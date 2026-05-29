import { describe, expect, it } from "vitest";
import {
  buildCommitMessagePrompt,
  changedFilesForCommit,
  groupBranches,
  normalizeGeneratedCommitMessage,
  operationProgress,
} from "./gitWorkflow";
import type { GitFileEntry, GitOperationState } from "./ipc";

describe("git workflow helpers", () => {
  it("prefers staged files for commit generation", () => {
    const entries: GitFileEntry[] = [
      { path: "a.ts", status: "modified", staged: false, unstaged: true },
      { path: "b.ts", status: "added", staged: true, unstaged: false },
    ];
    expect(changedFilesForCommit(entries).map((e) => e.path)).toEqual(["b.ts"]);
  });

  it("falls back to tracked unstaged files when nothing is staged", () => {
    const entries: GitFileEntry[] = [
      { path: "a.ts", status: "modified", staged: false, unstaged: true },
      { path: "new.ts", status: "untracked", staged: false, unstaged: true },
    ];
    expect(changedFilesForCommit(entries).map((e) => e.path)).toEqual(["a.ts"]);
  });

  it("builds a consolidation prompt from independent file summaries", () => {
    const prompt = buildCommitMessagePrompt([
      { path: "src/App.tsx", status: "modified", summary: "Updates loading state." },
      { path: "src/git.ts", status: "added", summary: "Adds git operation helpers." },
    ]);
    expect(prompt).toContain("src/App.tsx");
    expect(prompt).toContain("imperative subject line");
  });

  it("normalizes empty model output into a useful fallback", () => {
    const msg = normalizeGeneratedCommitMessage("", [
      { path: "src/App.tsx", status: "modified", summary: "Adds activity banners." },
    ]);
    expect(msg).toContain("Update src/App.tsx");
    expect(msg).toContain("Adds activity banners");
  });

  it("splits local and remote branches", () => {
    const grouped = groupBranches([
      { name: "main", current: true, remote: false, last_commit: "today", upstream: "origin/main" },
      { name: "origin/main", current: false, remote: true, last_commit: "today", upstream: null },
    ]);
    expect(grouped.local).toHaveLength(1);
    expect(grouped.remote).toHaveLength(1);
  });

  it("calculates bounded operation progress", () => {
    const op: GitOperationState = {
      kind: "rebase",
      title: "Rebase 2 of 4",
      head: "feature",
      target: "abc123",
      current: 2,
      total: 4,
      conflicts: [],
    };
    expect(operationProgress(op)).toBe(50);
  });
});
