/**
 * Send-to-AI routing.
 *
 * Provides a single funnel that any UI surface (editor context menu,
 * Monaco code action, Problems panel button, etc.) can call to stage a
 * reference on the unified Assistant and route the user to the right
 * dock view. Centralising the side-effects here keeps callers small and
 * keeps the cross-store wiring out of components that have no business
 * knowing about Zustand stores.
 *
 * Two flavours:
 *   • `sendSelectionToAI` — wrap an arbitrary editor selection.
 *   • `sendDiagnosticToAI` — wrap a Monaco marker with its snippet.
 *
 * `target` is now an `AssistantMode` ("ask" | "plan" | "agent") rather
 * than the old "chat"/"agent" pair. The two old aliases are still
 * accepted for one release so any caller we haven't migrated keeps
 * working: "chat" maps to "ask", "agent" stays "agent".
 */

import type { Reference } from "@/store/chat";
import { useAssistant, type AssistantMode } from "@/store/assistant";
import { useSettings } from "@/store/settings";
import { useSession } from "@/store/session";
import { useDiagnostics, type Diagnostic } from "@/store/diagnostics";
import type { Breakpoint, DebugValue } from "@/store/debugger";
import { ipc } from "@/lib/ipc";
import { toast } from "@/components/Toast";

export type AiTarget = AssistantMode | "chat";

function normaliseTarget(t: AiTarget): AssistantMode {
  // "chat" is the historical name for what's now "ask" — keep the
  // alias so external callers don't break in this release. Plan and
  // Agent pass through unchanged.
  return t === "chat" ? "ask" : t;
}

/** Stage an editor selection as a reference on the chosen target and
 *  open that dock view. The textarea is left untouched — the chip just
 *  appears above it. */
export function sendSelectionToAI(
  target: AiTarget,
  selection: {
    path: string;
    startLine: number;
    endLine: number;
    text: string;
  },
) {
  const ref: Reference = {
    kind: "selection",
    path: selection.path,
    startLine: selection.startLine,
    endLine: selection.endLine,
    text: selection.text,
  };
  return stage(target, ref, "selection");
}

/** Stage a Monaco diagnostic on the chosen target. We pull the offending
 *  lines off disk so the model has something to quote, falling back to
 *  the message alone if the read fails (file moved, etc.). */
export async function sendDiagnosticToAI(
  target: AiTarget,
  diagnostic: Diagnostic,
) {
  const path = uriToPath(diagnostic.uri);
  let snippet = "";
  try {
    const src = await ipc.readTextFile(path);
    snippet = lineRange(src, diagnostic.startLine, diagnostic.endLine);
  } catch {
    /* fall through with empty snippet */
  }
  const ref: Reference = {
    kind: "diagnostic",
    path,
    startLine: diagnostic.startLine,
    startCol: diagnostic.startCol,
    endLine: diagnostic.endLine,
    endCol: diagnostic.endCol,
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source,
    code: diagnostic.code,
    snippet,
  };
  return stage(
    target,
    ref,
    `${diagnostic.severity} in ${diagnostic.name}:${diagnostic.startLine}`,
  );
}

/** Stage all current Monaco diagnostics in a single batch — useful when
 *  the user asks the agent to "fix everything". Returns the count of
 *  diagnostics actually attached (deduplicated by URI+line+code). */
export async function sendAllDiagnosticsToAI(target: AiTarget): Promise<number> {
  const all = Object.values(useDiagnostics.getState().byUri).flat();
  // Dedup so multiple identical lint markers don't double-pile the chip
  // list (e.g. ESLint + tsserver flagging the same line).
  const seen = new Set<string>();
  const unique = all.filter((d) => {
    const key = `${d.uri}:${d.startLine}:${d.code ?? ""}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const d of unique) {
    await sendDiagnosticToAI(target, d);
  }
  return unique.length;
}

/** Stage an editor/debugger breakpoint on the chosen Assistant mode. */
export function sendBreakpointToAI(target: AiTarget, breakpoint: Breakpoint) {
  const ref: Reference = {
    kind: "breakpoint",
    path: breakpoint.path,
    line: breakpoint.line,
    column: breakpoint.column,
    enabled: breakpoint.enabled,
    condition: breakpoint.condition,
    logMessage: breakpoint.logMessage,
  };
  return stage(
    target,
    ref,
    `breakpoint ${shortPath(breakpoint.path)}:${breakpoint.line}`,
  );
}

/** Stage a captured debugger/watch value on the chosen Assistant mode. */
export function sendDebugValueToAI(target: AiTarget, value: DebugValue) {
  const ref: Reference = {
    kind: "debugValue",
    name: value.name,
    value: value.value,
    type: value.type,
    path: value.path,
    line: value.line,
    scope: value.scope,
    frame: value.frame,
    thread: value.thread,
  };
  return stage(target, ref, `debug value ${value.name}`);
}

// ──────────────────────────────────────────────────────────────────────
// Internal: route the ref to the right store + dock view + toast.
// ──────────────────────────────────────────────────────────────────────

export function sendReferenceToAI(target: AiTarget, ref: Reference, what = ref.kind) {
  return stage(target, ref, what);
}

function stage(target: AiTarget, ref: Reference, what: string) {
  const mode = normaliseTarget(target);
  const assistant = useAssistant.getState();
  // Ensure there's an active session in the requested mode. Creating
  // a new session if the active one is busy keeps a chip from landing
  // mid-stream where the user can't see it.
  const settings = useSettings.getState();
  const model = settings.chatModel;
  const active = assistant.getActive();
  if (!active || active.status === "running") {
    assistant.newSession({ mode, model });
  } else if (active.mode !== mode) {
    assistant.setSessionMode(active.id, mode);
  }
  assistant.addRef(ref);
  useSession.getState().noteDockView("assistant");
  toast.info(`Sent to ${mode}`, {
    body: `Attached ${what}. Add a prompt below and send.`,
  });
}

function uriToPath(uri: string): string {
  return uri.replace(/^file:\/\//, "").replace(/^\/([A-Za-z]):/, "$1:");
}

function lineRange(src: string, startLine: number, endLine: number): string {
  const lines = src.split(/\r?\n/);
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, endLine);
  return lines.slice(from, to).join("\n");
}

function shortPath(path: string): string {
  return path.split(/[\\/]/).slice(-2).join("/");
}
