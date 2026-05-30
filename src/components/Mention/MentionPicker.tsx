/**
 * Mention picker — the Cursor-style categorised autocomplete that pops
 * up when the user types `@` in a chat / agent input.
 *
 * Responsibilities split:
 *   • This component renders the popover, owns keyboard navigation,
 *     and turns a selection into a `Reference` via the onPick callback.
 *   • The data layer is the consumer's job: the host passes us a
 *     `query`, a precomputed list of file / codebase / diagnostic
 *     candidates, and we just render them. That keeps the picker
 *     unit-testable in isolation and free of IPC noise.
 */

import { useEffect, useMemo, useRef, useState } from "@/lib/preactSignalCompat";
import {
  AlertCircle,
  Code2,
  CircleDot,
  FileText,
  Folder,
  Search,
  ScrollText,
  Sparkles,
} from "@/lib/lucide";
import {
  CATEGORY_REGISTRY,
  intentFromQuery,
  type MentionCategory,
} from "@/lib/mentions";
import type { Reference } from "@/store/chat";
import type { Diagnostic } from "@/store/diagnostics";
import { FileIconFor } from "@/lib/fileIcon";
import { Popover } from "@/components/Popover";
import { rankFileCandidates } from "@/lib/mentionRanker";
import { useRecentEdits } from "@/store/recentEdits";
import { useEditorStore } from "@/store/editor";
import { useDebuggerStore, type Breakpoint, type DebugValue } from "@/store/debugger";
import { useWorkspace } from "@/store/workspace";

export type MentionSelection =
  | { kind: "category"; category: MentionCategory; remainder: string }
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "selection" }
  | { kind: "breakpoint"; breakpoint: Breakpoint }
  | { kind: "debugValue"; value: DebugValue }
  | { kind: "diagnostic"; diagnostic: Diagnostic }
  | { kind: "codebase"; query: string };

export type MentionPickerProps = {
  /** Anchor element the popover glues to — typically the composer
   *  textarea. The Popover uses this ref to measure placement and to
   *  decide whether outside-clicks should close the picker (a click
   *  on the anchor itself is treated as "still inside"). */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Query the user has typed after the `@`. */
  query: string;
  fileCandidates: { path: string }[];
  /** Directory candidates surfaced when the user is in @folder mode.
   *  Defaults to empty when the host hasn't wired a folder backend. */
  folderCandidates?: { path: string }[];
  diagnostics: Diagnostic[];
  /** Whether a non-empty editor selection currently exists. */
  hasSelection: boolean;
  /** Whether the `@codebase` row is operational (toggle on + indexable). */
  codebaseUsable: boolean;
  /** Already-attached references — used to dim duplicates. */
  attached: Reference[];
  onPick: (selection: MentionSelection) => void;
  onClose: () => void;
  /** Preferred placement. `"auto"` flips between `"up"` and `"down"`
   *  based on the available viewport space; `"up"` / `"down"` lock it. */
  placement?: "up" | "down" | "auto";
};

type Row =
  | {
      key: string;
      kind: "category";
      category: MentionCategory;
      label: string;
      description: string;
      icon: React.ReactNode;
      disabled?: boolean;
      disabledReason?: string;
    }
  | {
      key: string;
      kind: "file";
      path: string;
    }
  | {
      key: string;
      kind: "folder";
      path: string;
    }
  | {
      key: string;
      kind: "selection";
    }
  | {
      key: string;
      kind: "breakpoint";
      breakpoint: Breakpoint;
    }
  | {
      key: string;
      kind: "debugValue";
      value: DebugValue;
    }
  | {
      key: string;
      kind: "diagnostic";
      diagnostic: Diagnostic;
    }
  | {
      key: string;
      kind: "codebase";
      query: string;
    };

const ICONS: Record<MentionCategory, React.ReactNode> = {
  file: <FileText size={11} />,
  folder: <Folder size={11} />,
  selection: <ScrollText size={11} />,
  codebase: <Search size={11} />,
  diagnostic: <AlertCircle size={11} />,
  breakpoint: <CircleDot size={11} />,
  debug: <Code2 size={11} />,
  symbol: <Code2 size={11} />,
};

export function MentionPicker({
  anchorRef,
  query,
  fileCandidates,
  folderCandidates = [],
  diagnostics,
  hasSelection,
  codebaseUsable,
  attached,
  onPick,
  onClose,
  placement = "auto",
}: MentionPickerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);
  // Recents + currently open tabs feed the candidate ranker. We
  // subscribe at component scope so the picker re-ranks live as the
  // user pulls up new files in adjacent tabs without re-typing.
  const recentEntries = useRecentEdits((s) => s.entries);
  const openTabs = useEditorStore((s) => s.tabs);
  const workspaceRoot = useWorkspace((s) => s.root);
  const recentPaths = useMemo(
    () => recentEntries.map((e) => ({ path: e.path })),
    [recentEntries],
  );
  const openTabPaths = useMemo(
    () => openTabs.map((t) => ({ path: t.path })),
    [openTabs],
  );
  const breakpoints = useDebuggerStore((s) => s.breakpoints);
  const debugValues = useDebuggerStore((s) => s.values);

  // Decide which rows to show. The query has two modes:
  //   • Empty / generic: show *all* categories (the menu state).
  //   • Category-targeted ("@codebase X", "@sel"): show that category's
  //     rows only, optionally with the remainder forwarded as the
  //     real query for file / codebase searches.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const { category, remainder } = intentFromQuery(query);

    // Headers are noise once the user is typing a real query — even if
    // they haven't picked a specific category alias. We show the
    // category overview only when the query is empty (`@<caret>`).
    const includeCategoryHeaders = category === null && query.trim() === "";

    // Top-level categories (only when no explicit intent).
    if (includeCategoryHeaders) {
      for (const r of CATEGORY_REGISTRY) {
        const disabled =
          (r.category === "selection" && !hasSelection) ||
          (r.category === "codebase" && !codebaseUsable);
        const disabledReason = disabled
          ? r.category === "selection"
            ? "Select text in the editor first."
            : "Indexing isn't ready — start Ollama and pick an embed model."
          : undefined;
        out.push({
          key: `cat:${r.category}`,
          kind: "category",
          category: r.category,
          label: r.label,
          description: r.description,
          icon: ICONS[r.category],
          disabled,
          disabledReason,
        });
      }
    }

    // Selection — surfaced both as a category and as its own row when
    // the user is explicitly asking for it.
    if (
      hasSelection &&
      (category === "selection" || (includeCategoryHeaders && !query))
    ) {
      // Already covered by the category row above; we don't double up.
    }

    // Files — the most common mention by far, so we always include
    // matches when the user is typing a filename-ish thing.
    // We rank by recency + open-tab signal + match quality (basename
    // prefix, camelcase initials, etc.) instead of naive substring
    // slicing. That makes the picker feel "intelligent" in the
    // exact way the user requested: it knows what files matter.
    if (category === null || category === "file") {
      const filteredFiles = rankFileCandidates({
        candidates: fileCandidates,
        query: remainder,
        recents: recentPaths,
        openTabs: openTabPaths,
      });
      for (const f of filteredFiles) {
        out.push({ key: `file:${f.path}`, kind: "file", path: f.path });
      }
    }

    // Folders — only when explicitly requested. Same ranker (the
    // recency / open-tab signals also apply to directories
    // through the open tabs' parent dirs).
    if (category === "folder") {
      const filtered = rankFileCandidates({
        candidates: folderCandidates,
        query: remainder,
        recents: recentPaths.map((r) => ({ path: dirname(r.path) })),
        openTabs: openTabPaths.map((t) => ({ path: dirname(t.path) })),
      });
      for (const f of filtered) {
        out.push({ key: `folder:${f.path}`, kind: "folder", path: f.path });
      }
    }

    // Diagnostics — only when explicitly asked (otherwise this category
    // would dominate noisy projects).
    if (category === "diagnostic") {
      const filteredDiags = diagnostics
        .filter((d) => {
          if (!remainder) return true;
          const needle = remainder.toLowerCase();
          return (
            d.message.toLowerCase().includes(needle) ||
            d.name.toLowerCase().includes(needle) ||
            (d.code ?? "").toLowerCase().includes(needle)
          );
        })
        .slice(0, 8);
      for (const d of filteredDiags) {
        out.push({
          key: `diag:${d.uri}:${d.startLine}:${d.startCol}:${d.code ?? ""}`,
          kind: "diagnostic",
          diagnostic: d,
        });
      }
    }

    if (category === "breakpoint") {
      const needle = remainder.toLowerCase();
      const filtered = breakpoints
        .filter((bp) => {
          if (!needle) return true;
          return (
            bp.path.toLowerCase().includes(needle) ||
            `l${bp.line}`.includes(needle) ||
            String(bp.line).includes(needle) ||
            (bp.condition ?? "").toLowerCase().includes(needle)
          );
        })
        .slice(0, 12);
      for (const bp of filtered) {
        out.push({ key: `bp:${bp.id}`, kind: "breakpoint", breakpoint: bp });
      }
    }

    if (category === "debug") {
      const needle = remainder.toLowerCase();
      const filtered = debugValues
        .filter((value) => {
          if (!needle) return true;
          return (
            value.name.toLowerCase().includes(needle) ||
            value.value.toLowerCase().includes(needle) ||
            (value.type ?? "").toLowerCase().includes(needle)
          );
        })
        .slice(0, 12);
      for (const value of filtered) {
        out.push({ key: `dbg:${value.id}`, kind: "debugValue", value });
      }
    }

    // Codebase — when explicitly asked, surface a "search for this"
    // row that, when picked, attaches a `@codebase: …` reference.
    if (category === "codebase" && codebaseUsable) {
      out.push({
        key: `code:${remainder}`,
        kind: "codebase",
        query: remainder,
      });
    }

    // Selection — always exposed when category-targeted and available.
    if (category === "selection" && hasSelection) {
      out.push({ key: "sel", kind: "selection" });
    }

    return out;
  }, [
    query,
    fileCandidates,
    folderCandidates,
    diagnostics,
    breakpoints,
    debugValues,
    hasSelection,
    codebaseUsable,
    recentPaths,
    openTabPaths,
  ]);

  // Reset active index whenever the row list changes shape — we don't
  // want the highlighted row to jump to a stale index after the user
  // narrows the query.
  useEffect(() => {
    setActive(0);
  }, [rows.length]);

  // Global keyboard handler — works whether the picker has focus or
  // (more likely) the textarea below it does. We swallow Up/Down/Enter
  // so the textarea doesn't also move the caret or insert a newline.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const target = e.target instanceof Node ? e.target : null;
      const anchor = anchorRef.current;
      const container = containerRef.current;
      if (
        target &&
        anchor &&
        target !== anchor &&
        !container?.contains(target)
      ) {
        return;
      }
      if (rows.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % rows.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + rows.length) % rows.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const row = rows[active];
        if (row) commit(row);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rows, active, onClose]);

  // Scroll the active row into view whenever it moves.
  useEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-mention-index="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const commit = (row: Row) => {
    if (row.kind === "category") {
      if (row.disabled) return;
      onPick({
        kind: "category",
        category: row.category,
        remainder: intentFromQuery(query).remainder,
      });
      return;
    }
    if (row.kind === "file") onPick({ kind: "file", path: row.path });
    if (row.kind === "folder") onPick({ kind: "folder", path: row.path });
    if (row.kind === "selection") onPick({ kind: "selection" });
    if (row.kind === "breakpoint")
      onPick({ kind: "breakpoint", breakpoint: row.breakpoint });
    if (row.kind === "debugValue")
      onPick({ kind: "debugValue", value: row.value });
    if (row.kind === "diagnostic")
      onPick({ kind: "diagnostic", diagnostic: row.diagnostic });
    if (row.kind === "codebase")
      onPick({ kind: "codebase", query: row.query });
  };

  if (rows.length === 0) {
    return (
      <Popover
        anchorRef={anchorRef}
        open
        onClose={onClose}
        placement={placement}
        align="match"
        layer="panel-popover"
        ariaLabel="Mention picker"
        role="status"
        maxHeight={64}
      >
        <div
          ref={containerRef}
          className="px-3 py-2 text-[11px] text-noir-mute font-sans"
        >
          No matches. Press <span className="pn-kbd">Esc</span> to close.
        </div>
      </Popover>
    );
  }

  // Hint the user about keyboard nav once a row is visible.
  return (
    <Popover
      anchorRef={anchorRef}
      open
      onClose={onClose}
      placement={placement}
      align="match"
      layer="panel-popover"
      role="listbox"
      ariaLabel="Mention picker"
      maxHeight={280}
    ><div
      ref={containerRef}
      className="flex flex-col min-h-0 flex-1"
    >
      <div className="flex-1 min-h-0 overflow-y-auto">
        {rows.map((row, idx) => {
          const selected = idx === active;
          return (
            <button
              key={row.key}
              data-mention-index={idx}
              onMouseEnter={() => setActive(idx)}
              onMouseDown={(e) => {
                // Mousedown (not click) so the textarea doesn't lose focus
                // before we splice — keyboard nav remains uninterrupted.
                e.preventDefault();
                commit(row);
              }}
              className={`w-full text-left px-3 py-2 flex items-center gap-2 text-[12px] min-w-0 ${
                selected
                  ? "bg-noir-accent/15 text-noir-text"
                  : "text-noir-text hover:bg-noir-ridge/60"
              } ${
                row.kind === "category" && row.disabled ? "opacity-50" : ""
              }`}
              aria-selected={selected}
              role="option"
              title={
                row.kind === "category" && row.disabled
                  ? row.disabledReason
                  : row.kind === "file" || row.kind === "folder"
                  ? row.path
                  : undefined
              }
            >
              <RowBody
                row={row}
                attached={attached}
                workspaceRoot={workspaceRoot}
              />
            </button>
          );
        })}
      </div>
      <div className="px-3 py-1 border-t border-noir-line/60 bg-noir-chrome/40 text-[10px] font-sans text-noir-mute flex items-center gap-3">
        <span>
          <span className="pn-kbd">↑↓</span> navigate
        </span>
        <span>
          <span className="pn-kbd">⏎</span> insert
        </span>
        <span>
          <span className="pn-kbd">esc</span> close
        </span>
      </div>
    </div>
    </Popover>
  );
}

/** Closest path-style dirname. We want this for free without
 *  pulling node's posix path module — the operation is one find. */
function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? "" : p.slice(0, i);
}

function RowBody({
  row,
  attached,
  workspaceRoot,
}: {
  row: Row;
  attached: Reference[];
  workspaceRoot: string | null;
}) {
  if (row.kind === "category") {
    return (
      <>
        <span className="text-noir-accent shrink-0">{row.icon}</span>
        <span className="font-mono text-[12px] text-noir-accent shrink-0">{row.label}</span>
        <span className="text-noir-mute text-[11px] truncate min-w-0">
          {row.description}
        </span>
      </>
    );
  }
  if (row.kind === "file") {
    const dup = attached.some(
      (r) => r.kind === "file" && r.path === row.path,
    );
    const display = displayPath(row.path, workspaceRoot);
    return (
      <>
        <FileIconFor name={display.name} size={13} className="shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[12px] leading-4 text-noir-text">
            {display.name}
          </span>
          <span className="block truncate font-mono text-[10.5px] leading-3 text-noir-mute">
            {display.parent || "workspace root"}
          </span>
        </span>
        {dup && (
          <span className="ml-auto text-[10px] text-noir-mute shrink-0">attached</span>
        )}
      </>
    );
  }
  if (row.kind === "folder") {
    const display = displayPath(row.path, workspaceRoot);
    return (
      <>
        <Folder size={13} className="text-noir-accent shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[12px] leading-4 text-noir-text">
            {display.name}/
          </span>
          <span className="block truncate font-mono text-[10.5px] leading-3 text-noir-mute">
            {display.parent || "workspace root"}
          </span>
        </span>
        <span className="text-noir-mute text-[10.5px] ml-auto shrink-0">folder</span>
      </>
    );
  }
  if (row.kind === "selection") {
    return (
      <>
        <ScrollText size={11} className="text-noir-accent" />
        <span className="font-mono">@selection</span>
        <span className="text-noir-mute text-[10.5px]">
          current editor selection
        </span>
      </>
    );
  }
  if (row.kind === "breakpoint") {
    const bp = row.breakpoint;
    return (
      <>
        <CircleDot
          size={11}
          className={bp.enabled ? "text-noir-err" : "text-noir-mute"}
        />
        <span className="font-mono text-[11px] truncate">
          {shorten(bp.path)}:{bp.line}
        </span>
        <span className="text-noir-mute text-[10.5px] truncate">
          {bp.condition || bp.logMessage || "breakpoint"}
        </span>
      </>
    );
  }
  if (row.kind === "debugValue") {
    const value = row.value;
    return (
      <>
        <Code2 size={11} className="text-noir-accent" />
        <span className="font-mono text-[11px] truncate">{value.name}</span>
        <span className="text-noir-text text-[11px] truncate flex-1">
          {value.value}
        </span>
        {value.type && (
          <span className="font-mono text-[9.5px] text-noir-mute shrink-0">
            {value.type}
          </span>
        )}
      </>
    );
  }
  if (row.kind === "diagnostic") {
    const d = row.diagnostic;
    return (
      <>
        <AlertCircle
          size={11}
          className={
            d.severity === "error"
              ? "text-noir-err"
              : d.severity === "warning"
              ? "text-noir-warn"
              : "text-noir-mute"
          }
        />
        <span className="font-mono text-[11px] truncate">
          {d.name}:{d.startLine}
        </span>
        <span className="text-noir-text text-[11px] truncate flex-1">
          {d.message}
        </span>
        {d.code && (
          <span className="font-mono text-[9.5px] text-noir-mute shrink-0 uppercase tracking-wider">
            {d.code}
          </span>
        )}
      </>
    );
  }
  if (row.kind === "codebase") {
    return (
      <>
        <Sparkles size={11} className="text-noir-accent" />
        <span className="font-mono">
          @codebase{row.query ? `: ${row.query}` : ""}
        </span>
        <span className="text-noir-mute text-[10.5px] ml-auto">
          semantic search
        </span>
      </>
    );
  }
  return null;
}

function shorten(p: string): string {
  return p.split(/[\\/]/).slice(-2).join("/");
}

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

function displayPath(
  path: string,
  workspaceRoot: string | null,
): { name: string; parent: string } {
  const rel = relativeToRoot(path, workspaceRoot);
  const name = basename(rel) || basename(path) || path;
  return { name, parent: dirname(rel) };
}

function relativeToRoot(path: string, workspaceRoot: string | null): string {
  if (!workspaceRoot) return path;
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedPath === normalizedRoot) return basename(normalizedRoot);
  if (normalizedPath.startsWith(normalizedRoot + "/")) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return path;
}
