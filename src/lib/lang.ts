/**
 * Map a file path to a Monaco language id.
 *
 * The table is deliberately exhaustive. Monaco's basic-languages bundle
 * ships syntax + tokenization for *every* id we return here (we extend the
 * defaults in `setupMonaco.ts` for the ones it doesn't, like `mdx` and
 * `dockerfile`). When in doubt: a missing id falls back to plaintext, which
 * is still searchable / editable but loses colour.
 *
 * We also key on basenames (Dockerfile, Makefile, etc.) because real-world
 * repos rely on case-sensitive basename detection just as much as extensions.
 */

const BASENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  podfile: "ruby",
  "package.json": "json",
  "tsconfig.json": "json",
  "jsconfig.json": "json",
  "cargo.toml": "toml",
  "pyproject.toml": "toml",
  "go.mod": "go",
  "go.sum": "go",
  ".gitignore": "plaintext",
  ".gitattributes": "plaintext",
  ".env": "shell",
  ".dockerignore": "plaintext",
  "license": "plaintext",
};

const EXT: Record<string, string> = {
  // JS/TS family
  ts: "typescript",
  tsx: "typescript",
  cts: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  // Other web languages
  vue: "html",
  svelte: "html",
  astro: "html",
  // Markup
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  // Style
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  // Data
  json: "json",
  jsonc: "jsonc",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  conf: "ini",
  env: "shell",
  // Docs
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  // Systems
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  zig: "rust", // close enough until monaco ships zig grammar
  // Scripts
  py: "python",
  pyi: "python",
  rb: "ruby",
  php: "php",
  lua: "lua",
  pl: "perl",
  // JVM
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  groovy: "groovy",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  // .NET
  cs: "csharp",
  fs: "fsharp",
  fsx: "fsharp",
  vb: "vb",
  // Apple
  swift: "swift",
  m: "objective-c",
  mm: "objective-c",
  // Shell
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  // SQL / DB
  sql: "sql",
  // Misc
  dockerfile: "dockerfile",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  prisma: "plaintext",
  tf: "hcl",
  hcl: "hcl",
  // Notebooks (loaded raw, but at least JSON gets the right tokens)
  ipynb: "json",
};

function lastExt(path: string): string | null {
  const m = /\.([^./\\]+)$/.exec(path);
  return m ? m[1].toLowerCase() : null;
}

function basename(path: string): string {
  return (path.split(/[\\/]/).pop() || path).toLowerCase();
}

export function languageFromPath(path: string): string {
  if (!path) return "plaintext";
  const name = basename(path);
  if (BASENAME[name]) return BASENAME[name];
  // Dotfiles like ".eslintrc" -> treat as JSON if the contents start with
  // `{`, but we can't peek here. Fall back to plaintext rather than risk
  // a misleading colourisation.
  const ext = lastExt(path);
  if (ext && EXT[ext]) return EXT[ext];
  return "plaintext";
}
