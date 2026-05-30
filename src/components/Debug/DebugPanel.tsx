import { useMemo, useState } from "@/lib/preactSignalCompat";
import {
  Bot,
  CircleDot,
  Code2,
  MessageSquare,
  Plus,
  Route,
  Send,
  Trash2,
} from "@/lib/lucide";
import { inferDebuggerCapabilities } from "@/lib/debugCapabilities";
import { sendBreakpointToAI, sendDebugValueToAI, type AiTarget } from "@/lib/sendToAI";
import { useDebuggerStore, type Breakpoint, type DebugValue } from "@/store/debugger";
import { useEditorStore } from "@/store/editor";
import { useWorkspace } from "@/store/workspace";

export function DebugPanel() {
  const breakpoints = useDebuggerStore((s) => s.breakpoints);
  const debugValues = useDebuggerStore((s) => s.values);
  const addDebugValue = useDebuggerStore((s) => s.addDebugValue);
  const clearDebugValues = useDebuggerStore((s) => s.clearDebugValues);
  const active = useEditorStore((s) => s.getActive());
  const cursor = useEditorStore((s) => s.cursor);
  const tabs = useEditorStore((s) => s.tabs);
  const openTabPaths = useMemo(() => tabs.map((t) => t.path), [tabs]);
  const knownFiles = useKnownWorkspaceFiles();
  const capabilities = useMemo(
    () => inferDebuggerCapabilities([...knownFiles, ...openTabPaths]),
    [knownFiles, openTabPaths],
  );
  const [draft, setDraft] = useState({ name: "", value: "", type: "" });

  const capture = () => {
    if (!draft.name.trim() || !draft.value.trim()) return;
    addDebugValue({
      name: draft.name.trim(),
      value: draft.value.trim(),
      type: draft.type.trim() || undefined,
      path: active?.path,
      line: cursor?.line,
      scope: "manual capture",
    });
    setDraft({ name: "", value: "", type: "" });
  };

  return (
    <div
      className="flex h-full flex-col bg-noir-bg font-sans text-noir-text"
      role="region"
      aria-label="Debug panel"
    >
      <header className="border-b border-noir-line bg-noir-chrome/40 px-3 py-2">
        <div className="flex items-center gap-2 text-[12px] font-medium">
          <Route size={13} className="text-noir-accent" aria-hidden="true" />
          Debug
        </div>
        <div className="mt-0.5 text-[10.5px] text-noir-mute">
          Breakpoints and runtime values can be dragged or sent into Ask, Plan, or Agent.
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <section>
          <SectionTitle label="Adapters" count={capabilities.length} />
          {capabilities.length === 0 ? (
            <EmptyLine text="Open a project file to infer debugger adapters." />
          ) : (
            <div className="space-y-2">
              {capabilities.map((cap) => (
                <div
                  key={cap.language}
                  data-debug-adapter-language={cap.language}
                  className="rounded-md border border-noir-line bg-noir-canvas/35 p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11.5px] font-medium text-noir-text">
                      {cap.label}
                    </div>
                    <div className="rounded border border-noir-accent/30 bg-noir-accent/10 px-1.5 py-0.5 font-mono text-[9.5px] text-noir-accent">
                      {cap.adapter}
                    </div>
                  </div>
                  <div className="mt-1 text-[10.5px] leading-relaxed text-noir-mute">
                    {cap.installHint}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {Array.from(new Set([...cap.launchKinds, ...cap.frameworks]))
                      .map((tag) => (
                      <span
                        key={tag}
                        className="rounded border border-noir-line bg-noir-ridge/50 px-1.5 py-0.5 text-[9.5px] text-noir-subtext"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionTitle label="Breakpoints" count={breakpoints.length} />
          {breakpoints.length === 0 ? (
            <EmptyLine text="Click the editor gutter to add a breakpoint." />
          ) : (
            <div className="space-y-1.5">
              {breakpoints.map((bp) => (
                <BreakpointRow key={bp.id} breakpoint={bp} />
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between">
            <SectionTitle label="Captured values" count={debugValues.length} />
            {debugValues.length > 0 && (
              <button
                onClick={clearDebugValues}
                className="text-[10px] text-noir-mute hover:text-noir-err"
              >
                Clear
              </button>
            )}
          </div>
          <div className="rounded-md border border-noir-line bg-noir-canvas/35 p-2 space-y-1.5">
            <div className="grid grid-cols-[1fr_0.8fr] gap-1.5">
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                className="pn-input h-7"
                placeholder="name"
                aria-label="Debug value name"
              />
              <input
                value={draft.type}
                onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}
                className="pn-input h-7"
                placeholder="type"
                aria-label="Debug value type"
              />
            </div>
            <div className="flex gap-1.5">
              <input
                value={draft.value}
                onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") capture();
                }}
                className="pn-input h-7 min-w-0 flex-1"
                placeholder="value"
                aria-label="Debug value"
              />
              <button
                onClick={capture}
                disabled={!draft.name.trim() || !draft.value.trim()}
                className="pn-icon-button h-7 w-7"
                title="Capture debug value"
                aria-label="Capture debug value"
              >
                <Plus size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
          {debugValues.length === 0 ? (
            <EmptyLine text="Capture a watch value, then drag or send it to the Assistant." />
          ) : (
            <div className="mt-2 space-y-1.5">
              {debugValues.map((value) => (
                <DebugValueRow key={value.id} value={value} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function BreakpointRow({ breakpoint }: { breakpoint: Breakpoint }) {
  const removeBreakpoint = useDebuggerStore((s) => s.removeBreakpoint);
  const updateBreakpoint = useDebuggerStore((s) => s.updateBreakpoint);
  return (
    <div
      draggable
      data-debug-breakpoint-path={breakpoint.path}
      data-debug-breakpoint-line={breakpoint.line}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(
          "application/x-pointer-breakpoint",
          JSON.stringify(breakpoint),
        );
        e.dataTransfer.setData("text/plain", `${breakpoint.path}:${breakpoint.line}`);
      }}
      className="group rounded-md border border-noir-line bg-noir-canvas/35 p-2"
    >
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={() =>
            updateBreakpoint(breakpoint.id, { enabled: !breakpoint.enabled })
          }
          className="shrink-0 text-noir-mute hover:text-noir-err"
          title={breakpoint.enabled ? "Disable breakpoint" : "Enable breakpoint"}
          aria-label={breakpoint.enabled ? "Disable breakpoint" : "Enable breakpoint"}
        >
          <CircleDot
            size={12}
            className={breakpoint.enabled ? "text-noir-err" : "text-noir-mute"}
            aria-hidden="true"
          />
        </button>
        <button
          onClick={() =>
            useEditorStore
              .getState()
              .revealAt(breakpoint.path, breakpoint.line, breakpoint.column ?? 1)
              .catch(() => {})
          }
          className="min-w-0 flex-1 truncate text-left font-mono text-[11px] hover:text-noir-accent"
          title={breakpoint.path}
        >
          {shortPath(breakpoint.path)}:{breakpoint.line}
        </button>
        <SendButtons onSend={(target) => sendBreakpointToAI(target, breakpoint)} />
        <button
          onClick={() => removeBreakpoint(breakpoint.id)}
          className="text-noir-mute hover:text-noir-err"
          title="Remove breakpoint"
          aria-label="Remove breakpoint"
        >
          <Trash2 size={11} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <input
          value={breakpoint.condition ?? ""}
          onChange={(e) =>
            updateBreakpoint(breakpoint.id, {
              condition: e.currentTarget.value.trim() || undefined,
            })
          }
          className="pn-input h-6 font-mono text-[10px]"
          placeholder="condition"
          aria-label="Breakpoint condition"
        />
        <input
          value={breakpoint.logMessage ?? ""}
          onChange={(e) =>
            updateBreakpoint(breakpoint.id, {
              logMessage: e.currentTarget.value.trim() || undefined,
            })
          }
          className="pn-input h-6 font-mono text-[10px]"
          placeholder="log message"
          aria-label="Breakpoint log message"
        />
      </div>
    </div>
  );
}

function DebugValueRow({ value }: { value: DebugValue }) {
  const removeDebugValue = useDebuggerStore((s) => s.removeDebugValue);
  return (
    <div
      draggable
      data-debug-value-name={value.name}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(
          "application/x-pointer-debug-value",
          JSON.stringify(value),
        );
        e.dataTransfer.setData("text/plain", `${value.name} = ${value.value}`);
      }}
      className="rounded-md border border-noir-line bg-noir-canvas/35 p-2"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Code2 size={12} className="text-noir-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate font-mono text-[11px] text-noir-text">
              {value.name}
            </span>
            {value.type && (
              <span className="shrink-0 rounded bg-noir-ridge/70 px-1.5 py-0.5 font-mono text-[9px] text-noir-mute">
                {value.type}
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[10.5px] text-noir-subtext">
            {value.value}
          </div>
        </div>
        <SendButtons onSend={(target) => sendDebugValueToAI(target, value)} />
        <button
          onClick={() => removeDebugValue(value.id)}
          className="text-noir-mute hover:text-noir-err"
          title="Remove value"
          aria-label="Remove debug value"
        >
          <Trash2 size={11} aria-hidden="true" />
        </button>
      </div>
      {value.path && (
        <div className="mt-1 truncate text-[10px] text-noir-mute">
          {shortPath(value.path)}
          {value.line ? `:${value.line}` : ""}
        </div>
      )}
    </div>
  );
}

function SendButtons({ onSend }: { onSend: (target: AiTarget) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={() => onSend("ask")}
        className="pn-icon-button h-5 w-5"
        title="Send to Ask"
        aria-label="Send to Ask"
      >
        <MessageSquare size={10} aria-hidden="true" />
      </button>
      <button
        onClick={() => onSend("plan")}
        className="pn-icon-button h-5 w-5"
        title="Send to Plan"
        aria-label="Send to Plan"
      >
        <Send size={10} aria-hidden="true" />
      </button>
      <button
        onClick={() => onSend("agent")}
        className="pn-icon-button h-5 w-5"
        title="Send to Agent"
        aria-label="Send to Agent"
      >
        <Bot size={10} aria-hidden="true" />
      </button>
    </div>
  );
}

function SectionTitle({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-noir-mute">
      <span>{label}</span>
      <span className="font-mono tabular-nums">{count}</span>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-noir-line bg-noir-canvas/20 px-2.5 py-2 text-[10.5px] text-noir-mute">
      {text}
    </div>
  );
}

function useKnownWorkspaceFiles(): string[] {
  const root = useWorkspace((s) => s.root);
  const entries = useWorkspace((s) => s.entries);
  const childrenCache = useWorkspace((s) => s.childrenCache);
  return useMemo(() => {
    const paths = new Set<string>();
    if (root) paths.add(root);
    for (const entry of entries) paths.add(entry.path);
    for (const children of Object.values(childrenCache)) {
      for (const entry of children) paths.add(entry.path);
    }
    return Array.from(paths);
  }, [root, entries, childrenCache]);
}

function shortPath(path: string): string {
  return path.split(/[\\/]/).slice(-2).join("/");
}
