import { create } from "@/lib/signalStore";

/**
 * Multi-selection state for the file tree. Stores the set of
 * selected paths plus the "anchor" — the row Shift-click extends
 * from. Without an anchor, Shift-click degrades to a single-select.
 *
 * Kept in a tiny dedicated store rather than on the workspace store
 * because selection is transient (clears on workspace change, on
 * Esc, and after batch ops succeed) and we don't want to thread it
 * through every component that reads workspace state.
 */
type State = {
  selected: Set<string>;
  anchor: string | null;
  toggle: (path: string) => void;
  set: (paths: string[], anchor?: string | null) => void;
  /** Add the linear range between `anchor` and `path` (inclusive)
   *  given the visible order. Caller passes the ordered list so we
   *  don't need to know tree shape here. */
  range: (path: string, ordered: string[]) => void;
  clear: () => void;
  has: (path: string) => boolean;
};

export const useTreeSelection = create<State>((set, get) => ({
  selected: new Set(),
  anchor: null,
  toggle: (path) => {
    const cur = new Set(get().selected);
    if (cur.has(path)) cur.delete(path);
    else cur.add(path);
    set({ selected: cur, anchor: path });
  },
  set: (paths, anchor = null) =>
    set({ selected: new Set(paths), anchor: anchor ?? paths[0] ?? null }),
  range: (path, ordered) => {
    const { anchor } = get();
    if (!anchor) {
      set({ selected: new Set([path]), anchor: path });
      return;
    }
    const a = ordered.indexOf(anchor);
    const b = ordered.indexOf(path);
    if (a < 0 || b < 0) {
      set({ selected: new Set([path]), anchor: path });
      return;
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const next = new Set(get().selected);
    for (let i = lo; i <= hi; i++) next.add(ordered[i]);
    set({ selected: next });
  },
  clear: () => set({ selected: new Set(), anchor: null }),
  has: (path) => get().selected.has(path),
}));
