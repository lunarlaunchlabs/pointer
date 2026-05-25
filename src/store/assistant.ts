/**
 * Unified Assistant store.
 *
 * One session model + one panel for all three modes (Ask | Plan |
 * Agent). The split that used to live across `store/chat.ts` (chat
 * UI) and `store/agentSessions.ts` (agent UI) collapses here so the
 * user can switch modes mid-conversation without losing context,
 * and so the action ledger spans the whole conversation regardless
 * of which mode the user invoked on a given turn.
 *
 * Migration: on first load we read `chat.sessions.v1` and
 * `agent.sessions.v2` (the previous stores' keys), translate each
 * to an `AssistantSession`, and write the result to
 * `assistant.sessions.v1`. The old keys are left in place for one
 * release as rollback safety — the migration is idempotent and
 * skipped once `assistant.sessions.v1` exists.
 */
import { create } from "zustand";
import {
  ipc,
  listenEvent,
  newRequestId,
  type LedgerEntry,
  type AssistantLedgerEvent,
} from "@/lib/ipc";
import { getItem, persistAsync } from "@/lib/persist";
import { getWorkspaceBrief } from "@/lib/workspaceBrief";
import { useEditorStore } from "@/store/editor";
import { useWorkspace } from "@/store/workspace";
import type { Reference } from "@/store/chat";
import {
  appendAgentEvent,
  type AgentEvent,
  type AgentMessage,
  type AgentMode,
  type AgentSession,
  type AgentStatus,
  type FileChange,
  type Phase,
} from "@/store/agentSessions";
import type { ChatMessage, ChatSession } from "@/store/chat";

/** Top-level Assistant mode. `ask` never enters the agent loop;
 *  `plan` and `agent` go through `agent_run` / `agent_continue`. */
export type AssistantMode = "ask" | "plan" | "agent";

/** A unified message for the visible transcript. Carries every
 *  field both chat and agent transcripts used so the renderer can
 *  display all three modes identically. */
export type AssistantMessage = ChatMessage;

/** Unified session shape. Some fields only matter in some modes
 *  (events/changes/transcript are plan/agent-only) but we keep
 *  them present-but-empty for ask sessions so the renderer can
 *  treat every session the same. */
export type AssistantSession = {
  id: string;
  title: string;
  model: string;
  mode: AssistantMode;
  workspace: string | null;
  /** Visible transcript — user prose + assistant prose. Same shape
   *  as the old ChatMessage so we can reuse renderers. */
  messages: AssistantMessage[];
  /** Backend resume payload (the Ollama message list). Empty in
   *  Ask mode because Ask doesn't run a loop. */
  transcript: AgentMessage[];
  /** Plan/Agent event cards (tool calls, approvals, file change
   *  rows). Empty in Ask mode. */
  events: AgentEvent[];
  /** Mutating-tool change journal — drives the "Review changes"
   *  card. Empty in Ask mode. */
  changes: FileChange[];
  /** Action ledger mirrored from the backend. Spans every turn of
   *  the session regardless of mode. */
  ledger: LedgerEntry[];
  /** Mention chips pending for the next turn. */
  references: Reference[];
  /** Plan/Agent-mode tuning. Backfilled for migrated chat sessions. */
  maxSteps: number;
  lintCommand: string;
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
};

type State = {
  hydrated: boolean;
  sessions: AssistantSession[];
  activeSessionId: string | null;
  phase: Phase;
  currentRequestId: string | null;
  pendingRefs: Reference[];

  init: () => Promise<void>;
  newSession: (opts: { mode: AssistantMode; model: string }) => string;
  selectSession: (id: string | null) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  /** Switch a session's mode mid-conversation. The ledger and
   *  transcript are preserved — the next turn just runs in the new
   *  mode. */
  setSessionMode: (id: string, mode: AssistantMode) => void;
  ensureActive: (model: string, mode: AssistantMode) => AssistantSession;

  addRef: (r: Reference) => void;
  removeRef: (idx: number) => void;
  clearRefs: () => void;

  cancel: () => Promise<void>;
  send: (
    text: string,
    opts: {
      defaultModel: string;
      buildContext?: (refs: Reference[]) => Promise<string | undefined>;
    },
  ) => Promise<void>;
  /** Promote a Plan-mode session into an Agent run that executes
   *  the plan it just produced. Carries forward transcript +
   *  ledger so the agent doesn't re-explore. */
  executePlan: (id: string) => Promise<void>;

  getActive: () => AssistantSession | null;
};

const SESSIONS_KEY = "assistant.sessions.v1";
const ACTIVE_KEY = "assistant.active.v1";
// Legacy stores we migrate from on first load. Left in place after
// migration as one-release rollback safety.
const LEGACY_CHAT_KEY = "chat.sessions.v1";
const LEGACY_AGENT_KEY = "agent.sessions.v2";

const DEFAULT_MAX_STEPS = 30;

export const useAssistant = create<State>((set, get) => ({
  hydrated: false,
  sessions: [],
  activeSessionId: null,
  phase: { kind: "idle" },
  currentRequestId: null,
  pendingRefs: [],

  init: async () => {
    const [existing, active] = await Promise.all([
      getItem<AssistantSession[]>(SESSIONS_KEY).catch(() => undefined),
      getItem<string | null>(ACTIVE_KEY).catch(() => null),
    ]);
    let sessions = existing;
    if (!sessions) {
      // First boot under the unified store — pull the two legacy
      // stores and merge. Read errors are non-fatal; an old key
      // missing just means there's nothing to migrate from it.
      const [legacyChat, legacyAgent] = await Promise.all([
        getItem<ChatSession[]>(LEGACY_CHAT_KEY).catch(() => undefined),
        getItem<AgentSession[]>(LEGACY_AGENT_KEY).catch(() => undefined),
      ]);
      sessions = migrateLegacy(legacyChat ?? [], legacyAgent ?? []);
      if (sessions.length) {
        persistAsync(SESSIONS_KEY, sessions);
      }
    }
    // Repair pass: any session still 'running' across a restart
    // was abandoned mid-turn; flip it to cancelled so the composer
    // unlocks.
    const repaired = (sessions ?? []).map((s) => ({
      ...s,
      status: s.status === "running" ? ("cancelled" as const) : s.status,
    }));
    set({
      sessions: repaired,
      activeSessionId: active ?? null,
      hydrated: true,
    });
  },

  newSession: ({ mode, model }) => {
    const s: AssistantSession = blankSession(mode, model);
    set((st) => ({
      sessions: [s, ...st.sessions],
      activeSessionId: s.id,
      pendingRefs: [],
    }));
    flush(get());
    return s.id;
  },

  selectSession: (id) => {
    set({ activeSessionId: id, pendingRefs: [], phase: { kind: "idle" } });
    persistAsync(ACTIVE_KEY, id);
  },

  deleteSession: (id) => {
    const st = get();
    const next = st.sessions.filter((x) => x.id !== id);
    const activeSessionId =
      st.activeSessionId === id ? next[0]?.id ?? null : st.activeSessionId;
    set({ sessions: next, activeSessionId });
    flush(get());
  },

  renameSession: (id, title) => {
    patchSession(set, get, id, { title, updatedAt: Date.now() });
    flush(get());
  },

  setSessionMode: (id, mode) => {
    const st = get();
    const s = st.sessions.find((x) => x.id === id);
    // Locking the picker while a turn is in flight prevents mid-run
    // mode swaps that would orphan the active stream.
    if (!s || s.status === "running") return;
    patchSession(set, get, id, { mode, updatedAt: Date.now() });
    flush(get());
  },

  ensureActive: (model, mode) => {
    const st = get();
    const found = st.sessions.find((s) => s.id === st.activeSessionId);
    if (found) return found;
    const id = get().newSession({ mode, model });
    return get().sessions.find((s) => s.id === id)!;
  },

  addRef: (r) => set((s) => ({ pendingRefs: [...s.pendingRefs, r] })),
  removeRef: (idx) =>
    set((s) => ({ pendingRefs: s.pendingRefs.filter((_, i) => i !== idx) })),
  clearRefs: () => set({ pendingRefs: [] }),

  cancel: async () => {
    const rid = get().currentRequestId;
    if (!rid) return;
    // Ask uses ollama_cancel, agent/plan use agent_cancel. Trying
    // both is safe — each is a no-op when the other path owns the
    // request id.
    await Promise.allSettled([
      ipc.ollamaCancel(rid),
      ipc.agentCancel(rid),
    ]);
  },

  send: async (text, { defaultModel, buildContext }) => {
    if (!defaultModel) return;
    const refs = get().pendingRefs;
    let active = get().ensureActive(defaultModel, "ask");
    if (!active.model) return;

    const userMsg: AssistantMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      references: refs.length ? refs : undefined,
    };
    appendMessage(set, get, active.id, userMsg);
    set({ pendingRefs: [] });

    active = get().sessions.find((s) => s.id === active.id)!;
    if (active.messages.filter((m) => m.role === "user").length === 1) {
      const title = derivedTitle(text);
      get().renameSession(active.id, title);
    }

    const context = (await buildContext?.(refs)) ?? undefined;

    switch (active.mode) {
      case "ask":
        await sendAsk(set, get, active.id, context);
        break;
      case "plan":
      case "agent":
        await sendAgent(set, get, active.id, text, context);
        break;
    }
  },

  executePlan: async (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    if (session.status === "running") return;
    // Collect any <plan> blocks the model produced this session.
    // We pass the raw concatenation — the BE handler prefixes it
    // with "Execute the following plan:" and routes it through
    // agent_continue when a transcript is available.
    const planText = session.events
      .filter((e) => e.kind === "plan")
      .map((e) => (e.kind === "plan" ? e.text : ""))
      .join("\n\n")
      .trim();
    patchSession(set, get, id, {
      mode: "agent",
      status: "running",
      updatedAt: Date.now(),
    });
    set({
      activeSessionId: id,
      phase: { kind: "warming", step: 0, sinceMs: Date.now() },
    });
    const rid = newRequestId("plan");
    set({ currentRequestId: rid });
    const off = await subscribeAgentEvents(set, get, id, rid);
    try {
      await ipc.agentExecutePlan(rid, {
        session_id: id,
        plan_text: planText,
        model: session.model,
        workspace: session.workspace ?? undefined,
        transcript: session.transcript.length ? session.transcript : undefined,
        ledger: session.ledger.length ? session.ledger : undefined,
      });
    } catch (e) {
      pushEvent(set, get, id, { kind: "error", text: String(e) });
      patchSession(set, get, id, { status: "error" });
      set({ phase: { kind: "idle" }, currentRequestId: null });
      off();
      flush(get());
    }
  },

  getActive: () => {
    const st = get();
    return st.sessions.find((s) => s.id === st.activeSessionId) ?? null;
  },
}));

// ---------------------------------------------------------------------------
// Ask-mode send: plain chat stream + a single AnsweredOnly ledger entry
// ---------------------------------------------------------------------------

async function sendAsk(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  context: string | undefined,
) {
  const session = get().sessions.find((s) => s.id === sessionId);
  if (!session) return;

  const assistantMsg: AssistantMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    streaming: true,
  };
  appendMessage(set, get, sessionId, assistantMsg);

  const messages = get()
    .sessions.find((s) => s.id === sessionId)!
    .messages.filter((m) => m.id !== assistantMsg.id)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const brief = await getWorkspaceBrief(useWorkspace.getState().root);
  const system = askSystemPrompt(brief);
  const rid = newRequestId("ask");
  set({ currentRequestId: rid });

  // Listen for token stream over the shared ollama:chat channel.
  const offStream = await listenEvent<
    | { token: string }
    | { done: true }
    | { cancelled: true; done: true }
    | { error: string; done: true }
  >(`ollama:chat:${rid}`, (p) => {
    if ("token" in p) appendToken(set, get, sessionId, assistantMsg.id, p.token);
    if ("error" in p)
      appendToken(set, get, sessionId, assistantMsg.id, `\n\n_Error: ${p.error}_`);
    if ("done" in p && p.done) {
      patchSession(set, get, sessionId, {
        messages: get()
          .sessions.find((s) => s.id === sessionId)!
          .messages.map((m) =>
            m.id === assistantMsg.id ? { ...m, streaming: false } : m,
          ),
        status: "done",
        updatedAt: Date.now(),
      });
      set({ currentRequestId: null });
      flush(get());
      offStream();
    }
  });
  // Listen on the ledger channel — the BE fires one
  // AnsweredOnly entry once the stream completes.
  const offLedger = await listenEvent<AssistantLedgerEvent>(
    `assistant:ledger:${sessionId}`,
    (p) => {
      appendLedger(set, get, sessionId, p.entry);
      offLedger();
    },
  );

  try {
    await ipc.assistantAsk(rid, {
      session_id: sessionId,
      model: session.model,
      messages,
      system,
      system_extras: context,
      temperature: 0.2,
    });
  } catch (e) {
    appendToken(set, get, sessionId, assistantMsg.id, `\n\n_Error: ${String(e)}_`);
    patchSession(set, get, sessionId, { status: "error" });
    set({ currentRequestId: null });
    offStream();
    offLedger();
  }
}

// ---------------------------------------------------------------------------
// Plan/Agent send: routes through the agent loop
// ---------------------------------------------------------------------------

async function sendAgent(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  text: string,
  context: string | undefined,
) {
  const session = get().sessions.find((s) => s.id === sessionId);
  if (!session) return;

  patchSession(set, get, sessionId, {
    status: "running",
    references: [],
    updatedAt: Date.now(),
  });
  set({
    activeSessionId: sessionId,
    phase: { kind: "warming", step: 0, sinceMs: Date.now() },
  });

  const rid = newRequestId("agent");
  set({ currentRequestId: rid });
  const off = await subscribeAgentEvents(set, get, sessionId, rid);

  const editor = useEditorStore.getState();
  const openTabs = editor.tabs.map((t) => t.path);
  const activeFile = editor.activePath ?? undefined;
  const mode = toAgentMode(session.mode);

  try {
    if (session.transcript.length === 0) {
      await ipc.agentRun(rid, {
        model: session.model,
        goal: text,
        workspace: session.workspace ?? undefined,
        max_steps: session.maxSteps,
        mode,
        lint_command: session.lintCommand.trim() || undefined,
        context: context?.trim() ? context : undefined,
        open_tabs: openTabs.length ? openTabs : undefined,
        active_file: activeFile,
      });
    } else {
      await ipc.agentContinue(rid, {
        model: session.model,
        user_message: text,
        transcript: session.transcript,
        workspace: session.workspace ?? undefined,
        max_steps: session.maxSteps,
        mode,
        lint_command: session.lintCommand.trim() || undefined,
        context: context?.trim() ? context : undefined,
        open_tabs: openTabs.length ? openTabs : undefined,
        active_file: activeFile,
        ledger: session.ledger.length ? session.ledger : undefined,
      });
    }
  } catch (e) {
    pushEvent(set, get, sessionId, { kind: "error", text: String(e) });
    patchSession(set, get, sessionId, { status: "error" });
    set({ phase: { kind: "idle" }, currentRequestId: null });
    off();
    flush(get());
  }
}

// ---------------------------------------------------------------------------
// Agent event plumbing — mirrors the old agentSessions store but writes
// onto the unified `AssistantSession` shape.
// ---------------------------------------------------------------------------

async function subscribeAgentEvents(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  rid: string,
): Promise<() => void> {
  type LedgerSnapshot = { kind: "ledger_snapshot"; entries: LedgerEntry[] };
  const off = await listenEvent<AgentEvent | LedgerSnapshot>(
    `agent:event:${rid}`,
    (e) => {
      if (e.kind === "transcript_snapshot") {
        patchSession(set, get, sessionId, {
          transcript: e.messages,
          updatedAt: Date.now(),
        });
        return;
      }
      if (e.kind === "ledger_snapshot") {
        // Replace wholesale — the BE snapshot is authoritative for
        // the run. Ask-mode entries from earlier in the session
        // survive because the BE forwards the entire ledger.
        patchSession(set, get, sessionId, {
          ledger: e.entries,
          updatedAt: Date.now(),
        });
        flush(get());
        return;
      }
      if (e.kind === "tool_result" && e.extra && typeof e.extra === "object") {
        const change = (e.extra as { change?: unknown }).change;
        if (isFileChangePayload(change)) {
          appendChange(set, get, sessionId, change);
        }
      }
      pushEvent(set, get, sessionId, e);
      switch (e.kind) {
        case "step_start":
          set({ phase: { kind: "warming", step: e.step, sinceMs: Date.now() } });
          break;
        case "first_token":
          set({
            phase: { kind: "streaming", step: e.step, warmupMs: e.warmup_ms },
          });
          break;
        case "tool_call":
          set({ phase: { kind: "tool", tool: e.tool } });
          break;
        case "approval_request":
          set({ phase: { kind: "awaiting_approval", tool: e.tool } });
          break;
        case "tool_result":
          set({ phase: { kind: "warming", step: 0, sinceMs: Date.now() } });
          break;
        case "done":
          patchSession(set, get, sessionId, { status: "done" });
          set({ phase: { kind: "idle" }, currentRequestId: null });
          off();
          flush(get());
          break;
        case "cancelled":
          patchSession(set, get, sessionId, { status: "cancelled" });
          set({ phase: { kind: "idle" }, currentRequestId: null });
          off();
          flush(get());
          break;
        case "error":
          patchSession(set, get, sessionId, { status: "error" });
          set({ phase: { kind: "idle" }, currentRequestId: null });
          off();
          flush(get());
          break;
      }
    },
  );
  return off;
}

// ---------------------------------------------------------------------------
// Migration: legacy chat + agent stores → unified assistant store.
// Exposed (not just internal) so tests can drive it directly without
// faking the persistence layer.
// ---------------------------------------------------------------------------

export function migrateLegacy(
  legacyChat: ChatSession[],
  legacyAgent: AgentSession[],
): AssistantSession[] {
  const fromChat: AssistantSession[] = legacyChat.map((c) => ({
    id: rekey(c.id, "asst"),
    title: c.title,
    model: c.model,
    mode: "ask",
    workspace: null,
    messages: c.messages,
    transcript: [],
    events: [],
    changes: [],
    // Reconstruct a one-line AnsweredOnly entry for each assistant
    // message so the ledger reflects history even though the old
    // store didn't track one. Without this, switching to plan/agent
    // mode after a chat history would lose the conversational
    // context the new <previous_work> block depends on.
    ledger: c.messages
      .filter((m) => m.role === "assistant" && m.content.trim())
      .map((m, i) => ({
        turn: i + 1,
        timestamp_ms: c.updatedAt,
        mode: "ask",
        kind: { type: "answered_only" as const, summary: firstSentence(m.content) },
      })),
    references: [],
    maxSteps: DEFAULT_MAX_STEPS,
    lintCommand: "",
    status: "idle",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
  const fromAgent: AssistantSession[] = legacyAgent.map((a) => ({
    id: rekey(a.id, "asst"),
    title: a.title,
    model: a.model,
    mode: legacyModeToAssistantMode(a.mode),
    workspace: a.workspace,
    // Synthesize a visible transcript from the agent events so the
    // user sees what they sent and what came back. Tool results and
    // approvals stay in the events list, which the renderer also
    // shows.
    messages: messagesFromAgentEvents(a),
    transcript: a.transcript,
    events: a.events,
    changes: a.changes,
    // Reconstruct ledger entries by walking the agent's events.
    // Only mutating events become Wrote/Renamed/Deleted entries —
    // searches/reads are dropped because we never persisted enough
    // detail to round-trip them faithfully.
    ledger: ledgerFromAgentEvents(a),
    references: a.references,
    maxSteps: a.maxSteps,
    lintCommand: a.lintCommand,
    status: a.status === "running" ? "cancelled" : a.status,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }));
  // Sort newest first so the picker matches the user's mental model.
  return [...fromChat, ...fromAgent].sort((x, y) => y.updatedAt - x.updatedAt);
}

function legacyModeToAssistantMode(m: AgentMode): AssistantMode {
  // Legacy agent stored "ask"/"auto" as approval-style/auto-style
  // distinctions inside the SAME agent loop. The new top-level
  // Ask mode (chat-only) is a different beast, so we collapse both
  // into the unified "agent" surface — the FE picker no longer
  // surfaces approval vs auto as a separate axis. Plan stays plan.
  return m === "plan" ? "plan" : "agent";
}

function toAgentMode(m: AssistantMode): AgentMode {
  // Map the new UI modes back to the wire format `agent_run`
  // expects. `ask` should never reach here — it goes through
  // `assistant_ask` instead — but if it does we route to the
  // safest agent option (approval-gated) so a routing bug can't
  // silently auto-mutate.
  if (m === "plan") return "plan";
  if (m === "agent") return "auto";
  return "ask";
}

function messagesFromAgentEvents(a: AgentSession): AssistantMessage[] {
  const msgs: AssistantMessage[] = [
    {
      id: crypto.randomUUID(),
      role: "user",
      content: a.goal,
      references: a.references,
    },
  ];
  for (const ev of a.events) {
    if (ev.kind === "user_message") {
      msgs.push({
        id: crypto.randomUUID(),
        role: "user",
        content: ev.text,
        references: ev.references,
      });
    } else if (ev.kind === "final") {
      msgs.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: ev.text,
      });
    }
  }
  return msgs;
}

function ledgerFromAgentEvents(a: AgentSession): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  let turn = 0;
  for (const ev of a.events) {
    if (ev.kind === "user_message") turn += 1;
    if (ev.kind === "tool_call" || ev.kind === "tool_result") {
      // We don't have status separated from the call; only emit
      // for tool_result with status==="ok" to avoid recording
      // failed/rejected actions as facts.
      if (ev.kind === "tool_result" && ev.status === "ok") {
        const path = (ev.extra as { path?: string } | undefined)?.path;
        const tool = ev.tool;
        if ((tool === "write_file" || tool === "edit_file" || tool === "apply_diff") && path) {
          out.push({
            turn: Math.max(turn, 1),
            timestamp_ms: a.updatedAt,
            mode: "agent",
            kind: { type: "wrote", path, bytes: 0, hunks: 1 },
          });
        } else if (tool === "delete_path" && path) {
          out.push({
            turn: Math.max(turn, 1),
            timestamp_ms: a.updatedAt,
            mode: "agent",
            kind: { type: "deleted", path },
          });
        }
      }
    }
    if (ev.kind === "final") {
      out.push({
        turn: Math.max(turn, 1),
        timestamp_ms: a.updatedAt,
        mode: "agent",
        kind: { type: "answered_only", summary: firstSentence(ev.text) },
      });
    }
  }
  return out;
}

function firstSentence(s: string): string {
  const collapsed = s.trim().replace(/\s+/g, " ");
  const cut = collapsed.split(/[.?!\n]/, 1)[0] ?? collapsed;
  return cut.length > 160 ? cut.slice(0, 160) + "…" : cut;
}

function rekey(id: string, prefix: string): string {
  // Preserve enough of the old id that an old `assistant.active.v1`
  // pointer (if any) can still resolve, while making the prefix
  // recognizable.
  return `${prefix}_${id.replace(/^[a-z]+_/, "")}`;
}

function isFileChangePayload(v: unknown): v is FileChange {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.step === "number" &&
    (o.kind === "create" ||
      o.kind === "modify" ||
      o.kind === "delete" ||
      o.kind === "rename") &&
    typeof o.path === "string" &&
    typeof o.before_bytes === "number" &&
    typeof o.after_bytes === "number" &&
    (o.status === "pending" || o.status === "kept" || o.status === "undone")
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blankSession(mode: AssistantMode, model: string): AssistantSession {
  const now = Date.now();
  return {
    id: `asst_${crypto.randomUUID().slice(0, 12)}`,
    title: "New assistant",
    model,
    mode,
    workspace: useWorkspace.getState().root,
    messages: [],
    transcript: [],
    events: [],
    changes: [],
    ledger: [],
    references: [],
    maxSteps: DEFAULT_MAX_STEPS,
    lintCommand: "",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

function appendMessage(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  msg: AssistantMessage,
) {
  set((st) => ({
    sessions: st.sessions.map((s) =>
      s.id !== sessionId
        ? s
        : { ...s, messages: [...s.messages, msg], updatedAt: Date.now() },
    ),
  }));
  if (msg.role === "user") flush(get());
}

function appendToken(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  msgId: string,
  token: string,
) {
  void get;
  set((st) => ({
    sessions: st.sessions.map((s) =>
      s.id !== sessionId
        ? s
        : {
            ...s,
            messages: s.messages.map((m) =>
              m.id === msgId ? { ...m, content: m.content + token } : m,
            ),
          },
    ),
  }));
}

function appendLedger(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  entry: LedgerEntry,
) {
  set((st) => ({
    sessions: st.sessions.map((s) => {
      if (s.id !== sessionId) return s;
      // Assign a real turn index when the BE sent the marker 0.
      const turn = entry.turn > 0 ? entry.turn : s.ledger.length + 1;
      return {
        ...s,
        ledger: [...s.ledger, { ...entry, turn }],
        updatedAt: Date.now(),
      };
    }),
  }));
  flush(get());
}

function appendChange(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  change: FileChange,
) {
  set((st) => ({
    sessions: st.sessions.map((s) => {
      if (s.id !== sessionId) return s;
      if (s.changes.some((c) => c.id === change.id)) return s;
      return { ...s, changes: [...s.changes, change], updatedAt: Date.now() };
    }),
  }));
  flush(get());
}

function pushEvent(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  id: string,
  e: AgentEvent,
) {
  set((st) => ({
    sessions: st.sessions.map((s) =>
      s.id === id
        ? { ...s, events: appendAgentEvent(s.events, e), updatedAt: Date.now() }
        : s,
    ),
  }));
  if (e.kind === "shell_progress") return;
  const len = get().sessions.find((s) => s.id === id)?.events.length ?? 0;
  if (len % 10 === 0) flush(get());
}

function patchSession(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  id: string,
  patch: Partial<AssistantSession>,
) {
  set((st) => ({
    sessions: st.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  }));
  void get;
}

function flush(s: State) {
  persistAsync(SESSIONS_KEY, s.sessions);
  persistAsync(ACTIVE_KEY, s.activeSessionId);
}

function derivedTitle(text: string): string {
  const first = text.split("\n").find((l) => l.trim()) ?? text;
  const trimmed = first.trim().slice(0, 64);
  return trimmed.length === 0 ? "New assistant" : trimmed;
}

function askSystemPrompt(brief?: string): string {
  return `You are Pointer, an AI pair programmer running entirely on the user's machine via local open-source models. Be concise.

You are in ASK mode — answer questions and explain code. Do NOT
emit edit blocks, tool tags, or shell commands. If the user wants
the code changed, suggest switching to Plan or Agent mode.

${
  brief && brief.trim().length
    ? "Workspace brief — a compact snapshot of the project the user has open. Use it for orientation; if you need more, ask.\n\n" +
      brief +
      "\n"
    : ""
}`;
}
