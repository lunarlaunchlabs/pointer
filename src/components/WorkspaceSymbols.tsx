import { Command } from "cmdk";
import { useEffect, useMemo, useState } from "react";
import { Hash, Loader2 } from "lucide-react";
import { ipc, type TextHit } from "@/lib/ipc";
import { useEditorStore } from "@/store/editor";
import { useWorkspace } from "@/store/workspace";

/**
 * Quick workspace symbol picker. We don't have an LSP, so this
 * shells out to the same content search that powers Find in Files
 * with a small set of language-aware patterns ("function foo",
 * "class Bar", "def baz", "fn qux" …). It's faster than a true
 * symbol provider but covers the day-to-day need for jumping to
 * symbols by name.
 *
 * Triggered by ⌘T or "Go to Symbol in Workspace…". Results are
 * grouped by file and clicking jumps to the matching line.
 */
type Sym = TextHit & {
  /** Display name extracted from the source line for the row. */
  symbol: string;
  /** Symbol kind label (Function / Class / …) for the column on the right. */
  kind: string;
};

const SYMBOL_PATTERNS: { kind: string; re: string }[] = [
  // Captures the symbol name in group 1 of an extended regex. We
  // intentionally keep these loose; false positives are fine —
  // false negatives are not.
  { kind: "Function", re: String.raw`\bfunction\s+([A-Za-z_$][\w$]*)` },
  { kind: "Class", re: String.raw`\bclass\s+([A-Za-z_$][\w$]*)` },
  { kind: "Interface", re: String.raw`\binterface\s+([A-Za-z_$][\w$]*)` },
  { kind: "Type", re: String.raw`\btype\s+([A-Za-z_$][\w$]*)\s*=` },
  { kind: "Enum", re: String.raw`\benum\s+([A-Za-z_$][\w$]*)` },
  { kind: "Const", re: String.raw`\bconst\s+([A-Za-z_$][\w$]*)\s*=` },
  { kind: "Def", re: String.raw`\bdef\s+([A-Za-z_][\w]*)` },
  { kind: "Fn", re: String.raw`\bfn\s+([A-Za-z_][\w]*)` },
  { kind: "Struct", re: String.raw`\bstruct\s+([A-Za-z_][\w]*)` },
  { kind: "Trait", re: String.raw`\btrait\s+([A-Za-z_][\w]*)` },
  { kind: "Func", re: String.raw`\bfunc\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)` },
];

export function WorkspaceSymbols({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Sym[]>([]);
  const [searching, setSearching] = useState(false);
  const root = useWorkspace((s) => s.root);
  const revealAt = useEditorStore((s) => s.revealAt);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!root) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    setSearching(true);
    const id = setTimeout(async () => {
      try {
        // Fire all the symbol shape searches in parallel — each
        // returns matches for one language family. Dedupe by
        // path+line so the same declaration doesn't appear twice
        // when two patterns happen to match.
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const queries = SYMBOL_PATTERNS.map((p) =>
          p.re.replace(
            /\(\[A-Za-z_\$\]\[\\w\$\]\*\)|\(\[A-Za-z_\]\[\\w\]\*\)/,
            `(${escaped}[\\w$]*)`,
          ),
        );
        const results = await Promise.all(
          queries.map((pattern, i) =>
            ipc
              .searchText(pattern, 80, {
                regex: true,
                case_sensitive: false,
              })
              .then((arr): Sym[] =>
                arr.map((h) => ({
                  ...h,
                  symbol: extractSymbol(h.text, q) ?? q,
                  kind: SYMBOL_PATTERNS[i].kind,
                })),
              )
              .catch(() => [] as Sym[]),
          ),
        );
        const merged: Sym[] = [];
        const seen = new Set<string>();
        for (const arr of results) {
          for (const h of arr) {
            const k = `${h.path}:${h.line}`;
            if (seen.has(k)) continue;
            seen.add(k);
            merged.push(h);
          }
        }
        setHits(merged.slice(0, 200));
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(id);
  }, [query, root]);

  const grouped = useMemo(() => {
    // Sort: exact name matches first, then by file path.
    const ql = query.trim().toLowerCase();
    return [...hits].sort((a, b) => {
      const ea = a.symbol.toLowerCase() === ql ? 0 : 1;
      const eb = b.symbol.toLowerCase() === ql ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return a.path.localeCompare(b.path);
    });
  }, [hits, query]);

  const jump = (h: Sym) => {
    revealAt(h.path, h.line, h.col ?? 1).catch(() => {});
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-pn-palette flex items-start justify-center pt-[14vh] bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Workspace symbols"
        className="w-[720px] max-w-[92vw] rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Workspace symbols" loop shouldFilter={false}>
          <div className="border-b border-noir-line/60 px-4 py-3 flex items-center gap-3">
            <Hash size={14} className="text-noir-accent" aria-hidden="true" />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              autoFocus
              aria-label="Search workspace symbols"
              placeholder="Search for a function, class, type… (workspace)"
              className="flex-1 bg-transparent text-[14px] text-noir-text font-sans outline-none placeholder-noir-mute"
            />
            {searching && (
              <Loader2
                size={12}
                aria-hidden="true"
                className="animate-spin text-noir-accent"
              />
            )}
            <kbd className="pn-kbd">Esc</kbd>
          </div>
          <Command.List className="max-h-[60vh] overflow-y-auto py-1">
            {grouped.length === 0 && query.trim().length >= 2 && !searching && (
              <Command.Empty className="px-4 py-3 text-[12px] text-noir-mute font-sans">
                No symbols matched.
              </Command.Empty>
            )}
            {query.trim().length < 2 && (
              <Command.Empty className="px-4 py-3 text-[12px] text-noir-mute font-sans">
                Type at least two characters.
              </Command.Empty>
            )}
            {grouped.map((h) => (
              <Command.Item
                key={`${h.path}:${h.line}:${h.symbol}`}
                value={`${h.symbol} ${h.path}`}
                onSelect={() => jump(h)}
                className="px-4 py-2 text-[13px] font-mono text-noir-text aria-selected:bg-noir-ridge cursor-pointer flex items-center gap-3"
              >
                <span className="text-[10px] uppercase tracking-wider text-noir-mute w-16 shrink-0">
                  {h.kind}
                </span>
                <span className="truncate font-medium">{h.symbol}</span>
                <span className="text-noir-mute text-[10.5px] truncate ml-auto">
                  {h.path.replace(root ?? "", "")}:{h.line}
                </span>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function extractSymbol(line: string, query: string): string | null {
  // Find the token containing the query substring. Tokens are
  // identifier runs ([A-Za-z_$][\w$]*).
  const ql = query.toLowerCase();
  const tokens = line.match(/[A-Za-z_$][\w$]*/g) ?? [];
  for (const t of tokens) {
    if (t.toLowerCase().includes(ql)) return t;
  }
  return null;
}
