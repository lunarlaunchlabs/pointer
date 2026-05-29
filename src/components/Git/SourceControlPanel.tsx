import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Bot,
  Check,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  FileText,
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  Loader2,
  Minus,
  Plus,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useGit, gitStatusColor, gitStatusLetter } from "@/store/git";
import { useWorkspace } from "@/store/workspace";
import { useEditorStore } from "@/store/editor";
import { useDiffViewer } from "@/store/diffViewer";
import {
  ipc,
  listenEvent,
  newRequestId,
  type ChatToken,
  type GitBranch as GitBranchT,
  type GitFileEntry,
  type GitOperationState,
} from "@/lib/ipc";
import { languageFromPath } from "@/lib/lang";
import {
  buildCommitMessagePrompt,
  buildChangeConsolidationPrompt,
  buildDiffChunkSummaryPrompt,
  buildFileConsolidationPrompt,
  changedFilesForCommit,
  chunkDiffForSummary,
  fallbackSummaryFromDiff,
  groupBranches,
  normalizeChangeSummary,
  normalizeChunkSummary,
  normalizeFileSummary,
  normalizeGeneratedCommitMessage,
  operationAbortLabel,
  operationActionLabel,
  operationProgress,
  type CommitChunkSummary,
  type CommitFileSummary,
  type CommitGenerationMemory,
} from "@/lib/gitWorkflow";
import { GitCommitHarness, type CommitFileCandidate } from "@/lib/gitCommitHarness";
import { isFeatureUsable, useSettings } from "@/store/settings";
import { useModelWorkflows } from "@/store/modelWorkflows";
import { toast } from "@/components/Toast";
import { confirm } from "@/components/Confirm";

const COMMIT_DRAFT_CANCELLED = "__POINTER_COMMIT_DRAFT_CANCELLED__";

/**
 * Source Control panel — Pointer's git workspace.
 *
 * Layout (top-to-bottom):
 *   1. Toolbar: branch picker, refresh, fetch, pull, push, sync
 *   2. Commit composer
 *   3. Staged files (collapsible)
 *   4. Unstaged + untracked files (collapsible)
 *   5. Inline output / errors from the last command
 *
 * Each file row exposes stage / unstage / discard actions on hover.
 * Clicking a row jumps to the file in the editor.
 */
export function SourceControlPanel() {
  const root = useWorkspace((s) => s.root);
  const status = useGit((s) => s.status);
  const refresh = useGit((s) => s.refresh);
  const openFile = useEditorStore((s) => s.openFile);
  const showDiff = useDiffViewer((s) => s.show);
  const chatModel = useSettings((s) => s.chatModel);
  const chatUsable = useSettings((s) => isFeatureUsable("chat", s));
  const activeCommitWorkflow = useModelWorkflows((s) =>
    s.workflows.find((workflow) => workflow.kind === "git_commit"),
  );
  const cancelWorkflow = useModelWorkflows((s) => s.cancelWorkflow);

  /** Read a file from the working tree. Returns "" if the file no
   *  longer exists (deleted entries) so the diff renders as
   *  "everything removed" rather than erroring. */
  const readWorking = async (abs: string): Promise<string> => {
    try {
      return await ipc.readTextFile(abs);
    } catch {
      return "";
    }
  };

  // Open the side-by-side diff for a given file. Staged rows show
  // HEAD ↔ index; unstaged rows show index ↔ working tree (so the
  // diff matches exactly what `git diff` would print). We read both
  // sides eagerly so the editor doesn't flash empty while loading.
  const openDiff = async (entry: GitFileEntry) => {
    if (!root) return;
    const abs = `${root}/${entry.path}`;
    try {
      let original = "";
      let modified = "";
      if (entry.staged && !entry.unstaged) {
        // Staged-only — compare HEAD vs index.
        original = await ipc.gitShowFile(root, entry.path, "head").catch(() => "");
        modified = await ipc.gitShowFile(root, entry.path, "staged").catch(() => "");
      } else if (entry.staged && entry.unstaged) {
        // Both — show working tree on the right but use HEAD on the
        // left so the user sees the full delta they'd be committing.
        original = await ipc.gitShowFile(root, entry.path, "head").catch(() => "");
        modified = await readWorking(abs);
      } else {
        // Unstaged / untracked — compare HEAD vs working tree. For
        // untracked files HEAD doesn't exist; gitShowFile returns "".
        original = await ipc.gitShowFile(root, entry.path, "head").catch(() => "");
        modified = await readWorking(abs);
      }
      showDiff({
        title: `${entry.path}  ·  ${entry.staged && !entry.unstaged ? "HEAD ↔ Staged" : "HEAD ↔ Working tree"}`,
        language: languageFromPath(entry.path),
        original,
        modified,
        readOnly: true,
        path: abs,
        source: "head",
      });
    } catch (e) {
      toast.error("Couldn't open diff", {
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const [commitMessage, setCommitMessage] = useState("");
  const [output, setOutput] = useState<{ kind: "info" | "error"; body: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [commitGenerating, setCommitGenerating] = useState(false);
  const [commitNow, setCommitNow] = useState(Date.now());
  const [commitDraft, setCommitDraft] = useState<CommitGenerationMemory | null>(null);
  const [showStaged, setShowStaged] = useState(true);
  const [showUnstaged, setShowUnstaged] = useState(true);
  const [branches, setBranches] = useState<GitBranchT[] | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const branchRef = useRef<HTMLDivElement | null>(null);

  const staged = useMemo(
    () => status.entries.filter((e) => e.staged),
    [status.entries],
  );
  const unstaged = useMemo(
    () => status.entries.filter((e) => e.unstaged),
    [status.entries],
  );
  const commitElapsedMs = activeCommitWorkflow
    ? Math.max(0, commitNow - activeCommitWorkflow.startedAtMs)
    : 0;

  useEffect(() => {
    if (!commitGenerating && !activeCommitWorkflow) return;
    setCommitNow(Date.now());
    const id = window.setInterval(() => setCommitNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [commitGenerating, activeCommitWorkflow?.id]);

  // Click-outside for branch dropdown.
  useEffect(() => {
    if (!branchOpen) return;
    const onClick = (e: MouseEvent) => {
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) {
        setBranchOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [branchOpen]);

  // Lazy-load branches the first time the picker opens.
  const loadBranches = async () => {
    if (!root) return;
    try {
      const bs = await ipc.gitBranches(root);
      setBranches(bs);
    } catch (e) {
      setBranches([]);
      toast.error("Couldn't list branches", {
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const runCommand = async (
    label: string,
    fn: () => Promise<string>,
    successToast?: string,
  ): Promise<boolean> => {
    if (!root) return false;
    setBusy(true);
    setActiveCommand(label);
    setOutput({ kind: "info", body: `Running ${label}…` });
    try {
      const out = await fn();
      setOutput({ kind: "info", body: out.trim() || `${label} done.` });
      if (successToast) toast.info(successToast);
      return true;
    } catch (e) {
      const body = e instanceof Error ? e.message : String(e);
      setOutput({ kind: "error", body });
      toast.error(`${label} failed`, { body });
      return false;
    } finally {
      await refresh();
      setActiveCommand(null);
      setBusy(false);
    }
  };

  const stage = (paths: string[]) =>
    runCommand("git add", () => ipc.gitStage(root!, paths));
  const unstage = (paths: string[]) =>
    runCommand("git reset", () => ipc.gitUnstage(root!, paths));
  const discard = async (paths: string[]) => {
    const ok = await confirm({
      title: `Discard ${paths.length} file${paths.length === 1 ? "" : "s"}?`,
      body: `This will permanently revert worktree changes and delete untracked files. Make sure you don't need these edits.\n\n${paths.slice(0, 6).join("\n")}${paths.length > 6 ? "\n…" : ""}`,
      confirmLabel: "Discard",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    return runCommand("git discard", () => ipc.gitDiscard(root!, paths));
  };

  const stageAll = () => stage([]);
  const unstageAll = () => unstage([]);
  const commit = async () => {
    if (!root) return;
    if (!commitMessage.trim()) {
      toast.warn("Commit message required");
      return;
    }
    const currentStatus = await ipc.gitStatus(root).catch(() => status);
    const currentStaged = currentStatus.entries.filter((e) => e.staged);
    const currentUnstaged = currentStatus.entries.filter((e) => e.unstaged);
    if (currentStaged.length === 0) {
      // Auto-stage all unstaged tracked changes when nothing is
      // explicitly staged — git's "commit -a" semantics. Skip
      // untracked files (must be explicitly added).
      const trackable = currentUnstaged
        .filter((e) => e.status !== "untracked")
        .map((e) => e.path);
      if (trackable.length === 0) {
        toast.warn("Nothing to commit");
        return;
      }
      const ok = await confirm({
        title: "Stage all and commit?",
        body: `No files are staged. Stage and commit ${trackable.length} tracked change${trackable.length === 1 ? "" : "s"}? (Untracked files are skipped.)`,
        confirmLabel: "Stage & Commit",
      });
      if (!ok) return;
      const stagedOk = await runCommand("git add", () =>
        ipc.gitStage(root, trackable),
      );
      if (!stagedOk) return;
    }
    const committed = await runCommand("git commit", () =>
      ipc.gitCommit(root, commitMessage),
    );
    if (committed) {
      setCommitMessage("");
      setCommitDraft(null);
    }
  };

  const generateCommitMessage = async () => {
    if (!root) return;
    if (!chatUsable || !chatModel) {
      toast.warn("Chat model unavailable", {
        body: "Install or select a chat model before generating a commit message.",
      });
      return;
    }
    const files = changedFilesForCommit(status.entries).slice(0, 10);
    if (files.length === 0) {
      toast.warn("No tracked changes to summarize");
      return;
    }

    setCommitGenerating(true);
    const workflowId = newRequestId("git_commit_run");
    useModelWorkflows.getState().startWorkflow({
      id: workflowId,
      kind: "git_commit",
      title: "Draft commit message",
      currentStep: `Preparing ${files.length} changed file${files.length === 1 ? "" : "s"}`,
      totalSteps: files.length + 3,
    });
    setOutput({
      kind: "info",
      body: `Summarizing ${files.length} file${files.length === 1 ? "" : "s"}…`,
    });
    try {
      const harness = new GitCommitHarness();
      const strictRuntime = harness.strictRuntime();
      const seedMemory = harness.seed({
        prompt: "Draft a commit message for the selected git changes.",
        workspaceRoot: root,
        openDirectoryEntries: status.entries.map((entry) => ({
          path: entry.path,
          kind: "file" as const,
        })),
      });
      const scoutTodo = strictRuntime.todos.add({
        title: "Approve git status targets for commit drafting",
        stage: "scout_targets",
        assignedArchetype: "scout",
        evidenceMemoryIds: [seedMemory.id],
      });
      const targetMemories = harness.rememberScoutTargets(
        files.map((file) => ({
          kind: "file" as const,
          path: file.path,
          reason: file.staged
            ? "Selected from staged git status for commit drafting."
            : "Selected from tracked unstaged git status for commit drafting.",
        })),
        [seedMemory.id],
      );
      const candidates: CommitFileCandidate[] = files.map((file) => ({
        path: file.path,
        status: file.status,
        reason: "Selected by deterministic git status for commit drafting.",
      }));
      const approvedFiles = harness.promoteApprovedFiles(
        candidates,
        candidates.map((candidate) => ({
          id: candidate.path,
          label: candidate.path,
          value: candidate,
        })),
        targetMemories.map((memory) => memory.id),
      );
      harness.approveMemories(targetMemories.map((memory) => memory.id));
      strictRuntime.todos.complete(
        scoutTodo.content.id,
        targetMemories.map((memory) => memory.id),
      );
      await strictRuntime.approveNavigation(
        "scout_targets",
        targetMemories.map((memory) => memory.id),
        async () => "Y",
      );
      const approvedFileByPath = new Map(
        approvedFiles.map((memory) => [memory.content.path, memory.id]),
      );
      const memories: CommitGenerationMemory["files"] = [];
      const warnings: string[] = [];
      for (const file of files) {
        assertCommitDraftNotCancelled(workflowId);
        updateCommitWorkflowStep(workflowId, `Reading ${file.path}`);
        const diff = await commitDiffFor(file);
        const fallback = fallbackSummaryFromDiff(file.path, file.status, diff);
        const chunks = chunkDiffForSummary(file.path, diff || `${file.path} changed.`);
        const chunkSummaries: CommitChunkSummary[] = [];
        const chunkMemoryIds: string[] = [];
        for (const chunk of chunks) {
          assertCommitDraftNotCancelled(workflowId);
          const diffMemory = harness.rememberDiffChunk(
            {
              path: file.path,
              chunkIndex: chunk.index,
              totalChunks: chunk.total,
              lineRange: `${chunk.startLine}-${chunk.endLine}`,
              text: chunk.text,
            },
            [approvedFileByPath.get(file.path)].filter((id): id is string => Boolean(id)),
          );
          const chunkFallback = fallbackSummaryFromDiff(
            file.path,
            file.status,
            chunk.text,
          );
          const rawChunk = await runCommitModel(
            buildDiffChunkSummaryPrompt(chunk),
            `Summarize ${file.path} ${chunk.index}/${chunk.total}`,
            72,
            workflowId,
          );
          const chunkSummary = await maybeRetryShortSummary(
            rawChunk,
            `Compress ${file.path} ${chunk.index}/${chunk.total}`,
            24,
            1,
            workflowId,
          );
          chunkSummaries.push({
            index: chunk.index,
            lineRange: `${chunk.startLine}-${chunk.endLine}`,
            summary: normalizeChunkSummary(
              chunkSummary,
              file.path,
              file.status,
              chunkFallback,
            ),
            fallback: chunkFallback,
          });
          const chunkMemory = harness.rememberChunkSummary(
            {
              path: file.path,
              chunkIndex: chunk.index,
              totalChunks: chunk.total,
              lineRange: `${chunk.startLine}-${chunk.endLine}`,
              summary: chunkSummaries.at(-1)?.summary ?? "",
            },
            [diffMemory.id],
            true,
          );
          chunkMemoryIds.push(chunkMemory.id);
        }

        const rawFileSummary =
          chunkSummaries.length <= 1
            ? (chunkSummaries[0]?.summary ?? "")
            : await runCommitModel(
                buildFileConsolidationPrompt(file.path, chunkSummaries),
                `Consolidate ${file.path}`,
                96,
                workflowId,
              );
        const fileSummary = await maybeRetryShortSummary(
          rawFileSummary,
          `Shorten ${file.path}`,
          35,
          2,
          workflowId,
        );
        const normalizedFileSummary = normalizeFileSummary(
          fileSummary,
          file.path,
          file.status,
          fallback,
        );
        harness.rememberFileSummary(
          {
            path: file.path,
            status: file.status,
            summary: normalizedFileSummary,
          },
          chunkMemoryIds,
          true,
        );
        memories.push({
          path: file.path,
          status: file.status,
          summary: normalizedFileSummary,
          fallback,
          chunks: chunkSummaries,
        });
      }

      const summaries: CommitFileSummary[] = memories.map(
        ({ path, status, summary, fallback }) => ({
          path,
          status,
          summary,
          fallback,
        }),
      );
      const rawConsolidated = await runCommitModel(
        buildChangeConsolidationPrompt(summaries),
        "Consolidate commit memory",
        180,
        workflowId,
      );
      const shortenedConsolidated = await maybeRetryShortSummary(
        rawConsolidated,
        "Shorten commit memory",
        65,
        3,
        workflowId,
      );
      const consolidatedSummary = normalizeChangeSummary(
        shortenedConsolidated,
        summaries,
      );
      const fileSummaryMemoryIds = harness.memory
        .byKind("file_summary", { approvedOnly: true })
        .map((memory) => memory.id);
      const sufficiency = harness.rememberDecision(
        "scout_evaluator",
        {
          verdict: "sufficient",
          reason: "Approved file summaries were enough to draft a commit message.",
        },
        fileSummaryMemoryIds,
        true,
      );
      const generated = await runCommitModel(
        buildCommitMessagePrompt(summaries, consolidatedSummary),
        "Draft commit message",
        180,
        workflowId,
      );
      const rawDraft = harness.rememberDraft(
        "message_drafter",
        { message: generated, raw: generated },
        [sufficiency.id],
        false,
      );
      const normalized = normalizeGeneratedCommitMessage(generated, summaries);
      const normalizedDraft = harness.rememberDraft(
        "message_normalizer",
        { message: normalized, raw: generated },
        [rawDraft.id],
        true,
      );
      harness.supersedeMemory(rawDraft.id);
      const redTeam = harness.rememberDecision(
        "message_red_team",
        {
          verdict: "ready",
          reason: "The normalized draft passed deterministic leak checks.",
        },
        [normalizedDraft.id],
        true,
      );
      harness.rememberFinal(
        { message: normalized, raw: generated },
        [redTeam.id],
        true,
      );
      const chunkTotal = memories.reduce((sum, file) => sum + file.chunks.length, 0);
      const harnessSnapshot = harness.memory.snapshot();
      setCommitMessage(normalized);
      setCommitDraft({
        files: memories,
        consolidatedSummary,
        generatedCommitMessage: normalized,
        warnings,
        harnessMemory: {
          lanes: harnessSnapshot.lanes.length,
          memories: harnessSnapshot.memories.length,
          approved: harnessSnapshot.memories.filter((memory) => memory.status === "approved").length,
        },
      });
      setOutput({
        kind: "info",
        body: `Generated a commit message from ${memories.length} file memor${memories.length === 1 ? "y" : "ies"} across ${chunkTotal} bounded diff chunk${chunkTotal === 1 ? "" : "s"}.`,
      });
    } catch (e) {
      if (e instanceof Error && e.message === COMMIT_DRAFT_CANCELLED) {
        setOutput({ kind: "info", body: "Commit draft cancelled." });
        toast.info("Commit draft stopped");
        return;
      }
      const body = e instanceof Error ? e.message : String(e);
      setOutput({ kind: "error", body });
      toast.error("Commit generation failed", { body });
    } finally {
      useModelWorkflows.getState().finishWorkflow(workflowId);
      setCommitGenerating(false);
    }
  };

  const commitDiffFor = async (entry: GitFileEntry): Promise<string> => {
    if (!root) return "";
    const summarizeStaged = staged.length > 0 && entry.staged;
    const diff = await ipc.gitDiff(root, entry.path, summarizeStaged).catch(() => "");
    if (diff.trim()) return diff;
    if (entry.status === "untracked") {
      const content = await ipc
        .readTextFile(`${root}/${entry.path}`)
        .catch(() => "");
      return `New file ${entry.path}:\n${content.slice(0, 12000)}`;
    }
    return `${entry.status} ${entry.path}`;
  };

  const runCommitModel = async (
    prompt: string,
    title: string,
    numPredict: number,
    workflowId: string,
  ): Promise<string> => {
    assertCommitDraftNotCancelled(workflowId);
    const requestId = newRequestId("git_commit");
    const chunks: string[] = [];
    let streamError: string | null = null;
    let sawStreamEvent = false;
    let markDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    useModelWorkflows.getState().attachRequest(workflowId, requestId, title);
    const off = await listenEvent<ChatToken>(`ollama:gen:${requestId}`, (event) => {
      sawStreamEvent = true;
      if ("token" in event) chunks.push(event.token);
      if ("error" in event) streamError = event.error;
      if ("cancelled" in event) streamError = COMMIT_DRAFT_CANCELLED;
      if ("done" in event && event.done) markDone();
    });
    try {
      await ipc.ollamaGenerate(requestId, {
        model: chatModel,
        prompt,
        system:
          "You are Pointer's git assistant. Be concise, specific, and accurate. Never invent changes not shown in the diff.",
        temperature: 0.1,
        num_predict: numPredict,
        purpose: "git_commit",
        title,
      });
      if (sawStreamEvent) {
        await Promise.race([
          done,
          new Promise<void>((resolve) => window.setTimeout(resolve, 250)),
        ]);
      }
      assertCommitDraftNotCancelled(workflowId);
      if (streamError === COMMIT_DRAFT_CANCELLED) {
        throw new Error(COMMIT_DRAFT_CANCELLED);
      }
      if (streamError) throw new Error(streamError);
      return chunks.join("").trim();
    } finally {
      off();
      useModelWorkflows.getState().detachRequest(workflowId, requestId);
    }
  };

  const maybeRetryShortSummary = async (
    raw: string,
    title: string,
    maxWords: number,
    maxSentences: number,
    workflowId: string,
  ): Promise<string> => {
    if (sentenceCount(raw) <= maxSentences && wordCount(raw) <= maxWords + 6) {
      return raw;
    }
    return runCommitModel(
      [
        "Compress this summary. Return only the compressed summary.",
        `Use at most ${maxSentences} sentence${maxSentences === 1 ? "" : "s"} and ${maxWords} words.`,
        "Do not add new facts, file paths, filenames, or changed symbols.",
        "",
        raw.trim(),
      ].join("\n"),
      title,
      Math.max(48, Math.min(120, maxWords * 3)),
      workflowId,
    );
  };

  const cancelCommitGeneration = async () => {
    if (!activeCommitWorkflow) return;
    setOutput({ kind: "info", body: "Stopping commit draft run…" });
    await cancelWorkflow(activeCommitWorkflow.id);
  };

  if (!root) {
    return (
      <div className="px-3 py-4 text-[12px] text-noir-mute font-sans">
        Open a folder to use source control.
      </div>
    );
  }

  if (!status.is_repo) {
    return (
      <div className="px-3 py-4 text-[12px] text-noir-mute font-sans">
        This folder isn't a git repository.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full font-sans" role="region" aria-label="Source control">
      <header className="px-3 py-2 border-b border-noir-line/60 flex items-center justify-between gap-2">
        <div
          ref={branchRef}
          className="relative flex items-center gap-1 text-[11px] text-noir-subtext min-w-0"
        >
          <button
            onClick={() => {
              setBranchOpen((v) => !v);
              if (!branches) loadBranches();
            }}
            className="flex items-center gap-1 hover:text-noir-text px-1.5 py-0.5 rounded hover:bg-noir-ridge/50 min-w-0"
            title="Switch branch"
            aria-haspopup="listbox"
            aria-expanded={branchOpen}
            aria-label={`Current branch ${status.branch ?? "detached"}. Click to switch branch`}
          >
            <GitBranch size={11} aria-hidden="true" />
            <span className="truncate max-w-[140px]">
              {status.branch ?? "detached"}
            </span>
            <ChevronDown size={10} aria-hidden="true" />
          </button>
          {(status.ahead ?? 0) > 0 && (
            <span className="text-[10px] text-noir-accent" aria-label={`${status.ahead} commits ahead of remote`}>↑{status.ahead}</span>
          )}
          {(status.behind ?? 0) > 0 && (
            <span className="text-[10px] text-amber-400" aria-label={`${status.behind} commits behind remote`}>↓{status.behind}</span>
          )}
          {branchOpen && (
            <BranchPicker
              branches={branches}
              loading={!branches}
              onSelect={async (name) => {
                setBranchOpen(false);
                const selected = branches?.find((branch) => branch.name === name);
                if (selected?.remote) {
                  const localName = name.replace(/^[^/]+\//, "");
                  const ok = await confirm({
                    title: `Create local branch ${localName}?`,
                    body: `${name} is a remote branch. Pointer will create and checkout a local branch from it instead of detaching HEAD.`,
                    confirmLabel: "Create local",
                    cancelLabel: "Cancel",
                  });
                  if (!ok) return;
                  await runCommand(`git checkout -b ${localName} ${name}`, () =>
                    ipc.gitCreateBranchFrom(root, localName, name, true),
                  );
                  await loadBranches();
                  return;
                }
                await runCommand(`git checkout ${name}`, () =>
                  ipc.gitCheckout(root, name),
                );
                await loadBranches();
              }}
              onCreate={async (name) => {
                setBranchOpen(false);
                await runCommand(`git checkout -b ${name}`, () =>
                  ipc.gitCreateBranch(root, name),
                );
                await loadBranches();
              }}
            />
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0" role="toolbar" aria-label="Git remote actions">
          <IconButton
            onClick={() => runCommand("git fetch", () => ipc.gitFetch(root))}
            title="Fetch from remote"
            disabled={busy}
          >
            <RefreshCw size={11} aria-hidden="true" />
          </IconButton>
          <IconButton
            onClick={() => runCommand("git pull", () => ipc.gitPull(root))}
            title="Pull from remote"
            disabled={busy}
          >
            <ArrowDownToLine size={11} aria-hidden="true" />
          </IconButton>
          <IconButton
            onClick={() => runCommand("git push", () => ipc.gitPush(root))}
            title="Push to remote"
            disabled={busy}
          >
            <ArrowUpToLine size={11} aria-hidden="true" />
          </IconButton>
        </div>
      </header>

      <GitWorkflowPanel
        statusOperation={status.operation}
        branches={branches}
        busy={busy}
        loadBranches={loadBranches}
        runCommand={runCommand}
        root={root}
      />

      <section className="px-3 py-2 border-b border-noir-line/60 bg-noir-canvas/20">
        <div className="rounded-md border border-noir-line/70 bg-noir-panel/70 overflow-hidden">
          <div className="px-2.5 py-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[11px] text-noir-text font-medium">
                Remote sync
              </div>
              <div className="text-[10px] text-noir-mute mt-0.5 truncate">
                {(status.ahead ?? 0) > 0 || (status.behind ?? 0) > 0
                  ? `${status.ahead ?? 0} ahead · ${status.behind ?? 0} behind`
                  : "Local branch is aligned with its upstream"}
              </div>
            </div>
            {busy && activeCommand?.startsWith("git ") && (
              <span
                className="inline-flex items-center gap-1.5 text-[10px] text-noir-accent shrink-0"
                role="status"
                aria-live="polite"
              >
                <Loader2 size={10} className="animate-spin" aria-hidden="true" />
                {activeCommand.replace(/^git\s+/, "")}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 border-t border-noir-line/60">
            <button
              onClick={() =>
                runCommand("git fetch", () => ipc.gitFetch(root), "Fetched")
              }
              disabled={busy}
              className="h-8 inline-flex items-center justify-center gap-1.5 text-[11px] text-noir-subtext hover:text-noir-text hover:bg-noir-ridge/50 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Fetch from remote"
            >
              <RefreshCw size={11} aria-hidden="true" />
              Fetch
            </button>
            <button
              onClick={() =>
                runCommand("git pull", () => ipc.gitPull(root), "Pulled")
              }
              disabled={busy}
              className="h-8 inline-flex items-center justify-center gap-1.5 border-l border-noir-line/60 text-[11px] text-noir-subtext hover:text-noir-text hover:bg-noir-ridge/50 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Pull from remote"
            >
              <ArrowDownToLine size={11} aria-hidden="true" />
              Pull
            </button>
            <button
              onClick={() =>
                runCommand("git push", () => ipc.gitPush(root), "Pushed")
              }
              disabled={busy}
              className="h-8 inline-flex items-center justify-center gap-1.5 border-l border-noir-line/60 text-[11px] text-noir-accent hover:bg-noir-accent/10 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Push to remote"
            >
              <ArrowUpToLine size={11} aria-hidden="true" />
              Push
            </button>
          </div>
        </div>
      </section>

      <div className="px-3 py-2 border-b border-noir-line/60 space-y-2">
        <div className="relative">
          <textarea
            value={commitMessage}
            onChange={(e) => {
              if (!commitGenerating) setCommitMessage(e.target.value);
            }}
            placeholder="Commit message (⌘↵ to commit)"
            aria-label="Commit message"
            aria-busy={commitGenerating}
            readOnly={commitGenerating}
            onKeyDown={(e) => {
              if (commitGenerating) return;
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            rows={2}
            className={`w-full text-[12px] bg-noir-canvas border rounded px-2 py-1.5 resize-none outline-none placeholder:text-noir-mute transition-[border-color,box-shadow,background-color] ${
              commitGenerating
                ? "border-noir-accent/55 pr-12 cursor-wait shadow-[0_0_0_1px_rgba(255,45,126,0.15),0_0_26px_-18px_rgba(255,45,126,0.95)]"
                : "border-noir-line focus:border-noir-accent"
            }`}
          />
          {commitGenerating && (
            <button
              type="button"
              onClick={cancelCommitGeneration}
              className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-md text-noir-accent hover:bg-noir-accent/10 focus:outline-none focus:ring-1 focus:ring-noir-accent/60"
              aria-label="Stop commit draft run"
              title={
                commitElapsedMs >= 45_000
                  ? "Stop this commit draft run"
                  : "Commit draft is running"
              }
            >
              <span className="sr-only">Generating commit message</span>
              <span className="pn-commit-agent-orbit" aria-hidden="true">
                <Bot size={16} strokeWidth={2.2} />
              </span>
            </button>
          )}
        </div>
        {commitGenerating && commitElapsedMs >= 30_000 && (
          <div
            className="rounded border border-noir-accent/25 bg-noir-accent/10 px-2 py-1 text-[10.5px] text-noir-subtext"
            role="status"
            aria-live="polite"
          >
            {commitElapsedMs >= 45_000
              ? "Still thinking. You can stop this run by clicking the robot icon."
              : "Thinking through the changed files. Pointer is still building commit memory."}
          </div>
        )}
        {commitDraft && (
          <details
            className="rounded border border-noir-line/60 bg-noir-canvas/20"
            data-testid="commit-generation-memory"
          >
            <summary className="cursor-pointer select-none px-2 py-1 text-[10px] uppercase tracking-wider text-noir-mute">
              Commit intelligence · {commitDraft.files.length} file memories ·{" "}
              {commitDraft.files.reduce((sum, item) => sum + item.chunks.length, 0)} chunks
              {commitDraft.harnessMemory
                ? ` · ${commitDraft.harnessMemory.approved}/${commitDraft.harnessMemory.memories} approved harness memories`
                : ""}
            </summary>
            <div className="border-t border-noir-line/60 px-2 py-2 space-y-2">
              <CommitDraftOption
                label="Consolidated summary"
                value={commitDraft.consolidatedSummary}
                action="Use summary"
                onUse={() => setCommitMessage(commitDraft.consolidatedSummary)}
              />
              <CommitDraftOption
                label="Commit message"
                value={commitDraft.generatedCommitMessage}
                action="Use message"
                onUse={() => setCommitMessage(commitDraft.generatedCommitMessage)}
              />
              {commitDraft.warnings.length > 0 && (
                <div className="rounded border border-noir-warn/30 bg-noir-warn/5 px-2 py-1 text-[10.5px] text-noir-warn">
                  {commitDraft.warnings.join(" ")}
                </div>
              )}
              <div className="space-y-1.5">
                {commitDraft.files.map((item) => (
                  <details
                    key={item.path}
                    className="rounded border border-noir-line/45 bg-noir-panel/30"
                  >
                    <summary className="cursor-pointer px-2 py-1 text-[10.5px] leading-relaxed">
                      <span className="font-mono text-noir-accent">{item.path}</span>
                      <span className="text-noir-mute">
                        {" "}
                        — {item.summary} ({item.chunks.length} chunk
                        {item.chunks.length === 1 ? "" : "s"})
                      </span>
                    </summary>
                    <ol className="border-t border-noir-line/40 px-2 py-1.5 space-y-1">
                      {item.chunks.map((chunk) => (
                        <li
                          key={`${item.path}:${chunk.index}`}
                          className="text-[10px] leading-relaxed text-noir-mute"
                        >
                          <span className="font-mono text-noir-subtext">
                            {chunk.index} · lines {chunk.lineRange}
                          </span>
                          <span> — {chunk.summary}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                ))}
              </div>
            </div>
          </details>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-noir-mute" aria-live="polite" role="status">
            {staged.length} staged · {unstaged.length} changed
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={generateCommitMessage}
              disabled={busy || commitGenerating || status.entries.length === 0}
              className="flex items-center gap-1.5 px-2 py-1 rounded border border-noir-line text-noir-subtext text-[11px] hover:border-noir-accent/50 hover:text-noir-accent disabled:opacity-40 disabled:cursor-not-allowed"
              title="Generate commit message with the local model"
              aria-label="Generate commit message with local model"
            >
              {commitGenerating ? (
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles size={11} aria-hidden="true" />
              )}
              Draft
            </button>
            <button
              onClick={commit}
              disabled={busy || commitGenerating || !commitMessage.trim()}
              className="flex items-center gap-1.5 px-2 py-1 rounded bg-noir-accent/15 text-noir-accent text-[11px] hover:bg-noir-accent/25 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Commit (⌘↵)"
              aria-label="Commit staged changes (Command Enter)"
            >
              {busy ? (
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              ) : (
                <GitCommit size={11} aria-hidden="true" />
              )}
              Commit
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {staged.length > 0 && (
          <Group
            label="Staged"
            count={staged.length}
            expanded={showStaged}
            onToggle={() => setShowStaged((v) => !v)}
            trailing={
              <IconButton onClick={unstageAll} title="Unstage all">
                <Minus size={11} />
              </IconButton>
            }
          >
            {staged.map((e) => (
              <FileRow
                key={`s:${e.path}`}
                entry={e}
                onJump={() => openDiff(e)}
                onOpen={() => root && openFile(`${root}/${e.path}`)}
                actions={
                  <IconButton
                    onClick={() => unstage([e.path])}
                    title="Unstage"
                  >
                    <Minus size={11} />
                  </IconButton>
                }
              />
            ))}
          </Group>
        )}
        {unstaged.length > 0 && (
          <Group
            label="Changes"
            count={unstaged.length}
            expanded={showUnstaged}
            onToggle={() => setShowUnstaged((v) => !v)}
            trailing={
              <>
                <IconButton onClick={stageAll} title="Stage all">
                  <Plus size={11} />
                </IconButton>
                <IconButton
                  onClick={() => discard(unstaged.map((e) => e.path))}
                  title="Discard all"
                >
                  <Undo2 size={11} />
                </IconButton>
              </>
            }
          >
            {unstaged.map((e) => (
              <FileRow
                key={`u:${e.path}`}
                entry={e}
                onJump={() => openDiff(e)}
                onOpen={() => root && openFile(`${root}/${e.path}`)}
                actions={
                  <>
                    <IconButton
                      onClick={() => stage([e.path])}
                      title="Stage"
                    >
                      <Plus size={11} />
                    </IconButton>
                    <IconButton
                      onClick={() => discard([e.path])}
                      title="Discard"
                    >
                      {e.status === "untracked" ? (
                        <Trash2 size={11} />
                      ) : (
                        <Undo2 size={11} />
                      )}
                    </IconButton>
                  </>
                }
              />
            ))}
          </Group>
        )}
        {staged.length === 0 && unstaged.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-noir-mute">
            <Check size={20} className="mx-auto text-noir-ok mb-2" />
            Working tree clean.
          </div>
        )}
      </div>

      {output && (
        <div
          className={`border-t border-noir-line/60 text-[11px] font-mono ${
            output.kind === "error" ? "text-noir-err" : "text-noir-subtext"
          }`}
          data-testid="git-output-pane"
        >
          <div className="px-3 py-1.5 flex items-center justify-between gap-2 border-b border-noir-line/40 bg-noir-canvas/45">
            <span className="text-[10px] uppercase tracking-wider text-noir-mute">
              Git output
            </span>
            <button
              onClick={() => setOutput(null)}
              className="text-noir-mute hover:text-noir-text shrink-0"
              aria-label="Dismiss git output"
              title="Dismiss"
            >
              <X size={11} aria-hidden="true" />
            </button>
          </div>
          <pre
            className="max-h-32 overflow-y-auto px-3 py-2 whitespace-pre-wrap break-words"
            data-testid="git-output-log"
          >
            {output.body}
          </pre>
        </div>
      )}
    </div>
  );
}

function assertCommitDraftNotCancelled(workflowId: string) {
  if (useModelWorkflows.getState().isCancelling(workflowId)) {
    throw new Error(COMMIT_DRAFT_CANCELLED);
  }
}

function updateCommitWorkflowStep(workflowId: string, currentStep: string) {
  const store = useModelWorkflows.getState();
  const workflow = store.workflows.find((item) => item.id === workflowId);
  store.updateWorkflow(workflowId, {
    currentStep,
    completedSteps: Math.min(
      workflow?.totalSteps ?? Number.MAX_SAFE_INTEGER,
      (workflow?.completedSteps ?? 0) + 1,
    ),
  });
}

function CommitDraftOption({
  label,
  value,
  action,
  onUse,
}: {
  label: string;
  value: string;
  action: string;
  onUse: () => void;
}) {
  return (
    <section className="rounded border border-noir-line/45 bg-noir-panel/40 px-2 py-1.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-noir-mute">
          {label}
        </div>
        <button
          type="button"
          onClick={onUse}
          className="rounded border border-noir-line px-1.5 py-0.5 text-[10px] text-noir-subtext hover:border-noir-accent/50 hover:text-noir-accent"
        >
          {action}
        </button>
      </div>
      <p className="whitespace-pre-wrap text-[10.5px] leading-relaxed text-noir-subtext">
        {value}
      </p>
    </section>
  );
}

function sentenceCount(text: string): number {
  return (
    text
      .replace(/\s+/g, " ")
      .trim()
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.length ?? 0
  );
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

type GitCommandRunner = (
  label: string,
  fn: () => Promise<string>,
  successToast?: string,
) => Promise<boolean>;

function GitWorkflowPanel({
  statusOperation,
  branches,
  busy,
  loadBranches,
  runCommand,
  root,
}: {
  statusOperation: GitOperationState | null;
  branches: GitBranchT[] | null;
  busy: boolean;
  loadBranches: () => Promise<void>;
  runCommand: GitCommandRunner;
  root: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [newBranch, setNewBranch] = useState("");
  const [branchBase, setBranchBase] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [rebaseTarget, setRebaseTarget] = useState("");

  useEffect(() => {
    if (!branches) void loadBranches();
  }, [branches, loadBranches]);

  const branchList = branches ?? [];
  const grouped = useMemo(() => groupBranches(branchList), [branchList]);
  const branchOptions = useMemo(
    () => [...grouped.local, ...grouped.remote],
    [grouped.local, grouped.remote],
  );

  useEffect(() => {
    const current = branchOptions.find((branch) => branch.current);
    const fallback = current?.name ?? branchOptions[0]?.name ?? "";
    if (!branchBase && fallback) setBranchBase(fallback);
    const remoteMain =
      branchOptions.find((branch) => branch.name === "origin/main")?.name ??
      branchOptions.find((branch) => branch.name === "main")?.name ??
      fallback;
    if (!mergeTarget && remoteMain) setMergeTarget(remoteMain);
    if (!rebaseTarget && remoteMain) setRebaseTarget(remoteMain);
  }, [branchBase, branchOptions, mergeTarget, rebaseTarget]);

  const createFromBase = async () => {
    const name = newBranch.trim();
    if (!name || !branchBase) return;
    const ok = await runCommand(`git checkout -b ${name} ${branchBase}`, () =>
      ipc.gitCreateBranchFrom(root, name, branchBase, true),
    );
    if (ok) {
      setNewBranch("");
      await loadBranches();
    }
  };

  const startMerge = async () => {
    if (!mergeTarget) return;
    const ok = await confirm({
      title: `Merge ${mergeTarget}?`,
      body: "Pointer will run git merge and then show conflicts here if Git stops for resolution.",
      confirmLabel: "Merge",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    await runCommand(`git merge ${mergeTarget}`, () =>
      ipc.gitMerge(root, mergeTarget),
    );
  };

  const startRebase = async () => {
    if (!rebaseTarget) return;
    const ok = await confirm({
      title: `Rebase onto ${rebaseTarget}?`,
      body: "Pointer will run git rebase and then show each blocked step here. You can abort from the same panel while the rebase is active.",
      confirmLabel: "Rebase",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    await runCommand(`git rebase ${rebaseTarget}`, () =>
      ipc.gitRebase(root, rebaseTarget),
    );
  };

  if (statusOperation) {
    return (
      <OperationCard
        operation={statusOperation}
        busy={busy}
        runCommand={runCommand}
        root={root}
      />
    );
  }

  return (
    <section className="border-b border-noir-line/60 bg-noir-chrome/20">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-left"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2 text-[11px] font-sans text-noir-text">
          <GitPullRequest size={12} className="text-noir-accent" aria-hidden="true" />
          Git workflow
        </span>
        {expanded ? (
          <ChevronDown size={12} className="text-noir-mute" aria-hidden="true" />
        ) : (
          <ChevronRight size={12} className="text-noir-mute" aria-hidden="true" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          <div className="grid grid-cols-[1fr_auto] gap-1.5">
            <input
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder="new branch name"
              className="min-w-0 rounded border border-noir-line bg-noir-canvas px-2 py-1 text-[11px] outline-none focus:border-noir-accent"
              aria-label="New branch name"
            />
            <button
              onClick={createFromBase}
              disabled={busy || !newBranch.trim() || !branchBase}
              className="pn-icon-button px-2"
              title="Create branch from selected base"
              aria-label="Create branch from selected base"
            >
              <Plus size={12} aria-hidden="true" />
            </button>
          </div>
          <LabeledSelect
            label="from"
            value={branchBase}
            onChange={setBranchBase}
            branches={branchOptions}
          />
          <div className="grid grid-cols-2 gap-2">
            <WorkflowAction
              icon={<GitMerge size={12} aria-hidden="true" />}
              label="Merge"
              value={mergeTarget}
              onChange={setMergeTarget}
              branches={branchOptions}
              disabled={busy || !mergeTarget}
              onRun={startMerge}
            />
            <WorkflowAction
              icon={<GitPullRequest size={12} aria-hidden="true" />}
              label="Rebase"
              value={rebaseTarget}
              onChange={setRebaseTarget}
              branches={branchOptions}
              disabled={busy || !rebaseTarget}
              onRun={startRebase}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function OperationCard({
  operation,
  busy,
  runCommand,
  root,
}: {
  operation: GitOperationState;
  busy: boolean;
  runCommand: GitCommandRunner;
  root: string;
}) {
  const progress = operationProgress(operation);
  const hasConflicts = operation.conflicts.length > 0;
  const canContinue = operation.kind === "rebase" || operation.kind === "merge";
  const continueOp = () => {
    if (operation.kind === "rebase") {
      return runCommand("git rebase --continue", () => ipc.gitRebaseContinue(root));
    }
    if (operation.kind === "merge") {
      return runCommand("git merge --continue", () => ipc.gitMergeContinue(root));
    }
    return Promise.resolve(false);
  };
  const abortOp = async () => {
    const ok = await confirm({
      title: operationAbortLabel(operation),
      body: "This asks Git to return the repository to the state before the operation began.",
      confirmLabel: "Abort",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    if (operation.kind === "rebase") {
      await runCommand("git rebase --abort", () => ipc.gitRebaseAbort(root));
    } else if (operation.kind === "merge") {
      await runCommand("git merge --abort", () => ipc.gitMergeAbort(root));
    }
  };

  return (
    <section className="border-b border-noir-accent/25 bg-noir-accent/5 px-3 py-3">
      <div className="flex items-start gap-2">
        <CircleAlert size={14} className="mt-0.5 text-noir-accent shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-sans font-medium text-noir-text">
            {operation.title}
          </div>
          <div className="text-[10.5px] text-noir-mute">
            {operation.head ? `${operation.head} → ` : ""}
            {operation.target ?? operation.kind}
            {hasConflicts
              ? ` · ${operation.conflicts.length} conflict${operation.conflicts.length === 1 ? "" : "s"}`
              : " · ready to continue"}
          </div>
          {progress !== null && (
            <div className="mt-2 h-1.5 rounded-full bg-noir-ridge overflow-hidden">
              <div
                className="h-full rounded-full bg-noir-accent"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      </div>
      {hasConflicts && (
        <ul className="mt-2 rounded border border-noir-line/60 bg-noir-canvas/25 divide-y divide-noir-line/50">
          {operation.conflicts.map((path) => (
            <li key={path} className="px-2 py-1 text-[10.5px] font-mono text-noir-text truncate">
              {path}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center justify-end gap-1">
        <button
          onClick={() => void continueOp()}
          disabled={busy || hasConflicts || !canContinue}
          className="flex items-center gap-1.5 rounded bg-noir-accent/15 px-2 py-1 text-[11px] text-noir-accent hover:bg-noir-accent/25 disabled:opacity-40 disabled:cursor-not-allowed"
          title={hasConflicts ? "Resolve conflicts and stage files first" : operationActionLabel(operation)}
          aria-label={operationActionLabel(operation)}
        >
          <Play size={11} aria-hidden="true" />
          Continue
        </button>
        <button
          onClick={() => void abortOp()}
          disabled={busy || !canContinue}
          className="flex items-center gap-1.5 rounded border border-noir-line px-2 py-1 text-[11px] text-noir-subtext hover:border-noir-warn/60 hover:text-noir-warn disabled:opacity-40 disabled:cursor-not-allowed"
          title={operationAbortLabel(operation)}
          aria-label={operationAbortLabel(operation)}
        >
          <Undo2 size={11} aria-hidden="true" />
          Abort
        </button>
      </div>
    </section>
  );
}

function WorkflowAction({
  icon,
  label,
  value,
  onChange,
  branches,
  disabled,
  onRun,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (value: string) => void;
  branches: GitBranchT[];
  disabled: boolean;
  onRun: () => void;
}) {
  return (
    <div className="rounded border border-noir-line/70 bg-noir-canvas/20 p-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-noir-mute">
        {icon}
        {label}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-noir-line bg-noir-canvas px-1.5 py-1 text-[10.5px] outline-none focus:border-noir-accent"
        aria-label={`${label} target`}
      >
        {branches.map((branch) => (
          <option key={`${label}:${branch.name}`} value={branch.name}>
            {branch.remote ? "remote · " : ""}
            {branch.name}
          </option>
        ))}
      </select>
      <button
        onClick={onRun}
        disabled={disabled}
        className="w-full rounded bg-noir-ridge/60 px-2 py-1 text-[10.5px] text-noir-subtext hover:bg-noir-accent/15 hover:text-noir-accent disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Run {label.toLowerCase()}
      </button>
    </div>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  branches,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  branches: GitBranchT[];
}) {
  return (
    <label className="grid grid-cols-[auto_1fr] items-center gap-1.5 text-[10px] text-noir-mute">
      <span className="uppercase tracking-wider">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 rounded border border-noir-line bg-noir-canvas px-1.5 py-1 text-[10.5px] text-noir-text outline-none focus:border-noir-accent"
      >
        {branches.map((branch) => (
          <option key={`base:${branch.name}`} value={branch.name}>
            {branch.remote ? "remote · " : ""}
            {branch.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Group({
  label,
  count,
  expanded,
  onToggle,
  trailing,
  children,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-noir-line/40">
      <header className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wider text-noir-mute bg-noir-chrome/30">
        <button
          onClick={onToggle}
          className="flex items-center gap-1 hover:text-noir-text"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label} (${count} files)`}
        >
          {expanded ? <ChevronDown size={10} aria-hidden="true" /> : <ChevronRight size={10} aria-hidden="true" />}
          {label}
          <span className="text-[10px] text-noir-mute font-mono">{count}</span>
        </button>
        <div className="flex items-center gap-0.5 opacity-70">{trailing}</div>
      </header>
      {expanded && <ul>{children}</ul>}
    </section>
  );
}

function FileRow({
  entry,
  onJump,
  onOpen,
  actions,
}: {
  entry: GitFileEntry;
  onJump: () => void;
  onOpen: () => void;
  actions: React.ReactNode;
}) {
  return (
    <li className="group flex items-center gap-2 px-3 py-1 text-[12px] hover:bg-noir-ridge/40">
      <button
        onClick={onJump}
        onDoubleClick={onOpen}
        className="flex-1 min-w-0 flex items-center gap-2 text-left"
        title={`${entry.path}\nClick: open diff · Double-click: open file`}
      >
        <span
          className={`text-[10px] font-mono shrink-0 ${gitStatusColor(entry.status)}`}
        >
          {gitStatusLetter(entry.status)}
        </span>
        <span className="font-mono truncate">{entry.path}</span>
      </button>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
        <IconButton onClick={onOpen} title="Open file">
          <FileText size={11} />
        </IconButton>
        {actions}
      </div>
    </li>
  );
}

function IconButton({
  children,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="p-1 text-noir-mute hover:text-noir-text disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function BranchPicker({
  branches,
  loading,
  onSelect,
  onCreate,
}: {
  branches: GitBranchT[] | null;
  loading: boolean;
  onSelect: (name: string) => void;
  onCreate: (name: string) => void;
}) {
  const [q, setQ] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const filtered = useMemo(() => {
    if (!branches) return [];
    if (!q.trim()) return branches;
    const needle = q.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(needle));
  }, [branches, q]);
  return (
    <div
      className="absolute top-full left-0 mt-1 w-72 max-h-72 z-pn-panel-popover rounded-md border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
      role="dialog"
      aria-label="Branch picker"
    >
      <div className="px-2 py-1 border-b border-noir-line/60">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find or create branch…"
          aria-label="Find or create branch"
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              q.trim() &&
              !filtered.some((b) => b.name === q.trim())
            ) {
              onCreate(q.trim());
            }
          }}
          className="w-full bg-transparent text-[12px] outline-none placeholder:text-noir-mute"
        />
      </div>
      <div className="overflow-y-auto max-h-56" role="listbox" aria-label="Branches">
        {loading && (
          <div className="px-3 py-2 text-[11px] text-noir-mute flex items-center gap-2" role="status">
            <Loader2 size={11} className="animate-spin" aria-hidden="true" />
            Loading branches…
          </div>
        )}
        {!loading && filtered.length === 0 && q.trim() && (
          <button
            onClick={() => onCreate(q.trim())}
            className="w-full text-left px-3 py-1.5 text-[12px] text-noir-accent hover:bg-noir-ridge/40"
          >
            + Create branch “{q.trim()}”
          </button>
        )}
        {(["local", "remote"] as const).map((kind) => {
          const grouped = groupBranches(filtered);
          const rows = kind === "local" ? grouped.local : grouped.remote;
          if (rows.length === 0) return null;
          return (
            <div key={kind}>
              <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-noir-mute bg-noir-chrome/40">
                {kind === "local" ? "Local" : "Remote"}
              </div>
              {rows.map((b) => (
                <button
                  key={b.name}
                  onClick={() => onSelect(b.name)}
                  className="w-full text-left px-3 py-1 flex items-center justify-between gap-2 hover:bg-noir-ridge/40 text-[12px]"
                  role="option"
                  aria-selected={b.current}
                  aria-label={b.current ? `${b.name} (current)` : `Switch to ${b.name}`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Check
                      size={10}
                      className={b.current ? "text-noir-accent" : "opacity-0"}
                      aria-hidden="true"
                    />
                    <span className="truncate">{b.name}</span>
                  </span>
                  <span className="text-[10px] text-noir-mute shrink-0">
                    {b.remote ? "remote" : b.last_commit}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="px-3 py-1 text-[10px] text-noir-mute border-t border-noir-line/60">
        Enter to checkout · Use Git workflow to create from a base
      </div>
    </div>
  );
}
