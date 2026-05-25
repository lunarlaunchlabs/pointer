import { create } from "zustand";
import { getItem, persistAsync } from "@/lib/persist";

const KEY = "searchHistory.v1";

/**
 * Recent search query history, used by the Find File picker and the
 * workspace-wide Find in Files panel. Each surface gets its own
 * stack so a fuzzy filename search doesn't show up next to a regex
 * grep query — they're different mental contexts.
 *
 * Keeps the most recent 30 entries per stack, deduped. Stored via
 * the same Tauri Store the rest of the session uses, so it survives
 * reloads without polluting localStorage.
 */
export type SearchScope = "finder" | "findInFiles";

type State = {
  hydrated: boolean;
  finder: string[];
  findInFiles: string[];
  init: () => Promise<void>;
  push: (scope: SearchScope, query: string) => void;
  clear: (scope: SearchScope) => void;
};

const MAX = 30;

export const useSearchHistory = create<State>((set, get) => ({
  hydrated: false,
  finder: [],
  findInFiles: [],
  init: async () => {
    if (get().hydrated) return;
    try {
      const raw = await getItem<{ finder?: string[]; findInFiles?: string[] }>(KEY);
      if (raw) {
        set({
          hydrated: true,
          finder: Array.isArray(raw.finder) ? raw.finder : [],
          findInFiles: Array.isArray(raw.findInFiles) ? raw.findInFiles : [],
        });
        return;
      }
    } catch {
      /* fall through to empty state */
    }
    set({ hydrated: true });
  },
  push: (scope, query) => {
    const q = query.trim();
    if (q.length < 2) return; // junk noise filter
    const cur = get()[scope];
    const next = [q, ...cur.filter((x) => x !== q)].slice(0, MAX);
    set({ [scope]: next } as Partial<State>);
    persistAsync(KEY, {
      finder: scope === "finder" ? next : get().finder,
      findInFiles: scope === "findInFiles" ? next : get().findInFiles,
    });
  },
  clear: (scope) => {
    set({ [scope]: [] } as Partial<State>);
    persistAsync(KEY, {
      finder: scope === "finder" ? [] : get().finder,
      findInFiles: scope === "findInFiles" ? [] : get().findInFiles,
    });
  },
}));
