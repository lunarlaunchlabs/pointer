import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  GitBranch,
  GitCommit,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useGit, gitStatusColor, gitStatusLetter } from "@/store/git";
import { useWorkspace } from "@/store/workspace";
import { useEditorStore } from "@/store/editor";
import { useDiffViewer } from "@/store/diffViewer";
import { ipc, type GitBranch as GitBranchT, type GitFileEntry } from "@/lib/ipc";
import { languageFromPath } from "@/lib/lang";
import { toast } from "@/components/Toast";
import { confirm } from "@/components/Confirm";

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
  ) => {
    if (!root) return;
    setBusy(true);
    setOutput({ kind: "info", body: `Running ${label}…` });
    try {
      const out = await fn();
      setOutput({ kind: "info", body: out.trim() || `${label} done.` });
      if (successToast) toast.info(successToast);
      await refresh();
    } catch (e) {
      const body = e instanceof Error ? e.message : String(e);
      setOutput({ kind: "error", body });
      toast.error(`${label} failed`, { body });
    } finally {
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
    if (!commitMessage.trim()) {
      toast.warn("Commit message required");
      return;
    }
    if (staged.length === 0) {
      // Auto-stage all unstaged tracked changes when nothing is
      // explicitly staged — git's "commit -a" semantics. Skip
      // untracked files (must be explicitly added).
      const trackable = unstaged
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
      await runCommand("git add", () => ipc.gitStage(root!, trackable));
    }
    await runCommand("git commit", () => ipc.gitCommit(root!, commitMessage));
    setCommitMessage("");
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

      <div className="px-3 py-2 border-b border-noir-line/60 space-y-2">
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Commit message (⌘↵ to commit)"
          aria-label="Commit message"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          rows={2}
          className="w-full text-[12px] bg-noir-canvas border border-noir-line rounded px-2 py-1.5 resize-none outline-none focus:border-noir-accent placeholder:text-noir-mute"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-noir-mute" aria-live="polite" role="status">
            {staged.length} staged · {unstaged.length} changed
          </span>
          <button
            onClick={commit}
            disabled={busy || !commitMessage.trim()}
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
          className={`border-t border-noir-line/60 px-3 py-2 text-[11px] font-mono max-h-32 overflow-y-auto ${
            output.kind === "error" ? "text-noir-err" : "text-noir-subtext"
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <pre className="whitespace-pre-wrap flex-1 break-words">
              {output.body}
            </pre>
            <button
              onClick={() => setOutput(null)}
              className="text-noir-mute hover:text-noir-text shrink-0"
              aria-label="Dismiss git output"
              title="Dismiss"
            >
              <X size={11} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
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
        {filtered.map((b) => (
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
              {b.last_commit}
            </span>
          </button>
        ))}
      </div>
      <div className="px-3 py-1 text-[10px] text-noir-mute border-t border-noir-line/60">
        Enter to checkout · Type a new name then Enter to create
      </div>
    </div>
  );
}
