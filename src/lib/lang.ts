/**
 * Map a file path to a Monaco language id.
 *
 * The table is deliberately exhaustive. IDs here are either native Monaco
 * languages or TextMate/Shiki-backed languages registered in `setupMonaco`.
 * When in doubt: a missing id falls back to plaintext, which is still
 * searchable / editable but loses colour.
 *
 * We also key on basenames (Dockerfile, Makefile, etc.) because real-world
 * repos rely on case-sensitive basename detection just as much as extensions.
 */

const BASENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  "gnumakefile": "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  podfile: "ruby",
  "package.json": "json",
  "package-lock.json": "json",
  "tsconfig.json": "json",
  "jsconfig.json": "json",
  "deno.json": "json",
  "deno.jsonc": "json",
  "cargo.toml": "toml",
  "cargo.lock": "toml",
  "pyproject.toml": "toml",
  "go.mod": "go",
  "go.sum": "go",
  "go.work": "go",
  ".gitignore": "plaintext",
  ".gitattributes": "plaintext",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".yarnrc": "ini",
  ".env": "shell",
  ".eslintrc": "json",
  ".prettierrc": "json",
  ".babelrc": "json",
  ".stylelintrc": "json",
  ".swcrc": "json",
  ".dockerignore": "plaintext",
  "license": "plaintext",
};

const EXT: Record<string, string> = {
  // JS/TS family
  ts: "typescript",
  tsx: "tsx",
  cts: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  // Other web languages
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  // Markup
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  pug: "pug",
  jade: "pug",
  hbs: "handlebars",
  handlebars: "handlebars",
  ejs: "ejs",
  tmpl: "ejs",
  liquid: "liquid",
  twig: "twig",
  cshtml: "razor",
  // Style
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  // Data
  json: "json",
  jsonc: "json",
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
  erb: "erb",
  php: "php",
  lua: "lua",
  pl: "perl",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  jl: "julia",
  r: "r",
  rmd: "r",
  // JVM
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  groovy: "groovy",
  gradle: "groovy",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  // .NET
  cs: "csharp",
  fs: "fsharp",
  fsx: "fsharp",
  fsi: "fsharp",
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
  bicep: "bicep",
  dockerfile: "dockerfile",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  prisma: "prisma",
  sol: "solidity",
  wgsl: "wgsl",
  qs: "qsharp",
  tsp: "typespec",
  sv: "system-verilog",
  svh: "system-verilog",
  v: "verilog",
  vh: "verilog",
  tf: "hcl",
  tfvars: "hcl",
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
  if (/^(dockerfile|containerfile)(\..+)?$/.test(name)) return "dockerfile";
  if (/^makefile(\..+)?$/.test(name)) return "makefile";
  if (/^\.env(\..+)?$/.test(name)) return "shell";
  if (BASENAME[name]) return BASENAME[name];
  // Dotfiles like ".eslintrc" -> treat as JSON if the contents start with
  // `{`, but we can't peek here. Fall back to plaintext rather than risk
  // a misleading colourisation.
  const ext = lastExt(path);
  if (ext && EXT[ext]) return EXT[ext];
  return "plaintext";
}
