/**
 * Tests for the send-to-AI routing layer.
 *
 * `sendToAI` glues the unified Assistant store together with the
 * dock session, so the tests verify:
 *   • Selection refs land on the active session and switch the
 *     dock view to "assistant".
 *   • Diagnostic refs pull the offending snippet via IPC and
 *     include it in the staged reference.
 *   • Staging in a mode that doesn't match the active session
 *     either flips the mode or spawns a new session, depending on
 *     whether the active session is busy.
 *   • Batch send dedupes diagnostics by (uri, line, code, message).
 *
 * We stub the Tauri IPC layer used by `ipc.readTextFile` so the
 * tests stay hermetic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAssistant } from "@/store/assistant";
import { useSession } from "@/store/session";
import { useDiagnostics, type Diagnostic } from "@/store/diagnostics";
import {
  sendAllDiagnosticsToAI,
  sendBreakpointToAI,
  sendDebugValueToAI,
  sendDiagnosticToAI,
  sendSelectionToAI,
} from "./sendToAI";

function resetStores() {
  useAssistant.setState({
    sessions: [],
    activeSessionId: null,
    pendingRefs: [],
    phase: { kind: "idle" },
    currentRequestId: null,
    hydrated: true,
  });
  useSession.setState({
    dockView: null,
    root: "/tmp/proj",
    openTabs: [],
    activePath: null,
    chatOpen: true,
    fileTreeWidth: 256,
    chatWidth: 420,
    treeCollapsed: false,
    recents: [],
    hydrated: true,
  });
  useDiagnostics.setState({ byUri: {}, errors: 0, warnings: 0 });
}

const sampleDiag = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  uri: "file:///workspace/src/foo.ts",
  name: "foo.ts",
  startLine: 7,
  startCol: 4,
  endLine: 7,
  endCol: 12,
  severity: "error",
  message: "Cannot find name 'foo'.",
  source: "ts",
  code: "TS2304",
  ...over,
});

describe("sendSelectionToAI", () => {
  beforeEach(() => resetStores());

  it("stages a selection reference on the assistant and opens the dock", () => {
    // The legacy "chat" target maps to the unified Ask mode.
    sendSelectionToAI("chat", {
      path: "src/foo.ts",
      startLine: 1,
      endLine: 3,
      text: "console.log('hi');",
    });
    const st = useAssistant.getState();
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0].mode).toBe("ask");
    expect(st.pendingRefs).toHaveLength(1);
    expect(st.pendingRefs[0]).toMatchObject({
      kind: "selection",
      path: "src/foo.ts",
      startLine: 1,
      endLine: 3,
    });
    expect(useSession.getState().dockView).toBe("assistant");
  });

  it("creates an agent-mode session when staging to agent and none exists", () => {
    sendSelectionToAI("agent", {
      path: "src/bar.ts",
      startLine: 5,
      endLine: 5,
      text: "x = 1;",
    });
    const st = useAssistant.getState();
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0].mode).toBe("agent");
    expect(st.pendingRefs).toHaveLength(1);
    expect(useSession.getState().dockView).toBe("assistant");
  });

  it("flips an idle session's mode rather than spawning a new one", () => {
    // Existing idle Ask session — sending to agent should reuse it
    // by flipping its mode in place. Stacking a new session every
    // time the user changed targets would be noisy.
    useAssistant.getState().newSession({ mode: "ask", model: "qwen" });
    sendSelectionToAI("agent", {
      path: "src/foo.ts",
      startLine: 1,
      endLine: 1,
      text: "y;",
    });
    const st = useAssistant.getState();
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0].mode).toBe("agent");
  });
});

describe("sendDiagnosticToAI", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string, args) => {
      if (cmd === "read_text_file") {
        // Return enough lines so `lineRange(7,7)` picks line 7.
        const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
        return lines.join("\n");
      }
      throw new Error(`unexpected invoke ${cmd} ${JSON.stringify(args)}`);
    });
  });

  it("attaches a diagnostic ref with the offending snippet", async () => {
    await sendDiagnosticToAI("chat", sampleDiag());
    const refs = useAssistant.getState().pendingRefs;
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    if (ref.kind !== "diagnostic") throw new Error("expected diagnostic ref");
    expect(ref.severity).toBe("error");
    expect(ref.code).toBe("TS2304");
    expect(ref.snippet).toBe("line 7");
    expect(ref.path).toBe("/workspace/src/foo.ts");
    expect(useSession.getState().dockView).toBe("assistant");
  });

  it("still attaches the diagnostic when the file read fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("ENOENT"));
    await sendDiagnosticToAI("chat", sampleDiag());
    const refs = useAssistant.getState().pendingRefs;
    expect(refs).toHaveLength(1);
    if (refs[0].kind !== "diagnostic") throw new Error("expected diagnostic ref");
    expect(refs[0].snippet).toBe("");
  });

  it("routes to agent mode when the target is 'agent'", async () => {
    await sendDiagnosticToAI("agent", sampleDiag());
    const st = useAssistant.getState();
    expect(st.sessions[0].mode).toBe("agent");
    expect(st.pendingRefs).toHaveLength(1);
    expect(useSession.getState().dockView).toBe("assistant");
  });
});

describe("sendAllDiagnosticsToAI", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue("only one line");
  });

  it("dedupes diagnostics that share uri/line/code/message", async () => {
    const d1 = sampleDiag();
    const d2 = sampleDiag({ source: "eslint" }); // same key, different source
    const d3 = sampleDiag({ startLine: 9 }); // distinct line
    useDiagnostics.setState({
      byUri: { "file:///workspace/src/foo.ts": [d1, d2, d3] },
      errors: 3,
      warnings: 0,
    });
    const n = await sendAllDiagnosticsToAI("chat");
    expect(n).toBe(2);
    expect(useAssistant.getState().pendingRefs).toHaveLength(2);
  });

  it("returns zero when there are no diagnostics", async () => {
    const n = await sendAllDiagnosticsToAI("chat");
    expect(n).toBe(0);
    expect(useAssistant.getState().pendingRefs).toHaveLength(0);
  });
});

describe("send debugger references to AI", () => {
  beforeEach(() => resetStores());

  it("stages breakpoint references on the requested mode", () => {
    sendBreakpointToAI("plan", {
      id: "bp_1",
      path: "/workspace/src/foo.ts",
      line: 11,
      enabled: true,
      condition: "ready",
      createdAt: 1,
    });
    const st = useAssistant.getState();
    expect(st.sessions[0].mode).toBe("plan");
    expect(st.pendingRefs[0]).toMatchObject({
      kind: "breakpoint",
      path: "/workspace/src/foo.ts",
      line: 11,
      condition: "ready",
    });
  });

  it("stages debug values on the requested mode", () => {
    sendDebugValueToAI("agent", {
      id: "dbg_1",
      name: "payload",
      value: "{ ok: false }",
      type: "Payload",
      path: "/workspace/src/foo.ts",
      line: 20,
      createdAt: 1,
    });
    const st = useAssistant.getState();
    expect(st.sessions[0].mode).toBe("agent");
    expect(st.pendingRefs[0]).toMatchObject({
      kind: "debugValue",
      name: "payload",
      value: "{ ok: false }",
      type: "Payload",
    });
  });
});
