/**
 * Recently-edited files store.
 *
 * The autocomplete (FIM) context builder uses this to pick the
 * smartest cross-file reference snippets to attach to a completion
 * prompt. The intuition is simple: if you just edited
 * `src/utils/format.ts` and now you're writing in `src/index.ts`,
 * the model will produce dramatically better completions if it
 * knows what `format.ts` looks like — because that's what's most
 * likely on the user's mind too.
 *
 * Why a tiny in-memory LRU instead of pulling from `useEditorStore`
 * directly?
 *
 *   • Editor tabs come and go — closing a file shouldn't make us
 *     forget it for completions.
 *   • We want a *snippet* (the head of the file), not the full
 *     content. Truncating once on insert is cheaper than truncating
 *     every read.
 *   • We want time-ordered recency, separate from tab order.
 *
 * The store is intentionally simple and synchronous — every keystroke
 * may consult it, so we don't want async IO in the hot path.
 */

import { create } from "zustand";

export type RecentEntry = {
  path: string;
  content: string;
  /** When the entry was last refreshed — millis since epoch. */
  touched: number;
};

type State = {
  entries: RecentEntry[];
  /** Maximum entries retained. */
  cap: number;
  /** Maximum characters of each snippet (head of file). The intuition
   *  is that the top of the file (imports, types, public API) is the
   *  most reusable for completion; the tail is implementation
   *  detail. */
  snippetChars: number;
  /** Record an edit. Idempotent — calling note() with the same path
   *  multiple times just moves it to the front and refreshes its
   *  snippet. */
  note: (path: string, content: string) => void;
  /** Snapshot the most-recent N entries, excluding `excludePath`. */
  selectRecent: (excludePath: string, limit?: number) => RecentEntry[];
  /** Wipe — used by tests and the "reset app" flow. */
  reset: () => void;
};

const DEFAULT_CAP = 8;
const DEFAULT_SNIPPET_CHARS = 1500;

export const useRecentEdits = create<State>((set, get) => ({
  entries: [],
  cap: DEFAULT_CAP,
  snippetChars: DEFAULT_SNIPPET_CHARS,
  note: (path, content) => {
    if (!path) return;
    const cap = get().cap;
    const max = get().snippetChars;
    set((s) => {
      const next: RecentEntry = {
        path,
        // Take the *head* of the file. The head holds imports, types,
        // exported names — the things completions are most likely to
        // riff on. The tail tends to be implementation detail.
        content: content.slice(0, max),
        touched: Date.now(),
      };
      const without = s.entries.filter((e) => e.path !== path);
      return { entries: [next, ...without].slice(0, cap) };
    });
  },
  selectRecent: (excludePath, limit = 5) => {
    return get()
      .entries.filter((e) => e.path !== excludePath)
      .slice(0, limit);
  },
  reset: () => set({ entries: [] }),
}));
