import { create } from "zustand";

/** Stores the file path the user marked via "Select for Compare". A
 *  second pick triggers the side-by-side diff and clears the slot.
 *  Persisted only in memory — losing it on reload mirrors the
 *  ephemeral nature of the gesture. */
type State = {
  selected: string | null;
  setSelected: (p: string | null) => void;
};

export const useCompareSelection = create<State>((set) => ({
  selected: null,
  setSelected: (p) => set({ selected: p }),
}));
