import { ipc, type FileHit } from "@/lib/ipc";
import type { Reference } from "@/store/chat";

const FILE_EXTENSIONS = [
  "astro",
  "bash",
  "c",
  "cc",
  "cjs",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "cxx",
  "env",
  "fish",
  "go",
  "gradle",
  "h",
  "hh",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "m",
  "md",
  "mdx",
  "mjs",
  "mm",
  "php",
  "ps1",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
] as const;

const FILE_MENTION_RE = new RegExp(
  String.raw`(?:^|[\s([{"'` + "`" + String.raw`])((?:~?\.{0,2}\/|\/)?(?:[A-Za-z0-9_@+()[\].-]+\/)*[A-Za-z0-9_@+()[\].-]+\.(` +
    FILE_EXTENSIONS.join("|") +
    String.raw`))(?:$|[\s)\]}",'` +
    "`" +
    String.raw`:;.!?])`,
  "gi",
);

export type ImplicitContextOptions = {
  existingRefs?: Reference[];
  activePath?: string | null;
  openTabs?: string[];
  maxFiles?: number;
  searchFiles?: (query: string, limit?: number) => Promise<FileHit[]>;
};

export function extractFileMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(FILE_MENTION_RE)) {
    const raw = match[1]?.trim();
    if (!raw || /^https?:\/\//i.test(raw)) continue;
    const token = raw.replace(/^[`'"]+|[`'"]+$/g, "");
    const key = normalizePath(token).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

export async function inferImplicitFileReferences(
  text: string,
  opts: ImplicitContextOptions = {},
): Promise<Reference[]> {
  const mentions = extractFileMentions(text);
  if (mentions.length === 0) return [];

  const existing = new Set(
    (opts.existingRefs ?? [])
      .filter((r) => r.kind === "file" || r.kind === "selection")
      .map((r) => normalizePath(r.path).toLowerCase()),
  );
  const existingBasenames = new Set(
    (opts.existingRefs ?? [])
      .filter((r) => r.kind === "file" || r.kind === "selection")
      .map((r) => basename(r.path).toLowerCase()),
  );
  const result: Reference[] = [];
  const emitted = new Set<string>();
  const searchFiles = opts.searchFiles ?? ipc.searchFiles;
  const maxFiles = opts.maxFiles ?? 3;

  for (const mention of mentions) {
    if (result.length >= maxFiles) break;
    const normalizedMention = normalizePath(mention);
    const mentionKey = normalizedMention.toLowerCase();
    const mentionBase = basename(mentionKey);
    if (existing.has(mentionKey) || existingBasenames.has(mentionBase)) {
      continue;
    }

    const candidates = new Map<string, string>();
    for (const path of [opts.activePath, ...(opts.openTabs ?? [])]) {
      if (path) candidates.set(normalizePath(path).toLowerCase(), path);
    }

    try {
      const hits = await searchFiles(mention, 25);
      for (const hit of hits) {
        candidates.set(normalizePath(hit.path).toLowerCase(), hit.path);
      }
    } catch {
      // File mention resolution is opportunistic. If search is unavailable,
      // the assistant still has the normal current-file fallback.
    }

    const picked = pickFileCandidate(mention, [...candidates.values()], {
      activePath: opts.activePath,
      openTabs: opts.openTabs ?? [],
    });
    if (!picked) continue;
    const pickedKey = normalizePath(picked).toLowerCase();
    if (existing.has(pickedKey) || emitted.has(pickedKey)) continue;
    emitted.add(pickedKey);
    result.push({ kind: "file", path: picked });
  }

  return result;
}

export function mergeReferences(
  explicitRefs: Reference[],
  implicitRefs: Reference[],
): Reference[] {
  const seen = new Set<string>();
  const out: Reference[] = [];
  for (const ref of [...explicitRefs, ...implicitRefs]) {
    const key = referenceKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function pickFileCandidate(
  mention: string,
  candidates: string[],
  opts: { activePath?: string | null; openTabs: string[] },
): string | null {
  const token = normalizePath(mention).toLowerCase();
  const tokenBase = basename(token);
  const hasDir = token.includes("/");
  const matches = candidates.filter((path) => {
    const normalized = normalizePath(path).toLowerCase();
    if (hasDir) return normalized === token || normalized.endsWith(`/${token}`);
    return basename(normalized) === tokenBase;
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  const active = opts.activePath
    ? matches.find(
        (path) => normalizePath(path).toLowerCase() === normalizePath(opts.activePath!).toLowerCase(),
      )
    : null;
  if (active) return active;

  const open = matches.filter((path) =>
    opts.openTabs.some(
      (tab) => normalizePath(tab).toLowerCase() === normalizePath(path).toLowerCase(),
    ),
  );
  if (open.length === 1) return open[0];

  return null;
}

function referenceKey(ref: Reference): string {
  if (ref.kind === "file" || ref.kind === "folder" || ref.kind === "symbol") {
    return `${ref.kind}:${normalizePath(ref.path).toLowerCase()}:${"name" in ref ? ref.name : ""}`;
  }
  if (ref.kind === "selection") {
    return `selection:${normalizePath(ref.path).toLowerCase()}:${ref.startLine}:${ref.endLine}`;
  }
  if (ref.kind === "diagnostic") {
    return `diagnostic:${normalizePath(ref.path).toLowerCase()}:${ref.startLine}:${ref.startCol}:${ref.message}`;
  }
  if (ref.kind === "breakpoint") {
    return `breakpoint:${normalizePath(ref.path).toLowerCase()}:${ref.line}:${ref.condition ?? ""}:${ref.logMessage ?? ""}`;
  }
  if (ref.kind === "debugValue") {
    return `debugValue:${ref.name}:${ref.type ?? ""}:${ref.path ? normalizePath(ref.path).toLowerCase() : ""}:${ref.line ?? ""}`;
  }
  if (ref.kind === "codebase") return `codebase:${ref.query}`;
  return `processed:${normalizePath(ref.path).toLowerCase()}:${ref.label}`;
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}
