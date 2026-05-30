import { languageFromPath } from "@/lib/lang";

export type RepoStandardsSource =
  | ".editorconfig"
  | ".vscode/settings.json";

export type RepoEditorStandards = {
  tabSize?: number;
  insertSpaces?: boolean;
  formatOnSave?: boolean;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  trimFinalNewlines?: boolean;
  endOfLine?: "lf" | "crlf" | "cr";
  defaultFormatter?: string;
  sources: RepoStandardsSource[];
};

export type ResolveRepoStandardsOptions = {
  path: string;
  workspaceRoot: string | null;
  readTextFile: (path: string) => Promise<string>;
};

type EditorConfigSection = {
  patterns: string[];
  values: Record<string, string>;
};

type EditorConfigFile = {
  path: string;
  dir: string;
  root: boolean;
  sections: EditorConfigSection[];
};

const MAX_ANCESTORS = 24;

export async function resolveRepoEditorStandards({
  path,
  workspaceRoot,
  readTextFile,
}: ResolveRepoStandardsOptions): Promise<RepoEditorStandards> {
  const out: RepoEditorStandards = { sources: [] };
  if (!workspaceRoot || !isWithin(workspaceRoot, path)) return out;

  const editorConfig = await readEditorConfigStandards(path, workspaceRoot, readTextFile);
  mergeStandards(out, editorConfig);

  const vscode = await readVsCodeStandards(path, workspaceRoot, readTextFile);
  mergeStandards(out, vscode);

  return out;
}

export function standardsFromEditorConfigProperties(
  properties: Record<string, string>,
): Omit<RepoEditorStandards, "sources"> {
  const out: Omit<RepoEditorStandards, "sources"> = {};
  const indentStyle = value(properties.indent_style);
  const indentSize = value(properties.indent_size);
  const tabWidth = numberValue(properties.tab_width);

  if (indentStyle === "tab") out.insertSpaces = false;
  if (indentStyle === "space") out.insertSpaces = true;
  if (indentSize && indentSize !== "tab") {
    const parsed = Number.parseInt(indentSize, 10);
    if (Number.isFinite(parsed) && parsed > 0) out.tabSize = parsed;
  } else if (indentSize === "tab" && tabWidth) {
    out.tabSize = tabWidth;
  }
  if (tabWidth && out.tabSize === undefined) out.tabSize = tabWidth;

  const trimTrailingWhitespace = boolValue(properties.trim_trailing_whitespace);
  if (trimTrailingWhitespace !== undefined) out.trimTrailingWhitespace = trimTrailingWhitespace;
  const insertFinalNewline = boolValue(properties.insert_final_newline);
  if (insertFinalNewline !== undefined) out.insertFinalNewline = insertFinalNewline;

  const endOfLine = value(properties.end_of_line);
  if (endOfLine === "lf" || endOfLine === "crlf" || endOfLine === "cr") {
    out.endOfLine = endOfLine;
  }
  return out;
}

export function standardsFromVsCodeSettings(
  settings: unknown,
  filePath: string,
): Omit<RepoEditorStandards, "sources"> {
  if (!settings || typeof settings !== "object") return {};
  const language = languageFromPath(filePath);
  const merged: Record<string, unknown> = {};
  applyVsCodeSettingsObject(merged, settings as Record<string, unknown>);
  for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
    if (isLanguageOverrideKey(key, language) && value && typeof value === "object") {
      applyVsCodeSettingsObject(merged, value as Record<string, unknown>);
    }
  }

  const out: Omit<RepoEditorStandards, "sources"> = {};
  if (typeof merged["editor.tabSize"] === "number") {
    out.tabSize = normalizePositiveInt(merged["editor.tabSize"]);
  }
  if (typeof merged["editor.insertSpaces"] === "boolean") {
    out.insertSpaces = merged["editor.insertSpaces"];
  }
  if (typeof merged["editor.formatOnSave"] === "boolean") {
    out.formatOnSave = merged["editor.formatOnSave"];
  }
  if (typeof merged["files.trimTrailingWhitespace"] === "boolean") {
    out.trimTrailingWhitespace = merged["files.trimTrailingWhitespace"];
  }
  if (typeof merged["files.insertFinalNewline"] === "boolean") {
    out.insertFinalNewline = merged["files.insertFinalNewline"];
  }
  if (typeof merged["files.trimFinalNewlines"] === "boolean") {
    out.trimFinalNewlines = merged["files.trimFinalNewlines"];
  }
  if (typeof merged["editor.defaultFormatter"] === "string") {
    out.defaultFormatter = merged["editor.defaultFormatter"];
  }
  return out;
}

async function readEditorConfigStandards(
  filePath: string,
  workspaceRoot: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<RepoEditorStandards> {
  const configs: EditorConfigFile[] = [];
  for (const dir of ancestorDirs(dirname(filePath), workspaceRoot)) {
    const configPath = `${dir}/.editorconfig`;
    try {
      configs.push(parseEditorConfig(configPath, await readTextFile(configPath)));
    } catch {
      /* no config at this level */
    }
    if (configs[configs.length - 1]?.root) break;
  }

  const properties: Record<string, string> = {};
  for (const config of configs.reverse()) {
    const relPath = relativePath(config.dir, filePath);
    for (const section of config.sections) {
      if (section.patterns.some((pattern) => editorConfigPatternMatches(pattern, relPath))) {
        Object.assign(properties, section.values);
      }
    }
  }

  const standards = standardsFromEditorConfigProperties(properties);
  return Object.keys(standards).length
    ? { ...standards, sources: [".editorconfig"] }
    : { sources: [] };
}

async function readVsCodeStandards(
  filePath: string,
  workspaceRoot: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<RepoEditorStandards> {
  const candidates = ancestorDirs(dirname(filePath), workspaceRoot)
    .map((dir) => `${dir}/.vscode/settings.json`)
    .reverse();
  const out: RepoEditorStandards = { sources: [] };
  for (const candidate of candidates) {
    try {
      const parsed = parseJsonc(await readTextFile(candidate));
      const standards = standardsFromVsCodeSettings(parsed, filePath);
      if (Object.keys(standards).length > 0) {
        mergeStandards(out, {
          ...standards,
          sources: [".vscode/settings.json"],
        });
      }
    } catch {
      /* no VS Code settings at this level, or invalid JSONC */
    }
  }
  return out;
}

function parseEditorConfig(path: string, raw: string): EditorConfigFile {
  const dir = dirname(path);
  const sections: EditorConfigSection[] = [];
  let root = false;
  let current: EditorConfigSection | null = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      current = {
        patterns: expandEditorConfigPattern(sectionMatch[1]),
        values: {},
      };
      sections.push(current);
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim().toLowerCase();
    const value = line.slice(equals + 1).trim();
    if (!current) {
      if (key === "root") root = value.toLowerCase() === "true";
      continue;
    }
    if (value.toLowerCase() !== "unset") current.values[key] = value;
  }
  return { path, dir, root, sections };
}

function expandEditorConfigPattern(pattern: string): string[] {
  const brace = pattern.match(/^(.*)\{([^{}]+)}(.*)$/);
  if (!brace) return [pattern];
  return brace[2]
    .split(",")
    .flatMap((part) => expandEditorConfigPattern(`${brace[1]}${part}${brace[3]}`));
}

function editorConfigPatternMatches(pattern: string, relPath: string): boolean {
  const normalized = normalizeRel(relPath);
  const target = pattern.includes("/") ? normalized : basename(normalized);
  return globToRegExp(pattern.includes("/") ? pattern : pattern).test(target);
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    const next = glob[i + 1];
    if (ch === "*" && next === "*") {
      re += ".*";
      i += 1;
    } else if (ch === "*") {
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

function applyVsCodeSettingsObject(
  out: Record<string, unknown>,
  settings: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith("[") && key.endsWith("]")) continue;
    out[key] = value;
  }
}

function isLanguageOverrideKey(key: string, language: string): boolean {
  if (!key.startsWith("[") || !key.endsWith("]")) return false;
  const ids = Array.from(key.matchAll(/\[([^\]]+)]/g)).map((match) => match[1]);
  const aliases = new Set(languageAliases(language));
  return ids.some((id) => aliases.has(id));
}

function languageAliases(language: string): string[] {
  const aliases = [language];
  if (language === "typescript") aliases.push("typescriptreact");
  if (language === "javascript") aliases.push("javascriptreact");
  if (language === "scss") aliases.push("sass");
  return aliases;
}

function parseJsonc(raw: string): unknown {
  return JSON.parse(stripJsonComments(raw).replace(/,\s*([}\]])/g, "$1"));
}

function stripJsonComments(raw: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && next) {
        out += next;
        i += 1;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function mergeStandards(target: RepoEditorStandards, next: RepoEditorStandards): void {
  const { sources, ...rest } = next;
  Object.assign(target, rest);
  for (const source of sources) {
    if (!target.sources.includes(source)) target.sources.push(source);
  }
}

function ancestorDirs(startDir: string, workspaceRoot: string): string[] {
  const root = normalizeAbs(workspaceRoot);
  const dirs: string[] = [];
  let current = normalizeAbs(startDir);
  for (let i = 0; i < MAX_ANCESTORS; i += 1) {
    if (!isWithin(root, current)) break;
    dirs.push(current);
    if (current === root) break;
    current = dirname(current);
  }
  return dirs;
}

function value(input: string | undefined): string | undefined {
  return input?.trim().toLowerCase();
}

function boolValue(input: string | undefined): boolean | undefined {
  const v = value(input);
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function numberValue(input: string | undefined): number | undefined {
  const v = value(input);
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function normalizePositiveInt(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function relativePath(root: string, path: string): string {
  const normalizedRoot = normalizeAbs(root);
  const normalizedPath = normalizeAbs(path);
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : basename(normalizedPath);
}

function isWithin(root: string, path: string): boolean {
  const normalizedRoot = normalizeAbs(root);
  const normalizedPath = normalizeAbs(path);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`)
  );
}

function dirname(path: string): string {
  const normalized = normalizeAbs(path);
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "/";
  return normalized.slice(0, idx);
}

function basename(path: string): string {
  return normalizeRel(path).split("/").pop() ?? path;
}

function normalizeAbs(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized || "/";
}

function normalizeRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
