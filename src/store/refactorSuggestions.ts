/**
 * Active refactor suggestion store.
 *
 * When the rename observer notices a clean single-identifier rename
 * and the searcher confirms other files still reference the old
 * name, we present a small floating card: "Renamed X → Y here.
 * Apply across N files?". Only one suggestion is shown at a time;
 * a dismissal sticks for the session so the user isn't re-prompted.
 */

import { create } from "@/lib/signalStore";
import type { TextHit } from "@/lib/ipc";

export type ActiveRenameSuggestion = {
  oldName: string;
  newName: string;
  /** Path of the file where the user did the rename — we exclude
   *  this from the "apply elsewhere" set. */
  sourcePath: string;
  /** All cross-file hits of the old name. The UI shows the count;
   *  the apply path uses these to compose the edit. */
  hits: TextHit[];
};

type State = {
  active: ActiveRenameSuggestion | null;
  /** Pairs the user dismissed in this session, formatted as
   *  `${old}→${new}`. */
  dismissed: Set<string>;
  propose: (s: ActiveRenameSuggestion) => void;
  dismiss: () => void;
  markApplied: () => void;
};

export const useRefactorSuggestions = create<State>((set, get) => ({
  active: null,
  dismissed: new Set<string>(),
  propose: (s) => {
    const key = `${s.oldName}→${s.newName}`;
    if (get().dismissed.has(key)) return;
    set({ active: s });
  },
  dismiss: () =>
    set((st) => {
      if (!st.active) return st;
      const key = `${st.active.oldName}→${st.active.newName}`;
      const next = new Set(st.dismissed);
      next.add(key);
      return { active: null, dismissed: next };
    }),
  markApplied: () => set({ active: null }),
}));
