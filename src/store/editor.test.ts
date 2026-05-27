import { beforeEach, describe, expect, it } from "vitest";
import { detectPreviewKind, useEditorStore } from "@/store/editor";
import { useSession } from "@/store/session";

describe("editor path rewrites", () => {
  beforeEach(() => {
    useEditorStore.setState({
      tabs: [
        {
          path: "/repo/src/App.jsx",
          name: "App.jsx",
          content: "unsaved app buffer",
          dirty: true,
          language: "javascript",
        },
        {
          path: "/repo/src/components/Button.tsx",
          name: "Button.tsx",
          content: "button",
          dirty: false,
          language: "typescript",
        },
        {
          path: "/repo/README.md",
          name: "README.md",
          content: "readme",
          dirty: false,
          language: "markdown",
        },
      ],
      activePath: "/repo/src/App.jsx",
      pinned: ["/repo/src/App.jsx"],
      closedTabs: ["/repo/src/components/Button.tsx"],
      pendingReveal: {
        path: "/repo/src/components/Button.tsx",
        line: 4,
        column: 2,
        nonce: 1,
      },
      selection: null,
      cursor: null,
    });
    useSession.setState({
      openTabs: ["/repo/src/App.jsx", "/repo/src/components/Button.tsx"],
      activePath: "/repo/src/App.jsx",
      pinnedTabs: ["/repo/src/App.jsx"],
      viewState: {
        "/repo/src/App.jsx": { line: 8, column: 3 },
        "/repo/README.md": { line: 1, column: 1 },
      },
      hotExitBuffers: {
        "/repo/src/App.jsx": "unsaved app buffer",
      },
    });
  });

  it("preserves dirty buffers and session metadata when a folder moves", () => {
    useEditorStore.getState().rewritePathPrefix("/repo/src", "/repo/app");

    const editor = useEditorStore.getState();
    expect(editor.tabs[0]).toMatchObject({
      path: "/repo/app/App.jsx",
      name: "App.jsx",
      content: "unsaved app buffer",
      dirty: true,
    });
    expect(editor.tabs[1].path).toBe("/repo/app/components/Button.tsx");
    expect(editor.tabs[2].path).toBe("/repo/README.md");
    expect(editor.activePath).toBe("/repo/app/App.jsx");
    expect(editor.pinned).toEqual(["/repo/app/App.jsx"]);
    expect(editor.closedTabs).toEqual(["/repo/app/components/Button.tsx"]);
    expect(editor.pendingReveal?.path).toBe("/repo/app/components/Button.tsx");

    const session = useSession.getState();
    expect(session.openTabs).toEqual([
      "/repo/app/App.jsx",
      "/repo/app/components/Button.tsx",
      "/repo/README.md",
    ]);
    expect(session.activePath).toBe("/repo/app/App.jsx");
    expect(session.pinnedTabs).toEqual(["/repo/app/App.jsx"]);
    expect(session.viewState["/repo/app/App.jsx"]).toEqual({ line: 8, column: 3 });
    expect(session.hotExitBuffers["/repo/app/App.jsx"]).toBe("unsaved app buffer");
    expect(session.viewState["/repo/README.md"]).toEqual({ line: 1, column: 1 });
  });

  it("overrides a tab language without touching content or dirty state", () => {
    useEditorStore.getState().setLanguage("/repo/src/App.jsx", "typescript");

    const tab = useEditorStore
      .getState()
      .tabs.find((t) => t.path === "/repo/src/App.jsx");
    expect(tab).toMatchObject({
      content: "unsaved app buffer",
      dirty: true,
      language: "typescript",
    });
    expect(useEditorStore.getState().tabs[1].language).toBe("typescript");
    expect(useEditorStore.getState().tabs[2].language).toBe("markdown");
  });

  it("routes font and macOS icon blobs to the binary preview", () => {
    expect(detectPreviewKind("/repo/public/fonts/site.woff2")).toBe("binary");
    expect(detectPreviewKind("/repo/public/fonts/site.ttf")).toBe("binary");
    expect(detectPreviewKind("/repo/src-tauri/icons/icon.icns")).toBe("binary");
  });
});
