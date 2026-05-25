/**
 * Rename observer tests.
 *
 * The observer is the brain behind "you just renamed X to Y — want to
 * apply that across the workspace?" suggestions. It takes two
 * snapshots of the same file (before / after) and asks one
 * disciplined question: "is there *exactly one* identifier that was
 * cleanly substituted, and is everything else unchanged?"
 *
 * We are strict on purpose: a false positive ("apply this rename")
 * is much worse than a missed detection. The observer has to be a
 * skeptic.
 */

import { describe, expect, it } from "vitest";
import { observeRename } from "./renameObserver";

describe("observeRename — positive cases", () => {
  it("detects a single-occurrence rename", () => {
    const before = "let foo_bar = 1;\nconsole.log(foo_bar);";
    const after = "let fooBar = 1;\nconsole.log(fooBar);";
    const out = observeRename(before, after);
    expect(out).toEqual({
      kind: "rename",
      oldName: "foo_bar",
      newName: "fooBar",
      occurrencesInFile: 2,
    });
  });

  it("detects a rename of a function name", () => {
    const before = "function calculateTotal() { return 0; }\ncalculateTotal();";
    const after = "function computeTotal() { return 0; }\ncomputeTotal();";
    const out = observeRename(before, after);
    expect(out).toMatchObject({
      kind: "rename",
      oldName: "calculateTotal",
      newName: "computeTotal",
    });
  });

  it("detects a rename that occurs three times", () => {
    const before =
      "const userAge = 12;\nif (userAge > 18) { sendWelcome(userAge); }";
    const after =
      "const personAge = 12;\nif (personAge > 18) { sendWelcome(personAge); }";
    const out = observeRename(before, after);
    expect(out).toEqual({
      kind: "rename",
      oldName: "userAge",
      newName: "personAge",
      occurrencesInFile: 3,
    });
  });

  it("refuses to fire when the rename happens alongside an unrelated content change", () => {
    // Adding a new line *and* renaming in the same diff is ambiguous —
    // the observer can't be sure the rename was deliberate vs.
    // incidental, so it stays silent.
    const before = "const a = 1;\nconst getColor = () => 'red';";
    const after = "const a = 1;\nconst getHue = () => 'red';\n// new comment";
    expect(observeRename(before, after).kind).toBe("none");
  });
});

describe("observeRename — negative cases (the skeptic)", () => {
  it("returns none for a pure addition", () => {
    const before = "let foo = 1;";
    const after = "let foo = 1;\nlet bar = 2;";
    expect(observeRename(before, after).kind).toBe("none");
  });

  it("returns none when only string content changed", () => {
    const before = 'console.log("hi");';
    const after = 'console.log("hello");';
    expect(observeRename(before, after).kind).toBe("none");
  });

  it("returns none when multiple identifiers changed", () => {
    const before = "let foo = 1; let baz = 2;";
    const after = "let bar = 1; let qux = 2;";
    expect(observeRename(before, after).kind).toBe("none");
  });

  it("returns none when the 'new' name is too short to bother with", () => {
    const before = "let foobar = 1;";
    const after = "let f = 1;";
    expect(observeRename(before, after).kind).toBe("none");
  });

  it("returns none when no change at all", () => {
    const t = "let foo = 1;";
    expect(observeRename(t, t).kind).toBe("none");
  });

  it("returns none when the old name remains in the file (incomplete rename)", () => {
    // foo_bar -> fooBar in line 1, but old name still in line 2.
    // This is a partial rename in progress, not a finished one.
    const before = "let foo_bar = 1;\nlet other = foo_bar + 1;";
    const after = "let fooBar = 1;\nlet other = foo_bar + 1;";
    expect(observeRename(before, after).kind).toBe("none");
  });

  it("returns none when only whitespace / formatting changed", () => {
    const before = "let foo=1;";
    const after = "let foo = 1;";
    expect(observeRename(before, after).kind).toBe("none");
  });

  it("returns none when the old name was a reserved keyword", () => {
    // We don't want to fire on the user fixing a "shadows a keyword"
    // mistake — too noisy.
    const before = "let class = 1;";
    const after = "let className = 1;";
    expect(observeRename(before, after).kind).toBe("none");
  });
});
