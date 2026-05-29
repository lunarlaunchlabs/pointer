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
import { inferImplicitFileReferences, mergeReferences } from "@/lib/implicitContext";
import { latestPlanText } from "@/lib/assistantPlans";
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
  type FileChangeStatus,
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
  /** Native OpenCode session id. When present, Pointer resumes OpenCode's
   *  own session memory instead of replaying a lossy transcript summary. */
  opencodeSessionId?: string | null;
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
  setSessionModel: (id: string, model: string) => void;
  ensureActive: (model: string, mode: AssistantMode) => AssistantSession;

  addRef: (r: Reference) => void;
  removeRef: (idx: number) => void;
  clearRefs: () => void;

  cancel: () => Promise<void>;
  send: (
    text: string,
    opts: {
      defaultModel: string;
      buildContext?: (
        refs: Reference[],
        prompt: string,
        mode: AssistantMode,
      ) => Promise<string | undefined>;
    },
  ) => Promise<void>;
  /** Promote a Plan-mode session into an Agent run that executes
   *  the plan it just produced. Carries forward transcript +
   *  ledger so the agent doesn't re-explore. */
  executePlan: (id: string) => Promise<void>;
  keepChange: (sessionId: string, changeId: string) => Promise<void>;
  undoChange: (sessionId: string, changeId: string) => Promise<void>;
  keepAllChanges: (sessionId: string) => Promise<void>;
  undoAllChanges: (sessionId: string) => Promise<void>;

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
    const victim = st.sessions.find((x) => x.id === id);
    const next = st.sessions.filter((x) => x.id !== id);
    const activeSessionId =
      st.activeSessionId === id ? next[0]?.id ?? null : st.activeSessionId;
    set({ sessions: next, activeSessionId });
    if (victim?.changes.length) {
      const pendingIds = victim.changes
        .filter((c) => c.status === "pending")
        .map((c) => c.id);
      if (pendingIds.length) void ipc.agentPurgeChanges(pendingIds).catch(() => {});
    }
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

  setSessionModel: (id, model) => {
    const st = get();
    const s = st.sessions.find((x) => x.id === id);
    if (!s || s.status === "running" || s.model === model) return;
    patchSession(set, get, id, { model, updatedAt: Date.now() });
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
    const explicitRefs = get().pendingRefs;
    let active = get().ensureActive(defaultModel, "ask");
    if (!active.model) return;
    const directAskRedirect =
      active.mode === "ask" && isDirectAskEditRequest(text);

    const editor = useEditorStore.getState();
    const implicitRefs = directAskRedirect
      ? []
      : await inferImplicitFileReferences(text, {
          existingRefs: explicitRefs,
          activePath: editor.activePath,
          openTabs: editor.tabs.map((t) => t.path),
        });
    const refs = mergeReferences(explicitRefs, implicitRefs);

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

    const context = directAskRedirect
      ? undefined
      : (await buildContext?.(refs, text, active.mode)) ?? undefined;
    const attachedFiles = attachedFilesFor(refs, editor.activePath, editor.tabs.map((t) => t.path));

    switch (active.mode) {
      case "ask":
        if (directAskRedirect) {
          appendAskRedirectAnswer(set, get, active.id);
          break;
        }
        await sendAsk(set, get, active.id, context, attachedFiles);
        break;
      case "plan":
      case "agent":
        await sendAgent(set, get, active.id, text, context, attachedFiles);
        break;
    }
  },

  executePlan: async (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    if (session.status === "running") return;
    // Collect any <plan> blocks the model produced this session.
    // We pass the latest block — the BE handler prefixes it
    // with "Execute the following plan:" and routes it through
    // agent_continue when a transcript is available.
    const planText = latestPlanText(session.events);
    if (!planText) return;
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
        opencode_session_id: session.opencodeSessionId ?? undefined,
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

  keepChange: async (sessionId, changeId) => {
    const change = get()
      .sessions.find((s) => s.id === sessionId)
      ?.changes.find((c) => c.id === changeId);
    if (!change || change.status !== "pending") return;
    setChangeStatus(set, get, sessionId, changeId, "kept");
    try {
      await ipc.agentKeepChange(changeId);
    } catch {
      setChangeStatus(set, get, sessionId, changeId, "pending");
    }
  },

  undoChange: async (sessionId, changeId) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    const change = session?.changes.find((c) => c.id === changeId);
    if (!session || !change || change.status !== "pending") return;
    setChangeStatus(set, get, sessionId, changeId, "undone");
    try {
      await ipc.agentUndoChange({
        changeId: change.id,
        workspace: session.workspace ?? useWorkspace.getState().root ?? "",
        kind: change.kind,
        path: change.path,
        from: change.from,
      });
      await refreshOpenEditorAfterUndo(change.path);
      if (change.from) await refreshOpenEditorAfterUndo(change.from);
    } catch {
      setChangeStatus(set, get, sessionId, changeId, "pending");
      throw new Error("undo failed — file may have changed since");
    }
  },

  keepAllChanges: async (sessionId) => {
    const pending =
      get()
        .sessions.find((s) => s.id === sessionId)
        ?.changes.filter((c) => c.status === "pending") ?? [];
    for (const change of pending) {
      await get().keepChange(sessionId, change.id);
    }
  },

  undoAllChanges: async (sessionId) => {
    const pending =
      get()
        .sessions.find((s) => s.id === sessionId)
        ?.changes.filter((c) => c.status === "pending")
        .slice()
        .reverse() ?? [];
    for (const change of pending) {
      try {
        await get().undoChange(sessionId, change.id);
      } catch {
        // Per-row status is restored to pending; keep unwinding the rest.
      }
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
  attachedFiles: string[],
) {
  const session = get().sessions.find((s) => s.id === sessionId);
  if (!session) return;

  patchSession(set, get, sessionId, {
    status: "running",
    updatedAt: Date.now(),
  });
  set({
    phase: { kind: "warming", step: 0, sinceMs: Date.now() },
  });

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
    if ("token" in p) {
      const phase = get().phase;
      if (phase.kind === "warming") {
        set({
          phase: {
            kind: "streaming",
            step: phase.step,
            warmupMs: Date.now() - phase.sinceMs,
          },
        });
      }
      appendToken(set, get, sessionId, assistantMsg.id, p.token);
    }
    if ("error" in p)
      appendToken(set, get, sessionId, assistantMsg.id, `\n\n_Error: ${p.error}_`);
    if ("done" in p && p.done) {
      const status: AgentStatus = "cancelled" in p && p.cancelled ? "cancelled" : "done";
      patchSession(set, get, sessionId, {
        messages: get()
          .sessions.find((s) => s.id === sessionId)!
          .messages.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: polishAssistantText(m.content), streaming: false }
              : m,
          ),
        status,
        updatedAt: Date.now(),
      });
      set({ phase: { kind: "idle" }, currentRequestId: null });
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
      if (p.opencode_session_id) {
        patchSession(set, get, sessionId, {
          opencodeSessionId: p.opencode_session_id,
          updatedAt: Date.now(),
        });
      }
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
      opencode_session_id: session.opencodeSessionId ?? undefined,
      attached_files: attachedFiles.length ? attachedFiles : undefined,
      temperature: 0.2,
    });
  } catch (e) {
    appendToken(set, get, sessionId, assistantMsg.id, `\n\n_Error: ${String(e)}_`);
    patchSession(set, get, sessionId, { status: "error" });
    set({ phase: { kind: "idle" }, currentRequestId: null });
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
  attachedFiles: string[],
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
        mode,
        lint_command: session.lintCommand.trim() || undefined,
        opencode_session_id: session.opencodeSessionId ?? undefined,
        context: context?.trim() ? context : undefined,
        open_tabs: openTabs.length ? openTabs : undefined,
        active_file: activeFile,
        attached_files: attachedFiles.length ? attachedFiles : undefined,
      });
    } else {
      await ipc.agentContinue(rid, {
        model: session.model,
        user_message: text,
        transcript: session.transcript,
        workspace: session.workspace ?? undefined,
        mode,
        lint_command: session.lintCommand.trim() || undefined,
        opencode_session_id: session.opencodeSessionId ?? undefined,
        context: context?.trim() ? context : undefined,
        open_tabs: openTabs.length ? openTabs : undefined,
        active_file: activeFile,
        attached_files: attachedFiles.length ? attachedFiles : undefined,
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
        const patch: Partial<AssistantSession> = {
          transcript: e.messages,
          updatedAt: Date.now(),
        };
        if (e.opencode_session_id) patch.opencodeSessionId = e.opencode_session_id;
        patchSession(set, get, sessionId, patch);
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
        case "final":
          appendAgentOutputMessage(set, get, sessionId, e.text);
          break;
        case "clarify":
          appendAgentOutputMessage(set, get, sessionId, e.text);
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
          appendAgentOutputMessage(set, get, sessionId, e.text);
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

function attachedFilesFor(
  refs: Reference[],
  activePath: string | null,
  openTabs: string[],
): string[] {
  const out: string[] = [];
  const push = (path: string | null | undefined) => {
    const p = path?.trim();
    if (!p || out.includes(p)) return;
    out.push(p);
  };
  for (const ref of refs) {
    if (ref.kind === "file" || ref.kind === "selection" || ref.kind === "symbol" || ref.kind === "diagnostic") {
      push(ref.path);
    }
  }
  push(activePath);
  for (const tab of openTabs.slice(0, 3)) push(tab);
  return out.slice(0, 8);
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

function polishAssistantText(text: string): string {
  return limitKeyIdentifiers(
    removeLeadingIdentifierPrefix(
      removeLeadingMiniAnswer(
        removeRepeatedBoundarySentence(dedupeRepeatedLines(dedupeRepeatedFinalText(removeFencedCodeBlocks(text)))),
      ),
    ),
  );
}

function removeFencedCodeBlocks(text: string): string {
  return String(text ?? "").replace(/```[^\n`]*\n([\s\S]*?)\n```/g, (_match, body) => {
    const compact = String(body ?? "").trim();
    if (!compact) return "";
    return compact
      .split(/\r?\n/)
      .map((line) => `  ${line}`)
      .join("\n");
  });
}

function dedupeRepeatedFinalText(text: string): string {
  const trimmed = String(text ?? "").trim();
  const lower = trimmed.toLowerCase();
  for (const restart of [
    "\ni've successfully",
    "\ni have successfully",
    "i've successfully",
    "i have successfully",
    "i've successfully refactored",
    "i've successfully updated",
    "i've successfully improved",
    "i've improved",
    "i've made",
    "i have successfully refactored",
    "i have successfully updated",
    "i have made",
    "i have improved",
    "i understand that",
  ]) {
    const idx = lower.indexOf(restart);
    if (idx > Math.max(120, trimmed.length / 3)) return trimmed.slice(0, idx).trim();
    if (idx > 40 && idx < 320 && /\b(?:i'll|i will|let me|try to|trying to)\b/i.test(trimmed.slice(0, idx))) {
      return trimmed.slice(idx).trim();
    }
  }
  return trimmed;
}

function dedupeRepeatedLines(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const normalized = line.trim().toLowerCase().replace(/\s+/g, " ");
    const meaningful = normalized.length >= 18 && /[a-z0-9]/.test(normalized);
    if (meaningful && seen.has(normalized)) continue;
    if (meaningful) seen.add(normalized);
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function removeRepeatedBoundarySentence(text: string): string {
  const trimmed = String(text ?? "").trim();
  const first = trimmed.match(/^(.{30,220}?[.!?])\s+/s);
  if (!first) return trimmed;
  const sentence = first[1].trim();
  const rest = trimmed.slice(first[0].length);
  return rest.toLowerCase().includes(sentence.toLowerCase()) ? rest.trim() : trimmed;
}

function removeLeadingMiniAnswer(text: string): string {
  const lower = text.toLowerCase();
  const first = lower.indexOf("key identifiers");
  const second = first === -1 ? -1 : lower.indexOf("key identifiers", first + 1);
  if (first === -1 || second === -1 || first > text.length / 2) return text;
  const lineEnd = text.indexOf("\n", first);
  if (lineEnd === -1) return text;
  let cut = lineEnd + 1;
  const nextLineEnd = text.indexOf("\n", cut);
  const nextLine = text.slice(cut, nextLineEnd === -1 ? undefined : nextLineEnd).trim();
  if (nextLine.includes(",") && nextLine.length < 240) {
    cut = nextLineEnd === -1 ? text.length : nextLineEnd + 1;
  }
  const rest = text.slice(cut).trim();
  return rest.length > 120 ? rest : text;
}

function limitKeyIdentifiers(text: string): string {
  return text.replace(
    /(Key identifiers?[^\n:]*:\s*)([^\n]+)/gi,
    (_match, prefix: string, list: string) => {
      const suffix = /\.\s*$/.test(list) ? "." : "";
      const items = list
        .replace(/\.\s*$/, "")
        .split(/,\s*/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length <= 8) return `${prefix}${list}`;
      return `${prefix}${items.slice(0, 8).join(", ")}${suffix}`;
    },
  );
}

function removeLeadingIdentifierPrefix(text: string): string {
  const firstThe = text.indexOf("The ");
  const firstNewline = text.indexOf("\n");
  if (
    firstThe > 0 &&
    firstThe < 520 &&
    (firstNewline === -1 || firstThe < firstNewline) &&
    text.slice(0, firstThe).split(",").length >= 4
  ) {
    return text.slice(firstThe).trim();
  }
  return text;
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

function appendAgentOutputMessage(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  text: string,
) {
  const content = text.trim();
  if (!content) return;
  const session = get().sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const normalized = normalizeMessageContent(content);
  const alreadyVisible = session.messages.some(
    (m) =>
      m.role === "assistant" &&
      normalizeMessageContent(m.content) === normalized,
  );
  if (alreadyVisible) return;
  appendMessage(set, get, sessionId, {
    id: crypto.randomUUID(),
    role: "assistant",
    content,
  });
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

function setChangeStatus(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  changeId: string,
  status: FileChangeStatus,
) {
  set((st) => ({
    sessions: st.sessions.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            changes: s.changes.map((c) =>
              c.id === changeId ? { ...c, status } : c,
            ),
            updatedAt: Date.now(),
          }
        : s,
    ),
  }));
  flush(get());
}

async function refreshOpenEditorAfterUndo(path: string) {
  const editor = useEditorStore.getState();
  const tab = editor.tabs.find((t) => t.path === path);
  if (!tab || tab.dirty) return;
  try {
    const content = await ipc.readTextFile(path);
    useEditorStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path ? { ...t, content, dirty: false, externalContent: null } : t,
      ),
    }));
  } catch {
    useEditorStore.setState((s) => ({
      tabs: s.tabs.filter((t) => t.path !== path),
      activePath: s.activePath === path ? s.tabs.find((t) => t.path !== path)?.path ?? null : s.activePath,
    }));
  }
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

const ASK_EDIT_REDIRECT =
  "Switch to Agent mode and I can apply that edit, or Plan mode if you want to review the plan first.";

function isDirectAskEditRequest(text: string): boolean {
  const trimmed = normalizeMessageContent(text).toLowerCase();
  if (!trimmed) return false;
  if (/\bhow\b|\bwhy\b|\bwhat\b|\bexplain\b|\btell me\b|\bplan\b/.test(trimmed)) {
    return false;
  }
  return /\b(change|edit|fix|add|remove|delete|rename|rewrite|implement|create|modify|update|patch)\b/.test(trimmed);
}

function appendAskRedirectAnswer(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
) {
  appendMessage(set, get, sessionId, {
    id: crypto.randomUUID(),
    role: "assistant",
    content: ASK_EDIT_REDIRECT,
    streaming: false,
  });
  appendLedger(set, get, sessionId, {
    turn: 0,
    timestamp_ms: Date.now(),
    mode: "ask",
    kind: { type: "answered_only", summary: ASK_EDIT_REDIRECT },
  });
  patchSession(set, get, sessionId, {
    status: "done",
    updatedAt: Date.now(),
  });
  set({ phase: { kind: "idle" }, currentRequestId: null });
  flush(get());
}

function normalizeMessageContent(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function askSystemPrompt(brief?: string): string {
  return `You are Pointer, an AI pair programmer running entirely on the user's machine via local open-source models. Be concise.

You are in ASK mode — answer questions and explain code. Do NOT
emit edit blocks, tool tags, shell commands, or triple-backtick code
fences. If the user asks you to change code, do not provide a patch or
replacement implementation in Ask mode; briefly tell them to switch to
Plan mode for an implementation plan or Agent mode to apply the edit.

ASK MODE OUTPUT CONTRACT:
- Prose only. The literal string \`\`\` is forbidden.
- Inline code spans like \`profile.name\` are OK; multi-line code examples are not.
- If the context includes a <file> block for a named file, answer from that
  file. Do not claim you lack access to it.
- For "tell me about <file>" style questions, answer with the file's purpose,
  important imports/exports, state or data flow, and any notable risks or
  neighboring files worth checking. Prefer a tight, skimmable explanation.
- For interface code, call out important state owners, event handlers, and
  conditional rendered UI when they are present.
- For codebase research questions that ask where a behavior is configured,
  compiled, consumed, or flows through the project, use search/read tools to
  trace at least the definition file and consumer file before answering.
- When a provided file defines object/property methods or dotted assignments,
  include the literal identifier names from the file. Do not paraphrase dotted
  assignments into generic method names.
- Preserve camelCase and dotted assignment names exactly as they appear in the
  supplied file.
- Include a compact "Key identifiers" sentence when explaining a file, naming
  4-8 concrete symbols or setting keys that are actually visible in the
  provided context. Never list more than 8 identifiers and never repeat one.
- Key identifiers must be real identifiers or setting keys from the file, not
  synthesized property chains.
- Never copy identifier examples from these instructions into the answer unless
  they appear in the supplied repository context.
- When explaining core framework/runtime files, name concrete configuration
  defaults, compatibility hooks, and routing/middleware paths visible in the
  file instead of smoothing them into generic summaries.
- Name important top-level functions, methods, and literal setting keys by their
  exact identifiers when they are central to the file.
- For direct edit requests ("change this file", "fix this", "add X"),
  your ENTIRE response must be exactly:
  "Switch to Agent mode and I can apply that edit, or Plan mode if you want to review the plan first."
  Do not show the changed code. Do not explain the change.

${
  brief && brief.trim().length
    ? "Workspace brief — a compact snapshot of the project the user has open. Use it for orientation; if you need more, ask.\n\n" +
      brief +
      "\n"
    : ""
}`;
}
