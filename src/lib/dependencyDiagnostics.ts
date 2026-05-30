import pathLib from "@/lib/path";
import { ipc } from "@/lib/ipc";

export type DependencyDiagnosticSeverity = "error" | "warning" | "info";

export type DependencyDiagnostic = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  severity: DependencyDiagnosticSeverity;
  message: string;
  source: "pointer-deps";
  code: "POINTER_DEP_MISSING";
};

type Ecosystem =
  | "js"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "csharp"
  | "php"
  | "ruby"
  | "dart"
  | "swift";

type DependencyRef = {
  ecosystem: Ecosystem;
  name: string;
  display: string;
  line: number;
  startColumn: number;
  endColumn: number;
};

type Registry = {
  manifests: string[];
  js: Set<string>;
  python: Set<string>;
  rust: Set<string>;
  go: Set<string>;
  java: Set<string>;
  csharp: Set<string>;
  php: Set<string>;
  ruby: Set<string>;
  dart: Set<string>;
  swift: Set<string>;
};

type ManifestReader = (path: string) => Promise<string | null>;
type DirectoryReader = (
  path: string,
) => Promise<Array<{ name: string; path?: string; is_dir?: boolean }> | null>;

const DEPENDENCY_MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Directory.Packages.props",
  "composer.json",
  "Gemfile",
  "pubspec.yaml",
  "Package.swift",
]);

const DOTNET_PROJECT_RE = /\.(?:csproj|fsproj|vbproj|vcxproj)$/i;
const MANIFESTS_BY_ECOSYSTEM: Record<Ecosystem, string[]> = {
  js: ["package.json"],
  python: ["pyproject.toml", "requirements.txt", "requirements-dev.txt"],
  rust: ["Cargo.toml"],
  go: ["go.mod"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
  csharp: ["Directory.Packages.props"],
  php: ["composer.json"],
  ruby: ["Gemfile"],
  dart: ["pubspec.yaml"],
  swift: ["Package.swift"],
};

const PYTHON_STDLIB = new Set([
  "__future__",
  "abc",
  "argparse",
  "asyncio",
  "collections",
  "contextlib",
  "csv",
  "dataclasses",
  "datetime",
  "decimal",
  "email",
  "enum",
  "functools",
  "glob",
  "hashlib",
  "http",
  "importlib",
  "inspect",
  "itertools",
  "json",
  "logging",
  "math",
  "os",
  "pathlib",
  "re",
  "shutil",
  "sqlite3",
  "statistics",
  "string",
  "subprocess",
  "sys",
  "tempfile",
  "threading",
  "time",
  "typing",
  "unittest",
  "urllib",
  "uuid",
  "xml",
  "zipfile",
]);

const RUST_BUILTINS = new Set(["alloc", "core", "crate", "self", "std", "super"]);
const GO_STDLIB_FIRST_SEGMENTS = new Set([
  "archive",
  "bufio",
  "bytes",
  "cmp",
  "compress",
  "container",
  "context",
  "crypto",
  "database",
  "debug",
  "embed",
  "encoding",
  "errors",
  "expvar",
  "flag",
  "fmt",
  "go",
  "hash",
  "html",
  "image",
  "index",
  "io",
  "log",
  "maps",
  "math",
  "mime",
  "net",
  "os",
  "path",
  "reflect",
  "regexp",
  "runtime",
  "slices",
  "sort",
  "strconv",
  "strings",
  "sync",
  "testing",
  "text",
  "time",
  "unicode",
  "unsafe",
]);
const JAVA_STDLIB_PREFIXES = ["java.", "javax.", "jdk.", "sun."];
const CSHARP_STDLIB_PREFIXES = ["System", "Microsoft"];

export function isDependencyManifestPath(path: string): boolean {
  return isDependencyManifestName(pathLib.basename(path));
}

export async function dependencyDiagnosticsForFile(opts: {
  path: string;
  language: string;
  content: string;
  workspaceRoot: string | null;
  readFile?: ManifestReader;
  listDir?: DirectoryReader;
}): Promise<DependencyDiagnostic[]> {
  if (!opts.workspaceRoot || opts.path.startsWith("untitled:")) return [];
  const refs = extractDependencyRefs(opts.language, opts.content);
  if (refs.length === 0) return [];
  const ecosystems = new Set(refs.map((ref) => ref.ecosystem));

  const readFile = opts.readFile ?? readTextFileIfPresent;
  const listDir = opts.listDir ?? listDirIfPresent;
  const registry = await buildRegistryForFile(
    opts.path,
    opts.workspaceRoot,
    readFile,
    listDir,
    ecosystems,
  );
  const diagnostics: DependencyDiagnostic[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (!shouldCheckRef(ref, registry)) continue;
    const key = `${ref.ecosystem}:${ref.name}:${ref.line}:${ref.startColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (dependencyIsKnown(ref, registry)) continue;
    diagnostics.push({
      startLine: ref.line,
      startColumn: ref.startColumn,
      endLine: ref.line,
      endColumn: ref.endColumn,
      severity: "warning",
      source: "pointer-deps",
      code: "POINTER_DEP_MISSING",
      message: missingMessage(ref, registry),
    });
  }

  return diagnostics;
}

async function readTextFileIfPresent(path: string): Promise<string | null> {
  try {
    return await ipc.readTextFile(path);
  } catch {
    return null;
  }
}

async function listDirIfPresent(path: string) {
  try {
    return await ipc.readWorkspaceTree(path);
  } catch {
    return null;
  }
}

async function buildRegistryForFile(
  filePath: string,
  workspaceRoot: string,
  readFile: ManifestReader,
  listDir: DirectoryReader,
  ecosystems: Set<Ecosystem>,
): Promise<Registry> {
  const registry = emptyRegistry();
  const candidates = await candidateManifestPaths(
    filePath,
    workspaceRoot,
    listDir,
    ecosystems,
  );
  const pairs = await Promise.all(
    candidates.map(async (path) => [path, await readFile(path)] as const),
  );
  for (const [path, content] of pairs) {
    if (!content) continue;
    registry.manifests.push(path);
    parseManifest(path, content, registry);
  }
  return registry;
}

function emptyRegistry(): Registry {
  return {
    manifests: [],
    js: new Set(),
    python: new Set(),
    rust: new Set(),
    go: new Set(),
    java: new Set(),
    csharp: new Set(),
    php: new Set(),
    ruby: new Set(),
    dart: new Set(),
    swift: new Set(),
  };
}

async function candidateManifestPaths(
  filePath: string,
  workspaceRoot: string,
  listDir: DirectoryReader,
  ecosystems: Set<Ecosystem>,
): Promise<string[]> {
  const out: string[] = [];
  const root = normalizePath(workspaceRoot);
  const manifestNames = manifestNamesForEcosystems(ecosystems);
  let dir = normalizePath(pathLib.dirname(filePath));
  while (dir && pathIsInside(dir, root)) {
    for (const name of manifestNames) {
      out.push(pathLib.join(dir, name));
    }
    const entries = await listDir(dir);
    for (const entry of entries ?? []) {
      if (entry.is_dir) continue;
      if (isDependencyManifestRelevant(entry.name, ecosystems)) {
        out.push(normalizePath(entry.path ?? pathLib.join(dir, entry.name)));
      }
    }
    if (dir === root) break;
    const parent = normalizePath(pathLib.dirname(dir));
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return [...new Set(out)];
}

function isDependencyManifestName(name: string): boolean {
  return DEPENDENCY_MANIFEST_NAMES.has(name) || DOTNET_PROJECT_RE.test(name);
}

function manifestNamesForEcosystems(ecosystems: Set<Ecosystem>): string[] {
  const names = new Set<string>();
  for (const ecosystem of ecosystems) {
    for (const name of MANIFESTS_BY_ECOSYSTEM[ecosystem]) {
      names.add(name);
    }
  }
  return [...names];
}

function isDependencyManifestRelevant(name: string, ecosystems: Set<Ecosystem>): boolean {
  if (DOTNET_PROJECT_RE.test(name)) return ecosystems.has("csharp");
  for (const ecosystem of ecosystems) {
    if (MANIFESTS_BY_ECOSYSTEM[ecosystem].includes(name)) return true;
  }
  return false;
}

function parseManifest(path: string, content: string, registry: Registry): void {
  const name = pathLib.basename(path);
  if (name === "package.json") parsePackageJson(content, registry);
  else if (name === "pyproject.toml") parsePyproject(content, registry);
  else if (name.startsWith("requirements") && name.endsWith(".txt")) {
    parseRequirements(content, registry);
  } else if (name === "Cargo.toml") parseCargoToml(content, registry);
  else if (name === "go.mod") parseGoMod(content, registry);
  else if (name === "pom.xml") parsePomXml(content, registry);
  else if (name === "build.gradle" || name === "build.gradle.kts") {
    parseGradle(content, registry);
  } else if (name === "Directory.Packages.props" || name.endsWith(".csproj")) {
    parseCsproj(content, registry);
  } else if (name === "composer.json") parseComposerJson(content, registry);
  else if (name === "Gemfile") parseGemfile(content, registry);
  else if (name === "pubspec.yaml") parsePubspec(content, registry);
  else if (name === "Package.swift") parseSwiftPackage(content, registry);
}

function parsePackageJson(content: string, registry: Registry): void {
  try {
    const json = JSON.parse(content) as Record<string, unknown>;
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "bundledDependencies",
      "bundleDependencies",
    ]) {
      const deps = json[field];
      if (Array.isArray(deps)) {
        for (const dep of deps) add(registry.js, dep);
      } else if (deps && typeof deps === "object") {
        for (const dep of Object.keys(deps)) add(registry.js, dep);
      }
    }
    const name = typeof json.name === "string" ? packageRoot(json.name) : null;
    if (name) add(registry.js, name);
  } catch {
    /* invalid JSON is reported by Monaco's JSON worker */
  }
}

function parsePyproject(content: string, registry: Registry): void {
  const depArrays = content.matchAll(/(?:dependencies|requires)\s*=\s*\[([\s\S]*?)\]/g);
  for (const match of depArrays) {
    for (const item of match[1].matchAll(/["']([^"']+)["']/g)) {
      add(registry.python, normalizePythonPackage(requirementName(item[1])));
    }
  }
  const sections = content.matchAll(/\[(?:tool\.poetry\.dependencies|tool\.poetry\.group\.[^\]]+\.dependencies|project\.optional-dependencies\.[^\]]+)\]([\s\S]*?)(?=\n\[|$)/g);
  for (const match of sections) {
    for (const line of match[1].split(/\r?\n/)) {
      const dep = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1];
      if (dep && dep.toLowerCase() !== "python") {
        add(registry.python, normalizePythonPackage(dep));
      }
    }
  }
}

function parseRequirements(content: string, registry: Registry): void {
  for (const line of content.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, "").trim();
    if (!clean || clean.startsWith("-")) continue;
    add(registry.python, normalizePythonPackage(requirementName(clean)));
  }
}

function parseCargoToml(content: string, registry: Registry): void {
  const sections = content.matchAll(/\[(dependencies|dev-dependencies|build-dependencies|target\.[^\]]+\.dependencies)\]([\s\S]*?)(?=\n\[|$)/g);
  for (const match of sections) {
    for (const line of match[2].split(/\r?\n/)) {
      const dep = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
      if (dep) add(registry.rust, normalizeRustCrate(dep));
    }
  }
}

function parseGoMod(content: string, registry: Registry): void {
  const moduleName = content.match(/^\s*module\s+(\S+)/m)?.[1];
  if (moduleName) add(registry.go, moduleName);
  for (const match of content.matchAll(/^\s*(?:require\s+)?([A-Za-z0-9_.-]+\/[^\s]+)\s+v?\d/mg)) {
    add(registry.go, match[1]);
  }
}

function parsePomXml(content: string, registry: Registry): void {
  for (const match of content.matchAll(/<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g)) {
    add(registry.java, match[1].trim());
    add(registry.java, `${match[1].trim()}.${match[2].trim()}`);
    add(registry.java, match[2].trim());
  }
}

function parseGradle(content: string, registry: Registry): void {
  for (const match of content.matchAll(/['"]([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):[^'"]+['"]/g)) {
    add(registry.java, match[1]);
    add(registry.java, `${match[1]}.${match[2]}`);
    add(registry.java, match[2]);
  }
}

function parseCsproj(content: string, registry: Registry): void {
  for (const match of content.matchAll(/<PackageReference[^>]+Include=["']([^"']+)["']/g)) {
    add(registry.csharp, normalizeDotnetPackage(match[1]));
  }
  for (const match of content.matchAll(/<PackageVersion[^>]+Include=["']([^"']+)["']/g)) {
    add(registry.csharp, normalizeDotnetPackage(match[1]));
  }
}

function parseComposerJson(content: string, registry: Registry): void {
  try {
    const json = JSON.parse(content) as Record<string, unknown>;
    for (const field of ["require", "require-dev"]) {
      const deps = json[field];
      if (deps && typeof deps === "object" && !Array.isArray(deps)) {
        for (const dep of Object.keys(deps)) add(registry.php, dep);
      }
    }
    const autoload = json.autoload as Record<string, unknown> | undefined;
    const psr4 = autoload?.["psr-4"];
    if (psr4 && typeof psr4 === "object" && !Array.isArray(psr4)) {
      for (const ns of Object.keys(psr4)) add(registry.php, ns.replace(/\\+$/, ""));
    }
  } catch {
    /* invalid JSON is reported elsewhere */
  }
}

function parseGemfile(content: string, registry: Registry): void {
  for (const match of content.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) {
    add(registry.ruby, match[1]);
  }
}

function parsePubspec(content: string, registry: Registry): void {
  for (const match of content.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*(?:$|[^\s])/gm)) {
    add(registry.dart, match[1]);
  }
}

function parseSwiftPackage(content: string, registry: Registry): void {
  for (const match of content.matchAll(/\.package\s*\([^)]*name:\s*"([^"]+)"/g)) {
    add(registry.swift, match[1]);
  }
  for (const match of content.matchAll(/\.product\s*\(\s*name:\s*"([^"]+)"/g)) {
    add(registry.swift, match[1]);
  }
}

function extractDependencyRefs(language: string, content: string): DependencyRef[] {
  const lang = language.toLowerCase();
  const refs: DependencyRef[] = [];
  if (["javascript", "typescript", "javascriptreact", "typescriptreact", "tsx", "jsx", "vue", "svelte", "astro"].includes(lang)) {
    refs.push(...extractJsRefs(content));
  }
  if (lang === "python") refs.push(...extractPythonRefs(content));
  if (lang === "rust") refs.push(...extractRustRefs(content));
  if (lang === "go") refs.push(...extractGoRefs(content));
  if (lang === "java" || lang === "kotlin" || lang === "scala") refs.push(...extractJavaRefs(content));
  if (lang === "csharp") refs.push(...extractCsharpRefs(content));
  if (lang === "php") refs.push(...extractPhpRefs(content));
  if (lang === "ruby") refs.push(...extractRubyRefs(content));
  if (lang === "dart") refs.push(...extractDartRefs(content));
  if (lang === "swift") refs.push(...extractSwiftRefs(content));
  return refs.filter((ref) => ref.name.length > 0);
}

function extractJsRefs(content: string): DependencyRef[] {
  const refs: DependencyRef[] = [];
  const importRegex =
    /(?:import\s+(?:type\s+)?(?:[^"'`]*?\s+from\s*)?|export\s+(?:type\s+)?[^"'`]*?\s+from\s*|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/g;
  eachLine(content, (line, lineNumber) => {
    for (const match of line.matchAll(importRegex)) {
      const spec = match[1];
      if (!spec || isRelativeOrUrl(spec)) continue;
      const root = packageRoot(spec);
      if (!root) continue;
      const start = (match.index ?? 0) + match[0].indexOf(spec) + 1;
      refs.push({
        ecosystem: "js",
        name: root,
        display: root,
        line: lineNumber,
        startColumn: start,
        endColumn: start + spec.length,
      });
    }
  });
  return refs;
}

function extractPythonRefs(content: string): DependencyRef[] {
  const refs: DependencyRef[] = [];
  eachLine(content, (line, lineNumber) => {
    const from = line.match(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/);
    if (from) {
      const root = from[1].split(".")[0];
      if (!PYTHON_STDLIB.has(root)) {
        const start = line.indexOf(from[1]) + 1;
        refs.push({
          ecosystem: "python",
          name: normalizePythonPackage(root),
          display: root,
          line: lineNumber,
          startColumn: start,
          endColumn: start + root.length,
        });
      }
      return;
    }
    const imported = line.match(/^\s*import\s+(.+)/);
    if (!imported) return;
    for (const part of imported[1].split(",")) {
      const token = part.trim().split(/\s+as\s+/)[0]?.split(".")[0];
      if (!token || !/^[A-Za-z_]\w*$/.test(token) || PYTHON_STDLIB.has(token)) continue;
      const start = line.indexOf(token) + 1;
      refs.push({
        ecosystem: "python",
        name: normalizePythonPackage(token),
        display: token,
        line: lineNumber,
        startColumn: start,
        endColumn: start + token.length,
      });
    }
  });
  return refs;
}

function extractRustRefs(content: string): DependencyRef[] {
  const refs: DependencyRef[] = [];
  eachLine(content, (line, lineNumber) => {
    const match = line.match(/^\s*(?:use|extern\s+crate)\s+([A-Za-z_][\w]*)/);
    const root = match?.[1];
    if (!root || RUST_BUILTINS.has(root)) return;
    const start = line.indexOf(root) + 1;
    refs.push({
      ecosystem: "rust",
      name: normalizeRustCrate(root),
      display: root,
      line: lineNumber,
      startColumn: start,
      endColumn: start + root.length,
    });
  });
  return refs;
}

function extractGoRefs(content: string): DependencyRef[] {
  const refs: DependencyRef[] = [];
  eachLine(content, (line, lineNumber) => {
    for (const match of line.matchAll(/"([^"]+)"/g)) {
      const spec = match[1];
      const first = spec.split("/")[0];
      if (!spec.includes(".") || GO_STDLIB_FIRST_SEGMENTS.has(first)) continue;
      const start = (match.index ?? 0) + 2;
      refs.push({
        ecosystem: "go",
        name: spec,
        display: spec,
        line: lineNumber,
        startColumn: start,
        endColumn: start + spec.length,
      });
    }
  });
  return refs;
}

function extractJavaRefs(content: string): DependencyRef[] {
  const refs: DependencyRef[] = [];
  eachLine(content, (line, lineNumber) => {
    const match = line.match(/^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*)(?:\.\*)?\s*;/);
    const spec = match?.[1];
    if (!spec || JAVA_STDLIB_PREFIXES.some((prefix) => spec.startsWith(prefix))) return;
    const start = line.indexOf(spec) + 1;
    refs.push({
      ecosystem: "java",
      name: spec,
      display: spec,
      line: lineNumber,
      startColumn: start,
      endColumn: start + spec.length,
    });
  });
  return refs;
}

function extractCsharpRefs(content: string): DependencyRef[] {
  const refs: DependencyRef[] = [];
  eachLine(content, (line, lineNumber) => {
    const match = line.match(/^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/);
    const spec = match?.[1];
    if (!spec || CSHARP_STDLIB_PREFIXES.some((prefix) => spec === prefix || spec.startsWith(`${prefix}.`))) {
      return;
    }
    const root = spec.split(".")[0];
    const start = line.indexOf(spec) + 1;
    refs.push({
      ecosystem: "csharp",
      name: normalizeDotnetPackage(root),
      display: root,
      line: lineNumber,
      startColumn: start,
      endColumn: start + spec.length,
    });
  });
  return refs;
}

function extractPhpRefs(content: string): DependencyRef[] {
  const refs: DependencyRef[] = [];
  eachLine(content, (line, lineNumber) => {
    const match = line.match(/^\s*use\s+([A-Za-z_\\][\w\\]*)\s*;/);
    const spec = match?.[1];
    if (!spec) return;
    const root = spec.split("\\")[0];
    const start = line.indexOf(spec) + 1;
    refs.push({
      ecosystem: "php",
      name: root,
      display: root,
      line: lineNumber,
      startColumn: start,
      endColumn: start + spec.length,
    });
  });
  return refs;
}

function extractRubyRefs(content: string): DependencyRef[] {
  const refs: DependencyRef[] = [];
  eachLine(content, (line, lineNumber) => {
    const match = line.match(/^\s*require\s+["']([^"']+)["']/);
    const spec = match?.[1];
    if (!spec || spec.startsWith(".") || spec.includes("/")) return;
    const start = line.indexOf(spec) + 1;
    refs.push({
      ecosystem: "ruby",
      name: spec,
      display: spec,
      line: lineNumber,
      startColumn: start,
      endColumn: start + spec.length,
    });
  });
  return refs;
}

function extractDartRefs(content: string): DependencyRef[] {
  const refs: DependencyRef[] = [];
  eachLine(content, (line, lineNumber) => {
    const match = line.match(/^\s*import\s+["']package:([^/"']+)/);
    const name = match?.[1];
    if (!name) return;
    const start = line.indexOf(name) + 1;
    refs.push({
      ecosystem: "dart",
      name,
      display: name,
      line: lineNumber,
      startColumn: start,
      endColumn: start + name.length,
    });
  });
  return refs;
}

function extractSwiftRefs(content: string): DependencyRef[] {
  const refs: DependencyRef[] = [];
  eachLine(content, (line, lineNumber) => {
    const match = line.match(/^\s*import\s+([A-Za-z_][\w]*)/);
    const name = match?.[1];
    if (!name || ["Foundation", "SwiftUI", "UIKit", "AppKit"].includes(name)) return;
    const start = line.indexOf(name) + 1;
    refs.push({
      ecosystem: "swift",
      name,
      display: name,
      line: lineNumber,
      startColumn: start,
      endColumn: start + name.length,
    });
  });
  return refs;
}

function shouldCheckRef(ref: DependencyRef, registry: Registry): boolean {
  return registry[ref.ecosystem].size > 0;
}

function dependencyIsKnown(ref: DependencyRef, registry: Registry): boolean {
  const deps = registry[ref.ecosystem];
  if (deps.has(ref.name)) return true;
  if (ref.ecosystem === "go") {
    return Array.from(deps).some((dep) => ref.name === dep || ref.name.startsWith(`${dep}/`));
  }
  if (ref.ecosystem === "java") {
    return Array.from(deps).some((dep) => ref.name === dep || ref.name.startsWith(`${dep}.`));
  }
  if (ref.ecosystem === "csharp") {
    return Array.from(deps).some((dep) => ref.display === dep || ref.display.startsWith(dep));
  }
  if (ref.ecosystem === "php") {
    return Array.from(deps).some((dep) => ref.display === dep || ref.display.startsWith(dep));
  }
  return false;
}

function missingMessage(ref: DependencyRef, registry: Registry): string {
  const manifests = registry.manifests.map((path) => pathLib.basename(path));
  const where = manifests.length ? `detected manifest${manifests.length === 1 ? "" : "s"} (${[...new Set(manifests)].join(", ")})` : "project manifests";
  return `Dependency "${ref.display}" is imported but is not declared by the ${where}. Install it or add it to the appropriate dependency manifest.`;
}

function eachLine(content: string, fn: (line: string, lineNumber: number) => void): void {
  content.split(/\r?\n/).forEach((line, index) => fn(line, index + 1));
}

function add(set: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const clean = value.trim();
  if (clean) set.add(clean);
}

function packageRoot(spec: string): string | null {
  if (!spec || isRelativeOrUrl(spec)) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

function isRelativeOrUrl(spec: string): boolean {
  return (
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)
  );
}

function requirementName(value: string): string {
  return value.split(/[<>=!~;\[\]\s]/)[0] ?? value;
}

function normalizePythonPackage(value: string): string {
  return value.toLowerCase().replace(/[-.]+/g, "_");
}

function normalizeRustCrate(value: string): string {
  return value.replace(/-/g, "_");
}

function normalizeDotnetPackage(value: string): string {
  return value.split(".")[0] ?? value;
}

function normalizePath(path: string): string {
  const normal = path.replace(/\\/g, "/");
  return normal === "/" ? normal : normal.replace(/\/+$/, "");
}

function pathIsInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
