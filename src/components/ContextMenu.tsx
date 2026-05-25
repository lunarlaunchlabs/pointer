import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { kind: "item"; label: string; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void; icon?: React.ReactNode }
  | { kind: "separator" };

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp to viewport so menus opened near the edges stay visible.
  const pad = 6;
  const w = 220;
  const left = Math.min(x, window.innerWidth - w - pad);
  const top = Math.min(y, window.innerHeight - 200);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Context menu"
      className="fixed z-pn-context-menu min-w-[220px] py-1 rounded-md border border-noir-line bg-noir-panel shadow-soft text-noir-text font-sans"
      style={{ left, top }}
    >
      {items.map((it, i) =>
        it.kind === "separator" ? (
          <div key={i} className="my-1 h-px bg-noir-line/60" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            onClick={() => {
              if (it.disabled) return;
              it.onSelect();
              onClose();
            }}
            disabled={it.disabled}
            aria-label={it.shortcut ? `${it.label} (${it.shortcut})` : it.label}
            className={`w-full flex items-center justify-between gap-3 px-3 py-1.5 text-[12px] text-left ${
              it.disabled
                ? "opacity-40 cursor-not-allowed"
                : it.danger
                ? "text-noir-err hover:bg-noir-err/15"
                : "hover:bg-noir-ridge"
            }`}
          >
            <span className="flex items-center gap-2">
              {it.icon && <span className="opacity-70" aria-hidden="true">{it.icon}</span>}
              {it.label}
            </span>
            {it.shortcut && (
              <kbd className="text-[10px] text-noir-mute">{it.shortcut}</kbd>
            )}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
