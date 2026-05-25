import { create } from "zustand";
import {
  ipc,
  type McpConfig,
  type McpServerConfig,
  type McpServerSnapshot,
  type McpTool,
} from "@/lib/ipc";

/**
 * MCP (Model Context Protocol) store.
 *
 * Owns the rendered state of the user's configured MCP servers, plus
 * lightly-cached tool lists and stderr logs. Real I/O happens in the
 * Tauri backend — this store is mostly a thin shim that pulls and
 * normalizes snapshots.
 *
 * Why a dedicated store: server status is needed in several disjoint
 * surfaces (AIPanel settings card, agent harness preview, chat
 * composer "@mcp" picker). Routing them all through Zustand keeps
 * Tauri IPC traffic to a single periodic refresh.
 */

type State = {
  servers: McpServerSnapshot[];
  tools: Record<string, McpTool[]>;
  logs: Record<string, string[]>;
  /** True while the next periodic refresh is in flight. */
  refreshing: boolean;
  /** Last error from any IPC call. UI surfaces it as a non-blocking toast/inline. */
  lastError: string | null;

  refresh: () => Promise<void>;
  loadConfig: () => Promise<McpConfig>;
  saveServer: (name: string, config: McpServerConfig) => Promise<void>;
  removeServer: (name: string) => Promise<void>;
  start: (name: string) => Promise<void>;
  stop: (name: string) => Promise<void>;
  restart: (name: string) => Promise<void>;
  refreshTools: (name: string) => Promise<void>;
  refreshLogs: (name: string) => Promise<void>;
};

export const useMcp = create<State>((set, get) => ({
  servers: [],
  tools: {},
  logs: {},
  refreshing: false,
  lastError: null,

  refresh: async () => {
    if (get().refreshing) return;
    set({ refreshing: true });
    try {
      const servers = await ipc.mcpListServers();
      set({ servers, lastError: null });
    } catch (e) {
      set({ lastError: String(e) });
    } finally {
      set({ refreshing: false });
    }
  },

  loadConfig: async () => {
    try {
      const cfg = await ipc.mcpLoadConfig();
      // Loading config syncs the server set on the backend; pull the new
      // snapshot in too so the UI matches what the backend just adopted.
      await get().refresh();
      return cfg;
    } catch (e) {
      set({ lastError: String(e) });
      throw e;
    }
  },

  saveServer: async (name, config) => {
    try {
      await ipc.mcpUpsertServer(name, config);
      await get().refresh();
    } catch (e) {
      set({ lastError: String(e) });
      throw e;
    }
  },

  removeServer: async (name) => {
    try {
      await ipc.mcpRemoveServer(name);
      set((s) => {
        const nextTools = { ...s.tools };
        const nextLogs = { ...s.logs };
        delete nextTools[name];
        delete nextLogs[name];
        return { tools: nextTools, logs: nextLogs };
      });
      await get().refresh();
    } catch (e) {
      set({ lastError: String(e) });
      throw e;
    }
  },

  start: async (name) => {
    try {
      const snap = await ipc.mcpStartServer(name);
      set((s) => ({
        servers: upsertSnapshot(s.servers, snap),
        lastError: null,
      }));
      // Prefetch tools — the user almost always wants to see them next.
      await get().refreshTools(name);
    } catch (e) {
      // Pull the fresh snapshot *first* — that's where the backend's
      // own captured error string lives. Then re-stamp `lastError` with
      // ours so the IPC failure isn't overwritten by refresh's
      // happy-path `lastError: null`.
      await get().refresh();
      set({ lastError: String(e) });
      throw e;
    }
  },

  stop: async (name) => {
    try {
      await ipc.mcpStopServer(name);
      await get().refresh();
    } catch (e) {
      set({ lastError: String(e) });
      throw e;
    }
  },

  restart: async (name) => {
    try {
      const snap = await ipc.mcpRestartServer(name);
      set((s) => ({
        servers: upsertSnapshot(s.servers, snap),
        lastError: null,
      }));
      await get().refreshTools(name);
    } catch (e) {
      await get().refresh();
      set({ lastError: String(e) });
      throw e;
    }
  },

  refreshTools: async (name) => {
    try {
      const tools = await ipc.mcpListTools(name);
      set((s) => ({ tools: { ...s.tools, [name]: tools } }));
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  refreshLogs: async (name) => {
    try {
      const lines = await ipc.mcpGetLogs(name);
      set((s) => ({ logs: { ...s.logs, [name]: lines } }));
    } catch (e) {
      set({ lastError: String(e) });
    }
  },
}));

/** Replace any existing entry with the same name, or append. Stable order. */
function upsertSnapshot(
  servers: McpServerSnapshot[],
  next: McpServerSnapshot,
): McpServerSnapshot[] {
  const i = servers.findIndex((s) => s.name === next.name);
  if (i === -1) return [...servers, next].sort((a, b) => a.name.localeCompare(b.name));
  const copy = servers.slice();
  copy[i] = next;
  return copy;
}

// ---------------------------------------------------------------------------
// Selectors — exposed for tests + for the chat composer "@mcp" picker.
// ---------------------------------------------------------------------------

/** Servers in the ready state. The agent only routes tool calls to these. */
export function readyServers(state: State): McpServerSnapshot[] {
  return state.servers.filter((s) => s.status === "ready");
}

/** A flat list of {server, tool} pairs from every ready server. */
export function allReadyTools(
  state: State,
): { server: string; tool: McpTool }[] {
  const out: { server: string; tool: McpTool }[] = [];
  for (const s of readyServers(state)) {
    for (const t of state.tools[s.name] ?? []) {
      out.push({ server: s.name, tool: t });
    }
  }
  return out;
}
