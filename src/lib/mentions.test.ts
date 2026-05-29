import { describe, expect, it } from "vitest";
import {
  applyMention,
  buildMentionRegex,
  intentFromQuery,
  mentionToken,
  probeMention,
} from "./mentions";

describe("probeMention", () => {
  it("opens at a fresh @ at start of input", () => {
    const r = probeMention("@", 1);
    expect(r.open).toBe(true);
    if (r.open) {
      expect(r.atStart).toBe(0);
      expect(r.atEnd).toBe(1);
      expect(r.query).toBe("");
    }
  });

  it("opens after a space-then-@", () => {
    const r = probeMention("fix this @foo", 13);
    expect(r.open).toBe(true);
    if (r.open) {
      expect(r.atStart).toBe(9);
      expect(r.query).toBe("foo");
    }
  });

  it("does NOT open inside an email-like token", () => {
    const r = probeMention("ping me at foo@example.com", 26);
    expect(r.open).toBe(false);
  });

  it("closes when the caret crosses whitespace", () => {
    const r = probeMention("@foo bar", 8);
    expect(r.open).toBe(false);
  });

  it("stays open for category-targeted queries with spaces", () => {
    const r = probeMention("@file App", 9);
    expect(r.open).toBe(true);
    if (r.open) expect(r.query).toBe("file App");
  });

  it("opens for path-y queries", () => {
    const r = probeMention("see @src/foo.ts", 15);
    expect(r.open).toBe(true);
    if (r.open) expect(r.query).toBe("src/foo.ts");
  });

  it("ignores unrelated text to the right of the caret", () => {
    const r = probeMention("@foo trailing", 4);
    expect(r.open).toBe(true);
    if (r.open) expect(r.query).toBe("foo");
  });
});

describe("intentFromQuery", () => {
  it("returns the codebase category for a plain alias", () => {
    expect(intentFromQuery("codebase")).toEqual({
      category: "codebase",
      remainder: "",
    });
  });

  it("strips the alias prefix when followed by space", () => {
    expect(intentFromQuery("code rgb to hsl")).toEqual({
      category: "codebase",
      remainder: "rgb to hsl",
    });
  });

  it("treats colon-prefixed aliases as filter form", () => {
    expect(intentFromQuery("diag:TS2304")).toEqual({
      category: "diagnostic",
      remainder: "TS2304",
    });
  });

  it("recognizes debugger aliases", () => {
    expect(intentFromQuery("bp app:12")).toEqual({
      category: "breakpoint",
      remainder: "app:12",
    });
    expect(intentFromQuery("watch user")).toEqual({
      category: "debug",
      remainder: "user",
    });
  });

  it("returns no category for free-form file queries", () => {
    expect(intentFromQuery("App.tsx")).toEqual({
      category: null,
      remainder: "App.tsx",
    });
  });

  it("ignores leading / trailing whitespace", () => {
    expect(intentFromQuery("  sel  ")).toEqual({
      category: "selection",
      remainder: "",
    });
  });
});

describe("applyMention", () => {
  it("performs a pure splice over the @-range", () => {
    const probe = { atStart: 0, atEnd: 4 };
    const { text, caret } = applyMention("@foo bar", probe, "@src/foo.ts ");
    // The trailing space supplied in `insertion` is preserved; the
    // existing space at the start of " bar" is deduped so we don't
    // produce a double gap.
    expect(text).toBe("@src/foo.ts bar");
    expect(caret).toBe("@src/foo.ts ".length);
  });

  it("preserves text before and after the mention", () => {
    const probe = { atStart: 6, atEnd: 10 };
    const { text } = applyMention("hello @foo!", probe, "@src/foo.ts ");
    expect(text).toBe("hello @src/foo.ts !");
  });

  it("never duplicates the tail's leading space when the insertion ends with one", () => {
    const probe = { atStart: 0, atEnd: 1 };
    // Tail = " bar", insertion ends with space → tail space gets dropped.
    const { text } = applyMention("@ bar", probe, "@codebase ");
    expect(text).toBe("@codebase bar");
  });

  it("is a no-op tail-rewrite when insertion has no trailing space", () => {
    const probe = { atStart: 0, atEnd: 1 };
    const { text, caret } = applyMention("@ bar", probe, "@codebase");
    // Tail's leading space is preserved verbatim; caller is responsible
    // for placing the caret past it if they want to skip over.
    expect(text).toBe("@codebase bar");
    expect(caret).toBe("@codebase".length);
  });
});

describe("mentionToken", () => {
  it("shortens long file paths to the trailing two segments", () => {
    const t = mentionToken({
      kind: "file",
      path: "/Users/sam/proj/src/components/Foo.tsx",
    });
    expect(t).toBe("@components/Foo.tsx");
  });

  it("encodes selection ranges in the token", () => {
    const t = mentionToken({
      kind: "selection",
      path: "src/foo.ts",
      startLine: 10,
      endLine: 12,
    });
    expect(t).toBe("@src/foo.ts:L10-12");
  });

  it("encodes diagnostic location + code", () => {
    const t = mentionToken({
      kind: "diagnostic",
      path: "src/foo.ts",
      startLine: 7,
      code: "TS2304",
    });
    expect(t).toBe("@src/foo.ts:L7(TS2304)");
  });

  it("encodes codebase queries by underscoring whitespace", () => {
    const t = mentionToken({ kind: "codebase", query: "rgb to hsl" });
    expect(t).toBe("@codebase:rgb_to_hsl");
  });

  it("encodes debugger references", () => {
    expect(
      mentionToken({ kind: "breakpoint", path: "src/foo.ts", line: 42 }),
    ).toBe("@src/foo.ts:L42");
    expect(mentionToken({ kind: "debugValue", name: "current user" })).toBe(
      "@debug:current_user",
    );
  });
});

describe("buildMentionRegex", () => {
  it("never matches when the token list is empty", () => {
    const re = buildMentionRegex([]);
    expect("anything @foo".match(re)).toBeNull();
  });

  it("matches the longest token first to avoid partial overlap", () => {
    const re = buildMentionRegex(["@src", "@src/foo.ts"]);
    const m = "see @src/foo.ts".match(re);
    expect(m?.[0]).toBe("@src/foo.ts");
  });

  it("escapes regex meta-characters in tokens", () => {
    const re = buildMentionRegex(["@foo(.ts)"]);
    expect("ping @foo(.ts) ok".match(re)?.[0]).toBe("@foo(.ts)");
    // …and doesn't bleed into other text.
    expect("ping @fooxtsx".match(re)).toBeNull();
  });
});
