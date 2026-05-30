import { useEffect, useRef } from "@/lib/preactSignalCompat";
import { createPortal } from "@/lib/preactSignalDomCompat";

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
  const itemRefs = useRef<HTMLButtonElement[]>([]);
  const enabledIndexes = items
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => it.kind === "item" && !it.disabled)
    .map(({ index }) => index);

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

  useEffect(() => {
    const first = enabledIndexes[0];
    if (first != null) {
      requestAnimationFrame(() => itemRefs.current[first]?.focus());
    }
    // Run only for this menu instance; changing focus while the user
    // navigates would be maddening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusRelative = (delta: number) => {
    if (enabledIndexes.length === 0) return;
    const active = document.activeElement;
    const current = itemRefs.current.findIndex((node) => node === active);
    const enabledPos = Math.max(0, enabledIndexes.indexOf(current));
    const next =
      enabledIndexes[
        (enabledPos + delta + enabledIndexes.length) % enabledIndexes.length
      ];
    itemRefs.current[next]?.focus();
  };

  // Clamp to viewport so menus opened near the edges stay visible.
  const pad = 6;
  const w = 220;
  const left = Math.max(pad, Math.min(x, window.innerWidth - w - pad));
  const top = Math.max(pad, Math.min(y, window.innerHeight - 200 - pad));

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Context menu"
      className="fixed z-pn-context-menu min-w-[220px] py-1 rounded-md border border-noir-line bg-noir-panel shadow-soft text-noir-text font-sans"
      style={{ left, top }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          focusRelative(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          focusRelative(-1);
        } else if (e.key === "Home") {
          e.preventDefault();
          itemRefs.current[enabledIndexes[0]]?.focus();
        } else if (e.key === "End") {
          e.preventDefault();
          itemRefs.current[enabledIndexes[enabledIndexes.length - 1]]?.focus();
        }
      }}
    >
      {items.map((it, i) =>
        it.kind === "separator" ? (
          <div key={i} className="my-1 h-px bg-noir-line/60" role="separator" />
        ) : (
          <button
            key={i}
            ref={(node) => {
              if (node) itemRefs.current[i] = node;
            }}
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
