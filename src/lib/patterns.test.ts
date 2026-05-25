/**
 * Pattern detector tests.
 *
 * These detectors are the eyes of our autocomplete: they look at the
 * text immediately around the cursor and report what kind of code
 * the user is writing — so the FIM context builder can prepend the
 * right reference snippets and the model receives a useful
 * "continuation hint" comment.
 *
 * The detectors are intentionally rule-based (no LLM) so they run
 * synchronously on every keystroke without taxing the host. The
 * contracts they encode:
 *
 *   • False positives are worse than false negatives. If a pattern
 *     isn't *clearly* there we should report `none` — a wrong hint
 *     pulls the model in the wrong direction.
 *   • Inputs are bounded — callers pass the last N lines of prefix
 *     and the first N lines of suffix, never the whole file.
 *   • All functions are pure (input -> output, no IPC, no globals).
 *
 * Tests are written first; the implementation follows. Coverage
 * targets every documented hint kind plus the negative cases that
 * each detector must refuse.
 */

import { describe, expect, it } from "vitest";
import {
  detectFunctionBoundary,
  detectIdentifiersInScope,
  detectImportBlock,
  detectListContinuation,
  detectNamingConvention,
  detectPattern,
} from "./patterns";

// ──────────────────────────────────────────────────────────────────────
// detectListContinuation
//
// Two repeats in a row are enough to fire (the "rule of three" is too
// strict — engineers often add the third item via autocomplete). The
// returned `template` is the most-recent line, stripped of trailing
// commas / whitespace, so the model sees a clean "fill in the blanks".
// ──────────────────────────────────────────────────────────────────────
describe("detectListContinuation", () => {
  it("detects repeated object literals in an array", () => {
    const prefix = `const items = [
  { name: "a", value: 1 },
  { name: "b", value: 2 },
`;
    const out = detectListContinuation(prefix);
    expect(out).toMatchObject({
      kind: "list",
      template: `{ name: "b", value: 2 }`,
      count: 2,
    });
  });

  it("detects key:value pairs inside an object literal", () => {
    const prefix = `const config = {
  ttlMs: 5_000,
  maxRetries: 3,
  backoffMs: 250,
`;
    const out = detectListContinuation(prefix);
    expect(out.kind).toBe("list");
    expect((out as { template: string }).template).toContain("backoffMs");
  });

  it("detects a switch-case ladder", () => {
    const prefix = `switch (event) {
  case "open": handleOpen(); break;
  case "close": handleClose(); break;
  case "error": handleError(); break;
`;
    const out = detectListContinuation(prefix);
    expect(out.kind).toBe("list");
  });

  it("refuses to fire on a single repetition (one match, not a pattern)", () => {
    const prefix = `const items = [
  { name: "only", value: 1 },
`;
    expect(detectListContinuation(prefix).kind).toBe("none");
  });

  it("refuses to fire when the trailing lines diverge wildly", () => {
    const prefix = `function foo() {
  const a = 1;
  console.log("hello world this is not a list");
  return a;
}`;
    expect(detectListContinuation(prefix).kind).toBe("none");
  });
});

// ──────────────────────────────────────────────────────────────────────
// detectImportBlock
// ──────────────────────────────────────────────────────────────────────
describe("detectImportBlock", () => {
  it("detects an import statement in progress", () => {
    const prefix = `import { useState, `;
    const out = detectImportBlock(prefix);
    expect(out).toMatchObject({
      kind: "import",
      module: undefined,
      // Caller passes us partial — we report we're inside an import.
    });
  });

  it("detects a multi-line import block", () => {
    const prefix = `import { useState } from "react";\nimport { useEffect } from "react";\nimport `;
    const out = detectImportBlock(prefix);
    expect(out.kind).toBe("import");
  });

  it("does not fire when the line is plain code with the word import in it", () => {
    const prefix = `// this comment talks about import\nconst x = 1;\n`;
    expect(detectImportBlock(prefix).kind).toBe("none");
  });
});

// ──────────────────────────────────────────────────────────────────────
// detectFunctionBoundary
//
// Distinguishes "about to define a function" from "writing the body".
// The model treats these very differently — a body completion is
// continuation; a signature completion is more like fill-in-blank.
// ──────────────────────────────────────────────────────────────────────
describe("detectFunctionBoundary", () => {
  it("flags 'defining a function signature' when only the keyword is present", () => {
    const out = detectFunctionBoundary("export function ", ")\n}\n");
    expect(out).toMatchObject({ kind: "signature" });
  });

  it("flags 'inside a function body' when the open brace was already typed", () => {
    const out = detectFunctionBoundary(
      "function process(input: string) {\n  ",
      "\n}\n",
    );
    expect(out).toMatchObject({ kind: "body" });
  });

  it("returns none in the middle of an expression", () => {
    const out = detectFunctionBoundary("const x = 1 + ", " 2;\n");
    expect(out.kind).toBe("none");
  });
});

// ──────────────────────────────────────────────────────────────────────
// detectNamingConvention
//
// Looks at identifiers IN scope (function names, locals) and reports
// the dominant casing — so when the model is about to suggest a new
// identifier it gets a hint of the surrounding style.
// ──────────────────────────────────────────────────────────────────────
describe("detectNamingConvention", () => {
  it("picks camelCase when surrounding identifiers are camelCase", () => {
    const ids = ["fooBar", "bazQux", "renderItem", "handleClick"];
    expect(detectNamingConvention(ids)).toBe("camelCase");
  });

  it("picks snake_case when surrounding identifiers are snake_case", () => {
    const ids = ["foo_bar", "baz_qux", "render_item"];
    expect(detectNamingConvention(ids)).toBe("snake_case");
  });

  it("picks PascalCase for top-level component names", () => {
    expect(detectNamingConvention(["Button", "Modal", "Card", "FooBar"])).toBe(
      "PascalCase",
    );
  });

  it("returns 'mixed' when no convention dominates", () => {
    expect(detectNamingConvention(["fooBar", "FOO_BAR", "Foo"])).toBe("mixed");
  });

  it("returns 'mixed' for an empty set", () => {
    expect(detectNamingConvention([])).toBe("mixed");
  });
});

// ──────────────────────────────────────────────────────────────────────
// detectIdentifiersInScope
//
// Pulls bare identifiers from a text blob — used to feed the naming
// convention detector and to surface "symbols the user just referenced
// that we should pull definitions for".
// ──────────────────────────────────────────────────────────────────────
describe("detectIdentifiersInScope", () => {
  it("extracts identifiers from a JS-like blob", () => {
    const out = detectIdentifiersInScope(
      "function handleClick(event) { return foo + barBaz; }",
    );
    expect(out).toEqual(
      expect.arrayContaining(["handleClick", "event", "foo", "barBaz"]),
    );
  });

  it("ignores keywords and short identifiers", () => {
    const out = detectIdentifiersInScope("if (true) return false;");
    expect(out).not.toContain("if");
    expect(out).not.toContain("true");
    expect(out).not.toContain("return");
    expect(out).not.toContain("false");
  });

  it("dedupes the result", () => {
    const out = detectIdentifiersInScope("foo, foo, foo");
    expect(out.filter((x) => x === "foo")).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// detectPattern — the umbrella that callers actually use. Routes to
// the right detector and picks the strongest signal.
// ──────────────────────────────────────────────────────────────────────
describe("detectPattern", () => {
  it("returns the list pattern when a list is the strongest signal", () => {
    const prefix = `const items = [
  { id: 1 },
  { id: 2 },
  { id: 3 },
`;
    expect(detectPattern(prefix, "]").kind).toBe("list");
  });

  it("returns the import pattern over a coincidental list signal", () => {
    const prefix = `import { a, b } from "x";\nimport { c, d } from "y";\nimport { `;
    expect(detectPattern(prefix, "").kind).toBe("import");
  });

  it("returns none when no pattern is detected", () => {
    expect(detectPattern("// plain comment\n", "").kind).toBe("none");
  });
});
