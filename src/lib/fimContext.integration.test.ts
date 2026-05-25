/**
 * End-to-end integration check for the enriched FIM pipeline.
 *
 * Component-level tests already verify each piece in isolation
 * (pattern detection, recent-edits store, context builder). What's
 * left to prove is that *when wired together*, the assembled prompt
 * actually contains the right information for the model to do
 * smarter completions.
 *
 * We simulate the editor's contribution by:
 *   1. Pre-populating useRecentEdits with two "recently edited"
 *      files (one of which uses a clear naming convention).
 *   2. Building a context for the current file with a list pattern
 *      in its prefix.
 *   3. Asserting that:
 *        a) Both recent files are stitched into the prompt with the
 *           Qwen `<|file_sep|>` separator.
 *        b) The pattern-hint comment is present.
 *        c) The local prefix is the tail of the assembled prompt.
 *        d) The current file is excluded from references.
 *
 * That's what the model actually sees on every keystroke.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { buildFimContext } from "./fimContext";
import { useRecentEdits } from "@/store/recentEdits";

function reset() {
  useRecentEdits.setState({ entries: [], cap: 8, snippetChars: 1500 });
}

describe("FIM enrichment end-to-end", () => {
  beforeEach(reset);

  it("stitches recent-edit refs, a pattern hint, and the local prefix", () => {
    useRecentEdits
      .getState()
      .note("src/util/format.ts", "export const formatBytes = (n: number) => `${n}B`;");
    useRecentEdits
      .getState()
      .note("src/components/Button.tsx", "export function Button() { return null; }");
    // Pretend the user is now editing src/index.ts. Their local
    // prefix contains a clear list pattern.
    const localPrefix =
      'const items = [\n  { id: 1, name: "a" },\n  { id: 2, name: "b" },\n  ';
    const ctx = buildFimContext({
      filePath: "src/index.ts",
      prefix: localPrefix,
      suffix: "\n];",
      language: "typescript",
      recentFiles: useRecentEdits.getState().selectRecent("src/index.ts"),
      openTabs: [],
      budgetChars: 4_000,
    });

    // (a) Both refs stitched in with the Qwen FIM file separator.
    expect(ctx.prefix).toContain("<|file_sep|>src/components/Button.tsx");
    expect(ctx.prefix).toContain("<|file_sep|>src/util/format.ts");
    expect(ctx.prefix).toContain("formatBytes");
    expect(ctx.prefix).toContain("function Button");

    // (b) Pattern-hint comment present.
    expect(ctx.prefix).toMatch(/\/\/ Pattern: list/);
    expect(ctx.trace.patternHint).toMatch(/list/);

    // (c) Local prefix is the tail of the assembled prompt.
    expect(ctx.prefix.endsWith(localPrefix)).toBe(true);

    // (d) The current file never appears as a reference, even if
    // somebody accidentally stuffed it into recents.
    useRecentEdits
      .getState()
      .note("src/index.ts", "stale snapshot of the current file");
    const ctx2 = buildFimContext({
      filePath: "src/index.ts",
      prefix: localPrefix,
      suffix: "\n];",
      language: "typescript",
      recentFiles: useRecentEdits.getState().selectRecent("src/index.ts"),
      openTabs: [],
      budgetChars: 4_000,
    });
    expect(ctx2.prefix).not.toContain("stale snapshot of the current file");
    expect(ctx2.prefix).not.toContain("<|file_sep|>src/index.ts");
  });

  it("falls back to open tabs when there are no recent edits", () => {
    const ctx = buildFimContext({
      filePath: "src/index.ts",
      prefix: "let x = ",
      suffix: ";\n",
      language: "typescript",
      recentFiles: [],
      openTabs: [
        { path: "src/types.ts", content: "export type ID = string;" },
      ],
      budgetChars: 1_000,
    });
    expect(ctx.prefix).toContain("<|file_sep|>src/types.ts");
    expect(ctx.prefix).toContain("export type ID");
  });

  it("drops trailing refs when budget is tight, never the local prefix", () => {
    const huge = "x".repeat(2_000);
    const ctx = buildFimContext({
      filePath: "src/index.ts",
      prefix: "let x = 1\n",
      suffix: "\n",
      language: "typescript",
      recentFiles: [
        { path: "a", content: huge, touched: 1 },
        { path: "b", content: huge, touched: 1 },
        { path: "c", content: huge, touched: 1 },
      ],
      openTabs: [],
      budgetChars: 500,
    });
    expect(ctx.prefix.endsWith("let x = 1\n")).toBe(true);
    // We get *some* refs but not all three.
    const inRefs = ["a", "b", "c"].filter((p) =>
      ctx.prefix.includes(`<|file_sep|>${p}`),
    );
    expect(inRefs.length).toBeLessThan(3);
  });
});
