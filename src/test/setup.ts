/**
 * Vitest setup file.
 *
 * Runs once per worker before any test executes. We use it to:
 *  1. Enable React Testing Library's jest-dom matchers (toBeInTheDocument
 *     etc.) so component tests read naturally.
 *  2. Stub the Tauri IPC layer with a noisy default that fails the test
 *     if it's ever called without a per-test mock. That way no test
 *     accidentally hits the real backend and we get a clear stack trace
 *     pointing at the offending call.
 *  3. Polyfill the small bits of `globalThis` Zustand's store factory
 *     relies on (matchMedia, ResizeObserver) so importing a store at the
 *     top of a file doesn't immediately throw.
 */

import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// JSDOM doesn't ship `matchMedia` — some component effects guard on it
// even when the breakpoint logic isn't under test.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// ResizeObserver is used by xterm + Monaco. JSDOM lacks it; a noop stub is
// enough for component tests because we don't actually render those
// editors in unit tests.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver =
  window.ResizeObserver || (NoopResizeObserver as unknown as typeof ResizeObserver);

// JSDOM doesn't implement `Element.scrollIntoView`. Lots of our component
// effects call it (mention picker, problems panel, etc.) to keep the
// active row visible. A noop is safe — the visual side-effect simply
// doesn't happen, but the surrounding code keeps running.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function () {};
}

// Mock the Tauri IPC bridge. Tests that exercise IPC-heavy paths can
// override individual commands using `vi.mocked(ipc.xxx).mockResolvedValue`.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() =>
    Promise.reject(
      new Error(
        "Tauri invoke called from a unit test without a per-test mock. " +
          "Add `vi.mocked(...).mockResolvedValue(...)` in your test.",
      ),
    ),
  ),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
  save: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(() => Promise.resolve(undefined)),
}));
