/**
 * Refactor watcher tests.
 *
 * The watcher couples `observeRename` to the editor store: it
 * subscribes to content snapshots, debounces, and on a quiet moment
 * checks whether a rename was performed. If so, it queries the
 * workspace for cross-file occurrences via the search IPC and
 * publishes a suggestion.
 *
 * These tests exercise the wiring with stub IPC + a controllable
 * clock so we can prove:
 *   • A clean rename in a file that has cross-file references
 *     publishes a suggestion.
 *   • A clean rename with no cross-file references does NOT publish
 *     (nothing to suggest).
 *   • Rapid back-to-back edits don't fire multiple suggestions —
 *     debounce works.
 *   • Disposal cleanly tears down the timer + subscription.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextHit } from "@/lib/ipc";
import { useRefactorSuggestions } from "@/store/refactorSuggestions";
import { createRefactorWatcher } from "./refactorWatcher";

function reset() {
  useRefactorSuggestions.setState({ active: null, dismissed: new Set() });
}

let stubHits: TextHit[] = [];
let searchCalls = 0;
function stubSearch(query: string): Promise<TextHit[]> {
  searchCalls += 1;
  return Promise.resolve(stubHits.filter((h) => h.text.includes(query)));
}

beforeEach(() => {
  reset();
  stubHits = [];
  searchCalls = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRefactorWatcher", () => {
  it("publishes a suggestion when the rename has cross-file references", async () => {
    stubHits = [
      { path: "src/other.ts", line: 1, text: "import { oldName } from './x';" },
      { path: "src/other.ts", line: 3, text: "oldName();" },
    ];
    const w = createRefactorWatcher({ search: stubSearch, debounceMs: 50 });
    w.observe("src/a.ts", "function oldName() {}\noldName();");
    w.observe(
      "src/a.ts",
      "function freshName() {}\nfreshName();",
    );
    await vi.advanceTimersByTimeAsync(60);
    const active = useRefactorSuggestions.getState().active;
    expect(active).toMatchObject({
      oldName: "oldName",
      newName: "freshName",
      sourcePath: "src/a.ts",
    });
    expect(active?.hits).toHaveLength(2);
    expect(searchCalls).toBe(1);
    w.dispose();
  });

  it("does not publish when the workspace search returns nothing", async () => {
    stubHits = [];
    const w = createRefactorWatcher({ search: stubSearch, debounceMs: 50 });
    w.observe("src/a.ts", "let oldName = 1;");
    w.observe("src/a.ts", "let freshName = 1;");
    await vi.advanceTimersByTimeAsync(60);
    expect(useRefactorSuggestions.getState().active).toBeNull();
    w.dispose();
  });

  it("debounces — multiple edits cause one analysis", async () => {
    stubHits = [{ path: "x", line: 1, text: "anchorName" }];
    const w = createRefactorWatcher({ search: stubSearch, debounceMs: 100 });
    w.observe("src/a.ts", "let anchorName = 1;");
    w.observe("src/a.ts", "let anchorName2 = 1;");
    w.observe("src/a.ts", "let anchorName3 = 1;");
    // Only the last pair (initial -> last) drives the analysis.
    await vi.advanceTimersByTimeAsync(150);
    expect(searchCalls).toBe(1);
    w.dispose();
  });

  it("ignores edits to the same path that don't constitute a rename", async () => {
    stubHits = [{ path: "x", line: 1, text: "foo" }];
    const w = createRefactorWatcher({ search: stubSearch, debounceMs: 30 });
    w.observe("src/a.ts", "let foo = 1;");
    // Adding a new line is not a rename.
    w.observe("src/a.ts", "let foo = 1;\nlet bar = 2;");
    await vi.advanceTimersByTimeAsync(60);
    expect(useRefactorSuggestions.getState().active).toBeNull();
    expect(searchCalls).toBe(0);
    w.dispose();
  });

  it("dispose() cancels the pending debounce", async () => {
    stubHits = [{ path: "x", line: 1, text: "anchorName" }];
    const w = createRefactorWatcher({ search: stubSearch, debounceMs: 100 });
    w.observe("src/a.ts", "let anchorName = 1;");
    w.observe("src/a.ts", "let anchorName2 = 1;");
    w.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(searchCalls).toBe(0);
    expect(useRefactorSuggestions.getState().active).toBeNull();
  });
});
