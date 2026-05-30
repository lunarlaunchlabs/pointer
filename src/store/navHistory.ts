import { create } from "@/lib/signalStore";

/**
 * Editor navigation history — the "back" / "forward" arrows users
 * expect from any IDE. Every time the editor's cursor jumps to a
 * "significant" position (different file, or > 10 lines from the
 * previous entry) we push a new entry on the stack. Back/forward
 * walk the stack without modifying it; a new jump after going back
 * truncates the forward arm (browser-style).
 *
 * The stack is intentionally small (capped at 100) — what users
 * actually need is roughly the last 20 jumps, anything older they'd
 * use Quick Open / Outline for.
 */
export type NavEntry = {
  path: string;
  line: number;
  column: number;
};

type State = {
  stack: NavEntry[];
  index: number;
  /** Push a new location. Coalesces with the previous entry if it's
   *  the same file within `MIN_JUMP_LINES` lines — avoids
   *  stuffing the history with tiny cursor movements. */
  push: (entry: NavEntry) => void;
  back: () => NavEntry | null;
  forward: () => NavEntry | null;
  canBack: () => boolean;
  canForward: () => boolean;
};

const MAX = 100;
const MIN_JUMP_LINES = 10;

export const useNavHistory = create<State>((set, get) => ({
  stack: [],
  index: -1,
  push: (entry) => {
    const { stack, index } = get();
    const prev = stack[index];
    if (
      prev &&
      prev.path === entry.path &&
      Math.abs(prev.line - entry.line) < MIN_JUMP_LINES
    ) {
      // Coalesce — update the current entry's column so back/forward
      // returns to the most recent within-symbol position.
      const nextStack = stack.slice(0, index + 1);
      nextStack[index] = { ...prev, line: entry.line, column: entry.column };
      set({ stack: nextStack });
      return;
    }
    // Truncate forward history before appending (browser-back-button
    // semantics).
    const truncated = stack.slice(0, index + 1);
    truncated.push(entry);
    if (truncated.length > MAX) truncated.shift();
    set({ stack: truncated, index: truncated.length - 1 });
  },
  back: () => {
    const { stack, index } = get();
    if (index <= 0) return null;
    const next = index - 1;
    set({ index: next });
    return stack[next];
  },
  forward: () => {
    const { stack, index } = get();
    if (index >= stack.length - 1) return null;
    const next = index + 1;
    set({ index: next });
    return stack[next];
  },
  canBack: () => get().index > 0,
  canForward: () => get().index < get().stack.length - 1,
}));
