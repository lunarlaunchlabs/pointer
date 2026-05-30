import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Tabs } from "./Tabs";
import { useEditorStore } from "@/store/editor";
import { useSession } from "@/store/session";
import { useGit } from "@/store/git";

describe("<Tabs>", () => {
  beforeEach(() => {
    useEditorStore.setState({
      tabs: [],
      activePath: null,
      pinned: [],
    });
    useSession.setState({ pinnedTabs: [] });
    useGit.setState({
      workspace: "",
      status: {
        is_repo: false,
        branch: null,
        ahead: null,
        behind: null,
        files: {},
        entries: [],
        dirty_count: 0,
        operation: null,
        error: null,
      },
    });
  });

  it("exports active file paths as assistant context during drag", () => {
    useEditorStore.setState({
      tabs: [
        {
          path: "/repo/src/App.tsx",
          name: "App.tsx",
          content: "",
          dirty: false,
          language: "typescriptreact",
        },
      ],
      activePath: "/repo/src/App.tsx",
      pinned: [],
    });
    useSession.setState({ pinnedTabs: [] });

    const payloads = new Map<string, string>();
    render(<Tabs />);
    fireEvent.dragStart(screen.getByRole("tab", { name: "App.tsx" }), {
      dataTransfer: {
        effectAllowed: "uninitialized",
        setData: (type: string, value: string) => payloads.set(type, value),
      },
    });

    expect(payloads.get("text/pointer-tab")).toBe("/repo/src/App.tsx");
    expect(payloads.get("application/x-pointer-paths")).toBe(
      JSON.stringify(["/repo/src/App.tsx"]),
    );
    expect(payloads.get("text/plain")).toBe("/repo/src/App.tsx");
  });

  it("colors tab text and edge by the tracked git status", () => {
    useEditorStore.setState({
      tabs: [
        {
          path: "/repo/src/App.tsx",
          name: "App.tsx",
          content: "",
          dirty: false,
          language: "typescriptreact",
        },
      ],
      activePath: "/repo/src/App.tsx",
      pinned: [],
    });
    useGit.setState({
      workspace: "/repo",
      status: {
        is_repo: true,
        branch: "main",
        ahead: 0,
        behind: 0,
        files: { "src/App.tsx": "modified" },
        entries: [],
        dirty_count: 1,
        operation: null,
        error: null,
      },
    });

    render(<Tabs />);

    const tab = screen.getByRole("tab", { name: "App.tsx" });
    expect(tab.getAttribute("data-git-status")).toBe("modified");
    expect(tab.className).toContain("border-l-noir-warn");
    expect(screen.getByText("App.tsx").className).toContain("text-noir-warn");
  });
});
