/**
 * Git status store.
 *
 * Polls the backend on a coarse interval (5s) plus on demand (file save,
 * workspace switch, focus). We deliberately *don't* hook into the FS
 * watcher here because every keystroke that hits disk would queue a
 * status refresh and saturate the IPC channel for no visible benefit —
 * the 5s tick is good enough for the FileTree dot and the branch pill.
 *
 * Errors are stored on the same object the UI reads, so components stay
 * declarative: "if isRepo show dots; if error swallow silently".
 */

import { create } from "zustand";
import { ipc, type GitStatus, type GitFileStatus } from "@/lib/ipc";

type State = {
  status: GitStatus;
  /** Workspace currently tracked. Empty string means "no folder open". */
  workspace: string;
  /** Tick counter for hard-refresh callers (file save, etc.). */
  lastRefresh: number;

  setWorkspace: (root: string) => void;
  refresh: () => Promise<void>;
  /** Cheap lookup used by FileTree decorations. */
  statusFor: (absolutePath: string) => GitFileStatus | null;
};

const EMPTY: GitStatus = {
  is_repo: false,
  branch: null,
  ahead: null,
  behind: null,
  files: {},
  entries: [],
  dirty_count: 0,
  error: null,
};

export const useGit = create<State>((set, get) => ({
  status: EMPTY,
  workspace: "",
  lastRefresh: 0,

  setWorkspace: (root) => {
    const prev = get().workspace;
    if (prev === root) return;
    // Clear stale status immediately so the UI doesn't keep showing dots
    // from the previous workspace during the in-flight refresh.
    set({ workspace: root, status: EMPTY, lastRefresh: 0 });
    if (root) {
      void get().refresh();
    }
  },

  refresh: async () => {
    const ws = get().workspace;
    if (!ws) return;
    try {
      const s = await ipc.gitStatus(ws);
      set({ status: s, lastRefresh: Date.now() });
    } catch (e) {
      // Backend already encodes errors inline; throwing means something
      // truly broke (IPC channel down). Don't poison the UI — just log.
      console.warn("git status failed", e);
    }
  },

  statusFor: (absolutePath) => {
    const ws = get().workspace;
    const status = get().status;
    if (!ws || !status.is_repo) return null;
    if (!absolutePath.startsWith(ws)) return null;
    // Strip leading workspace prefix + separator. Backend emits forward
    // slashes; we normalise on the way in to match.
    const rel = absolutePath
      .slice(ws.length)
      .replace(/^[\\/]+/, "")
      .replace(/\\/g, "/");
    return status.files[rel] ?? null;
  },
}));

/**
 * Returns the noir-palette colour for a given git status. Centralised so
 * the FileTree dot, the SCM panel, and any future Monaco gutter
 * decorations agree on the colour key.
 */
export function gitStatusColor(s: GitFileStatus): string {
  switch (s) {
    case "added":
      return "text-noir-ok"; // green
    case "modified":
    case "renamed":
      return "text-amber-400";
    case "deleted":
      return "text-noir-warn"; // red
    case "untracked":
      return "text-noir-accent"; // pointer pink
    case "conflicted":
      return "text-noir-warn";
    case "ignored":
      return "text-noir-mute";
  }
}

export function gitStatusLetter(s: GitFileStatus): string {
  switch (s) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "conflicted":
      return "C";
    case "ignored":
      return "·";
  }
}
