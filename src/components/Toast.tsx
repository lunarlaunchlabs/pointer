import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

/**
 * Lightweight, non-blocking notification system.
 *
 * The host is mounted once at the App root. Anywhere in the app, call
 * `toast.success(msg)` / `toast.error(msg)` / `toast.info(msg)` to surface a
 * transient message. Each toast auto-dismisses after a few seconds unless
 * `sticky: true` is passed.
 *
 * Why a custom impl instead of a library? We already have a dark theme,
 * z-scale, and motion language — pulling in `react-hot-toast` or similar
 * doubles bundle size for visuals we'd override anyway.
 */

export type ToastKind = "info" | "success" | "warn" | "error";

type ToastEntry = {
  id: string;
  kind: ToastKind;
  title: string;
  body?: React.ReactNode;
  sticky?: boolean;
  durationMs: number;
  /** Optional inline action, e.g. "Undo". Fires once then dismisses. */
  action?: { label: string; onSelect: () => void };
};

type Listener = (entries: ToastEntry[]) => void;
const listeners = new Set<Listener>();
let queue: ToastEntry[] = [];

/** Permanent history of every toast the app has ever raised this
 *  session — drives the Notification Center panel. We cap at 200
 *  entries so a noisy app session can't balloon memory; the oldest
 *  fall off the bottom. Each entry has a `seen` flag the bell icon
 *  uses for the unread badge. */
export type ToastHistoryEntry = {
  id: string;
  kind: ToastKind;
  title: string;
  bodyText?: string;
  ts: number; // epoch ms
  seen: boolean;
};
const historyListeners = new Set<(h: ToastHistoryEntry[]) => void>();
let history: ToastHistoryEntry[] = [];

function emit() {
  for (const l of listeners) l(queue);
}
function emitHistory() {
  for (const l of historyListeners) l(history);
}

function bodyToString(body?: React.ReactNode): string | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (typeof body === "number") return String(body);
  return undefined; // skip JSX bodies in the history view
}

function push(kind: ToastKind, title: string, opts?: Partial<ToastEntry>): string {
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const entry: ToastEntry = {
    id,
    kind,
    title,
    body: opts?.body,
    sticky: opts?.sticky,
    durationMs: opts?.durationMs ?? (kind === "error" ? 8000 : 4000),
    action: opts?.action,
  };
  queue = [...queue, entry];
  emit();
  history = [
    {
      id,
      kind,
      title,
      bodyText: bodyToString(opts?.body),
      ts: Date.now(),
      seen: false,
    },
    ...history,
  ].slice(0, 200);
  emitHistory();
  if (!entry.sticky) {
    window.setTimeout(() => dismiss(id), entry.durationMs);
  }
  return id;
}

function dismiss(id: string) {
  queue = queue.filter((t) => t.id !== id);
  emit();
}

/** Subscribe to history changes — used by the Notification Center
 *  and the unread badge in the status bar. */
export function subscribeHistory(fn: (h: ToastHistoryEntry[]) => void): () => void {
  historyListeners.add(fn);
  fn(history);
  return () => historyListeners.delete(fn);
}

/** Mark every history entry as read (called when the Notification
 *  Center opens — same UX pattern as the macOS bell). */
export function markAllSeen(): void {
  if (history.every((h) => h.seen)) return;
  history = history.map((h) => ({ ...h, seen: true }));
  emitHistory();
}

/** Clear the entire history. Surfaces a tiny "cleared" toast so the
 *  user sees the action took effect. */
export function clearHistory(): void {
  history = [];
  emitHistory();
}

/** Imperative API. Use anywhere; no React context needed. */
export const toast = {
  info: (title: string, opts?: Partial<ToastEntry>) => push("info", title, opts),
  success: (title: string, opts?: Partial<ToastEntry>) =>
    push("success", title, opts),
  warn: (title: string, opts?: Partial<ToastEntry>) => push("warn", title, opts),
  error: (title: string, opts?: Partial<ToastEntry>) => push("error", title, opts),
  dismiss,
};

export function ToastHost() {
  const [entries, setEntries] = useState<ToastEntry[]>(queue);
  useEffect(() => {
    listeners.add(setEntries);
    return () => {
      listeners.delete(setEntries);
    };
  }, []);

  // The host always renders so screen readers can attach to the live
  // region once. Otherwise the region is added to the DOM only when
  // there's already content in it, which means assistive tech misses
  // the first announcement of a session.
  return createPortal(
    <div
      className="fixed right-4 bottom-10 z-pn-toast flex flex-col gap-2 pointer-events-none"
      role="region"
      aria-label="Notifications"
    >
      {/* Polite live region for non-critical updates. Errors get the
          assertive region below so screen readers interrupt for them. */}
      <div className="sr-only" aria-live="polite" aria-atomic="false">
        {entries
          .filter((e) => e.kind !== "error")
          .map((e) => e.title)
          .join(". ")}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="false">
        {entries
          .filter((e) => e.kind === "error")
          .map((e) => e.title)
          .join(". ")}
      </div>
      {entries.map((e) => (
        <ToastCard key={e.id} entry={e} />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({ entry }: { entry: ToastEntry }) {
  const palette: Record<ToastKind, { ring: string; icon: React.ReactNode }> = {
    info: {
      ring: "border-noir-line bg-noir-panel/95",
      icon: <Info size={13} className="text-noir-subtext" />,
    },
    success: {
      ring: "border-noir-ok/40 bg-noir-ok/[0.06]",
      icon: <CheckCircle2 size={13} className="text-noir-ok" />,
    },
    warn: {
      ring: "border-noir-warn/40 bg-noir-warn/[0.06]",
      icon: <AlertTriangle size={13} className="text-noir-warn" />,
    },
    error: {
      ring: "border-noir-err/40 bg-noir-err/[0.08]",
      icon: <XCircle size={13} className="text-noir-err" />,
    },
  };
  const p = palette[entry.kind];
  return (
    <div
      className={`pointer-events-auto w-[340px] max-w-[88vw] rounded-lg border ${p.ring} shadow-soft backdrop-blur-md px-3 py-2 flex items-start gap-2.5 font-sans`}
      role={entry.kind === "error" || entry.kind === "warn" ? "alert" : "status"}
    >
      <div className="mt-0.5 shrink-0" aria-hidden="true">
        {p.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-noir-text leading-snug">{entry.title}</div>
        {entry.body && (
          <div className="text-[11px] text-noir-subtext mt-0.5 leading-relaxed">
            {entry.body}
          </div>
        )}
        {entry.action && (
          <button
            onClick={() => {
              entry.action!.onSelect();
              dismiss(entry.id);
            }}
            className="mt-1 text-[11px] text-noir-accent hover:underline"
          >
            {entry.action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => dismiss(entry.id)}
        className="p-1 -m-1 text-noir-mute hover:text-noir-text shrink-0"
        aria-label={`Dismiss notification: ${entry.title}`}
        title="Dismiss"
      >
        <X size={11} aria-hidden="true" />
      </button>
    </div>
  );
}
