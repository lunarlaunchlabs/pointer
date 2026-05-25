/**
 * Integration check: the MentionPicker, when used inside a hostile
 * (blurred + clipped) parent — exactly the production environment
 * provided by RightDock + PanelContainer — still:
 *
 *   1. Renders its content into document.body (not into the clipped
 *      ancestor).
 *   2. Lives in the panel-popover layer.
 *   3. Reaches its content via the testing library queries (proving
 *      that user-facing assertions don't care about the portal).
 *
 * This is the "real" smoke test for the z-index work: it would fail
 * before the portal refactor (the popover would render inside the
 * overflow-hidden / backdrop-blur wrapper), and pass after.
 */

import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MentionPicker } from "./MentionPicker";

function HostileEnvironment() {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  return (
    <div
      className="backdrop-blur-md overflow-hidden"
      data-testid="hostile-host"
      style={{ width: 300, height: 200 }}
    >
      <textarea ref={ref} data-testid="composer-anchor" />
      <MentionPicker
        anchorRef={ref}
        query=""
        fileCandidates={[]}
        diagnostics={[]}
        hasSelection={false}
        codebaseUsable
        attached={[]}
        onPick={() => {}}
        onClose={() => {}}
      />
    </div>
  );
}

describe("MentionPicker inside a blurred / overflow-hidden ancestor", () => {
  it("escapes the hostile ancestor via portaling to body", () => {
    render(<HostileEnvironment />);
    const host = screen.getByTestId("hostile-host");
    // @file row exists when the picker is rendering its category list.
    const fileRow = screen.getByText("@file");
    // Walk up to the popover surface (the element carrying the
    // data-popover-layer attribute).
    let cur: HTMLElement | null = fileRow;
    while (cur && !cur.dataset?.popoverLayer) cur = cur.parentElement;
    expect(cur, "popover surface not found").not.toBeNull();
    // The popover surface must NOT live under the hostile ancestor —
    // that's the whole point of the portal.
    expect(host.contains(cur!)).toBe(false);
    expect(document.body.contains(cur!)).toBe(true);
    expect(cur!.dataset.popoverLayer).toBe("panel-popover");
    expect(cur!.style.position).toBe("fixed");
  });
});
