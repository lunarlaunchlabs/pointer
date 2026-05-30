/**
 * Popover primitive tests.
 *
 * The Popover is the foundation of every dropdown in Pointer. The
 * contract we lock in here:
 *
 *   1. The popover renders into `document.body` (escapes any stacking
 *      context / overflow-hidden ancestor).
 *   2. It only renders while `open=true`.
 *   3. The z-index applied matches the requested layer token.
 *   4. Outside-clicks close the popover; clicks inside the trigger or
 *      the popover content do not.
 *   5. Escape closes the popover.
 *
 * JSDOM doesn't paint, so we can't assert pixel-perfect placement —
 * but we *can* assert which CSS class controls placement (the layer
 * token, the z-index class) and the structural escape into body.
 */

import { useRef, useState } from "@/lib/preactSignalCompat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Popover, type PopoverLayer } from "./Popover";

function Host({
  layer = "panel-popover" as PopoverLayer,
  onClose,
  defaultOpen = true,
}: {
  layer?: PopoverLayer;
  onClose?: () => void;
  defaultOpen?: boolean;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div data-testid="host">
      <button ref={ref} data-testid="anchor" onClick={() => setOpen(true)}>
        trigger
      </button>
      <Popover
        anchorRef={ref}
        open={open}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        layer={layer}
        ariaLabel="Test popover"
      >
        <div data-testid="content">popover body</div>
      </Popover>
    </div>
  );
}

describe("Popover", () => {
  beforeEach(() => {
    // Each test starts with a clean body so we can detect portal mounts.
    document.body.innerHTML = "";
  });

  it("renders nothing when closed", () => {
    render(<Host defaultOpen={false} />);
    expect(screen.queryByTestId("content")).not.toBeInTheDocument();
  });

  it("portals the popover to document.body, not inside the host", () => {
    render(<Host />);
    const host = screen.getByTestId("host");
    const content = screen.getByTestId("content");
    // The portal lifts the popover out of its parent React subtree
    // entirely — the DOM ancestor of `content` is `document.body`,
    // never the host wrapper.
    expect(host.contains(content)).toBe(false);
    expect(document.body.contains(content)).toBe(true);
  });

  it("uses the requested z-index layer class", () => {
    render(<Host layer="context-menu" />);
    const content = screen.getByTestId("content");
    const surface = content.parentElement!;
    expect(surface.className).toMatch(/z-pn-context-menu/);
    // Stack layer is stamped onto a data attribute too — handy for the
    // big-picture layering test below.
    expect(surface.getAttribute("data-popover-layer")).toBe("context-menu");
  });

  it.each([
    ["panel-popover" as PopoverLayer, "z-pn-panel-popover"],
    ["titlebar-popover" as PopoverLayer, "z-pn-titlebar-popover"],
    ["modal-popover" as PopoverLayer, "z-pn-modal-popover"],
    ["context-menu" as PopoverLayer, "z-pn-context-menu"],
  ])("maps layer=%s to class %s", (layer, cls) => {
    render(<Host layer={layer} />);
    const surface = screen.getByTestId("content").parentElement!;
    expect(surface.className).toMatch(new RegExp(cls));
  });

  it("closes on outside click", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("does NOT close on click inside popover content", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const content = screen.getByTestId("content");
    fireEvent.mouseDown(content);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does NOT close on click on the trigger anchor", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const anchor = screen.getByTestId("anchor");
    fireEvent.mouseDown(anchor);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape key", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("applies fixed positioning so it escapes overflow/clip ancestors", () => {
    render(<Host />);
    const surface = screen.getByTestId("content").parentElement!;
    expect(surface.style.position).toBe("fixed");
  });
});
