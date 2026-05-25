/**
 * Per-extension file icon resolver.
 *
 * Centralises every "what icon for this filename" decision so the
 * file tree, tabs, breadcrumbs, finder and chat attachment previews
 * stay visually consistent. We map by basename (Dockerfile, README,
 * package.json…) first and by extension second.
 *
 * The icon set itself lives in `./fileIconSvgs.tsx` — every icon is
 * an original SVG component using brand-associated colours. The
 * resolver here is just routing. That separation makes it cheap to
 * add a new file type (one entry in the table) and lets the icon
 * library be tested independently of the routing logic.
 *
 * Backwards-compat note: the previous resolver returned
 * `{ Icon: LucideIcon, color: string }`. Callers destructured `Icon`
 * and `color` separately, threading the tailwind class onto the
 * rendered component. The new icons are self-coloured (the brand
 * tint lives inside the SVG itself), so we keep the same shape but
 * the `color` field is now an empty string — and `FileIconFor`
 * ignores it. Existing call sites continue to work unchanged.
 */

import type { FunctionComponent } from "react";
import {
  IconAnsible,
  IconArchive,
  IconAsciiDoc,
  IconAstro,
  IconAudio,
  IconBabel,
  IconBat,
  IconBicep,
  IconBinary,
  IconC,
  IconCpp,
  IconCHeader,
  IconCppHeader,
  IconCargo,
  IconChangelog,
  IconCI,
  IconClojure,
  IconCommitLint,
  IconConf,
  IconCrystal,
  IconCSharp,
  IconCSS,
  IconCSV,
  IconCypress,
  IconD,
  IconDart,
  IconDBGeneric,
  IconDocker,
  IconDockerfile,
  IconEditorConfig,
  IconEJS,
  IconElixir,
  IconElm,
  IconEnv,
  IconErb,
  IconErlang,
  IconESLint,
  IconEsbuild,
  IconExcel,
  IconExe,
  IconFont,
  IconFSharp,
  IconGemfile,
  IconGenericCode,
  IconGenericFile,
  IconGitFile,
  IconGitHubActions,
  IconGo,
  IconGoMod,
  IconGraphQL,
  IconGroovy,
  IconHandlebars,
  IconHaskell,
  IconHelm,
  IconHCL,
  IconHTML,
  IconIco,
  IconImage,
  IconINI,
  IconJava,
  IconJavaScript,
  IconJest,
  IconJinja,
  IconJSConfig,
  IconJSON,
  IconJSON5,
  IconJSONC,
  IconJSX,
  IconJulia,
  IconJupyter,
  IconKeyFile,
  IconKotlin,
  IconKubernetes,
  IconLaTeX,
  IconLess,
  IconLicense,
  IconLiquid,
  IconLockfile,
  IconLua,
  IconMarkdown,
  IconMakefile,
  IconMDX,
  IconMJS,
  IconCJS,
  IconMongo,
  IconNext,
  IconNim,
  IconNix,
  IconNpmrc,
  IconNvmrc,
  IconNuxt,
  IconObjC,
  IconObjCPlusPlus,
  IconOCaml,
  IconPackageJson,
  IconPdf,
  IconPerl,
  IconPHP,
  IconPlaywright,
  IconPostCSS,
  IconPowerPoint,
  IconPowerShell,
  IconPrettier,
  IconPrisma,
  IconPug,
  IconPulumi,
  IconPureScript,
  IconPyProject,
  IconPyi,
  IconPython,
  IconR,
  IconReadme,
  IconReason,
  IconRedis,
  IconReScript,
  IconReStructuredText,
  IconRequirements,
  IconRichText,
  IconRollup,
  IconRust,
  IconRuby,
  IconSass,
  IconScala,
  IconSCSS,
  IconShell as IconShellScript,
  IconSolidity,
  IconSQL,
  IconStylus,
  IconSvelte,
  IconSVG,
  IconSwift,
  IconTailwind,
  IconTerraform,
  IconText,
  IconTOML,
  IconTSConfig,
  IconTSV,
  IconTSX,
  IconTypeScript,
  IconV,
  IconVB,
  IconVideo,
  IconViteConfig,
  IconVitest,
  IconVue,
  IconWebpack,
  IconWord,
  IconXML,
  IconYAML,
  IconZig,
  type IconProps,
} from "./fileIconSvgs";

/** Component type every entry in our tables resolves to. The shape
 *  matches Lucide's `LucideIcon` signature closely enough that older
 *  callsites work without changes. */
export type FileIconComponent = FunctionComponent<IconProps>;

export type FileIconSpec = {
  Icon: FileIconComponent;
  /** Legacy field kept for backwards compatibility. The new icons
   *  are self-coloured (brand tint lives in the SVG), so this stays
   *  empty. Callers that still concatenate it onto a classname see
   *  a harmless empty string. */
  color: string;
};

const spec = (Icon: FileIconComponent): FileIconSpec => ({ Icon, color: "" });

// ──────────────────────────────────────────────────────────────────
// Basename table — matched against the lower-cased final path
// segment BEFORE extension fallback. This is how we recognise files
// like `Dockerfile` (no extension) or `package.json` (where the
// basename is more meaningful than `.json`).
// ──────────────────────────────────────────────────────────────────

const BASENAME: Record<string, FileIconSpec> = {
  // Container / shell environment
  dockerfile: spec(IconDockerfile),
  containerfile: spec(IconDockerfile),
  "docker-compose.yml": spec(IconDocker),
  "docker-compose.yaml": spec(IconDocker),
  ".dockerignore": spec(IconDocker),
  // Build runners
  makefile: spec(IconMakefile),
  gnumakefile: spec(IconMakefile),
  rakefile: spec(IconMakefile),
  justfile: spec(IconMakefile),
  procfile: spec(IconShellScript),
  jenkinsfile: spec(IconCI),
  // Package manifests / lockfiles
  "package.json": spec(IconPackageJson),
  "package-lock.json": spec(IconLockfile),
  "yarn.lock": spec(IconLockfile),
  "pnpm-lock.yaml": spec(IconLockfile),
  "bun.lockb": spec(IconLockfile),
  "bun.lock": spec(IconLockfile),
  "deno.lock": spec(IconLockfile),
  "cargo.toml": spec(IconCargo),
  "cargo.lock": spec(IconLockfile),
  "go.mod": spec(IconGoMod),
  "go.sum": spec(IconLockfile),
  "pyproject.toml": spec(IconPyProject),
  "requirements.txt": spec(IconRequirements),
  "requirements-dev.txt": spec(IconRequirements),
  "poetry.lock": spec(IconLockfile),
  pipfile: spec(IconRequirements),
  "pipfile.lock": spec(IconLockfile),
  "uv.lock": spec(IconLockfile),
  gemfile: spec(IconGemfile),
  "gemfile.lock": spec(IconLockfile),
  podfile: spec(IconGemfile),
  "podfile.lock": spec(IconLockfile),
  composer: spec(IconPHP),
  "composer.json": spec(IconPHP),
  "composer.lock": spec(IconLockfile),
  "mix.exs": spec(IconElixir),
  "mix.lock": spec(IconLockfile),
  "rebar.config": spec(IconErlang),
  "build.gradle": spec(IconGroovy),
  "build.gradle.kts": spec(IconKotlin),
  "settings.gradle": spec(IconGroovy),
  "settings.gradle.kts": spec(IconKotlin),
  "pom.xml": spec(IconJava),
  "build.sbt": spec(IconScala),
  "stack.yaml": spec(IconHaskell),
  // Docs
  "readme.md": spec(IconReadme),
  "readme.mdx": spec(IconReadme),
  "readme.txt": spec(IconReadme),
  "readme.rst": spec(IconReadme),
  readme: spec(IconReadme),
  license: spec(IconLicense),
  "license.md": spec(IconLicense),
  "license.txt": spec(IconLicense),
  copying: spec(IconLicense),
  authors: spec(IconLicense),
  "code_of_conduct.md": spec(IconReadme),
  "contributing.md": spec(IconReadme),
  "changelog.md": spec(IconChangelog),
  changelog: spec(IconChangelog),
  // Editor / tooling configs
  "tsconfig.json": spec(IconTSConfig),
  "tsconfig.node.json": spec(IconTSConfig),
  "tsconfig.base.json": spec(IconTSConfig),
  "tsconfig.app.json": spec(IconTSConfig),
  "tsconfig.build.json": spec(IconTSConfig),
  "jsconfig.json": spec(IconJSConfig),
  "vite.config.ts": spec(IconViteConfig),
  "vite.config.js": spec(IconViteConfig),
  "vite.config.mts": spec(IconViteConfig),
  "vitest.config.ts": spec(IconVitest),
  "vitest.config.js": spec(IconVitest),
  "tailwind.config.ts": spec(IconTailwind),
  "tailwind.config.js": spec(IconTailwind),
  "tailwind.config.mjs": spec(IconTailwind),
  "tailwind.config.cjs": spec(IconTailwind),
  "postcss.config.js": spec(IconPostCSS),
  "postcss.config.cjs": spec(IconPostCSS),
  "postcss.config.mjs": spec(IconPostCSS),
  "webpack.config.js": spec(IconWebpack),
  "rollup.config.js": spec(IconRollup),
  "esbuild.config.js": spec(IconEsbuild),
  "next.config.js": spec(IconNext),
  "next.config.mjs": spec(IconNext),
  "next.config.ts": spec(IconNext),
  "nuxt.config.ts": spec(IconNuxt),
  "svelte.config.js": spec(IconSvelte),
  "astro.config.mjs": spec(IconAstro),
  "babel.config.js": spec(IconBabel),
  "babel.config.json": spec(IconBabel),
  ".babelrc": spec(IconBabel),
  ".babelrc.json": spec(IconBabel),
  "jest.config.js": spec(IconJest),
  "jest.config.ts": spec(IconJest),
  "playwright.config.ts": spec(IconPlaywright),
  "playwright.config.js": spec(IconPlaywright),
  "cypress.config.ts": spec(IconCypress),
  "cypress.config.js": spec(IconCypress),
  "commitlint.config.js": spec(IconCommitLint),
  // Lint / format dotfiles
  ".prettierrc": spec(IconPrettier),
  ".prettierrc.json": spec(IconPrettier),
  ".prettierrc.js": spec(IconPrettier),
  ".prettierrc.yml": spec(IconPrettier),
  ".prettierrc.yaml": spec(IconPrettier),
  ".prettierignore": spec(IconPrettier),
  "prettier.config.js": spec(IconPrettier),
  "prettier.config.cjs": spec(IconPrettier),
  ".eslintrc": spec(IconESLint),
  ".eslintrc.json": spec(IconESLint),
  ".eslintrc.js": spec(IconESLint),
  ".eslintrc.cjs": spec(IconESLint),
  ".eslintrc.yml": spec(IconESLint),
  ".eslintrc.yaml": spec(IconESLint),
  ".eslintignore": spec(IconESLint),
  "eslint.config.js": spec(IconESLint),
  "eslint.config.mjs": spec(IconESLint),
  "eslint.config.ts": spec(IconESLint),
  ".editorconfig": spec(IconEditorConfig),
  ".stylelintrc": spec(IconCSS),
  ".stylelintrc.json": spec(IconCSS),
  // Git
  ".gitignore": spec(IconGitFile),
  ".gitattributes": spec(IconGitFile),
  ".gitmodules": spec(IconGitFile),
  ".gitkeep": spec(IconGitFile),
  ".mailmap": spec(IconGitFile),
  // npm / node
  ".npmrc": spec(IconNpmrc),
  ".npmignore": spec(IconNpmrc),
  ".nvmrc": spec(IconNvmrc),
  ".node-version": spec(IconNvmrc),
  ".tool-versions": spec(IconConf),
  // Env / secrets
  ".env": spec(IconEnv),
  ".env.local": spec(IconEnv),
  ".env.development": spec(IconEnv),
  ".env.development.local": spec(IconEnv),
  ".env.production": spec(IconEnv),
  ".env.production.local": spec(IconEnv),
  ".env.test": spec(IconEnv),
  ".env.example": spec(IconEnv),
  ".env.sample": spec(IconEnv),
  // CI
  ".travis.yml": spec(IconCI),
  ".gitlab-ci.yml": spec(IconCI),
  ".circleci": spec(IconCI),
  // Misc
  ".vscode": spec(IconConf),
  ".idea": spec(IconConf),
  ".gitconfig": spec(IconGitFile),
  ".bashrc": spec(IconShellScript),
  ".bash_profile": spec(IconShellScript),
  ".zshrc": spec(IconShellScript),
  ".profile": spec(IconShellScript),
  ".inputrc": spec(IconShellScript),
};

// ──────────────────────────────────────────────────────────────────
// Extension table. Keys are extensions without the leading dot,
// lower-cased.
// ──────────────────────────────────────────────────────────────────

const EXT: Record<string, FileIconSpec> = {
  // Web / JS / TS family
  ts: spec(IconTypeScript),
  cts: spec(IconTypeScript),
  mts: spec(IconTypeScript),
  tsx: spec(IconTSX),
  js: spec(IconJavaScript),
  jsx: spec(IconJSX),
  mjs: spec(IconMJS),
  cjs: spec(IconCJS),
  vue: spec(IconVue),
  svelte: spec(IconSvelte),
  astro: spec(IconAstro),
  // Styles
  css: spec(IconCSS),
  scss: spec(IconSCSS),
  sass: spec(IconSass),
  less: spec(IconLess),
  styl: spec(IconStylus),
  stylus: spec(IconStylus),
  pcss: spec(IconPostCSS),
  // Markup / templating
  html: spec(IconHTML),
  htm: spec(IconHTML),
  xhtml: spec(IconHTML),
  xml: spec(IconXML),
  xsl: spec(IconXML),
  xslt: spec(IconXML),
  ejs: spec(IconEJS),
  hbs: spec(IconHandlebars),
  handlebars: spec(IconHandlebars),
  mustache: spec(IconHandlebars),
  pug: spec(IconPug),
  jade: spec(IconPug),
  liquid: spec(IconLiquid),
  j2: spec(IconJinja),
  jinja: spec(IconJinja),
  jinja2: spec(IconJinja),
  // Data / config
  json: spec(IconJSON),
  jsonc: spec(IconJSONC),
  json5: spec(IconJSON5),
  yml: spec(IconYAML),
  yaml: spec(IconYAML),
  toml: spec(IconTOML),
  ini: spec(IconINI),
  conf: spec(IconConf),
  cfg: spec(IconConf),
  properties: spec(IconConf),
  env: spec(IconEnv),
  // Docs / prose
  md: spec(IconMarkdown),
  markdown: spec(IconMarkdown),
  mdx: spec(IconMDX),
  txt: spec(IconText),
  text: spec(IconText),
  log: spec(IconText),
  rtf: spec(IconRichText),
  rst: spec(IconReStructuredText),
  adoc: spec(IconAsciiDoc),
  asciidoc: spec(IconAsciiDoc),
  tex: spec(IconLaTeX),
  latex: spec(IconLaTeX),
  bib: spec(IconLaTeX),
  // Systems languages
  rs: spec(IconRust),
  go: spec(IconGo),
  c: spec(IconC),
  h: spec(IconCHeader),
  cc: spec(IconCpp),
  cpp: spec(IconCpp),
  cxx: spec(IconCpp),
  hpp: spec(IconCppHeader),
  hxx: spec(IconCppHeader),
  zig: spec(IconZig),
  nim: spec(IconNim),
  v: spec(IconV),
  d: spec(IconD),
  // Scripting
  py: spec(IconPython),
  pyi: spec(IconPyi),
  pyw: spec(IconPython),
  pyx: spec(IconPython),
  ipynb: spec(IconJupyter),
  rb: spec(IconRuby),
  erb: spec(IconErb),
  cr: spec(IconCrystal),
  php: spec(IconPHP),
  phtml: spec(IconPHP),
  pl: spec(IconPerl),
  pm: spec(IconPerl),
  lua: spec(IconLua),
  // JVM
  java: spec(IconJava),
  kt: spec(IconKotlin),
  kts: spec(IconKotlin),
  scala: spec(IconScala),
  sc: spec(IconScala),
  groovy: spec(IconGroovy),
  gradle: spec(IconGroovy),
  clj: spec(IconClojure),
  cljs: spec(IconClojure),
  cljc: spec(IconClojure),
  edn: spec(IconClojure),
  // .NET
  cs: spec(IconCSharp),
  csx: spec(IconCSharp),
  fs: spec(IconFSharp),
  fsx: spec(IconFSharp),
  fsi: spec(IconFSharp),
  vb: spec(IconVB),
  // Apple
  swift: spec(IconSwift),
  m: spec(IconObjC),
  mm: spec(IconObjCPlusPlus),
  // Functional
  hs: spec(IconHaskell),
  lhs: spec(IconHaskell),
  ml: spec(IconOCaml),
  mli: spec(IconOCaml),
  erl: spec(IconErlang),
  hrl: spec(IconErlang),
  ex: spec(IconElixir),
  exs: spec(IconElixir),
  eex: spec(IconElixir),
  elm: spec(IconElm),
  re: spec(IconReason),
  res: spec(IconReScript),
  resi: spec(IconReScript),
  purs: spec(IconPureScript),
  // Other
  r: spec(IconR),
  dart: spec(IconDart),
  jl: spec(IconJulia),
  nix: spec(IconNix),
  sol: spec(IconSolidity),
  tf: spec(IconTerraform),
  tfvars: spec(IconTerraform),
  hcl: spec(IconHCL),
  graphql: spec(IconGraphQL),
  gql: spec(IconGraphQL),
  bicep: spec(IconBicep),
  // Shell
  sh: spec(IconShellScript),
  bash: spec(IconShellScript),
  zsh: spec(IconShellScript),
  fish: spec(IconShellScript),
  ksh: spec(IconShellScript),
  ps1: spec(IconPowerShell),
  psm1: spec(IconPowerShell),
  psd1: spec(IconPowerShell),
  bat: spec(IconBat),
  cmd: spec(IconBat),
  // Databases
  sql: spec(IconSQL),
  mysql: spec(IconSQL),
  pgsql: spec(IconSQL),
  psql: spec(IconSQL),
  db: spec(IconDBGeneric),
  sqlite: spec(IconDBGeneric),
  sqlite3: spec(IconDBGeneric),
  prisma: spec(IconPrisma),
  // Spreadsheets / Office
  csv: spec(IconCSV),
  tsv: spec(IconTSV),
  xls: spec(IconExcel),
  xlsx: spec(IconExcel),
  ods: spec(IconExcel),
  numbers: spec(IconExcel),
  doc: spec(IconWord),
  docx: spec(IconWord),
  ppt: spec(IconPowerPoint),
  pptx: spec(IconPowerPoint),
  pdf: spec(IconPdf),
  // Images
  png: spec(IconImage),
  jpg: spec(IconImage),
  jpeg: spec(IconImage),
  gif: spec(IconImage),
  webp: spec(IconImage),
  bmp: spec(IconImage),
  tiff: spec(IconImage),
  tif: spec(IconImage),
  heic: spec(IconImage),
  avif: spec(IconImage),
  ico: spec(IconIco),
  svg: spec(IconSVG),
  // Fonts
  ttf: spec(IconFont),
  otf: spec(IconFont),
  woff: spec(IconFont),
  woff2: spec(IconFont),
  eot: spec(IconFont),
  // Audio
  mp3: spec(IconAudio),
  wav: spec(IconAudio),
  ogg: spec(IconAudio),
  flac: spec(IconAudio),
  aac: spec(IconAudio),
  m4a: spec(IconAudio),
  opus: spec(IconAudio),
  // Video
  mp4: spec(IconVideo),
  mov: spec(IconVideo),
  mkv: spec(IconVideo),
  webm: spec(IconVideo),
  avi: spec(IconVideo),
  m4v: spec(IconVideo),
  wmv: spec(IconVideo),
  // Archives
  zip: spec(IconArchive),
  tar: spec(IconArchive),
  gz: spec(IconArchive),
  tgz: spec(IconArchive),
  bz2: spec(IconArchive),
  xz: spec(IconArchive),
  "7z": spec(IconArchive),
  rar: spec(IconArchive),
  zst: spec(IconArchive),
  // Binaries / lock-shaped
  exe: spec(IconExe),
  dll: spec(IconBinary),
  bin: spec(IconBinary),
  so: spec(IconBinary),
  dylib: spec(IconBinary),
  o: spec(IconBinary),
  obj: spec(IconBinary),
  a: spec(IconBinary),
  app: spec(IconBinary),
  lock: spec(IconLockfile),
  pem: spec(IconKeyFile),
  key: spec(IconKeyFile),
  crt: spec(IconKeyFile),
  cer: spec(IconKeyFile),
  p12: spec(IconKeyFile),
  pfx: spec(IconKeyFile),
  asc: spec(IconKeyFile),
  // Infrastructure / extras
  helm: spec(IconHelm),
  ansible: spec(IconAnsible),
  pulumi: spec(IconPulumi),
  mongo: spec(IconMongo),
  redis: spec(IconRedis),
};

const FALLBACK: FileIconSpec = spec(IconGenericFile);

/**
 * Resolve a (filename → icon component) for non-directory entries.
 *
 * The lookup goes basename-first, extension-second, fallback last.
 * Accepts both bare filenames and full paths; we always look at the
 * last path segment.
 */
export function fileIcon(name: string): FileIconSpec {
  if (!name) return FALLBACK;
  const seg = name.split(/[\\/]/).pop() || name;
  const lower = seg.toLowerCase();
  if (BASENAME[lower]) return BASENAME[lower];
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) {
    // Either no extension at all, or it's a leading-dot file like
    // `.env.something` that wasn't caught by BASENAME above. Try
    // the suffix-after-final-dot one more time before giving up.
    if (dot === -1) return FALLBACK;
    const tail = lower.slice(dot + 1);
    if (EXT[tail]) return EXT[tail];
    return FALLBACK;
  }
  const ext = lower.slice(dot + 1);
  return EXT[ext] || FALLBACK;
}

/**
 * Convenience component: render the resolved icon at the requested
 * size with an optional className. The legacy `color` field on the
 * spec is intentionally not applied here — the new icons are
 * self-coloured, and forwarding a tailwind text-* class would
 * fight with the SVG fills.
 */
export function FileIconFor({
  name,
  size = 12,
  className,
  "aria-hidden": ariaHidden,
}: {
  name: string;
  size?: number;
  className?: string;
  /** When true, marks the icon as decorative for assistive tech.
   *  We can't pass arbitrary props through Lucide's prop type, so
   *  we mirror the attribute on the rendered SVG explicitly. */
  "aria-hidden"?: boolean | "true" | "false";
}) {
  const { Icon } = fileIcon(name);
  return (
    <Icon
      size={size}
      className={className}
      aria-hidden={ariaHidden ?? true}
    />
  );
}
