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
    if (
      !isNavigableSpecifier(raw, {
        allowPackage: isImportLikeSpecifierContext(line, start),
      })
    ) {
      return null;
    }
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

export function isNavigableSpecifier(
  raw: string,
  opts: { allowPackage?: boolean } = {},
): boolean {
  const spec = stripTargetDecorations(raw.trim());
  if (!spec) return false;
  if (/^(https?:|mailto:|data:|blob:)/i.test(spec)) return false;
  if (spec.startsWith("file://")) return true;
  if (spec.startsWith("./") || spec.startsWith("../")) return true;
  if (spec.startsWith("/") || spec.startsWith("~/") || spec.startsWith("@/")) return true;
  if (spec.includes("/") && hasKnownExtension(spec)) return true;
  if (opts.allowPackage && isPackageSpecifier(spec)) return true;
  // Common tsconfig/vite baseUrl import: "src/components/Button".
  if (isWorkspaceRootSpecifier(spec)) {
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
    readTextFile?: (path: string) => Promise<string>;
  },
): Promise<ResolvedPathTarget | null> {
  const exists = opts.exists ?? defaultExists;
  const configured = await configuredCandidatePaths(
    opts.target.raw,
    opts.sourcePath,
    opts.workspaceRoot,
    opts.readTextFile ?? defaultReadTextFile,
  );
  const candidates = dedupe([
    ...configured,
    ...candidatePaths(opts.target.raw, opts.sourcePath, opts.workspaceRoot),
  ]);
  for (const candidate of candidates) {
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
    if (isWorkspaceRootSpecifier(spec)) {
      bases.push(joinPath(root, spec));
      if (!spec.startsWith("src/")) bases.push(joinPath(root, "src", spec));
    } else if (isPackageSpecifier(spec)) {
      bases.push(...packageImportCandidates(root, spec));
    } else {
      bases.push(joinPath(root, spec));
      if (!spec.startsWith("src/")) bases.push(joinPath(root, "src", spec));
    }
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

function packageImportCandidates(root: string, spec: string): string[] {
  const { packageName, subpath } = splitPackageSpecifier(spec);
  if (!packageName) return [];
  const packageRoot = joinPath(root, "node_modules", packageName);
  if (subpath) {
    return [joinPath(packageRoot, subpath)];
  }
  return [
    joinPath(packageRoot, "package.json"),
    joinPath(packageRoot, "index"),
    joinPath(packageRoot, "src", "index"),
    joinPath(packageRoot, "dist", "index"),
  ];
}

async function configuredCandidatePaths(
  raw: string,
  sourcePath: string,
  workspaceRoot: string | null,
  readTextFile: (path: string) => Promise<string>,
): Promise<string[]> {
  const spec = stripTargetDecorations(raw.trim());
  const root = workspaceRoot ? normalizePath(workspaceRoot) : null;
  if (!root || !spec) return [];
  const sourceDir = dirname(normalizePath(sourcePath));
  const candidates: string[] = [];
  const configs = await loadNavigationConfigs(root, sourceDir, readTextFile);

  for (const config of configs) {
    if (config.baseUrl) {
      candidates.push(joinPath(config.baseUrl, spec));
    }
    for (const mapping of config.paths) {
      const resolved = resolvePathMapping(spec, mapping);
      for (const target of resolved) candidates.push(target);
    }
    for (const alias of config.aliases) {
      const resolved = resolveAliasMapping(spec, alias);
      if (resolved) candidates.push(resolved);
    }
    for (const mapping of config.packageImports) {
      const resolved = resolvePathMapping(spec, mapping);
      for (const target of resolved) candidates.push(target);
    }
  }

  if (isPackageSpecifier(spec)) {
    candidates.push(...(await packageJsonCandidatePaths(root, spec, readTextFile)));
  }

  const out: string[] = [];
  for (const base of dedupe(candidates.map(normalizePath))) {
    out.push(...expandCandidate(base));
  }
  return dedupe(out);
}

type PathMapping = {
  pattern: string;
  targets: string[];
};

type AliasMapping = {
  find: string;
  replacement: string;
};

type NavigationConfig = {
  baseUrl: string | null;
  paths: PathMapping[];
  aliases: AliasMapping[];
  packageImports: PathMapping[];
};

async function loadNavigationConfigs(
  root: string,
  sourceDir: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<NavigationConfig[]> {
  const configs: NavigationConfig[] = [];
  const dirs = configSearchDirs(root, sourceDir);
  const seen = new Set<string>();

  for (const dir of dirs) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const path = joinPath(dir, name);
      if (seen.has(path)) continue;
      seen.add(path);
      const config = await loadTsLikeConfig(path, readTextFile);
      if (config) configs.push(config);
    }
  }

  for (const name of [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mts",
    "vite.config.mjs",
    "vitest.config.ts",
    "vitest.config.js",
    "webpack.config.ts",
    "webpack.config.js",
    "rollup.config.ts",
    "rollup.config.js",
  ]) {
    const path = joinPath(root, name);
    const text = await readMaybe(path, readTextFile);
    if (!text) continue;
    const aliases = parseResolverAliases(text, root);
    if (aliases.length > 0) {
      configs.push({ baseUrl: null, paths: [], aliases, packageImports: [] });
    }
  }

  const packageJson = await readPackageJson(root, readTextFile);
  if (packageJson) {
    const imports = packageJson.imports && typeof packageJson.imports === "object"
      ? Object.entries(packageJson.imports as Record<string, unknown>)
      : [];
    const packageImports = imports
      .map(([key, value]) => {
        const targets = stringTargetsFromPackageValue(value)
          .filter((target) => target.startsWith("."))
          .map((target) => joinPath(root, target));
        return targets.length > 0 ? { pattern: key, targets } : null;
      })
      .filter((item): item is PathMapping => !!item);
    if (packageImports.length > 0) {
      configs.push({ baseUrl: null, paths: [], aliases: [], packageImports });
    }
  }

  return configs;
}

function configSearchDirs(root: string, sourceDir: string): string[] {
  const dirs: string[] = [];
  let dir = normalizePath(sourceDir);
  const normalizedRoot = normalizePath(root);
  while (dir.startsWith(normalizedRoot)) {
    dirs.push(dir);
    if (dir === normalizedRoot) break;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  dirs.push(normalizedRoot);
  return dedupe(dirs);
}

async function loadTsLikeConfig(
  path: string,
  readTextFile: (path: string) => Promise<string>,
  seen = new Set<string>(),
): Promise<NavigationConfig | null> {
  if (seen.has(path)) return null;
  seen.add(path);
  const text = await readMaybe(path, readTextFile);
  if (!text) return null;
  const json = parseJsonLike(text);
  if (!json || typeof json !== "object") return null;

  const dir = dirname(path);
  const parent = await loadExtendsConfig(json, dir, readTextFile, seen);
  const parentCompilerOptions =
    parent?.compilerOptions && typeof parent.compilerOptions === "object"
      ? (parent.compilerOptions as Record<string, unknown>)
      : {};
  const localCompilerOptions =
    (json as Record<string, unknown>).compilerOptions &&
    typeof (json as Record<string, unknown>).compilerOptions === "object"
      ? ((json as Record<string, unknown>).compilerOptions as Record<string, unknown>)
      : {};
  const compilerOptions = {
    ...parentCompilerOptions,
    ...localCompilerOptions,
  };
  const baseUrlRaw =
    typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
  const baseUrl = baseUrlRaw.startsWith("/")
    ? normalizePath(baseUrlRaw)
    : joinPath(dir, baseUrlRaw);
  const pathsObj =
    compilerOptions.paths && typeof compilerOptions.paths === "object"
      ? (compilerOptions.paths as Record<string, unknown>)
      : {};
  const paths: PathMapping[] = [];
  for (const [pattern, rawTargets] of Object.entries(pathsObj)) {
    if (!Array.isArray(rawTargets)) continue;
    const targets = rawTargets
      .filter((target): target is string => typeof target === "string")
      .map((target) =>
        target.startsWith("/") ? normalizePath(target) : joinPath(baseUrl, target),
      );
    if (targets.length > 0) paths.push({ pattern, targets });
  }

  return {
    baseUrl,
    paths,
    aliases: [],
    packageImports: [],
  };
}

async function loadExtendsConfig(
  json: unknown,
  dir: string,
  readTextFile: (path: string) => Promise<string>,
  seen: Set<string>,
): Promise<Record<string, unknown> | null> {
  if (!json || typeof json !== "object") return null;
  const value = (json as Record<string, unknown>).extends;
  if (typeof value !== "string" || !value.trim()) return null;
  let extended = value.trim();
  if (!extended.endsWith(".json")) extended = `${extended}.json`;
  if (!extended.startsWith(".") && !extended.startsWith("/")) {
    extended = joinPath("node_modules", extended);
  }
  const path = extended.startsWith("/")
    ? normalizePath(extended)
    : joinPath(dir, extended);
  const loaded = await loadTsLikeConfig(path, readTextFile, seen);
  if (!loaded) return null;
  const compilerOptions: Record<string, unknown> = {};
  if (loaded.baseUrl) compilerOptions.baseUrl = loaded.baseUrl;
  if (loaded.paths.length > 0) {
    compilerOptions.paths = Object.fromEntries(
      loaded.paths.map((mapping) => [mapping.pattern, mapping.targets]),
    );
  }
  return { compilerOptions };
}

function resolvePathMapping(spec: string, mapping: PathMapping): string[] {
  const star = mapping.pattern.indexOf("*");
  if (star === -1) {
    if (spec !== mapping.pattern) return [];
    return mapping.targets;
  }
  const prefix = mapping.pattern.slice(0, star);
  const suffix = mapping.pattern.slice(star + 1);
  if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return [];
  const matched = spec.slice(prefix.length, spec.length - suffix.length);
  return mapping.targets.map((target) => target.replace(/\*/g, matched));
}

function resolveAliasMapping(spec: string, alias: AliasMapping): string | null {
  if (spec === alias.find) return alias.replacement;
  const prefix = alias.find.endsWith("/") ? alias.find : `${alias.find}/`;
  if (!spec.startsWith(prefix)) return null;
  return joinPath(alias.replacement, spec.slice(prefix.length));
}

function parseResolverAliases(text: string, root: string): AliasMapping[] {
  const aliases: AliasMapping[] = [];
  const pathProperty =
    /(?:["']([^"']+)["']|([A-Za-z_$@~][\w$@~/-]*))\s*:\s*(?:path\.)?(?:resolve|join)\s*\(\s*__dirname\s*,\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(pathProperty)) {
    const find = match[1] || match[2] || "";
    if (find) aliases.push({ find, replacement: joinPath(root, match[3]) });
  }

  const objectMatch = /alias\s*:\s*\{([\s\S]*?)\}/m.exec(text);
  if (objectMatch) {
    const body = objectMatch[1];
    const property = /(?:["']([^"']+)["']|([A-Za-z_$@~][\w$@~/-]*))\s*:\s*([^,\n}]+)/g;
    for (const match of body.matchAll(property)) {
      const find = match[1] || match[2] || "";
      const replacement = parseAliasReplacement(match[3], root);
      if (find && replacement) aliases.push({ find, replacement });
    }
  }

  const arrayPathEntry =
    /\{\s*find\s*:\s*["']([^"']+)["'][\s\S]*?replacement\s*:\s*(?:path\.)?(?:resolve|join)\s*\(\s*__dirname\s*,\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(arrayPathEntry)) {
    aliases.push({ find: match[1], replacement: joinPath(root, match[2]) });
  }

  const arrayEntry =
    /\{\s*find\s*:\s*["']([^"']+)["'][\s\S]*?replacement\s*:\s*([^,}]+)\}/g;
  for (const match of text.matchAll(arrayEntry)) {
    const replacement = parseAliasReplacement(match[2], root);
    if (replacement) aliases.push({ find: match[1], replacement });
  }
  return dedupeAliases(aliases);
}

function parseAliasReplacement(expr: string, root: string): string | null {
  const trimmed = expr.trim();
  const literal = /^["']([^"']+)["']/.exec(trimmed);
  if (literal) return aliasLiteralToPath(literal[1], root);

  const pathResolve =
    /(?:path\.)?resolve\s*\(\s*__dirname\s*,\s*["']([^"']+)["']\s*\)/.exec(trimmed) ??
    /(?:path\.)?join\s*\(\s*__dirname\s*,\s*["']([^"']+)["']\s*\)/.exec(trimmed);
  if (pathResolve) return joinPath(root, pathResolve[1]);

  const urlResolve = /new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/.exec(trimmed);
  if (urlResolve) return joinPath(root, urlResolve[1]);

  const dirnamePlus = /__dirname\s*\+\s*["']\/?([^"']+)["']/.exec(trimmed);
  if (dirnamePlus) return joinPath(root, dirnamePlus[1]);

  return null;
}

function aliasLiteralToPath(value: string, root: string): string {
  if (value.startsWith("/")) return normalizePath(value);
  return joinPath(root, value);
}

function dedupeAliases(aliases: AliasMapping[]): AliasMapping[] {
  const seen = new Set<string>();
  const out: AliasMapping[] = [];
  for (const alias of aliases) {
    const key = `${alias.find}\0${alias.replacement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

async function packageJsonCandidatePaths(
  root: string,
  spec: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<string[]> {
  const { packageName, subpath } = splitPackageSpecifier(spec);
  if (!packageName) return [];
  const packageRoot = joinPath(root, "node_modules", packageName);
  const packageJson = await readPackageJson(packageRoot, readTextFile);
  if (!packageJson) return [];

  const out: string[] = [];
  if (subpath) {
    out.push(...packageExportTargets(packageJson.exports, `./${subpath}`, packageRoot));
    out.push(joinPath(packageRoot, subpath));
    return out;
  }

  out.push(...packageExportTargets(packageJson.exports, ".", packageRoot));
  for (const field of ["types", "typings", "module", "browser", "main"]) {
    const value = (packageJson as Record<string, unknown>)[field];
    if (typeof value === "string") out.push(joinPath(packageRoot, value));
  }
  out.push(joinPath(packageRoot, "package.json"));
  return dedupe(out);
}

function packageExportTargets(exportsValue: unknown, subpath: string, packageRoot: string): string[] {
  const out: string[] = [];
  if (typeof exportsValue === "string" && subpath === ".") {
    out.push(joinPath(packageRoot, exportsValue));
  } else if (exportsValue && typeof exportsValue === "object") {
    const entries = exportsValue as Record<string, unknown>;
    if (subpath === "." && !Object.keys(entries).some((key) => key.startsWith("."))) {
      out.push(
        ...stringTargetsFromPackageValue(entries).map((target) =>
          joinPath(packageRoot, target),
        ),
      );
      return out;
    }
    if (subpath in entries) {
      out.push(
        ...stringTargetsFromPackageValue(entries[subpath]).map((target) =>
          joinPath(packageRoot, target),
        ),
      );
    }
    for (const [pattern, value] of Object.entries(entries)) {
      if (!pattern.includes("*")) continue;
      const mapping = { pattern, targets: stringTargetsFromPackageValue(value) };
      out.push(
        ...resolvePathMapping(subpath, mapping).map((target) =>
          joinPath(packageRoot, target),
        ),
      );
    }
  }
  return out.filter((candidate) => !candidate.includes("/node_modules/undefined/"));
}

function stringTargetsFromPackageValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringTargetsFromPackageValue);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = ["types", "import", "module", "browser", "default", "require", "node"];
    return keys.flatMap((key) => stringTargetsFromPackageValue(obj[key]));
  }
  return [];
}

async function readPackageJson(
  dir: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<Record<string, unknown> | null> {
  const text = await readMaybe(joinPath(dir, "package.json"), readTextFile);
  const parsed = text ? parseJsonLike(text) : null;
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
}

async function readMaybe(
  path: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<string | null> {
  try {
    return await readTextFile(path);
  } catch {
    return null;
  }
}

function parseJsonLike(text: string): unknown | null {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function splitPackageSpecifier(spec: string): {
  packageName: string;
  subpath: string;
} {
  const parts = spec.split("/").filter(Boolean);
  if (parts.length === 0) return { packageName: "", subpath: "" };
  const scoped = parts[0].startsWith("@");
  const packageName = scoped ? parts.slice(0, 2).join("/") : parts[0];
  const subpath = parts.slice(scoped ? 2 : 1).join("/");
  return { packageName, subpath };
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
  s = s.startsWith("#") ? s.replace(/\?.*$/, "") : s.replace(/[?#].*$/, "");
  s = s.replace(/:(\d+)(?::\d+)?$/, "");
  return s;
}

function isImportLikeSpecifierContext(line: string, quoteStart: number): boolean {
  const before = line.slice(0, quoteStart);
  return /(?:\bimport\s*(?:\(|[^;]*\bfrom\s*)|\bexport\s+[^;]*\bfrom\s*|\brequire\s*\(|\bjest\.mock\s*\(|\bvi\.mock\s*\()$/.test(
    before,
  );
}

function isPackageSpecifier(spec: string): boolean {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~/")) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return false;
  if (/^#[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?$/.test(spec)) return true;
  if (/^~[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?$/.test(spec)) return true;
  return /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?$/.test(
    spec,
  );
}

function isWorkspaceRootSpecifier(spec: string): boolean {
  return /^(src|app|lib|components|pages|routes|server|client|test|tests)\//.test(spec);
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

async function defaultReadTextFile(path: string): Promise<string> {
  const { ipc } = await import("./ipc");
  return ipc.readTextFile(path);
}
