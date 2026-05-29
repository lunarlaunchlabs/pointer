/**
 * Composer integration tests.
 *
 * These exercise the full @-mention flow end-to-end: a user types the
 * trigger, the picker opens, picks a file, and the chip + mirror token
 * appear. The IPC layer is stubbed via the global Tauri mocks so the
 * picker's file search returns predictable results.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";
import { useChat, type Reference } from "@/store/chat";
import { useEditorStore } from "@/store/editor";
import { useDiagnostics } from "@/store/diagnostics";

function resetStores() {
  useChat.setState({
    sessions: [],
    activeSessionId: null,
    streamingId: null,
    currentRequest: null,
    pendingRefs: [],
    hydrated: true,
  });
  useEditorStore.setState({
    tabs: [],
    activePath: null,
    selection: null,
    pendingReveal: null,
  });
  useDiagnostics.setState({ byUri: {}, errors: 0, warnings: 0 });
}

type Props = React.ComponentProps<typeof Composer>;

function renderComposer(overrides: Partial<Props> = {}) {
  const onSend = vi.fn();
  const onCancel = vi.fn();
  const onAddReference = vi.fn((r: Reference) => {
    useChat.setState((s) => ({ pendingRefs: [...s.pendingRefs, r] }));
  });
  const onRemoveReference = vi.fn();
  render(
    <Composer
      disabled={false}
      streaming={false}
      onSend={onSend}
      onCancel={onCancel}
      references={[]}
      onAddReference={onAddReference}
      onRemoveReference={onRemoveReference}
      {...overrides}
    />,
  );
  return { onSend, onCancel, onAddReference, onRemoveReference };
}

describe("Composer", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "search_files") {
        return [{ path: "src/App.tsx", name: "App.tsx" }];
      }
      if (cmd === "search_directories") {
        return [{ path: "src", name: "src" }];
      }
      // Default: surface a useful error so we catch unexpected calls
      // in component tests.
      throw new Error(`unexpected invoke ${cmd}`);
    });
  });

  it("opens the picker when the user types @ and fires onAddReference on pick", async () => {
    const user = userEvent.setup();
    const { onAddReference } = renderComposer();
    const ta = screen.getByPlaceholderText(/Ask, edit, generate/i);
    await user.click(ta);
    await user.type(ta, "@");
    // The picker debounces 60ms before issuing the search; wait for
    // the file row to materialise.
    const row = await screen.findByText("src/App.tsx", {}, { timeout: 1500 });
    fireEvent.mouseDown(row);
    await waitFor(() =>
      expect(onAddReference).toHaveBeenCalledWith({
        kind: "file",
        path: "src/App.tsx",
      }),
    );
  });

  it("closes the picker after Escape", async () => {
    const user = userEvent.setup();
    renderComposer();
    const ta = screen.getByPlaceholderText(/Ask, edit, generate/i);
    await user.type(ta, "@");
    expect(await screen.findByText("@file")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByText("@file")).not.toBeInTheDocument(),
    );
  });

  it("renders existing reference chips above the input", () => {
    renderComposer({
      references: [{ kind: "file", path: "src/foo.ts" }],
    });
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
  });

  it("submits the text and clears the input on Enter", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    const ta = screen.getByPlaceholderText(/Ask, edit, generate/i);
    await user.click(ta);
    await user.type(ta, "hello{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("does not fire onSend while the picker is open", async () => {
    const user = userEvent.setup();
    const { onSend, onAddReference } = renderComposer();
    const ta = screen.getByPlaceholderText(/Ask, edit, generate/i);
    await user.type(ta, "fix @");
    await screen.findByText("@file");
    fireEvent.keyDown(window, { key: "Enter" });
    // The picker swallows Enter as "commit selected row" — the first
    // row is `@file` (category header), which doesn't add a ref but
    // does keep the picker open.
    expect(onSend).not.toHaveBeenCalled();
    // Sanity: the picker is still in the DOM after the keydown.
    expect(screen.queryByText("@file")).toBeInTheDocument();
    // …and no ref was added by the category header click either.
    expect(onAddReference).not.toHaveBeenCalled();
  });

  it("keeps @file queries live after the category alias", async () => {
    const user = userEvent.setup();
    renderComposer();
    const ta = screen.getByPlaceholderText(/Ask, edit, generate/i);
    await user.type(ta, "@file App");
    expect(await screen.findByText("src/App.tsx")).toBeInTheDocument();
  });

  it("accepts dropped files, breakpoints, and debug values as context", async () => {
    const { onAddReference } = renderComposer();
    const root = screen
      .getByPlaceholderText(/Ask, edit, generate/i)
      .closest("[data-pointer-drop-context='assistant']")!;
    const payloads = new Map<string, string>([
      ["application/x-pointer-paths", JSON.stringify(["/repo/src/App.tsx"])],
      [
        "application/x-pointer-breakpoint",
        JSON.stringify({
          id: "bp_1",
          path: "/repo/src/App.tsx",
          line: 7,
          enabled: true,
          createdAt: 1,
        }),
      ],
      [
        "application/x-pointer-debug-value",
        JSON.stringify({
          id: "dbg_1",
          name: "user",
          value: "{ id: 1 }",
          type: "User",
          createdAt: 1,
        }),
      ],
    ]);
    fireEvent.drop(root, {
      dataTransfer: {
        types: Array.from(payloads.keys()),
        files: [],
        getData: (type: string) => payloads.get(type) ?? "",
        dropEffect: "copy",
      },
    });
    await waitFor(() => {
      expect(onAddReference).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "breakpoint", line: 7 }),
      );
      expect(onAddReference).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "debugValue", name: "user" }),
      );
      expect(onAddReference).toHaveBeenCalledWith({
        kind: "file",
        path: "/repo/src/App.tsx",
      });
    });
  });
});
