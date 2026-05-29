import {
  HarnessBlueprint,
  LayeredHarness,
  MemoryGraph,
  type CouncilItem,
  type HarnessLayerSpec,
  type HarnessMemory,
} from "./harnessCore";
import type { GitFileEntry } from "./ipc";

export type CommitScoutTarget = {
  kind: "file" | "folder";
  path: string;
  reason: string;
};

export type CommitFileCandidate = {
  path: string;
  status: GitFileEntry["status"];
  reason: string;
};

export type CommitChunkMemory = {
  path: string;
  chunkIndex: number;
  totalChunks: number;
  lineRange: string;
  summary: string;
};

export type CommitDiffChunkMemory = {
  path: string;
  chunkIndex: number;
  totalChunks: number;
  lineRange: string;
  text: string;
};

export type CommitFileSummaryMemory = {
  path: string;
  status: GitFileEntry["status"];
  summary: string;
};

export type CommitDraftMemory = {
  message: string;
  raw?: string;
};

export type CommitDecisionMemory = {
  verdict: "sufficient" | "needs_more_context" | "mixed_changes" | "ready";
  reason: string;
};

export type CommitHarnessSeed = {
  prompt: string;
  workspaceRoot: string;
  openDirectoryEntries: Array<{ path: string; kind: "file" | "folder" }>;
};

const READ_ONLY_COMMIT_TOOLS = ["git_status", "git_diff", "read_file"] as const;

export function createGitCommitHarnessBlueprint(): HarnessBlueprint {
  const layers: HarnessLayerSpec[] = [
    {
      id: "seed",
      name: "Seed prompt and visible workspace structure",
      archetype: "cartographer",
      actionMode: "none",
      inputKinds: [],
      outputKinds: ["prompt", "directory_listing"],
      allowedTools: [],
      judge: { kind: "none" },
      writesApprovedMemory: true,
    },
    {
      id: "scout_targets",
      name: "Scouts propose context targets",
      archetype: "scout",
      actionMode: "propose",
      inputKinds: ["prompt", "directory_listing"],
      outputKinds: ["proposal"],
      allowedTools: [],
      judge: { kind: "stage", judges: 3, requiredYes: 4 },
      writesApprovedMemory: false,
    },
    {
      id: "target_council",
      name: "Judge council approves scout targets",
      archetype: "judge",
      actionMode: "none",
      inputKinds: ["proposal"],
      outputKinds: ["judge_verdict"],
      allowedTools: [],
      judge: { kind: "item", judges: 3, requiredYes: 2 },
      writesApprovedMemory: true,
    },
    {
      id: "deterministic_gather",
      name: "Gather approved git status and diffs",
      archetype: "evidence_collector",
      actionMode: "none",
      inputKinds: ["judge_verdict", "proposal"],
      outputKinds: ["file_metadata", "diff_chunk"],
      allowedTools: [...READ_ONLY_COMMIT_TOOLS],
      judge: { kind: "none" },
      writesApprovedMemory: true,
    },
    {
      id: "troop_leader_files",
      name: "Scout troop leader selects candidate files",
      archetype: "scout_troop_leader",
      actionMode: "propose",
      inputKinds: ["file_metadata", "diff_chunk"],
      outputKinds: ["decision"],
      allowedTools: [],
      judge: { kind: "item", judges: 3, requiredYes: 2 },
      writesApprovedMemory: false,
    },
    {
      id: "collect_file_content",
      name: "Collect approved file content or staged diff chunks",
      archetype: "evidence_collector",
      actionMode: "none",
      inputKinds: ["decision", "judge_verdict"],
      outputKinds: ["file_content", "diff_chunk"],
      allowedTools: [...READ_ONLY_COMMIT_TOOLS],
      judge: { kind: "none" },
      writesApprovedMemory: true,
    },
    {
      id: "chunk_summarizers",
      name: "Summarize bounded chunks",
      archetype: "summarizer",
      actionMode: "none",
      inputKinds: ["diff_chunk", "file_content"],
      outputKinds: ["chunk_summary"],
      allowedTools: [],
      judge: { kind: "stage", judges: 3, requiredYes: 4 },
      writesApprovedMemory: false,
    },
    {
      id: "chunk_summary_council",
      name: "Judge chunk summaries before durable memory",
      archetype: "judge",
      actionMode: "none",
      inputKinds: ["chunk_summary"],
      outputKinds: ["judge_verdict"],
      allowedTools: [],
      judge: { kind: "item", judges: 3, requiredYes: 2 },
      writesApprovedMemory: true,
    },
    {
      id: "file_consolidator",
      name: "Create approved file summaries",
      archetype: "consolidator",
      actionMode: "none",
      inputKinds: ["chunk_summary", "judge_verdict"],
      outputKinds: ["file_summary"],
      allowedTools: [],
      judge: { kind: "stage", judges: 3, requiredYes: 4 },
      writesApprovedMemory: false,
    },
    {
      id: "scout_evaluator",
      name: "Evaluate whether approved memory is sufficient",
      archetype: "evaluator",
      actionMode: "propose",
      inputKinds: ["prompt", "file_summary", "diff_chunk"],
      outputKinds: ["decision"],
      allowedTools: [],
      judge: { kind: "stage", judges: 3, requiredYes: 4 },
      writesApprovedMemory: false,
    },
    {
      id: "split_proposer",
      name: "Propose commit splits for mixed changes",
      archetype: "splitter",
      actionMode: "propose",
      inputKinds: ["file_summary", "decision"],
      outputKinds: ["action_plan"],
      allowedTools: [],
      judge: { kind: "stage", judges: 3, requiredYes: 4 },
      writesApprovedMemory: false,
    },
    {
      id: "message_drafter",
      name: "Draft commit message from approved memory",
      archetype: "drafter",
      actionMode: "none",
      inputKinds: ["file_summary", "decision", "action_plan"],
      outputKinds: ["draft"],
      allowedTools: [],
      judge: { kind: "stage", judges: 3, requiredYes: 4 },
      writesApprovedMemory: false,
    },
    {
      id: "message_normalizer",
      name: "Normalize draft without adding facts",
      archetype: "normalizer",
      actionMode: "none",
      inputKinds: ["draft", "file_summary"],
      outputKinds: ["draft"],
      allowedTools: [],
      judge: { kind: "none" },
      writesApprovedMemory: true,
    },
    {
      id: "message_red_team",
      name: "Red-team the normalized draft",
      archetype: "red_team",
      actionMode: "none",
      inputKinds: ["draft", "file_summary", "diff_chunk"],
      outputKinds: ["decision", "judge_verdict"],
      allowedTools: [],
      judge: { kind: "none" },
      writesApprovedMemory: true,
    },
    {
      id: "final_message_council",
      name: "Judge final commit message",
      archetype: "judge",
      actionMode: "none",
      inputKinds: ["draft", "file_summary", "diff_chunk", "decision"],
      outputKinds: ["judge_verdict", "final"],
      allowedTools: [],
      judge: { kind: "stage", judges: 3, requiredYes: 4 },
      writesApprovedMemory: true,
    },
  ];
  return new HarnessBlueprint("git_commit_message", "commit_message", layers);
}

export class GitCommitHarness extends LayeredHarness {
  constructor(memory = new MemoryGraph("commit-main", "Commit message")) {
    super(createGitCommitHarnessBlueprint(), memory);
  }

  seed(input: CommitHarnessSeed): HarnessMemory<CommitHarnessSeed> {
    return this.remember({
      laneId: "commit-main",
      stage: "seed",
      kind: "prompt",
      archetype: "cartographer",
      content: input,
      summary: input.prompt,
      tags: ["commit", "seed"],
      status: "approved",
    });
  }

  rememberScoutTargets(
    targets: CommitScoutTarget[],
    parentIds: string[],
  ): Array<HarnessMemory<CommitScoutTarget>> {
    return targets.map((target) =>
      this.remember({
        laneId: "commit-main",
        stage: "scout_targets",
        kind: "proposal",
        archetype: "scout",
        content: target,
        summary: `${target.kind} ${target.path}: ${target.reason}`,
        tags: ["commit", "scout-target", target.kind],
        parentIds,
      }),
    );
  }

  promoteApprovedFiles(
    candidates: CommitFileCandidate[],
    approved: Array<CouncilItem<CommitFileCandidate>>,
    parentIds: string[],
  ): Array<HarnessMemory<CommitFileCandidate>> {
    const approvedPaths = new Set(approved.map((item) => item.value.path));
    return candidates
      .filter((candidate) => approvedPaths.has(candidate.path))
      .map((candidate) =>
        this.remember({
          laneId: "commit-main",
          stage: "troop_leader_files",
          kind: "decision",
          archetype: "scout_troop_leader",
          content: candidate,
          summary: `${candidate.path}: ${candidate.reason}`,
          tags: ["commit", "approved-file"],
          parentIds,
          status: "approved",
        }),
      );
  }

  rememberChunkSummary(
    chunk: CommitChunkMemory,
    parentIds: string[],
    approved: boolean,
  ): HarnessMemory<CommitChunkMemory> {
    return this.remember({
      laneId: "commit-main",
      stage: "chunk_summarizers",
      kind: "chunk_summary",
      archetype: "summarizer",
      content: chunk,
      summary: chunk.summary,
      tags: ["commit", "chunk-summary", chunk.path],
      parentIds,
      status: approved ? "approved" : "pending",
    });
  }

  rememberDiffChunk(
    chunk: CommitDiffChunkMemory,
    parentIds: string[],
  ): HarnessMemory<CommitDiffChunkMemory> {
    return this.remember({
      laneId: "commit-main",
      stage: "deterministic_gather",
      kind: "diff_chunk",
      archetype: "evidence_collector",
      content: chunk,
      summary: `${chunk.path} chunk ${chunk.chunkIndex}/${chunk.totalChunks} lines ${chunk.lineRange}`,
      tags: ["commit", "diff-chunk", chunk.path],
      parentIds,
      status: "approved",
    });
  }

  rememberFileSummary(
    summary: CommitFileSummaryMemory,
    parentIds: string[],
    approved: boolean,
  ): HarnessMemory<CommitFileSummaryMemory> {
    return this.remember({
      laneId: "commit-main",
      stage: "file_consolidator",
      kind: "file_summary",
      archetype: "consolidator",
      content: summary,
      summary: `${summary.path}: ${summary.summary}`,
      tags: ["commit", "file-summary", summary.path],
      parentIds,
      status: approved ? "approved" : "pending",
    });
  }

  rememberDecision(
    stage: string,
    decision: CommitDecisionMemory,
    parentIds: string[],
    approved: boolean,
  ): HarnessMemory<CommitDecisionMemory> {
    return this.remember({
      laneId: "commit-main",
      stage,
      kind: "decision",
      archetype: stage === "message_red_team" ? "red_team" : "evaluator",
      content: decision,
      summary: `${decision.verdict}: ${decision.reason}`,
      tags: ["commit", "decision", decision.verdict],
      parentIds,
      status: approved ? "approved" : "pending",
    });
  }

  rememberDraft(
    stage: string,
    draft: CommitDraftMemory,
    parentIds: string[],
    approved: boolean,
  ): HarnessMemory<CommitDraftMemory> {
    return this.remember({
      laneId: "commit-main",
      stage,
      kind: stage === "final_message_council" ? "final" : "draft",
      archetype: stage === "message_normalizer" ? "normalizer" : "drafter",
      content: draft,
      summary: draft.message.split(/\r?\n/)[0] ?? draft.message,
      tags: ["commit", "draft"],
      parentIds,
      status: approved ? "approved" : "pending",
    });
  }

  rememberFinal(
    draft: CommitDraftMemory,
    parentIds: string[],
    approved: boolean,
  ): HarnessMemory<CommitDraftMemory> {
    return this.remember({
      laneId: "commit-main",
      stage: "final_message_council",
      kind: "final",
      archetype: "judge",
      content: draft,
      summary: draft.message.split(/\r?\n/)[0] ?? draft.message,
      tags: ["commit", "final"],
      parentIds,
      status: approved ? "approved" : "pending",
    });
  }

  approveMemories(ids: string[]): HarnessMemory[] {
    return ids.map((id) => this.memory.setStatus(id, "approved"));
  }

  supersedeMemory(id: string): HarnessMemory {
    return this.memory.setStatus(id, "superseded");
  }
}

export function gitCommitHarnessAllowsActions(blueprint = createGitCommitHarnessBlueprint()): boolean {
  return blueprint.actionTakerLayers().length > 0;
}
