import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaseSensitive,
  Loader2,
  Regex,
  Replace,
  Search,
  WholeWord,
  X,
} from "lucide-react";
import { ipc, type TextHit, type SearchOptions } from "@/lib/ipc";
import { useEditorStore } from "@/store/editor";
import { useWorkspace } from "@/store/workspace";
import { useSearchHistory } from "@/store/searchHistory";
import { confirm } from "@/components/Confirm";
import { toast } from "@/components/Toast";

/**
 * Workspace-wide find / replace. Backed by `ipc.searchText` and
 * `ipc.replaceText`, both of which honor .gitignore via the `ignore`
 * crate. Click a result to jump straight to the matching line and
 * column; the editor opens (or activates) the file and the cursor
 * lands on the actual match, not just line 1.
 *
 * Modeled after VSCode's Search side panel rather than its modal —
 * options live as inline icons on the input row, and the replace
 * field is revealed on demand to keep the default case minimal.
 */
export function FindInFiles({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [hits, setHits] = useState<TextHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const root = useWorkspace((s) => s.root);
  const revealAt = useEditorStore((s) => s.revealAt);
  const history = useSearchHistory((s) => s.findInFiles);
  const pushHistory = useSearchHistory((s) => s.push);
  const initHistory = useSearchHistory((s) => s.init);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    void initHistory();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, initHistory]);

  const options: SearchOptions = useMemo(
    () => ({
      case_sensitive: caseSensitive,
      whole_word: wholeWord,
      regex: useRegex,
    }),
    [caseSensitive, wholeWord, useRegex],
  );

  // Debounce — the IPC walks the whole workspace, so we don't want a
  // request per keystroke. Options changes also re-search since they
  // change the result set.
  useEffect(() => {
    if (!root || !query.trim()) {
      setHits([]);
      setError(null);
      return;
    }
    setSearching(true);
    setError(null);
    const id = setTimeout(async () => {
      try {
        const r = await ipc.searchText(query.trim(), 300, options);
        setHits(r);
        if (r.length > 0) {
          // Only remember queries that actually matched something —
          // typos disappear instead of cluttering the recents list.
          pushHistory("findInFiles", query.trim());
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => clearTimeout(id);
  }, [query, root, options]);

  const grouped = useMemo(() => {
    const m = new Map<string, TextHit[]>();
    for (const h of hits) {
      const arr = m.get(h.path) ?? [];
      arr.push(h);
      m.set(h.path, arr);
    }
    return Array.from(m.entries());
  }, [hits]);

  const rootPrefix = root ? root + "/" : "";

  const doReplaceAll = async () => {
    if (!query.trim()) return;
    const ok = await confirm({
      title: `Replace all matches?`,
      body: `Replace ${hits.length} match${hits.length === 1 ? "" : "es"} across ${grouped.length} file${grouped.length === 1 ? "" : "s"}.\n\n"${query}" → "${replacement}"\n\nThis writes to disk immediately and isn't transactional. Make sure your workspace is committed first.`,
      confirmLabel: "Replace All",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    setReplacing(true);
    setError(null);
    try {
      const r = await ipc.replaceText(query.trim(), replacement, options);
      toast.info(
        `Replaced ${r.replacements} match${r.replacements === 1 ? "" : "es"} in ${r.files_changed} file${r.files_changed === 1 ? "" : "s"}`,
      );
      // Re-search so the UI shows the post-replace state — usually
      // zero hits unless the replacement still matches the pattern.
      const fresh = await ipc.searchText(query.trim(), 300, options);
      setHits(fresh);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Replace failed", { body: msg });
    } finally {
      setReplacing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-pn-palette flex items-start justify-center pt-[8vh] bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Find in files"
        className="w-[820px] max-w-[94vw] max-h-[80vh] rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-noir-line/60 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowReplace((v) => !v)}
              className="text-noir-mute hover:text-noir-text"
              title={showReplace ? "Hide replace field" : "Toggle replace"}
              aria-label={showReplace ? "Hide replace field" : "Show replace field"}
              aria-expanded={showReplace}
            >
              <Replace
                size={13}
                aria-hidden="true"
                className={showReplace ? "text-noir-accent" : ""}
              />
            </button>
            <Search size={13} className="text-noir-accent shrink-0" aria-hidden="true" />
            <div className="flex-1 relative">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setShowHistory(true)}
                onBlur={() => setTimeout(() => setShowHistory(false), 120)}
                placeholder={
                  root
                    ? useRegex
                      ? "Regex pattern across the workspace…"
                      : "Search across the workspace…"
                    : "Open a folder first"
                }
                disabled={!root}
                aria-label="Search workspace"
                className="w-full bg-transparent text-[14px] text-noir-text font-sans outline-none placeholder-noir-mute disabled:opacity-50"
              />
              {showHistory && query.length === 0 && history.length > 0 && (
                <div className="absolute left-0 top-full mt-1 w-full max-h-[260px] overflow-y-auto rounded-md border border-noir-line bg-noir-panel shadow-soft z-pn-modal-popover">
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-noir-mute font-sans border-b border-noir-line/60">
                    Recent searches
                  </div>
                  {history.slice(0, 12).map((q) => (
                    <button
                      key={q}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setQuery(q);
                        setShowHistory(false);
                      }}
                      className="w-full text-left px-3 py-1.5 text-[12px] font-mono text-noir-subtext hover:bg-noir-ridge/60 hover:text-noir-text"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <OptionToggle
              active={caseSensitive}
              onClick={() => setCaseSensitive((v) => !v)}
              title="Case sensitive"
              ariaLabel="Toggle case sensitive"
            >
              <CaseSensitive size={12} />
            </OptionToggle>
            <OptionToggle
              active={wholeWord}
              onClick={() => setWholeWord((v) => !v)}
              title="Match whole word"
              ariaLabel="Toggle match whole word"
            >
              <WholeWord size={12} />
            </OptionToggle>
            <OptionToggle
              active={useRegex}
              onClick={() => setUseRegex((v) => !v)}
              title="Regular expression"
              ariaLabel="Toggle regular expression"
            >
              <Regex size={12} />
            </OptionToggle>
            {searching && (
              <Loader2
                size={12}
                aria-hidden="true"
                className="animate-spin text-noir-accent"
              />
            )}
            <span
              className="text-[10.5px] text-noir-mute font-sans"
              role="status"
              aria-live="polite"
            >
              {hits.length} {hits.length === 1 ? "match" : "matches"}
            </span>
            <button
              onClick={onClose}
              className="p-1 text-noir-mute hover:text-noir-text"
              aria-label="Close find in files"
              title="Close (Esc)"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
          {showReplace && (
            <div className="flex items-center gap-3 pl-7">
              <Replace size={13} className="text-noir-mute shrink-0" aria-hidden="true" />
              <input
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                placeholder="Replacement"
                disabled={!root}
                aria-label="Replacement text"
                className="flex-1 bg-transparent text-[14px] text-noir-text font-sans outline-none placeholder-noir-mute disabled:opacity-50"
              />
              <button
                onClick={doReplaceAll}
                disabled={!root || !query.trim() || hits.length === 0 || replacing}
                className="px-2.5 py-1 rounded bg-noir-accent/15 text-noir-accent text-[11px] font-medium hover:bg-noir-accent/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                title="Replace all matches across the workspace"
              >
                {replacing && <Loader2 size={11} aria-hidden="true" className="animate-spin" />}
                Replace All
              </button>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto font-sans">
          {error && (
            <div className="px-4 py-3 text-[12px] text-noir-err">{error}</div>
          )}
          {!error && root && query.trim() && grouped.length === 0 && !searching && (
            <div className="px-4 py-6 text-center text-[12px] text-noir-mute">
              No matches.
            </div>
          )}
          {!root && (
            <div className="px-4 py-6 text-center text-[12px] text-noir-mute">
              Open a folder with <span className="pn-kbd">⌘O</span> to enable
              workspace search.
            </div>
          )}
          {grouped.map(([file, fileHits]) => (
            <div key={file} className="border-b border-noir-line/40 last:border-b-0">
              <div className="px-3 py-1.5 text-[11px] font-mono text-noir-subtext bg-noir-chrome/30 flex items-center justify-between">
                <span className="truncate">
                  {file.startsWith(rootPrefix)
                    ? file.slice(rootPrefix.length)
                    : file}
                </span>
                <span className="text-[10px] text-noir-mute ml-2 shrink-0">
                  {fileHits.length}
                </span>
              </div>
              <ul>
                {fileHits.map((h, i) => (
                  <li key={`${file}:${h.line}:${i}`}>
                    <button
                      onClick={() => {
                        // Land the cursor at the actual match
                        // column when the backend reported one;
                        // otherwise jump to column 1 of the line.
                        const col = (h.col ?? -1) >= 0 ? (h.col ?? 0) + 1 : 1;
                        revealAt(h.path, h.line, col);
                        onClose();
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-noir-ridge/40 transition-colors flex items-baseline gap-3"
                    >
                      <span className="font-mono text-[10.5px] text-noir-mute w-9 text-right shrink-0">
                        {h.line}
                      </span>
                      <HighlightedLine
                        text={h.text}
                        query={query.trim()}
                        col={h.col ?? -1}
                        matchLen={h.match_len ?? 0}
                        regex={useRegex}
                        caseSensitive={caseSensitive}
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function OptionToggle({
  active,
  onClick,
  title,
  ariaLabel,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`p-1 rounded transition-colors ${
        active
          ? "bg-noir-accent/15 text-noir-accent"
          : "text-noir-mute hover:text-noir-text hover:bg-noir-ridge/40"
      }`}
    >
      {children}
    </button>
  );
}

function HighlightedLine({
  text,
  query,
  col,
  matchLen,
  regex,
  caseSensitive,
}: {
  text: string;
  query: string;
  col: number;
  matchLen: number;
  regex: boolean;
  caseSensitive: boolean;
}) {
  // When the backend reports a column + length, we have the precise
  // match — use that to highlight exactly the right span (regex and
  // edge cases included). Otherwise fall back to a substring scan.
  if (col >= 0 && matchLen > 0 && col + matchLen <= text.length) {
    const before = text.slice(0, col);
    const middle = text.slice(col, col + matchLen);
    const after = text.slice(col + matchLen);
    return (
      <span className="font-mono text-[12px] text-noir-text truncate">
        {before}
        <span className="bg-noir-accent/20 text-noir-accent rounded-sm">{middle}</span>
        {after}
      </span>
    );
  }
  // Substring fallback (legacy behavior when col is unavailable).
  if (!query || regex) {
    return <span className="font-mono text-[12px]">{text}</span>;
  }
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = haystack.indexOf(needle, i);
    if (idx < 0) {
      parts.push(<span key={i}>{text.slice(i)}</span>);
      break;
    }
    if (idx > i) parts.push(<span key={`p${i}`}>{text.slice(i, idx)}</span>);
    parts.push(
      <span
        key={`m${idx}`}
        className="bg-noir-accent/20 text-noir-accent rounded-sm"
      >
        {text.slice(idx, idx + needle.length)}
      </span>,
    );
    i = idx + needle.length;
  }
  return (
    <span className="font-mono text-[12px] text-noir-text truncate">{parts}</span>
  );
}
