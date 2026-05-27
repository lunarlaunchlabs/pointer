import { stat } from "@tauri-apps/plugin-fs";

export type PathTarget = {
  raw: string;
  startColumn: number;
  endColumn: number;
};

export type ResolvedPathTarget = {
  path: string;
  target: PathTarget;
};

const SOURCE_EXTS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mts",
  "cts",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "css",
  "scss",
  "sass",
  "less",
  "md",
  "mdx",
  "vue",
  "svelte",
  "astro",
  "rs",
  "go",
  "py",
  "rb",
  "php",
  "java",
  "kt",
  "kts",
  "swift",
  "cs",
  "fs",
  "fsx",
  "cpp",
  "c",
  "h",
  "hpp",
  "hxx",
  "toml",
  "yaml",
  "yml",
  "ejs",
  "tmpl",
  "hbs",
  "handlebars",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
];

const INDEX_EXTS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "mdx",
  "vue",
  "svelte",
  "astro",
];

/**
 * Extract a navigable path-like token under a 1-based Monaco column.
 * Handles import strings, require() strings, markdown link destinations,
 * and pasted stack-trace-ish bare paths.
 */
export function extractPathTarget(line: string, column: number): PathTarget | null {
  const index = Math.max(0, column - 1);

  const quoted = /(['"`])([^'"`]+?)\1/g;
  for (const match of line.matchAll(quoted)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (index < start + 1 || index > end - 1) continue;
    const raw = match[2];
    if (!isNavigableSpecifier(raw)) return null;
    return {
      raw,
      startColumn: start + 2,
      endColumn: end,
    };
  }

  const mdLink = /\]\(([^)\s]+)\)/g;
  for (const match of line.matchAll(mdLink)) {
    const start = (match.index ?? 0) + 2;
    const end = start + match[1].length;
    if (index < start || index > end) continue;
    const raw = match[1];
    if (!isNavigableSpecifier(raw)) return null;
    return {
      raw,
      startColumn: start + 1,
      endColumn: end + 1,
    };
  }

  const bare = tokenAround(line, index);
  if (!bare) return null;
  if (!isNavigableSpecifier(bare.text)) return null;
  return {
    raw: bare.text,
    startColumn: bare.start + 1,
    endColumn: bare.end + 1,
  };
}

export function isNavigableSpecifier(raw: string): boolean {
  const spec = stripTargetDecorations(raw.trim());
  if (!spec) return false;
  if (/^(https?:|mailto:|data:|blob:)/i.test(spec)) return false;
  if (spec.startsWith("file://")) return true;
  if (spec.startsWith("./") || spec.startsWith("../")) return true;
  if (spec.startsWith("/") || spec.startsWith("~/") || spec.startsWith("@/")) return true;
  if (spec.includes("/") && hasKnownExtension(spec)) return true;
  // Common tsconfig/vite baseUrl import: "src/components/Button".
  if (/^(src|app|lib|components|pages|routes|server|client|test|tests)\//.test(spec)) {
    return true;
  }
  return false;
}

export async function resolvePathTarget(
  opts: {
    target: PathTarget;
    sourcePath: string;
    workspaceRoot: string | null;
    exists?: (path: string) => Promise<"file" | "dir" | null>;
  },
): Promise<ResolvedPathTarget | null> {
  const exists = opts.exists ?? defaultExists;
  for (const candidate of candidatePaths(
    opts.target.raw,
    opts.sourcePath,
    opts.workspaceRoot,
  )) {
    const kind = await exists(candidate);
    if (kind === "file") return { path: candidate, target: opts.target };
  }
  return null;
}

export function candidatePaths(
  raw: string,
  sourcePath: string,
  workspaceRoot: string | null,
): string[] {
  const spec = stripTargetDecorations(raw.trim());
  const root = workspaceRoot ? normalizePath(workspaceRoot) : null;
  const sourceDir = dirname(normalizePath(sourcePath));
  const bases: string[] = [];

  if (spec.startsWith("file://")) {
    bases.push(normalizePath(decodeURIComponent(spec.replace(/^file:\/\//, ""))));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    bases.push(joinPath(sourceDir, spec));
    if (root && hasKnownExtension(spec)) {
      bases.push(...publicAssetCandidates(root, spec));
    }
  } else if (spec.startsWith("@/")) {
    if (root) {
      bases.push(joinPath(root, "src", spec.slice(2)));
      bases.push(joinPath(root, spec.slice(2)));
    }
  } else if (spec.startsWith("~/")) {
    if (root) {
      bases.push(joinPath(root, spec.slice(2)));
      bases.push(joinPath(root, "src", spec.slice(2)));
    }
  } else if (spec.startsWith("/")) {
    if (root && !normalizePath(spec).startsWith(root)) {
      bases.push(joinPath(root, spec.replace(/^\/+/, "")));
      bases.push(joinPath(root, "public", spec.replace(/^\/+/, "")));
    }
    bases.push(normalizePath(spec));
  } else if (root) {
    bases.push(joinPath(root, spec));
    if (!spec.startsWith("src/")) bases.push(joinPath(root, "src", spec));
    if (hasKnownExtension(spec)) {
      bases.push(...publicAssetCandidates(root, spec));
    }
  }

  const out: string[] = [];
  for (const base of dedupe(bases.map(normalizePath))) {
    out.push(...expandCandidate(base));
  }
  return dedupe(out);
}

function publicAssetCandidates(root: string, spec: string): string[] {
  const webPath = spec
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(?:\.\.\/)+/, "")
    .replace(/^(?:\.\/)+/, "");
  if (!webPath) return [];
  if (webPath.startsWith("public/")) return [joinPath(root, webPath)];
  return [joinPath(root, "public", webPath)];
}

function expandCandidate(base: string): string[] {
  const out = [base];
  const ext = extensionOf(base);
  if (ext) {
    if (["js", "jsx", "mjs", "cjs"].includes(ext)) {
      const without = base.slice(0, -ext.length - 1);
      out.push(`${without}.ts`, `${without}.tsx`, `${without}.js`, `${without}.jsx`);
    }
    return [...out, ...INDEX_EXTS.map((x) => joinPath(base, `index.${x}`))];
  }
  for (const x of SOURCE_EXTS) out.push(`${base}.${x}`);
  for (const x of INDEX_EXTS) out.push(joinPath(base, `index.${x}`));
  return out;
}

function tokenAround(line: string, index: number): { text: string; start: number; end: number } | null {
  const isStop = (ch: string) => /[\s'"`(){}[\]<>,;]/.test(ch);
  let start = index;
  let end = index;
  while (start > 0 && !isStop(line[start - 1])) start--;
  while (end < line.length && !isStop(line[end])) end++;
  const text = line.slice(start, end).trim();
  if (!text) return null;
  return { text, start, end };
}

function stripTargetDecorations(raw: string): string {
  let s = raw.trim();
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/:(\d+)(?::\d+)?$/, "");
  return s;
}

function hasKnownExtension(path: string): boolean {
  const ext = extensionOf(path);
  return !!ext && SOURCE_EXTS.includes(ext);
}

function extensionOf(path: string): string | null {
  const name = basename(path);
  const match = /\.([^.\\/]+)$/.exec(name);
  return match ? match[1].toLowerCase() : null;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized.startsWith("/") ? "/" : ".";
  return normalized.slice(0, idx);
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/");
  return normalizePath(joined);
}

function normalizePath(path: string): string {
  const raw = path.replace(/\\/g, "/");
  const absolute = raw.startsWith("/");
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}` || (absolute ? "/" : ".");
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

async function defaultExists(path: string): Promise<"file" | "dir" | null> {
  try {
    const meta = await stat(path);
    if (meta.isDirectory) return "dir";
    if (meta.isFile) return "file";
    return null;
  } catch {
    return null;
  }
}
