/**
 * RefactorSuggestion UI tests.
 *
 * The card is the user's first touch point with the cross-file
 * rename feature. We pin three behaviours:
 *
 *   • It only renders when there's an active suggestion.
 *   • The Dismiss button hides the card and remembers the pair
 *     (covered transitively by the store test, but we also assert
 *     the card disappears).
 *   • The Apply button calls into the workspace applier and, on
 *     success, marks the suggestion applied (card disappears).
 *
 * IPC is stubbed at the module boundary so the test doesn't reach
 * any real file system.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefactorSuggestion } from "./RefactorSuggestion";
import { useRefactorSuggestions } from "@/store/refactorSuggestions";
import * as ipcModule from "@/lib/ipc";

beforeEach(() => {
  useRefactorSuggestions.setState({ active: null, dismissed: new Set() });
  vi.spyOn(ipcModule.ipc, "readTextFile").mockResolvedValue("foo();");
  vi.spyOn(ipcModule.ipc, "writeTextFile").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RefactorSuggestion", () => {
  it("renders nothing when there is no active suggestion", () => {
    const { container } = render(<RefactorSuggestion />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the active suggestion and the affected file count", () => {
    useRefactorSuggestions.getState().propose({
      oldName: "foo",
      newName: "bar",
      sourcePath: "src/source.ts",
      hits: [
        { path: "src/a.ts", line: 1, text: "foo()" },
        { path: "src/a.ts", line: 4, text: "foo + 1" },
        { path: "src/b.ts", line: 9, text: "foo()" },
      ],
    });
    render(<RefactorSuggestion />);
    expect(screen.getByTestId("refactor-suggestion")).toBeInTheDocument();
    // The summary line and the description both reference foo / bar.
    expect(screen.getAllByText("foo").length).toBeGreaterThan(0);
    expect(screen.getAllByText("bar").length).toBeGreaterThan(0);
    // The button mentions 2 files (one per unique path).
    expect(screen.getByRole("button", { name: /Apply to 2 files/i })).toBeInTheDocument();
  });

  it("dismiss removes the card and marks the pair as dismissed", () => {
    useRefactorSuggestions.getState().propose({
      oldName: "foo",
      newName: "bar",
      sourcePath: "src/source.ts",
      hits: [{ path: "src/a.ts", line: 1, text: "foo()" }],
    });
    render(<RefactorSuggestion />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    expect(screen.queryByTestId("refactor-suggestion")).not.toBeInTheDocument();
    expect(useRefactorSuggestions.getState().dismissed.has("foo→bar")).toBe(true);
  });

  it("apply triggers the workspace rewrite and clears the suggestion", async () => {
    useRefactorSuggestions.getState().propose({
      oldName: "foo",
      newName: "bar",
      sourcePath: "src/source.ts",
      hits: [{ path: "src/a.ts", line: 1, text: "foo()" }],
    });
    render(<RefactorSuggestion />);
    fireEvent.click(screen.getByRole("button", { name: /Apply to 1 file/i }));
    await waitFor(() => {
      expect(useRefactorSuggestions.getState().active).toBeNull();
    });
    expect(ipcModule.ipc.writeTextFile).toHaveBeenCalledWith("src/a.ts", "bar();");
  });
});
