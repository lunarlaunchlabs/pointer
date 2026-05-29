/**
 * @deprecated Use `@/store/assistant` instead. This store is kept on
 * disk for one release window so the new `assistant.sessions.v1`
 * migration can re-run if it landed buggy in any user's profile.
 * The store is no longer wired into any view — it exists only so
 * `useAssistant.init()` can read `agent.sessions.v2` once on first
 * boot under the new build. Remove the entire file in the release
 * after migration is confirmed safe in the wild.
 */
import { create } from "zustand";
import { ipc, listenEvent, newRequestId } from "@/lib/ipc";
import { getItem, persistAsync } from "@/lib/persist";
import type { Reference } from "./chat";
import { useEditorStore } from "./editor";

export type AgentMode = "plan" | "ask" | "auto";

/** One message in the Ollama-side conversation transcript. We persist
 *  these on the session so a follow-up `continueSession` call can resume
 *  the same conversation on the backend, instead of starting fresh.
 *  The shape mirrors what the backend feeds Ollama's /api/chat. */
export type AgentMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

/** A single file change the agent made during a turn. Persisted on
 *  the session so the "Review changes" card survives restarts and the
 *  user can keep/undo each entry individually. NO content lives here —
 *  the snapshot blobs are addressed by `id` and stored in the BE's
 *  app_data dir; the FE fetches them on demand via `agentChangeDiff`
 *  when the user clicks "View diff".
 *
 *  `status` starts as "pending" and flips to "kept" / "undone" once
 *  the user decides. The card filters on `status === "pending"` so
 *  resolved rows roll off cleanly. */
export type FileChangeKind = "create" | "modify" | "delete" | "rename";
export type FileChangeStatus = "pending" | "kept" | "undone";
export type FileChange = {
  id: string;
  step: number;
  kind: FileChangeKind;
  /** Workspace-relative path (or destination path for rename). */
  path: string;
  /** Source path for renames; undefined otherwise. */
  from?: string;
  before_bytes: number;
  after_bytes: number;
  status: FileChangeStatus;
};

export type AgentEvent =
  | {
      kind: "started";
      mode: AgentMode;
      max_steps?: number | null;
      depth: number;
      workspace: string;
      runtime?: string;
    }
  | { kind: "step_start"; step: number; model: string; elapsed_ms: number }
  | { kind: "request_sent"; step: number; elapsed_ms: number }
  | { kind: "first_token"; step: number; warmup_ms: number }
  | { kind: "token"; step: number; text: string }
  | { kind: "thought"; step: number; text: string }
  | { kind: "plan"; step: number; text: string }
  | {
      kind: "tool_call";
      step: number;
      tool: string;
      attrs: Record<string, string>;
      args: string;
    }
  | {
      kind: "tool_result";
      step: number;
      tool: string;
      status: string;
      result: string;
      extra: Record<string, unknown>;
    }
  | {
      kind: "approval_request";
      step: number;
      tool: string;
      attrs: Record<string, string>;
      args: string;
    }
  | { kind: "verifier"; step: number; tool: string; text: string }
  | { kind: "clarify"; step: number; text: string }
  | { kind: "final"; step: number; text: string }
  | { kind: "error"; step?: number; text: string }
  | { kind: "cancelled" }
  | { kind: "done"; termination: string; elapsed_ms: number }
  | { kind: "tool_proxy"; tool: string; args: string }
  // Streamed chunks of stdout/stderr from an in-flight `run_shell`.
  // The UI uses these to render a live tail so a long install
  // (e.g. `npm install`, `npx create-vite`) doesn't look frozen
  // while the buffer fills.
  | { kind: "shell_progress"; request_id?: string; stream: "stdout" | "stderr"; chunk: string }
  // Turn divider — emitted by the FE (not the BE) when the user sends
  // a follow-up message via `continueSession`. The renderer uses these
  // to visually separate one user-turn from the next in the transcript.
  | { kind: "user_message"; text: string; references: Reference[]; ts: number }
  // Mid-run budget renegotiation. The model emits `<budget_bump>N because R</budget_bump>`
  // when it realizes the goal needs more steps than the agreed budget;
  // the BE pauses the loop and surfaces this event to the UI, which
  // gates resumption on a `respondToBudgetBump` call.
  | { kind: "budget_bump_request"; step: number; proposed: number; reason: string }
  // Captured by the BE just before each terminal event so the FE can
  // persist the exact Ollama transcript needed to resume the
  // conversation later. Not rendered; consumed by the store listener.
  | { kind: "transcript_snapshot"; messages: AgentMessage[]; opencode_session_id?: string | null };

export type AgentStatus = "idle" | "running" | "done" | "cancelled" | "error";

export type Phase =
  | { kind: "idle" }
  | { kind: "warming"; step: number; sinceMs: number }
  | { kind: "streaming"; step: number; warmupMs: number }
  | { kind: "tool"; tool: string }
  | { kind: "awaiting_approval"; tool: string }
  // Paused: the model proposed a higher (or lower) step budget than
  // the agreed cap. `proposed` is what it asked for; `reason` is its
  // short justification. The user's `respondToBudgetBump` decision
  // unblocks the BE oneshot and the loop resumes (or cancels).
  | { kind: "awaiting_budget_bump"; step: number; proposed: number; reason: string };

/** One agent session — now a multi-turn conversation rather than a
 *  one-shot run. Persisted so transcripts survive restarts.
 *
 *  `references` is the mention chip list shown above the composer
 *  while the *current* turn is idle (draft). On the first turn this
 *  is the initial goal context; on follow-ups it's whatever the user
 *  attaches alongside their reply.
 *
 *  `transcript` is the Ollama-side message history (system + user +
 *  assistant + tool messages). The BE snapshots this back to the FE
 *  before each terminal event via a `transcript_snapshot` event so
 *  the next `continueSession` call can hand the same conversation
 *  back to the model and resume cleanly.
 *
 *  `estimate` is the most-recent preflight planner result for the
 *  *current* draft (cleared once the run starts). It pre-fills
 *  `maxSteps` unless the user pinned the field manually.
 *
 *  `status` is the status of the MOST RECENT turn. After a terminal
 *  status the session is still alive — the composer remains open
 *  for follow-up messages, which transition the session back to
 *  `running`. */
export type AgentSession = {
  id: string;
  title: string;
  goal: string;
  mode: AgentMode;
  model: string;
  workspace: string | null;
  maxSteps: number;
  lintCommand: string;
  status: AgentStatus;
  events: AgentEvent[];
  references: Reference[];
  /** Ollama transcript persisted across restarts so follow-ups can
   *  resume the same conversation. Empty until the first turn ends. */
  transcript: AgentMessage[];
  /** Preflight budget estimate for the current draft turn. Cleared
   *  on each new turn. `null` when no estimate has been requested or
   *  the model declined to estimate. */
  estimate: { steps: number; summary: string } | null;
  /** True once the user has manually edited `maxSteps`; prevents
   *  subsequent estimates from clobbering an explicit override. */
  maxStepsPinned?: boolean;
  /** Every mutating file operation the agent performed across all
   *  turns of this session. The "Review changes" card filters this
   *  by status === "pending" to gate keep/undo prompts. Survives
   *  restarts; backfilled to [] for v2 sessions. */
  changes: FileChange[];
  createdAt: number;
  updatedAt: number;
};

type State = {
  hydrated: boolean;
  sessions: AgentSession[];
  activeSessionId: string | null;
  /** Ephemeral — never persisted. */
  phase: Phase;
  currentRequestId: string | null;

  init: () => Promise<void>;
  newSession: (opts: {
    goal: string;
    mode: AgentMode;
    model: string;
    workspace: string | null;
    maxSteps: number;
    lintCommand: string;
    references?: Reference[];
  }) => string;
  selectSession: (id: string | null) => void;
  deleteSession: (id: string) => void;
  updateDraft: (
    id: string,
    patch: Partial<Pick<AgentSession, "goal" | "mode" | "model" | "maxSteps" | "lintCommand">>,
  ) => void;
  /** Push a Reference onto the active draft's `references` list. The
   *  list is locked while a turn is `running`; in all other statuses
   *  (idle, done, error, cancelled) the user may stage references for
   *  the next turn. */
  addRefToDraft: (id: string, r: Reference) => void;
  removeRefFromDraft: (id: string, index: number) => void;
  cloneSession: (id: string) => string;
  /**
   * Run the session's FIRST turn. The context is typically produced by
   * `buildContext(session.references)` and threaded through the IPC's
   * `context` field so the agent sees the same attachments chat sees.
   * For follow-up turns use `continueSession`.
   */
  run: (id: string, context?: string) => Promise<void>;
  /**
   * Send a follow-up message on an existing session, resuming the
   * stored Ollama transcript. Appends a `user_message` event for the
   * UI to render as a turn divider, then calls `agent_continue`.
   */
  continueSession: (id: string, message: string, context?: string) => Promise<void>;
  cancel: () => Promise<void>;
  /**
   * Compute a preflight step estimate for the active draft's current
   * goal. Pre-fills `maxSteps` when the user hasn't pinned it. Safe
   * to call repeatedly (debounced from the UI).
   */
  estimateBudget: (id: string) => Promise<void>;
  /**
   * Resolve a pending mid-run `<budget_bump>` request. `accept` keeps
   * the model's proposed value; `override` substitutes a different
   * number; `cancel` aborts the run. Calls the new
   * `agent_budget_decision` IPC.
   */
  respondToBudgetBump: (decision:
    | { kind: "accept" }
    | { kind: "override"; value: number }
    | { kind: "cancel" }
  ) => Promise<void>;
  /**
   * Mark a single change as kept — the BE drops the snapshot files
   * but the file on disk is left as-is. The change row stays on the
   * session with `status: "kept"` so the review log is auditable.
   */
  keepChange: (sessionId: string, changeId: string) => Promise<void>;
  /**
   * Restore a single change. The BE writes the captured `before`
   * blob back (or deletes the file, for a create; or renames, for
   * a rename). The change row stays on the session with
   * `status: "undone"`.
   */
  undoChange: (sessionId: string, changeId: string) => Promise<void>;
  /** Keep every pending change on the session in one click. */
  keepAllChanges: (sessionId: string) => Promise<void>;
  /**
   * Undo every pending change on the session in reverse order — last
   * change first so dependent edits unwind cleanly (e.g. a delete
   * followed by a create at the same path restores the original).
   */
  undoAllChanges: (sessionId: string) => Promise<void>;

  getActive: () => AgentSession | null;
};

// Bumped from v1 to v2 because we added `transcript`, `estimate`, and
// `maxStepsPinned`. `init` migrates v1 records by backfilling defaults;
// old sessions become view-only (no transcript to resume from), but
// clone-to-new-draft still works.
const SESSIONS_KEY = "agent.sessions.v2";
const SESSIONS_KEY_V1 = "agent.sessions.v1";
const ACTIVE_KEY = "agent.active.v1";

export const useAgent = create<State>((set, get) => ({
  hydrated: false,
  sessions: [],
  activeSessionId: null,
  phase: { kind: "idle" },
  currentRequestId: null,

  init: async () => {
    const [v2, v1, active] = await Promise.all([
      getItem<AgentSession[]>(SESSIONS_KEY).catch(() => undefined),
      getItem<AgentSession[]>(SESSIONS_KEY_V1).catch(() => undefined),
      getItem<string | null>(ACTIVE_KEY).catch(() => null),
    ]);
    // v2 wins when present; otherwise migrate v1 in place. v1 had no
    // `transcript`/`estimate` so old sessions become view-only history
    // for the UI (clone-to-new-draft still works because that copies
    // config, not the transcript).
    const raw = v2 ?? v1 ?? [];
    const migratedFromV1 = !v2 && !!v1;
    // Repair pass: any session left in 'running' across a process
    // restart must be flipped to 'cancelled' (the underlying request
    // was abandoned). Backfill the post-v1 fields so the UI never
    // has to handle undefined on the render path.
    const repaired: AgentSession[] = raw.map((s) => ({
      ...s,
      status: s.status === "running" ? ("cancelled" as const) : s.status,
      references: Array.isArray(s.references) ? s.references : [],
      transcript: Array.isArray((s as { transcript?: unknown }).transcript)
        ? (s as { transcript: AgentMessage[] }).transcript
        : [],
      estimate:
        (s as { estimate?: { steps: number; summary: string } | null }).estimate ?? null,
      maxStepsPinned:
        (s as { maxStepsPinned?: boolean }).maxStepsPinned ?? false,
      // v2 sessions predate the change journal — backfill to [] so the
      // UI never sees `undefined` on the render path. Old sessions
      // can't be reviewed (no snapshots exist), but the empty array
      // means the "Review changes" card simply doesn't render.
      changes: Array.isArray((s as { changes?: unknown }).changes)
        ? (s as { changes: FileChange[] }).changes
        : [],
    }));
    set({
      sessions: repaired,
      activeSessionId: active ?? null,
      hydrated: true,
    });
    // Persist the migration (so the next startup reads from v2 and we
    // can eventually drop the v1 read entirely) OR any in-place repair.
    const dirty =
      migratedFromV1 ||
      repaired.some(
        (s, i) =>
          s.status !== raw[i]?.status ||
          (raw[i] && !Array.isArray((raw[i] as { references?: unknown }).references)) ||
          (raw[i] && !Array.isArray((raw[i] as { transcript?: unknown }).transcript)),
      );
    if (dirty) flush(get());
  },

  newSession: ({ goal, mode, model, workspace, maxSteps, lintCommand, references }) => {
    const s: AgentSession = {
      id: `agt_${crypto.randomUUID().slice(0, 12)}`,
      title: deriveTitle(goal),
      goal,
      mode,
      model,
      workspace,
      maxSteps,
      lintCommand,
      status: "idle",
      events: [],
      references: references ?? [],
      transcript: [],
      estimate: null,
      maxStepsPinned: false,
      changes: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set((st) => ({
      sessions: [s, ...st.sessions],
      activeSessionId: s.id,
    }));
    flush(get());
    return s.id;
  },

  selectSession: (id) => {
    set({ activeSessionId: id, phase: { kind: "idle" } });
    persistAsync(ACTIVE_KEY, id);
  },

  deleteSession: (id) => {
    const st = get();
    const victim = st.sessions.find((x) => x.id === id);
    const next = st.sessions.filter((x) => x.id !== id);
    const activeSessionId =
      st.activeSessionId === id ? next[0]?.id ?? null : st.activeSessionId;
    set({ sessions: next, activeSessionId });
    flush(get());
    // Fire-and-forget snapshot cleanup so leftover change blobs from
    // pending rows don't accumulate forever. Kept/undone rows already
    // dropped their snapshot at decision time. Failures are silent —
    // a stale dir is harmless, the next purge will catch it.
    if (victim) {
      const pendingIds = victim.changes
        .filter((c) => c.status === "pending")
        .map((c) => c.id);
      if (pendingIds.length) {
        void ipc.agentPurgeChanges(pendingIds).catch(() => {});
      }
    }
  },

  updateDraft: (id, patch) => {
    set((st) => ({
      sessions: st.sessions.map((s) => {
        if (s.id !== id) return s;
        // Lock the draft only while a turn is actively running. Once
        // the run reaches a terminal status (done / error / cancelled)
        // the user is composing the NEXT turn, so the fields unlock.
        if (s.status === "running") return s;
        const updated: AgentSession = { ...s, ...patch, updatedAt: Date.now() };
        if (patch.goal !== undefined) updated.title = deriveTitle(patch.goal);
        // Pin maxSteps the moment the user touches it so subsequent
        // preflight estimates don't quietly stomp the manual value.
        if (patch.maxSteps !== undefined && patch.maxSteps !== s.maxSteps) {
          updated.maxStepsPinned = true;
        }
        return updated;
      }),
    }));
    flush(get());
  },

  addRefToDraft: (id, r) => {
    set((st) => ({
      sessions: st.sessions.map((s) => {
        if (s.id !== id) return s;
        if (s.status === "running") return s;
        return {
          ...s,
          references: [...s.references, r],
          updatedAt: Date.now(),
        };
      }),
    }));
    flush(get());
  },

  removeRefFromDraft: (id, index) => {
    set((st) => ({
      sessions: st.sessions.map((s) => {
        if (s.id !== id) return s;
        if (s.status === "running") return s;
        return {
          ...s,
          references: s.references.filter((_, i) => i !== index),
          updatedAt: Date.now(),
        };
      }),
    }));
    flush(get());
  },

  cloneSession: (id) => {
    const src = get().sessions.find((s) => s.id === id);
    if (!src) return get().activeSessionId ?? "";
    // Clone copies CONFIG only (goal, mode, model, refs) — it does
    // NOT carry the transcript or events. A clone is a fresh draft;
    // if the user wanted to continue the old conversation they'd
    // send a follow-up on the original session instead.
    return get().newSession({
      goal: src.goal,
      mode: src.mode,
      model: src.model,
      workspace: src.workspace,
      maxSteps: src.maxSteps,
      lintCommand: src.lintCommand,
      references: src.references,
    });
  },

  run: async (id, context) => {
    const st = get();
    const session = st.sessions.find((s) => s.id === id);
    if (!session || session.status === "running") return;

    // First turn of the session. We DO NOT wipe `events` if there are
    // any — for a fresh draft `events` is already empty, and for a
    // re-run on a finished session the right action is `continueSession`,
    // not `run`. Re-using `run` on a session that already has events
    // would conflate "start over" with "add a turn"; we preserve them.
    patchSession(set, get, id, {
      status: "running",
      // Clear the stale draft estimate now that the turn has started.
      estimate: null,
      updatedAt: Date.now(),
    });
    set({
      activeSessionId: id,
      phase: { kind: "warming", step: 0, sinceMs: Date.now() },
    });

    const rid = newRequestId("agent");
    set({ currentRequestId: rid });

    const off = await subscribeAgentEvents(set, get, id, rid);

    try {
      // Snapshot the editor's open tabs and active file so the
      // agent's <environment_details> block reflects what the user
      // is looking at right now. Cheap to compute, big quality lift
      // for "edit THIS file" style asks where the model would
      // otherwise have to guess.
      const editor = useEditorStore.getState();
      const openTabs = editor.tabs.map((t) => t.path);
      const activeFile = editor.activePath ?? undefined;

      await ipc.agentRun(rid, {
        model: session.model,
        goal: session.goal,
        workspace: session.workspace ?? undefined,
        max_steps: session.maxSteps,
        mode: session.mode,
        lint_command: session.lintCommand.trim() || undefined,
        // Threading `context` lets the agent's user-brief renderer
        // pull in @file / @selection / @diagnostic attachments built
        // by the same pipeline chat uses, so the agent and chat see
        // exactly the same context for a given set of references.
        context: context?.trim() ? context : undefined,
        open_tabs: openTabs.length ? openTabs : undefined,
        active_file: activeFile,
      });
    } catch (e) {
      pushEvent(set, get, id, { kind: "error", text: String(e) });
      patchSession(set, get, id, { status: "error" });
      set({ phase: { kind: "idle" }, currentRequestId: null });
      off();
      flush(get());
    }
  },

  continueSession: async (id, message, context) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const st = get();
    const session = st.sessions.find((s) => s.id === id);
    if (!session || session.status === "running") return;
    // No transcript means there's nothing for the BE to resume from
    // (this session predates v2, or its very first run somehow ended
    // without a transcript_snapshot). Fall through to a fresh `run`
    // with the message treated as the goal — preserves the chat-like
    // composer affordance for legacy sessions.
    if (session.transcript.length === 0) {
      patchSession(set, get, id, { goal: trimmed });
      await get().run(id, context);
      return;
    }

    // Record the user's message as a turn divider event so the
    // transcript card list shows the conversation flow.
    const userMessageEvent: AgentEvent = {
      kind: "user_message",
      text: trimmed,
      references: session.references,
      ts: Date.now(),
    };
    pushEvent(set, get, id, userMessageEvent);
    patchSession(set, get, id, {
      status: "running",
      // Clear the staged refs — they're now baked into this turn's
      // context. A fresh follow-up starts with no refs by default.
      references: [],
      estimate: null,
      updatedAt: Date.now(),
    });
    set({
      activeSessionId: id,
      phase: { kind: "warming", step: 0, sinceMs: Date.now() },
    });

    const rid = newRequestId("agent");
    set({ currentRequestId: rid });

    const off = await subscribeAgentEvents(set, get, id, rid);

    try {
      const editor = useEditorStore.getState();
      const openTabs = editor.tabs.map((t) => t.path);
      const activeFile = editor.activePath ?? undefined;

      await ipc.agentContinue(rid, {
        model: session.model,
        user_message: trimmed,
        transcript: session.transcript,
        workspace: session.workspace ?? undefined,
        max_steps: session.maxSteps,
        mode: session.mode,
        lint_command: session.lintCommand.trim() || undefined,
        context: context?.trim() ? context : undefined,
        open_tabs: openTabs.length ? openTabs : undefined,
        active_file: activeFile,
      });
    } catch (e) {
      pushEvent(set, get, id, { kind: "error", text: String(e) });
      patchSession(set, get, id, { status: "error" });
      set({ phase: { kind: "idle" }, currentRequestId: null });
      off();
      flush(get());
    }
  },

  cancel: async () => {
    const rid = get().currentRequestId;
    if (rid) await ipc.agentCancel(rid);
  },

  estimateBudget: async (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    // Cheap guard: nothing to estimate without a goal.
    const goal = session.goal.trim();
    if (!goal) return;
    // Don't pile up estimates while a turn is in flight.
    if (session.status === "running") return;
    // The estimator uses the chat-style model the user picked for the
    // agent — same model, but we'll skip if no model is set yet.
    if (!session.model) return;
    const rid = newRequestId("estimate");
    try {
      const result = await ipc.agentEstimate(rid, {
        model: session.model,
        goal,
        workspace: session.workspace ?? undefined,
        mode: session.mode,
      });
      const current = get().sessions.find((s) => s.id === id);
      // Bail if the user navigated away or the session is now running.
      if (!current || current.status === "running") return;
      const next: Partial<AgentSession> = {
        estimate: result,
        updatedAt: Date.now(),
      };
      // Pre-fill maxSteps unless the user pinned it explicitly.
      if (!current.maxStepsPinned) {
        next.maxSteps = clampSteps(result.steps);
      }
      patchSession(set, get, id, next);
      flush(get());
    } catch {
      /* swallow — estimate is a nice-to-have; never block the UI */
    }
  },

  respondToBudgetBump: async (decision) => {
    const rid = get().currentRequestId;
    if (!rid) return;
    if (decision.kind === "cancel") {
      await ipc.agentCancel(rid);
      return;
    }
    await ipc.agentBudgetDecision(rid, {
      accept: decision.kind === "accept",
      override:
        decision.kind === "override"
          ? clampSteps(decision.value)
          : undefined,
    });
  },

  keepChange: async (sessionId, changeId) => {
    // Optimistically mark the row as kept so the UI updates
    // immediately; revert on failure (rare — keep is just snapshot
    // deletion in the BE) so the user can retry.
    const prev = get().sessions.find((s) => s.id === sessionId)
      ?.changes.find((c) => c.id === changeId);
    if (!prev || prev.status !== "pending") return;
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
        workspace: session.workspace ?? "",
        kind: change.kind,
        path: change.path,
        from: change.from,
      });
    } catch {
      // Roll the row back so the user can see it's still pending
      // and decide whether to retry or just Keep.
      setChangeStatus(set, get, sessionId, changeId, "pending");
      throw new Error("undo failed — file may have changed since");
    }
  },

  keepAllChanges: async (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const pending = session.changes.filter((c) => c.status === "pending");
    for (const c of pending) {
      // Each call is small (just snapshot dir removal) and we want
      // partial progress to be visible on the UI rather than waiting
      // for everything to flush at once.
      await get().keepChange(sessionId, c.id);
    }
  },

  undoAllChanges: async (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session) return;
    // Reverse order: a delete-then-recreate at the same path needs
    // the create undone first (which removes the file) before the
    // delete is undone (which restores the original content).
    const pending = session.changes
      .filter((c) => c.status === "pending")
      .slice()
      .reverse();
    for (const c of pending) {
      try {
        await get().undoChange(sessionId, c.id);
      } catch {
        // Surface partial failures to the caller via the per-row
        // status; don't abort the whole batch.
      }
    }
  },

  getActive: () => {
    const st = get();
    return st.sessions.find((s) => s.id === st.activeSessionId) ?? null;
  },
}));

/**
 * Shared event-loop subscription used by both `run` (first turn) and
 * `continueSession` (follow-up turns). Maintains the per-turn `phase`
 * machine, captures `transcript_snapshot` payloads onto the session,
 * surfaces budget bumps, and tears down its own listener on terminal
 * events. Returns the unsubscribe so callers can also release it on
 * an early IPC failure.
 */
async function subscribeAgentEvents(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  sessionId: string,
  rid: string,
): Promise<() => void> {
  const off = await listenEvent<AgentEvent>(`agent:event:${rid}`, (e) => {
    // transcript_snapshot is consumed by the store, not rendered.
    // Skip the events[] append so it doesn't show up in the UI.
    if (e.kind === "transcript_snapshot") {
      patchSession(set, get, sessionId, {
        transcript: e.messages,
        updatedAt: Date.now(),
      });
      return;
    }
    // Tool results from the mutating tools carry a `change` payload
    // (FileChangeRecord) in `extra` — pull it off and append to the
    // session's change journal so the Review Changes card can render
    // it at end of turn. Do this BEFORE pushEvent so the event log
    // and the change journal stay perfectly in sync per turn.
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
      case "budget_bump_request":
        set({
          phase: {
            kind: "awaiting_budget_bump",
            step: e.step,
            proposed: e.proposed,
            reason: e.reason,
          },
        });
        break;
      case "tool_result":
        set({ phase: { kind: "warming", step: e.step, sinceMs: Date.now() } });
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
  });
  return off;
}

function clampSteps(n: number): number {
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(100, Math.round(n)));
}

/** Last N KB we keep on a coalesced shell_progress event. Enough
 * for a live tail in the UI, small enough to keep the persisted
 * session under a few hundred KB even after a verbose install. */
export const SHELL_PROGRESS_TAIL_CHARS = 16_000;

/**
 * Append an agent event onto an existing event list, coalescing
 * consecutive `shell_progress` chunks for the same stream so a
 * verbose install doesn't push thousands of micro-events into the
 * session (which would tank rendering + persistence).
 *
 * Pure function so it's unit-testable without spinning up the
 * whole Zustand store.
 */
export function appendAgentEvent(events: AgentEvent[], e: AgentEvent): AgentEvent[] {
  if (e.kind === "shell_progress") {
    const last = events[events.length - 1];
    if (
      last &&
      last.kind === "shell_progress" &&
      last.stream === e.stream &&
      last.request_id === e.request_id
    ) {
      const merged = (last.chunk + e.chunk).slice(-SHELL_PROGRESS_TAIL_CHARS);
      return [...events.slice(0, -1), { ...last, chunk: merged }];
    }
  }
  return [...events, e];
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
  // Flush periodically — every 10th NON-shell-progress event so
  // a chatty install doesn't blow up the persistence layer.
  if (e.kind === "shell_progress") return;
  const len = get().sessions.find((s) => s.id === id)?.events.length ?? 0;
  if (len % 10 === 0) flush(get());
}

function patchSession(
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State,
  id: string,
  patch: Partial<AgentSession>,
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

function deriveTitle(goal: string): string {
  const first = goal.split("\n").find((l) => l.trim()) ?? goal;
  const trimmed = first.trim().slice(0, 64);
  return trimmed.length === 0 ? "New agent run" : trimmed;
}

/** Type guard for the FileChange payload that comes back inside
 *  `tool_result.extra.change`. We only need a duck-type — the BE
 *  controls the shape exactly. Returning false here means the
 *  payload was malformed (very old BE? corrupt event?) and the
 *  change journal silently drops it rather than rendering garbage. */
function isFileChangePayload(v: unknown): v is FileChange {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.step === "number" &&
    (o.kind === "create" || o.kind === "modify" || o.kind === "delete" || o.kind === "rename") &&
    typeof o.path === "string" &&
    typeof o.before_bytes === "number" &&
    typeof o.after_bytes === "number" &&
    (o.status === "pending" || o.status === "kept" || o.status === "undone")
  );
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
      // The BE may resend a tool_result snapshot during transcript
      // replay; dedupe by id so a single change can't appear twice.
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
      s.id !== sessionId
        ? s
        : {
            ...s,
            changes: s.changes.map((c) =>
              c.id === changeId ? { ...c, status } : c,
            ),
            updatedAt: Date.now(),
          },
    ),
  }));
  flush(get());
}
