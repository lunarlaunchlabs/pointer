import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Copy,
  Edit3,
  ExternalLink,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Search,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useRef } from "react";
import { useWorkspace } from "@/store/workspace";
import { useEditorStore } from "@/store/editor";
import { useGit, gitStatusColor, gitStatusLetter } from "@/store/git";
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

/** Tiny CSS.escape polyfill — Tauri targets recent webkit which has it
 *  natively, but typing falls back here for older platforms or test envs. */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && (CSS as { escape?: (s: string) => string }).escape) {
    return (CSS as { escape: (s: string) => string }).escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
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

  // Cross-component tree actions. Dispatched via the global action bus
  // by App.tsx so commands and menu items don't have to know about this
  // component's internal state.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const ce = e as CustomEvent<{ path: string }>;
      const p = ce.detail?.path;
      if (!p) return;
      expandTo(p).then(() => {
        // Scroll the matching row into view after the next paint.
        requestAnimationFrame(() => {
          const root = scrollerRef.current;
          if (!root) return;
          const row = root.querySelector(
            `[data-tree-path="${cssEscape(p)}"]`,
          ) as HTMLElement | null;
          row?.scrollIntoView({ block: "center" });
          row?.classList.add("pn-flash");
          setTimeout(() => row?.classList.remove("pn-flash"), 900);
        });
      });
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
  }, [collapseAll, expandTo]);

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
      console.warn("create failed", e);
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
      // Editor: rename open tab paths transparently.
      const tabs = useEditorStore.getState().tabs;
      for (const t of tabs) {
        if (t.path === oldPath || t.path.startsWith(oldPath + "/")) {
          closeTab(t.path);
          await openFile(t.path.replace(oldPath, newPath));
        }
      }
      await refreshDir(parent).catch(() => {});
      await refresh().catch(() => {});
    } catch (e) {
      console.warn("rename failed", e);
    }
  };

  /** Move a batch of source paths into `targetDir`. Skips no-ops
   *  (already in that directory). Asks for confirmation when more
   *  than 5 files are involved so accidental drags don't silently
   *  reorganize half the project. */
  const moveFiles = async (sources: string[], targetDir: string) => {
    const valid = sources.filter((src) => {
      if (src === targetDir) return false;
      if (targetDir.startsWith(src + "/")) return false; // can't move into self
      const parent = pathLib.dirname(src);
      return parent !== targetDir;
    });
    if (valid.length === 0) return;
    if (valid.length > 5) {
      const ok = await confirm({
        title: `Move ${valid.length} items into ${pathLib.basename(targetDir)}?`,
        body: "Drag-to-move applies the rename to every selected item.",
        confirmLabel: "Move",
      });
      if (!ok) return;
    }
    let moved = 0;
    let failed = 0;
    for (const src of valid) {
      const name = src.split(/[\\/]/).pop() ?? src;
      const dest = `${targetDir}/${name}`;
      try {
        await ipc.renamePath(src, dest);
        // Rewrite any open tabs that referenced the old path so the
        // editor doesn't break when you save next.
        useEditorStore.setState((s) => ({
          tabs: s.tabs.map((t) =>
            t.path === src
              ? { ...t, path: dest, name }
              : t.path.startsWith(src + "/")
              ? { ...t, path: dest + t.path.slice(src.length) }
              : t,
          ),
          activePath: s.activePath === src ? dest : s.activePath,
        }));
        moved++;
      } catch (e) {
        failed++;
        console.warn("move failed", src, "→", dest, e);
      }
    }
    useTreeSelection.getState().clear();
    await refreshDir(targetDir).catch(() => {});
    await refresh().catch(() => {});
    if (failed > 0) {
      toast.warn(`Moved ${moved} · ${failed} failed`);
    } else if (moved > 0) {
      toast.success(`Moved ${moved} item${moved === 1 ? "" : "s"}`);
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
      const tabs = useEditorStore.getState().tabs;
      for (const t of tabs) {
        if (t.path === target || t.path.startsWith(target + "/")) {
          closeTab(t.path);
        }
      }
      await ipc.deletePath(target);
      const parent = pathLib.dirname(target);
      await refreshDir(parent).catch(() => {});
      await refresh().catch(() => {});
    } catch (e) {
      console.warn("delete failed", e);
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
    ];
    if (entry) {
      items.push(
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
        const tabs = useEditorStore.getState().tabs;
        for (const t of tabs) {
          if (t.path === target || t.path.startsWith(target + "/")) {
            closeTab(t.path);
          }
        }
        await ipc.deletePath(target);
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
      <div className="p-3 text-[11px] text-noir-mute font-sans">
        No folder open.
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full"
      onContextMenu={(e) => onContextMenu(e, null)}
    >
      <header
        className="px-3 h-8 flex items-center justify-between text-[10px] uppercase tracking-wider text-noir-mute font-sans border-b border-noir-line/60"
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
      <div className="px-2 py-1.5 border-b border-noir-line/60 flex items-center gap-1.5 text-[11px]">
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
        className="flex-1 overflow-y-auto py-1.5 text-[12px]"
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
            onMoveFiles={moveFiles}
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
  onMoveFiles,
}: {
  entry: FsEntry;
  depth: number;
  expanded: Set<string>;
  childrenCache: Record<string, FsEntry[]>;
  onToggle: (p: string) => void;
  onOpenFile: (p: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry | null) => void;
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
  /** Drop handler — invoked when files are dragged onto this row.
   *  We delegate to the FileTree parent so it can refresh the
   *  workspace once moves complete. */
  onMoveFiles: (sources: string[], target: string) => void;
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
  if (!visible) return null;
  // Subscribe to git status here so each row re-renders only when its own
  // status changes (well, when the whole map changes — but the dot lookup
  // is O(1) and React reconciliation handles the rest). Directories don't
  // currently show a roll-up; that's a follow-up worth adding once we have
  // a real SCM panel.
  const gitStatus = useGit((s) =>
    entry.is_dir ? null : s.statusFor(entry.path),
  );
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
  const selectionSize = useTreeSelection((s) => s.selected.size);
  const [dragOver, setDragOver] = React.useState(false);

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
          role="treeitem"
          aria-expanded={entry.is_dir ? isOpen : undefined}
          aria-level={depth + 1}
          aria-selected={isSelected || undefined}
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
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            // Only directories accept drops. Files would just route
            // to their parent which is confusing — better to require
            // an explicit folder target.
            if (!entry.is_dir) return;
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
            const raw = e.dataTransfer.getData("application/x-pointer-paths");
            if (!raw) return;
            try {
              const sources = JSON.parse(raw) as string[];
              if (Array.isArray(sources) && sources.length > 0) {
                e.preventDefault();
                onMoveFiles(sources, entry.path);
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
            sel.set([entry.path], entry.path);
            if (entry.is_dir) onToggle(entry.path);
            else {
              // `openFile` is async and surfaces its own toast on
              // failure; we just need to swallow the resulting
              // rejection so it doesn't become an unhandled
              // promise (and so a transient read error doesn't
              // log a noisy console error on every click).
              Promise.resolve(onOpenFile(entry.path)).catch(() => {});
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
            isSelected ? "bg-noir-accent/15" : ""
          } ${dragOver ? "ring-1 ring-noir-accent/60" : ""}`}
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
                className="text-noir-warn shrink-0"
              />
            ) : (
              <Folder
                size={12}
                aria-hidden="true"
                className="text-noir-subtext shrink-0"
              />
            )
          ) : (
            <FileIconFor name={entry.name} className="shrink-0" aria-hidden="true" />
          )}
          <span
            className={`truncate ${
              gitStatus === "untracked"
                ? "text-noir-accent/90"
                : gitStatus === "deleted"
                ? "text-noir-mute line-through"
                : gitStatus
                ? "text-noir-text"
                : "text-noir-text"
            }`}
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
              onMoveFiles={onMoveFiles}
            />
          ))}
        </div>
      )}
    </div>
  );
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
  return (
    <div
      className="w-full flex items-center gap-1 px-2 py-[2px] mx-1 font-mono rounded-[3px] bg-noir-ridge/40 border border-noir-accent/40"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="w-[10px] shrink-0" />
      {icon}
      <input
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
