import type { GitBranch, GitFileEntry, GitOperationState } from "@/lib/ipc";

export type CommitFileSummary = {
  path: string;
  status: GitFileEntry["status"];
  summary: string;
};

export function changedFilesForCommit(
  entries: GitFileEntry[],
): GitFileEntry[] {
  const staged = entries.filter((entry) => entry.staged);
  if (staged.length > 0) return staged;
  return entries.filter(
    (entry) => entry.unstaged && entry.status !== "untracked",
  );
}

export function buildFileSummaryPrompt(path: string, diff: string): string {
  return [
    `Summarize this git diff for ${path}.`,
    "Return one concise bullet in plain English.",
    "Mention the user-visible behavior or technical intent, not line counts.",
    "",
    diff.trim().slice(0, 12000),
  ].join("\n");
}

export function buildCommitMessagePrompt(summaries: CommitFileSummary[]): string {
  const body = summaries
    .map((item) => `- ${item.path} (${item.status}): ${item.summary}`)
    .join("\n");
  return [
    "Write a polished git commit message for these file-level change summaries.",
    "Return only the commit message.",
    "Use an imperative subject line under 72 characters.",
    "Add a blank line and 1-3 bullets only if the changes need explanation.",
    "",
    body,
  ].join("\n");
}

export function normalizeGeneratedCommitMessage(
  text: string,
  summaries: CommitFileSummary[],
): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, ""),
    )
    .split(/\r?\n/)
    .map((line) => line.replace(/^["'`]|["'`]$/g, "").trimEnd())
    .join("\n")
    .trim();

  if (cleaned) return cleaned;
  const fallbackSubject = summaries.length === 1
    ? `Update ${summaries[0].path}`
    : `Update ${summaries.length} files`;
  const bullets = summaries
    .slice(0, 3)
    .map((item) => `- ${item.summary.replace(/^[-*]\s*/, "").trim()}`)
    .filter((line) => line.length > 2);
  return [fallbackSubject, bullets.length ? `\n${bullets.join("\n")}` : ""]
    .join("")
    .trim();
}

export function groupBranches(branches: GitBranch[]): {
  local: GitBranch[];
  remote: GitBranch[];
} {
  return {
    local: branches.filter((branch) => !branch.remote),
    remote: branches.filter((branch) => branch.remote),
  };
}

export function operationActionLabel(operation: GitOperationState): string {
  switch (operation.kind) {
    case "rebase":
      return "Continue rebase";
    case "merge":
      return "Continue merge";
    case "cherry_pick":
      return "Continue cherry-pick";
    case "revert":
      return "Continue revert";
  }
}

export function operationAbortLabel(operation: GitOperationState): string {
  switch (operation.kind) {
    case "rebase":
      return "Abort rebase";
    case "merge":
      return "Abort merge";
    case "cherry_pick":
      return "Abort cherry-pick";
    case "revert":
      return "Abort revert";
  }
}

export function operationProgress(operation: GitOperationState): number | null {
  if (!operation.current || !operation.total || operation.total <= 0) return null;
  return Math.max(0, Math.min(100, (operation.current / operation.total) * 100));
}
