import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Play,
  Plug,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useMcp } from "@/store/mcp";
import type { McpServerConfig, McpServerSnapshot, McpTool } from "@/lib/ipc";
import { confirm } from "@/components/Confirm";
import { toast } from "@/components/Toast";

/**
 * MCP control surface.
 *
 * Lives inside the AI control panel as a `Section` body. Three columns of
 * affordances:
 *   1. Server list — name, status pill, tools-count, start/stop/restart,
 *      remove, expand to show stderr logs.
 *   2. Add-server form — name + command + args + env, validated client-side
 *      before we round-trip to the backend.
 *   3. Tool browser — when a server is expanded, list its tools with their
 *      JSON-schema fields so the user can verify what the agent will see.
 *
 * We refresh on mount + every 5s while the user has the panel open. The
 * pollers stop when the component unmounts so the AIPanel doesn't keep
 * polling forever.
 */
export function MCPPanel() {
  const servers = useMcp((s) => s.servers);
  const lastError = useMcp((s) => s.lastError);
  const refresh = useMcp((s) => s.refresh);
  const loadConfig = useMcp((s) => s.loadConfig);

  const [showAdd, setShowAdd] = useState(false);

  // Initial load + polling. Polls are cheap (a single Tauri call returning
  // a small snapshot array) so 5s is comfortable.
  useEffect(() => {
    loadConfig().catch(() => {});
    const id = setInterval(() => {
      refresh();
    }, 5000);
    return () => clearInterval(id);
  }, [refresh, loadConfig]);

  return (
    <div className="space-y-2 font-sans">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-noir-mute leading-tight">
          Servers from <code className="px-1 text-noir-subtext">mcp.json</code>{" "}
          run as local subprocesses. Their tools show up to the agent as{" "}
          <code className="px-1 text-noir-subtext">mcp_call</code> blocks.
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => refresh()}
            className="pn-button font-sans text-[10.5px] inline-flex items-center gap-1"
            title="Refresh server status"
            aria-label="Refresh MCP server status"
          >
            <RefreshCw size={10} aria-hidden="true" />
            Refresh
          </button>
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="pn-button-accent font-sans text-[10.5px] inline-flex items-center gap-1"
            aria-expanded={showAdd}
            aria-label={showAdd ? "Cancel adding MCP server" : "Add a new MCP server"}
          >
            {showAdd ? <X size={10} aria-hidden="true" /> : <Plus size={10} aria-hidden="true" />}
            {showAdd ? "Cancel" : "Add server"}
          </button>
        </div>
      </div>

      {lastError && (
        <div
          className="rounded-md border border-noir-err/40 bg-noir-err/5 px-2 py-1.5 text-[11px] text-noir-err inline-flex items-start gap-1.5"
          role="alert"
        >
          <AlertCircle size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="break-words">{lastError}</span>
        </div>
      )}

      {showAdd && <AddServerForm onDone={() => setShowAdd(false)} />}

      {servers.length === 0 ? (
        <EmptyState onAdd={() => setShowAdd(true)} />
      ) : (
        <ul className="rounded-lg border border-noir-line divide-y divide-noir-line/60">
          {servers.map((s) => (
            <ServerRow key={s.name} snapshot={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-noir-line bg-noir-canvas/40 px-3 py-4 text-center text-[11px] text-noir-mute">
      <Plug size={14} className="mx-auto mb-1 opacity-70" />
      No MCP servers configured.
      <div className="mt-1">
        Try{" "}
        <button
          onClick={onAdd}
          className="underline underline-offset-2 text-noir-accent"
        >
          adding one
        </button>{" "}
        — e.g. <code className="text-noir-subtext">npx -y @modelcontextprotocol/server-filesystem ~/code</code>.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-server row
// ---------------------------------------------------------------------------

function ServerRow({ snapshot }: { snapshot: McpServerSnapshot }) {
  const start = useMcp((s) => s.start);
  const stop = useMcp((s) => s.stop);
  const restart = useMcp((s) => s.restart);
  const remove = useMcp((s) => s.removeServer);
  const refreshTools = useMcp((s) => s.refreshTools);
  const refreshLogs = useMcp((s) => s.refreshLogs);
  const tools = useMcp((s) => s.tools[snapshot.name]);
  const logs = useMcp((s) => s.logs[snapshot.name]);

  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<"start" | "stop" | "restart" | "remove" | null>(null);
  const [editing, setEditing] = useState(false);

  const onStart = async () => {
    setBusy("start");
    try {
      await start(snapshot.name);
    } catch (e) {
      toast.error(`Failed to start ${snapshot.name}`, { body: String(e) });
    } finally {
      setBusy(null);
    }
  };
  const onStop = async () => {
    setBusy("stop");
    try {
      await stop(snapshot.name);
    } catch (e) {
      toast.error(`Failed to stop ${snapshot.name}`, { body: String(e) });
    } finally {
      setBusy(null);
    }
  };
  const onRestart = async () => {
    setBusy("restart");
    try {
      await restart(snapshot.name);
    } catch (e) {
      toast.error(`Failed to restart ${snapshot.name}`, { body: String(e) });
    } finally {
      setBusy(null);
    }
  };
  const onRemove = async () => {
    const ok = await confirm({
      title: `Remove MCP server "${snapshot.name}"?`,
      body:
        "Pointer will stop the subprocess and delete the entry from mcp.json. " +
        "You can always add it back later.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusy("remove");
    try {
      await remove(snapshot.name);
    } catch (e) {
      toast.error(`Failed to remove ${snapshot.name}`, { body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const onToggleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      // Fetch tools + logs once when expanding so the user sees fresh data.
      await Promise.all([refreshTools(snapshot.name), refreshLogs(snapshot.name)]);
    }
  };

  return (
    <li className="px-3 py-2 font-sans">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onToggleExpand}
          className="text-noir-mute hover:text-noir-text"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${snapshot.name}`}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
        </button>
        <Server size={11} className="text-noir-accent shrink-0" aria-hidden="true" />
        <span className="font-mono text-[11.5px] text-noir-text truncate max-w-[180px]">
          {snapshot.name}
        </span>
        <StatusPill status={snapshot.status} />
        <span className="text-[10px] text-noir-mute">
          {snapshot.tool_count} tool{snapshot.tool_count === 1 ? "" : "s"}
        </span>
        <span className="text-[10px] text-noir-mute font-mono truncate max-w-[260px]" aria-label="Command">
          {snapshot.config.command}
          {snapshot.config.args && snapshot.config.args.length > 0 ? " " : ""}
          {(snapshot.config.args ?? []).join(" ")}
        </span>
        <div className="ml-auto flex items-center gap-1" role="toolbar" aria-label={`Actions for ${snapshot.name}`}>
          {snapshot.status === "ready" || snapshot.status === "starting" ? (
            <button
              onClick={onStop}
              disabled={busy !== null}
              className="pn-button font-sans text-[10.5px] inline-flex items-center gap-1"
              title="Stop the subprocess"
              aria-label={`Stop ${snapshot.name}`}
            >
              {busy === "stop" ? (
                <Loader2 size={10} className="animate-spin" aria-hidden="true" />
              ) : (
                <Square size={10} aria-hidden="true" />
              )}
              Stop
            </button>
          ) : (
            <button
              onClick={onStart}
              disabled={busy !== null || snapshot.config.disabled}
              className="pn-button-accent font-sans text-[10.5px] inline-flex items-center gap-1"
              title={snapshot.config.disabled ? "Server is disabled in mcp.json" : "Start the subprocess"}
              aria-label={snapshot.config.disabled ? `${snapshot.name} is disabled in mcp.json` : `Start ${snapshot.name}`}
            >
              {busy === "start" ? (
                <Loader2 size={10} className="animate-spin" aria-hidden="true" />
              ) : (
                <Play size={10} aria-hidden="true" />
              )}
              Start
            </button>
          )}
          <button
            onClick={onRestart}
            disabled={busy !== null}
            className="pn-button font-sans text-[10.5px] inline-flex items-center gap-1"
            title="Stop then start"
            aria-label={`Restart ${snapshot.name}`}
          >
            {busy === "restart" ? (
              <Loader2 size={10} className="animate-spin" aria-hidden="true" />
            ) : (
              <RotateCw size={10} aria-hidden="true" />
            )}
            Restart
          </button>
          <button
            onClick={() => setEditing((v) => !v)}
            className="p-1 text-noir-mute hover:text-noir-text"
            title="Edit config"
            aria-label={`Edit ${snapshot.name} configuration`}
            aria-expanded={editing}
          >
            <Pencil size={10} aria-hidden="true" />
          </button>
          <button
            onClick={onRemove}
            disabled={busy !== null}
            className="p-1 text-noir-mute hover:text-noir-err"
            title="Remove from mcp.json"
            aria-label={`Remove ${snapshot.name} from mcp.json`}
          >
            <Trash2 size={10} aria-hidden="true" />
          </button>
        </div>
      </div>

      {snapshot.error && (
        <div
          className="mt-1 text-[10.5px] text-noir-err inline-flex items-start gap-1"
          role="alert"
        >
          <AlertCircle size={9} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="break-words">{snapshot.error}</span>
        </div>
      )}

      {editing && (
        <div className="mt-2">
          <AddServerForm
            existingName={snapshot.name}
            initial={snapshot.config}
            onDone={() => setEditing(false)}
          />
        </div>
      )}

      {expanded && (
        <div className="mt-2 space-y-2">
          <ToolList tools={tools ?? []} server={snapshot.name} />
          <LogPane lines={logs ?? []} onRefresh={() => refreshLogs(snapshot.name)} />
        </div>
      )}
    </li>
  );
}

function StatusPill({ status }: { status: McpServerSnapshot["status"] }) {
  const map: Record<typeof status, { label: string; cls: string }> = {
    stopped: {
      label: "stopped",
      cls: "border-noir-line text-noir-mute bg-noir-canvas/40",
    },
    starting: {
      label: "starting",
      cls: "border-noir-warn/40 text-noir-warn bg-noir-warn/5",
    },
    ready: {
      label: "ready",
      cls: "border-noir-ok/40 text-noir-ok bg-noir-ok/5",
    },
    error: {
      label: "error",
      cls: "border-noir-err/40 text-noir-err bg-noir-err/5",
    },
  };
  const m = map[status];
  return (
    <span
      className={`text-[9.5px] font-sans px-1 py-[1px] rounded border ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tool list (under expanded server)
// ---------------------------------------------------------------------------

function ToolList({ tools, server }: { tools: McpTool[]; server: string }) {
  if (tools.length === 0) {
    return (
      <div className="text-[10.5px] text-noir-mute italic">
        No tools yet — start the server, or it advertised an empty list.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-noir-line bg-noir-canvas/30">
      <div className="px-2 py-1 border-b border-noir-line/60 text-[10px] uppercase tracking-wider text-noir-mute">
        Tools advertised by {server}
      </div>
      <ul className="divide-y divide-noir-line/60">
        {tools.map((t) => (
          <ToolRow key={t.name} tool={t} />
        ))}
      </ul>
    </div>
  );
}

function ToolRow({ tool }: { tool: McpTool }) {
  const [open, setOpen] = useState(false);
  const schema = tool.inputSchema as
    | { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
    | null;
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const fieldNames = Object.keys(props);
  return (
    <li className="px-2 py-1.5 text-[11px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-start gap-1 w-full text-left"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${tool.name}${tool.description ? ": " + tool.description : ""}`}
      >
        {open ? (
          <ChevronDown size={10} className="mt-1 text-noir-mute shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight size={10} className="mt-1 text-noir-mute shrink-0" aria-hidden="true" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <code className="text-noir-text">{tool.name}</code>
            {fieldNames.length > 0 && (
              <span className="text-[9.5px] text-noir-mute">
                {fieldNames.length} param{fieldNames.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {tool.description && (
            <div className="text-[10.5px] text-noir-subtext mt-0.5 line-clamp-2">
              {tool.description}
            </div>
          )}
        </div>
      </button>
      {open && fieldNames.length > 0 && (
        <div className="mt-1.5 ml-3 rounded border border-noir-line/60 bg-noir-canvas/30 divide-y divide-noir-line/40">
          {fieldNames.map((n) => {
            const p = props[n];
            return (
              <div key={n} className="px-2 py-1 flex items-start gap-2">
                <code className="text-[10.5px] text-noir-text shrink-0">{n}</code>
                <span className="text-[10px] text-noir-mute shrink-0">
                  {p?.type ?? "any"}
                </span>
                {required.has(n) && (
                  <span className="text-[9.5px] text-noir-warn">required</span>
                )}
                {p?.description && (
                  <span className="text-[10.5px] text-noir-subtext break-words">
                    {p.description}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Logs (under expanded server)
// ---------------------------------------------------------------------------

function LogPane({
  lines,
  onRefresh,
}: {
  lines: string[];
  onRefresh: () => void;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  return (
    <div className="rounded-md border border-noir-line bg-noir-canvas/30">
      <div className="px-2 py-1 border-b border-noir-line/60 flex items-center justify-between">
        <h4 className="text-[10px] uppercase tracking-wider text-noir-mute inline-flex items-center gap-1 m-0">
          <Terminal size={9} aria-hidden="true" /> Stderr logs (last 200 lines)
        </h4>
        <button
          onClick={onRefresh}
          className="text-[10px] text-noir-mute hover:text-noir-text inline-flex items-center gap-1"
          aria-label="Refresh server logs"
        >
          <RefreshCw size={9} aria-hidden="true" /> Refresh
        </button>
      </div>
      <pre
        ref={ref}
        className="font-mono text-[10.5px] text-noir-subtext px-2 py-1 max-h-[180px] overflow-auto whitespace-pre-wrap"
        role="log"
        aria-label="Server stderr output"
      >
        {lines.length === 0
          ? "(no output yet — server may not have started or hasn't logged anything)"
          : lines.join("\n")}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / edit server form
// ---------------------------------------------------------------------------

function AddServerForm({
  existingName,
  initial,
  onDone,
}: {
  existingName?: string;
  initial?: McpServerConfig;
  onDone: () => void;
}) {
  const save = useMcp((s) => s.saveServer);
  const [name, setName] = useState(existingName ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsLine, setArgsLine] = useState((initial?.args ?? []).join(" "));
  const [envLines, setEnvLines] = useState(
    Object.entries(initial?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  const [disabled, setDisabled] = useState(!!initial?.disabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = useMemo(() => /^[a-zA-Z0-9_.-]+$/.test(name), [name]);
  const canSave = nameValid && command.trim().length > 0 && !saving;

  const args = useMemo(() => parseArgs(argsLine), [argsLine]);
  const env = useMemo(() => parseEnv(envLines), [envLines]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const cfg: McpServerConfig = {
        command: command.trim(),
        args,
        env,
        cwd: cwd.trim() || null,
        disabled,
      };
      await save(name.trim(), cfg);
      toast.success(
        existingName ? `Updated MCP server "${name}"` : `Added MCP server "${name}"`,
      );
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border border-noir-line bg-noir-canvas/40 p-2.5 space-y-2 text-[11px]"
      aria-label={existingName ? "Edit MCP server" : "Add MCP server"}
    >
      <div className="grid grid-cols-1 gap-1.5">
        <label className="block">
          <span className="text-noir-mute">Name</span>
          <input
            value={name}
            disabled={!!existingName}
            onChange={(e) => setName(e.target.value)}
            placeholder="filesystem"
            className="pn-input w-full mt-0.5 font-mono"
            aria-label="Server name"
          />
          {!nameValid && name.length > 0 && (
            <span className="text-[10px] text-noir-warn">
              Use letters, numbers, dots, dashes, underscores.
            </span>
          )}
        </label>
        <label className="block">
          <span className="text-noir-mute">Command</span>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx"
            className="pn-input w-full mt-0.5 font-mono"
            aria-label="Command"
          />
        </label>
        <label className="block">
          <span className="text-noir-mute">
            Args{" "}
            <span className="text-[9.5px] text-noir-mute italic">
              (space-separated; quote values with spaces)
            </span>
          </span>
          <input
            value={argsLine}
            onChange={(e) => setArgsLine(e.target.value)}
            placeholder='-y @modelcontextprotocol/server-filesystem "/Users/me/code"'
            className="pn-input w-full mt-0.5 font-mono"
            aria-label="Arguments"
          />
        </label>
        <label className="block">
          <span className="text-noir-mute">
            Env{" "}
            <span className="text-[9.5px] text-noir-mute italic">
              (one KEY=value per line)
            </span>
          </span>
          <textarea
            value={envLines}
            onChange={(e) => setEnvLines(e.target.value)}
            placeholder="GITHUB_TOKEN=ghp_…"
            rows={3}
            className="pn-input w-full mt-0.5 font-mono"
            aria-label="Environment variables"
          />
        </label>
        <label className="block">
          <span className="text-noir-mute">
            Working dir{" "}
            <span className="text-[9.5px] text-noir-mute italic">(optional)</span>
          </span>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/Users/me/projects"
            className="pn-input w-full mt-0.5 font-mono"
            aria-label="Working directory"
          />
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
            className="h-3 w-3 accent-noir-accent"
          />
          <span className="text-noir-subtext">Disabled (keep in config but don't run)</span>
        </label>
      </div>
      {error && (
        <div
          className="text-[10.5px] text-noir-err inline-flex items-start gap-1"
          role="alert"
        >
          <AlertCircle size={10} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="break-words">{error}</span>
        </div>
      )}
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={onDone}
          className="pn-button font-sans text-[10.5px]"
          aria-label="Cancel server changes"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSave}
          className="pn-button-accent font-sans text-[10.5px] inline-flex items-center gap-1"
          aria-label={existingName ? `Save changes to ${existingName}` : "Add MCP server"}
        >
          {saving ? (
            <Loader2 size={10} className="animate-spin" aria-hidden="true" />
          ) : (
            <Power size={10} aria-hidden="true" />
          )}
          {existingName ? "Save" : "Add server"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Split a "command-line"-ish args string into tokens, honoring quoted
 * substrings. Not a full shell parser — we don't expand variables or do
 * glob expansion; we just split tokens correctly when the user pasted
 * something like `-y "@scope/pkg" "/path with space"`.
 */
export function parseArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Parse a multi-line `KEY=value` block into an env map. Blank lines and
 * comment lines starting with `#` are ignored.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}
