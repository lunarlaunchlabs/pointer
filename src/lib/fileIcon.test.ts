/**
 * fileIcon resolver tests.
 *
 * The resolver routes a filename to a custom SVG icon component. We
 * pin behaviour with three layers of assertions:
 *
 *   1. Routing — basename / extension / fallback precedence works.
 *   2. Distinctness — every documented extension AND basename should
 *      resolve to a *named* icon, not the generic fallback. Anything
 *      slipping through to the fallback is almost certainly a typo
 *      or a missing wiring.
 *   3. Distinct components — the dozens of categories don't all map
 *      to the same component (a regression we'd want to catch).
 */

import { describe, expect, it } from "vitest";
import { fileIcon } from "./fileIcon";
import * as Icons from "./fileIconSvgs";

describe("fileIcon — routing", () => {
  it("matches basenames before extensions", () => {
    const docker = fileIcon("Dockerfile");
    const json = fileIcon("package.json");
    // Dockerfile basename hit → IconDockerfile (pictogram), not the
    // generic .json icon.
    expect(docker.Icon).toBe(Icons.IconDockerfile);
    expect(json.Icon).toBe(Icons.IconPackageJson);
  });

  it("uses the last segment of a path", () => {
    const direct = fileIcon("README.md");
    const nested = fileIcon("docs/intro/README.md");
    expect(nested).toEqual(direct);
  });

  it("is case-insensitive", () => {
    expect(fileIcon("FOO.TS").Icon).toBe(Icons.IconTypeScript);
    expect(fileIcon("foo.Ts").Icon).toBe(Icons.IconTypeScript);
  });

  it("falls back gracefully for unknown names", () => {
    const unknown = fileIcon("strange.zzz");
    expect(unknown.Icon).toBe(Icons.IconGenericFile);
    // Empty input yields the same fallback rather than throwing.
    expect(fileIcon("").Icon).toBe(Icons.IconGenericFile);
  });

  it("treats multi-dot names by their final extension", () => {
    expect(fileIcon("Button.test.tsx").Icon).toBe(Icons.IconTSX);
    // vite.config.ts is basename-matched first.
    expect(fileIcon("vite.config.ts").Icon).toBe(Icons.IconViteConfig);
  });

  it("keeps the legacy `color` field empty (backwards-compat shim)", () => {
    // The new icons embed their colour in the SVG; callers that
    // still string-concat `color` see an empty string.
    expect(fileIcon("App.tsx").color).toBe("");
  });
});

describe("fileIcon — language coverage", () => {
  // For each well-known extension, the resolver should return a
  // SPECIFIC named icon (not the fallback). This catches typos in
  // the EXT table immediately.
  const cases: Array<[string, keyof typeof Icons]> = [
    // JS / TS
    ["x.ts", "IconTypeScript"],
    ["x.tsx", "IconTSX"],
    ["x.js", "IconJavaScript"],
    ["x.jsx", "IconJSX"],
    ["x.mjs", "IconMJS"],
    ["x.cjs", "IconCJS"],
    ["x.vue", "IconVue"],
    ["x.svelte", "IconSvelte"],
    ["x.astro", "IconAstro"],
    // Styles
    ["x.css", "IconCSS"],
    ["x.scss", "IconSCSS"],
    ["x.sass", "IconSass"],
    ["x.less", "IconLess"],
    ["x.styl", "IconStylus"],
    ["x.pcss", "IconPostCSS"],
    // Markup
    ["x.html", "IconHTML"],
    ["x.htm", "IconHTML"],
    ["x.xml", "IconXML"],
    ["x.ejs", "IconEJS"],
    ["x.hbs", "IconHandlebars"],
    ["x.pug", "IconPug"],
    ["x.liquid", "IconLiquid"],
    ["x.jinja", "IconJinja"],
    // Data / config
    ["x.json", "IconJSON"],
    ["x.jsonc", "IconJSONC"],
    ["x.json5", "IconJSON5"],
    ["x.yml", "IconYAML"],
    ["x.yaml", "IconYAML"],
    ["x.toml", "IconTOML"],
    ["x.ini", "IconINI"],
    ["x.conf", "IconConf"],
    ["x.cfg", "IconConf"],
    ["x.env", "IconEnv"],
    // Docs
    ["x.md", "IconMarkdown"],
    ["x.mdx", "IconMDX"],
    ["x.txt", "IconText"],
    ["x.rtf", "IconRichText"],
    ["x.rst", "IconReStructuredText"],
    ["x.adoc", "IconAsciiDoc"],
    ["x.tex", "IconLaTeX"],
    // Systems
    ["x.rs", "IconRust"],
    ["x.go", "IconGo"],
    ["x.c", "IconC"],
    ["x.h", "IconCHeader"],
    ["x.cpp", "IconCpp"],
    ["x.hpp", "IconCppHeader"],
    ["x.zig", "IconZig"],
    ["x.nim", "IconNim"],
    ["x.v", "IconV"],
    ["x.d", "IconD"],
    // Scripts
    ["x.py", "IconPython"],
    ["x.pyi", "IconPyi"],
    ["x.ipynb", "IconJupyter"],
    ["x.rb", "IconRuby"],
    ["x.erb", "IconErb"],
    ["x.cr", "IconCrystal"],
    ["x.php", "IconPHP"],
    ["x.pl", "IconPerl"],
    ["x.lua", "IconLua"],
    // JVM
    ["x.java", "IconJava"],
    ["x.kt", "IconKotlin"],
    ["x.scala", "IconScala"],
    ["x.groovy", "IconGroovy"],
    ["x.clj", "IconClojure"],
    // .NET
    ["x.cs", "IconCSharp"],
    ["x.fs", "IconFSharp"],
    ["x.vb", "IconVB"],
    // Apple
    ["x.swift", "IconSwift"],
    ["x.m", "IconObjC"],
    ["x.mm", "IconObjCPlusPlus"],
    // Functional
    ["x.hs", "IconHaskell"],
    ["x.ml", "IconOCaml"],
    ["x.erl", "IconErlang"],
    ["x.ex", "IconElixir"],
    ["x.elm", "IconElm"],
    ["x.re", "IconReason"],
    ["x.res", "IconReScript"],
    ["x.purs", "IconPureScript"],
    // Other
    ["x.r", "IconR"],
    ["x.dart", "IconDart"],
    ["x.jl", "IconJulia"],
    ["x.nix", "IconNix"],
    ["x.sol", "IconSolidity"],
    ["x.tf", "IconTerraform"],
    ["x.hcl", "IconHCL"],
    ["x.graphql", "IconGraphQL"],
    ["x.gql", "IconGraphQL"],
    // Shell
    ["x.sh", "IconShell"],
    ["x.bash", "IconShell"],
    ["x.zsh", "IconShell"],
    ["x.ps1", "IconPowerShell"],
    ["x.bat", "IconBat"],
    // DB
    ["x.sql", "IconSQL"],
    ["x.sqlite", "IconDBGeneric"],
    ["x.prisma", "IconPrisma"],
    // Spreadsheets / Office
    ["x.csv", "IconCSV"],
    ["x.tsv", "IconTSV"],
    ["x.xlsx", "IconExcel"],
    ["x.docx", "IconWord"],
    ["x.pptx", "IconPowerPoint"],
    ["x.pdf", "IconPdf"],
    // Images
    ["x.png", "IconImage"],
    ["x.jpg", "IconImage"],
    ["x.gif", "IconImage"],
    ["x.webp", "IconImage"],
    ["x.svg", "IconSVG"],
    ["x.ico", "IconIco"],
    ["x.avif", "IconImage"],
    // Fonts
    ["x.ttf", "IconFont"],
    ["x.woff2", "IconFont"],
    // Media
    ["x.mp3", "IconAudio"],
    ["x.wav", "IconAudio"],
    ["x.mp4", "IconVideo"],
    ["x.mov", "IconVideo"],
    // Archives
    ["x.zip", "IconArchive"],
    ["x.tar", "IconArchive"],
    ["x.gz", "IconArchive"],
    ["x.7z", "IconArchive"],
    // Binaries / certs
    ["x.exe", "IconExe"],
    ["x.dll", "IconBinary"],
    ["x.so", "IconBinary"],
    ["x.pem", "IconKeyFile"],
    ["x.crt", "IconKeyFile"],
  ];

  for (const [name, expectedKey] of cases) {
    it(`maps ${name} to ${expectedKey}`, () => {
      const got = fileIcon(name);
      expect(got.Icon).toBe(Icons[expectedKey]);
      expect(got.Icon).not.toBe(Icons.IconGenericFile);
    });
  }
});

describe("fileIcon — basename coverage", () => {
  const cases: Array<[string, keyof typeof Icons]> = [
    ["Dockerfile", "IconDockerfile"],
    ["Containerfile", "IconDockerfile"],
    ["Makefile", "IconMakefile"],
    ["Gemfile", "IconGemfile"],
    ["Rakefile", "IconMakefile"],
    ["Justfile", "IconMakefile"],
    ["Jenkinsfile", "IconCI"],
    ["package.json", "IconPackageJson"],
    ["package-lock.json", "IconLockfile"],
    ["yarn.lock", "IconLockfile"],
    ["pnpm-lock.yaml", "IconLockfile"],
    ["bun.lockb", "IconLockfile"],
    ["Cargo.toml", "IconCargo"],
    ["Cargo.lock", "IconLockfile"],
    ["go.mod", "IconGoMod"],
    ["go.sum", "IconLockfile"],
    ["pyproject.toml", "IconPyProject"],
    ["requirements.txt", "IconRequirements"],
    ["poetry.lock", "IconLockfile"],
    ["pipfile", "IconRequirements"],
    ["pipfile.lock", "IconLockfile"],
    ["README.md", "IconReadme"],
    ["README", "IconReadme"],
    ["LICENSE", "IconLicense"],
    ["CHANGELOG.md", "IconChangelog"],
    ["tsconfig.json", "IconTSConfig"],
    ["jsconfig.json", "IconJSConfig"],
    ["vite.config.ts", "IconViteConfig"],
    ["vitest.config.ts", "IconVitest"],
    ["tailwind.config.ts", "IconTailwind"],
    ["postcss.config.js", "IconPostCSS"],
    ["webpack.config.js", "IconWebpack"],
    ["next.config.ts", "IconNext"],
    ["nuxt.config.ts", "IconNuxt"],
    [".env", "IconEnv"],
    [".env.local", "IconEnv"],
    [".env.production", "IconEnv"],
    [".gitignore", "IconGitFile"],
    [".gitattributes", "IconGitFile"],
    [".npmrc", "IconNpmrc"],
    [".nvmrc", "IconNvmrc"],
    [".prettierrc", "IconPrettier"],
    [".eslintrc", "IconESLint"],
    [".editorconfig", "IconEditorConfig"],
    ["docker-compose.yml", "IconDocker"],
    ["pom.xml", "IconJava"],
    ["build.gradle", "IconGroovy"],
    ["build.gradle.kts", "IconKotlin"],
    ["mix.exs", "IconElixir"],
    [".gitlab-ci.yml", "IconCI"],
    [".travis.yml", "IconCI"],
  ];

  for (const [name, expectedKey] of cases) {
    it(`maps ${name} to ${expectedKey}`, () => {
      const got = fileIcon(name);
      expect(got.Icon).toBe(Icons[expectedKey]);
    });
  }
});

describe("fileIcon — visual distinctness", () => {
  it("uses distinct icons for the JS family (JS / TS / JSX / TSX)", () => {
    const components = new Set([
      fileIcon("x.js").Icon,
      fileIcon("x.ts").Icon,
      fileIcon("x.jsx").Icon,
      fileIcon("x.tsx").Icon,
    ]);
    expect(components.size).toBe(4);
  });

  it("uses distinct icons for the CSS preprocessor family", () => {
    const components = new Set([
      fileIcon("a.css").Icon,
      fileIcon("a.scss").Icon,
      fileIcon("a.sass").Icon,
      fileIcon("a.less").Icon,
      fileIcon("a.styl").Icon,
    ]);
    expect(components.size).toBe(5);
  });

  it("uses distinct icons for header / source pairs", () => {
    expect(fileIcon("foo.c").Icon).not.toBe(fileIcon("foo.h").Icon);
    expect(fileIcon("foo.cpp").Icon).not.toBe(fileIcon("foo.hpp").Icon);
  });

  it("uses distinct icons for ESM / CommonJS modules", () => {
    expect(fileIcon("a.mjs").Icon).not.toBe(fileIcon("a.cjs").Icon);
    expect(fileIcon("a.mjs").Icon).not.toBe(fileIcon("a.js").Icon);
  });
});
