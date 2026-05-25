import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MCPPanel, parseArgs, parseEnv } from "./MCPPanel";
import { useMcp } from "@/store/mcp";
import { ipc, type McpServerSnapshot } from "@/lib/ipc";

vi.mock("@/lib/ipc", async () => ({
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
}));

/**
 * Configure default IPC mocks so calls from the MCPPanel mount effect
 * (loadConfig + refresh) don't blow up the test. `prefilledServers` is
 * passed through when set so we can assert against a known state.
 */
function withDefaultMocks(prefilledServers: McpServerSnapshot[] = []): void {
  vi.mocked(ipc.mcpLoadConfig).mockResolvedValue({ mcpServers: {} });
  vi.mocked(ipc.mcpListServers).mockResolvedValue(prefilledServers);
  vi.mocked(ipc.mcpUpsertServer).mockResolvedValue({ mcpServers: {} });
  vi.mocked(ipc.mcpRemoveServer).mockResolvedValue({ mcpServers: {} });
  vi.mocked(ipc.mcpStopServer).mockResolvedValue(undefined);
  vi.mocked(ipc.mcpListTools).mockResolvedValue([]);
  vi.mocked(ipc.mcpGetLogs).mockResolvedValue([]);
}

vi.mock("@/components/Toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/components/Confirm", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

const fs: McpServerSnapshot = {
  name: "fs",
  config: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    env: {},
    cwd: null,
    disabled: false,
  },
  status: "stopped",
  error: null,
  server_info: null,
  started_at_ms: null,
  tool_count: 0,
};

beforeEach(() => {
  useMcp.setState({
    servers: [],
    tools: {},
    logs: {},
    refreshing: false,
    lastError: null,
  });
  vi.clearAllMocks();
  withDefaultMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers — parsing user input from the Add-server form.
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("splits on whitespace", () => {
    expect(parseArgs("-y --foo bar")).toEqual(["-y", "--foo", "bar"]);
  });
  it("honors double-quoted spans", () => {
    expect(parseArgs('-y "@scope/pkg" "/path with space"')).toEqual([
      "-y",
      "@scope/pkg",
      "/path with space",
    ]);
  });
  it("honors single-quoted spans", () => {
    expect(parseArgs("'a b' c")).toEqual(["a b", "c"]);
  });
  it("returns empty array for empty string", () => {
    expect(parseArgs("")).toEqual([]);
  });
  it("collapses extra whitespace", () => {
    expect(parseArgs("  a   b ")).toEqual(["a", "b"]);
  });
  it("treats unterminated quote as 'rest is one token'", () => {
    expect(parseArgs('a "b c')).toEqual(["a", "b c"]);
  });
});

describe("parseEnv", () => {
  it("parses one entry per line", () => {
    expect(parseEnv("A=1\nB=2")).toEqual({ A: "1", B: "2" });
  });
  it("ignores blank lines and # comments", () => {
    expect(parseEnv("\n# top comment\nA=1\n#B=2\n")).toEqual({ A: "1" });
  });
  it("preserves '=' inside values", () => {
    expect(parseEnv("TOKEN=abc=def==")).toEqual({ TOKEN: "abc=def==" });
  });
  it("skips lines without '='", () => {
    expect(parseEnv("FOO\nBAR=baz")).toEqual({ BAR: "baz" });
  });
  it("trims whitespace around keys and values", () => {
    expect(parseEnv("  A  =   v  ")).toEqual({ A: "v" });
  });
  it("returns empty object for empty input", () => {
    expect(parseEnv("")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

describe("<MCPPanel>", () => {
  it("renders the empty state when no servers are configured", async () => {
    render(<MCPPanel />);
    expect(await screen.findByText(/No MCP servers configured/)).toBeInTheDocument();
  });

  it("renders a configured server with its status and command", async () => {
    withDefaultMocks([fs]);
    useMcp.setState({ servers: [fs] });
    render(<MCPPanel />);
    expect(await screen.findByText("fs")).toBeInTheDocument();
    expect(screen.getByText("stopped")).toBeInTheDocument();
    expect(
      screen.getByText(/npx -y @modelcontextprotocol\/server-filesystem/),
    ).toBeInTheDocument();
  });

  it("'ready' server shows a Stop button; 'stopped' shows Start", async () => {
    const ready = { ...fs, status: "ready" as const };
    withDefaultMocks([ready]);
    useMcp.setState({ servers: [ready] });
    render(<MCPPanel />);
    expect(await screen.findByRole("button", { name: /^Stop$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Start$/ })).not.toBeInTheDocument();
  });

  it("clicking Start invokes the IPC and updates the snapshot", async () => {
    const user = userEvent.setup();
    withDefaultMocks([fs]);
    useMcp.setState({ servers: [fs] });
    vi.mocked(ipc.mcpStartServer).mockResolvedValue({
      ...fs,
      status: "ready",
      tool_count: 2,
    });
    render(<MCPPanel />);
    // /^Start$/ — anchored so the "Restart" button doesn't match.
    await user.click(await screen.findByRole("button", { name: /^Start$/ }));
    expect(ipc.mcpStartServer).toHaveBeenCalledWith("fs");
  });

  it("expanding a row fetches tools and logs", async () => {
    const user = userEvent.setup();
    const ready = { ...fs, status: "ready" as const, tool_count: 1 };
    withDefaultMocks([ready]);
    useMcp.setState({ servers: [ready] });
    vi.mocked(ipc.mcpListTools).mockResolvedValue([
      {
        name: "search",
        description: "search the codebase",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "what to search" } },
          required: ["query"],
        },
      },
    ]);
    vi.mocked(ipc.mcpGetLogs).mockResolvedValue(["booted", "ready"]);
    render(<MCPPanel />);
    // First chevron expands the row.
    const expandBtn = await screen.findByRole("button", { name: /^Expand$/ });
    await user.click(expandBtn);
    expect(await screen.findByText("search")).toBeInTheDocument();
    expect(screen.getByText("search the codebase")).toBeInTheDocument();
    // Logs show up too.
    expect(screen.getByText(/booted/)).toBeInTheDocument();
  });

  it("Add server form: name validation rejects spaces", async () => {
    const user = userEvent.setup();
    render(<MCPPanel />);
    await user.click(screen.getByRole("button", { name: /Add server/ }));
    const form = await screen.findByRole("form", { name: /Add MCP server/i });
    const name = within(form).getByLabelText("Server name");
    await user.type(name, "bad name");
    expect(
      within(form).getByText(/Use letters, numbers, dots, dashes/),
    ).toBeInTheDocument();
    // Submit is disabled.
    const submit = within(form).getByRole("button", { name: /Add server/ });
    expect(submit).toBeDisabled();
  });

  it("Add server form: submits a valid config to the IPC", async () => {
    const user = userEvent.setup();
    render(<MCPPanel />);
    await user.click(screen.getByRole("button", { name: /Add server/ }));
    const form = await screen.findByRole("form", { name: /Add MCP server/i });
    await user.type(within(form).getByLabelText("Server name"), "fs");
    await user.type(within(form).getByLabelText("Command"), "npx");
    await user.type(
      within(form).getByLabelText("Arguments"),
      '-y @modelcontextprotocol/server-filesystem "/tmp/x"',
    );
    await user.type(within(form).getByLabelText("Environment variables"), "FOO=bar");
    await user.click(within(form).getByRole("button", { name: /Add server/ }));
    expect(ipc.mcpUpsertServer).toHaveBeenCalledWith("fs", {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/x"],
      env: { FOO: "bar" },
      cwd: null,
      disabled: false,
    });
  });

  it("renders the last error banner when one is set", async () => {
    // The mount-time refresh would otherwise wipe lastError to null;
    // make it fail so the error stays put.
    vi.mocked(ipc.mcpListServers).mockRejectedValue(new Error("config parse failed"));
    render(<MCPPanel />);
    expect(await screen.findByText(/config parse failed/)).toBeInTheDocument();
  });

  it("shows a per-server error inline when the snapshot has one", async () => {
    const errored = {
      ...fs,
      status: "error" as const,
      error: "spawn ENOENT",
    };
    withDefaultMocks([errored]);
    useMcp.setState({ servers: [errored] });
    render(<MCPPanel />);
    expect(await screen.findByText(/spawn ENOENT/)).toBeInTheDocument();
  });
});
