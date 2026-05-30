import { useEffect, useState } from "@/lib/preactSignalCompat";
import { createPortal } from "@/lib/preactSignalDomCompat";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Info,
  Trash2,
  X,
  XCircle,
} from "@/lib/lucide";
import {
  clearHistory,
  markAllSeen,
  subscribeHistory,
  type ToastHistoryEntry,
} from "@/components/Toast";

/**
 * Notification Center — the macOS-bell-style flyout that lists
 * every toast Pointer has raised this session. Opens from the
 * status bar bell, closes on Esc / outside-click. Clearing wipes
 * the in-memory history; per-toast dismiss is a no-op since the
 * live overlay is what auto-expires.
 *
 * Implementation note: kept entirely client-side because toasts are
 * ephemeral UI events, not user-authored content. Persisting them
 * across launches would be misleading ("why does Pointer think it
 * had an error 3 days ago?").
 */
export function NotificationCenter({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<ToastHistoryEntry[]>([]);
  useEffect(() => {
    const unsub = subscribeHistory(setItems);
    markAllSeen();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unsub();
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-pn-modal flex items-start justify-end bg-black/30 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-center-title"
        className="mt-12 mr-3 w-[380px] max-w-[92vw] max-h-[70vh] rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden flex flex-col font-sans"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="h-9 px-3 flex items-center gap-2 border-b border-noir-line/60 bg-noir-chrome/70">
          <Bell size={12} className="text-noir-accent" aria-hidden="true" />
          <h2
            id="notification-center-title"
            className="text-[12px] text-noir-text m-0 font-normal"
          >
            Notifications
          </h2>
          <span className="text-[10px] text-noir-mute">
            {items.length} total
          </span>
          <div className="flex-1" />
          <button
            onClick={() => clearHistory()}
            disabled={items.length === 0}
            className="text-[11px] text-noir-subtext hover:text-noir-text disabled:opacity-30 inline-flex items-center gap-1"
            title="Clear all notifications"
            aria-label="Clear all notifications"
          >
            <Trash2 size={11} aria-hidden="true" /> Clear
          </button>
          <button
            onClick={onClose}
            className="p-1 text-noir-mute hover:text-noir-text"
            aria-label="Close notifications"
            title="Close (Esc)"
          >
            <X size={11} aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-noir-mute">
              No notifications yet.
              <div className="text-[10.5px] text-noir-mute/70 mt-1">
                Toasts you've seen this session land here.
              </div>
            </div>
          ) : (
            <ul className="py-1" aria-label="Notification history">
              {items.map((it) => (
                <li
                  key={it.id}
                  className="px-3 py-2 border-b border-noir-line/40 last:border-b-0"
                >
                  <div className="flex items-start gap-2">
                    <KindIcon kind={it.kind} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] text-noir-text leading-snug">
                        <span className="sr-only">{labelForKind(it.kind)}: </span>
                        {it.title}
                      </div>
                      {it.bodyText && (
                        <div className="text-[11px] text-noir-subtext mt-0.5 leading-relaxed whitespace-pre-wrap break-words">
                          {it.bodyText}
                        </div>
                      )}
                      <div
                        className="text-[10px] text-noir-mute mt-1 tabular-nums"
                        title={new Date(it.ts).toLocaleString()}
                      >
                        {formatRelative(it.ts)}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function KindIcon({ kind }: { kind: ToastHistoryEntry["kind"] }) {
  const common = "shrink-0 mt-0.5";
  if (kind === "success")
    return (
      <CheckCircle2
        size={13}
        aria-hidden="true"
        className={`text-noir-ok ${common}`}
      />
    );
  if (kind === "warn")
    return (
      <AlertTriangle
        size={13}
        aria-hidden="true"
        className={`text-noir-warn ${common}`}
      />
    );
  if (kind === "error")
    return (
      <XCircle
        size={13}
        aria-hidden="true"
        className={`text-noir-err ${common}`}
      />
    );
  return (
    <Info size={13} aria-hidden="true" className={`text-noir-subtext ${common}`} />
  );
}

function labelForKind(kind: ToastHistoryEntry["kind"]): string {
  switch (kind) {
    case "success":
      return "Success";
    case "warn":
      return "Warning";
    case "error":
      return "Error";
    default:
      return "Info";
  }
}

function formatRelative(ts: number): string {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
