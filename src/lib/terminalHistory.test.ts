import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetTerminalHistoryForTests,
  recordTerminalCommand,
  suggestTerminalCommand,
  terminalHistorySnapshot,
  type TerminalHistoryEntry,
} from "./terminalHistory";

const DAY = 86_400_000;

describe("terminalHistory", () => {
  beforeEach(() => {
    __resetTerminalHistoryForTests();
  });

  it("suggests a command tail from matching deterministic history", () => {
    recordTerminalCommand("git status --short", "/repo", 1_000);

    const suggestion = suggestTerminalCommand("git st", "/repo", 1_500);

    expect(suggestion?.command).toBe("git status --short");
    expect(suggestion?.suffix).toBe("atus --short");
  });

  it("weights frequency and current working directory without using AI", () => {
    recordTerminalCommand("npm run build", "/repo-a", 1_000);
    recordTerminalCommand("npm run test", "/repo-b", 2_000);
    recordTerminalCommand("npm run test", "/repo-b", 3_000);
    recordTerminalCommand("npm run test", "/repo-b", 4_000);

    expect(suggestTerminalCommand("npm run", "/repo-b", 5_000)?.command).toBe("npm run test");
    expect(suggestTerminalCommand("npm run b", "/repo-a", 5_000)?.command).toBe("npm run build");
  });

  it("lets very recent commands beat old low-signal matches", () => {
    const old: TerminalHistoryEntry = {
      command: "cargo test",
      uses: 1,
      firstUsed: 1_000,
      lastUsed: 1_000,
      cwdHits: [{ cwd: "/repo", uses: 1, lastUsed: 1_000 }],
    };
    const recent: TerminalHistoryEntry = {
      command: "cargo check",
      uses: 1,
      firstUsed: 30 * DAY,
      lastUsed: 30 * DAY,
      cwdHits: [{ cwd: "/repo", uses: 1, lastUsed: 30 * DAY }],
    };
    __resetTerminalHistoryForTests([old, recent]);

    expect(suggestTerminalCommand("cargo", "/repo", 30 * DAY)?.command).toBe("cargo check");
  });

  it("does not persist obvious secret-bearing commands", () => {
    recordTerminalCommand("export API_TOKEN=abc123", "/repo", 1_000);
    recordTerminalCommand("curl --password hunter2 https://example.test", "/repo", 1_000);
    recordTerminalCommand("npm run lint", "/repo", 1_000);

    expect(terminalHistorySnapshot().map((entry) => entry.command)).toEqual(["npm run lint"]);
  });

  it("keeps the in-memory history bounded", () => {
    for (let i = 0; i < 460; i += 1) {
      recordTerminalCommand(`echo command-${i}`, "/repo", i + 1);
    }

    expect(terminalHistorySnapshot()).toHaveLength(400);
    expect(terminalHistorySnapshot()[0].command).toBe("echo command-459");
  });
});
