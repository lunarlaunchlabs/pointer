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
});
