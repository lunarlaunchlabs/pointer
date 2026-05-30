import { Command } from "cmdk";
import { useEffect, useMemo, useState } from "@/lib/preactSignalCompat";
import { Clock } from "@/lib/lucide";
import { ipc, type FileHit } from "@/lib/ipc";
import { useEditorStore } from "@/store/editor";
import { useWorkspace } from "@/store/workspace";
import { useSearchHistory } from "@/store/searchHistory";
import { FileIconFor } from "@/lib/fileIcon";

type Goto = { line: number; col?: number };

/** "src/foo.ts:42:8" → ["src/foo.ts", { line: 42, col: 8 }] */
function parseGoto(input: string): [string, Goto | null] {
  const m = input.match(/^(.*?):(\d+)(?::(\d+))?\s*$/);
  if (!m) return [input, null];
  const [, name, lineStr, colStr] = m;
  return [name, { line: Number(lineStr), col: colStr ? Number(colStr) : undefined }];
}

export function FileFinder({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FileHit[]>([]);
  const openFile = useEditorStore((s) => s.openFile);
  const revealAt = useEditorStore((s) => s.revealAt);
  const root = useWorkspace((s) => s.root);
  const history = useSearchHistory((s) => s.finder);
  const pushHistory = useSearchHistory((s) => s.push);
  const initHistory = useSearchHistory((s) => s.init);
  useEffect(() => {
    void initHistory();
  }, [initHistory]);

  // Split "src/file.ts:42:8" into the search term and the optional
  // line/column suffix. Matches the de facto IDE convention so users
  // can paste error stack frames directly into the picker.
  const [namePart, lineGoto] = useMemo(() => parseGoto(query), [query]);

  useEffect(() => {
    if (!root) return;
    const id = setTimeout(async () => {
      try {
        const r = await ipc.searchFiles(namePart, 50);
        setHits(r);
      } catch (e) {
        console.warn(e);
      }
    }, 60);
    return () => clearTimeout(id);
  }, [namePart, root]);

  const open = (path: string) => {
    pushHistory("finder", query);
    if (lineGoto) {
      revealAt(path, lineGoto.line, lineGoto.col ?? 1).catch(() => {});
    } else {
      openFile(path);
    }
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
        aria-label="File finder"
        className="w-[640px] max-w-[92vw] rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="File finder" loop shouldFilter={false}>
          <div className="border-b border-noir-line/60 px-4 py-3 flex items-center gap-3">
            <span className="text-noir-accent" aria-hidden="true">▸</span>
            <Command.Input
              value={query}
              onValueChange={setQuery}
              autoFocus
              aria-label="Find file by name"
              placeholder="Find file by name — append :line[:col] to jump…"
              className="flex-1 bg-transparent text-[14px] text-noir-text font-sans outline-none placeholder-noir-mute"
            />
            {lineGoto && (
              <span
                className="text-[11px] text-noir-accent font-mono mr-1"
                role="status"
                aria-label={`Will jump to line ${lineGoto.line}${lineGoto.col ? ` column ${lineGoto.col}` : ""}`}
              >
                → :{lineGoto.line}
                {lineGoto.col ? `:${lineGoto.col}` : ""}
              </span>
            )}
            <kbd className="pn-kbd">Esc</kbd>
          </div>
          <Command.List className="max-h-[60vh] overflow-y-auto py-1">
            {query.length === 0 && history.length > 0 && (
              <Command.Group
                heading="Recent searches"
                className="text-noir-mute"
              >
                {history.slice(0, 8).map((q) => (
                  <Command.Item
                    key={q}
                    value={`__hist:${q}`}
                    onSelect={() => setQuery(q)}
                    className="px-4 py-2 text-[12px] font-mono text-noir-subtext aria-selected:bg-noir-ridge cursor-pointer flex items-center gap-2"
                  >
                    <Clock size={11} className="shrink-0 text-noir-mute" aria-hidden="true" />
                    <span className="truncate">{q}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {hits.length === 0 && query.length > 0 && (
              <Command.Empty className="px-4 py-3 text-[12px] text-noir-mute font-sans">
                {root ? "No matches." : "Open a folder first."}
              </Command.Empty>
            )}
            {hits.map((h) => (
              <Command.Item
                key={h.path}
                value={h.path}
                onSelect={() => open(h.path)}
                className="px-4 py-2 text-[13px] font-mono text-noir-text aria-selected:bg-noir-ridge cursor-pointer flex items-center gap-2"
              >
                <FileIconFor name={h.name} size={13} className="shrink-0" />
                <span className="truncate flex-1">{h.name}</span>
                <span className="text-noir-mute text-[11px] truncate max-w-[60%] ml-2 shrink-0">
                  {h.path.replace(root ?? "", "")}
                </span>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
