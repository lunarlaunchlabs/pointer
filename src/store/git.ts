/**
 * Git status store.
 *
 * Polls the backend on a coarse interval (5s) plus on demand (file save,
 * workspace switch, focus, and debounced filesystem changes). Typing stays
 * in Monaco's staged buffer, so watcher-driven refreshes track real disk/git
 * changes without waking the git process for every keystroke.
 *
 * Errors are stored on the same object the UI reads, so components stay
 * declarative: "if isRepo show dots; if error swallow silently".
 */

import { create } from "@/lib/signalStore";
import { ipc, type GitStatus, type GitFileStatus } from "@/lib/ipc";

export type GitFolderStatusSummary = {
  total: number;
  counts: Partial<Record<GitFileStatus, number>>;
  statuses: GitFileStatus[];
  dominant: GitFileStatus;
};

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
  /** Roll-up lookup used by FileTree folder decorations. */
  folderStatusFor: (absolutePath: string) => GitFolderStatusSummary | null;
};

const EMPTY: GitStatus = {
  is_repo: false,
  branch: null,
  ahead: null,
  behind: null,
  files: {},
  entries: [],
  dirty_count: 0,
  operation: null,
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
    const rel = relativeGitPath(ws, absolutePath);
    if (rel == null || rel === "") return null;
    return status.files[rel] ?? null;
  },

  folderStatusFor: (absolutePath) => {
    const ws = get().workspace;
    const status = get().status;
    if (!ws || !status.is_repo) return null;
    const rel = relativeGitPath(ws, absolutePath);
    if (rel == null) return null;
    return aggregateFolderStatus(status.files, rel);
  },
}));

function relativeGitPath(workspace: string, absolutePath: string): string | null {
  const ws = normalizeAbs(workspace);
  const abs = normalizeAbs(absolutePath);
  if (!ws) return null;
  if (abs === ws) return "";
  const prefix = ws.endsWith("/") ? ws : `${ws}/`;
  if (!abs.startsWith(prefix)) return null;
  return abs.slice(prefix.length).replace(/^\/+/, "");
}

function normalizeAbs(path: string): string {
  const normal = path.replace(/\\/g, "/");
  if (normal === "/") return normal;
  return normal.replace(/\/+$/, "");
}

export function aggregateFolderStatus(
  files: Record<string, GitFileStatus>,
  folderRelPath: string,
): GitFolderStatusSummary | null {
  const folder = folderRelPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const prefix = folder ? `${folder}/` : "";
  const counts: Partial<Record<GitFileStatus, number>> = {};
  let total = 0;
  for (const [rawPath, status] of Object.entries(files)) {
    const path = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const inFolder = folder
      ? path === folder || path.startsWith(prefix)
      : path.length > 0;
    if (!inFolder) continue;
    counts[status] = (counts[status] ?? 0) + 1;
    total += 1;
  }
  if (total === 0) return null;
  const statuses = GIT_STATUS_ORDER.filter((status) => (counts[status] ?? 0) > 0);
  return {
    total,
    counts,
    statuses,
    dominant: statuses[0] ?? "modified",
  };
}

const GIT_STATUS_ORDER: GitFileStatus[] = [
  "conflicted",
  "deleted",
  "added",
  "modified",
  "renamed",
  "untracked",
  "ignored",
];

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
      return "text-noir-warn";
    case "deleted":
      return "text-noir-err";
    case "untracked":
      return "text-noir-accent"; // pointer pink
    case "conflicted":
      return "text-noir-err";
    case "ignored":
      return "text-noir-mute";
  }
}

export function gitStatusNameClass(
  status: GitFileStatus | null,
  options: { isFolder?: boolean } = {},
): string {
  if (!status) return "text-noir-text";
  if (status === "deleted" && !options.isFolder) {
    return "text-noir-err line-through decoration-noir-err/70";
  }
  if (status === "ignored") return "text-noir-mute";
  return gitStatusColor(status);
}

export function gitStatusBorderClass(status: GitFileStatus | null): string {
  switch (status) {
    case "added":
      return "border-l-noir-ok";
    case "modified":
    case "renamed":
      return "border-l-noir-warn";
    case "deleted":
    case "conflicted":
      return "border-l-noir-err";
    case "untracked":
      return "border-l-noir-accent";
    case "ignored":
      return "border-l-noir-mute";
    default:
      return "border-l-transparent";
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

export function gitStatusLabel(s: GitFileStatus): string {
  switch (s) {
    case "added":
      return "added";
    case "modified":
      return "modified";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "untracked":
      return "untracked";
    case "conflicted":
      return "conflicted";
    case "ignored":
      return "ignored";
  }
}

export function gitFolderStatusTitle(summary: GitFolderStatusSummary): string {
  const parts = summary.statuses.map((status) => {
    const count = summary.counts[status] ?? 0;
    return `${count} ${gitStatusLabel(status)}`;
  });
  return `Git changes in folder: ${parts.join(", ")}`;
}
