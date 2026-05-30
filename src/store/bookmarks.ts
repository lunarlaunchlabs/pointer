import { create } from "@/lib/signalStore";
import { getItem, persistAsync } from "@/lib/persist";

/**
 * Bookmark — a named position inside a file the user wants to jump
 * back to. Modeled after the VS Code "Bookmarks" extension because
 * it's the dominant mental model; we keep the surface deliberately
 * tight: one bookmark per (file, line), no labels (the source line
 * is the label), no "groups" (bookmarks are global to the
 * workspace).
 *
 * Persisted under a single key — bookmarks are session-spanning by
 * design; users expect them to survive a reload.
 */
export type Bookmark = {
  path: string;
  line: number;
  /** Snapshot of the line content at bookmark time. Useful for the
   *  picker when files have drifted (deleted/renamed/etc.). */
  preview: string;
  /** Epoch ms the bookmark was placed — drives "most recent" sort
   *  fallback when ordering otherwise ties. */
  ts: number;
};

const KEY = "bookmarks.v1";

type State = {
  bookmarks: Bookmark[];
  hydrated: boolean;
  init: () => Promise<void>;
  /** Toggle a bookmark for the given file+line. Returns the new
   *  presence flag so callers can show a toast. */
  toggle: (b: Bookmark) => boolean;
  clearFile: (path: string) => void;
  clearAll: () => void;
  hasAt: (path: string, line: number) => boolean;
  /** All bookmarks for a single file, line-sorted. */
  forFile: (path: string) => Bookmark[];
};

export const useBookmarks = create<State>((set, get) => ({
  bookmarks: [],
  hydrated: false,
  init: async () => {
    try {
      const saved = await getItem<Bookmark[]>(KEY);
      set({ bookmarks: saved ?? [], hydrated: true });
    } catch {
      set({ bookmarks: [], hydrated: true });
    }
  },
  toggle: (b) => {
    const cur = get().bookmarks;
    const idx = cur.findIndex(
      (x) => x.path === b.path && x.line === b.line,
    );
    let next: Bookmark[];
    let present: boolean;
    if (idx >= 0) {
      next = cur.filter((_, i) => i !== idx);
      present = false;
    } else {
      next = [...cur, b];
      present = true;
    }
    set({ bookmarks: next });
    persistAsync(KEY, next);
    return present;
  },
  clearFile: (path) => {
    const next = get().bookmarks.filter((b) => b.path !== path);
    set({ bookmarks: next });
    persistAsync(KEY, next);
  },
  clearAll: () => {
    set({ bookmarks: [] });
    persistAsync(KEY, []);
  },
  hasAt: (path, line) =>
    get().bookmarks.some((b) => b.path === path && b.line === line),
  forFile: (path) =>
    get()
      .bookmarks.filter((b) => b.path === path)
      .sort((a, b) => a.line - b.line),
}));
