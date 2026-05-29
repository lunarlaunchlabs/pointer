import { create } from "zustand";
import { getItem, persistAsync } from "@/lib/persist";

export type Breakpoint = {
  id: string;
  path: string;
  line: number;
  column?: number;
  enabled: boolean;
  condition?: string;
  logMessage?: string;
  createdAt: number;
};

export type DebugValue = {
  id: string;
  name: string;
  value: string;
  type?: string;
  path?: string;
  line?: number;
  scope?: string;
  frame?: string;
  thread?: string;
  createdAt: number;
};

type State = {
  hydrated: boolean;
  breakpoints: Breakpoint[];
  values: DebugValue[];
  init: () => Promise<void>;
  toggleBreakpoint: (path: string, line: number, column?: number) => void;
  addBreakpoint: (bp: Omit<Breakpoint, "id" | "createdAt">) => string;
  removeBreakpoint: (id: string) => void;
  updateBreakpoint: (id: string, patch: Partial<Pick<Breakpoint, "enabled" | "condition" | "logMessage">>) => void;
  breakpointsForPath: (path: string) => Breakpoint[];
  addDebugValue: (value: Omit<DebugValue, "id" | "createdAt">) => string;
  removeDebugValue: (id: string) => void;
  clearDebugValues: () => void;
};

const BREAKPOINTS_KEY = "debug.breakpoints.v1";
const VALUES_KEY = "debug.values.v1";
const VALUE_LIMIT = 80;

export const useDebuggerStore = create<State>((set, get) => ({
  hydrated: false,
  breakpoints: [],
  values: [],

  init: async () => {
    const [breakpoints, values] = await Promise.all([
      getItem<Breakpoint[]>(BREAKPOINTS_KEY).catch(() => undefined),
      getItem<DebugValue[]>(VALUES_KEY).catch(() => undefined),
    ]);
    set({
      breakpoints: sanitizeBreakpoints(breakpoints ?? []),
      values: sanitizeValues(values ?? []),
      hydrated: true,
    });
  },

  toggleBreakpoint: (path, line, column) => {
    const existing = get().breakpoints.find(
      (bp) => bp.path === path && bp.line === line,
    );
    if (existing) {
      set((s) => ({
        breakpoints: s.breakpoints.filter((bp) => bp.id !== existing.id),
      }));
    } else {
      const now = Date.now();
      set((s) => ({
        breakpoints: [
          ...s.breakpoints,
          {
            id: `bp_${crypto.randomUUID().slice(0, 12)}`,
            path,
            line,
            column,
            enabled: true,
            createdAt: now,
          },
        ],
      }));
    }
    flush(get());
  },

  addBreakpoint: (bp) => {
    const id = `bp_${crypto.randomUUID().slice(0, 12)}`;
    set((s) => ({
      breakpoints: [
        ...s.breakpoints.filter((x) => !(x.path === bp.path && x.line === bp.line)),
        { ...bp, id, createdAt: Date.now() },
      ],
    }));
    flush(get());
    return id;
  },

  removeBreakpoint: (id) => {
    set((s) => ({ breakpoints: s.breakpoints.filter((bp) => bp.id !== id) }));
    flush(get());
  },

  updateBreakpoint: (id, patch) => {
    set((s) => ({
      breakpoints: s.breakpoints.map((bp) =>
        bp.id === id ? { ...bp, ...patch } : bp,
      ),
    }));
    flush(get());
  },

  breakpointsForPath: (path) =>
    get()
      .breakpoints.filter((bp) => bp.path === path)
      .sort((a, b) => a.line - b.line),

  addDebugValue: (value) => {
    const id = `dbg_${crypto.randomUUID().slice(0, 12)}`;
    set((s) => ({
      values: [{ ...value, id, createdAt: Date.now() }, ...s.values].slice(
        0,
        VALUE_LIMIT,
      ),
    }));
    flush(get());
    return id;
  },

  removeDebugValue: (id) => {
    set((s) => ({ values: s.values.filter((value) => value.id !== id) }));
    flush(get());
  },

  clearDebugValues: () => {
    set({ values: [] });
    flush(get());
  },
}));

function flush(state: State) {
  persistAsync(BREAKPOINTS_KEY, state.breakpoints);
  persistAsync(VALUES_KEY, state.values);
}

function sanitizeBreakpoints(items: Breakpoint[]): Breakpoint[] {
  return items
    .filter((bp) => bp.path && Number.isFinite(bp.line) && bp.line > 0)
    .map((bp) => ({ ...bp, enabled: bp.enabled !== false }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

function sanitizeValues(items: DebugValue[]): DebugValue[] {
  return items
    .filter((value) => value.name && typeof value.value === "string")
    .slice(0, VALUE_LIMIT);
}
