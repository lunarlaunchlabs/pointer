import { create } from "zustand";

/**
 * Active diff viewer state — when set, the editor area shows a Monaco
 * `DiffEditor` instead of the regular code editor. Opened by the
 * Source Control panel (click a file row), Git log (compare commits),
 * or the agent (proposed change preview, future use).
 *
 * Keeping this in a tiny dedicated store avoids muddying the Tab type
 * (every tab is a real file you can edit) with a "this isn't really
 * a file" carve-out. Closing the diff returns the user to whatever
 * tab they had open before.
 */
export type DiffSource = "head" | "staged" | "literal";

export type DiffSpec = {
  /** Logical title shown in the diff toolbar — "src/foo.ts (HEAD ↔ working)" etc. */
  title: string;
  /** Language id for syntax highlighting; defaults to plaintext. */
  language: string;
  /** Left side (original) content. */
  original: string;
  /** Right side (modified) content. */
  modified: string;
  /** Whether either side is editable in the diff view. We currently
   *  render read-only diffs for git; reserved for future inline-edit. */
  readOnly: boolean;
  /** Optional path so the toolbar can offer "Open file". */
  path?: string;
  /** Where the original came from — used in the toolbar copy. */
  source?: DiffSource;
};

type State = {
  spec: DiffSpec | null;
  show: (spec: DiffSpec) => void;
  close: () => void;
};

export const useDiffViewer = create<State>((set) => ({
  spec: null,
  show: (spec) => set({ spec }),
  close: () => set({ spec: null }),
}));
