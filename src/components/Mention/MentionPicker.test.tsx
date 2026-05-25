/**
 * MentionPicker component tests.
 *
 * The picker is pure UI — its data layer (file search, diagnostics) is
 * fed in via props. That makes it easy to drive: render with a fixed
 * set of candidates and assert what the user sees + what `onPick`
 * receives for each interaction.
 */

import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MentionPicker } from "./MentionPicker";
import type { Diagnostic } from "@/store/diagnostics";

const diag = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  uri: "file:///src/foo.ts",
  name: "foo.ts",
  startLine: 12,
  startCol: 4,
  endLine: 12,
  endCol: 8,
  severity: "error",
  message: "Cannot find name 'foo'.",
  source: "ts",
  code: "TS2304",
  ...over,
});

// Wrapper that wires a real anchor element into the picker, since the
// picker now portals into body and measures the anchor's bounding
// rect to place itself. Without a host anchor the popover would not
// know where to live.
function Host(
  overrides: Partial<React.ComponentProps<typeof MentionPicker>> = {},
) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  return (
    <>
      <textarea ref={ref} data-testid="anchor" />
      <MentionPicker
        anchorRef={ref}
        query=""
        fileCandidates={[]}
        diagnostics={[]}
        hasSelection={false}
        codebaseUsable
        attached={[]}
        onPick={overrides.onPick ?? (() => {})}
        onClose={overrides.onClose ?? (() => {})}
        {...overrides}
      />
    </>
  );
}

const renderPicker = (
  overrides: Partial<React.ComponentProps<typeof MentionPicker>> = {},
) => {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(<Host onPick={onPick} onClose={onClose} {...overrides} />);
  return { onPick, onClose };
};

describe("MentionPicker", () => {
  it("renders all backed categories when the query is empty", () => {
    renderPicker();
    expect(screen.getByText("@file")).toBeInTheDocument();
    expect(screen.getByText("@folder")).toBeInTheDocument();
    expect(screen.getByText("@selection")).toBeInTheDocument();
    expect(screen.getByText("@codebase")).toBeInTheDocument();
    expect(screen.getByText("@diagnostic")).toBeInTheDocument();
    // `@symbol` is intentionally absent until we ship a real symbol
    // provider — surfacing it would lead to an empty results list.
    expect(screen.queryByText("@symbol")).not.toBeInTheDocument();
  });

  it("disables @selection when there's no editor selection", () => {
    renderPicker({ hasSelection: false });
    const selRow = screen.getByText("@selection").closest("button")!;
    expect(selRow).toHaveAttribute("aria-selected");
    // The row carries a title with the disabled reason; clicking it
    // is a no-op (verified via onPick assertion in another test).
    expect(selRow.getAttribute("title") ?? "").toMatch(/Select text/);
  });

  it("disables @codebase when indexing is not usable", () => {
    renderPicker({ codebaseUsable: false });
    const row = screen.getByText("@codebase").closest("button")!;
    expect(row.getAttribute("title") ?? "").toMatch(/Indexing/);
  });

  it("shows file candidates when the query is filename-ish", () => {
    renderPicker({
      query: "App",
      fileCandidates: [
        { path: "src/App.tsx" },
        { path: "src/Other.tsx" },
      ],
    });
    expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
    // The non-matching file is filtered out by the picker's
    // case-insensitive substring match.
    expect(screen.queryByText("src/Other.tsx")).not.toBeInTheDocument();
  });

  it("flags duplicates with an 'attached' badge", () => {
    renderPicker({
      query: "App",
      fileCandidates: [{ path: "src/App.tsx" }],
      attached: [{ kind: "file", path: "src/App.tsx" }],
    });
    expect(screen.getByText("attached")).toBeInTheDocument();
  });

  it("emits diagnostic picks when the user is in @diagnostic mode", async () => {
    const { onPick } = renderPicker({
      query: "diag",
      diagnostics: [diag()],
    });
    const row = screen.getByText("Cannot find name 'foo'.");
    await userEvent.pointer({ keys: "[MouseLeft>]", target: row });
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "diagnostic" }),
    );
  });

  it("emits a category pick for an alias-only query", () => {
    const { onPick } = renderPicker({ query: "code" });
    // 'code' aliases to the codebase category. The picker should
    // surface one explicit codebase row.
    const codeRow = screen
      .getByText(/@codebase/)
      .closest("button")!;
    fireEvent.mouseDown(codeRow);
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "codebase" }),
    );
  });

  it("navigates with ArrowDown / Enter via global keyboard", async () => {
    const { onPick } = renderPicker({
      query: "App",
      fileCandidates: [
        { path: "src/App.tsx" },
        { path: "src/App.test.tsx" },
      ],
    });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({
      kind: "file",
      path: "src/App.test.tsx",
    });
  });

  it("calls onClose on Escape", () => {
    const { onClose } = renderPicker();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("falls back to a friendly 'no matches' when no rows produce", () => {
    renderPicker({ query: "diag", diagnostics: [] });
    expect(screen.getByText(/No matches/i)).toBeInTheDocument();
  });
});
