/**
 * FIM context builder — adversarial / boundary inputs.
 *
 * The happy-path tests already cover normal usage. These pin
 * pathological inputs so we can't regress on:
 *
 *   • Empty prefix / suffix (the editor passes these at file
 *     start / end).
 *   • A reference file containing the FIM separator token (must not
 *     be mistaken for the boundary between refs and the local
 *     prefix).
 *   • A pathological local prefix that's longer than the budget
 *     (we still must not truncate it).
 *   • Many reference files: budget must trim from the tail, not
 *     the head.
 *   • Unicode in identifiers / paths.
 */

import { describe, expect, it } from "vitest";
import { buildFimContext } from "./fimContext";

describe("buildFimContext — adversarial", () => {
  it("handles empty prefix and suffix without crashing", () => {
    const out = buildFimContext({
      filePath: "src/empty.ts",
      prefix: "",
      suffix: "",
      language: "typescript",
      recentFiles: [],
      openTabs: [],
      budgetChars: 1000,
    });
    expect(out.prefix).toBe("");
    expect(out.suffix).toBe("");
  });

  it("preserves a local prefix that exceeds the budget", () => {
    const prefix = "x".repeat(5_000);
    const out = buildFimContext({
      filePath: "src/big.ts",
      prefix,
      suffix: "\n",
      language: "typescript",
      recentFiles: [
        { path: "src/ref.ts", content: "let y = 1;", touched: 1 },
      ],
      openTabs: [],
      budgetChars: 1_000, // smaller than the prefix!
    });
    // Local prefix is untouched even though it's >> budget.
    expect(out.prefix.endsWith(prefix)).toBe(true);
    // References were dropped to keep the local prefix sacred.
    expect(out.trace.referenceFiles).toHaveLength(0);
  });

  it("does not crash when a reference contains the FIM separator", () => {
    const out = buildFimContext({
      filePath: "src/index.ts",
      prefix: "let x = ",
      suffix: ";\n",
      language: "typescript",
      recentFiles: [
        {
          path: "src/contains.ts",
          content: "const literal = '<|file_sep|>not a real boundary';",
          touched: 1,
        },
      ],
      openTabs: [],
      budgetChars: 2_000,
    });
    expect(out.prefix).toContain("<|file_sep|>src/contains.ts");
    expect(out.prefix).toContain("not a real boundary");
  });

  it("trims trailing references — never the head ones — when budget shrinks", () => {
    const ref = (name: string) => ({
      path: name,
      content: "X".repeat(300),
      touched: 1,
    });
    const out = buildFimContext({
      filePath: "src/index.ts",
      prefix: "let x = ",
      suffix: ";\n",
      language: "typescript",
      recentFiles: [
        ref("src/first.ts"),
        ref("src/second.ts"),
        ref("src/third.ts"),
        ref("src/fourth.ts"),
      ],
      openTabs: [],
      budgetChars: 800,
    });
    // The "first" ref is always included (it's the most recent),
    // and at least one trailing ref is dropped.
    expect(out.prefix).toContain("<|file_sep|>src/first.ts");
    expect(out.trace.referenceFiles[0].path).toBe("src/first.ts");
    expect(out.trace.referenceFiles.length).toBeLessThan(4);
  });

  it("handles unicode identifiers in the local prefix", () => {
    const prefix = "let café = 1;\nconsole.log(café);\n";
    const out = buildFimContext({
      filePath: "src/utf8.ts",
      prefix,
      suffix: "\n",
      language: "typescript",
      recentFiles: [],
      openTabs: [],
      budgetChars: 2_000,
    });
    expect(out.prefix.endsWith(prefix)).toBe(true);
  });
});
