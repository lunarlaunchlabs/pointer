export type VueSymbolKind =
  | "component"
  | "computed"
  | "data"
  | "method"
  | "prop"
  | "ref"
  | "setup";

export type VueSymbol = {
  name: string;
  kind: VueSymbolKind;
  line: number;
  column: number;
};

export function collectVueSymbols(source: string): VueSymbol[] {
  const symbols: VueSymbol[] = [];
  const push = (name: string, kind: VueSymbolKind, index: number) => {
    if (!isIdentifierLike(name)) return;
    const pos = positionAt(source, index);
    symbols.push({ name, kind, line: pos.line, column: pos.column });
  };

  for (const block of scriptBlocks(source)) {
    const body = block.body;
    const base = block.bodyStart;
    for (const match of body.matchAll(/\bimport\s+([A-Z][A-Za-z0-9_$]*)\s+from\s+["'][^"']+\.vue["']/g)) {
      push(match[1], "component", base + match.index! + match[0].indexOf(match[1]));
    }
    if (block.setup) {
      for (const match of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
        push(match[1], "setup", base + match.index! + match[0].indexOf(match[1]));
      }
      for (const match of body.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
        push(match[1], "method", base + match.index! + match[0].indexOf(match[1]));
      }
      continue;
    }

    for (const item of sectionKeys(source, body, base, "components")) {
      push(item.name, "component", item.index);
    }
    for (const item of sectionKeys(source, body, base, "computed")) {
      push(item.name, "computed", item.index);
    }
    for (const item of sectionKeys(source, body, base, "methods")) {
      push(item.name, "method", item.index);
    }
    for (const item of dataKeys(source, body, base)) {
      push(item.name, "data", item.index);
    }
    for (const item of propsKeys(source, body, base)) {
      push(item.name, "prop", item.index);
    }
  }

  for (const match of source.matchAll(/\bref=["']([A-Za-z_$][\w$-]*)["']/g)) {
    push(match[1], "ref", match.index! + match[0].indexOf(match[1]));
  }

  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.kind}:${symbol.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function vueCompletionSymbolsForPosition(
  source: string,
  line: number,
  column: number,
): VueSymbol[] {
  const offset = offsetAt(source, line, column);
  const before = source.slice(Math.max(0, offset - 120), offset);
  const symbols = collectVueSymbols(source);
  const inTemplate = rangeForTag(source, "template").some(
    (range) => offset >= range.start && offset <= range.end,
  );

  if (/\bthis\.[A-Za-z_$][\w$]*$/.test(before) || /\bthis\.$/.test(before)) {
    return symbols.filter((s) =>
      ["computed", "data", "method", "prop", "ref"].includes(s.kind),
    );
  }

  if (inTemplate && /<([A-Z][\w.-]*)?$/.test(before)) {
    return symbols.filter((s) => s.kind === "component");
  }

  if (
    inTemplate &&
    (/\{\{[^}]*$/.test(before) ||
      /[:@#A-Za-z0-9_-]+=["'][^"']*$/.test(before) ||
      /[A-Za-z_$][\w$]*$/.test(before))
  ) {
    return symbols.filter((s) => s.kind !== "component" || /^[A-Z]/.test(s.name));
  }

  return [];
}

export function vueOutlineSymbols(source: string): VueSymbol[] {
  return collectVueSymbols(source).filter((s) => s.kind !== "ref");
}

function scriptBlocks(source: string) {
  const blocks: { setup: boolean; body: string; bodyStart: number }[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of source.matchAll(re)) {
    blocks.push({
      setup: /\bsetup\b/.test(match[1]),
      body: match[2],
      bodyStart: match.index! + match[0].indexOf(match[2]),
    });
  }
  return blocks;
}

function sectionKeys(
  source: string,
  script: string,
  base: number,
  section: string,
): { name: string; index: number }[] {
  const start = findObjectAfter(script, new RegExp(`\\b${section}\\s*:`));
  if (!start) return [];
  return topLevelObjectKeys(start.body).map((item) => ({
    name: item.name,
    index: base + start.bodyStart + item.index,
  }));
}

function dataKeys(source: string, script: string, base: number) {
  void source;
  const dataMatch = /\bdata\s*\([^)]*\)\s*\{/.exec(script);
  if (!dataMatch) return [];
  const bodyOpen = script.indexOf("{", dataMatch.index);
  const bodyClose = findMatching(script, bodyOpen, "{", "}");
  if (bodyClose < 0) return [];
  const fnBody = script.slice(bodyOpen + 1, bodyClose);
  const returnMatch = /\breturn\s*\{/.exec(fnBody);
  if (!returnMatch) return [];
  const objectOpen = bodyOpen + 1 + returnMatch.index + returnMatch[0].lastIndexOf("{");
  const objectClose = findMatching(script, objectOpen, "{", "}");
  if (objectClose < 0) return [];
  const body = script.slice(objectOpen + 1, objectClose);
  return topLevelObjectKeys(body).map((item) => ({
    name: item.name,
    index: base + objectOpen + 1 + item.index,
  }));
}

function propsKeys(source: string, script: string, base: number) {
  void source;
  const section = /\bprops\s*:/.exec(script);
  if (!section) return [];
  let i = script.indexOf(":", section.index) + 1;
  while (/\s/.test(script[i] ?? "")) i++;
  if (script[i] === "{") {
    const close = findMatching(script, i, "{", "}");
    if (close < 0) return [];
    return topLevelObjectKeys(script.slice(i + 1, close)).map((item) => ({
      name: item.name,
      index: base + i + 1 + item.index,
    }));
  }
  if (script[i] === "[") {
    const close = findMatching(script, i, "[", "]");
    if (close < 0) return [];
    const body = script.slice(i + 1, close);
    return [...body.matchAll(/["']([A-Za-z_$][\w$-]*)["']/g)].map((m) => ({
      name: m[1],
      index: base + i + 1 + m.index! + m[0].indexOf(m[1]),
    }));
  }
  return [];
}

function findObjectAfter(script: string, sectionRe: RegExp) {
  const match = sectionRe.exec(script);
  if (!match) return null;
  const open = script.indexOf("{", match.index + match[0].length);
  if (open < 0) return null;
  const close = findMatching(script, open, "{", "}");
  if (close < 0) return null;
  return {
    body: script.slice(open + 1, close),
    bodyStart: open + 1,
  };
}

function topLevelObjectKeys(body: string) {
  const keys: { name: string; index: number }[] = [];
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(body, i);
      continue;
    }
    if (body.startsWith("//", i)) {
      i = body.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (body.startsWith("/*", i)) {
      i = body.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 2;
      continue;
    }
    if (depth === 0 && /[A-Za-z_$'"]/.test(ch)) {
      const parsed = parseKeyAt(body, i);
      if (parsed) {
        keys.push({ name: parsed.name, index: parsed.index });
        i = parsed.next;
        continue;
      }
    }
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth = Math.max(0, depth - 1);
    i++;
  }
  return keys;
}

function parseKeyAt(body: string, start: number) {
  let i = start;
  if (body.startsWith("async", i) && /\s/.test(body[i + 5] ?? "")) {
    i += 5;
    while (/\s/.test(body[i] ?? "")) i++;
  }
  let name = "";
  let nameIndex = i;
  if (body[i] === '"' || body[i] === "'") {
    const quote = body[i++];
    nameIndex = i;
    while (i < body.length && body[i] !== quote) name += body[i++];
    i++;
  } else {
    const match = /^[A-Za-z_$][\w$-]*/.exec(body.slice(i));
    if (!match) return null;
    name = match[0];
    i += name.length;
  }
  while (/\s/.test(body[i] ?? "")) i++;
  if (body[i] === ":" || body[i] === "(") {
    return { name, index: nameIndex, next: i + 1 };
  }
  return null;
}

function findMatching(source: string, open: number, left: string, right: string) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i) - 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      const next = source.indexOf("\n", i + 2);
      if (next < 0) break;
      i = next;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const next = source.indexOf("*/", i + 2);
      if (next < 0) break;
      i = next + 1;
      continue;
    }
    if (ch === left) depth++;
    else if (ch === right) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipString(source: string, start: number) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function rangeForTag(source: string, tag: string) {
  const ranges: { start: number; end: number }[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  for (const match of source.matchAll(re)) {
    const bodyStart = match.index! + match[0].indexOf(match[1]);
    ranges.push({ start: bodyStart, end: bodyStart + match[1].length });
  }
  return ranges;
}

function positionAt(source: string, index: number) {
  const before = source.slice(0, index).split("\n");
  return { line: before.length, column: before[before.length - 1].length + 1 };
}

function offsetAt(source: string, line: number, column: number) {
  const lines = source.split("\n");
  let offset = 0;
  for (let i = 0; i < Math.max(0, line - 1); i++) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  return offset + Math.max(0, column - 1);
}

function isIdentifierLike(name: string) {
  return /^[A-Za-z_$][\w$-]*$/.test(name);
}
