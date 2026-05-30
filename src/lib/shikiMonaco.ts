import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import {
  POINTER_THEMES,
  normalizeAppThemeId,
  pointerThemeFor,
  type AppThemeId,
} from "@/theme/themes";

type LanguageRegistration = {
  id: string;
  extensions?: string[];
  aliases?: string[];
  filenames?: string[];
};

type ShikiRuntime = {
  highlighter: any;
  monaco: Monaco;
  encodedTokenMetadata: any;
  initialRuleStack: any;
  fontStyle: any;
  colorMap: string[];
  colorStyleToScopeMap: Map<string, string>;
  providers: Set<string>;
  loading: Map<string, Promise<void>>;
};

type ShikiLanguageModule = { default: unknown };

const SHIKI_LANGUAGE_LOADERS: Record<string, () => Promise<ShikiLanguageModule>> = {
  astro: () => import("@shikijs/langs/astro"),
  bat: () => import("@shikijs/langs/bat"),
  bicep: () => import("@shikijs/langs/bicep"),
  c: () => import("@shikijs/langs/c"),
  clojure: () => import("@shikijs/langs/clojure"),
  cpp: () => import("@shikijs/langs/cpp"),
  crystal: () => import("@shikijs/langs/crystal"),
  csharp: () => import("@shikijs/langs/csharp"),
  d: () => import("@shikijs/langs/d"),
  css: () => import("@shikijs/langs/css"),
  dart: () => import("@shikijs/langs/dart"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  dotenv: () => import("@shikijs/langs/dotenv"),
  ejs: () => import("@shikijs/langs/javascript"),
  elm: () => import("@shikijs/langs/elm"),
  elixir: () => import("@shikijs/langs/elixir"),
  erlang: () => import("@shikijs/langs/erlang"),
  erb: () => import("@shikijs/langs/erb"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  groovy: () => import("@shikijs/langs/groovy"),
  handlebars: () => import("@shikijs/langs/handlebars"),
  haskell: () => import("@shikijs/langs/haskell"),
  hcl: () => import("@shikijs/langs/hcl"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  julia: () => import("@shikijs/langs/julia"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  latex: () => import("@shikijs/langs/latex"),
  less: () => import("@shikijs/langs/less"),
  liquid: () => import("@shikijs/langs/liquid"),
  log: () => import("@shikijs/langs/log"),
  lua: () => import("@shikijs/langs/lua"),
  makefile: () => import("@shikijs/langs/makefile"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  nim: () => import("@shikijs/langs/nim"),
  nix: () => import("@shikijs/langs/nix"),
  ocaml: () => import("@shikijs/langs/ocaml"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  perl: () => import("@shikijs/langs/perl"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  prisma: () => import("@shikijs/langs/prisma"),
  proto: () => import("@shikijs/langs/proto"),
  pug: () => import("@shikijs/langs/pug"),
  python: () => import("@shikijs/langs/python"),
  r: () => import("@shikijs/langs/r"),
  racket: () => import("@shikijs/langs/racket"),
  razor: () => import("@shikijs/langs/razor"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scala: () => import("@shikijs/langs/scala"),
  scss: () => import("@shikijs/langs/scss"),
  shell: () => import("@shikijs/langs/shell"),
  solidity: () => import("@shikijs/langs/solidity"),
  sql: () => import("@shikijs/langs/sql"),
  stylus: () => import("@shikijs/langs/stylus"),
  svelte: () => import("@shikijs/langs/svelte"),
  swift: () => import("@shikijs/langs/swift"),
  "system-verilog": () => import("@shikijs/langs/system-verilog"),
  toml: () => import("@shikijs/langs/toml"),
  twig: () => import("@shikijs/langs/twig"),
  typescript: () => import("@shikijs/langs/tsx"),
  typespec: () => import("@shikijs/langs/typespec"),
  vb: () => import("@shikijs/langs/vb"),
  verilog: () => import("@shikijs/langs/verilog"),
  vue: () => import("@shikijs/langs/vue"),
  wgsl: () => import("@shikijs/langs/wgsl"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
  zig: () => import("@shikijs/langs/zig"),
};

const TEXTMATE_LANGUAGE_REGISTRATIONS: LanguageRegistration[] = [
  { id: "astro", extensions: [".astro"], aliases: ["Astro", "astro"] },
  { id: "bat", extensions: [".bat", ".cmd"], aliases: ["Batch", "bat"] },
  { id: "bicep", extensions: [".bicep"], aliases: ["Bicep", "bicep"] },
  { id: "c", extensions: [".c", ".h"], aliases: ["C", "c"] },
  { id: "clojure", extensions: [".clj", ".cljs", ".cljc", ".edn"], aliases: ["Clojure", "clojure"] },
  { id: "cpp", extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hxx"], aliases: ["C++", "cpp"] },
  { id: "crystal", extensions: [".cr"], aliases: ["Crystal", "crystal"] },
  { id: "csharp", extensions: [".cs"], aliases: ["C#", "csharp"] },
  { id: "d", extensions: [".d"], aliases: ["D", "d"] },
  { id: "dart", extensions: [".dart"], aliases: ["Dart", "dart"] },
  { id: "dockerfile", extensions: [".dockerfile"], filenames: ["Dockerfile", "Containerfile"], aliases: ["Dockerfile", "dockerfile"] },
  { id: "dotenv", extensions: [".env"], aliases: ["dotenv", "env"] },
  { id: "ejs", extensions: [".ejs", ".tmpl"], aliases: ["EJS", "ejs"] },
  { id: "elm", extensions: [".elm"], aliases: ["Elm", "elm"] },
  { id: "erlang", extensions: [".erl", ".hrl"], aliases: ["Erlang", "erlang"] },
  { id: "erb", extensions: [".erb"], aliases: ["ERB", "erb"] },
  { id: "elixir", extensions: [".ex", ".exs"], aliases: ["Elixir", "elixir"] },
  { id: "fsharp", extensions: [".fs", ".fsx", ".fsi"], aliases: ["F#", "fsharp"] },
  { id: "go", extensions: [".go"], aliases: ["Go", "go"] },
  { id: "graphql", extensions: [".graphql", ".gql"], aliases: ["GraphQL", "graphql"] },
  { id: "groovy", extensions: [".groovy", ".gvy", ".gradle"], aliases: ["Groovy", "groovy"] },
  { id: "handlebars", extensions: [".hbs", ".handlebars"], aliases: ["Handlebars", "handlebars"] },
  { id: "haskell", extensions: [".hs", ".lhs"], aliases: ["Haskell", "haskell"] },
  { id: "hcl", extensions: [".hcl", ".tf", ".tfvars"], aliases: ["HCL", "Terraform", "hcl"] },
  { id: "html", extensions: [".html", ".htm"], aliases: ["HTML", "html"] },
  { id: "ini", extensions: [".ini", ".cfg", ".conf"], aliases: ["INI", "ini"] },
  { id: "java", extensions: [".java"], aliases: ["Java", "java"] },
  { id: "json", extensions: [".json", ".jsonc", ".json5"], aliases: ["JSON", "json"] },
  { id: "julia", extensions: [".jl"], aliases: ["Julia", "julia"] },
  { id: "kotlin", extensions: [".kt", ".kts"], aliases: ["Kotlin", "kotlin"] },
  { id: "latex", extensions: [".tex", ".latex"], aliases: ["LaTeX", "latex"] },
  { id: "less", extensions: [".less"], aliases: ["Less", "less"] },
  { id: "liquid", extensions: [".liquid"], aliases: ["Liquid", "liquid"] },
  { id: "log", extensions: [".log"], aliases: ["Log", "log"] },
  { id: "lua", extensions: [".lua"], aliases: ["Lua", "lua"] },
  { id: "makefile", extensions: [".mk"], filenames: ["Makefile", "GNUmakefile"], aliases: ["Makefile", "makefile"] },
  { id: "markdown", extensions: [".md", ".markdown"], aliases: ["Markdown", "markdown"] },
  { id: "mdx", extensions: [".mdx"], aliases: ["MDX", "mdx"] },
  { id: "nim", extensions: [".nim", ".nims"], aliases: ["Nim", "nim"] },
  { id: "nix", extensions: [".nix"], aliases: ["Nix", "nix"] },
  { id: "ocaml", extensions: [".ml", ".mli", ".re", ".rei"], aliases: ["OCaml", "ocaml"] },
  { id: "objective-c", extensions: [".m", ".mm"], aliases: ["Objective-C", "objective-c"] },
  { id: "perl", extensions: [".pl", ".pm"], aliases: ["Perl", "perl"] },
  { id: "php", extensions: [".php"], aliases: ["PHP", "php"] },
  { id: "powershell", extensions: [".ps1", ".psm1"], aliases: ["PowerShell", "powershell"] },
  { id: "prisma", extensions: [".prisma"], aliases: ["Prisma", "prisma"] },
  { id: "proto", extensions: [".proto"], aliases: ["Protocol Buffer", "proto"] },
  { id: "pug", extensions: [".pug", ".jade"], aliases: ["Pug", "pug"] },
  { id: "python", extensions: [".py", ".pyi"], aliases: ["Python", "python"] },
  { id: "r", extensions: [".r", ".rmd"], aliases: ["R", "r"] },
  { id: "racket", extensions: [".rkt"], aliases: ["Racket", "racket"] },
  { id: "razor", extensions: [".cshtml"], aliases: ["Razor", "razor"] },
  { id: "ruby", extensions: [".rb"], aliases: ["Ruby", "ruby"] },
  { id: "rust", extensions: [".rs"], aliases: ["Rust", "rust"] },
  { id: "scala", extensions: [".scala"], aliases: ["Scala", "scala"] },
  { id: "scss", extensions: [".scss", ".sass"], aliases: ["SCSS", "Sass", "scss"] },
  { id: "shell", extensions: [".sh", ".bash", ".zsh", ".fish"], aliases: ["Shell", "shell"] },
  { id: "solidity", extensions: [".sol"], aliases: ["Solidity", "sol"] },
  { id: "sql", extensions: [".sql"], aliases: ["SQL", "sql"] },
  { id: "stylus", extensions: [".styl", ".stylus"], aliases: ["Stylus", "stylus"] },
  { id: "svelte", extensions: [".svelte"], aliases: ["Svelte", "svelte"] },
  { id: "swift", extensions: [".swift"], aliases: ["Swift", "swift"] },
  { id: "system-verilog", extensions: [".sv", ".svh"], aliases: ["SystemVerilog"] },
  { id: "toml", extensions: [".toml"], aliases: ["TOML", "toml"] },
  { id: "twig", extensions: [".twig"], aliases: ["Twig", "twig"] },
  { id: "typespec", extensions: [".tsp"], aliases: ["TypeSpec", "typespec"] },
  { id: "vb", extensions: [".vb"], aliases: ["Visual Basic", "vb"] },
  { id: "verilog", extensions: [".v", ".vh"], aliases: ["Verilog", "verilog"] },
  { id: "vue", extensions: [".vue"], aliases: ["Vue", "vue"] },
  { id: "wgsl", extensions: [".wgsl"], aliases: ["WGSL", "wgsl"] },
  { id: "xml", extensions: [".xml", ".svg", ".plist"], aliases: ["XML", "xml"] },
  { id: "yaml", extensions: [".yaml", ".yml"], aliases: ["YAML", "yaml"] },
  { id: "zig", extensions: [".zig", ".zon"], aliases: ["Zig", "zig"] },
];

let runtimePromise: Promise<ShikiRuntime> | null = null;
let runtimeMonaco: Monaco | null = null;

export function setupShikiMonaco(
  monaco: Monaco,
  initialLanguage?: string | null,
  themeId?: AppThemeId,
): Promise<void> {
  registerTextmateLanguageIds(monaco);
  registerPointerEditorThemes(monaco);
  setPointerMonacoTheme(monaco, themeId);
  return initialLanguage
    ? ensureShikiMonacoLanguage(monaco, initialLanguage)
    : Promise.resolve();
}

export function registerPointerEditorThemes(monaco: Monaco): void {
  for (const theme of POINTER_THEMES) {
    monaco.editor.defineTheme(theme.id, theme.monaco);
  }
}

export function setPointerMonacoTheme(
  monaco: Monaco,
  themeId?: string | null,
): AppThemeId {
  const id = normalizeAppThemeId(themeId);
  const theme = pointerThemeFor(id);
  registerPointerEditorThemes(monaco);
  monaco.editor.setTheme(theme.id);

  if (runtimeMonaco === monaco && runtimePromise) {
    void runtimePromise
      .then((runtime) => refreshThemeMaps(runtime, theme.id, theme.monaco))
      .catch(() => {});
  }
  return theme.id;
}

export async function ensureShikiMonacoLanguage(
  monaco: Monaco,
  language: string | null | undefined,
): Promise<void> {
  registerTextmateLanguageIds(monaco);
  const shikiLanguage = shikiLanguageFor(language);
  if (!shikiLanguage) return;

  const runtime = await getRuntime(monaco);
  if (runtime.providers.has(language!)) {
    registerTokensProvider(runtime, language!, shikiLanguage, true);
    return;
  }

  const existing = runtime.loading.get(language!);
  if (existing) return existing;

  const job = (async () => {
    const loader = SHIKI_LANGUAGE_LOADERS[shikiLanguage];
    if (!loader) return;
    const module = await loader();
    const registrations = asRegistrations(module.default);
    await runtime.highlighter.loadLanguage(...registrations);
    registerTokensProvider(
      runtime,
      language!,
      primaryRegistrationName(registrations, shikiLanguage),
    );
  })().catch((error) => {
    console.warn(`Pointer could not install TextMate highlighting for ${language}.`, error);
  });

  runtime.loading.set(language!, job);
  await job;
  runtime.loading.delete(language!);
}

async function getRuntime(monaco: Monaco): Promise<ShikiRuntime> {
  if (!runtimePromise || runtimeMonaco !== monaco) {
    runtimeMonaco = monaco;
    runtimePromise = createRuntime(monaco).catch((error) => {
      runtimePromise = null;
      runtimeMonaco = null;
      console.warn("Pointer could not initialize TextMate highlighting.", error);
      throw error;
    });
  }
  return runtimePromise;
}

async function createRuntime(monaco: Monaco): Promise<ShikiRuntime> {
  const [
    { createHighlighterCore },
    { createJavaScriptRegexEngine },
    { textmateThemeToMonacoTheme },
    { EncodedTokenMetadata, INITIAL },
  ] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("@shikijs/monaco"),
    import("@shikijs/vscode-textmate"),
  ]);

  const highlighter = await createHighlighterCore({
    themes: POINTER_THEMES.map((theme) => theme.shiki),
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  const defaultTheme = pointerThemeFor(
    typeof document === "undefined"
      ? undefined
      : document.documentElement.dataset.pointerTheme,
  );
  for (const theme of POINTER_THEMES) {
    const monacoTheme = textmateThemeToMonacoTheme(highlighter.getTheme(theme.id));
    monaco.editor.defineTheme(theme.id, {
      ...monacoTheme,
      colors: {
        ...(monacoTheme as any).colors,
        ...theme.monaco.colors,
      },
    } as any);
  }

  const runtime: ShikiRuntime = {
    highlighter,
    monaco,
    encodedTokenMetadata: EncodedTokenMetadata,
    initialRuleStack: INITIAL,
    fontStyle: {
      None: 0,
      Italic: 1,
      Bold: 2,
      Underline: 4,
      Strikethrough: 8,
    },
    colorMap: [],
    colorStyleToScopeMap: new Map(),
    providers: new Set(),
    loading: new Map(),
  };
  refreshThemeMaps(runtime, defaultTheme.id, defaultTheme.monaco);
  monaco.editor.setTheme(defaultTheme.id);
  return runtime;
}

function registerTokensProvider(
  runtime: ShikiRuntime,
  monacoLanguage: string,
  grammarLanguage: string,
  force = false,
) {
  if (!force && runtime.providers.has(monacoLanguage)) return;
  const { monaco, highlighter } = runtime;
  if (!monaco.languages.getLanguages().some((item) => item.id === monacoLanguage)) {
    return;
  }
  monaco.languages.setTokensProvider(monacoLanguage, {
    getInitialState() {
      return new TokenizerState(runtime.initialRuleStack);
    },
    tokenizeEncoded(line: string, state: TokenizerState) {
      if (line.length >= 40_000) {
        return {
          endState: state,
          tokens: new Uint32Array([0, 0]),
        };
      }
      const grammar = highlighter.getLanguage(grammarLanguage);
      const result = grammar.tokenizeLine2(
        line,
        state?.ruleStack ?? runtime.initialRuleStack,
        500,
      );
      return {
        endState: new TokenizerState(result.ruleStack),
        tokens: result.tokens,
      };
    },
    tokenize(line: string, state: TokenizerState) {
      if (line.length >= 40_000) {
        return {
          endState: state,
          tokens: [{ startIndex: 0, scopes: "" }],
        };
      }
      const grammar = highlighter.getLanguage(grammarLanguage);
      const result = grammar.tokenizeLine2(
        line,
        state?.ruleStack ?? runtime.initialRuleStack,
        500,
      );
      const tokensLength = result.tokens.length / 2;
      const tokens = [];
      for (let i = 0; i < tokensLength; i += 1) {
        const startIndex = result.tokens[2 * i];
        const metadata = result.tokens[2 * i + 1];
        const color = normalizeColor(
          runtime.colorMap[
            runtime.encodedTokenMetadata.getForeground(metadata)
          ] || "",
        );
        const fontStyle = runtime.encodedTokenMetadata.getFontStyle(metadata);
        const scopes = color
          ? findScopeByColorAndStyle(runtime, color, fontStyle) || ""
          : "";
        tokens.push({ startIndex, scopes });
      }
      return {
        endState: new TokenizerState(result.ruleStack),
        tokens,
      };
    },
  });
  runtime.providers.add(monacoLanguage);
  if (!force) {
    scheduleTokenProviderRefresh(runtime, monacoLanguage, grammarLanguage);
  }
}

function scheduleTokenProviderRefresh(
  runtime: ShikiRuntime,
  monacoLanguage: string,
  grammarLanguage: string,
) {
  if (monacoLanguage !== "typescript" && monacoLanguage !== "javascript") return;
  if (typeof globalThis.setTimeout !== "function") return;
  for (const delay of [0, 50, 250, 1000]) {
    globalThis.setTimeout(() => {
      registerTokensProvider(runtime, monacoLanguage, grammarLanguage, true);
    }, delay);
  }
}

class TokenizerState {
  constructor(readonly ruleStack: any) {}
  clone() {
    return new TokenizerState(this.ruleStack);
  }
  equals(other: unknown) {
    return other instanceof TokenizerState && other.ruleStack === this.ruleStack;
  }
}

function shikiLanguageFor(language: string | null | undefined): string | null {
  if (!language || language === "plaintext") return null;
  if (language === "javascript" || language === "typescript") return null;
  return SHIKI_LANGUAGE_LOADERS[language] ? language : null;
}

function asRegistrations(input: unknown): any[] {
  return Array.isArray(input) ? input : [input];
}

function primaryRegistrationName(registrations: any[], fallback: string): string {
  return (
    registrations.find((item) => typeof item?.name === "string")?.name ??
    fallback
  );
}

function refreshThemeMaps(
  runtime: ShikiRuntime,
  themeId: AppThemeId,
  monacoTheme: editor.IStandaloneThemeData | any,
) {
  const ret = runtime.highlighter.setTheme(themeId);
  runtime.colorMap.length = 0;
  for (let i = 0; i < ret.colorMap.length; i += 1) {
    runtime.colorMap[i] = ret.colorMap[i];
  }
  runtime.monaco.languages.setColorMap(
    runtime.colorMap.map((color) => color || "#000000"),
  );
  runtime.colorStyleToScopeMap.clear();
  monacoTheme.rules?.forEach((rule: { foreground?: string; fontStyle?: string; token?: string }) => {
    const color = normalizeColor(rule.foreground);
    if (!color || !rule.token) return;
    runtime.colorStyleToScopeMap.set(
      getColorStyleKey(color, normalizeFontStyleString(rule.fontStyle)),
      rule.token,
    );
  });
}

function findScopeByColorAndStyle(
  runtime: ShikiRuntime,
  color: string,
  fontStyle: number,
) {
  return runtime.colorStyleToScopeMap.get(
    getColorStyleKey(color, normalizeFontStyleBits(runtime, fontStyle)),
  );
}

function normalizeColor(color?: string | string[]): string | undefined {
  const raw = Array.isArray(color) ? color[0] : color;
  if (!raw) return undefined;
  const trimmed = raw.charCodeAt(0) === 35 ? raw.slice(1) : raw;
  const lower = trimmed.toLowerCase();
  if (lower.length === 3 || lower.length === 4) {
    return lower
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return lower;
}

const FONT_STYLE_SPLIT = /[\s,]+/;
const VALID_FONT_STYLES = ["italic", "bold", "underline", "strikethrough"];
const VALID_FONT_ALIASES: Record<string, string> = {
  "line-through": "strikethrough",
};

function normalizeFontStyleString(fontStyle?: string): string {
  if (!fontStyle) return "";
  const styles = new Set(
    fontStyle
      .split(FONT_STYLE_SPLIT)
      .map((style) => style.trim().toLowerCase())
      .map((style) => VALID_FONT_ALIASES[style] || style)
      .filter(Boolean),
  );
  return VALID_FONT_STYLES.filter((style) => styles.has(style)).join(" ");
}

function normalizeFontStyleBits(runtime: ShikiRuntime, fontStyle: number): string {
  if (fontStyle <= runtime.fontStyle.None) return "";
  const styles = [];
  if (fontStyle & runtime.fontStyle.Italic) styles.push("italic");
  if (fontStyle & runtime.fontStyle.Bold) styles.push("bold");
  if (fontStyle & runtime.fontStyle.Underline) styles.push("underline");
  if (fontStyle & runtime.fontStyle.Strikethrough) styles.push("strikethrough");
  return styles.join(" ");
}

function getColorStyleKey(color: string, fontStyle: string): string {
  return fontStyle ? `${color}|${fontStyle}` : color;
}

function registerTextmateLanguageIds(monaco: Monaco) {
  for (const registration of TEXTMATE_LANGUAGE_REGISTRATIONS) {
    try {
      monaco.languages.register(registration);
    } catch {
      /* Monaco already knows this id or this build does not accept it. */
    }
  }

  monaco.languages.setLanguageConfiguration("astro", htmlLikeLanguageConfig());
  monaco.languages.setLanguageConfiguration("svelte", htmlLikeLanguageConfig());
  monaco.languages.setLanguageConfiguration("vue", htmlLikeLanguageConfig());
}

function htmlLikeLanguageConfig() {
  return {
    comments: { blockComment: ["<!--", "-->"] as [string, string] },
    brackets: [
      ["<", ">"],
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ] as [string, string][],
    autoClosingPairs: [
      { open: "<", close: ">" },
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  };
}
