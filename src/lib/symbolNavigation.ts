export type SymbolAtPosition = {
  symbol: string;
  startColumn: number;
  endColumn: number;
};

export type LocalDefinition = {
  line: number;
  column: number;
  text: string;
};

const STOP_SYMBOLS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "else",
  "enum",
  "export",
  "false",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "if",
  "impl",
  "import",
  "in",
  "interface",
  "let",
  "match",
  "mod",
  "new",
  "none",
  "null",
  "package",
  "private",
  "protected",
  "pub",
  "public",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "trait",
  "true",
  "type",
  "undefined",
  "use",
  "var",
  "void",
  "while",
]);

export function symbolAtPosition(
  line: string,
  column: number,
): SymbolAtPosition | null {
  const cursor = Math.max(0, Math.min(line.length, column - 1));
  const re = /[A-Za-z_$][\w$]*/g;
  for (const match of line.matchAll(re)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (cursor >= start && cursor <= end) {
      const symbol = match[0];
      if (!isNavigableSymbol(symbol)) return null;
      return {
        symbol,
        startColumn: start + 1,
        endColumn: end + 1,
      };
    }
  }
  return null;
}

export function isNavigableSymbol(symbol: string): boolean {
  return symbol.length >= 2 && !STOP_SYMBOLS.has(symbol.toLowerCase());
}

export function definitionSearchPatterns(
  symbol: string,
  language: string,
): string[] {
  if (!isNavigableSymbol(symbol)) return [];
  const s = escapeRegex(symbol);
  const lang = language.toLowerCase();
  const jsLike = [
    String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+${s}\b`,
    String.raw`^\s*(?:export\s+)?(?:default\s+)?class\s+${s}\b`,
    String.raw`^\s*(?:export\s+)?interface\s+${s}\b`,
    String.raw`^\s*(?:export\s+)?type\s+${s}\b`,
    String.raw`^\s*(?:export\s+)?enum\s+${s}\b`,
    String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+${s}\b`,
  ];

  if (
    [
      "javascript",
      "typescript",
      "javascriptreact",
      "typescriptreact",
      "jsx",
      "tsx",
      "vue",
      "svelte",
      "astro",
    ].includes(lang)
  ) {
    return jsLike;
  }
  if (lang === "python") {
    return [
      String.raw`^\s*(?:async\s+)?def\s+${s}\b`,
      String.raw`^\s*class\s+${s}\b`,
      String.raw`^\s*${s}\s*=`,
    ];
  }
  if (lang === "rust") {
    return [
      String.raw`^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+${s}\b`,
      String.raw`^\s*(?:pub(?:\([^)]+\))?\s+)?struct\s+${s}\b`,
      String.raw`^\s*(?:pub(?:\([^)]+\))?\s+)?enum\s+${s}\b`,
      String.raw`^\s*(?:pub(?:\([^)]+\))?\s+)?trait\s+${s}\b`,
      String.raw`^\s*(?:pub(?:\([^)]+\))?\s+)?mod\s+${s}\b`,
      String.raw`^\s*(?:pub(?:\([^)]+\))?\s+)?(?:const|static)\s+${s}\b`,
    ];
  }
  if (lang === "go") {
    return [
      String.raw`^\s*func\s+(?:\([^)]+\)\s+)?${s}\b`,
      String.raw`^\s*type\s+${s}\b`,
      String.raw`^\s*(?:const|var)\s+${s}\b`,
    ];
  }
  if (["java", "kotlin", "csharp", "swift"].includes(lang)) {
    return [
      String.raw`^\s*(?:public|private|protected|internal|open|final|static|\s)*\b(?:class|interface|enum|struct|object|protocol)\s+${s}\b`,
      String.raw`^\s*(?:public|private|protected|internal|open|final|static|\s)*\b(?:fun|func)\s+${s}\b`,
      String.raw`^\s*(?:public|private|protected|internal|static|\s)*\b(?:const|let|var|val)\s+${s}\b`,
    ];
  }
  if (["c", "cpp"].includes(lang)) {
    return [
      String.raw`^\s*(?:class|struct|enum|typedef)\s+${s}\b`,
      String.raw`^\s*(?:[\w:*&<>,\s]+)\s+${s}\s*\(`,
      String.raw`^\s*(?:#define|const|static)\s+${s}\b`,
    ];
  }
  if (lang === "php") {
    return [
      String.raw`^\s*(?:final\s+|abstract\s+)?(?:class|interface|trait|enum)\s+${s}\b`,
      String.raw`^\s*(?:public|private|protected|static|\s)*function\s+${s}\b`,
      String.raw`^\s*\$${s}\s*=`,
    ];
  }
  if (lang === "ruby") {
    return [
      String.raw`^\s*def\s+${s}\b`,
      String.raw`^\s*class\s+${s}\b`,
      String.raw`^\s*module\s+${s}\b`,
    ];
  }

  return [
    ...jsLike,
    String.raw`^\s*(?:async\s+)?def\s+${s}\b`,
    String.raw`^\s*(?:pub\s+)?fn\s+${s}\b`,
    String.raw`^\s*func\s+(?:\([^)]+\)\s+)?${s}\b`,
    String.raw`^\s*(?:class|interface|enum|struct|trait|object)\s+${s}\b`,
  ];
}

export function findLocalDefinitions(
  source: string,
  symbol: string,
  language: string,
): LocalDefinition[] {
  const patterns = definitionSearchPatterns(symbol, language).map(
    (p) => new RegExp(p),
  );
  if (patterns.length === 0) return [];
  const lines = source.split("\n");
  const out: LocalDefinition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!patterns.some((p) => p.test(text))) continue;
    out.push({
      line: i + 1,
      column: Math.max(1, text.indexOf(symbol) + 1),
      text: text.trim(),
    });
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
