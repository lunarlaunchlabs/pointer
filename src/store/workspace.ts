import { create } from "zustand";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc, type FsEntry } from "@/lib/ipc";
import { useSession } from "@/store/session";
import { invalidateWorkspaceBrief } from "@/lib/workspaceBrief";

type PendingCreate = {
  parentDir: string;
  kind: "file" | "folder";
  /** Bumped on every new request so FileTree's effect re-fires even when
   *  the payload is otherwise identical (e.g. user picks "New File" twice
   *  in a row from the menu before completing the first one). */
  nonce: number;
};

type State = {
  root: string | null;
  entries: FsEntry[];
  expanded: Set<string>;
  childrenCache: Record<string, FsEntry[]>;
  /** Imperative "start a new file/folder input in the tree" trigger. Set by
   *  whoever wants to initiate a create flow (menu, palette, button); the
   *  FileTree component listens and renders the inline input. Null when
   *  there's nothing pending. */
  pendingCreate: PendingCreate | null;
  openFolder: () => Promise<void>;
  setRoot: (root: string) => Promise<void>;
  toggle: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
  refreshDir: (path: string) => Promise<void>;
  expandTo: (path: string) => Promise<void>;
  collapseAll: () => void;
  requestCreate: (kind: "file" | "folder", parentDir?: string) => void;
  clearPendingCreate: () => void;
};

export const useWorkspace = create<State>((set, get) => ({
  root: null,
  entries: [],
  expanded: new Set<string>(),
  childrenCache: {},
  pendingCreate: null,
  openFolder: async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      await get().setRoot(selected);
    }
  },
  setRoot: async (root) => {
    // IMPORTANT: watch_workspace is the SOLE writer of the backend's
    // state.workspace (read_workspace_tree was changed to be a pure
    // directory-listing call so subdirectory expansions don't
    // silently re-root the backend). We MUST call it before the
    // first readWorkspaceTree / readTextFile / etc., otherwise
    // path-validation gates that depend on state.workspace would
    // either be unset (open as-is, no canonicalization) or stale
    // (still the previous workspace). The watcher itself spawns on
    // a background thread; watchWorkspace returns once state has
    // been written.
    try {
      await ipc.watchWorkspace(root);
    } catch (e) {
      console.warn("watch failed", e);
    }
    // Different workspace → drop the cached brief so the next chat or
    // agent turn re-fetches against the new root rather than handing
    // the model a description of the previous project.
    invalidateWorkspaceBrief();
    const entries = await ipc.readWorkspaceTree(root);
    set({ root, entries, expanded: new Set(), childrenCache: {} });
    // Selection / compare state are scoped to the old workspace —
    // dropping them avoids ghost references to files that no longer
    // exist in the new tree.
    try {
      const { useTreeSelection } = await import("@/store/treeSelection");
      useTreeSelection.getState().clear();
    } catch {}
    useSession.getState().noteRoot(root);
    // Expose the workspace root on `window` so utility callers
    // (e.g. "Copy Relative Path") can avoid prop-drilling. Pure
    // read-only — nothing mutates this except setRoot itself.
    (window as unknown as { __pointerWorkspaceRoot?: string }).__pointerWorkspaceRoot = root;
    // Per-workspace overrides (.pointer/settings.json). Async-import
    // to keep the workspace store free of the settings store import
    // cycle that would otherwise form.
    try {
      const { applyWorkspaceSettings } = await import("@/lib/workspaceSettings");
      await applyWorkspaceSettings(root);
    } catch (e) {
      console.warn("apply workspace settings failed", e);
    }
  },
  toggle: async (path) => {
    const exp = new Set(get().expanded);
    if (exp.has(path)) exp.delete(path);
    else {
      exp.add(path);
      if (!get().childrenCache[path]) {
        try {
          const ch = await ipc.readWorkspaceTree(path);
          set((s) => ({ childrenCache: { ...s.childrenCache, [path]: ch } }));
        } catch (e) {
          console.warn(e);
        }
      }
    }
    set({ expanded: exp });
  },
  refresh: async () => {
    const r = get().root;
    if (!r) return;
    const entries = await ipc.readWorkspaceTree(r);
    set({ entries, childrenCache: {} });
  },
  refreshDir: async (path) => {
    const r = get().root;
    if (!r) return;
    if (path === r) {
      const entries = await ipc.readWorkspaceTree(r);
      set({ entries });
      return;
    }
    try {
      const ch = await ipc.readWorkspaceTree(path);
      set((s) => ({ childrenCache: { ...s.childrenCache, [path]: ch } }));
    } catch (e) {
      console.warn(e);
    }
  },
  requestCreate: (kind, parentDir) => {
    const r = get().root;
    if (!r) return;
    const target = parentDir ?? r;
    set({
      pendingCreate: {
        parentDir: target,
        kind,
        nonce: Date.now(),
      },
    });
  },
  clearPendingCreate: () => set({ pendingCreate: null }),
  collapseAll: () => set({ expanded: new Set<string>() }),
  expandTo: async (path) => {
    const r = get().root;
    if (!r || !path.startsWith(r)) return;
    const rel = path.slice(r.length).split(/[\\/]+/).filter(Boolean);
    let cursor = r;
    const exp = new Set(get().expanded);
    for (let i = 0; i < rel.length - 1; i++) {
      cursor = cursor + "/" + rel[i];
      exp.add(cursor);
      if (!get().childrenCache[cursor]) {
        try {
          const ch = await ipc.readWorkspaceTree(cursor);
          set((s) => ({ childrenCache: { ...s.childrenCache, [cursor]: ch } }));
        } catch {
          /* ignore */
        }
      }
    }
    set({ expanded: exp });
  },
}));
