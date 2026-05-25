/**
 * Mention candidate ranker tests.
 *
 * The default behaviour of "filter by includes() and slice the first
 * 8" felt random — adjacent prefix matches were beaten by deep
 * substring matches just because the directory tree happened to be
 * walked in alphabetical order. The ranker exists to give us
 * intelligent results without paying a fuzzy-match library:
 *
 *   • Exact basename match dominates everything.
 *   • Basename prefix match outranks path-anywhere match.
 *   • CamelCase initials match (`mp` → `MentionPicker.tsx`) is a
 *     near-prefix match in weight — it's how power users actually
 *     navigate.
 *   • A "recent edit" bonus lifts files the user just touched.
 *   • An "open tab" bonus lifts files the user is actively reading.
 *   • Ties break by shorter path (closer to the workspace root).
 *
 * Determinism: same inputs → same outputs. The ranker does not
 * touch any state; the caller hands us the recents + open lists.
 */

import { describe, expect, it } from "vitest";
import { rankFileCandidates } from "./mentionRanker";

const C = (paths: string[]) => paths.map((path) => ({ path }));

describe("rankFileCandidates — exactness", () => {
  it("ranks an exact basename match first", () => {
    const out = rankFileCandidates({
      candidates: C([
        "src/lib/foo.test.ts",
        "src/lib/foo.ts",
        "src/lib/foobar.ts",
      ]),
      query: "foo.ts",
      recents: [],
      openTabs: [],
    });
    expect(out[0].path).toBe("src/lib/foo.ts");
  });

  it("ranks a basename prefix match above a path-anywhere match", () => {
    const out = rankFileCandidates({
      candidates: C([
        "src/deep/inner/foo/bar.ts",
        "src/lib/foo-utils.ts",
      ]),
      query: "foo",
      recents: [],
      openTabs: [],
    });
    expect(out[0].path).toBe("src/lib/foo-utils.ts");
  });

  it("matches CamelCase initials like Cmd+P", () => {
    const out = rankFileCandidates({
      candidates: C([
        "src/components/Mention/MentionPicker.tsx",
        "src/lib/multipassPipeline.ts",
        "src/some/other.ts",
      ]),
      query: "mp",
      recents: [],
      openTabs: [],
    });
    // Both first two contain m and p — the one whose camelcase
    // initials actually match (MentionPicker) wins.
    expect(out[0].path).toBe("src/components/Mention/MentionPicker.tsx");
  });
});

describe("rankFileCandidates — recency & open-tab signals", () => {
  it("lifts a recent-edit hit above an equally-good unrelated match", () => {
    const out = rankFileCandidates({
      candidates: C(["src/lib/foo.ts", "src/components/Foo.tsx"]),
      query: "Foo",
      recents: [{ path: "src/lib/foo.ts" }],
      openTabs: [],
    });
    // Both contain "foo" — recents tips the balance.
    expect(out[0].path).toBe("src/lib/foo.ts");
  });

  it("lifts an open tab above a non-recent, non-open match", () => {
    const out = rankFileCandidates({
      candidates: C([
        "src/lib/util.ts",
        "src/lib/utility-helpers.ts",
      ]),
      query: "util",
      recents: [],
      openTabs: [{ path: "src/lib/utility-helpers.ts" }],
    });
    expect(out[0].path).toBe("src/lib/utility-helpers.ts");
  });

  it("recency outweighs open-tab when they conflict", () => {
    const out = rankFileCandidates({
      candidates: C(["src/a.ts", "src/b.ts"]),
      query: "src",
      recents: [{ path: "src/b.ts" }],
      openTabs: [{ path: "src/a.ts" }],
    });
    expect(out[0].path).toBe("src/b.ts");
  });
});

describe("rankFileCandidates — defaults & limits", () => {
  it("returns an empty array when no candidate matches the query", () => {
    const out = rankFileCandidates({
      candidates: C(["src/x.ts", "src/y.ts"]),
      query: "thisDoesNotExist",
      recents: [],
      openTabs: [],
    });
    expect(out).toEqual([]);
  });

  it("respects the limit", () => {
    const out = rankFileCandidates({
      candidates: C(
        Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`),
      ),
      query: "file",
      recents: [],
      openTabs: [],
      limit: 5,
    });
    expect(out).toHaveLength(5);
  });

  it("ties break by shorter path", () => {
    const out = rankFileCandidates({
      candidates: C([
        "src/deep/inner/foo.ts",
        "src/foo.ts",
      ]),
      query: "foo.ts",
      recents: [],
      openTabs: [],
    });
    expect(out[0].path).toBe("src/foo.ts");
  });

  it("returns everything that matches when no query is provided", () => {
    const out = rankFileCandidates({
      candidates: C(["src/a.ts", "src/b.ts", "src/c.ts"]),
      query: "",
      recents: [{ path: "src/b.ts" }],
      openTabs: [{ path: "src/c.ts" }],
    });
    // With no query, recents come first, then open tabs, then the
    // rest in original order.
    expect(out.map((c) => c.path)).toEqual(["src/b.ts", "src/c.ts", "src/a.ts"]);
  });
});
