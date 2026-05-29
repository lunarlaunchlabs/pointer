import { describe, expect, it } from "vitest";
import { JudgeCouncil } from "./harnessCore";
import {
  GitCommitHarness,
  createGitCommitHarnessBlueprint,
  gitCommitHarnessAllowsActions,
  type CommitFileCandidate,
} from "./gitCommitHarness";

describe("git commit specialized harness", () => {
  it("is read-only and judge-gated without action takers", () => {
    const blueprint = createGitCommitHarnessBlueprint();
    expect(blueprint.validate()).toEqual([]);
    expect(gitCommitHarnessAllowsActions(blueprint)).toBe(false);
    expect(blueprint.layers.some((layer) => layer.archetype === "scout")).toBe(true);
    expect(blueprint.layers.some((layer) => layer.archetype === "scout_troop_leader")).toBe(true);
    expect(blueprint.layers.some((layer) => layer.archetype === "summarizer")).toBe(true);
    expect(blueprint.layers.some((layer) => layer.archetype === "drafter")).toBe(true);
    expect(
      blueprint.layers
        .filter((layer) => layer.actionMode === "propose")
        .every((layer) => layer.judge.kind !== "none"),
    ).toBe(true);
  });

  it("promotes only file candidates approved by a per-file judge council", async () => {
    const harness = new GitCommitHarness();
    const seed = harness.seed({
      prompt: "Draft a commit message for staged changes.",
      workspaceRoot: "/repo",
      openDirectoryEntries: [
        { path: "src", kind: "folder" },
        { path: "README.md", kind: "file" },
      ],
    });
    const proposals = harness.rememberScoutTargets(
      [
        { kind: "folder", path: "src", reason: "Likely source changes." },
        { kind: "file", path: "README.md", reason: "May document behavior." },
      ],
      [seed.id],
    );
    const candidates: CommitFileCandidate[] = [
      {
        path: "src/lib/gitWorkflow.ts",
        status: "modified",
        reason: "Contains commit message generation logic.",
      },
      {
        path: "README.md",
        status: "modified",
        reason: "Only broad documentation context.",
      },
    ];
    const council = await new JudgeCouncil().evaluateItems(
      candidates.map((candidate) => ({
        id: candidate.path,
        label: candidate.path,
        value: candidate,
      })),
      (item) => `Approve collecting this file for the commit goal?\n${item.value.reason}`,
      async (_prompt, judgeIndex, item) => {
        if (item.value.path.includes("gitWorkflow")) return judgeIndex < 2 ? "Y" : "N";
        return "N";
      },
    );

    const promoted = harness.promoteApprovedFiles(
      candidates,
      council.approved.map((item) => item.item),
      proposals.map((proposal) => proposal.id),
    );

    expect(promoted).toHaveLength(1);
    expect(promoted[0].content.path).toBe("src/lib/gitWorkflow.ts");
    expect(
      harness.memory.materializeContext({
        kinds: ["decision"],
        tags: ["approved-file"],
        approvedOnly: true,
      }),
    ).toHaveLength(1);
  });

  it("keeps chunk summaries in durable memory only after approval", () => {
    const harness = new GitCommitHarness();
    const pending = harness.rememberChunkSummary(
      {
        path: "src/lib/gitWorkflow.ts",
        chunkIndex: 1,
        totalChunks: 2,
        lineRange: "1-120",
        summary: "Describes a weak unapproved chunk.",
      },
      [],
      false,
    );
    const approved = harness.rememberChunkSummary(
      {
        path: "src/lib/gitWorkflow.ts",
        chunkIndex: 2,
        totalChunks: 2,
        lineRange: "121-240",
        summary: "Rejects low-value commit-message filler.",
      },
      [pending.id],
      true,
    );

    expect(
      harness.memory.materializeContext({
        kinds: ["chunk_summary"],
        approvedOnly: true,
      }).map((item) => item.id),
    ).toEqual([approved.id]);
  });

  it("promotes and supersedes memories as later layers validate them", () => {
    const harness = new GitCommitHarness();
    const seed = harness.seed({
      prompt: "Draft a commit message.",
      workspaceRoot: "/repo",
      openDirectoryEntries: [],
    });
    const [target] = harness.rememberScoutTargets(
      [{ kind: "file", path: "src/commit/CommitHarness.ts", reason: "Primary change." }],
      [seed.id],
    );
    expect(target.status).toBe("pending");
    expect(harness.approveMemories([target.id])[0].status).toBe("approved");

    const raw = harness.rememberDraft(
      "message_drafter",
      { message: "Improve things." },
      [target.id],
      false,
    );
    expect(raw.status).toBe("pending");
    expect(harness.supersedeMemory(raw.id).status).toBe("superseded");
  });

  it("records diff chunks, file summaries, decisions, and drafts with lineage", () => {
    const harness = new GitCommitHarness();
    const seed = harness.seed({
      prompt: "Draft a commit message.",
      workspaceRoot: "/repo",
      openDirectoryEntries: [],
    });
    const diff = harness.rememberDiffChunk(
      {
        path: "src/commit/CommitHarness.ts",
        chunkIndex: 1,
        totalChunks: 1,
        lineRange: "1-80",
        text: "+export class CommitHarness {}",
      },
      [seed.id],
    );
    const chunk = harness.rememberChunkSummary(
      {
        path: "src/commit/CommitHarness.ts",
        chunkIndex: 1,
        totalChunks: 1,
        lineRange: "1-80",
        summary: "Adds commit harness orchestration.",
      },
      [diff.id],
      true,
    );
    const file = harness.rememberFileSummary(
      {
        path: "src/commit/CommitHarness.ts",
        status: "added",
        summary: "Adds commit harness orchestration.",
      },
      [chunk.id],
      true,
    );
    const decision = harness.rememberDecision(
      "scout_evaluator",
      { verdict: "sufficient", reason: "Approved file summaries cover the staged diff." },
      [file.id],
      true,
    );
    const draft = harness.rememberDraft(
      "message_normalizer",
      { message: "feat: add commit harness orchestration" },
      [decision.id],
      true,
    );
    const final = harness.rememberFinal(
      { message: "feat: add commit harness orchestration" },
      [draft.id],
      true,
    );

    expect(harness.memory.lineage(final.id).map((item) => item.id)).toEqual([
      seed.id,
      diff.id,
      chunk.id,
      file.id,
      decision.id,
      draft.id,
      final.id,
    ]);
    expect(harness.memory.snapshot().memories).toHaveLength(7);
  });
});
