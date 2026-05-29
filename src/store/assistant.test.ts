/**
 * Migration round-trips for the unified Assistant store.
 *
 * The user's two prior stores — `chat.sessions.v1` and
 * `agent.sessions.v2` — both contain history that must survive the
 * collapse into the new `assistant.sessions.v1` shape. These tests
 * pin the migration so a future refactor can't silently drop
 * conversations on upgrade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { migrateLegacy, useAssistant } from "./assistant";
import type { ChatSession } from "./chat";
import type { AgentSession } from "./agentSessions";

describe("assistant migration", () => {
  it("maps a chat session to ask mode with reconstructed ledger", () => {
    const chat: ChatSession = {
      id: "chat_abc123def",
      title: "buffer pool design",
      model: "qwen2.5-coder:32b",
      createdAt: 100,
      updatedAt: 200,
      messages: [
        { id: "u1", role: "user", content: "explain the buffer pool" },
        {
          id: "a1",
          role: "assistant",
          content:
            "It uses clock-sweep eviction. We rejected ARC for the memory overhead.",
        },
        { id: "u2", role: "user", content: "and the write-back path?" },
        {
          id: "a2",
          role: "assistant",
          content: "Writes are coalesced behind a dirty page list.",
        },
      ],
    };
    const [migrated] = migrateLegacy([chat], []);
    expect(migrated.mode).toBe("ask");
    expect(migrated.title).toBe("buffer pool design");
    expect(migrated.model).toBe("qwen2.5-coder:32b");
    expect(migrated.messages).toHaveLength(4);
    // Two assistant turns -> two ledger entries.
    expect(migrated.ledger).toHaveLength(2);
    expect(migrated.ledger[0].mode).toBe("ask");
    expect(migrated.ledger[0].kind.type).toBe("answered_only");
    if (migrated.ledger[0].kind.type === "answered_only") {
      expect(migrated.ledger[0].kind.summary).toContain("clock-sweep");
    }
    // Plan/agent-only fields backfill to empty.
    expect(migrated.transcript).toEqual([]);
    expect(migrated.events).toEqual([]);
    expect(migrated.changes).toEqual([]);
  });

  it("maps an agent session to plan/agent mode and rebuilds the ledger", () => {
    const agent: AgentSession = {
      id: "agt_xyz890ghi",
      title: "add feature flag",
      goal: "add a feature flag for the new exporter",
      mode: "auto",
      model: "qwen2.5-coder:32b",
      workspace: "/tmp/ws",
      maxSteps: 20,
      lintCommand: "cargo check",
      status: "done",
      events: [
        {
          kind: "tool_result",
          step: 1,
          tool: "write_file",
          status: "ok",
          result: "wrote",
          extra: { path: "src/flags.rs" },
        },
        {
          kind: "tool_result",
          step: 2,
          tool: "edit_file",
          status: "ok",
          result: "patched",
          extra: { path: "src/lib.rs" },
        },
        {
          kind: "final",
          step: 3,
          text: "Added the EXPORTER_V2 flag and wired it into the lib root.",
        },
      ],
      references: [],
      transcript: [
        { role: "system", content: "..." },
        { role: "user", content: "..." },
      ],
      estimate: null,
      maxStepsPinned: false,
      changes: [],
      createdAt: 50,
      updatedAt: 60,
    };
    const [migrated] = migrateLegacy([], [agent]);
    // Legacy "auto" collapses to the unified "agent" UI mode.
    expect(migrated.mode).toBe("agent");
    expect(migrated.title).toBe("add feature flag");
    expect(migrated.workspace).toBe("/tmp/ws");
    // Two writes + one final -> three ledger entries.
    expect(migrated.ledger).toHaveLength(3);
    const wrote = migrated.ledger.filter((e) => e.kind.type === "wrote");
    expect(wrote).toHaveLength(2);
    expect(wrote.map((e) => (e.kind.type === "wrote" ? e.kind.path : ""))).toEqual([
      "src/flags.rs",
      "src/lib.rs",
    ]);
    // Visible transcript carries goal + final answer.
    expect(migrated.messages[0].role).toBe("user");
    expect(migrated.messages[0].content).toBe("add a feature flag for the new exporter");
    expect(migrated.messages.at(-1)?.role).toBe("assistant");
  });

  it("preserves plan mode when migrating", () => {
    const agent: AgentSession = {
      id: "agt_plan",
      title: "plan only",
      goal: "plan the migration",
      mode: "plan",
      model: "qwen",
      workspace: null,
      maxSteps: 10,
      lintCommand: "",
      status: "done",
      events: [{ kind: "plan", step: 1, text: "step 1; step 2" }],
      references: [],
      transcript: [],
      estimate: null,
      maxStepsPinned: false,
      changes: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const [migrated] = migrateLegacy([], [agent]);
    expect(migrated.mode).toBe("plan");
  });

  it("flips abandoned 'running' sessions to cancelled", () => {
    const agent: AgentSession = {
      id: "agt_running",
      title: "abandoned",
      goal: "do a thing",
      mode: "auto",
      model: "qwen",
      workspace: null,
      maxSteps: 10,
      lintCommand: "",
      // Crashed/quit while running — must NOT leak into the new
      // store as "still running" or the composer stays locked.
      status: "running",
      events: [],
      references: [],
      transcript: [],
      estimate: null,
      maxStepsPinned: false,
      changes: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const [migrated] = migrateLegacy([], [agent]);
    expect(migrated.status).toBe("cancelled");
  });

  it("ignores failed tool calls when reconstructing the ledger", () => {
    // A rejected/errored tool result must not appear in the
    // ledger — recording it would falsely tell the next turn
    // the file changed.
    const agent: AgentSession = {
      id: "agt_fail",
      title: "x",
      goal: "x",
      mode: "auto",
      model: "qwen",
      workspace: null,
      maxSteps: 10,
      lintCommand: "",
      status: "done",
      events: [
        {
          kind: "tool_result",
          step: 1,
          tool: "write_file",
          status: "rejected",
          result: "user rejected",
          extra: { path: "src/x.rs" },
        },
        {
          kind: "tool_result",
          step: 2,
          tool: "edit_file",
          status: "error",
          result: "SEARCH not found",
          extra: { path: "src/y.rs" },
        },
      ],
      references: [],
      transcript: [],
      estimate: null,
      maxStepsPinned: false,
      changes: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const [migrated] = migrateLegacy([], [agent]);
    expect(migrated.ledger).toHaveLength(0);
  });

  it("sorts merged sessions newest-first across both stores", () => {
    const chat: ChatSession = {
      id: "chat_a",
      title: "old chat",
      model: "qwen",
      createdAt: 10,
      updatedAt: 10,
      messages: [],
    };
    const agent: AgentSession = {
      id: "agt_b",
      title: "new agent",
      goal: "g",
      mode: "auto",
      model: "qwen",
      workspace: null,
      maxSteps: 10,
      lintCommand: "",
      status: "done",
      events: [],
      references: [],
      transcript: [],
      estimate: null,
      maxStepsPinned: false,
      changes: [],
      createdAt: 100,
      updatedAt: 100,
    };
    const merged = migrateLegacy([chat], [agent]);
    expect(merged.map((s) => s.title)).toEqual(["new agent", "old chat"]);
  });

  it("is a no-op when both legacy stores are empty", () => {
    expect(migrateLegacy([], [])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Store behaviour: mode switching mid-session and plan->execute
// promotion preserve the unified ledger.
// ─────────────────────────────────────────────────────────────────────

describe("useAssistant mode switching + plan promotion", () => {
  // We exercise the store's reducers directly via setState/getState so
  // we don't pull in the IPC layer. The behaviours under test are
  // pure-state transitions; the IPC side-effects live in send/
  // executePlan and are tested separately above.
  //
  // beforeEach: snapshot the initial store state so each test starts
  // from a clean slate. Zustand stores are singletons in the module
  // graph, so we have to roll back between tests manually.
  let initial: ReturnType<typeof getStore>;
  function getStore() {
    return useAssistant.getState();
  }
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    initial = getStore();
    useAssistant.setState(
      {
        ...initial,
        sessions: [],
        activeSessionId: null,
        pendingRefs: [],
        phase: { kind: "idle" },
        currentRequestId: null,
        hydrated: true,
      },
      true,
    );
  });

  it("preserves transcript and ledger when switching modes mid-session", () => {
    const id = getStore().newSession({ mode: "agent", model: "qwen" });
    // Seed the session with a transcript + ledger + visible
    // message to mimic an in-flight conversation.
    useAssistant.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id !== id
          ? sess
          : {
              ...sess,
              status: "idle",
              transcript: [
                { role: "user", content: "do the thing" },
                { role: "assistant", content: "done" },
              ],
              ledger: [
                {
                  turn: 1,
                  timestamp_ms: 0,
                  mode: "agent",
                  kind: { type: "wrote", path: "src/foo.ts", bytes: 10, hunks: 1 },
                },
              ],
              messages: [
                { id: "m1", role: "user", content: "do the thing" },
                { id: "m2", role: "assistant", content: "done" },
              ],
            },
      ),
    }));
    getStore().setSessionMode(id, "ask");
    const after = getStore().sessions.find((s) => s.id === id)!;
    expect(after.mode).toBe("ask");
    expect(after.transcript).toHaveLength(2);
    expect(after.ledger).toHaveLength(1);
    expect(after.messages).toHaveLength(2);
  });

  it("refuses to switch mode while a turn is running", () => {
    // Mid-run mode swaps would orphan the active stream — the
    // composer's lock state assumes session.status === running
    // means the mode is pinned for the duration.
    const id = getStore().newSession({ mode: "ask", model: "qwen" });
    useAssistant.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, status: "running" as const } : sess,
      ),
    }));
    getStore().setSessionMode(id, "agent");
    expect(getStore().sessions.find((s) => s.id === id)!.mode).toBe("ask");
  });

  it("updates the session model unless the turn is running", () => {
    const id = getStore().newSession({ mode: "ask", model: "chat-model" });
    getStore().setSessionModel(id, "agent-model");
    expect(getStore().sessions.find((s) => s.id === id)!.model).toBe("agent-model");

    useAssistant.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, status: "running" as const } : sess,
      ),
    }));
    getStore().setSessionModel(id, "should-not-apply");
    expect(getStore().sessions.find((s) => s.id === id)!.model).toBe("agent-model");
  });

  it("flipping a session to plan mode does not reset the ledger", () => {
    const id = getStore().newSession({ mode: "ask", model: "qwen" });
    useAssistant.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id !== id
          ? sess
          : {
              ...sess,
              status: "idle",
              ledger: [
                {
                  turn: 1,
                  timestamp_ms: 0,
                  mode: "ask",
                  kind: { type: "answered_only", summary: "explained X" },
                },
              ],
            },
      ),
    }));
    getStore().setSessionMode(id, "plan");
    const after = getStore().sessions.find((s) => s.id === id)!;
    expect(after.mode).toBe("plan");
    // The Ask-mode entry survives so the plan turn sees the
    // conversational thread in <previous_work>.
    expect(after.ledger).toHaveLength(1);
    expect(after.ledger[0].kind.type).toBe("answered_only");
  });

  it("new sessions start with empty ledger and ask mode by default", () => {
    const id = getStore().newSession({ mode: "ask", model: "qwen" });
    const s = getStore().sessions.find((x) => x.id === id)!;
    expect(s.mode).toBe("ask");
    expect(s.ledger).toEqual([]);
    expect(s.transcript).toEqual([]);
    expect(s.messages).toEqual([]);
    expect(s.status).toBe("idle");
  });

  it("marks ask-mode turns as running while the stream is active", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const id = getStore().newSession({ mode: "ask", model: "qwen" });

    await getStore().send("Tell me about App.jsx", { defaultModel: "qwen" });

    const s = getStore().sessions.find((x) => x.id === id)!;
    expect(s.status).toBe("running");
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages.at(-1)?.streaming).toBe(true);
    expect(getStore().phase.kind).toBe("warming");
    expect(getStore().currentRequestId).toMatch(/^ask_/);
  });

  it("answers direct Ask-mode edit requests with the deterministic mode redirect", async () => {
    const id = getStore().newSession({ mode: "ask", model: "qwen" });

    await getStore().send("Fix src/App.jsx so the nav works", { defaultModel: "qwen" });

    const s = getStore().sessions.find((x) => x.id === id)!;
    expect(invoke).not.toHaveBeenCalled();
    expect(s.status).toBe("done");
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages.at(-1)?.content).toBe(
      "Switch to Agent mode and I can apply that edit, or Plan mode if you want to review the plan first.",
    );
    expect(s.ledger.at(-1)?.kind).toEqual({
      type: "answered_only",
      summary:
        "Switch to Agent mode and I can apply that edit, or Plan mode if you want to review the plan first.",
    });
  });

  it("deleting the active session clears activeSessionId or falls back", () => {
    const a = getStore().newSession({ mode: "ask", model: "qwen" });
    const b = getStore().newSession({ mode: "plan", model: "qwen" });
    // newSession leaves the newest selected; deleting it should
    // fall back to the next-newest, not leave activeId pointing
    // at a tombstone.
    expect(getStore().activeSessionId).toBe(b);
    getStore().deleteSession(b);
    expect(getStore().activeSessionId).toBe(a);
    getStore().deleteSession(a);
    expect(getStore().activeSessionId).toBeNull();
  });

  it("promotes only the latest plan block into the agent execution request", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const id = getStore().newSession({ mode: "plan", model: "qwen" });
    useAssistant.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id !== id
          ? sess
          : {
              ...sess,
              status: "done",
              transcript: [{ role: "assistant", content: "<plan>draft</plan>" }],
              events: [
                { kind: "plan", step: 1, text: "1. Read files to make a plan." },
                {
                  kind: "plan",
                  step: 4,
                  text: "1. Edit src/App.jsx to add the route.\n2. Verify with npm test.",
                },
              ],
            },
      ),
    }));

    await getStore().executePlan(id);

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "agent_execute_plan",
      expect.objectContaining({
        request: expect.objectContaining({
          plan_text: "1. Edit src/App.jsx to add the route.\n2. Verify with npm test.",
          model: "qwen",
        }),
      }),
    );
    expect(getStore().sessions.find((s) => s.id === id)?.mode).toBe("agent");
  });

  it("does not start agent execution without a plan block", async () => {
    const id = getStore().newSession({ mode: "plan", model: "qwen" });
    await getStore().executePlan(id);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("keeps individual agent changes through the backend journal", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const id = getStore().newSession({ mode: "agent", model: "qwen" });
    useAssistant.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id
          ? {
              ...sess,
              changes: [
                {
                  id: "11111111-1111-1111-1111-111111111111",
                  step: 3,
                  kind: "modify" as const,
                  path: "src/App.tsx",
                  before_bytes: 10,
                  after_bytes: 12,
                  status: "pending" as const,
                },
              ],
            }
          : sess,
      ),
    }));

    await getStore().keepChange(id, "11111111-1111-1111-1111-111111111111");

    expect(invoke).toHaveBeenCalledWith("agent_keep_change", {
      changeId: "11111111-1111-1111-1111-111111111111",
    });
    expect(
      getStore()
        .sessions.find((s) => s.id === id)
        ?.changes.at(0)?.status,
    ).toBe("kept");
  });

  it("undoes agent changes with the workspace and file metadata needed by Rust", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "agent_undo_change") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    const id = getStore().newSession({ mode: "agent", model: "qwen" });
    useAssistant.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id
          ? {
              ...sess,
              workspace: "/tmp/ws",
              changes: [
                {
                  id: "22222222-2222-2222-2222-222222222222",
                  step: 5,
                  kind: "rename" as const,
                  from: "src/old.ts",
                  path: "src/new.ts",
                  before_bytes: 0,
                  after_bytes: 0,
                  status: "pending" as const,
                },
              ],
            }
          : sess,
      ),
    }));

    await getStore().undoChange(id, "22222222-2222-2222-2222-222222222222");

    expect(invoke).toHaveBeenCalledWith("agent_undo_change", {
      req: {
        change_id: "22222222-2222-2222-2222-222222222222",
        workspace: "/tmp/ws",
        kind: "rename",
        path: "src/new.ts",
        from: "src/old.ts",
      },
    });
    expect(
      getStore()
        .sessions.find((s) => s.id === id)
        ?.changes.at(0)?.status,
    ).toBe("undone");
  });

  it("purges only unresolved change snapshots when deleting a session", () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const id = getStore().newSession({ mode: "agent", model: "qwen" });
    useAssistant.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id
          ? {
              ...sess,
              changes: [
                {
                  id: "33333333-3333-3333-3333-333333333333",
                  step: 1,
                  kind: "modify" as const,
                  path: "src/a.ts",
                  before_bytes: 1,
                  after_bytes: 2,
                  status: "pending" as const,
                },
                {
                  id: "44444444-4444-4444-4444-444444444444",
                  step: 2,
                  kind: "modify" as const,
                  path: "src/b.ts",
                  before_bytes: 2,
                  after_bytes: 3,
                  status: "kept" as const,
                },
              ],
            }
          : sess,
      ),
    }));

    getStore().deleteSession(id);

    expect(invoke).toHaveBeenCalledWith("agent_purge_changes", {
      changeIds: ["33333333-3333-3333-3333-333333333333"],
    });
  });
});
