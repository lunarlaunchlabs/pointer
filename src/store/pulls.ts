import { create } from "@/lib/signalStore";
import { ipc, listenEvent, newRequestId } from "@/lib/ipc";

/**
 * Active model-pull tracker.
 *
 * Pulls are long-running streams. If the user starts one in the AI panel and
 * then switches to chat or closes the dock, the in-component state previously
 * tracking the pull is unmounted — and they lose the progress bar entirely
 * even though the daemon keeps downloading. This store moves that state into
 * a single, app-wide source of truth so:
 *   - the same pull is visible from any view (AI panel, status bar, etc.);
 *   - reopening the panel mid-pull shows the live progress;
 *   - errors and completion update everywhere atomically.
 */

export type PullState = {
  model: string;
  rid: string;
  pct: number;
  status: string;
  error: string | null;
  startedAt: number;
};

type PullsState = {
  /** Keyed by model name so a model can only have one active pull. */
  active: Record<string, PullState>;
  /** Start a pull. Returns the request id (the same that the daemon uses). */
  start: (model: string) => Promise<string>;
  /** Cancel a pull that's currently running. */
  cancel: (model: string) => Promise<void>;
  /** Clear the error chip after the user acknowledges it. */
  clearError: (model: string) => void;
};

export const usePulls = create<PullsState>((set, get) => ({
  active: {},
  start: async (model: string) => {
    const existing = get().active[model];
    if (existing && !existing.error) return existing.rid;
    const rid = newRequestId("pull");
    set((s) => ({
      active: {
        ...s.active,
        [model]: {
          model,
          rid,
          pct: 0,
          status: "starting",
          error: null,
          startedAt: Date.now(),
        },
      },
    }));
    // Subscribe to the daemon's progress stream. We keep the unlisten handle
    // in a closure (rather than on the store) because it's transient and
    // would never be useful to render.
    const off = await listenEvent<{
      status?: string;
      completed?: number;
      total?: number;
      error?: string;
    }>(`ollama:pull:${rid}`, (p) => {
      set((s) => {
        const cur = s.active[model];
        if (!cur || cur.rid !== rid) return s;
        if (p.error) {
          return {
            active: {
              ...s.active,
              [model]: { ...cur, error: p.error, status: "error" },
            },
          };
        }
        const pct =
          p.total && p.completed
            ? Math.round((p.completed / p.total) * 100)
            : cur.pct;
        const next = { ...cur, pct, status: p.status ?? cur.status };
        if (p.status === "done") {
          // Pop the model out of the active set — completion is implied by
          // absence, which keeps render logic dead simple.
          const { [model]: _gone, ...rest } = s.active;
          off();
          return { active: rest };
        }
        return { active: { ...s.active, [model]: next } };
      });
    });
    try {
      await ipc.ollamaPull(model, rid);
    } catch (e) {
      off();
      set((s) => {
        const cur = s.active[model];
        if (!cur || cur.rid !== rid) return s;
        return {
          active: {
            ...s.active,
            [model]: { ...cur, error: String(e), status: "error" },
          },
        };
      });
    }
    return rid;
  },
  cancel: async (model: string) => {
    const cur = get().active[model];
    if (!cur) return;
    try {
      await ipc.ollamaCancel(cur.rid);
    } catch {
      /* daemon may already be done */
    }
    set((s) => {
      const { [model]: _gone, ...rest } = s.active;
      return { active: rest };
    });
  },
  clearError: (model: string) => {
    set((s) => {
      const cur = s.active[model];
      if (!cur || !cur.error) return s;
      const { [model]: _gone, ...rest } = s.active;
      return { active: rest };
    });
  },
}));
