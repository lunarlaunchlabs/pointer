/**
 * Tests for the InlineEdit dialog's diagnostic awareness.
 *
 * The flow we care about here is the "Fix these" affordance: when the
 * user's current selection overlaps any Monaco diagnostic, the dialog
 * surfaces a banner with the first message and a one-click prompt
 * pre-fill. We don't exercise the streaming-LLM path — that's covered
 * elsewhere — just the static rendering / pre-fill behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listen } from "@tauri-apps/api/event";
import { InlineEdit } from "./InlineEdit";
import { useEditorStore } from "@/store/editor";
import { useDiagnostics, type Diagnostic } from "@/store/diagnostics";
import { useRecentEdits } from "@/store/recentEdits";
import * as ipcModule from "@/lib/ipc";

function resetStores() {
  useEditorStore.setState({
    tabs: [
      {
        path: "/proj/src/foo.ts",
        name: "foo.ts",
        content: "let foo = bar;",
        dirty: false,
        language: "typescript",
      },
    ],
    activePath: "/proj/src/foo.ts",
    selection: null,
    pendingReveal: null,
  });
  useDiagnostics.setState({ byUri: {}, errors: 0, warnings: 0 });
}

const diag: Diagnostic = {
  uri: "file:///proj/src/foo.ts",
  name: "foo.ts",
  startLine: 1,
  startCol: 11,
  endLine: 1,
  endCol: 14,
  severity: "error",
  message: "Cannot find name 'bar'.",
  source: "ts",
  code: "TS2304",
};

function renderInlineEdit() {
  return render(
    <InlineEdit
      selection={{ startLine: 1, endLine: 1, text: "let foo = bar;" }}
      position={{ top: 100, left: 100 }}
      onClose={vi.fn()}
      onProposeDiff={vi.fn()}
    />,
  );
}

describe("InlineEdit + diagnostics", () => {
  beforeEach(() => resetStores());

  it("does not show the fix banner when no markers overlap the selection", () => {
    renderInlineEdit();
    expect(screen.queryByText(/Fix these/i)).not.toBeInTheDocument();
  });

  it("surfaces the overlapping diagnostic's message in a banner", () => {
    useDiagnostics.setState({
      byUri: { "file:///proj/src/foo.ts": [diag] },
      errors: 1,
      warnings: 0,
    });
    renderInlineEdit();
    expect(screen.getByText("Cannot find name 'bar'.")).toBeInTheDocument();
    expect(screen.getByText(/Fix these/i)).toBeInTheDocument();
  });

  it("pre-fills the prompt when the user clicks Fix these", async () => {
    useDiagnostics.setState({
      byUri: { "file:///proj/src/foo.ts": [diag] },
      errors: 1,
      warnings: 0,
    });
    const user = userEvent.setup();
    renderInlineEdit();
    await user.click(screen.getByRole("button", { name: /Fix these/i }));
    const ta = screen.getByPlaceholderText(/Click 'Fix these'/i) as HTMLTextAreaElement;
    expect(ta.value).toContain("Fix this error");
    expect(ta.value).toContain("Cannot find name 'bar'.");
    expect(ta.value).toContain("TS2304");
  });

  it("summarises multiple overlapping diagnostics", () => {
    useDiagnostics.setState({
      byUri: {
        "file:///proj/src/foo.ts": [
          diag,
          { ...diag, code: "TS2552", message: "Did you mean 'baz'?" },
        ],
      },
      errors: 2,
      warnings: 0,
    });
    renderInlineEdit();
    expect(screen.getByText(/\+1 more/i)).toBeInTheDocument();
  });
});

describe("InlineEdit + context enrichment", () => {
  beforeEach(() => {
    resetStores();
    useRecentEdits.setState({ entries: [], cap: 8, snippetChars: 1500 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a context-enriched message including selection, surrounding code, and recent files", async () => {
    // Populate the editor with a longer file so 'surrounding context'
    // is a meaningful concept.
    const body = Array.from(
      { length: 25 },
      (_, i) => `const line${i} = ${i};`,
    ).join("\n");
    useEditorStore.setState({
      tabs: [
        {
          path: "/proj/src/foo.ts",
          name: "foo.ts",
          content: body,
          dirty: false,
          language: "typescript",
        },
      ],
      activePath: "/proj/src/foo.ts",
      selection: null,
      pendingReveal: null,
    });
    useRecentEdits.getState().note(
      "/proj/src/utils.ts",
      "export function format(n: number): string { return String(n); }",
    );
    const chatSpy = vi
      .spyOn(ipcModule.ipc, "ollamaChat")
      .mockResolvedValue();

    const user = userEvent.setup();
    render(
      <InlineEdit
        selection={{
          startLine: 12,
          endLine: 12,
          text: "const line11 = 11;",
        }}
        position={{ top: 100, left: 100 }}
        onClose={vi.fn()}
        onProposeDiff={vi.fn()}
      />,
    );
    const ta = screen.getByPlaceholderText(/Refactor this/i);
    await user.type(ta, "Rename line11 to row11");
    await user.keyboard("{Enter}");

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const args = chatSpy.mock.calls[0][1];
    const userMessage = args.messages[0].content;
    expect(userMessage).toContain("const line11 = 11;");
    expect(userMessage).toContain("Surrounding context:");
    expect(userMessage).toContain("<<< SELECTION");
    expect(userMessage).toContain("Recent file: /proj/src/utils.ts");
    expect(userMessage).toContain("export function format");
    expect(userMessage).toContain("Instruction: Rename line11 to row11");
  });

  it("applies streamed search/replace output from the event buffer", async () => {
    let emit: ((payload: unknown) => void) | null = null;
    vi.mocked(listen).mockImplementation(async (_event, cb) => {
      emit = (payload: unknown) => cb({ payload } as never);
      return () => {};
    });
    vi.spyOn(ipcModule.ipc, "ollamaChat").mockResolvedValue();
    const onProposeDiff = vi.fn();

    const user = userEvent.setup();
    render(
      <InlineEdit
        selection={{ startLine: 1, endLine: 1, text: "let foo = bar;" }}
        position={{ top: 100, left: 100 }}
        onClose={vi.fn()}
        onProposeDiff={onProposeDiff}
      />,
    );

    await user.type(screen.getByPlaceholderText(/Refactor this/i), "Use baz");
    await user.click(screen.getByRole("button", { name: /Generate/i }));
    await waitFor(() => expect(emit).not.toBeNull());

    act(() => {
      emit?.({
        token:
          "<<<<<<< SEARCH /proj/src/foo.ts\nlet foo = bar;\n=======\nlet foo = baz;\n>>>>>>> REPLACE\n",
      });
      emit?.({ done: true });
    });

    await waitFor(() =>
      expect(onProposeDiff).toHaveBeenCalledWith(
        "let foo = bar;",
        "let foo = baz;",
        "Use baz",
      ),
    );
  });
});
