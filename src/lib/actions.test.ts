import { describe, expect, it, vi } from "vitest";
import { dispatchAction, onAction } from "@/lib/actions";

describe("action bus", () => {
  it("dispatches only matching action ids", () => {
    const openSettings = vi.fn();
    const openTerminal = vi.fn();
    const offSettings = onAction("settings:open", openSettings);
    const offTerminal = onAction("view:toggle_terminal", openTerminal);

    dispatchAction("settings:open");

    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(openTerminal).not.toHaveBeenCalled();

    offSettings();
    offTerminal();
  });

  it("unsubscribes cleanly", () => {
    const handler = vi.fn();
    const off = onAction("ai:assistant_ask", handler);

    off();
    dispatchAction("ai:assistant_ask");

    expect(handler).not.toHaveBeenCalled();
  });
});
