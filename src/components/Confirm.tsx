import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";

/**
 * In-app Confirm modal. Replaces `window.confirm()` so destructive prompts
 * actually look like part of Pointer instead of a 1995 OS dialog.
 *
 * The shape is intentionally minimal and imperative — call `confirm(opts)`
 * anywhere and `await` the boolean. State lives in a module-level signal so
 * callers don't need a React context.
 */

export type ConfirmOptions = {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, the confirm button is styled as destructive (red). */
  danger?: boolean;
  /** When set, the user must type this exact string to enable confirm. */
  confirmKeyword?: string;
};

type Pending = ConfirmOptions & {
  resolve: (v: boolean) => void;
};

// Module-level subscribers — we treat the modal host as a singleton mount in
// App.tsx so anyone can imperatively call `confirm(...)`.
type Listener = (p: Pending | null) => void;
const listeners = new Set<Listener>();
let current: Pending | null = null;

function setCurrent(p: Pending | null) {
  current = p;
  for (const l of listeners) l(p);
}

/** Imperative confirm. Resolves to true (confirmed) or false (cancelled). */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // If an earlier prompt is still on screen, queue: resolve the older one
    // as cancel to avoid stuck UI, then take over.
    if (current) current.resolve(false);
    setCurrent({ ...opts, resolve });
  });
}

/** Convenience hook so components can call `confirm` without importing twice. */
export function useConfirm() {
  return confirm;
}

/** Single mount point. Render once at the App root. */
export function ConfirmModalHost() {
  const [p, setP] = useState<Pending | null>(current);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const l: Listener = (next) => {
      setP(next);
      setTyped("");
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const cancel = useCallback(() => {
    if (!p) return;
    p.resolve(false);
    setCurrent(null);
  }, [p]);

  const confirmIt = useCallback(() => {
    if (!p) return;
    if (p.confirmKeyword && typed !== p.confirmKeyword) return;
    p.resolve(true);
    setCurrent(null);
  }, [p, typed]);

  useEffect(() => {
    if (!p) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        confirmIt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p, cancel, confirmIt]);

  if (!p) return null;
  const keywordOk = !p.confirmKeyword || typed === p.confirmKeyword;

  return createPortal(
    <div
      className="fixed inset-0 z-pn-modal flex items-center justify-center bg-black/60 backdrop-blur-md"
      onClick={cancel}
    >
      <div
        className="w-[440px] max-w-[92vw] rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={p.body ? "confirm-body" : undefined}
      >
        <header className="px-5 py-4 border-b border-noir-line flex items-start gap-3">
          {p.danger ? (
            <AlertTriangle
              size={16}
              className="text-noir-err shrink-0 mt-0.5"
              aria-hidden="true"
            />
          ) : (
            <span
              className="text-noir-accent text-xl leading-none shrink-0"
              aria-hidden="true"
            >
              ▸
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h3
              id="confirm-title"
              className="font-sans text-[14px] text-noir-text leading-tight"
            >
              {p.title}
            </h3>
          </div>
          <button
            onClick={cancel}
            className="p-1 -m-1 text-noir-mute hover:text-noir-text shrink-0"
            aria-label="Cancel"
            title="Cancel (Esc)"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </header>
        {p.body && (
          <div
            id="confirm-body"
            className="px-5 py-4 text-[12.5px] font-sans text-noir-subtext leading-relaxed"
          >
            {p.body}
          </div>
        )}
        {p.confirmKeyword && (
          <div className="px-5 pb-3">
            <label
              htmlFor="confirm-keyword-input"
              className="block text-[11px] font-sans text-noir-mute mb-1.5"
            >
              Type{" "}
              <code className="font-mono text-noir-text bg-noir-canvas/60 border border-noir-line/60 px-1 py-px rounded">
                {p.confirmKeyword}
              </code>{" "}
              to confirm
            </label>
            <input
              id="confirm-keyword-input"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="pn-input w-full font-mono"
              placeholder={p.confirmKeyword}
              aria-label={`Type ${p.confirmKeyword} to confirm`}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
        <footer className="px-5 py-3 bg-noir-chrome/60 border-t border-noir-line flex items-center justify-end gap-2">
          <button onClick={cancel} className="pn-button font-sans">
            {p.cancelLabel ?? "Cancel"}
          </button>
          <button
            onClick={confirmIt}
            disabled={!keywordOk}
            className={
              p.danger
                ? "pn-button font-sans !text-white disabled:opacity-40"
                : "pn-button-accent font-sans"
            }
            style={
              p.danger && keywordOk
                ? { background: "linear-gradient(180deg, #ff5673, #d4304a)" }
                : undefined
            }
          >
            {p.confirmLabel ?? "Confirm"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
