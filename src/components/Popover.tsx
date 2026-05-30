/**
 * Portaled popover primitive.
 *
 * Every dropdown / picker / inline menu in Pointer needs to satisfy
 * the same constraints:
 *
 *   • Escape any blurred / transformed / overflow-hidden ancestor (the
 *     RightDock and FileTree both use `backdrop-blur-xs`, every modal
 *     uses `backdrop-blur-md`; all of those *trap* z-index, and the
 *     PanelContainer wraps its children in an `overflow-hidden` div
 *     which clips absolutely-positioned descendants).
 *   • Track an anchor element on resize / scroll so the popover stays
 *     glued to its trigger.
 *   • Pick a viewport-aware placement so it never goes off-screen.
 *   • Close on outside-click and Escape — but treat clicks inside the
 *     trigger AND inside the popover (different DOM subtrees thanks to
 *     the portal) as "still inside the widget".
 *
 * This component encodes all of that once so the chat session picker,
 * the agent model picker, the mention picker, and any future overlay
 * stay visually correct regardless of where they live in the tree.
 *
 * The Titlebar's Models popover follows the exact same pattern by
 * hand — that one's kept inline because it was the original reference
 * implementation and changing it carries a risk : reward we don't
 * need to take. New popovers should use this component.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "@/lib/preactSignalCompat";
import { createPortal } from "@/lib/preactSignalDomCompat";

/** The z-index "layer" a popover should occupy. Mirrors the named
 *  tokens defined in tailwind.config.ts so callers can pick the
 *  semantically correct one rather than guessing a number. */
export type PopoverLayer =
  | "panel-popover" // dropdowns inside the dock / sidebar (z=30)
  | "titlebar-popover" // dropdowns from the titlebar (z=50)
  | "modal-popover" // dropdowns *inside* an open modal (z=80)
  | "context-menu"; // right-click menus (z=90)

/** Where to place the popover vertically relative to the anchor.
 *  "auto" measures available viewport space and flips. */
export type PopoverPlacement = "up" | "down" | "auto";

/** How the popover's horizontal extent is anchored to the trigger.
 *  "start" left-aligns popover to anchor's left edge,
 *  "end" right-aligns popover to anchor's right edge,
 *  "match" sets the popover width to the anchor's width. */
export type PopoverAlign = "start" | "end" | "match";

export type PopoverProps = {
  /** Element the popover is glued to. Use a ref on the trigger button
   *  (or input) so resize / scroll re-measurement works. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Whether the popover is shown. Toggled by the caller. */
  open: boolean;
  /** Called when the user clicks outside both anchor and popover, or
   *  hits Escape. The caller should set its `open` state to false. */
  onClose: () => void;
  /** Vertical placement strategy. */
  placement?: PopoverPlacement;
  /** Horizontal alignment / width. */
  align?: PopoverAlign;
  /** Pixel gap between the anchor edge and the popover. */
  gap?: number;
  /** Override the popover width. Useful when `align !== "match"` and
   *  the natural content width is too narrow / wide. */
  width?: number;
  /** Max pixel height — caps tall popovers so they don't overflow
   *  the viewport. The popover scrolls internally if content exceeds. */
  maxHeight?: number;
  /** Stacking layer. Defaults to panel-popover; pick context-menu /
   *  modal-popover / titlebar-popover when appropriate. */
  layer?: PopoverLayer;
  /** Tailwind / CSS classes applied to the popover surface. We provide
   *  sensible visual defaults; pass an override for custom looks. */
  className?: string;
  /** Optional ARIA role override. Defaults to "menu" — change to
   *  "listbox" for autocomplete / selection lists. */
  role?: string;
  /** Optional ARIA label for screen readers. */
  ariaLabel?: string;
  children: React.ReactNode;
};

const LAYER_CLASS: Record<PopoverLayer, string> = {
  "panel-popover": "z-pn-panel-popover",
  "titlebar-popover": "z-pn-titlebar-popover",
  "modal-popover": "z-pn-modal-popover",
  "context-menu": "z-pn-context-menu",
};

const DEFAULT_SURFACE =
  "bg-noir-panel border border-noir-line rounded-md shadow-soft overflow-hidden font-sans";

export function Popover({
  anchorRef,
  open,
  onClose,
  placement = "auto",
  align = "match",
  gap = 4,
  width,
  maxHeight = 320,
  layer = "panel-popover",
  className,
  role = "menu",
  ariaLabel,
  children,
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    resolvedPlacement: "up" | "down";
  } | null>(null);

  /**
   * Re-measure the anchor's bounding rect and decide where the
   * popover goes. Called on open, on window resize, and on scroll
   * (capture phase) so scrolled containers don't desync.
   */
  const recompute = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const popH = popoverRef.current?.offsetHeight ?? maxHeight;
    // Choose placement.
    const roomAbove = r.top - gap;
    const roomBelow = vh - r.bottom - gap;
    const resolved =
      placement === "up"
        ? "up"
        : placement === "down"
        ? "down"
        : roomBelow >= popH || roomBelow >= roomAbove
        ? "down"
        : "up";
    // Compute width.
    const w = width ?? (align === "match" ? r.width : undefined) ?? 240;
    // Horizontal anchor.
    let left =
      align === "end"
        ? r.right - w
        : align === "match"
        ? r.left
        : r.left;
    // Clamp into viewport.
    left = Math.max(8, Math.min(left, vw - w - 8));
    // Vertical anchor + cap maxHeight to the available room.
    const cappedMaxH = Math.min(
      maxHeight,
      resolved === "down" ? roomBelow : roomAbove,
    );
    const top =
      resolved === "down"
        ? r.bottom + gap
        : Math.max(8, r.top - gap - Math.min(popH, cappedMaxH));
    setCoords({
      top,
      left,
      width: w,
      maxHeight: Math.max(120, cappedMaxH),
      resolvedPlacement: resolved,
    });
  }, [anchorRef, placement, align, gap, width, maxHeight]);

  // Measure on open / placement / size changes — useLayoutEffect so
  // the first paint happens at the right place (no flash of unstyled
  // popover at 0,0).
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    recompute();
  }, [open, recompute]);

  // Track resize / scroll so the popover stays glued.
  useEffect(() => {
    if (!open) return;
    const onResize = () => recompute();
    const onScroll = () => recompute();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, recompute]);

  // Click-outside + Escape. We treat any click inside the trigger or
  // the portaled popover as "inside the widget" so the user can
  // interact with both surfaces freely.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !coords) return null;

  const node = (
    <div
      ref={popoverRef}
      role={role}
      aria-label={ariaLabel}
      data-popover-layer={layer}
      style={{
        position: "fixed",
        top: coords.top,
        left: coords.left,
        width: coords.width,
        maxHeight: coords.maxHeight,
      }}
      className={`${LAYER_CLASS[layer]} ${DEFAULT_SURFACE} flex flex-col ${className ?? ""}`}
    >
      {children}
    </div>
  );

  return createPortal(node, document.body);
}
