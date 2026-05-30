import { useEffect, useState } from "@/lib/preactSignalCompat";
import { ChevronDown, ChevronRight } from "@/lib/lucide";
import { useEditorStore } from "@/store/editor";
import { ipc, type LspDocumentSymbol } from "@/lib/ipc";
import { vueOutlineSymbols } from "@/lib/vueIntelligence";

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
    setItems(null);
    setError(null);
    setExpanded(new Set());
  }, [active?.path]);

  useEffect(() => {
    if (!active) {
      setItems(null);
      setError(null);
      return;
    }
    if (active.preview) {
      setItems([]);
      setError("Outline is available for text files.");
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        if (active.language === "markdown" || active.language === "mdx") {
          if (!cancelled) {
            setItems(scanByRegex(active.content, active.language));
            setError(null);
          }
          return;
        }

        const lspSymbols = await ipc
          .lspDocumentSymbols({
            path: active.path,
            language: active.language,
            content: active.content,
          })
          .catch(() => []);
        if (lspSymbols.length > 0) {
          if (!cancelled) {
            setItems(lspSymbols.map(fromLspSymbol));
            setError(null);
          }
          return;
        }

        const fallback = scanByRegex(active.content, active.language);
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
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [active?.path, active?.content, active?.language]);

  if (!active) {
    return (
      <div className="flex-1 min-h-0 px-3 py-2 text-[11px] text-noir-mute">
        Open a file to see its outline.
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      <header className="px-3 h-7 shrink-0 flex items-center text-[10px] uppercase tracking-wider text-noir-mute font-sans border-b border-noir-line/60">
        Outline · {active.name}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto py-1 text-[12px]">
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
        {items === null && !error && (
          <div className="px-3 py-2 text-[11px] text-noir-mute" role="status">
            Building outline…
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

function fromLspSymbol(symbol: LspDocumentSymbol): OutlineItem {
  return {
    name: symbol.name,
    kindLabel: symbolKindLabel(symbol.kind),
    line: symbol.line,
    column: symbol.column,
    detail: symbol.detail ?? undefined,
    children: symbol.children.map(fromLspSymbol),
  };
}

function symbolKindLabel(kind: number): string {
  switch (kind) {
    case 2:
      return "Module";
    case 3:
      return "Namespace";
    case 4:
      return "Package";
    case 5:
      return "Class";
    case 6:
      return "Method";
    case 7:
      return "Property";
    case 8:
      return "Field";
    case 9:
      return "Constructor";
    case 10:
      return "Enum";
    case 11:
      return "Interface";
    case 12:
      return "Function";
    case 13:
      return "Variable";
    case 14:
      return "Constant";
    case 18:
      return "Array";
    case 22:
      return "Struct";
    case 23:
      return "Event";
    case 24:
      return "Operator";
    case 25:
      return "Type";
    default:
      return "Symbol";
  }
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

  if (language === "vue") {
    return vueOutlineSymbols(source).map((symbol) => ({
      name: symbol.name,
      kindLabel:
        symbol.kind === "component"
          ? "Component"
          : symbol.kind === "computed"
          ? "Computed"
          : symbol.kind === "data"
          ? "Data"
          : symbol.kind === "method"
          ? "Method"
          : symbol.kind === "prop"
          ? "Prop"
          : "Setup",
      line: symbol.line,
      column: symbol.column,
    }));
  }

  const ident = String.raw`([A-Za-z_$][\w$]*)`;
  const patterns: { re: RegExp; kind: string }[] = [
    // JS / TS / JSX / TSX
    { re: new RegExp(String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+${ident}\s*\(`), kind: "Function" },
    { re: new RegExp(String.raw`^\s*(?:export\s+)?(?:default\s+)?class\s+${ident}\b`), kind: "Class" },
    { re: new RegExp(String.raw`^\s*(?:export\s+)?interface\s+${ident}\b`), kind: "Interface" },
    { re: new RegExp(String.raw`^\s*(?:export\s+)?type\s+${ident}\s*=`), kind: "Type" },
    { re: new RegExp(String.raw`^\s*(?:export\s+)?enum\s+${ident}\b`), kind: "Enum" },
    { re: new RegExp(String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+${ident}(?:\s*:[^=]+)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|${ident})\s*=>`), kind: "Function" },
    { re: new RegExp(String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+${ident}(?:\s*:[^=]+)?\s*=\s*(?:async\s+)?function\b`), kind: "Function" },
    { re: new RegExp(String.raw`^\s*(?:(?:public|private|protected|static|readonly|override|abstract|get|set)\s+)*(?:async\s+)?${ident}\s*\([^)]*\)\s*(?::[^={]+)?\s*\{?\s*$`), kind: "Method" },

    // Python
    { re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/, kind: "Function" },
    { re: /^\s*class\s+([A-Za-z_][\w]*)/, kind: "Class" },

    // Rust
    { re: /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*[(<]/, kind: "Function" },
    { re: /^\s*(?:pub(?:\([^)]+\))?\s+)?struct\s+([A-Za-z_][\w]*)/, kind: "Struct" },
    { re: /^\s*(?:pub(?:\([^)]+\))?\s+)?enum\s+([A-Za-z_][\w]*)/, kind: "Enum" },
    { re: /^\s*(?:pub(?:\([^)]+\))?\s+)?trait\s+([A-Za-z_][\w]*)/, kind: "Trait" },
    { re: /^\s*impl(?:\s*<[^>]+>)?\s+([A-Za-z_][\w<>:'_]*)/, kind: "Impl" },

    // Go
    { re: /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)\s*\(/, kind: "Function" },
    { re: /^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)/, kind: "Type" },

    // Swift / Kotlin / Dart-ish declarations
    { re: /^\s*(?:(?:public|private|internal|open|static|override|mutating|suspend|async)\s+)*(?:func|fun)\s+([A-Za-z_][\w]*)\s*[\(<]/, kind: "Function" },
    { re: /^\s*(?:(?:public|private|internal|open|data|sealed|abstract|final)\s+)*class\s+([A-Za-z_][\w]*)\b/, kind: "Class" },
    { re: /^\s*(?:(?:public|private|internal|open|data|sealed|abstract|final)\s+)*struct\s+([A-Za-z_][\w]*)\b/, kind: "Struct" },
    { re: /^\s*(?:(?:public|private|internal|open|data|sealed|abstract|final)\s+)*enum\s+([A-Za-z_][\w]*)\b/, kind: "Enum" },
    { re: /^\s*(?:(?:public|private|internal|open|data|sealed|abstract|final)\s+)*(?:protocol|object)\s+([A-Za-z_][\w]*)\b/, kind: "Type" },

    // JVM / .NET-style declarations
    { re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|sealed|async|suspend|pub)\s+)+(?:[\w<>,.?[\]]+\s+)+([A-Za-z_$][\w$]*)\s*\(/, kind: "Method" },
    { re: /^\s*(?:(?:public|private|protected|internal|final|abstract|sealed|data)\s+)*(?:class|record)\s+([A-Za-z_$][\w$]*)\b/, kind: "Class" },
    { re: /^\s*(?:(?:public|private|protected|internal)\s+)*interface\s+([A-Za-z_$][\w$]*)\b/, kind: "Interface" },

    // PHP / Ruby
    { re: /^\s*(?:(?:public|private|protected|static)\s+)*function\s+([A-Za-z_][\w]*)\s*\(/, kind: "Function" },
    { re: /^\s*def\s+(?:self\.)?([A-Za-z_][\w!?=]*)/, kind: "Function" },
    { re: /^\s*class\s+([A-Za-z_][\w:]*)/, kind: "Class" },
    { re: /^\s*module\s+([A-Za-z_][\w:]*)/, kind: "Module" },
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      const m = p.re.exec(lines[i]);
      if (m && !IGNORED_SYMBOL_NAMES.has(m[1])) {
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

const IGNORED_SYMBOL_NAMES = new Set([
  "catch",
  "describe",
  "for",
  "if",
  "it",
  "switch",
  "while",
]);
