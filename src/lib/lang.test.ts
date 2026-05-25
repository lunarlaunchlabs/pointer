import { describe, expect, it } from "vitest";
import { languageFromPath } from "./lang";

describe("languageFromPath", () => {
  it("recognises common code extensions", () => {
    expect(languageFromPath("src/App.tsx")).toBe("typescript");
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
    expect(languageFromPath("repo/Makefile")).toBe("makefile");
    expect(languageFromPath("repo/Cargo.toml")).toBe("toml");
    expect(languageFromPath("repo/package.json")).toBe("json");
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
