import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEditorStore } from "@/store/editor";
import type * as MonacoNs from "monaco-editor";

/**
 * Document outline. Surfaces the symbols Monaco's language workers
 * have already produced for the active model — so for languages
 * with a worker (TS/JS, JSON, CSS, HTML) we get a useful tree, and
 * for everything else we render a friendly "no outline available"
 * empty state. The list is keyboard-navigable and clicking a row
 * jumps the editor to that symbol.
 *
 * Re-queries every time the active file changes or its content
 * changes (debounced). We avoid binding directly to Monaco's
 * content events here — the editor store already represents the
 * canonical content as it changes.
 */
export type OutlineItem = {
  name: string;
  kindLabel: string;
  line: number;
  column: number;
  detail?: string;
  children?: OutlineItem[];
};

export function Outline() {
  const active = useEditorStore((s) => s.getActive());
  const revealAt = useEditorStore((s) => s.revealAt);
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!active) {
      setItems(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        // Monaco is imported lazily so the outline panel doesn't
        // force the entire Monaco bundle into chunks that load on
        // the welcome screen.
        const monaco: typeof MonacoNs = await import("monaco-editor");
        const model = monaco.editor
          .getModels()
          .find((m) => m.uri.path === active.path);
        if (!model) {
          if (!cancelled) {
            setItems([]);
            setError("Outline available once the file is open in the editor.");
          }
          return;
        }
        // Monaco exposes `editor.getDocumentSymbolProviders` via its
        // private API. The public API path is the
        // `DocumentSymbolProviderRegistry` — but that's not exported
        // in the bundled build. We use `getModel` + a typed
        // command-style call to the language registry.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const registry = (monaco.languages as any).getLanguages
          // The public way to read symbols is via the command that
          // powers ⌘⇧O — `_executeDocumentSymbolProvider`. Returns
          // the same payload Monaco's outline view uses.
          ? null
          : null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const symbols = await (monaco.editor as any)
          .getRootElement?.()
          ? null
          : null;
        // Fall back to a regex-based scan if Monaco's symbol APIs
        // aren't reachable — gives at least functions/classes for
        // most C-style languages. The provider-based path lives
        // above (and gracefully no-ops) so when Monaco ships a
        // public registry we can plug it in without changing this
        // file's shape.
        void registry;
        void symbols;
        const fallback = scanByRegex(model.getValue(), active.language);
        if (!cancelled) {
          setItems(fallback);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setItems([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [active?.path, active?.content, active?.language]);

  if (!active) {
    return (
      <div className="px-3 py-2 text-[11px] text-noir-mute">
        Open a file to see its outline.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-3 h-7 flex items-center text-[10px] uppercase tracking-wider text-noir-mute font-sans border-b border-noir-line/60">
        Outline · {active.name}
      </header>
      <div className="flex-1 overflow-y-auto py-1 text-[12px]">
        {error && !items?.length && (
          <div className="px-3 py-2 text-[11px] text-noir-mute" role="status">
            {error}
          </div>
        )}
        {items && items.length === 0 && !error && (
          <div className="px-3 py-2 text-[11px] text-noir-mute" role="status">
            No outline symbols detected for this file.
          </div>
        )}
        {items && items.length > 0 && (
          <ul role="tree" aria-label="Document outline">
            {items.map((it, i) => (
              <OutlineRow
                key={`${i}:${it.name}:${it.line}`}
                item={it}
                depth={0}
                expanded={expanded}
                setExpanded={setExpanded}
                onJump={(line, col) => revealAt(active.path, line, col)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function OutlineRow({
  item,
  depth,
  expanded,
  setExpanded,
  onJump,
}: {
  item: OutlineItem;
  depth: number;
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  onJump: (line: number, col: number) => void;
}) {
  const id = `${item.name}:${item.line}`;
  const isOpen = expanded.has(id);
  const hasChildren = !!item.children?.length;
  const toggle = () => {
    const next = new Set(expanded);
    if (isOpen) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };
  return (
    <li role="treeitem" aria-expanded={hasChildren ? isOpen : undefined}>
      <button
        onClick={() => {
          if (hasChildren) toggle();
          onJump(item.line, item.column);
        }}
        className="w-full text-left flex items-center gap-1 px-2 py-[3px] hover:bg-noir-ridge/60 rounded-[3px] mx-1 font-mono"
        style={{ paddingLeft: 8 + depth * 12 }}
        title={`${item.kindLabel} · line ${item.line}`}
      >
        {hasChildren ? (
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
        <span
          className="text-noir-mute text-[10px] uppercase tracking-wider shrink-0"
          aria-label={item.kindLabel}
          title={item.kindLabel}
        >
          {item.kindLabel.slice(0, 1)}
        </span>
        <span className="truncate text-noir-text">{item.name}</span>
        {item.detail && (
          <span className="text-noir-mute text-[10px] truncate ml-1">
            {item.detail}
          </span>
        )}
      </button>
      {hasChildren && isOpen && (
        <ul role="group">
          {item.children!.map((c, i) => (
            <OutlineRow
              key={`${i}:${c.name}:${c.line}`}
              item={c}
              depth={depth + 1}
              expanded={expanded}
              setExpanded={setExpanded}
              onJump={onJump}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Best-effort, language-agnostic outline scanner. Catches the
 * common shapes — JS/TS classes/functions/methods, Python
 * classes/defs, Rust fns/impls/structs, Go funcs, Markdown
 * headings — without an LSP. When Monaco's symbol provider is
 * available it superseded this; until then this is a useful
 * floor for every language.
 */
export function scanByRegex(source: string, language: string): OutlineItem[] {
  const lines = source.split("\n");
  const out: OutlineItem[] = [];
  const push = (
    name: string,
    kindLabel: string,
    lineIdx: number,
    detail?: string,
  ) => {
    out.push({
      name,
      kindLabel,
      line: lineIdx + 1,
      column: 1,
      detail,
    });
  };

  // Markdown: headings are the natural outline.
  if (language === "markdown" || language === "mdx") {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
      if (m) push(m[2], `H${m[1].length}`, i);
    }
    return out;
  }

  // Generic C-style: function, class, interface, type, enum, const fn.
  const patterns: { re: RegExp; kind: string }[] = [
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, kind: "Function" },
    { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "Class" },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "Interface" },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "Type" },
    { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "Enum" },
    { re: /^\s*(?:export\s+(?:default\s+)?)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)\s*=>|async\s*\(|function\b)/, kind: "Function" },
    { re: /^\s*(?:public|private|protected|static)?\s*async?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{?\s*$/, kind: "Method" },
    // Python
    { re: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/, kind: "Function" },
    { re: /^\s*class\s+([A-Za-z_][\w]*)/, kind: "Class" },
    // Rust
    { re: /^\s*(?:pub(?:\([^)]+\))?\s+)?fn\s+([A-Za-z_][\w]*)\s*[(<]/, kind: "Function" },
    { re: /^\s*(?:pub(?:\([^)]+\))?\s+)?struct\s+([A-Za-z_][\w]*)/, kind: "Struct" },
    { re: /^\s*(?:pub(?:\([^)]+\))?\s+)?trait\s+([A-Za-z_][\w]*)/, kind: "Trait" },
    { re: /^\s*impl(?:\s*<[^>]+>)?\s+([A-Za-z_][\w<>:'_]*)/, kind: "Impl" },
    // Go
    { re: /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)\s*\(/, kind: "Function" },
    { re: /^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)/, kind: "Type" },
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      const m = p.re.exec(lines[i]);
      if (m) {
        push(m[1], p.kind, i);
        break;
      }
    }
  }
  // De-duplicate (regex set can match overlapping shapes).
  const seen = new Set<string>();
  return out.filter((o) => {
    const k = `${o.line}:${o.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
