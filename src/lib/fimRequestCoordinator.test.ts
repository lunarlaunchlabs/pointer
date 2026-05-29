import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FimRequestCoordinator,
  type FimCancellationToken,
} from "./fimRequestCoordinator";

describe("FimRequestCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a debounced request when a newer keystroke replaces it", async () => {
    vi.useFakeTimers();
    const coordinator = new FimRequestCoordinator();
    const cancelled: string[] = [];

    const first = coordinator.request({
      debounceMs: 50,
      createRequestId: () => "first",
      cancelRequest: (id) => {
        cancelled.push(id);
      },
      generate: async () => "first suggestion",
    });
    const second = coordinator.request({
      debounceMs: 50,
      createRequestId: () => "second",
      cancelRequest: (id) => {
        cancelled.push(id);
      },
      generate: async () => "second suggestion",
    });

    await expect(first).resolves.toBe("");
    await vi.advanceTimersByTimeAsync(50);
    await expect(second).resolves.toBe("second suggestion");
    expect(cancelled).toEqual([]);
  });

  it("does not let stale Monaco cancellation cancel the newest FIM request", async () => {
    vi.useFakeTimers();
    const coordinator = new FimRequestCoordinator();
    const cancelled: string[] = [];
    const resolvers = new Map<string, (text: string) => void>();
    const oldToken = cancellableToken();
    const newToken = cancellableToken();
    let nextId = "old";

    const oldPromise = coordinator.request({
      debounceMs: 0,
      token: oldToken.token,
      createRequestId: () => nextId,
      cancelRequest: (id) => {
        cancelled.push(id);
      },
      generate: (id) =>
        new Promise<string>((resolve) => {
          resolvers.set(id, resolve);
        }),
    });
    await vi.runOnlyPendingTimersAsync();
    expect(resolvers.has("old")).toBe(true);

    nextId = "new";
    const newPromise = coordinator.request({
      debounceMs: 0,
      token: newToken.token,
      createRequestId: () => nextId,
      cancelRequest: (id) => {
        cancelled.push(id);
      },
      generate: (id) =>
        new Promise<string>((resolve) => {
          resolvers.set(id, resolve);
        }),
    });
    expect(cancelled).toEqual(["old"]);

    oldToken.cancel();
    expect(cancelled).toEqual(["old"]);

    await vi.runOnlyPendingTimersAsync();
    resolvers.get("new")?.("new suggestion");
    resolvers.get("old")?.("old suggestion");

    await expect(newPromise).resolves.toBe("new suggestion");
    await expect(oldPromise).resolves.toBe("");
  });

  it("does not let stale pre-debounce cancellation clear the newest timer", async () => {
    vi.useFakeTimers();
    const coordinator = new FimRequestCoordinator();
    const oldToken = cancellableToken();
    const newToken = cancellableToken();
    let nextId = "old";

    const oldPromise = coordinator.request({
      debounceMs: 100,
      token: oldToken.token,
      createRequestId: () => nextId,
      cancelRequest: () => {},
      generate: async () => "old suggestion",
    });

    nextId = "new";
    const newPromise = coordinator.request({
      debounceMs: 100,
      token: newToken.token,
      createRequestId: () => nextId,
      cancelRequest: () => {},
      generate: async () => "new suggestion",
    });

    await expect(oldPromise).resolves.toBe("");
    oldToken.cancel();
    await vi.advanceTimersByTimeAsync(100);
    await expect(newPromise).resolves.toBe("new suggestion");
  });

  it("cancels before debounce without running the model call", async () => {
    vi.useFakeTimers();
    const coordinator = new FimRequestCoordinator();
    const cancellation = cancellableToken();
    const generate = vi.fn(async () => "suggestion");

    const promise = coordinator.request({
      debounceMs: 100,
      token: cancellation.token,
      createRequestId: () => "request",
      cancelRequest: () => {},
      generate,
    });

    cancellation.cancel();
    await expect(promise).resolves.toBe("");
    await vi.advanceTimersByTimeAsync(100);
    expect(generate).not.toHaveBeenCalled();
  });
});

function cancellableToken(): {
  token: FimCancellationToken;
  cancel: () => void;
} {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener) {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
    },
    cancel: () => {
      cancelled = true;
      for (const listener of [...listeners]) listener();
    },
  };
}
