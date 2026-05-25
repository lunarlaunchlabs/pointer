/**
 * Refactor-suggestions store tests.
 *
 * The store holds at most one *active* rename suggestion at a time.
 * The agreement with the UI:
 *
 *   • Only the most-recent suggestion is shown — we don't queue up
 *     stale ones.
 *   • Dismissing remembers the (oldName, newName) pair so the same
 *     suggestion won't pop up again in the same session.
 *   • Marking applied wipes the suggestion AND the dismissed list
 *     for that pair (subsequent further renames are valid again).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useRefactorSuggestions } from "./refactorSuggestions";

function reset() {
  useRefactorSuggestions.setState({ active: null, dismissed: new Set() });
}

describe("useRefactorSuggestions", () => {
  beforeEach(reset);

  it("propose() sets the active suggestion", () => {
    useRefactorSuggestions.getState().propose({
      oldName: "foo",
      newName: "bar",
      sourcePath: "src/a.ts",
      hits: [{ path: "src/b.ts", line: 2, text: "foo()" }],
    });
    expect(useRefactorSuggestions.getState().active).toMatchObject({
      oldName: "foo",
      newName: "bar",
    });
  });

  it("propose() replaces an older active suggestion", () => {
    const s = useRefactorSuggestions.getState();
    s.propose({ oldName: "foo", newName: "bar", sourcePath: "a", hits: [] });
    s.propose({ oldName: "baz", newName: "qux", sourcePath: "a", hits: [] });
    expect(useRefactorSuggestions.getState().active?.newName).toBe("qux");
  });

  it("dismiss() clears the active suggestion and remembers the pair", () => {
    const s = useRefactorSuggestions.getState();
    s.propose({ oldName: "foo", newName: "bar", sourcePath: "a", hits: [] });
    s.dismiss();
    const st = useRefactorSuggestions.getState();
    expect(st.active).toBeNull();
    expect(st.dismissed.has("foo→bar")).toBe(true);
  });

  it("propose() is a no-op for a previously-dismissed pair", () => {
    const s = useRefactorSuggestions.getState();
    s.propose({ oldName: "foo", newName: "bar", sourcePath: "a", hits: [] });
    s.dismiss();
    s.propose({ oldName: "foo", newName: "bar", sourcePath: "a", hits: [] });
    expect(useRefactorSuggestions.getState().active).toBeNull();
  });

  it("markApplied() clears active suggestion", () => {
    const s = useRefactorSuggestions.getState();
    s.propose({ oldName: "foo", newName: "bar", sourcePath: "a", hits: [] });
    s.markApplied();
    expect(useRefactorSuggestions.getState().active).toBeNull();
  });
});
