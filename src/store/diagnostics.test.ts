import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useDiagnostics, type Diagnostic } from "./diagnostics";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    projectCheckRun: vi.fn(),
  },
}));

const baseDiag: Diagnostic = {
  uri: "file:///repo/src/app.ts",
  name: "app.ts",
  startLine: 3,
  startCol: 5,
  endLine: 3,
  endCol: 6,
  severity: "error",
  message: "broken",
  source: "project-check",
  code: "TS1",
};

describe("diagnostics store", () => {
  beforeEach(() => {
    vi.mocked(ipc.projectCheckRun).mockReset();
    useDiagnostics.setState({
      byUri: {},
      monacoByUri: {},
      projectByUri: {},
      errors: 0,
      warnings: 0,
      projectCheck: {
        status: "idle",
        detected: null,
        lastOutput: null,
        error: null,
      },
    });
  });

  it("merges project-check diagnostics into the Problems view", async () => {
    vi.mocked(ipc.projectCheckRun).mockResolvedValue({
      detected: { kind: "node", command: "npm run lint" },
      diagnostics: [baseDiag],
      rawOutput: "src/app.ts(3,5): error TS1: broken",
      exitCode: 1,
      timedOut: false,
    });

    await useDiagnostics.getState().runProjectCheck();

    const state = useDiagnostics.getState();
    expect(state.byUri["file:///repo/src/app.ts"]).toHaveLength(1);
    expect(state.errors).toBe(1);
    expect(state.projectCheck.detected?.command).toBe("npm run lint");
  });

  it("clears project diagnostics without deleting Monaco markers", () => {
    const monacoDiag = { ...baseDiag, source: "ts" };
    useDiagnostics.setState({
      monacoByUri: { [monacoDiag.uri]: [monacoDiag] },
      projectByUri: { [baseDiag.uri]: [baseDiag] },
      byUri: { [baseDiag.uri]: [monacoDiag, baseDiag] },
      errors: 2,
      warnings: 0,
    });

    useDiagnostics.getState().clearProjectDiagnostics();

    const state = useDiagnostics.getState();
    expect(state.projectByUri).toEqual({});
    expect(state.byUri[baseDiag.uri]).toEqual([monacoDiag]);
    expect(state.errors).toBe(1);
  });
});
