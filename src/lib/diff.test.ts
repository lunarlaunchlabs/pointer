import { describe, expect, it } from "vitest";
import { applyHunk, applyHunks, isCreationHunk, parseSearchReplace } from "./diff";

describe("parseSearchReplace", () => {
  it("parses a vanilla SEARCH/REPLACE hunk with a path", () => {
    const text = [
      "<<<<<<< SEARCH src/foo.ts",
      "const x = 1;",
      "=======",
      "const x = 2;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const hunks = parseSearchReplace(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual({
      path: "src/foo.ts",
      search: "const x = 1;",
      replace: "const x = 2;",
    });
  });

  it("parses an empty-SEARCH create block", () => {
    const text = [
      "<<<<<<< SEARCH src/new.js",
      "=======",
      "export const a = 1;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const hunks = parseSearchReplace(text);
    expect(hunks).toHaveLength(1);
    expect(isCreationHunk(hunks[0])).toBe(true);
    expect(hunks[0].replace).toBe("export const a = 1;");
  });

  it("parses the common drift shape with the path on the next line", () => {
    const text = [
      "<<<<<<< SEARCH",
      "src/foo.ts",
      "const x = 1;",
      "=======",
      "const x = 2;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const hunks = parseSearchReplace(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual({
      path: "src/foo.ts",
      search: "const x = 1;",
      replace: "const x = 2;",
    });
  });

  it("parses a <file> create block", () => {
    const text = `<file path="src/new.ts">\nexport const x = 1;\n</file>`;
    const hunks = parseSearchReplace(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].path).toBe("src/new.ts");
    expect(hunks[0].replace).toBe("export const x = 1;");
  });

  it("parses fenced title=path create blocks (legacy)", () => {
    const text = '```typescript title="src/new.ts"\nexport const x = 1;\n```';
    const hunks = parseSearchReplace(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].path).toBe("src/new.ts");
  });

  it("treats `\\`\\`\\`lang path/to/file` blocks as full-file rewrites", () => {
    // This is the very common shape models emit when asked to patch
    // a small file — the language is followed by a bare path on the
    // fence opener. Pointer used to drop these silently; we now
    // surface them so the user sees the proposed change.
    const text =
      "```javascript src/clamp.js\nexport function clamp(n, lo, hi) {\n  return n;\n}\n```";
    const hunks = parseSearchReplace(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].path).toBe("src/clamp.js");
    expect(hunks[0].search).toBe("");
    expect(hunks[0].replace).toContain("export function clamp");
  });

  it("does NOT misinterpret a fence whose token is just a language", () => {
    // A plain ` ```javascript\n…\n``` ` fence has no path token, so the
    // path-shape parser must skip it.
    const text = "```javascript\nconst x = 1;\n```";
    const hunks = parseSearchReplace(text);
    expect(hunks).toHaveLength(0);
  });

  it("doesn't double-emit when both title= and bare path could match", () => {
    // FENCED_PATH_RE is permissive enough to also see `title="…"` as
    // the second token. The path-shape guard rejects attribute-looking
    // strings, so the title= match is the only one that fires.
    const text = '```ts title="src/a.ts"\nexport const a = 1;\n```';
    const hunks = parseSearchReplace(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].path).toBe("src/a.ts");
  });

  it("parses a fenced block whose first line is a // path comment (drift fallback)", () => {
    const text =
      '```javascript\n// CREATE file path="src/util/uniq.js"\nexport function uniq(arr) {\n  return [...new Set(arr)];\n}\n```';
    const hunks = parseSearchReplace(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].path).toBe("src/util/uniq.js");
    expect(hunks[0].search).toBe("");
    expect(hunks[0].replace).toContain("uniq");
  });

  it("recognises path: comments with `#` (python-style) too", () => {
    // Comment styles vary, but the path is always quoted by the
    // common drift-mode emitter (matches the JS comment shape).
    const text =
      '```python\n# path: "scripts/clean.py"\nprint("hi")\n```';
    const hunks = parseSearchReplace(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].path).toBe("scripts/clean.py");
  });

  it("picks up multiple hunks in one response", () => {
    const text =
      [
        "<<<<<<< SEARCH src/a.ts",
        "const a = 1;",
        "=======",
        "const a = 2;",
        ">>>>>>> REPLACE",
        "",
        '<file path="src/b.ts">',
        "export const b = true;",
        "</file>",
      ].join("\n");
    const hunks = parseSearchReplace(text);
    expect(hunks).toHaveLength(2);
    expect(hunks.map((h) => h.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("applyHunk / applyHunks", () => {
  it("applies a verbatim search block", () => {
    const src = "const x = 1;\nconst y = 2;\n";
    const out = applyHunk(src, {
      path: "f",
      search: "const x = 1;",
      replace: "const x = 42;",
    });
    expect(out).toBe("const x = 42;\nconst y = 2;\n");
  });

  it("returns null when search isn't found and fuzzy fails", () => {
    const out = applyHunk("abc", { path: "f", search: "zzz", replace: "yyy" });
    expect(out).toBeNull();
  });

  it("treats empty-search as overwrite (create-or-overwrite)", () => {
    // Empty SEARCH semantics: the whole file becomes `replace`.
    // Production code never calls this path for existing files — it
    // routes through isCreationHunk + writeTextFile — but if a test
    // or inline-apply consumer does, it must be a clean overwrite.
    const out = applyHunk("existing", {
      path: "f",
      search: "",
      replace: "new",
    });
    expect(out).toBe("new");
  });

  it("applies multiple hunks sequentially and tracks counts", () => {
    const src = "a\nb\nc\n";
    const r = applyHunks(src, [
      { path: "f", search: "a", replace: "A" },
      { path: "f", search: "c", replace: "C" },
      { path: "f", search: "missing", replace: "x" },
    ]);
    expect(r.text).toBe("A\nb\nC\n");
    expect(r.applied).toBe(2);
    expect(r.failed).toBe(1);
  });
});
