/**
 * Tests for the AI-staged decoration descriptor builder.
 *
 * The builder is the pure math behind the squiggle / gutter chevron
 * that lights up when the user attaches a selection or diagnostic to
 * chat / agent. The Editor component just hands the result to
 * Monaco's `deltaDecorations`, so we don't need a real editor to
 * verify the contract.
 */

import { describe, expect, it } from "vitest";
import { aiStageDecorationsFor } from "./aiStageDecorations";
import type { Reference } from "@/store/chat";

const sel = (path: string, l1: number, l2: number): Reference => ({
  kind: "selection",
  path,
  startLine: l1,
  endLine: l2,
  text: "...",
});

const diag = (path: string, l1: number, c1: number, l2: number, c2: number): Reference => ({
  kind: "diagnostic",
  path,
  startLine: l1,
  startCol: c1,
  endLine: l2,
  endCol: c2,
  severity: "error",
  source: "ts",
  code: "TS2304",
  message: "Cannot find name 'foo'.",
  snippet: "console.log(foo);",
});

describe("aiStageDecorationsFor", () => {
  it("returns nothing when no file is open", () => {
    const out = aiStageDecorationsFor([sel("src/a.ts", 1, 3)], "chat", null);
    expect(out).toEqual([]);
  });

  it("ignores refs that point at a different file", () => {
    const out = aiStageDecorationsFor(
      [sel("src/other.ts", 1, 3)],
      "chat",
      "src/a.ts",
    );
    expect(out).toEqual([]);
  });

  it("emits a whole-line decoration for selection refs", () => {
    const out = aiStageDecorationsFor(
      [sel("src/a.ts", 4, 7)],
      "chat",
      "src/a.ts",
    );
    expect(out).toHaveLength(1);
    expect(out[0].range).toEqual({
      startLineNumber: 4,
      startColumn: 1,
      endLineNumber: 7,
      endColumn: 1 << 30,
    });
    expect(out[0].options.isWholeLine).toBe(true);
    expect(out[0].options.className).toContain("pn-ai-staged-range");
  });

  it("emits a column-precise decoration for diagnostic refs", () => {
    const out = aiStageDecorationsFor(
      [diag("src/a.ts", 9, 4, 9, 12)],
      "chat",
      "src/a.ts",
    );
    expect(out).toHaveLength(1);
    expect(out[0].range).toEqual({
      startLineNumber: 9,
      startColumn: 4,
      endLineNumber: 9,
      endColumn: 12,
    });
    expect(out[0].options.isWholeLine).toBe(false);
    expect(out[0].options.hoverMessage.value).toContain("TS2304");
  });

  it("tints decorations differently for chat vs agent surfaces", () => {
    const a = aiStageDecorationsFor([sel("x", 1, 1)], "chat", "x");
    const b = aiStageDecorationsFor([sel("x", 1, 1)], "agent", "x");
    expect(a[0].options.className).not.toContain("pn-ai-staged-agent");
    expect(b[0].options.className).toContain("pn-ai-staged-agent");
    expect(b[0].options.linesDecorationsClassName).toContain(
      "pn-ai-staged-agent",
    );
  });

  it("normalises Windows paths before comparing", () => {
    const out = aiStageDecorationsFor(
      [sel("src\\a.ts", 1, 2)],
      "chat",
      "src/a.ts",
    );
    expect(out).toHaveLength(1);
  });

  it("skips kinds that have no in-file anchor", () => {
    const out = aiStageDecorationsFor(
      [
        { kind: "file", path: "src/a.ts" },
        { kind: "codebase", query: "foo" },
        { kind: "folder", path: "src" },
      ],
      "chat",
      "src/a.ts",
    );
    expect(out).toEqual([]);
  });
});
