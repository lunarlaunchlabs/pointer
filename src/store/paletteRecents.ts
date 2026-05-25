import { create } from "zustand";
import { getItem, persistAsync } from "@/lib/persist";

/**
 * Persisted MRU list of command palette entries. Drives the
 * "Recently used" section at the top of the palette so power users
 * land on the same handful of commands they reach for daily without
 * hunting through the full catalog.
 *
 * Stored under a tiny array of `{ id, label, ts }` rather than a
 * map so iteration order and recency are trivial. Cap of 12 is the
 * roughly 1-screen worth at our palette typography.
 */
export type RecentCommand = {
  id: string;
  label: string;
  ts: number;
};

const KEY = "palette.recents.v1";
const MAX = 12;

type State = {
  recents: RecentCommand[];
  hydrated: boolean;
  init: () => Promise<void>;
  push: (item: { id: string; label: string }) => void;
  clear: () => void;
};

export const usePaletteRecents = create<State>((set, get) => ({
  recents: [],
  hydrated: false,
  init: async () => {
    if (get().hydrated) return;
    try {
      const saved = await getItem<RecentCommand[]>(KEY);
      set({ recents: saved ?? [], hydrated: true });
    } catch {
      set({ recents: [], hydrated: true });
    }
  },
  push: (item) => {
    const ts = Date.now();
    // Dedup by id — moving the matching entry to the top keeps the
    // list stable when the user repeats themselves.
    const next: RecentCommand[] = [
      { id: item.id, label: item.label, ts },
      ...get().recents.filter((r) => r.id !== item.id),
    ].slice(0, MAX);
    set({ recents: next });
    persistAsync(KEY, next);
  },
  clear: () => {
    set({ recents: [] });
    persistAsync(KEY, []);
  },
}));
