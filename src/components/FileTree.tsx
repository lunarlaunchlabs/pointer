import React, { useEffect, useMemo, useState } from "@/lib/preactSignalCompat";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ClipboardPaste,
  Copy,
  Edit3,
  ExternalLink,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Search,
  Scissors,
  TerminalSquare,
  Trash2,
  X,
} from "@/lib/lucide";
import { useRef } from "@/lib/preactSignalCompat";
import { useWorkspace } from "@/store/workspace";
import { useEditorStore } from "@/store/editor";
import {
  useGit,
  aggregateFolderStatus,
  gitFolderStatusTitle,
  gitStatusColor,
  gitStatusLetter,
  gitStatusNameClass,
  type GitFolderStatusSummary,
} from "@/store/git";
import { useDiagnostics } from "@/store/diagnostics";
import { useSettings } from "@/store/settings";
import { ipc, listenEvent, type FsEntry } from "@/lib/ipc";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";
import { confirm } from "@/components/Confirm";
import { revealInFiler } from "@/lib/reveal";
import pathLib from "@/lib/path";
import { FileIconFor } from "@/lib/fileIcon";
import { useCompareSelection } from "@/store/compareSelection";
import { useDiffViewer } from "@/store/diffViewer";
import { useTreeSelection } from "@/store/treeSelection";
import { languageFromPath } from "@/lib/lang";
import { toast } from "@/components/Toast";
import { useTerminals, nextTerminalTitle } from "@/store/terminal";
import { useSession } from "@/store/session";

/** Spawn a fresh terminal tab whose initial working directory is
 *  `cwd`. Reused by the file-tree context menu and the "Open in
 *  Terminal" actions. Shows the panel + activates the new tab so
 *  the user sees the cursor sitting in the right directory. */
async function openTerminalAt(cwd: string): Promise<void> {
  try {
    const { id, title } = nextTerminalTitle();
    const result = await ipc.terminalOpen(id, cwd, 100, 24);
    useTerminals.getState().add({
      id,
      title,
      shell: result.shell,
      cwd,
      exited: false,
      exitCode: null,
    });
    useTerminals.getState().setOpen(true);
    useTerminals.getState().setActive(id);
  } catch (e) {
    toast.error("Couldn't open terminal", {
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Open the side-by-side diff for two arbitrary workspace files.
 *  Reads both contents and hands the spec to the shared diff viewer
 *  — the same component the SCM panel uses. */
async function doCompare(leftPath: string, rightPath: string): Promise<void> {
  try {
    const [left, right] = await Promise.all([
      ipc.readTextFile(leftPath).catch(() => ""),
      ipc.readTextFile(rightPath).catch(() => ""),
    ]);
    useDiffViewer.getState().show({
      title: `${shortName(leftPath)} ↔ ${shortName(rightPath)}`,
      language: languageFromPath(rightPath),
      original: left,
      modified: right,
      readOnly: true,
      path: rightPath,
      source: "literal",
    });
    useCompareSelection.getState().setSelected(null);
  } catch (e) {
    toast.error("Couldn't compare", {
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

function shortName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

type Pending = {
  parentDir: string; // workspace-absolute
  kind: "file" | "folder";
};

type TransferMode = "copy" | "move";

type TreeClipboard = {
  mode: TransferMode;
  paths: string[];
};

/** Tiny CSS.escape polyfill — Tauri targets recent webkit which has it
 *  natively, but typing falls back here for older platforms or test envs. */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && (CSS as { escape?: (s: string) => string }).escape) {
    return (CSS as { escape: (s: string) => string }).escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function focusTreeRow(path: string): void {
  requestAnimationFrame(() => {
    const row = document.querySelector(
      `[data-tree-path="${cssEscape(path)}"]`,
    ) as HTMLElement | null;
    row?.focus();
  });
}

function pathBelongsToRoot(path: string, root: string): boolean {
  const cleanRoot = root.replace(/[\\/]+$/, "");
  return (
    path === cleanRoot ||
    path.startsWith(`${cleanRoot}/`) ||
    path.startsWith(`${cleanRoot}\\`)
  );
}

function normalizeTreePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

function isSameOrDescendant(path: string, ancestor: string): boolean {
  const child = normalizeTreePath(path);
  const parent = normalizeTreePath(ancestor);
  return child === parent || child.startsWith(`${parent}/`);
}

function copyName(name: string, index: number): string {
  if (index === 0) return name;
  const suffix = index === 1 ? " copy" : ` copy ${index}`;
  const lastDot = name.lastIndexOf(".");
  const dotIsExtension = lastDot > 0;
  if (!dotIsExtension) return `${name}${suffix}`;
  return `${name.slice(0, lastDot)}${suffix}${name.slice(lastDot)}`;
}

function uniqueDestinationPath(
  sourcePath: string,
  targetDir: string,
  occupiedNames: Set<string>,
): string {
  const originalName = pathLib.basename(sourcePath);
  for (let i = 0; i < 10_000; i += 1) {
    const candidateName = copyName(originalName, i);
    const key = candidateName.toLocaleLowerCase();
    if (!occupiedNames.has(key)) {
      occupiedNames.add(key);
      return pathLib.join(targetDir, candidateName);
    }
  }
  throw new Error(`Couldn't find an available name for ${originalName}`);
}

/** Stable sort comparator. Default puts directories first then alphabetical;
 *  "name" mode is purely lexical so users who don't think in folders see a
 *  predictable ABC list across files and dirs. */
/** Build the title attribute shown on long-hover over a tree row.
 *  We compose: path · size (for files) · last modified — matching
 *  the metadata other IDEs show. Falls back gracefully when the
 *  backend doesn't have the field (older builds, special files). */
function buildEntryTooltip(entry: FsEntry): string {
  const lines: string[] = [entry.path];
  if (!entry.is_dir && entry.size != null) {
    lines.push(formatFileSize(entry.size));
  }
  if (entry.mtime != null) {
    lines.push(`Modified ${formatRelative(entry.mtime)}`);
  }
  return lines.join("\n");
}

function formatFileSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Format a Unix epoch (seconds) as a human-friendly relative time
 *  — "5m ago" / "yesterday" / "Mar 12 14:22". Mirrors the heuristics
 *  most IDEs use so the tooltip reads naturally at a glance. */
function formatRelative(epochSec: number): string {
  const now = Date.now() / 1000;
  const diff = now - epochSec;
  if (diff < 0) return "just now";
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  const d = new Date(epochSec * 1000);
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  };
  return d.toLocaleString(undefined, opts);
}

function sortEntries(entries: FsEntry[], mode: "type" | "name"): FsEntry[] {
  const copy = entries.slice();
  if (mode === "name") {
    copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  } else {
    copy.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }
  return copy;
}

export function FileTree() {
  const root = useWorkspace((s) => s.root);
  const entries = useWorkspace((s) => s.entries);
  const expanded = useWorkspace((s) => s.expanded);
  const childrenCache = useWorkspace((s) => s.childrenCache);
  const toggle = useWorkspace((s) => s.toggle);
  const refresh = useWorkspace((s) => s.refresh);
  const refreshDir = useWorkspace((s) => s.refreshDir);
  const pendingCreate = useWorkspace((s) => s.pendingCreate);
  const clearPendingCreate = useWorkspace((s) => s.clearPendingCreate);
  const openFile = useEditorStore((s) => s.openFile);
  const closeTab = useEditorStore((s) => s.closeTab);
  const activePath = useEditorStore((s) => s.activePath);
  const collapseAll = useWorkspace((s) => s.collapseAll);
  const expandTo = useWorkspace((s) => s.expandTo);
  const treeSort = useSettings((s) => s.treeSort);

  const [pending, setPending] = useState<Pending | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const [treeClipboard, setTreeClipboard] = useState<TreeClipboard | null>(null);
  const lastAutoRevealedRef = useRef<string | null>(null);

  const rootName = useMemo(() => root?.split(/[\\/]/).pop() ?? "", [root]);

  /** Filter shown at the top of the tree — fuzzy substring on
   *  basename, case-insensitive. Highlights matching files and
   *  auto-expands directories that contain a match. Cleared with
   *  Esc or the ✕ button. */
  const filterLower = filter.trim().toLowerCase();
  const matchPath = (p: string) =>
    !filterLower || (p.split(/[\\/]/).pop() ?? "").toLowerCase().includes(filterLower);

  /** Flat DOM-order list of every visible row's path. Used so
   *  Shift-click can compute the range between two rows without
   *  needing tree shape. Recomputed on every render — cheap because
   *  we only walk the EXPANDED slice of the tree. */
  const visibleOrder = useMemo(() => {
    const out: string[] = [];
    const walk = (kids: FsEntry[]) => {
      for (const k of sortEntries(kids, treeSort)) {
        const matchesSelf =
          !filterLower ||
          (k.path.split(/[\\/]/).pop() ?? "").toLowerCase().includes(filterLower);
        const desc = childrenCache[k.path];
        const anyDescendant = (kids?: FsEntry[]): boolean => {
          if (!kids) return false;
          for (const c of kids) {
            if (matchPath(c.path)) return true;
            if (c.is_dir && anyDescendant(childrenCache[c.path])) return true;
          }
          return false;
        };
        const visible =
          !filterLower || matchesSelf || (k.is_dir && anyDescendant(desc));
        if (!visible) continue;
        out.push(k.path);
        if (k.is_dir && expanded.has(k.path) && desc) walk(desc);
      }
    };
    walk(entries);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, expanded, childrenCache, treeSort, filterLower]);

  const copyPath = (p: string, relative = false) => {
    let toCopy = p;
    if (relative && root && p.startsWith(root)) {
      toCopy = p.slice(root.length).replace(/^[\\/]+/, "");
    }
    navigator.clipboard?.writeText(toCopy).catch(() => {});
  };

  const selectedOrEntryPaths = (entry: FsEntry | null): string[] => {
    const selected = useTreeSelection.getState().selected;
    if (entry && selected.has(entry.path) && selected.size > 1) {
      return Array.from(selected);
    }
    if (entry) return [entry.path];
    return Array.from(selected);
  };

  const setFileClipboard = (mode: TransferMode, sources: string[]) => {
    const paths = Array.from(new Set(sources.filter(Boolean)));
    if (paths.length === 0) return;
    setTreeClipboard({ mode, paths });
    toast.info(`${mode === "copy" ? "Copied" : "Cut"} ${paths.length} item${paths.length === 1 ? "" : "s"}`);
  };

  const revealTreePath = React.useCallback(
    (path: string, flash = false) => {
      expandTo(path).then(() => {
        // Scroll the matching row into view after expansion has committed.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const root = scrollerRef.current;
            if (!root) return;
            const row = root.querySelector(
              `[data-tree-path="${cssEscape(path)}"]`,
            ) as HTMLElement | null;
            row?.scrollIntoView({ block: "center" });
            if (flash) {
              row?.classList.add("pn-flash");
              setTimeout(() => row?.classList.remove("pn-flash"), 900);
            }
          });
        });
      });
    },
    [expandTo],
  );

  // Keep the file tree tracking the editor's active file. This is a reveal,
  // not a selection change: users can still multi-select files without every
  // tab switch rewriting their selection set.
  useEffect(() => {
    if (!root || !activePath || activePath.startsWith("untitled:")) return;
    if (!pathBelongsToRoot(activePath, root)) return;
    const key = `${root}\0${activePath}`;
    if (lastAutoRevealedRef.current === key) return;
    lastAutoRevealedRef.current = key;
    revealTreePath(activePath);
  }, [activePath, root, revealTreePath]);

  // Cross-component tree actions. Dispatched via the global action bus
  // by App.tsx so commands and menu items don't have to know about this
  // component's internal state.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const ce = e as CustomEvent<{ path: string }>;
      const p = ce.detail?.path;
      if (!p) return;
      revealTreePath(p, true);
    };
    const onFocusFilter = () => filterRef.current?.focus();
    const onCollapse = () => collapseAll();
    window.addEventListener("pointer:reveal_in_tree", onReveal as EventListener);
    window.addEventListener(
      "pointer:focus_tree_filter",
      onFocusFilter as EventListener,
    );
    window.addEventListener("pointer:collapse_tree", onCollapse as EventListener);
    return () => {
      window.removeEventListener(
        "pointer:reveal_in_tree",
        onReveal as EventListener,
      );
      window.removeEventListener(
        "pointer:focus_tree_filter",
        onFocusFilter as EventListener,
      );
      window.removeEventListener(
        "pointer:collapse_tree",
        onCollapse as EventListener,
      );
    };
  }, [collapseAll, revealTreePath]);

  // Auto-refresh on FS events from the watcher.
  useEffect(() => {
    let off: (() => void) | undefined;
    listenEvent<{ kind: string; paths: string[] }>("fs:change", (p) => {
      const root = useWorkspace.getState().root;
      if (!root) return;
      const dirsToRefresh = new Set<string>();
      for (const path of p.paths) {
        // Refresh the parent dir; for top-level the root entries.
        const parent = pathLib.dirname(path);
        if (parent === root || parent === ".") dirsToRefresh.add(root);
        else dirsToRefresh.add(parent);
      }
      for (const d of dirsToRefresh) {
        refreshDir(d).catch(() => {});
      }
    }).then((u) => (off = u));
    return () => off?.();
  }, [refreshDir]);

  const beginCreate = (kind: "file" | "folder", parentDir: string) => {
    setPending({ parentDir, kind });
    // Ensure the dir is expanded so the inline input appears in context.
    if (parentDir !== root) {
      const exp = useWorkspace.getState().expanded;
      if (!exp.has(parentDir)) toggle(parentDir);
    }
  };

  // Mirror imperative create requests from the workspace store (driven by
  // the File menu, command palette, or any other entry point that can't
  // reach into this component's closure directly). The `nonce` field makes
  // repeated requests with the same payload still fire this effect.
  useEffect(() => {
    if (!pendingCreate) return;
    beginCreate(pendingCreate.kind, pendingCreate.parentDir);
    clearPendingCreate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCreate?.nonce]);

  const submitCreate = async (name: string) => {
    if (!pending) return;
    const trimmed = name.trim();
    setPending(null);
    if (!trimmed) return;
    const fullPath = pathLib.join(pending.parentDir, trimmed);
    try {
      if (pending.kind === "file") {
        await ipc.createFile(fullPath);
        await openFile(fullPath);
      } else {
        await ipc.createDir(fullPath);
      }
      await refreshDir(pending.parentDir).catch(() => {});
      await refresh().catch(() => {});
    } catch (e) {
      toast.error(`Couldn't create ${pending.kind}`, {
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const submitRename = async (oldPath: string, newName: string) => {
    setRenaming(null);
    const trimmed = newName.trim();
    if (!trimmed) return;
    const parent = pathLib.dirname(oldPath);
    const newPath = pathLib.join(parent, trimmed);
    if (newPath === oldPath) return;
    try {
      await ipc.renamePath(oldPath, newPath);
      useEditorStore.getState().rewritePathPrefix(oldPath, newPath);
      await refreshDir(parent).catch(() => {});
      await refresh().catch(() => {});
    } catch (e) {
      toast.error("Couldn't rename", {
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /** Copy or move a batch of source paths into `targetDir`. Skips
   *  impossible/no-op transfers and chooses Finder-style duplicate
   *  names instead of overwriting an existing file. */
  const transferFiles = async (
    sources: string[],
    targetDir: string,
    mode: TransferMode,
  ): Promise<{ changed: number; failed: number }> => {
    const uniqueSources = Array.from(new Set(sources.filter(Boolean)));
    const valid = uniqueSources.filter((src) => {
      if (src === targetDir) return false;
      if (isSameOrDescendant(targetDir, src)) return false;
      const parent = pathLib.dirname(src);
      return mode === "copy" || parent !== targetDir;
    });
    if (valid.length === 0) return { changed: 0, failed: 0 };
    const verb = mode === "copy" ? "Copy" : "Move";
    const pastVerb = mode === "copy" ? "Copied" : "Moved";
    if (valid.length > 5) {
      const ok = await confirm({
        title: `${verb} ${valid.length} items into ${pathLib.basename(targetDir)}?`,
        body: `${verb} applies to every selected item.`,
        confirmLabel: verb,
      });
      if (!ok) return { changed: 0, failed: 0 };
    }
    let targetEntries: FsEntry[] = [];
    try {
      targetEntries = await ipc.readWorkspaceTree(targetDir);
    } catch {
      targetEntries = [];
    }
    const occupied = new Set(targetEntries.map((entry) => entry.name.toLocaleLowerCase()));
    const dirty = new Set<string>([targetDir]);
    let changed = 0;
    let failed = 0;
    for (const src of valid) {
      try {
        const dest = uniqueDestinationPath(src, targetDir, occupied);
        if (mode === "copy") {
          await ipc.copyPath(src, dest);
        } else {
          await ipc.renamePath(src, dest);
          useEditorStore.getState().rewritePathPrefix(src, dest);
          dirty.add(pathLib.dirname(src));
        }
        changed++;
      } catch (e) {
        failed++;
        console.warn(`${mode} failed`, src, "→", targetDir, e);
      }
    }
    useTreeSelection.getState().clear();
    for (const dir of dirty) {
      await refreshDir(dir).catch(() => {});
    }
    await refresh().catch(() => {});
    if (failed > 0) {
      toast.warn(`${pastVerb} ${changed} · ${failed} failed`);
    } else if (changed > 0) {
      toast.success(`${pastVerb} ${changed} item${changed === 1 ? "" : "s"}`);
    }
    return { changed, failed };
  };

  const pasteClipboard = async (targetDir: string) => {
    if (!treeClipboard) return;
    const result = await transferFiles(
      treeClipboard.paths,
      targetDir,
      treeClipboard.mode,
    );
    if (treeClipboard.mode === "move" && result?.changed) {
      setTreeClipboard(null);
    }
  };

  const remove = async (target: string) => {
    const name = target.split(/[\\/]/).pop() ?? target;
    const ok = await confirm({
      title: `Delete ${name}?`,
      body: (
        <div className="space-y-2">
          <p>
            Pointer will permanently remove this from disk — there is no undo
            inside the editor.
          </p>
          <code className="block font-mono text-[11px] text-noir-mute truncate">
            {target}
          </code>
        </div>
      ),
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    try {
      const tabsToClose = useEditorStore
        .getState()
        .tabs.filter((t) => t.path === target || t.path.startsWith(target + "/"));
      await ipc.deletePath(target);
      for (const t of tabsToClose) {
        useSession.getState().noteHotExit(t.path, null);
        closeTab(t.path);
      }
      const parent = pathLib.dirname(target);
      await refreshDir(parent).catch(() => {});
      await refresh().catch(() => {});
    } catch (e) {
      toast.error("Couldn't delete", {
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const onContextMenu = (e: React.MouseEvent, entry: FsEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    const targetDir = entry?.is_dir
      ? entry.path
      : entry
      ? pathLib.dirname(entry.path)
      : root ?? "";
    const items: MenuItem[] = [
      {
        kind: "item",
        label: "New File",
        shortcut: "N",
        icon: <FilePlus size={12} />,
        onSelect: () => beginCreate("file", targetDir),
      },
      {
        kind: "item",
        label: "New Folder",
        icon: <FolderPlus size={12} />,
        onSelect: () => beginCreate("folder", targetDir),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: treeClipboard
          ? `Paste ${treeClipboard.paths.length} item${treeClipboard.paths.length === 1 ? "" : "s"}`
          : "Paste",
        shortcut: "⌘V",
        icon: <ClipboardPaste size={12} />,
        disabled: !treeClipboard,
        onSelect: () => void pasteClipboard(targetDir),
      },
    ];
    if (entry) {
      const transferPaths = selectedOrEntryPaths(entry);
      items.push(
        { kind: "separator" },
        {
          kind: "item",
          label: transferPaths.length > 1 ? `Copy ${transferPaths.length} items` : "Copy",
          shortcut: "⌘C",
          icon: <Copy size={12} />,
          onSelect: () => setFileClipboard("copy", transferPaths),
        },
        {
          kind: "item",
          label: transferPaths.length > 1 ? `Cut ${transferPaths.length} items` : "Cut",
          shortcut: "⌘X",
          icon: <Scissors size={12} />,
          onSelect: () => setFileClipboard("move", transferPaths),
        },
        { kind: "separator" },
        {
          kind: "item",
          label: "Rename",
          shortcut: "↵",
          icon: <Edit3 size={12} />,
          onSelect: () => setRenaming(entry.path),
        },
        {
          kind: "item",
          label: "Open in Terminal",
          icon: <TerminalSquare size={12} />,
          onSelect: () => {
            const cwd = entry.is_dir
              ? entry.path
              : pathLib.dirname(entry.path);
            void openTerminalAt(cwd);
          },
        },
        {
          kind: "item",
          label: "Reveal in Finder",
          icon: <ExternalLink size={12} />,
          onSelect: () => revealInFiler(entry.path),
        },
        {
          kind: "item",
          label: "Copy Path",
          icon: <Copy size={12} />,
          onSelect: () => copyPath(entry.path),
        },
        {
          kind: "item",
          label: "Copy Relative Path",
          icon: <Copy size={12} />,
          onSelect: () => copyPath(entry.path, true),
        },
      );
      if (!entry.is_dir) {
        const otherPath = useCompareSelection.getState().selected;
        const isMarked = otherPath === entry.path;
        items.push(
          { kind: "separator" },
          {
            kind: "item",
            label: isMarked
              ? "Cancel: marked for compare"
              : "Select for Compare",
            icon: <ArrowLeftRight size={12} />,
            onSelect: () => {
              useCompareSelection
                .getState()
                .setSelected(isMarked ? null : entry.path);
              toast.info(
                isMarked
                  ? "Compare selection cleared"
                  : `Marked ${entry.name} — pick a second file to compare`,
              );
            },
          },
        );
        if (otherPath && otherPath !== entry.path) {
          items.push({
            kind: "item",
            label: "Compare with Selected",
            icon: <ArrowLeftRight size={12} />,
            onSelect: () => doCompare(otherPath, entry.path),
          });
        }
      }
      // If multiple rows are selected, the destructive ops apply to
      // the whole batch — mirrors how Finder treats right-click
      // when the clicked file is already part of the selection.
      const sel = useTreeSelection.getState().selected;
      const batch = sel.has(entry.path) && sel.size > 1 ? Array.from(sel) : null;
      items.push(
        { kind: "separator" },
        {
          kind: "item",
          label: batch ? `Delete ${batch.length} items` : "Delete",
          shortcut: "⌫",
          danger: true,
          icon: <Trash2 size={12} />,
          onSelect: () => (batch ? removeMany(batch) : remove(entry.path)),
        },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const treeTargetDirFromElement = (target: EventTarget | null): string => {
    const element = target instanceof HTMLElement ? target : null;
    const row = element?.closest("[data-tree-path]") as HTMLElement | null;
    const rowPath = row?.dataset.treePath;
    if (!rowPath) return root ?? "";
    return row.dataset.treeKind === "dir" ? rowPath : pathLib.dirname(rowPath);
  };

  const handleTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable
    ) {
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "c" || key === "x") {
      const activeRow = target?.closest("[data-tree-path]") as HTMLElement | null;
      const activePath = activeRow?.dataset.treePath;
      const selected = useTreeSelection.getState().selected;
      const paths =
        activePath && (selected.has(activePath) || selected.size === 0)
          ? selected.size > 1
            ? Array.from(selected)
            : [activePath]
          : Array.from(selected);
      if (paths.length === 0) return;
      e.preventDefault();
      setFileClipboard(key === "c" ? "copy" : "move", paths);
    } else if (key === "v") {
      if (!treeClipboard) return;
      e.preventDefault();
      void pasteClipboard(treeTargetDirFromElement(e.target));
    }
  };

  /** Batch-delete handler. One confirmation for the whole set; runs
   *  deletes sequentially so the file system sees a sane order and
   *  any failures don't strand half-deleted parents. */
  const removeMany = async (targets: string[]) => {
    const ok = await confirm({
      title: `Delete ${targets.length} items?`,
      body: (
        <div className="space-y-2">
          <p>
            Pointer will permanently remove these from disk — there is no undo
            inside the editor.
          </p>
          <ul className="text-[11px] font-mono text-noir-mute max-h-32 overflow-y-auto space-y-0.5">
            {targets.slice(0, 8).map((t) => (
              <li key={t} className="truncate">{t}</li>
            ))}
            {targets.length > 8 && (
              <li className="text-noir-subtext">… and {targets.length - 8} more</li>
            )}
          </ul>
        </div>
      ),
      confirmLabel: `Delete ${targets.length}`,
      danger: true,
    });
    if (!ok) return;
    let ok_n = 0;
    let fail_n = 0;
    const dirty = new Set<string>();
    for (const target of targets) {
      try {
        const tabsToClose = useEditorStore
          .getState()
          .tabs.filter((t) => t.path === target || t.path.startsWith(target + "/"));
        await ipc.deletePath(target);
        for (const t of tabsToClose) {
          useSession.getState().noteHotExit(t.path, null);
          closeTab(t.path);
        }
        dirty.add(pathLib.dirname(target));
        ok_n++;
      } catch (e) {
        fail_n++;
        console.warn("batch delete failed for", target, e);
      }
    }
    useTreeSelection.getState().clear();
    for (const d of dirty) await refreshDir(d).catch(() => {});
    await refresh().catch(() => {});
    if (fail_n > 0) toast.warn(`Deleted ${ok_n} · ${fail_n} failed`);
    else if (ok_n > 0) toast.success(`Deleted ${ok_n} items`);
  };

  if (!root) {
    return (
      <div className="flex-1 min-h-0 p-3 text-[11px] text-noir-mute font-sans">
        No folder open.
      </div>
    );
  }

  return (
    <div
      className="flex flex-1 min-h-0 flex-col overflow-hidden"
      onContextMenu={(e) => onContextMenu(e, null)}
    >
      <header
        className="px-3 h-8 shrink-0 flex items-center justify-between text-[10px] uppercase tracking-wider text-noir-mute font-sans border-b border-noir-line/60"
        aria-label="File tree toolbar"
      >
        <span className="truncate" title={root}>
          {rootName}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => beginCreate("file", root)}
            title="New File"
            aria-label="New file at workspace root"
            className="opacity-60 hover:opacity-100 transition-opacity p-0.5"
          >
            <FilePlus size={12} aria-hidden="true" />
          </button>
          <button
            onClick={() => beginCreate("folder", root)}
            title="New Folder"
            aria-label="New folder at workspace root"
            className="opacity-60 hover:opacity-100 transition-opacity p-0.5"
          >
            <FolderPlus size={12} aria-hidden="true" />
          </button>
          <button
            onClick={refresh}
            title="Refresh"
            aria-label="Refresh file tree"
            className="opacity-60 hover:opacity-100 transition-opacity p-0.5"
          >
            <RefreshCw size={11} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="px-2 py-1.5 shrink-0 border-b border-noir-line/60 flex items-center gap-1.5 text-[11px]">
        <Search size={10} className="text-noir-mute shrink-0" aria-hidden="true" />
        <input
          ref={filterRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          placeholder="Filter files in tree"
          aria-label="Filter files in tree"
          className="flex-1 min-w-0 bg-transparent outline-none text-[11px] placeholder:text-noir-mute"
        />
        {filter && (
          <button
            onClick={() => setFilter("")}
            className="text-noir-mute hover:text-noir-text shrink-0"
            aria-label="Clear filter"
            title="Clear filter"
          >
            <X size={10} aria-hidden="true" />
          </button>
        )}
        <button
          onClick={() => collapseAll()}
          className="text-noir-mute hover:text-noir-text shrink-0 opacity-70 hover:opacity-100 transition-opacity"
          title="Collapse all folders"
          aria-label="Collapse all folders"
        >
          <ChevronsDownUp size={11} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={scrollerRef}
        role="tree"
        aria-label="Files"
        className="flex-1 min-h-0 overflow-y-auto py-1.5 text-[12px]"
        onKeyDown={handleTreeKeyDown}
        onDragOver={(e) => {
          if ((e.target as HTMLElement | null)?.closest("[data-tree-path]")) return;
          if (e.dataTransfer.types.includes("text/pointer-tab")) return;
          if (!e.dataTransfer.types.includes("application/x-pointer-paths")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = e.altKey || e.metaKey ? "copy" : "move";
        }}
        onDrop={(e) => {
          if ((e.target as HTMLElement | null)?.closest("[data-tree-path]")) return;
          if (e.dataTransfer.types.includes("text/pointer-tab")) return;
          const raw = e.dataTransfer.getData("application/x-pointer-paths");
          if (!raw || !root) return;
          try {
            const sources = JSON.parse(raw) as string[];
            if (Array.isArray(sources) && sources.length > 0) {
              e.preventDefault();
              void transferFiles(
                sources,
                root,
                e.altKey || e.metaKey ? "copy" : "move",
              );
            }
          } catch {
            /* malformed payload — ignore */
          }
        }}
        onClick={(e) => {
          // Click on the empty scroller (not a child row) collapses
          // the selection — same as Finder / Explorer behaviour.
          if (e.target === e.currentTarget) {
            useTreeSelection.getState().clear();
          }
        }}
      >
        {pending?.parentDir === root && (
          <InlineCreate
            depth={0}
            kind={pending.kind}
            onCancel={() => setPending(null)}
            onSubmit={submitCreate}
          />
        )}
        {sortEntries(entries, treeSort).map((e) => (
          <TreeNode
            key={e.path}
            entry={e}
            depth={0}
            expanded={expanded}
            childrenCache={childrenCache}
            onToggle={toggle}
            onOpenFile={openFile}
            onContextMenu={onContextMenu}
            beginRename={setRenaming}
            deleteSelection={(path) => {
              const sel = useTreeSelection.getState().selected;
              if (sel.has(path) && sel.size > 1) void removeMany(Array.from(sel));
              else void remove(path);
            }}
            renaming={renaming}
            submitRename={submitRename}
            cancelRename={() => setRenaming(null)}
            pending={pending}
            cancelCreate={() => setPending(null)}
            submitCreate={submitCreate}
            filter={filterLower}
            matchPath={matchPath}
            sortMode={treeSort}
            visibleOrder={visibleOrder}
            clipboard={treeClipboard}
            onTransferFiles={transferFiles}
            activePath={activePath}
          />
        ))}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function TreeNode({
  entry,
  depth,
  expanded,
  childrenCache,
  onToggle,
  onOpenFile,
  onContextMenu,
  beginRename,
  deleteSelection,
  renaming,
  submitRename,
  cancelRename,
  pending,
  cancelCreate,
  submitCreate,
  filter,
  matchPath,
  sortMode,
  visibleOrder,
  clipboard,
  onTransferFiles,
  activePath,
}: {
  entry: FsEntry;
  depth: number;
  expanded: Set<string>;
  childrenCache: Record<string, FsEntry[]>;
  onToggle: (p: string) => void;
  onOpenFile: (p: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry | null) => void;
  beginRename: (path: string) => void;
  deleteSelection: (path: string) => void;
  renaming: string | null;
  submitRename: (oldPath: string, newName: string) => void;
  cancelRename: () => void;
  pending: Pending | null;
  cancelCreate: () => void;
  submitCreate: (name: string) => void;
  filter: string;
  matchPath: (p: string) => boolean;
  sortMode: "type" | "name";
  /** Flat list of every visible row's path, in DOM order. Lets
   *  Shift-click compute a range without needing tree shape. */
  visibleOrder: string[];
  clipboard: TreeClipboard | null;
  /** Drop handler — invoked when files are dragged onto this row.
   *  We delegate to the FileTree parent so it can refresh the
   *  workspace once transfers complete. */
  onTransferFiles: (
    sources: string[],
    target: string,
    mode: TransferMode,
  ) => Promise<{ changed: number; failed: number }>;
  activePath: string | null;
}) {
  const isOpen = expanded.has(entry.path);
  const children = childrenCache[entry.path];
  const isRenaming = renaming === entry.path;
  // Visibility rule when a filter is active:
  //   • files: shown if their basename matches the filter
  //   • directories: shown if any descendant matches OR the dir
  //     itself matches. With no filter (empty string), everything
  //     is visible. We compute this with a cheap recursive walk
  //     over the in-memory children cache so we don't rescan disk.
  //
  // We only have the children of EXPANDED directories in the cache,
  // which means under-collapsed dirs are visible "as themselves" —
  // expanding them lets the filter recurse into their freshly
  // loaded subtree. This keeps the filter incremental and works
  // for any tree size without prefetching.
  const matchesSelf = matchPath(entry.path);
  const anyDescendantMatches = (kids?: FsEntry[]): boolean => {
    if (!kids) return false;
    for (const k of kids) {
      if (matchPath(k.path)) return true;
      if (k.is_dir && anyDescendantMatches(childrenCache[k.path])) return true;
    }
    return false;
  };
  const visible = !filter || matchesSelf || (entry.is_dir && anyDescendantMatches(children));
  // Subscribe to git status here so file rows and folder rows repaint when
  // their own status changes. Files use the direct git path lookup; folders
  // roll up every dirty descendant, including deleted files that no longer
  // exist in the current tree.
  const gitStatus = useGit((s) =>
    entry.is_dir ? null : s.statusFor(entry.path),
  );
  const gitWorkspace = useGit((s) => s.workspace);
  const gitIsRepo = useGit((s) => s.status.is_repo);
  const gitFiles = useGit((s) => s.status.files);
  const folderGitStatus = React.useMemo(
    () => {
      if (!entry.is_dir || !gitWorkspace || !gitIsRepo) return null;
      const rel = relativeGitPath(gitWorkspace, entry.path);
      return rel == null ? null : aggregateFolderStatus(gitFiles, rel);
    },
    [entry.is_dir, entry.path, gitWorkspace, gitIsRepo, gitFiles],
  );
  const gitTone = gitStatus ?? folderGitStatus?.dominant ?? null;
  // Lint marker counts so we can dot the row red / amber for files
  // that have problems. We select PRIMITIVES out of the store —
  // `countsForPath` allocates a fresh object on every call, which
  // would tell `useSyncExternalStore` the snapshot changed on every
  // render and infinite-loop the component. Pulling the two numbers
  // separately lets Zustand's referential equality short-circuit
  // re-renders for unrelated diagnostic changes.
  const lintErrors = useDiagnostics((s) =>
    entry.is_dir ? 0 : s.countsForPath(entry.path).errors,
  );
  const lintWarnings = useDiagnostics((s) =>
    entry.is_dir ? 0 : s.countsForPath(entry.path).warnings,
  );
  const lintCounts = entry.is_dir
    ? null
    : { errors: lintErrors, warnings: lintWarnings };
  // Subscribe to multi-select so the row repaints when its own
  // selection state changes; the boolean-derived selector
  // (single-prop comparison) keeps unrelated rows from re-rendering.
  const isSelected = useTreeSelection((s) => s.selected.has(entry.path));
  const isActiveFile = !entry.is_dir && activePath === entry.path;
  const selectionSize = useTreeSelection((s) => s.selected.size);
  const isCut = clipboard?.mode === "move" && clipboard.paths.includes(entry.path);
  const [dragOver, setDragOver] = React.useState(false);
  const focusVisible = (offset: number) => {
    const idx = visibleOrder.indexOf(entry.path);
    if (idx < 0) return;
    const next = visibleOrder[idx + offset];
    if (next) focusTreeRow(next);
  };
  const focusParent = () => {
    const parent = pathLib.dirname(entry.path);
    if (parent && parent !== "." && visibleOrder.includes(parent)) {
      focusTreeRow(parent);
    }
  };
  const primaryAction = () => {
    useTreeSelection.getState().set([entry.path], entry.path);
    if (entry.is_dir) onToggle(entry.path);
    else Promise.resolve(onOpenFile(entry.path)).catch(() => {});
  };
  if (!visible) return null;

  return (
    <div>
      {isRenaming ? (
        <InlineInput
          depth={depth}
          initial={entry.name}
          icon={
            entry.is_dir ? (
              <FolderOpen size={12} className="text-noir-warn shrink-0" />
            ) : (
              <FileIconFor name={entry.name} className="shrink-0" />
            )
          }
          onCancel={cancelRename}
          onSubmit={(v) => submitRename(entry.path, v)}
        />
      ) : (
        <button
          data-tree-path={entry.path}
          data-tree-kind={entry.is_dir ? "dir" : "file"}
          data-active-file={isActiveFile ? "true" : undefined}
          data-git-status={gitTone ?? undefined}
          role="treeitem"
          aria-expanded={entry.is_dir ? isOpen : undefined}
          aria-level={depth + 1}
          aria-selected={isSelected || undefined}
          aria-current={isActiveFile ? "page" : undefined}
          draggable
          onDragStart={(e) => {
            // If the dragged row is part of the selection we move
            // the whole set; otherwise just this row.
            const sel = useTreeSelection.getState();
            const sources = sel.selected.has(entry.path)
              ? Array.from(sel.selected)
              : [entry.path];
            e.dataTransfer.setData(
              "application/x-pointer-paths",
              JSON.stringify(sources),
            );
            e.dataTransfer.setData("text/plain", sources.join("\n"));
            e.dataTransfer.effectAllowed = "copyMove";
          }}
          onDragOver={(e) => {
            // Only directories accept drops. Files would just route
            // to their parent which is confusing — better to require
            // an explicit folder target.
            if (!entry.is_dir) return;
            if (e.dataTransfer.types.includes("text/pointer-tab")) return;
            if (!e.dataTransfer.types.includes("application/x-pointer-paths"))
              return;
            e.preventDefault();
            e.dataTransfer.dropEffect = e.altKey || e.metaKey ? "copy" : "move";
            if (!dragOver) setDragOver(true);
          }}
          onDragLeave={() => dragOver && setDragOver(false)}
          onDrop={(e) => {
            setDragOver(false);
            if (!entry.is_dir) return;
            if (e.dataTransfer.types.includes("text/pointer-tab")) return;
            const raw = e.dataTransfer.getData("application/x-pointer-paths");
            if (!raw) return;
            try {
              const sources = JSON.parse(raw) as string[];
              if (Array.isArray(sources) && sources.length > 0) {
                e.preventDefault();
                void onTransferFiles(
                  sources,
                  entry.path,
                  e.altKey || e.metaKey ? "copy" : "move",
                );
              }
            } catch {
              /* malformed payload — ignore */
            }
          }}
          onClick={(e) => {
            const sel = useTreeSelection.getState();
            if (e.shiftKey) {
              // Shift-click: extend the selection from the anchor.
              e.preventDefault();
              sel.range(entry.path, visibleOrder);
              return;
            }
            const cmd = e.metaKey || e.ctrlKey;
            if (cmd) {
              // Cmd/Ctrl-click toggles this row independently —
              // doesn't affect activation.
              e.preventDefault();
              sel.toggle(entry.path);
              return;
            }
            // Plain click — collapse selection to just this row and
            // perform the row's primary action.
            primaryAction();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              focusVisible(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              focusVisible(-1);
            } else if (e.key === "ArrowRight") {
              if (!entry.is_dir) return;
              e.preventDefault();
              if (!isOpen) onToggle(entry.path);
              else focusVisible(1);
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              if (entry.is_dir && isOpen) onToggle(entry.path);
              else focusParent();
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              primaryAction();
            } else if (e.key === "F2") {
              e.preventDefault();
              beginRename(entry.path);
            } else if (e.key === "Delete" || e.key === "Backspace") {
              e.preventDefault();
              deleteSelection(entry.path);
            }
          }}
          onContextMenu={(e) => {
            // Keep the row's selection state intact when right-
            // clicking — that's how every desktop tree works. Only
            // collapse to single-row selection if the row isn't
            // already in the set.
            const sel = useTreeSelection.getState();
            if (!sel.selected.has(entry.path)) {
              sel.set([entry.path], entry.path);
            }
            onContextMenu(e, entry);
          }}
          title={
            selectionSize > 1 && isSelected
              ? `${selectionSize} selected`
              : buildEntryTooltip(entry)
          }
          className={`w-full flex items-center gap-1 px-2 py-[3px] hover:bg-noir-ridge/60 text-noir-text rounded-[3px] mx-1 font-mono ${
            isActiveFile ? "pn-tree-active-file" : isSelected ? "bg-noir-accent/15" : ""
          } ${dragOver ? "ring-1 ring-noir-accent/60" : ""} ${isCut ? "opacity-55" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {entry.is_dir ? (
            isOpen ? (
              <ChevronDown
                size={10}
                aria-hidden="true"
                className="text-noir-mute shrink-0"
              />
            ) : (
              <ChevronRight
                size={10}
                aria-hidden="true"
                className="text-noir-mute shrink-0"
              />
            )
          ) : (
            <span className="w-[10px] shrink-0" aria-hidden="true" />
          )}
          {entry.is_dir ? (
            isOpen ? (
              <FolderOpen
                size={12}
                aria-hidden="true"
                className={`shrink-0 ${
                  folderGitStatus ? gitStatusColor(folderGitStatus.dominant) : "text-noir-warn"
                }`}
              />
            ) : (
              <Folder
                size={12}
                aria-hidden="true"
                className={`shrink-0 ${
                  folderGitStatus
                    ? gitStatusColor(folderGitStatus.dominant)
                    : "text-noir-subtext"
                }`}
              />
            )
          ) : (
            <FileIconFor name={entry.name} className="shrink-0" aria-hidden="true" />
          )}
          <span
            className={`truncate ${gitStatusNameClass(gitTone, { isFolder: entry.is_dir })}`}
          >
            {entry.name}
          </span>
          {lintCounts && (lintCounts.errors > 0 || lintCounts.warnings > 0) && (
            <span
              className={`ml-auto text-[9.5px] font-medium tabular-nums shrink-0 ${
                lintCounts.errors > 0 ? "text-noir-err" : "text-amber-400"
              }`}
              title={`${lintCounts.errors} error${
                lintCounts.errors === 1 ? "" : "s"
              }, ${lintCounts.warnings} warning${
                lintCounts.warnings === 1 ? "" : "s"
              }`}
            >
              {lintCounts.errors > 0 ? lintCounts.errors : lintCounts.warnings}
            </span>
          )}
          {gitStatus && gitStatus !== "ignored" && (
            <span
              className={`${
                lintCounts && (lintCounts.errors > 0 || lintCounts.warnings > 0)
                  ? ""
                  : "ml-auto"
              } text-[10px] font-medium tabular-nums shrink-0 ${gitStatusColor(gitStatus)}`}
              title={`Git: ${gitStatus}`}
            >
              {gitStatusLetter(gitStatus)}
            </span>
          )}
          {!gitStatus && folderGitStatus && (
            <FolderGitBadges summary={folderGitStatus} />
          )}
        </button>
      )}
      {entry.is_dir && isOpen && (
        <div>
          {pending?.parentDir === entry.path && (
            <InlineCreate
              depth={depth + 1}
              kind={pending.kind}
              onCancel={cancelCreate}
              onSubmit={submitCreate}
            />
          )}
          {(children ? sortEntries(children, sortMode) : []).map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              depth={depth + 1}
              expanded={expanded}
              childrenCache={childrenCache}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
              beginRename={beginRename}
              deleteSelection={deleteSelection}
              renaming={renaming}
              submitRename={submitRename}
              cancelRename={cancelRename}
              pending={pending}
              cancelCreate={cancelCreate}
              submitCreate={submitCreate}
              filter={filter}
              matchPath={matchPath}
              sortMode={sortMode}
              visibleOrder={visibleOrder}
              clipboard={clipboard}
              onTransferFiles={onTransferFiles}
              activePath={activePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderGitBadges({ summary }: { summary: GitFolderStatusSummary }) {
  const visible = summary.statuses.filter((status) => status !== "ignored").slice(0, 4);
  const hidden = summary.statuses.filter((status) => status !== "ignored").length - visible.length;
  if (visible.length === 0) return null;
  return (
    <span
      className="ml-auto flex items-center gap-0.5 shrink-0"
      title={gitFolderStatusTitle(summary)}
      aria-label={gitFolderStatusTitle(summary)}
    >
      {visible.map((status) => {
        const count = summary.counts[status] ?? 0;
        return (
          <span
            key={status}
            className={`text-[9.5px] font-medium tabular-nums ${gitStatusColor(status)}`}
          >
            {gitStatusLetter(status)}
            {count > 1 ? count : ""}
          </span>
        );
      })}
      {hidden > 0 && (
        <span className="text-[9.5px] font-medium tabular-nums text-noir-mute">
          +{hidden}
        </span>
      )}
    </span>
  );
}

function relativeGitPath(workspace: string, absolutePath: string): string | null {
  const ws = normalizeAbs(workspace);
  const abs = normalizeAbs(absolutePath);
  if (!ws) return null;
  if (abs === ws) return "";
  const prefix = ws.endsWith("/") ? ws : `${ws}/`;
  if (!abs.startsWith(prefix)) return null;
  return abs.slice(prefix.length).replace(/^\/+/, "");
}

function normalizeAbs(path: string): string {
  const normal = path.replace(/\\/g, "/");
  if (normal === "/") return normal;
  return normal.replace(/\/+$/, "");
}

function InlineCreate({
  depth,
  kind,
  onCancel,
  onSubmit,
}: {
  depth: number;
  kind: "file" | "folder";
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  return (
    <InlineInput
      depth={depth}
      initial=""
      placeholder={kind === "file" ? "new-file.ts" : "new-folder"}
      icon={
        kind === "folder" ? (
          <FolderPlus size={12} className="text-noir-accent shrink-0" />
        ) : (
          <FilePlus size={12} className="text-noir-accent shrink-0" />
        )
      }
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

function InlineInput({
  depth,
  initial,
  placeholder,
  icon,
  onCancel,
  onSubmit,
}: {
  depth: number;
  initial: string;
  placeholder?: string;
  icon: React.ReactNode;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  return (
    <div
      className="w-full flex items-center gap-1 px-2 py-[2px] mx-1 font-mono rounded-[3px] bg-noir-ridge/40 border border-noir-accent/40"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="w-[10px] shrink-0" />
      {icon}
      <input
        ref={inputRef}
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value.trim()) onSubmit(value);
          else onCancel();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(value);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="flex-1 bg-transparent text-[12px] text-noir-text outline-none placeholder-noir-mute font-mono"
      />
    </div>
  );
}
