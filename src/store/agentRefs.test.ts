/**
 * Tests for the agent draft reference operations.
 *
 * `addRefToDraft` / `removeRefFromDraft` are the only mutation entry
 * points for the new `references` field. Both honour the same
 * "frozen once running" contract that `updateDraft` does — running
 * sessions must not be retroactively edited.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useAgent } from "./agentSessions";
import type { Reference } from "./chat";

function resetAgentStore() {
  useAgent.setState({
    sessions: [],
    activeSessionId: null,
    phase: { kind: "idle" },
    currentRequestId: null,
    hydrated: true,
  });
}

const fileRef: Reference = { kind: "file", path: "src/App.tsx" };
const selRef: Reference = {
  kind: "selection",
  path: "src/x.ts",
  startLine: 1,
  endLine: 2,
  text: "x;",
};

describe("agent draft refs", () => {
  beforeEach(() => resetAgentStore());

  it("starts with an empty reference list on a fresh draft", () => {
    const id = useAgent.getState().newSession({
      goal: "",
      mode: "ask",
      model: "qwen2.5-coder:7b-instruct",
      workspace: "/tmp/proj",
      maxSteps: 20,
      lintCommand: "",
    });
    const s = useAgent.getState().sessions.find((x) => x.id === id);
    expect(s?.references).toEqual([]);
  });

  it("appends references via addRefToDraft", () => {
    const id = useAgent.getState().newSession({
      goal: "",
      mode: "ask",
      model: "qwen2.5-coder:7b-instruct",
      workspace: "/tmp/proj",
      maxSteps: 20,
      lintCommand: "",
    });
    useAgent.getState().addRefToDraft(id, fileRef);
    useAgent.getState().addRefToDraft(id, selRef);
    const s = useAgent.getState().sessions.find((x) => x.id === id)!;
    expect(s.references).toEqual([fileRef, selRef]);
  });

  it("removes by index without disturbing the rest of the list", () => {
    const id = useAgent.getState().newSession({
      goal: "",
      mode: "ask",
      model: "qwen2.5-coder:7b-instruct",
      workspace: "/tmp/proj",
      maxSteps: 20,
      lintCommand: "",
      references: [fileRef, selRef],
    });
    useAgent.getState().removeRefFromDraft(id, 0);
    const s = useAgent.getState().sessions.find((x) => x.id === id)!;
    expect(s.references).toEqual([selRef]);
  });

  it("is a no-op once the session has started running", () => {
    const id = useAgent.getState().newSession({
      goal: "",
      mode: "ask",
      model: "qwen2.5-coder:7b-instruct",
      workspace: "/tmp/proj",
      maxSteps: 20,
      lintCommand: "",
      references: [fileRef],
    });
    // Manually flip into 'running' to simulate the post-launch state.
    useAgent.setState((st) => ({
      sessions: st.sessions.map((s) =>
        s.id === id ? { ...s, status: "running" as const } : s,
      ),
    }));
    useAgent.getState().addRefToDraft(id, selRef);
    useAgent.getState().removeRefFromDraft(id, 0);
    const s = useAgent.getState().sessions.find((x) => x.id === id)!;
    // No change — running sessions are frozen.
    expect(s.references).toEqual([fileRef]);
  });

  it("clones a session with its existing references", () => {
    const id = useAgent.getState().newSession({
      goal: "task",
      mode: "ask",
      model: "qwen2.5-coder:7b-instruct",
      workspace: "/tmp/proj",
      maxSteps: 20,
      lintCommand: "",
      references: [fileRef, selRef],
    });
    const cloned = useAgent.getState().cloneSession(id);
    const c = useAgent.getState().sessions.find((x) => x.id === cloned)!;
    expect(c.references).toEqual([fileRef, selRef]);
    expect(c.id).not.toBe(id);
  });
});
