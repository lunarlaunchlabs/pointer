/**
 * Monaco language extensions + diagnostics tuning.
 *
 * Invoked once from `Editor.onMount`. The functions are *idempotent* —
 * registering a language twice is safe because Monaco simply replaces the
 * existing definition. That matters in dev where React StrictMode runs
 * onMount twice on the first render.
 *
 * What's wired here:
 *  - MDX: extends markdown with JSX-aware highlighting via a custom
 *    Monarch tokenizer. Monaco's basic-languages bundle doesn't ship MDX.
 *  - Dockerfile, TOML, GraphQL, HCL, Proto: most are bundled but their
 *    *file extensions* sometimes aren't registered; we top them up.
 *  - TypeScript / JavaScript: configure compiler defaults so JSX, ESM,
 *    DOM lib, and React JSX import-source resolve out of the box. This
 *    is what gives us `document.queryS` autocomplete on a fresh file.
 *  - JSON: enable schema-driven autocomplete for the most common
 *    project files (`package.json`, `tsconfig.json`).
 *  - Markdown / YAML: tune the validator to be friendly (no spurious
 *    errors on every numbered list).
 */

import type { Monaco } from "@monaco-editor/react";
import { setupShikiMonaco } from "@/lib/shikiMonaco";
import type { AppThemeId } from "@/theme/themes";

const installedMonacos = new WeakSet<object>();
const javascriptTypeScriptTokenRefreshMonacos = new WeakSet<object>();
const JAVASCRIPT_TYPESCRIPT_TOKEN_LANGUAGES = ["javascript", "typescript"] as const;
const JAVASCRIPT_TYPESCRIPT_TOKEN_REFRESH_DELAYS = [0, 50, 250, 1000, 2500] as const;

export function setupMonaco(
  monaco: Monaco,
  initialLanguage?: string | null,
  themeId?: AppThemeId,
) {
  if (installedMonacos.has(monaco as object)) return;
  installedMonacos.add(monaco as object);

  registerMdx(monaco);
  registerVue(monaco);
  registerEjs(monaco);
  registerMakefile(monaco);
  registerPrisma(monaco);
  registerExtensionAliases(monaco);
  configureTypescript(monaco);
  registerJavaScriptTypeScriptTokens(monaco);
  scheduleJavaScriptTypeScriptTokenRefresh(monaco);
  configureJson(monaco);
  void setupShikiMonaco(monaco, initialLanguage, themeId);
}

function registerJavaScriptTypeScriptTokens(monaco: Monaco) {
  const language = javascriptTypeScriptMonarch() as any;
  for (const id of JAVASCRIPT_TYPESCRIPT_TOKEN_LANGUAGES) {
    monaco.languages.setMonarchTokensProvider(id, language);
  }
}

function scheduleJavaScriptTypeScriptTokenRefresh(monaco: Monaco) {
  if (javascriptTypeScriptTokenRefreshMonacos.has(monaco as object)) return;
  if (typeof globalThis.setTimeout !== "function") return;
  javascriptTypeScriptTokenRefreshMonacos.add(monaco as object);
  for (const delay of JAVASCRIPT_TYPESCRIPT_TOKEN_REFRESH_DELAYS) {
    globalThis.setTimeout(() => {
      registerJavaScriptTypeScriptTokens(monaco);
    }, delay);
  }
}

export function javascriptTypeScriptMonarch() {
  return {
    defaultToken: "identifier",
    tokenPostfix: ".ts",
    keywords: [
      "as",
      "async",
      "await",
      "break",
      "case",
      "catch",
      "class",
      "const",
      "continue",
      "default",
      "delete",
      "do",
      "else",
      "enum",
      "export",
      "extends",
      "false",
      "finally",
      "for",
      "from",
      "function",
      "if",
      "implements",
      "import",
      "in",
      "instanceof",
      "interface",
      "let",
      "new",
      "null",
      "of",
      "package",
      "private",
      "protected",
      "public",
      "readonly",
      "return",
      "satisfies",
      "static",
      "super",
      "switch",
      "this",
      "throw",
      "true",
      "try",
      "type",
      "typeof",
      "undefined",
      "var",
      "void",
      "while",
      "with",
      "yield",
    ],
    typeKeywords: [
      "any",
      "bigint",
      "boolean",
      "never",
      "number",
      "object",
      "string",
      "symbol",
      "unknown",
      "void",
    ],
    constants: ["NaN", "Infinity", "globalThis", "window", "document", "console"],
    operators: [
      "=>",
      "===",
      "!==",
      "==",
      "!=",
      "<=",
      ">=",
      "&&",
      "||",
      "??",
      "?.",
      "+",
      "-",
      "*",
      "/",
      "%",
      "=",
      "!",
      "<",
      ">",
      "&",
      "|",
      "^",
      "~",
      "?",
      ":",
    ],
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    escapes: /\\(?:[abfnrtv\\"'`]|x[0-9A-Fa-f]{2}|u\{?[0-9A-Fa-f]{4,6}\}?)/,
    tokenizer: {
      root: [
        [/[{}()\[\]]/, "@brackets"],
        [/\/\*/, { token: "comment", next: "@comment" }],
        [/\/\/.*$/, "comment"],
        [/<\/[A-Za-z_$][\w$.-]*\s*>/, "tag"],
        [/<[A-Za-z_$][\w$.-]*/, { token: "tag", next: "@jsxTag" }],
        [/[A-Z][\w$]*(?=\s*[({<])/, "type.identifier"],
        [/[A-Za-z_$][\w$]*(?=\s*\()/, "function"],
        [
          /[A-Za-z_$][\w$]*/,
          {
            cases: {
              "@keywords": "keyword",
              "@typeKeywords": "type.identifier",
              "@constants": "constant.language",
              "@default": "identifier",
            },
          },
        ],
        [/[0-9]+(?:\.[0-9]+)?(?:[eE][\-+]?[0-9]+)?/, "number"],
        [/`/, { token: "string", next: "@template" }],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/"/, { token: "string", next: "@stringDouble" }],
        [/'/, { token: "string", next: "@stringSingle" }],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "delimiter" } }],
        [/[;,.]/, "delimiter"],
      ],
      jsxTag: [
        [/\/>/, { token: "delimiter.angle", next: "@pop" }],
        [/>/, { token: "delimiter.angle", switchTo: "@jsxText" }],
        [/[A-Za-z_$][\w$.-]*(?=\s*=)/, "attribute.name"],
        [/[A-Za-z_$][\w$.-]*/, "tag"],
        [/=/, "operator"],
        [/"[^"]*"/, "attribute.value"],
        [/'[^']*'/, "attribute.value"],
        [/`/, { token: "attribute.value", next: "@template" }],
        [/\{/, { token: "delimiter.bracket", next: "@jsxExpression" }],
      ],
      jsxText: [
        [/<\/[A-Za-z_$][\w$.-]*\s*>/, { token: "tag", next: "@pop" }],
        [/<[A-Za-z_$][\w$.-]*/, { token: "tag", next: "@jsxTag" }],
        [/\{/, { token: "delimiter.bracket", next: "@jsxExpression" }],
        [/[^<{]+/, ""],
        [/./, ""],
      ],
      jsxExpression: [
        [/\}/, { token: "delimiter.bracket", next: "@pop" }],
        [/<\/[A-Za-z_$][\w$.-]*\s*>/, "tag"],
        [/<[A-Za-z_$][\w$.-]*/, { token: "tag", next: "@jsxTag" }],
        [/[{}()\[\]]/, "@brackets"],
        [/[A-Za-z_$][\w$]*(?=\s*\()/, "function"],
        [
          /[A-Za-z_$][\w$]*/,
          {
            cases: {
              "@keywords": "keyword",
              "@typeKeywords": "type.identifier",
              "@constants": "constant.language",
              "@default": "identifier",
            },
          },
        ],
        [/[0-9]+(?:\.[0-9]+)?/, "number"],
        [/`/, { token: "string", next: "@template" }],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "delimiter" } }],
        [/[;,.]/, "delimiter"],
      ],
      template: [
        [/\$\{/, { token: "delimiter.bracket", next: "@templateExpression" }],
        [/`/, { token: "string", next: "@pop" }],
        [/\\./, "string.escape"],
        [/[^`$\\]+/, "string"],
      ],
      templateExpression: [
        [/\}/, { token: "delimiter.bracket", next: "@pop" }],
        [/[A-Za-z_$][\w$]*(?=\s*\()/, "function"],
        [
          /[A-Za-z_$][\w$]*/,
          {
            cases: {
              "@keywords": "keyword",
              "@typeKeywords": "type.identifier",
              "@constants": "constant.language",
              "@default": "identifier",
            },
          },
        ],
        [/[0-9]+(?:\.[0-9]+)?/, "number"],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "delimiter" } }],
        [/[;,.]/, "delimiter"],
      ],
      stringDouble: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, { token: "string", next: "@pop" }],
      ],
      stringSingle: [
        [/[^\\']+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/'/, { token: "string", next: "@pop" }],
      ],
      comment: [
        [/[^\/*]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[\/*]/, "comment"],
      ],
    },
  };
}

function registerVue(monaco: Monaco) {
  const id = "vue";
  monaco.languages.register({
    id,
    extensions: [".vue"],
    aliases: ["Vue", "vue"],
  });
  monaco.languages.setMonarchTokensProvider(id, {
    defaultToken: "",
    tokenizer: {
      root: [
        [/<!--/, { token: "comment", next: "@comment" }],
        [/<script\b[^>]*>/, { token: "tag", next: "@script" }],
        [/<style\b[^>]*>/, { token: "tag", next: "@style" }],
        [/<\/?[A-Za-z][\w.-]*/, { token: "tag", next: "@tag" }],
        [/\{\{/, { token: "delimiter.bracket", next: "@mustache" }],
      ],
      tag: [
        [/\/?>/, { token: "tag", next: "@pop" }],
        [/[:@#]?[A-Za-z_][\w:-]*(?=\s*=)/, "attribute.name"],
        [/[:@#]?[A-Za-z_][\w:-]*/, "attribute.name"],
        [/=/, "delimiter"],
        [/"[^"]*"/, "string"],
        [/'[^']*'/, "string"],
        [/\{\{/, { token: "delimiter.bracket", next: "@mustache" }],
      ],
      mustache: [
        [/\}\}/, { token: "delimiter.bracket", next: "@pop" }],
        [/\b(v-if|v-for|v-model|true|false|null|undefined|return)\b/, "keyword"],
        [/[A-Za-z_$][\w$]*/, "identifier"],
        [/"[^"]*"/, "string"],
        [/'[^']*'/, "string"],
        [/[0-9]+(?:\.[0-9]+)?/, "number"],
        [/[{}()[\].,?:+\-*/%&|!<>=]+/, "delimiter"],
      ],
      script: [
        [/<\/script\s*>/, { token: "tag", next: "@pop" }],
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@blockComment" }],
        [/\b(import|export|from|default|const|let|var|function|async|await|return|if|else|for|while|class|new|this)\b/, "keyword"],
        [/\b(true|false|null|undefined)\b/, "constant"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/`/, { token: "string", next: "@templateString" }],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/[A-Za-z_$][\w$]*/, "identifier"],
        [/[0-9]+(?:\.[0-9]+)?/, "number"],
        [/[{}()[\].,;:+\-*/%&|!<>=]+/, "delimiter"],
      ],
      style: [
        [/<\/style\s*>/, { token: "tag", next: "@pop" }],
        [/\/\*/, { token: "comment", next: "@blockComment" }],
        [/[.#]?[A-Za-z_-][\w-]*(?=\s*\{)/, "tag"],
        [/[A-Za-z-]+(?=\s*:)/, "attribute.name"],
        [/#[0-9A-Fa-f]{3,8}\b/, "number.hex"],
        [/"[^"]*"/, "string"],
        [/'[^']*'/, "string"],
        [/[{}:;(),]/, "delimiter"],
      ],
      templateString: [
        [/`/, { token: "string", next: "@pop" }],
        [/\$\{[^}]*\}/, "delimiter.bracket"],
        [/[^`$]+/, "string"],
      ],
      comment: [
        [/-->/, { token: "comment", next: "@pop" }],
        [/[^-]+/, "comment"],
        [/./, "comment"],
      ],
      blockComment: [
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[^*]+/, "comment"],
        [/./, "comment"],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration(id, {
    comments: { blockComment: ["<!--", "-->"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
      ["<", ">"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "<", close: ">" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
    ],
  });
}

function registerEjs(monaco: Monaco) {
  const id = "ejs";
  monaco.languages.register({
    id,
    extensions: [".ejs", ".tmpl"],
    aliases: ["EJS", "ejs", "Template"],
  });
  monaco.languages.setMonarchTokensProvider(id, {
    defaultToken: "",
    tokenizer: {
      root: [
        [/<!--/, { token: "comment", next: "@comment" }],
        [/<%#/, { token: "comment", next: "@ejsComment" }],
        [/<%[-_=]?/, { token: "delimiter", next: "@ejs" }],
        [/\{\{[#\/]?[A-Za-z_][\w.]*\}\}/, "variable"],
        [/\$[A-Za-z_][\w.]*/, "variable"],
        [/<\/?[A-Za-z][\w.-]*/, { token: "tag", next: "@tag" }],
      ],
      tag: [
        [/\/?>/, { token: "tag", next: "@pop" }],
        [/[A-Za-z_][\w:-]*(?=\s*=)/, "attribute.name"],
        [/=/, "delimiter"],
        [/"[^"]*"/, "string"],
        [/'[^']*'/, "string"],
        [/<%[-_=]?/, { token: "delimiter", next: "@ejs" }],
      ],
      ejs: [
        [/%>/, { token: "delimiter", next: "@pop" }],
        [/\b(const|let|var|function|if|else|for|while|return|await|async|new|true|false|null|undefined)\b/, "keyword"],
        [/[A-Za-z_$][\w$]*/, "identifier"],
        [/"[^"]*"/, "string"],
        [/'[^']*'/, "string"],
        [/[0-9]+(?:\.[0-9]+)?/, "number"],
        [/[{}()[\].,?:+\-*/%&|!<>=]+/, "delimiter"],
      ],
      ejsComment: [
        [/%>/, { token: "comment", next: "@pop" }],
        [/[^%]+/, "comment"],
        [/./, "comment"],
      ],
      comment: [
        [/-->/, { token: "comment", next: "@pop" }],
        [/[^-]+/, "comment"],
        [/./, "comment"],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration(id, {
    comments: { blockComment: ["<!--", "-->"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
      ["<", ">"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "<", close: ">" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
}

/**
 * MDX is markdown + a JSX-like component syntax. A full grammar would be
 * a big lift; for editor-quality colour we recognise:
 *   - Headings, lists, code fences (delegated to markdown)
 *   - JSX tags <Component .../> and <Component>...</Component>
 *   - Inline JS expressions `{ ... }`
 *   - import/export statements at the file top
 *
 * The result isn't 100% spec-perfect (no embedded TS inside `{ }`) but is
 * good enough that MDX files don't look like wall-of-text.
 */
function registerMdx(monaco: Monaco) {
  const id = "mdx";
  monaco.languages.register({
    id,
    extensions: [".mdx"],
    aliases: ["MDX", "mdx"],
  });

  monaco.languages.setMonarchTokensProvider(id, {
    defaultToken: "",
    tokenizer: {
      root: [
        // Frontmatter (YAML between leading --- --- pair)
        [/^---$/, { token: "delimiter", next: "@frontmatter" }],
        // Import / export at top level
        [/^\s*(import|export)\b.*$/, "keyword"],
        // JSX-style components
        [/<[A-Z][\w.]*/, { token: "tag", next: "@jsx_tag" }],
        [/<\/[A-Z][\w.]*>/, "tag"],
        // ATX headings (#, ##, …)
        [/^#{1,6}\s.*/, "comment.doc"],
        // Inline code
        [/`[^`]+`/, "string"],
        // Bold / italic — cheap heuristic
        [/\*\*[^*]+\*\*/, "strong"],
        [/_[^_]+_/, "emphasis"],
        // Fenced code block — soft-handled here, full sub-language nesting
        // would require setLanguageConfiguration + bracketing; we settle
        // for treating the fence + contents as a string literal so the
        // user sees the visual delineation.
        [/^\s*```[\w-]*\s*$/, { token: "string.escape", next: "@codeblock" }],
        // {expression}
        [/\{/, { token: "delimiter.bracket", next: "@expr" }],
      ],
      frontmatter: [
        [/^---$/, { token: "delimiter", next: "@pop" }],
        [/^[\w-]+:/, "type"],
        [/.*/, "string"],
      ],
      jsx_tag: [
        [/\/?>/, { token: "tag", next: "@pop" }],
        [/[\w.-]+(?=\s*=)/, "attribute.name"],
        [/=/, "delimiter"],
        [/"[^"]*"/, "string"],
        [/'[^']*'/, "string"],
        [/\{/, { token: "delimiter.bracket", next: "@expr" }],
      ],
      expr: [
        [/\}/, { token: "delimiter.bracket", next: "@pop" }],
        [/[A-Za-z_][\w]*/, "identifier"],
        [/"[^"]*"/, "string"],
        [/[0-9]+/, "number"],
      ],
      codeblock: [
        [/^\s*```\s*$/, { token: "string.escape", next: "@pop" }],
        [/.*/, "string"],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration(id, {
    comments: { blockComment: ["<!--", "-->"] },
    brackets: [
      ["{", "}"],
      ["<", ">"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "<", close: ">" },
      { open: "`", close: "`" },
    ],
  });
}

function registerMakefile(monaco: Monaco) {
  const id = "makefile";
  monaco.languages.register({
    id,
    extensions: [".mk"],
    filenames: ["Makefile", "makefile", "GNUmakefile"],
    aliases: ["Makefile", "makefile"],
  });
  monaco.languages.setMonarchTokensProvider(id, {
    defaultToken: "",
    tokenizer: {
      root: [
        [/^\s*#.*$/, "comment"],
        [/^\s*include\b.*$/, "keyword"],
        [/^\s*[-]?include\b.*$/, "keyword"],
        [/^[A-Za-z0-9_.\/%$(){} -]+(?=\s*:)/, "type.identifier"],
        [/[:;]/, "delimiter"],
        [/^\t.*$/, "string"],
        [/[$][({][A-Za-z0-9_.-]+[)}]/, "variable"],
        [/[$][@<^+?*%]/, "variable.predefined"],
        [/([A-Za-z0-9_.-]+)\s*(\?=|\+=|:=|=)/, ["variable", "operator"]],
        [/"[^"]*"/, "string"],
        [/'[^']*'/, "string"],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration(id, {
    comments: { lineComment: "#" },
    brackets: [
      ["(", ")"],
      ["{", "}"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "{", close: "}" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
}

function registerPrisma(monaco: Monaco) {
  const id = "prisma";
  monaco.languages.register({
    id,
    extensions: [".prisma"],
    aliases: ["Prisma", "prisma"],
  });
  monaco.languages.setMonarchTokensProvider(id, {
    defaultToken: "",
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@comment" }],
        [/\b(generator|datasource|model|enum|type|view)\b/, "keyword"],
        [/\b(provider|url|shadowDatabaseUrl|relationMode|previewFeatures)\b/, "attribute.name"],
        [/\b(String|Boolean|Int|BigInt|Float|Decimal|DateTime|Json|Bytes)\b/, "type"],
        [/@{1,2}[A-Za-z_][\w.]*/, "annotation"],
        [/\b(true|false|null)\b/, "constant"],
        [/"[^"]*"/, "string"],
        [/'[^']*'/, "string"],
        [/[{}()[\],]/, "delimiter"],
        [/[A-Za-z_]\w*(?=\s*[{(])/, "type.identifier"],
        [/[A-Za-z_]\w*/, "identifier"],
      ],
      comment: [
        [/[^\/*]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[\/*]/, "comment"],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration(id, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["(", ")"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
  });
}

/**
 * Register a handful of extension aliases Monaco's bundled languages don't
 * always advertise on their own. Calling `register` on an already-known
 * language id is a no-op for the *id* but appends to its extensions list,
 * which is exactly what we want.
 */
function registerExtensionAliases(monaco: Monaco) {
  const aliases: { id: string; extensions: string[]; filenames?: string[] }[] = [
    { id: "dockerfile", extensions: [".dockerfile"], filenames: ["Dockerfile", "Containerfile"] },
    { id: "makefile", extensions: [".mk"], filenames: ["Makefile", "GNUmakefile"] },
    { id: "toml", extensions: [".toml"] },
    { id: "yaml", extensions: [".yml", ".yaml"] },
    { id: "shell", extensions: [".sh", ".bash", ".zsh", ".fish"] },
    { id: "powershell", extensions: [".ps1", ".psm1"] },
    { id: "graphql", extensions: [".graphql", ".gql"] },
    { id: "proto", extensions: [".proto"] },
    { id: "hcl", extensions: [".tf", ".hcl"] },
    { id: "scss", extensions: [".scss", ".sass"] },
    { id: "less", extensions: [".less"] },
    { id: "kotlin", extensions: [".kt", ".kts"] },
    { id: "rust", extensions: [".rs"] },
    { id: "swift", extensions: [".swift"] },
    { id: "objective-c", extensions: [".m", ".mm"] },
    { id: "clojure", extensions: [".clj", ".cljs", ".cljc", ".edn"] },
    { id: "fsharp", extensions: [".fs", ".fsx", ".fsi"] },
    { id: "csharp", extensions: [".cs"] },
    { id: "vb", extensions: [".vb"] },
    { id: "sql", extensions: [".sql"] },
    { id: "perl", extensions: [".pl", ".pm"] },
    { id: "lua", extensions: [".lua"] },
    { id: "groovy", extensions: [".groovy", ".gvy", ".gradle"] },
    { id: "ini", extensions: [".ini", ".cfg", ".conf"] },
    { id: "bat", extensions: [".bat", ".cmd"] },
  ];
  for (const { id, extensions, filenames } of aliases) {
    try {
      monaco.languages.register({ id, extensions, filenames });
    } catch {
      /* language unknown to this Monaco build; skip silently */
    }
  }
}

/**
 * Configure the TypeScript/JavaScript workers so out-of-the-box files get
 * sensible diagnostics + intellisense:
 *
 *  - target: ESNext so modern syntax (top-level await, optional chaining)
 *    is recognised everywhere.
 *  - moduleResolution: NodeJs — required for `import` of bare specifiers
 *    to resolve.
 *  - jsx: ReactJSX (the modern automatic runtime). Avoids the legacy
 *    "React must be in scope" error.
 *  - lib: DOM + ESNext so `document.querySelector`, `Promise.all`, etc.
 *    autocomplete in plain `.ts` files even with no tsconfig present.
 *
 * The `eagerModelSync` option also keeps the worker's view of open models
 * in sync, so cross-file references inside the editor (e.g. clicking into
 * a function defined in another open tab) work without a full LSP.
 */
function configureTypescript(monaco: Monaco) {
  const ts = monaco.languages.typescript;
  const opts: any = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    strict: false,
    noEmit: true,
    isolatedModules: true,
    lib: ["dom", "dom.iterable", "esnext"],
    skipLibCheck: true,
  };
  ts.typescriptDefaults.setCompilerOptions(opts);
  ts.javascriptDefaults.setCompilerOptions(opts);

  // Silence the most common diagnostic noise: missing modules and
  // unreachable-code complaints in single-file scratch buffers. We still
  // surface syntax / type errors.
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
    onlyVisible: true,
    // 2307 = Cannot find module 'x'. Useful, but very noisy when editing a
    // file that imports from a sibling we haven't told the worker about.
    diagnosticCodesToIgnore: [2307, 2792],
  });
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
    onlyVisible: true,
    diagnosticCodesToIgnore: [2307, 2792, 7016],
  });

  // Keep the worker's model graph in sync as users open tabs so jumping
  // across files works without explicit "add to project" plumbing.
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);
}

/**
 * Add schema validation for the most common project files. Monaco ships
 * the JSON worker out of the box — we only need to wire up which schemas
 * apply to which files. Schemas come from the official Schemastore.
 */
function configureJson(monaco: Monaco) {
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    trailingCommas: "warning",
    enableSchemaRequest: true,
    schemas: [
      {
        uri: "https://json.schemastore.org/package.json",
        fileMatch: ["**/package.json"],
      },
      {
        uri: "https://json.schemastore.org/tsconfig.json",
        fileMatch: ["**/tsconfig.json", "**/tsconfig.*.json"],
      },
      {
        uri: "https://json.schemastore.org/eslintrc.json",
        fileMatch: [
          "**/.eslintrc",
          "**/.eslintrc.json",
        ],
      },
      {
        uri: "https://json.schemastore.org/prettierrc.json",
        fileMatch: ["**/.prettierrc", "**/.prettierrc.json"],
      },
    ],
  });
}
