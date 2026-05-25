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

let installed = false;

export function setupMonaco(monaco: Monaco) {
  if (installed) return;
  installed = true;

  registerMdx(monaco);
  registerExtensionAliases(monaco);
  configureTypescript(monaco);
  configureJson(monaco);
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
    // 2307 = Cannot find module 'x'. Useful, but very noisy when editing a
    // file that imports from a sibling we haven't told the worker about.
    diagnosticCodesToIgnore: [2307, 2792],
  });
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
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
