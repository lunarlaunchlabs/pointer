/**
 * Problems panel.
 *
 * Renders the diagnostics produced by Monaco's language workers, grouped
 * by file. Clicking a row opens the file and positions the cursor on the
 * offending range — the same gesture VS Code's panel uses.
 *
 * We deliberately keep this panel *flat* per file (no fancy outline tree)
 * because in practice most repos have <20 active problems at a time and
 * the visual cost of a tree adds friction.
 */

import { useMemo } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  ChevronDown,
  Info,
  MessageSquare,
  Sparkles,
  X,
} from "lucide-react";
import { useDiagnostics, type Diagnostic } from "@/store/diagnostics";
import { useEditorStore } from "@/store/editor";
import { FileIconFor } from "@/lib/fileIcon";
import {
  sendAllDiagnosticsToAI,
  sendDiagnosticToAI,
} from "@/lib/sendToAI";
import { isFeatureUsable, useSettings } from "@/store/settings";

export function ProblemsPanel({ onClose }: { onClose: () => void }) {
  const byUri = useDiagnostics((s) => s.byUri);
  const revealAt = useEditorStore((s) => s.revealAt);
  // We don't *disable* the send buttons when chat / agent are off (the
  // user might be staging refs to inspect later), but we surface the
  // unavailable state in the tooltip so they know what to expect when
  // they hit Enter in the picker.
  const chatUsable = useSettings((s) => isFeatureUsable("chat", s));
  const agentUsable = useSettings((s) => isFeatureUsable("agent", s));

  // Build a stable grouped view. Sorted by severity → file → line so the
  // most important problems sit at the top, and a re-render with one
  // changed marker doesn't shuffle unrelated entries.
  const groups = useMemo(() => {
    const out: { uri: string; name: string; diags: Diagnostic[] }[] = [];
    for (const [uri, diags] of Object.entries(byUri)) {
      const sorted = [...diags].sort((a, b) => {
        const sev = sevRank(b.severity) - sevRank(a.severity);
        if (sev !== 0) return sev;
        return a.startLine - b.startLine || a.startCol - b.startCol;
      });
      out.push({ uri, name: sorted[0]?.name ?? uri, diags: sorted });
    }
    out.sort((a, b) => {
      const aTopSev = sevRank(a.diags[0]?.severity ?? "info");
      const bTopSev = sevRank(b.diags[0]?.severity ?? "info");
      if (aTopSev !== bTopSev) return bTopSev - aTopSev;
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [byUri]);

  const total = Object.values(byUri).reduce((a, b) => a + b.length, 0);

  const reveal = (d: Diagnostic) => {
    // Monaco model URIs are `file:///abs/path`. Strip the scheme so the
    // editor store treats it as a normal absolute path. Windows paths
    // come through as `file:///C:/...` — slicing off `file://` gives the
    // path with a leading `/C:/`, which the file-open IPC tolerates after
    // a trim.
    const path = d.uri
      .replace(/^file:\/\//, "")
      .replace(/^\/([A-Za-z]):/, "$1:");
    revealAt(path, d.startLine, d.startCol).catch(() => {});
  };

  return (
    <div
      className="border-t border-noir-line bg-noir-panel/95 flex flex-col h-[220px] shrink-0"
      role="region"
      aria-label="Problems panel"
    >
      <div className="h-7 flex items-center gap-2 px-3 border-b border-noir-line/60 bg-noir-chrome/60 select-none" role="toolbar" aria-label="Problems toolbar">
        <h2 className="font-sans text-[11px] uppercase tracking-wider text-noir-mute m-0">
          Problems
        </h2>
        <span
          className="text-[11px] text-noir-subtext font-mono"
          role="status"
          aria-live="polite"
          aria-label={total === 0 ? "No problems" : `${total} ${total === 1 ? "problem" : "problems"}`}
        >
          {total === 0 ? "none" : `${total} item${total === 1 ? "" : "s"}`}
        </span>
        <div className="flex-1" />
        {/* Batch actions: send every diagnostic to chat or agent in one
            click. Cheaper than the per-row buttons when the user wants
            to bring the agent in to do a wider sweep. Hidden when
            there's nothing to send so the toolbar stays light. */}
        {total > 0 && (
          <>
            <button
              onClick={() =>
                sendAllDiagnosticsToAI("chat").catch(() => {})
              }
              className="text-[10.5px] font-sans px-1.5 py-0.5 rounded text-noir-subtext hover:text-noir-accent hover:bg-noir-ridge/60 inline-flex items-center gap-1"
              title={
                chatUsable
                  ? `Attach all ${total} diagnostics to chat`
                  : "Chat isn't ready, but you can still stage diagnostics."
              }
              aria-label={
                chatUsable
                  ? `Attach all ${total} diagnostics to chat`
                  : "Stage all diagnostics for chat (chat is not ready)"
              }
            >
              <MessageSquare size={10} aria-hidden="true" /> All → Chat
            </button>
            <button
              onClick={() =>
                sendAllDiagnosticsToAI("agent").catch(() => {})
              }
              className="text-[10.5px] font-sans px-1.5 py-0.5 rounded text-noir-subtext hover:text-noir-accent hover:bg-noir-ridge/60 inline-flex items-center gap-1"
              title={
                agentUsable
                  ? `Attach all ${total} diagnostics to agent`
                  : "Agent isn't ready, but you can still stage diagnostics."
              }
              aria-label={
                agentUsable
                  ? `Attach all ${total} diagnostics to agent`
                  : "Stage all diagnostics for agent (agent is not ready)"
              }
            >
              <Bot size={10} aria-hidden="true" /> All → Agent
            </button>
            <span className="w-px h-3 bg-noir-line/60 mx-1" aria-hidden="true" />
          </>
        )}
        <button
          onClick={onClose}
          className="p-1 rounded text-noir-subtext hover:text-noir-text hover:bg-noir-ridge/60"
          title="Hide Problems"
          aria-label="Hide problems panel"
        >
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {groups.length === 0 ? (
          <div className="px-4 py-3 text-[12px] text-noir-mute font-sans">
            No problems detected. Lint results from open files will appear here.
          </div>
        ) : (
          groups.map((g) => (
            <FileGroup key={g.uri} group={g} onReveal={reveal} />
          ))
        )}
      </div>
    </div>
  );
}

function FileGroup({
  group,
  onReveal,
}: {
  group: { uri: string; name: string; diags: Diagnostic[] };
  onReveal: (d: Diagnostic) => void;
}) {
  return (
    <div className="mb-1" role="group" aria-label={`${group.name}, ${group.diags.length} problem${group.diags.length === 1 ? "" : "s"}`}>
      <div className="px-3 py-1 flex items-center gap-2 text-[11.5px] text-noir-subtext font-mono">
        <FileIconFor name={group.name} size={11} className="shrink-0" />
        <span className="truncate">{group.name}</span>
        <span className="text-noir-mute text-[10.5px]" aria-hidden="true">
          {group.diags.length}
        </span>
      </div>
      {group.diags.map((d, i) => (
        <div
          key={`${d.startLine}:${d.startCol}:${i}`}
          className="w-full px-3 py-1 hover:bg-noir-ridge/60 flex items-start gap-2 group"
        >
          <button
            onClick={() => onReveal(d)}
            className="flex-1 min-w-0 text-left flex items-start gap-2"
            title="Open this location in the editor"
            aria-label={`${d.severity}: ${d.message} in ${group.name} at line ${d.startLine} column ${d.startCol}${d.code ? ` (${d.code})` : ""}`}
          >
            <SeverityIcon sev={d.severity} />
            <span className="flex-1 min-w-0 text-[11.5px] text-noir-text leading-snug">
              <span className="truncate">{d.message}</span>
              {d.code && (
                <span className="ml-2 text-[10px] text-noir-mute font-mono">
                  {d.code}
                </span>
              )}
            </span>
            <span className="shrink-0 text-[10.5px] text-noir-mute font-mono tabular-nums" aria-hidden="true">
              [{d.startLine}, {d.startCol}]
            </span>
            <span className="shrink-0 text-[10px] text-noir-mute font-mono uppercase tracking-wider opacity-0 group-hover:opacity-70" aria-hidden="true">
              {d.source}
            </span>
          </button>
          {/* Per-row send buttons — only visible on hover so a quiet
              Problems panel stays calm. Both actions short-circuit to
              the picker; no LLM round-trip until the user actually
              sends a message. */}
          <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <button
              onClick={(e) => {
                e.stopPropagation();
                sendDiagnosticToAI("chat", d).catch(() => {});
              }}
              className="p-1 rounded text-noir-subtext hover:text-noir-accent hover:bg-noir-ridge/80"
              title="Send to chat"
              aria-label="Send this diagnostic to chat"
            >
              <MessageSquare size={11} aria-hidden="true" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                sendDiagnosticToAI("agent", d).catch(() => {});
              }}
              className="p-1 rounded text-noir-subtext hover:text-noir-accent hover:bg-noir-ridge/80"
              title="Fix with agent"
              aria-label="Fix this diagnostic with agent"
            >
              <Sparkles size={11} aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SeverityIcon({ sev }: { sev: Diagnostic["severity"] }) {
  if (sev === "error")
    return (
      <AlertCircle
        size={12}
        className="text-noir-warn shrink-0 mt-[2px]"
        role="img"
        aria-label="Error"
      />
    );
  if (sev === "warning")
    return (
      <AlertTriangle
        size={12}
        className="text-amber-400 shrink-0 mt-[2px]"
        role="img"
        aria-label="Warning"
      />
    );
  return (
    <Info
      size={12}
      className="text-noir-subtext shrink-0 mt-[2px]"
      role="img"
      aria-label="Info"
    />
  );
}

function sevRank(s: Diagnostic["severity"]): number {
  switch (s) {
    case "error":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
    case "hint":
      return 0;
  }
}
