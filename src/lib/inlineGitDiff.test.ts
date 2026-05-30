import { describe, expect, it } from "vitest";
import { computeInlineGitDiff, relativeGitPath } from "./inlineGitDiff";

describe("inline git diff", () => {
  it("detects added, modified, and deleted hunks in one active buffer", () => {
    const original = [
      "const anchor = 1;",
      'const name = "old";',
      "const shared = true;",
      "const removeMe = true;",
      "const middle = 2;",
      "const tail = 3;",
    ].join("\n");
    const modified = [
      "const anchor = 1;",
      'const name = "new";',
      "const shared = true;",
      "const middle = 2;",
      "const inserted = 4;",
      "const tail = 3;",
    ].join("\n");

    expect(computeInlineGitDiff(original, modified)).toEqual([
      {
        kind: "modified",
        lineNumber: 2,
        lineCount: 1,
        originalLineCount: 1,
        originalLines: ['const name = "old";'],
      },
      {
        kind: "deleted",
        lineNumber: 4,
        lineCount: 0,
        originalLineCount: 1,
        originalLines: ["const removeMe = true;"],
      },
      {
        kind: "added",
        lineNumber: 5,
        lineCount: 1,
        originalLineCount: 0,
      },
    ]);
  });

  it("treats a new file as all additions", () => {
    expect(computeInlineGitDiff("", "one\ntwo")).toEqual([
      { kind: "added", lineNumber: 1, lineCount: 2, originalLineCount: 0 },
    ]);
  });

  it("does not report a change for final newline-only differences", () => {
    expect(computeInlineGitDiff("const x = 1;\n", "const x = 1;")).toEqual([]);
  });

  it("normalizes workspace paths for git show", () => {
    expect(relativeGitPath("/repo", "/repo/src/App.tsx")).toBe("src/App.tsx");
    expect(relativeGitPath("/repo/", "/repo/src/App.tsx")).toBe("src/App.tsx");
    expect(relativeGitPath("/repo", "/other/src/App.tsx")).toBeNull();
  });
});
