import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcp, readyServers, allReadyTools } from "./mcp";
import { ipc, type McpServerSnapshot, type McpTool } from "@/lib/ipc";

vi.mock("@/lib/ipc", async () => {
  return {
    ipc: {
      mcpListServers: vi.fn(),
      mcpLoadConfig: vi.fn(),
      mcpUpsertServer: vi.fn(),
      mcpRemoveServer: vi.fn(),
      mcpStartServer: vi.fn(),
      mcpStopServer: vi.fn(),
      mcpRestartServer: vi.fn(),
      mcpListTools: vi.fn(),
      mcpGetLogs: vi.fn(),
      mcpCallTool: vi.fn(),
    },
  };
});

const fs: McpServerSnapshot = {
  name: "fs",
  config: { command: "npx", args: ["-y", "fs"], env: {}, cwd: null, disabled: false },
  status: "stopped",
  error: null,
  server_info: null,
  started_at_ms: null,
  tool_count: 0,
};

const fsReady: McpServerSnapshot = { ...fs, status: "ready", tool_count: 2 };

const tools: McpTool[] = [
  { name: "read_file", description: "read", inputSchema: null },
  { name: "write_file", description: "write", inputSchema: null },
];

beforeEach(() => {
  // Reset Zustand store state between tests so they don't leak.
  useMcp.setState({
    servers: [],
    tools: {},
    logs: {},
    refreshing: false,
    lastError: null,
  });
  vi.clearAllMocks();
});

describe("useMcp store", () => {
  it("refresh pulls server snapshots from IPC", async () => {
    vi.mocked(ipc.mcpListServers).mockResolvedValue([fs]);
    await useMcp.getState().refresh();
    expect(useMcp.getState().servers).toEqual([fs]);
    expect(useMcp.getState().lastError).toBeNull();
  });

  it("refresh sets lastError on IPC failure", async () => {
    vi.mocked(ipc.mcpListServers).mockRejectedValue(new Error("boom"));
    await useMcp.getState().refresh();
    expect(useMcp.getState().lastError).toMatch(/boom/);
    expect(useMcp.getState().servers).toEqual([]);
  });

  it("refresh dedupes concurrent calls (only one IPC call runs at a time)", async () => {
    let resolveOuter: (v: McpServerSnapshot[]) => void = () => {};
    vi.mocked(ipc.mcpListServers).mockImplementationOnce(
      () =>
        new Promise<McpServerSnapshot[]>((res) => {
          resolveOuter = res;
        }),
    );
    const p1 = useMcp.getState().refresh();
    const p2 = useMcp.getState().refresh();
    resolveOuter([fs]);
    await Promise.all([p1, p2]);
    expect(ipc.mcpListServers).toHaveBeenCalledTimes(1);
  });

  it("start updates the snapshot in place and refreshes tools", async () => {
    vi.mocked(ipc.mcpStartServer).mockResolvedValue(fsReady);
    vi.mocked(ipc.mcpListTools).mockResolvedValue(tools);
    await useMcp.getState().start("fs");
    expect(useMcp.getState().servers).toContainEqual(fsReady);
    expect(useMcp.getState().tools.fs).toEqual(tools);
  });

  it("start surfaces error and re-pulls fresh snapshot on failure", async () => {
    vi.mocked(ipc.mcpStartServer).mockRejectedValue(new Error("spawn fail"));
    vi.mocked(ipc.mcpListServers).mockResolvedValue([fs]);
    await expect(useMcp.getState().start("fs")).rejects.toThrow();
    expect(useMcp.getState().lastError).toMatch(/spawn fail/);
    expect(useMcp.getState().servers).toEqual([fs]);
  });

  it("stop refreshes the snapshot afterwards", async () => {
    useMcp.setState({ servers: [fsReady] });
    vi.mocked(ipc.mcpStopServer).mockResolvedValue();
    vi.mocked(ipc.mcpListServers).mockResolvedValue([fs]);
    await useMcp.getState().stop("fs");
    expect(useMcp.getState().servers).toEqual([fs]);
  });

  it("removeServer wipes tools + logs for that server", async () => {
    useMcp.setState({
      servers: [fsReady],
      tools: { fs: tools },
      logs: { fs: ["line1"] },
    });
    vi.mocked(ipc.mcpRemoveServer).mockResolvedValue({ mcpServers: {} });
    vi.mocked(ipc.mcpListServers).mockResolvedValue([]);
    await useMcp.getState().removeServer("fs");
    expect(useMcp.getState().tools.fs).toBeUndefined();
    expect(useMcp.getState().logs.fs).toBeUndefined();
  });

  it("refreshTools caches the result keyed by server name", async () => {
    vi.mocked(ipc.mcpListTools).mockResolvedValue(tools);
    await useMcp.getState().refreshTools("fs");
    expect(useMcp.getState().tools.fs).toEqual(tools);
  });

  it("refreshLogs caches the result keyed by server name", async () => {
    vi.mocked(ipc.mcpGetLogs).mockResolvedValue(["[fs] booted"]);
    await useMcp.getState().refreshLogs("fs");
    expect(useMcp.getState().logs.fs).toEqual(["[fs] booted"]);
  });

  it("restart updates snapshot + tools", async () => {
    vi.mocked(ipc.mcpRestartServer).mockResolvedValue(fsReady);
    vi.mocked(ipc.mcpListTools).mockResolvedValue(tools);
    await useMcp.getState().restart("fs");
    expect(useMcp.getState().servers).toContainEqual(fsReady);
    expect(useMcp.getState().tools.fs).toEqual(tools);
  });

  it("saveServer routes through mcpUpsertServer + refresh", async () => {
    vi.mocked(ipc.mcpUpsertServer).mockResolvedValue({
      mcpServers: { fs: fs.config },
    });
    vi.mocked(ipc.mcpListServers).mockResolvedValue([fs]);
    await useMcp.getState().saveServer("fs", fs.config);
    expect(ipc.mcpUpsertServer).toHaveBeenCalledWith("fs", fs.config);
    expect(useMcp.getState().servers).toEqual([fs]);
  });
});

describe("selectors", () => {
  it("readyServers filters by status", () => {
    const state = {
      ...useMcp.getState(),
      servers: [fs, fsReady, { ...fs, name: "err", status: "error" as const }],
    };
    expect(readyServers(state).map((s) => s.name)).toEqual(["fs"]);
  });

  it("allReadyTools enumerates tools across every ready server", () => {
    const a = { ...fsReady, name: "a" };
    const b = { ...fsReady, name: "b" };
    const state = {
      ...useMcp.getState(),
      servers: [a, b, { ...fs, name: "off" }],
      tools: {
        a: [tools[0]],
        b: [tools[1]],
        off: [tools[0]], // should be ignored — server isn't ready
      },
    };
    const flat = allReadyTools(state);
    expect(flat).toEqual([
      { server: "a", tool: tools[0] },
      { server: "b", tool: tools[1] },
    ]);
  });
});
