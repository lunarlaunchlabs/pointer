/**
 * Recent-edits store tests.
 *
 * The FIM context builder asks "what files have I touched recently?"
 * to decide which reference snippets to attach. This store keeps a
 * tiny LRU of paths + their content snippets and is updated by the
 * editor store on every save / external write. We test:
 *
 *   • Capacity: oldest entries fall off when the cap is exceeded.
 *   • Recency: re-touching a file moves it to the front.
 *   • Snippet bound: large files are truncated so the store doesn't
 *     bloat the process memory.
 *   • Self-exclude: the file the user is currently editing is
 *     intentionally NOT in the recent-edits list (it goes into the
 *     local prefix instead).
 *   • Reset: the test helper wipes state cleanly between tests.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useRecentEdits } from "./recentEdits";

function reset() {
  useRecentEdits.setState({ entries: [], cap: 8, snippetChars: 1500 });
}

describe("useRecentEdits", () => {
  beforeEach(reset);

  it("records a new edit", () => {
    useRecentEdits.getState().note("src/a.ts", "let x = 1");
    const e = useRecentEdits.getState().entries;
    expect(e).toHaveLength(1);
    expect(e[0].path).toBe("src/a.ts");
    expect(e[0].content).toBe("let x = 1");
  });

  it("moves a re-touched file to the most-recent slot", () => {
    const s = useRecentEdits.getState();
    s.note("src/a.ts", "A");
    s.note("src/b.ts", "B");
    s.note("src/a.ts", "A2");
    const paths = useRecentEdits.getState().entries.map((e) => e.path);
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(useRecentEdits.getState().entries[0].content).toBe("A2");
  });

  it("evicts the oldest entry beyond cap", () => {
    useRecentEdits.setState({ entries: [], cap: 3, snippetChars: 100 });
    const s = useRecentEdits.getState();
    s.note("p1", "1");
    s.note("p2", "2");
    s.note("p3", "3");
    s.note("p4", "4"); // p1 falls off
    const paths = useRecentEdits.getState().entries.map((e) => e.path);
    expect(paths).toEqual(["p4", "p3", "p2"]);
  });

  it("truncates large snippets to the configured snippet bound", () => {
    useRecentEdits.setState({ entries: [], cap: 4, snippetChars: 50 });
    const big = "x".repeat(500);
    useRecentEdits.getState().note("p", big);
    const entry = useRecentEdits.getState().entries[0];
    expect(entry.content.length).toBeLessThanOrEqual(50);
  });

  it("selectRecent excludes the current file", () => {
    const s = useRecentEdits.getState();
    s.note("p1", "1");
    s.note("p2", "2");
    s.note("p3", "3");
    const recent = s.selectRecent("p2");
    expect(recent.map((e) => e.path)).toEqual(["p3", "p1"]);
  });

  it("selectRecent respects the limit argument", () => {
    const s = useRecentEdits.getState();
    s.note("p1", "1");
    s.note("p2", "2");
    s.note("p3", "3");
    expect(s.selectRecent("p0", 2).map((e) => e.path)).toEqual(["p3", "p2"]);
  });

  it("reset clears all entries", () => {
    const s = useRecentEdits.getState();
    s.note("p1", "1");
    s.note("p2", "2");
    s.reset();
    expect(useRecentEdits.getState().entries).toEqual([]);
  });
});
