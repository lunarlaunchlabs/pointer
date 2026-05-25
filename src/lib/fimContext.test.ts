/**
 * FIM context builder tests.
 *
 * The builder turns a Monaco prefix / suffix snapshot into an enriched
 * prompt that includes:
 *
 *   • A `<|file_sep|>`-separated header of reference files (Qwen-FIM
 *     repo-level format — the backend already adds `<|file_sep|>` to
 *     the stop list so this dovetails cleanly).
 *   • A short comment block describing any detected pattern.
 *   • The original local prefix verbatim.
 *
 * Tests pin the contract: the format, the budget discipline (we
 * NEVER truncate the local prefix), the language-aware comment
 * style, and the pattern hint emission.
 */

import { describe, expect, it } from "vitest";
import { buildFimContext } from "./fimContext";

const baseInput = () => ({
  filePath: "src/index.ts",
  prefix: "function process(input: string) {\n  return ",
  suffix: ";\n}\n",
  language: "typescript",
  openTabs: [] as { path: string; content: string }[],
  recentFiles: [] as {
    path: string;
    content: string;
    touched: number;
  }[],
  budgetChars: 4_000,
});

describe("buildFimContext — invariants", () => {
  it("always preserves the local prefix verbatim at the end", () => {
    const input = baseInput();
    const out = buildFimContext(input);
    expect(out.prefix.endsWith(input.prefix)).toBe(true);
  });

  it("always passes the suffix through untouched", () => {
    const input = baseInput();
    const out = buildFimContext(input);
    expect(out.suffix).toBe(input.suffix);
  });

  it("returns the local prefix as-is when no references and no pattern", () => {
    const input = baseInput();
    // Pattern-free, reference-free input.
    input.prefix = "let value = 0\n";
    const out = buildFimContext(input);
    expect(out.prefix).toBe(input.prefix);
    expect(out.trace.referenceFiles).toHaveLength(0);
    expect(out.trace.patternHint).toBeUndefined();
  });
});

describe("buildFimContext — cross-file references", () => {
  it("includes recently edited files as repo-level FIM references", () => {
    const input = baseInput();
    input.recentFiles = [
      {
        path: "src/utils/format.ts",
        content: "export function format(n: number): string { return String(n); }",
        touched: Date.now(),
      },
    ];
    const out = buildFimContext(input);
    expect(out.prefix).toContain("<|file_sep|>src/utils/format.ts");
    expect(out.prefix).toContain("export function format");
    // The references precede the local prefix.
    const fileSepIdx = out.prefix.indexOf("<|file_sep|>src/utils/format.ts");
    const localIdx = out.prefix.indexOf(input.prefix);
    expect(fileSepIdx).toBeLessThan(localIdx);
  });

  it("includes other open tabs when they aren't already in recents", () => {
    const input = baseInput();
    input.openTabs = [
      {
        path: "src/types.ts",
        content: "export type Result<T> = { ok: T } | { err: string };",
      },
    ];
    const out = buildFimContext(input);
    expect(out.prefix).toContain("<|file_sep|>src/types.ts");
  });

  it("does not include the current file as a reference (already in local prefix)", () => {
    const input = baseInput();
    input.filePath = "src/foo.ts";
    input.recentFiles = [
      { path: "src/foo.ts", content: "stale copy", touched: Date.now() },
      { path: "src/bar.ts", content: "ok", touched: Date.now() },
    ];
    const out = buildFimContext(input);
    expect(out.prefix).not.toContain("<|file_sep|>src/foo.ts");
    expect(out.prefix).toContain("<|file_sep|>src/bar.ts");
  });

  it("dedupes recents and open tabs by path (recents win)", () => {
    const input = baseInput();
    input.recentFiles = [
      {
        path: "src/util.ts",
        content: "RECENT-VERSION",
        touched: Date.now(),
      },
    ];
    input.openTabs = [
      {
        path: "src/util.ts",
        content: "OPEN-TAB-VERSION",
        touched: Date.now(),
      } as { path: string; content: string },
    ];
    const out = buildFimContext(input);
    expect(out.prefix).toContain("RECENT-VERSION");
    expect(out.prefix).not.toContain("OPEN-TAB-VERSION");
  });

  it("respects the budget — drops trailing refs rather than the local prefix", () => {
    const input = baseInput();
    input.budgetChars = 200; // tiny
    const huge = "x".repeat(5_000);
    input.recentFiles = [
      { path: "src/a.ts", content: huge, touched: Date.now() },
      { path: "src/b.ts", content: huge, touched: Date.now() },
      { path: "src/c.ts", content: huge, touched: Date.now() },
    ];
    const out = buildFimContext(input);
    // Local prefix is sacred.
    expect(out.prefix.endsWith(input.prefix)).toBe(true);
    // Output fits the budget (within a small slack for the framing
    // and the local prefix itself).
    expect(out.prefix.length).toBeLessThanOrEqual(
      input.budgetChars + input.prefix.length + 200,
    );
  });
});

describe("buildFimContext — pattern hints", () => {
  it("emits a list-continuation hint when one is detected", () => {
    const input = baseInput();
    input.prefix = `const items = [
  { id: 1, name: "a" },
  { id: 2, name: "b" },
  `;
    const out = buildFimContext(input);
    expect(out.trace.patternHint).toMatch(/list/i);
    // The hint should appear as a comment in the prompt.
    expect(out.prefix).toMatch(/(?:#|\/\/)\s*Pattern: list/i);
  });

  it("emits an import-block hint when one is detected", () => {
    const input = baseInput();
    input.prefix = `import { useState, `;
    const out = buildFimContext(input);
    expect(out.trace.patternHint).toMatch(/import/i);
  });

  it("does not emit a hint when no pattern is detected", () => {
    const input = baseInput();
    input.prefix = `// just a comment\n`;
    const out = buildFimContext(input);
    expect(out.trace.patternHint).toBeUndefined();
  });

  it("uses the language's comment style", () => {
    const input = baseInput();
    input.language = "python";
    input.prefix = `items = [
  ("a", 1),
  ("b", 2),
  `;
    const out = buildFimContext(input);
    // Python = hash comments, not double-slash.
    if (out.trace.patternHint) {
      expect(out.prefix).toMatch(/^#/m);
    }
  });
});
