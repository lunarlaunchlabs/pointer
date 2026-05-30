import { describe, expect, it } from "vitest";
import {
  buildCommitMessagePrompt,
  buildChangeConsolidationPrompt,
  buildDiffChunkSummaryPrompt,
  buildFileSummaryPrompt,
  buildFileConsolidationPrompt,
  changedFilesForCommit,
  chunkDiffForSummary,
  fallbackSummaryFromDiff,
  groupBranches,
  normalizeChangeSummary,
  normalizeChunkSummary,
  normalizeFileSummary,
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
    ], "Improves the workflow.");
    expect(prompt).not.toContain("src/App.tsx");
    expect(prompt).toContain("imperative subject line");
    expect(prompt).toContain("no more than 3 sentences");
    expect(prompt).toContain("Do not output bullets");
    expect(prompt).toContain("System memory summary");
    expect(prompt).toContain("category-only subject");
  });

  it("asks for tiny per-file behavioral summaries", () => {
    const prompt = buildFileSummaryPrompt("src/App.tsx", "diff --git a/src/App.tsx b/src/App.tsx");
    expect(prompt).toContain("1-2 short sentences");
    expect(prompt).toContain("under 35 words");
    expect(prompt).toContain("Do not repeat the file path");
  });

  it("chunks large diffs on line boundaries and preserves diff headers", () => {
    const diff = [
      "diff --git a/src/App.tsx b/src/App.tsx",
      "index 111..222 100644",
      "--- a/src/App.tsx",
      "+++ b/src/App.tsx",
      "@@ -1,3 +1,90 @@",
      ...Array.from({ length: 46 }, (_, i) => `+const value${i} = ${i};`),
      "@@ -100,3 +100,90 @@",
      ...Array.from({ length: 46 }, (_, i) => `+const next${i} = ${i};`),
    ].join("\n");
    const chunks = chunkDiffForSummary("src/App.tsx", diff, 30, 3000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.includes("diff --git"))).toBe(true);
    expect(chunks.map((chunk) => chunk.index)).toEqual([1, 2, 3, 4]);
    expect(chunks[0].endLine).toBeLessThan(chunks[1].startLine);
  });

  it("builds bounded chunk and file consolidation prompts", () => {
    const [chunk] = chunkDiffForSummary(
      "src/App.tsx",
      "diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n+show status",
    );
    const chunkPrompt = buildDiffChunkSummaryPrompt(chunk);
    expect(chunkPrompt).toContain("chunk 1 of 1");
    expect(chunkPrompt).toContain("under 24 words");

    const filePrompt = buildFileConsolidationPrompt("src/App.tsx", [
      { index: 1, lineRange: "1-10", summary: "Adds visible status feedback." },
      { index: 2, lineRange: "11-20", summary: "Keeps the commit composer locked while generating." },
    ]);
    expect(filePrompt).toContain("1-2 short sentences");
    expect(filePrompt).not.toContain("lines 1-10");

    const changePrompt = buildChangeConsolidationPrompt([
      { path: "src/App.tsx", status: "modified", summary: "Adds visible status feedback." },
    ]);
    expect(changePrompt).toContain("user-visible change summary");
    expect(changePrompt).not.toContain("src/App.tsx");
  });

  it("normalizes file summaries to two short sentences without paths", () => {
    const summary = normalizeFileSummary(
      "- src/App.tsx: Updates the git panel so output controls remain visible. Adds tests for long push logs. Extra sentence.",
      "src/App.tsx",
      "modified",
    );
    expect(summary).not.toContain("src/App.tsx");
    expect(summary).toContain("output controls remain visible");
    expect(summary.split(".").filter(Boolean).length).toBeLessThanOrEqual(2);
  });

  it("rejects path-only file summaries after path stripping", () => {
    const summary = normalizeFileSummary(
      "Updates src/lib/harnessCore.",
      "src/lib/harnessCore.ts",
      "added",
      "Adds AgentOrchestrator and PermissionEngine.",
    );
    expect(summary).toBe("Adds agent orchestrator and permission engine.");
  });

  it("repairs grammar when path stripping removes a document subject", () => {
    const summary = normalizeFileSummary(
      "The README is updated to describe the SportsMove investor deck as a Vite-powered slide presentation.",
      "README.md",
      "modified",
      "Updates sports move investor deck.",
    );
    expect(summary).toBe(
      "Updates the SportsMove investor deck as a Vite-powered slide presentation.",
    );
  });

  it("rejects file summaries that leak unrelated paths", () => {
    const summary = normalizeFileSummary(
      "Updates src/lib/harnessCore.",
      "src/components/Git/SourceControlPanel.tsx",
      "modified",
      "Updates source control panel.",
    );
    expect(summary).toBe("Updates source control panel.");
  });

  it("replaces generic model file summaries with diff-derived intent", () => {
    const diff = [
      "diff --git a/src/components/Git/SourceControlPanel.tsx b/src/components/Git/SourceControlPanel.tsx",
      "+function GitOutputPane() {",
      "+  return <button aria-label=\"Dismiss git output\" />;",
    ].join("\n");
    const fallback = fallbackSummaryFromDiff(
      "src/components/Git/SourceControlPanel.tsx",
      "modified",
      diff,
    );
    expect(fallback.toLowerCase()).toContain("dismiss git output");
    expect(
      normalizeFileSummary(
        "Updates related behavior.",
        "src/components/Git/SourceControlPanel.tsx",
        "modified",
        fallback,
      ),
    ).toBe(fallback);
  });

  it("uses structural diff signals without repo-specific branches", () => {
    expect(
      fallbackSummaryFromDiff(
        "src/lib/workflow.ts",
        "modified",
        "+export function chunkDiffForSummary() {}",
      ),
    ).toBe("Updates diff summary.");
    expect(
      fallbackSummaryFromDiff(
        "src/lib/runtime.ts",
        "added",
        "+export class AgentOrchestrator {}",
      ),
    ).toBe("Adds agent orchestrator.");
    expect(
      fallbackSummaryFromDiff(
        "src/lib/CommitHarness.ts",
        "added",
        "+export const allowedTools = [];",
      ),
    ).toBe("Adds commit harness.");
    expect(
      fallbackSummaryFromDiff(
        "assets/theme.css",
        "modified",
        "+.loading-indicator-orbit { animation: spin; }",
      ),
    ).toBe("Updates loading indicator orbit.");
  });

  it("extracts concise prose intent from documentation diffs", () => {
    expect(
      fallbackSummaryFromDiff(
        "README.md",
        "modified",
        [
          "+SportsMove investor deck",
          "+",
          "+This deck presents the SportsMove thesis, founders, market structure, and appendix material.",
        ].join("\n"),
      ),
    ).toBe("Updates sports move investor deck.");
  });

  it("does not treat CSS utility class strings as feature summaries", () => {
    const summary = fallbackSummaryFromDiff(
      "src/components/Git/SourceControlPanel.tsx",
      "modified",
      [
        '+className="flex items-start justify-between gap-2"',
        '+className="text-[10px] uppercase tracking-wider text-noir-mute"',
      ].join("\n"),
    );
    expect(summary).not.toContain("flex items-start");
    expect(summary).not.toContain("text-[10px]");
    expect(summary).toBe("Updates git source control panel.");
  });

  it("normalizes overlong chunk and change summaries into bounded memory", () => {
    const chunk = normalizeChunkSummary(
      "Adds visible commit generation feedback. It also talks too much about implementation details. Extra sentence.",
      "src/components/Git/SourceControlPanel.tsx",
      "modified",
    );
    expect(chunk.split(/[.!?]+/).filter(Boolean)).toHaveLength(1);

    const summary = normalizeChangeSummary(
      "src/components/Git/SourceControlPanel.tsx changed. Updates gitCommandOutputs and setCommandOutput in fixtures pointer app.",
      [
        {
          path: "src/components/Git/SourceControlPanel.tsx",
          status: "modified",
          summary: "Locks the commit composer while generating and shows commit intelligence.",
        },
        {
          path: "src/lib/gitWorkflow.ts",
          status: "modified",
          summary: "Chunks diffs into bounded summaries before drafting commit messages.",
        },
      ],
    );
    expect(summary).not.toContain("gitCommandOutputs");
    expect(summary).not.toContain("gitCommandOutputs");
    expect(summary).toContain("commit composer");
  });

  it("rejects consolidated summaries that leak fixture strings and path fragments", () => {
    const summary = normalizeChangeSummary(
      "Updates remote line ${i + 1}. Updates Adds visual git workflow support.. Updates src/lib/harnessCore.",
      [
        {
          path: "e2e/fixtures/pointerApp.ts",
          status: "modified",
          summary: "Updates remote line ${i + 1}.",
        },
        {
          path: "src/lib/harnessCore.ts",
          status: "added",
          summary: "Adds state-machine AgentOrchestrator, PermissionEngine, Critic, transcript grading, and regression runner safeguards.",
        },
        {
          path: "src/lib/gitWorkflow.ts",
          status: "modified",
          summary: "Chunks staged diffs into bounded commit memory before drafting commit messages.",
        },
        {
          path: "src/components/Git/SourceControlPanel.tsx",
          status: "modified",
          summary: "Locks the commit composer while generating and shows commit intelligence with a robot status indicator.",
        },
      ],
    );
    expect(summary).not.toContain("remote line");
    expect(summary).not.toContain("${");
    expect(summary).not.toContain("src/lib/harnessCore");
    expect(summary).toContain("commit");
    expect(summary).toContain("staged diffs");
  });

  it("normalizes empty model output into a useful fallback", () => {
    const msg = normalizeGeneratedCommitMessage("", [
      {
        path: "src/App.tsx",
        status: "modified",
        summary: "Adds activity banners.",
        fallback: "Adds activity banners.",
      },
    ]);
    expect(msg).toBe("feat: add activity banners");
  });

  it("does not accept repeated related-behavior commit filler", () => {
    const msg = normalizeGeneratedCommitMessage(
      "Update related behavior\n\nUpdates related behavior. Updates related behavior.",
      [
        {
          path: "src/components/Git/SourceControlPanel.tsx",
          status: "modified",
          summary: "Updates related behavior.",
          fallback: "Updates remote sync feedback in source control panel.",
        },
      ],
    );
    expect(msg).not.toContain("related behavior");
    expect(msg).toContain("remote sync feedback");
  });

  it("rejects implementation-symbol inventory commit messages", () => {
    const msg = normalizeGeneratedCommitMessage(
      "Update git_push\n\nUpdates git_push. Updates gitCommandOutputs and setCommandOutput in fixtures pointer app.",
      [
        {
          path: "e2e/fixtures/pointerApp.ts",
          status: "modified",
          summary: "Updates gitCommandOutputs and setCommandOutput in fixtures pointer app.",
          fallback: "Updates git_push.",
        },
        {
          path: "src/components/Git/SourceControlPanel.tsx",
          status: "modified",
          summary: "Keeps Git output controls visible while long logs scroll.",
          fallback: "Updates Git output.",
        },
        {
          path: "src/lib/gitWorkflow.ts",
          status: "modified",
          summary: "Consolidates file summaries into concise commit messages.",
          fallback: "Updates commit message workflow.",
        },
      ],
    );
    expect(msg).not.toContain("git_push");
    expect(msg).not.toContain("gitCommandOutputs");
    expect(msg).not.toContain("setCommandOutput");
    expect(msg).not.toContain("fixtures pointer app");
    expect(msg).toContain("file summaries");
  });

  it("rejects theme-only commit messages for the current harness work", () => {
    const msg = normalizeGeneratedCommitMessage(
      "Improve commit message generation and source control workflow",
      [
        {
          path: "src/lib/harnessCore.ts",
          status: "added",
          summary: "Adds state-machine AgentOrchestrator, PermissionEngine, Critic, transcript grading, and regression runner safeguards.",
          fallback: "Adds agent harness safeguards.",
        },
        {
          path: "src/lib/gitWorkflow.ts",
          status: "modified",
          summary: "Chunks staged diffs into bounded commit memory before drafting commit messages.",
          fallback: "Updates commit message workflow.",
        },
        {
          path: "src/components/Git/SourceControlPanel.tsx",
          status: "modified",
          summary: "Locks the commit composer while generating and shows commit intelligence with a robot status indicator.",
          fallback: "Updates source control panel.",
        },
      ],
    );
    expect(msg).toContain("agent harness safeguards");
    expect(msg).toContain("staged diffs");
  });

  it("does not duplicate fix wording in synthesized conventional subjects", () => {
    const msg = normalizeGeneratedCommitMessage(
      "Improve commit message generation and source control workflow",
      [
        {
          path: "src/lib/gitWorkflow.ts",
          status: "modified",
          summary: "Fixes commit file summary validation and chunked commit memory.",
          fallback: "Fixes commit file summary validation.",
        },
        {
          path: "scripts/quality/gitCommitPipelineProbe.mjs",
          status: "added",
          summary: "Adds commit pipeline probe coverage.",
          fallback: "Adds commit pipeline probe coverage.",
        },
      ],
    );
    expect(msg).toMatch(/^fix: correct /);
    expect(msg).not.toMatch(/^fix: fix\b/);
  });

  it("filters file-path filler from synthesized commit bodies", () => {
    const msg = normalizeGeneratedCommitMessage(
      "Improve commit message generation and source control workflow",
      [
        {
          path: "scripts/quality/gitCommitPipelineProbe.mjs",
          status: "added",
          summary: "Adds file path.",
          fallback: "Adds commit pipeline probe coverage.",
        },
        {
          path: "src/lib/gitWorkflow.ts",
          status: "modified",
          summary: "Fixes commit file summary validation and chunked commit memory.",
          fallback: "Fixes commit file summary validation.",
        },
        {
          path: "src/components/Git/SourceControlPanel.tsx",
          status: "modified",
          summary: "Shows commit draft feedback while generating.",
          fallback: "Shows commit draft feedback.",
        },
      ],
    );
    expect(msg).not.toContain("file path");
    expect(msg).toContain("commit draft feedback");
    expect(msg).toContain("commit file summary");
  });

  it("filters internal implementation concepts from staged commit drafts", () => {
    const msg = normalizeGeneratedCommitMessage(
      [
        "fix: correct git commit pipeline probe and writes approved memory",
        "",
        "Includes commit agent orbit, commit draft, and num predict.",
      ].join("\n"),
      [
        {
          path: "scripts/quality/gitCommitPipelineProbe.mjs",
          status: "added",
          summary: "Adds num predict.",
          fallback: "Adds git commit pipeline probe.",
        },
        {
          path: "src/commit/CommitHarness.ts",
          status: "added",
          summary: "Adds writes approved memory.",
          fallback: "Adds commit harness with judge councils and memory lanes.",
        },
        {
          path: "src/core/HarnessMemory.ts",
          status: "added",
          summary: "Adds action mode.",
          fallback: "Adds memory graph, archetypes, and judge councils.",
        },
        {
          path: "src/components/CommitPanel.tsx",
          status: "modified",
          summary: "Updates raw draft.",
          fallback: "Updates commit draft feedback.",
        },
        {
          path: "src/styles/theme.css",
          status: "modified",
          summary: "Updates border radius.",
          fallback: "Updates border radius.",
        },
      ],
    );
    expect(msg).toContain("commit harness");
    expect(msg).not.toContain("writes approved memory");
    expect(msg).not.toContain("num predict");
    expect(msg).not.toContain("action mode");
    expect(msg).not.toContain("commit agent orbit");
    expect(msg).not.toContain("border radius");
    expect(msg).not.toContain("normalized file summary");
    expect(msg).not.toContain("memory ids");
    expect(msg).not.toContain("raw draft");
  });

  it("prioritizes the primary commit harness over support tooling noise", () => {
    const msg = normalizeGeneratedCommitMessage(
      [
        "fix: correct git commit pipeline probe and writes approved memory",
        "",
        "Includes commit agent orbit, commit draft, and num predict.",
      ].join("\n"),
      [
        {
          path: "scripts/quality/gitCommitPipelineProbe.mjs",
          status: "added",
          summary: "Adds num predict.",
          fallback: "Adds git commit pipeline probe.",
        },
        {
          path: "src/commit/CommitHarness.ts",
          status: "added",
          summary: "Adds commit harness.",
          fallback: "Adds commit harness.",
        },
        {
          path: "src/core/HarnessMemory.ts",
          status: "added",
          summary: "Adds memory graph and judge councils.",
          fallback: "Adds memory graph and judge councils.",
        },
        {
          path: "src/commit/CommitSummary.ts",
          status: "modified",
          summary: "Updates commit file summary validation.",
          fallback: "Updates commit file summary validation.",
        },
      ],
    );
    expect(msg).toMatch(/^feat: add /);
    expect(msg).toContain("commit harness");
    expect(msg).toContain("memory graph");
    expect(msg).not.toContain("git commit pipeline probe");
    expect(msg).not.toContain("num predict");
  });

  it("rejects file-inventory commit messages and synthesizes intent", () => {
    const msg = normalizeGeneratedCommitMessage(
      "- src/App.tsx: changed\n- src/lib/gitWorkflow.ts: changed",
      [
        {
          path: "src/App.tsx",
          status: "modified",
          summary: "Improves remote sync feedback.",
        },
        {
          path: "src/lib/gitWorkflow.ts",
          status: "modified",
          summary: "Consolidates file summaries into a concise commit message.",
        },
      ],
    );
    expect(msg).not.toContain("src/App.tsx");
    expect(msg).not.toContain("src/lib/gitWorkflow.ts");
    expect(msg).toContain("file summaries");
    expect(msg.split(/[.!?]+/).filter(Boolean).length).toBeLessThanOrEqual(3);
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
