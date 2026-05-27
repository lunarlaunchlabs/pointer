import type { Monaco } from "@monaco-editor/react";
import { POINTER_NOIR_ID, pointerNoirShikiTheme } from "@/theme/pointer-noir";

type LanguageRegistration = {
  id: string;
  extensions?: string[];
  aliases?: string[];
  filenames?: string[];
};

const SHIKI_LANGUAGE_LOADERS = [
  () => import("@shikijs/langs/astro"),
  () => import("@shikijs/langs/bash"),
  () => import("@shikijs/langs/bat"),
  () => import("@shikijs/langs/bicep"),
  () => import("@shikijs/langs/c"),
  () => import("@shikijs/langs/clojure"),
  () => import("@shikijs/langs/cpp"),
  () => import("@shikijs/langs/csharp"),
  () => import("@shikijs/langs/css"),
  () => import("@shikijs/langs/dart"),
  () => import("@shikijs/langs/dockerfile"),
  () => import("@shikijs/langs/dotenv"),
  () => import("@shikijs/langs/elixir"),
  () => import("@shikijs/langs/erb"),
  () => import("@shikijs/langs/fsharp"),
  () => import("@shikijs/langs/go"),
  () => import("@shikijs/langs/graphql"),
  () => import("@shikijs/langs/groovy"),
  () => import("@shikijs/langs/handlebars"),
  () => import("@shikijs/langs/hcl"),
  () => import("@shikijs/langs/html"),
  () => import("@shikijs/langs/ini"),
  () => import("@shikijs/langs/java"),
  () => import("@shikijs/langs/javascript"),
  () => import("@shikijs/langs/jsx"),
  () => import("@shikijs/langs/json"),
  () => import("@shikijs/langs/julia"),
  () => import("@shikijs/langs/kotlin"),
  () => import("@shikijs/langs/less"),
  () => import("@shikijs/langs/liquid"),
  () => import("@shikijs/langs/log"),
  () => import("@shikijs/langs/lua"),
  () => import("@shikijs/langs/makefile"),
  () => import("@shikijs/langs/markdown"),
  () => import("@shikijs/langs/mdx"),
  () => import("@shikijs/langs/objective-c"),
  () => import("@shikijs/langs/perl"),
  () => import("@shikijs/langs/php"),
  () => import("@shikijs/langs/prisma"),
  () => import("@shikijs/langs/proto"),
  () => import("@shikijs/langs/pug"),
  () => import("@shikijs/langs/python"),
  () => import("@shikijs/langs/r"),
  () => import("@shikijs/langs/razor"),
  () => import("@shikijs/langs/ruby"),
  () => import("@shikijs/langs/rust"),
  () => import("@shikijs/langs/sass"),
  () => import("@shikijs/langs/scala"),
  () => import("@shikijs/langs/scss"),
  () => import("@shikijs/langs/shell"),
  () => import("@shikijs/langs/solidity"),
  () => import("@shikijs/langs/sql"),
  () => import("@shikijs/langs/svelte"),
  () => import("@shikijs/langs/swift"),
  () => import("@shikijs/langs/system-verilog"),
  () => import("@shikijs/langs/toml"),
  () => import("@shikijs/langs/tsx"),
  () => import("@shikijs/langs/twig"),
  () => import("@shikijs/langs/typescript"),
  () => import("@shikijs/langs/typespec"),
  () => import("@shikijs/langs/verilog"),
  () => import("@shikijs/langs/vim"),
  () => import("@shikijs/langs/vue"),
  () => import("@shikijs/langs/wgsl"),
  () => import("@shikijs/langs/xml"),
  () => import("@shikijs/langs/yaml"),
];

const TEXTMATE_LANGUAGE_REGISTRATIONS: LanguageRegistration[] = [
  { id: "astro", extensions: [".astro"], aliases: ["Astro", "astro"] },
  { id: "dotenv", extensions: [".env"], aliases: ["dotenv", "env"] },
  { id: "erb", extensions: [".erb"], aliases: ["ERB", "erb"] },
  { id: "jsx", extensions: [".jsx"], aliases: ["JSX", "jsx"] },
  { id: "log", extensions: [".log"], aliases: ["Log", "log"] },
  { id: "mdx", extensions: [".mdx"], aliases: ["MDX", "mdx"] },
  { id: "solidity", extensions: [".sol"], aliases: ["Solidity", "sol"] },
  { id: "svelte", extensions: [".svelte"], aliases: ["Svelte", "svelte"] },
  { id: "system-verilog", extensions: [".sv", ".svh"], aliases: ["SystemVerilog"] },
  { id: "tsx", extensions: [".tsx"], aliases: ["TSX", "tsx"] },
];

let setupPromise: Promise<void> | null = null;

export function setupShikiMonaco(monaco: Monaco): Promise<void> {
  if (!setupPromise) {
    setupPromise = installShiki(monaco).catch((error) => {
      setupPromise = null;
      console.warn("Pointer could not install TextMate highlighting.", error);
    });
  }
  return setupPromise;
}

async function installShiki(monaco: Monaco) {
  registerTextmateLanguageIds(monaco);

  const [
    { createHighlighterCore },
    { createJavaScriptRegexEngine },
    { shikiToMonaco },
    ...languageModules
  ] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("@shikijs/monaco"),
    ...SHIKI_LANGUAGE_LOADERS.map((load) => load()),
  ]);

  const highlighter = await createHighlighterCore({
    themes: [pointerNoirShikiTheme],
    langs: languageModules.flatMap((module) => module.default) as any,
    engine: createJavaScriptRegexEngine(),
  });

  shikiToMonaco(highlighter, monaco as any, {
    tokenizeMaxLineLength: 40_000,
    tokenizeTimeLimit: 500,
  });
  monaco.editor.setTheme(POINTER_NOIR_ID);
}

function registerTextmateLanguageIds(monaco: Monaco) {
  for (const registration of TEXTMATE_LANGUAGE_REGISTRATIONS) {
    try {
      monaco.languages.register(registration);
    } catch {
      /* Monaco already knows this id or this build does not accept it. */
    }
  }

  monaco.languages.setLanguageConfiguration("tsx", typescriptLikeLanguageConfig());
  monaco.languages.setLanguageConfiguration("jsx", typescriptLikeLanguageConfig());
  monaco.languages.setLanguageConfiguration("astro", htmlLikeLanguageConfig());
  monaco.languages.setLanguageConfiguration("svelte", htmlLikeLanguageConfig());
  monaco.languages.setLanguageConfiguration("vue", htmlLikeLanguageConfig());
}

function typescriptLikeLanguageConfig() {
  return {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] as [string, string] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
      ["<", ">"],
    ] as [string, string][],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "<", close: ">" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "<", close: ">" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
    ],
  };
}

function htmlLikeLanguageConfig() {
  return {
    comments: { blockComment: ["<!--", "-->"] as [string, string] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
      ["<", ">"],
    ] as [string, string][],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "<", close: ">" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "<", close: ">" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
    ],
  };
}
