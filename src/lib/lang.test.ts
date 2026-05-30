import { describe, expect, it } from "vitest";
import { languageFromPath } from "./lang";

describe("languageFromPath", () => {
  it("recognises common code extensions", () => {
    expect(languageFromPath("src/App.tsx")).toBe("typescript");
    expect(languageFromPath("src/App.jsx")).toBe("javascript");
    expect(languageFromPath("src/app.js")).toBe("javascript");
    expect(languageFromPath("main.rs")).toBe("rust");
    expect(languageFromPath("module.py")).toBe("python");
    expect(languageFromPath("svc/main.go")).toBe("go");
  });

  it("handles MDX as a first-class language", () => {
    expect(languageFromPath("docs/getting-started.mdx")).toBe("mdx");
  });

  it("matches basename rules above extension rules", () => {
    expect(languageFromPath("repo/Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("repo/Dockerfile.dev")).toBe("dockerfile");
    expect(languageFromPath("repo/Makefile")).toBe("makefile");
    expect(languageFromPath("repo/Makefile.am")).toBe("makefile");
    expect(languageFromPath("repo/Cargo.toml")).toBe("toml");
    expect(languageFromPath("repo/Cargo.lock")).toBe("toml");
    expect(languageFromPath("repo/package.json")).toBe("json");
  });

  it("recognises extensionless config files that Monaco can validate", () => {
    expect(languageFromPath("repo/.eslintrc")).toBe("json");
    expect(languageFromPath("repo/.prettierrc")).toBe("json");
    expect(languageFromPath("repo/.editorconfig")).toBe("ini");
    expect(languageFromPath("repo/.env.local")).toBe("shell");
  });

  it("maps JSON-with-comments files to Monaco's JSON worker", () => {
    expect(languageFromPath("repo/tsconfig.base.jsonc")).toBe("json");
    expect(languageFromPath("repo/deno.jsonc")).toBe("json");
  });

  it("recognises common framework and infra extensions", () => {
    expect(languageFromPath("build.gradle")).toBe("groovy");
    expect(languageFromPath("vars.tfvars")).toBe("hcl");
    expect(languageFromPath("views/index.erb")).toBe("erb");
    expect(languageFromPath("views/index.ejs")).toBe("ejs");
    expect(languageFromPath("views/user.tmpl")).toBe("ejs");
    expect(languageFromPath("src/App.vue")).toBe("vue");
    expect(languageFromPath("Info.plist")).toBe("xml");
    expect(languageFromPath("schema.prisma")).toBe("prisma");
    expect(languageFromPath("contracts/Vault.sol")).toBe("solidity");
    expect(languageFromPath("shader.wgsl")).toBe("wgsl");
    expect(languageFromPath("infra/main.bicep")).toBe("bicep");
    expect(languageFromPath("template.hbs")).toBe("handlebars");
  });

  it("maps less common bundled Monaco languages when extensions are unambiguous", () => {
    expect(languageFromPath("lib/app.ex")).toBe("elixir");
    expect(languageFromPath("notebook.jl")).toBe("julia");
    expect(languageFromPath("plot.R")).toBe("r");
    expect(languageFromPath("component.cshtml")).toBe("razor");
    expect(languageFromPath("types/main.tsp")).toBe("typespec");
    expect(languageFromPath("hdl/top.sv")).toBe("system-verilog");
    expect(languageFromPath("src/main.zig")).toBe("zig");
    expect(languageFromPath("flake.nix")).toBe("nix");
    expect(languageFromPath("app/Main.hs")).toBe("haskell");
    expect(languageFromPath("src/server.erl")).toBe("erlang");
    expect(languageFromPath("src/Main.elm")).toBe("elm");
    expect(languageFromPath("lib/parser.mli")).toBe("ocaml");
    expect(languageFromPath("src/shard.cr")).toBe("crystal");
    expect(languageFromPath("src/main.nim")).toBe("nim");
    expect(languageFromPath("source/app.d")).toBe("d");
    expect(languageFromPath("styles/app.styl")).toBe("stylus");
    expect(languageFromPath("paper/main.tex")).toBe("latex");
    expect(languageFromPath("lang/main.rkt")).toBe("racket");
  });

  it("falls back to plaintext on unknown extensions", () => {
    expect(languageFromPath("strange.zzz")).toBe("plaintext");
  });

  it("returns plaintext for empty or no-extension paths", () => {
    expect(languageFromPath("")).toBe("plaintext");
    expect(languageFromPath("no-extension")).toBe("plaintext");
  });

  it("is case-insensitive on extensions but case-sensitive on basenames", () => {
    // `.TS` should match the ts mapping.
    expect(languageFromPath("file.TS")).toBe("typescript");
    // Lower-casing means our basename table catches both Dockerfile and
    // dockerfile flavours.
    expect(languageFromPath("repo/dockerfile")).toBe("dockerfile");
  });
});
