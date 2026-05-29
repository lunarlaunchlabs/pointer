/**
 * Tests for the git status store's path-translation logic.
 *
 * The backend reports forward-slashed paths relative to the workspace
 * root. The store's `statusFor(abs)` is the lookup the FileTree uses on
 * every node render, so its correctness has high blast radius:
 *  - It must return null for paths outside the workspace.
 *  - It must normalise Windows backslashes before doing the lookup.
 *  - It must handle the leading slash gracefully (the FileTree's path
 *    field may include a trailing or leading separator depending on the
 *    OS).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useGit } from "./git";

function reset() {
  useGit.setState({
    status: {
      is_repo: true,
      branch: "main",
      ahead: 0,
      behind: 0,
      files: {
        "src/App.tsx": "modified",
        "src/lib/lang.ts": "added",
        ".env.local": "untracked",
      },
      entries: [],
      dirty_count: 3,
      operation: null,
      error: null,
    },
    workspace: "/Users/test/proj",
  });
}

describe("useGit.statusFor", () => {
  beforeEach(() => reset());

  it("returns the status for a file in the workspace", () => {
    const s = useGit.getState().statusFor("/Users/test/proj/src/App.tsx");
    expect(s).toBe("modified");
  });

  it("returns null for paths outside the workspace", () => {
    const s = useGit
      .getState()
      .statusFor("/Users/other/elsewhere/src/App.tsx");
    expect(s).toBeNull();
  });

  it("returns null for clean / untracked-elsewhere files", () => {
    const s = useGit.getState().statusFor("/Users/test/proj/README.md");
    expect(s).toBeNull();
  });

  it("normalises Windows backslashes before lookup", () => {
    useGit.setState({ workspace: "C:\\dev\\proj" });
    useGit.setState((prev) => ({
      status: {
        ...prev.status,
        files: { "src/app.ts": "added" },
      },
    }));
    const s = useGit.getState().statusFor("C:\\dev\\proj\\src\\app.ts");
    expect(s).toBe("added");
  });

  it("returns null when the workspace isn't a repo", () => {
    useGit.setState((prev) => ({
      status: { ...prev.status, is_repo: false },
    }));
    expect(useGit.getState().statusFor("/Users/test/proj/src/App.tsx")).toBeNull();
  });
});

describe("useGit.setWorkspace", () => {
  it("resets status when switching workspaces", () => {
    reset();
    useGit.getState().setWorkspace("/Users/test/other-proj");
    const s = useGit.getState().status;
    expect(s.is_repo).toBe(false);
    expect(s.files).toEqual({});
    expect(useGit.getState().workspace).toBe("/Users/test/other-proj");
  });

  it("no-ops when the workspace is unchanged", () => {
    reset();
    const before = useGit.getState().status;
    useGit.getState().setWorkspace("/Users/test/proj");
    expect(useGit.getState().status).toBe(before);
  });
});
