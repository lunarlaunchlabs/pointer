import { useEffect, useState } from "@/lib/preactSignalCompat";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Bot,
  Cpu,
  Database,
  Download,
  GitBranch,
  MessageSquare,
  Paperclip,
  Server,
  Sparkles,
} from "@/lib/lucide";
import { useEditorStore } from "@/store/editor";
import {
  useSettings,
  isFeatureUsable,
  effectiveAssignedModel,
  isModelInInstalledList,
} from "@/store/settings";
import { useSession } from "@/store/session";
import { usePulls } from "@/store/pulls";
import { useDiagnostics } from "@/store/diagnostics";
import { useGit } from "@/store/git";
import { useAssistant } from "@/store/assistant";
import {
  ipc,
  listenEvent,
  type LanguageServerStatus,
  type SystemLoadSnapshot,
} from "@/lib/ipc";
import { dispatchAction } from "@/lib/actions";
import { subscribeHistory, type ToastHistoryEntry } from "@/components/Toast";
import { useWorkspace } from "@/store/workspace";

/** Platform-aware modifier label so chip tooltips read naturally on both
 *  macOS and Windows / Linux. */
const ALT_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌥"
    : "Alt+";

export function StatusBar({ onOpenMonitor }: { onOpenMonitor?: () => void } = {}) {
  const active = useEditorStore((s) => s.getActive());
  const selection = useEditorStore((s) => s.selection);
  const cursor = useEditorStore((s) => s.cursor);
  const workspaceRoot = useWorkspace((s) => s.root);
  const tabSize = useSettings((s) => s.editorTabSize);
  const insertSpaces = useSettings((s) => s.editorInsertSpaces ?? true);
  const wordWrap = useSettings((s) => s.editorWordWrap);
  // Effective (= set AND currently installed) view of the per-purpose
  // assignments. The status bar is a glanceable summary, not a configuration
  // surface — if a slot points at a model the user has since uninstalled,
  // we treat it as unset here so the chip doesn't claim it's active.
  const chatModel = useSettings((s) => effectiveAssignedModel("chat", s));
  const agentModel = useSettings((s) => effectiveAssignedModel("agent", s));
  // Raw values are still needed for the tooltip so we can spell out
  // exactly *which* slot is unset or pointing at a missing model.
  const rawChat = useSettings((s) => s.chatModel);
  const rawAgent = useSettings((s) => s.agentModel);
  const rawFim = useSettings((s) => s.fimModel);
  const installedModels = useSettings((s) => s.installedModels);
  const fimEnabled = useSettings((s) => s.fimEnabled);
  const fimTriggerMode = useSettings((s) => s.fimTriggerMode);
  // The status-bar pill tracks the *effective* state — "Tab on" only when
  // FIM can actually fire (toggle on + model picked + installed + runtime
  // up). The underlying `fimEnabled` boolean is what the click toggles.
  const fimUsable = useSettings((s) => isFeatureUsable("fim", s));
  const setFimEnabled = useSettings((s) => s.setFimEnabled);
  const ollamaReady = useSettings((s) => s.ollamaReady);
  const noteDockView = useSession((s) => s.noteDockView);
  const activePulls = usePulls((s) => s.active);
  const errorCount = useDiagnostics((s) => s.errors);
  const gitBranch = useGit((s) => s.status.branch);
  const gitAhead = useGit((s) => s.status.ahead);
  const gitBehind = useGit((s) => s.status.behind);
  const gitDirty = useGit((s) => s.status.dirty_count);
  const warningCount = useDiagnostics((s) => s.warnings);
  // Staged-reference counter: a glanceable hint that the user has
  // attached context to the unified Assistant. Clicking the chip
  // routes to the Assistant so the user can find / remove what they
  // attached without hunting through the dock.
  const assistantRefCount = useAssistant((s) => s.pendingRefs.length);
  const assistantMode = useAssistant(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.mode ?? "ask",
  );
  const [indexProgress, setIndexProgress] = useState<null | {
    files: number;
    chunks: number;
  }>(null);
  const [load, setLoad] = useState<{
    cpu: number;
    mem: number;
    memTotal: number;
  } | null>(null);
  const [lspStatuses, setLspStatuses] = useState<LanguageServerStatus[]>([]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let offDone: (() => void) | undefined;
    listenEvent<{ files: number; chunks: number }>("index:progress", (p) =>
      setIndexProgress(p),
    ).then((u) => (off = u));
    listenEvent<{ files: number; chunks: number }>("index:done", (p) => {
      setIndexProgress(p);
      setTimeout(() => setIndexProgress(null), 4000);
    }).then((u) => (offDone = u));
    return () => {
      off?.();
      offDone?.();
    };
  }, []);

  // Sample the system load on a slow cadence so the chip stays current without
  // taxing the host. The full monitor polls faster when it's open.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s: SystemLoadSnapshot = await ipc.systemLoadSnapshot();
        if (!alive) return;
        setLoad({
          cpu: s.pointer_cpu_percent,
          mem: s.pointer_mem_bytes,
          memTotal: s.mem_total,
        });
      } catch {
        /* the monitor command exists; ignore transient errors */
      }
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      ipc
        .lspStatus(workspaceRoot ?? undefined)
        .then((statuses) => {
          if (alive) setLspStatuses(statuses);
        })
        .catch(() => {
          if (alive) setLspStatuses([]);
        });
    };
    refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [workspaceRoot, active?.path, active?.language]);

  const stats = active
    ? (() => {
        const lines = active.content.split("\n").length;
        return { lines };
      })()
    : null;

  // Compact representation of the per-purpose model picks — the title bar's
  // popover is the full breakdown; here we surface the chat/agent model
  // (which is the one users feel most directly) and signal in the tooltip
  // that they can click to manage all four.
  //
  // Crucially, this uses the *effective* model values (empty when a slot
  // points at a missing or uninstalled model). If both effective values
  // are empty we tell the user honestly rather than printing a stale name.
  const effectiveModels = [chatModel, agentModel].filter(Boolean);
  const modelLabel =
    effectiveModels.length === 0
      ? "no model"
      : effectiveModels[0] === effectiveModels[1] || effectiveModels.length === 1
      ? effectiveModels[0]
      : `${effectiveModels[0]} · ${effectiveModels[1]}`;
  // Per-slot tooltip status — "not set" when blank, "(missing)" when the
  // user picked a model that is no longer installed, plain name otherwise.
  // We rely on `installedModels` to distinguish the two failure modes so
  // the tooltip is actionable.
  const slotLabel = (raw: string) =>
    !raw
      ? "— not set —"
      : ollamaReady &&
        installedModels.length > 0 &&
        !isModelInInstalledList(raw, installedModels)
      ? `${raw} (not installed)`
      : raw;
  const modelTooltip = [
    `Chat · ${slotLabel(rawChat)}`,
    `Agent · ${slotLabel(rawAgent)}`,
    `Tab · ${slotLabel(rawFim)}`,
    "Click to manage assignments.",
  ].join("\n");
  const allEffectiveEmpty = effectiveModels.length === 0;
  const pullCount = Object.keys(activePulls).length;
  const dominantPull = Object.values(activePulls).find((p) => !p.error);
  const activeLsp = active
    ? lspStatuses.find((s) => s.language === normaliseStatusLanguage(active.language))
    : null;

  // The status bar gets dense fast. Strategy:
  //   • Left side is overflow-hidden + flex; items truncate label-side and
  //     less-critical ones (download chip, system load) hide below md.
  //   • Right side never wraps and shrinks individual items as needed.
  //   • The whole bar stays 24px tall regardless of content.
  return (
    <div
      className="pn-statusbar relative z-pn-editor-overlay h-6 shrink-0 px-3 flex items-center justify-between gap-3 border-t border-noir-line/80 text-[10px] font-sans text-noir-subtext select-none"
      role="contentinfo"
      aria-label="Status bar"
    >
      <div className="flex items-center gap-3 sm:gap-4 min-w-0 overflow-hidden">
        <button
          onClick={() => noteDockView("ai")}
          className="flex items-center gap-1.5 hover:text-noir-text transition-colors shrink-0"
          title="Open AI Control Panel (⌘,)"
          aria-label={`Inference runtime: ${ollamaReady ? "ready" : "offline"}. Open AI Control Panel.`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${
              ollamaReady ? "bg-noir-ok" : "bg-noir-mute"
            }`}
          />
          <span>{ollamaReady ? "Local" : "Offline"}</span>
        </button>
        <button
          onClick={() => noteDockView("ai")}
          className="flex items-center gap-1.5 hover:text-noir-text transition-colors min-w-0 max-w-[260px]"
          title={modelTooltip}
          aria-label={`AI model assignments. ${modelTooltip.replace(/\n/g, ". ")}`}
        >
          <Cpu
            size={10}
            aria-hidden="true"
            className={`shrink-0 ${allEffectiveEmpty ? "text-noir-warn" : ""}`}
          />
          <span
            className={`font-mono truncate ${allEffectiveEmpty ? "text-noir-warn" : ""}`}
          >
            {modelLabel}
          </span>
        </button>
        <button
          onClick={() => setFimEnabled(!fimEnabled)}
          className={`hidden sm:flex items-center gap-1 hover:text-noir-text transition-colors shrink-0 ${
            fimUsable ? "text-noir-accent" : ""
          }`}
          aria-pressed={fimUsable}
          title={
            fimUsable
              ? fimTriggerMode === "manual"
                ? "Manual tab completion is on. Press ⌘⇧Space to request — click to disable."
                : "Automatic tab completion is on — click to disable."
              : !fimEnabled
              ? "Tab completion is off — click to enable."
              : "Tab completion is off (no FIM model configured)."
          }
        >
          <Sparkles size={10} aria-hidden="true" />
          <span>
            Tab {fimUsable ? (fimTriggerMode === "manual" ? "manual" : "auto") : "off"}
          </span>
        </button>
        {indexProgress && (
          <div
            className="hidden md:flex items-center gap-1.5 shrink-0"
            role="status"
            aria-live="polite"
          >
            <Database size={10} aria-hidden="true" />
            <span className="truncate">
              Indexing — {indexProgress.files} files, {indexProgress.chunks} chunks
            </span>
          </div>
        )}
        {pullCount > 0 && (
          <button
            onClick={() => noteDockView("ai")}
            className="hidden md:flex items-center gap-1.5 hover:text-noir-text transition-colors min-w-0"
            title={`${pullCount} download${pullCount === 1 ? "" : "s"} in progress`}
            aria-label={`${pullCount} model download${pullCount === 1 ? "" : "s"} in progress. Open AI panel.`}
          >
            <Download
              size={10}
              aria-hidden="true"
              className="text-noir-accent animate-pulse shrink-0"
            />
            <span className="font-mono truncate max-w-[200px]">
              {dominantPull
                ? `${dominantPull.model} · ${dominantPull.pct}%`
                : `${pullCount} pulls`}
            </span>
          </button>
        )}
        {load && (
          <button
            onClick={onOpenMonitor}
            className="hidden lg:flex items-center gap-1.5 hover:text-noir-text transition-colors shrink-0"
            title="Open system monitor (⌘⇧M)"
            aria-label={`CPU ${load.cpu.toFixed(0)}%, memory ${fmtMb(load.mem)}. Open system monitor.`}
          >
            <Activity size={10} aria-hidden="true" className="text-noir-accent" />
            <span className="font-mono">
              {load.cpu.toFixed(0)}% · {fmtMb(load.mem)}
            </span>
          </button>
        )}
        {assistantRefCount > 0 && (
          <button
            onClick={() => noteDockView("assistant")}
            className="hidden md:flex items-center gap-1 hover:text-noir-text transition-colors shrink-0 text-noir-accent"
            title={`${assistantRefCount} reference${assistantRefCount === 1 ? "" : "s"} staged on ${assistantMode} — click to review`}
            aria-label={`${assistantRefCount} reference${assistantRefCount === 1 ? "" : "s"} staged on Assistant ${assistantMode} mode`}
          >
            {assistantMode === "ask" ? (
              <MessageSquare size={10} aria-hidden="true" />
            ) : (
              <Bot size={10} aria-hidden="true" />
            )}
            <Paperclip size={9} aria-hidden="true" className="-ml-0.5 opacity-70" />
            <span className="font-mono tabular-nums">{assistantRefCount}</span>
          </button>
        )}
        {gitBranch && (
          <button
            onClick={() => dispatchAction("git:show_panel")}
            className="hidden md:flex items-center gap-1.5 hover:text-noir-text transition-colors shrink-0"
            title={`Branch ${gitBranch}${
              gitAhead || gitBehind
                ? ` · ${gitAhead ?? 0} ahead / ${gitBehind ?? 0} behind`
                : ""
            }${
              gitDirty ? ` · ${gitDirty} dirty file${gitDirty === 1 ? "" : "s"}` : ""
            } — click to open Source Control`}
            aria-label={`Git branch ${gitBranch}${
              gitAhead ? `, ${gitAhead} ahead` : ""
            }${gitBehind ? `, ${gitBehind} behind` : ""}${
              gitDirty ? `, ${gitDirty} dirty file${gitDirty === 1 ? "" : "s"}` : ""
            }. Open Source Control panel.`}
          >
            <GitBranch size={10} aria-hidden="true" className="text-noir-accent" />
            <span className="font-mono max-w-[140px] truncate">{gitBranch}</span>
            {(gitAhead || gitBehind) && (
              <span className="font-mono tabular-nums text-noir-mute">
                {gitBehind ? `↓${gitBehind}` : ""}
                {gitAhead ? `↑${gitAhead}` : ""}
              </span>
            )}
            {gitDirty > 0 && (
              <span className="text-noir-warn font-mono tabular-nums">
                ●{gitDirty}
              </span>
            )}
          </button>
        )}
        <button
          onClick={() => dispatchAction("view:toggle_problems")}
          className="flex items-center gap-1.5 hover:text-noir-text transition-colors shrink-0"
          title={`${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${
            warningCount === 1 ? "" : "s"
          } — click to view Problems panel`}
          aria-label={`${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${
            warningCount === 1 ? "" : "s"
          }. Open Problems panel.`}
        >
          <AlertCircle
            size={10}
            aria-hidden="true"
            className={errorCount > 0 ? "text-noir-warn" : "text-noir-mute"}
          />
          <span className="font-mono tabular-nums">{errorCount}</span>
          <AlertTriangle
            size={10}
            aria-hidden="true"
            className={warningCount > 0 ? "text-amber-400" : "text-noir-mute"}
          />
          <span className="font-mono tabular-nums">{warningCount}</span>
        </button>
      </div>
      <div className="flex items-center gap-3 sm:gap-4 shrink-0">
        {active && cursor && (
          <button
            onClick={() => dispatchAction("editor:goto_line")}
            className="hidden sm:inline hover:text-noir-text transition-colors font-mono tabular-nums"
            title="Go to line… (⌘G)"
          >
            Ln {cursor.line}, Col {cursor.column}
            {selection && selection.text && (
              <SelectionStats selection={selection} />
            )}
          </button>
        )}
        {active && (
          <button
            onClick={() => dispatchAction("editor:toggle_indent")}
            className="hidden md:inline hover:text-noir-text transition-colors"
            title={`${insertSpaces ? "Spaces" : "Tabs"} · width ${tabSize}. Click to flip indent mode.`}
          >
            {insertSpaces ? "Spaces" : "Tabs"}: {tabSize}
          </button>
        )}
        {active && (
          <button
            onClick={() => dispatchAction("view:toggle_word_wrap")}
            className={`hidden md:inline hover:text-noir-text transition-colors ${
              wordWrap ? "text-noir-accent" : ""
            }`}
            title={`Word wrap is ${wordWrap ? "on" : "off"}. Click to toggle (${ALT_KEY}Z).`}
          >
            Wrap: {wordWrap ? "On" : "Off"}
          </button>
        )}
        {active && (
          <span
            className="hidden lg:inline text-noir-mute"
            title="Character encoding"
          >
            UTF-8
          </span>
        )}
        {active && (
          <button
            onClick={() => dispatchAction("editor:change_eol")}
            className="hidden lg:inline hover:text-noir-text transition-colors"
            title="End of line sequence. Click to switch."
          >
            {detectEol(active.content)}
          </button>
        )}
        {active && stats && (
          <>
            {activeLsp && (
              <button
                onClick={() => dispatchAction("editor:change_language")}
                className={`hidden md:inline-flex items-center gap-1 hover:text-noir-text transition-colors ${
                  activeLsp.status === "ready" || activeLsp.status === "available"
                    ? "text-noir-accent"
                    : activeLsp.status === "missing"
                    ? "text-noir-warn"
                    : ""
                }`}
                title={`${activeLsp.label} · ${activeLsp.detail}${
                  activeLsp.command ? `\n${activeLsp.command}` : ""
                }`}
                aria-label={`Language server: ${activeLsp.label}, ${activeLsp.status}`}
              >
                <Server size={10} aria-hidden="true" />
                <span>{shortLspLabel(activeLsp)}</span>
              </button>
            )}
            <button
              onClick={() => dispatchAction("editor:change_language")}
              className="hidden sm:inline hover:text-noir-text transition-colors"
              title={`Click to change language mode for this file${
                activeLsp ? `\n${activeLsp.detail}` : ""
              }`}
            >
              {active.language}
            </button>
            <span className="hidden md:inline">{stats.lines} lines</span>
            <span>{active.dirty ? "● Unsaved" : "Saved"}</span>
          </>
        )}
        <NotificationsBadge />
      </div>
    </div>
  );
}

function fmtMb(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function normaliseStatusLanguage(language: string): string {
  switch (language) {
    case "typescriptreact":
    case "tsx":
    case "typescript":
      return "typescript";
    case "javascriptreact":
    case "jsx":
    case "javascript":
      return "javascript";
    case "scss":
    case "less":
      return "css";
    case "mdx":
      return "markdown";
    case "solidity":
      return "solidity";
    case "system-verilog":
      return "systemverilog";
    default:
      return language;
  }
}

function shortLspLabel(status: LanguageServerStatus): string {
  if (status.status === "monaco") {
    return status.label === "TypeScript service" ? "TS service" : "Monaco";
  }
  if (status.status === "syntax") return "Syntax";
  if (status.status === "missing") return "No LSP";
  return status.label
    .replace("-language-server", "")
    .replace("rust-analyzer", "Rust LSP");
}

/** Inspect the buffer to figure out which line-ending sequence
 *  dominates. We sample the first ~10kb because that's enough to
 *  determine the file's convention; anything mixed is rare enough
 *  that we just say "LF" rather than introducing a "Mixed" label
 *  the user would only ask questions about. */
function detectEol(content: string): "LF" | "CRLF" {
  const sample = content.length > 10_000 ? content.slice(0, 10_000) : content;
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < sample.length; i++) {
    const ch = sample.charCodeAt(i);
    if (ch === 13 /* \r */) {
      if (sample.charCodeAt(i + 1) === 10) {
        crlf++;
        i++; // skip the \n half of the pair
      }
    } else if (ch === 10 /* \n */) {
      lf++;
    }
  }
  return crlf > lf ? "CRLF" : "LF";
}

/** Tiny bell with an unread count. Clicking opens the notification
 *  center; the badge clears when the panel mounts (markAllSeen()).
 *  Mirrors the macOS bell affordance — a system-wide pattern users
 *  already know. */
function NotificationsBadge() {
  const [items, setItems] = useState<ToastHistoryEntry[]>([]);
  useEffect(() => subscribeHistory(setItems), []);
  const unread = items.filter((i) => !i.seen).length;
  const total = items.length;
  return (
    <button
      onClick={() => dispatchAction("help:notifications")}
      className="relative inline-flex items-center gap-1 hover:text-noir-text transition-colors"
      title={
        total === 0
          ? "No notifications"
          : unread > 0
          ? `${unread} unread notification${unread === 1 ? "" : "s"}`
          : `${total} notification${total === 1 ? "" : "s"}`
      }
      aria-label="Notifications"
    >
      <BellIcon className={unread > 0 ? "text-noir-accent" : "text-noir-mute"} />
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[12px] h-[12px] px-1 rounded-full bg-noir-accent text-[8.5px] font-medium text-white flex items-center justify-center tabular-nums">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}

/** Compact bell icon used by the notifications badge. Inlined as a
 *  tiny svg so we don't pay for an extra lucide import in this file. */
function BellIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/** Compact "(N lines · M chars · K words)" readout shown next to
 *  the cursor position when the user has an active selection.
 *  Matches the format VSCode users expect — sized so it doesn't
 *  push other status segments off-screen on narrow windows. */
function SelectionStats({
  selection,
}: {
  selection: { startLine: number; endLine: number; text: string };
}) {
  const text = selection.text;
  const lines = selection.endLine - selection.startLine + 1;
  const chars = text.length;
  // Word count: split on whitespace, drop empties. Cheap enough to
  // do every render; no debouncing needed for selections that fit
  // in memory (which they do — Monaco caps selection size).
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const parts: string[] = [];
  if (lines > 1) parts.push(`${lines} lines`);
  parts.push(`${chars} char${chars === 1 ? "" : "s"}`);
  if (words > 0) parts.push(`${words} word${words === 1 ? "" : "s"}`);
  return <span> ({parts.join(" · ")})</span>;
}
