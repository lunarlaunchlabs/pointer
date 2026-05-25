/**
 * Inline-edit context builder tests.
 *
 * `buildInlineEditContext` packages everything a Cmd+K inline edit
 * call needs to land a good edit on the first try:
 *
 *   • The selected text (verbatim — the model must SEARCH this).
 *   • Surrounding code (10-ish lines above and below the selection)
 *     so the model sees the local style and structure.
 *   • Any pattern signal we detect at the selection boundary.
 *   • Recent files the user just edited — the working set.
 *   • Overlapping diagnostics so the model gets the actual lint
 *     messages even when the user typed a vague prompt.
 *
 * The tests pin the assembled prompt's shape and prove the budget
 * mechanic: when references would blow the cap, we drop them — but
 * never the selection or the surrounding code.
 */

import { describe, expect, it } from "vitest";
import { buildInlineEditContext } from "./inlineEditContext";

const baseInput = () => ({
  filePath: "src/index.ts",
  fileContent:
    "// header\n" +
    Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`).join("\n") +
    "\n",
  selection: {
    startLine: 30,
    endLine: 32,
    text: "const line29 = 29;\nconst line30 = 30;\nconst line31 = 31;",
  },
  language: "typescript",
  recentFiles: [] as Array<{ path: string; content: string }>,
  diagnostics: [] as Array<{
    line: number;
    message: string;
    severity: "error" | "warning" | "info";
  }>,
  budgetChars: 4_000,
});

describe("buildInlineEditContext — basics", () => {
  it("includes the selection verbatim in the assembled message", () => {
    const input = baseInput();
    const out = buildInlineEditContext(input);
    expect(out.userMessage).toContain(input.selection.text);
  });

  it("includes a few lines of code above and below the selection", () => {
    const input = baseInput();
    const out = buildInlineEditContext(input);
    // line25 is 5 lines before startLine; line35 is 3 lines after
    // the end. Both should be visible in the surrounding context.
    expect(out.userMessage).toContain("const line25 = 25;");
    expect(out.userMessage).toContain("const line35 = 35;");
  });

  it("never blows past the budget", () => {
    const input = baseInput();
    input.budgetChars = 600;
    const out = buildInlineEditContext(input);
    expect(out.userMessage.length).toBeLessThanOrEqual(input.budgetChars + 200);
  });
});

describe("buildInlineEditContext — recent files", () => {
  it("attaches recent files when there's budget", () => {
    const input = baseInput();
    input.recentFiles = [
      {
        path: "src/util.ts",
        content: "export const helper = () => 42;",
      },
    ];
    const out = buildInlineEditContext(input);
    expect(out.userMessage).toContain("src/util.ts");
    expect(out.userMessage).toContain("export const helper");
  });

  it("drops recent files first when budget is tight", () => {
    const input = baseInput();
    input.budgetChars = 600;
    input.recentFiles = [
      {
        path: "src/big.ts",
        content: "x".repeat(2_000),
      },
    ];
    const out = buildInlineEditContext(input);
    expect(out.userMessage).not.toContain("src/big.ts");
    // But the selection still made it through.
    expect(out.userMessage).toContain(input.selection.text);
  });
});

describe("buildInlineEditContext — diagnostics", () => {
  it("inlines overlapping diagnostics so the model sees them", () => {
    const input = baseInput();
    input.diagnostics = [
      {
        line: 30,
        message: "Unused variable 'line29'",
        severity: "warning",
      },
    ];
    const out = buildInlineEditContext(input);
    expect(out.userMessage).toContain("Unused variable 'line29'");
    // Diagnostics are placed in their own section so the model sees
    // them as authoritative input, not narrative.
    expect(out.userMessage.toLowerCase()).toContain("diagnostic");
  });
});

describe("buildInlineEditContext — trace", () => {
  it("returns a trace describing what was included", () => {
    const input = baseInput();
    input.recentFiles = [
      { path: "src/util.ts", content: "x" },
      { path: "src/types.ts", content: "y" },
    ];
    input.diagnostics = [
      { line: 30, message: "uh oh", severity: "error" },
    ];
    const out = buildInlineEditContext(input);
    expect(out.trace.recentFilesIncluded.map((r) => r.path)).toEqual([
      "src/util.ts",
      "src/types.ts",
    ]);
    expect(out.trace.diagnosticsIncluded).toBe(1);
    expect(out.trace.surroundingLines).toBeGreaterThan(0);
  });
});
