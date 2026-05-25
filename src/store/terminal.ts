/**
 * Terminal panel store.
 *
 * Holds the *metadata* for every open terminal — the actual xterm.js
 * instance lives inside the `TerminalView` component because xterm.js is
 * imperative and React's render cycle doesn't play nicely with its
 * mutable Buffer state.
 *
 * Why a store at all? Two reasons:
 *  1. We want a single source of truth for "which tab is active" so the
 *     status bar / titlebar can show the active shell name.
 *  2. Terminals survive panel close: collapsing the bottom dock should
 *     *not* kill the running shell. Storing the open-tab list at the App
 *     level lets us hide the view without unmounting the xterm instance.
 */

import { create } from "zustand";

export type TerminalTab = {
  id: string;
  /** Shell binary basename returned by the backend ("zsh", "powershell"). */
  shell: string;
  /** User-editable label. Defaults to the shell name + an ordinal. */
  title: string;
  /** Working directory used to spawn. Persisted so reopen-after-crash can
   *  restart in the same dir if we ever add session restore. */
  cwd: string;
  /** True once the child has exited. The xterm view stays visible so the
   *  user can read the last output, but writes are dropped. */
  exited: boolean;
  /** Exit code when known (null = still running or killed). */
  exitCode: number | null;
};

type State = {
  tabs: TerminalTab[];
  activeId: string | null;
  /** When true, the bottom panel is rendered. Closing the panel does not
   *  close terminals — they keep running until explicitly closed. */
  open: boolean;
  setOpen: (v: boolean) => void;
  toggleOpen: () => void;
  setActive: (id: string) => void;
  add: (t: TerminalTab) => void;
  remove: (id: string) => void;
  markExited: (id: string, code: number | null) => void;
  rename: (id: string, title: string) => void;
};

export const useTerminals = create<State>((set, get) => ({
  tabs: [],
  activeId: null,
  open: false,
  setOpen: (v) => set({ open: v }),
  toggleOpen: () => set((s) => ({ open: !s.open })),
  setActive: (id) => {
    if (get().tabs.some((t) => t.id === id)) set({ activeId: id });
  },
  add: (t) =>
    set((s) => ({
      tabs: [...s.tabs, t],
      activeId: t.id,
      open: true,
    })),
  remove: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeId =
        s.activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeId;
      return { tabs, activeId };
    }),
  markExited: (id, code) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, exited: true, exitCode: code } : t,
      ),
    })),
  rename: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),
}));

/**
 * Helper used by the panel UI to derive a fresh tab id and default title.
 * Lives here so the format ("Terminal 1", "Terminal 2") is consistent
 * regardless of which call site spawns a shell.
 *
 * The ordinal advances monotonically across the session — i.e. closing
 * "Terminal 2" and then opening another gives you "Terminal 3", not a
 * reused "Terminal 2". This matches iTerm2 / VS Code behaviour and is
 * also load-bearing defensively: if two callers synchronously invoke
 * `nextTerminalTitle()` before either `ipc.terminalOpen` resolves and
 * `add()` updates the store (the exact race that produced two
 * "Terminal 1" tabs when the native menu accelerator and a duplicate
 * JS keydown handler both fired for ⌘`), each still receives a
 * distinct ordinal.
 */
let terminalOrdinal = 0;
export function nextTerminalTitle(): { id: string; title: string } {
  // Seed the counter from any titles we've already issued in this
  // session (e.g. on hot reload). After the seed, the counter is the
  // single source of truth — we never derive the next ordinal from
  // current `tabs.length`, because that's racy with in-flight opens.
  const tabs = useTerminals.getState().tabs;
  for (const t of tabs) {
    const m = /^Terminal (\d+)$/.exec(t.title);
    if (m) terminalOrdinal = Math.max(terminalOrdinal, Number(m[1]));
  }
  terminalOrdinal += 1;
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, title: `Terminal ${terminalOrdinal}` };
}

/** Test-only: reset the monotonic counter between tests. */
export function __resetTerminalOrdinalForTests(): void {
  terminalOrdinal = 0;
}
