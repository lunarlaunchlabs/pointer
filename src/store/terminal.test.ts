/**
 * Terminal store tests.
 *
 * We focus on `nextTerminalTitle()` because it's the helper that
 * silently broke in the field: a synchronous call site reads
 * `tabs.length` before the in-flight `ipc.terminalOpen` resolves and
 * adds the tab to the store, so two calls can race and both produce
 * "Terminal 1". The monotonic counter is the fix; these tests pin
 * the contract so it can't regress.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetTerminalOrdinalForTests,
  nextTerminalTitle,
  useTerminals,
} from "./terminal";

function reset() {
  useTerminals.setState({ tabs: [], activeId: null, open: false });
  __resetTerminalOrdinalForTests();
}

describe("nextTerminalTitle", () => {
  beforeEach(reset);

  it("issues sequential titles starting at Terminal 1", () => {
    const a = nextTerminalTitle();
    const b = nextTerminalTitle();
    const c = nextTerminalTitle();
    expect(a.title).toBe("Terminal 1");
    expect(b.title).toBe("Terminal 2");
    expect(c.title).toBe("Terminal 3");
  });

  it("issues unique ids", () => {
    const a = nextTerminalTitle();
    const b = nextTerminalTitle();
    expect(a.id).not.toBe(b.id);
  });

  // Regression: the original implementation derived `n` from
  // `tabs.length + 1`. Two synchronous callers BEFORE either
  // `add()` ran would both see `tabs.length === 0` and produce
  // identical "Terminal 1" labels — the exact "two copies of
  // Terminal 1" the user reported. The monotonic counter must
  // give each caller a fresh ordinal even when the store hasn't
  // caught up yet.
  it("does not produce duplicate titles when called twice before the store is updated", () => {
    const first = nextTerminalTitle();
    const second = nextTerminalTitle();
    expect(first.title).not.toBe(second.title);
    expect(first.id).not.toBe(second.id);
  });

  // After a tab is closed, the next opened tab should NOT reuse the
  // freed ordinal (iTerm2 / VS Code parity). The ordinal counter
  // moves forward only.
  it("does not reuse ordinals from closed tabs", () => {
    const a = nextTerminalTitle();
    useTerminals.getState().add({
      id: a.id,
      title: a.title,
      shell: "zsh",
      cwd: "",
      exited: false,
      exitCode: null,
    });
    const b = nextTerminalTitle();
    useTerminals.getState().add({
      id: b.id,
      title: b.title,
      shell: "zsh",
      cwd: "",
      exited: false,
      exitCode: null,
    });
    useTerminals.getState().remove(a.id);
    const c = nextTerminalTitle();
    expect(c.title).toBe("Terminal 3");
  });

  // On hot-reload the module-level counter resets to 0 but the
  // persisted/store state may still have tabs from before. The next
  // title must clear those existing ordinals to avoid colliding
  // with a survivor.
  it("seeds the counter from existing tabs so it never collides on hot reload", () => {
    useTerminals.setState({
      tabs: [
        {
          id: "old-7",
          title: "Terminal 7",
          shell: "zsh",
          cwd: "",
          exited: false,
          exitCode: null,
        },
      ],
      activeId: "old-7",
      open: true,
    });
    __resetTerminalOrdinalForTests();
    const next = nextTerminalTitle();
    expect(next.title).toBe("Terminal 8");
  });
});
