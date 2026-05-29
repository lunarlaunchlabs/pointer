type TimerHandle = ReturnType<typeof setTimeout>;

export type FimCancellationToken = {
  readonly isCancellationRequested?: boolean;
  onCancellationRequested?: (listener: () => void) => { dispose?: () => void } | void;
};

export type FimRequestCoordinatorOptions = {
  debounceMs: number;
  token?: FimCancellationToken;
  createRequestId: () => string;
  cancelRequest: (requestId: string) => void | Promise<void>;
  generate: (requestId: string) => Promise<string>;
  setTimeoutFn?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
};

type PendingFimRequest = {
  id: string;
  cancel: () => void;
  disposeCancellation: () => void;
};

export class FimRequestCoordinator {
  private debounceTimer: TimerHandle | null = null;
  private debounceResolve: ((value: string) => void) | null = null;
  private debounceCancel: (() => void) | null = null;
  private debounceClearTimeout: (handle: TimerHandle) => void = clearTimeout;
  private pending: PendingFimRequest | null = null;
  private sequence = 0;

  async request(options: FimRequestCoordinatorOptions): Promise<string> {
    this.cancelDebounce();
    this.cancelPending();

    const sequence = ++this.sequence;
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    const token = options.token;
    this.debounceClearTimeout = clearTimeoutFn;

    return new Promise<string>((resolve) => {
      let settled = false;
      const settle = (value: string) => {
        if (settled) return;
        settled = true;
        if (this.debounceResolve === settle) this.debounceResolve = null;
        resolve(value);
      };

      this.debounceResolve = settle;

      let timer: TimerHandle | null = null;
      const cancelBeforeRun = registerFimCancellation(token, () => {
        if (sequence !== this.sequence) return;
        if (timer) {
          if (this.debounceTimer === timer) this.debounceTimer = null;
          clearTimeoutFn(timer);
          timer = null;
        }
        settle("");
      });
      this.debounceCancel = cancelBeforeRun;

      timer = setTimeoutFn(() => {
        this.debounceTimer = null;
        if (this.debounceResolve === settle) this.debounceResolve = null;
        if (this.debounceCancel === cancelBeforeRun) this.debounceCancel = null;
        cancelBeforeRun();

        if (token?.isCancellationRequested || sequence !== this.sequence) {
          settle("");
          return;
        }

        const id = options.createRequestId();
        const current: PendingFimRequest = {
          id,
          cancel: () => {
            void options.cancelRequest(id);
          },
          disposeCancellation: () => {},
        };
        this.pending = current;

        current.disposeCancellation = registerFimCancellation(token, () => {
          current.cancel();
        });

        options
          .generate(id)
          .then((text) => {
            const stillCurrent = this.pending?.id === id && sequence === this.sequence;
            settle(stillCurrent && !token?.isCancellationRequested ? text : "");
          })
          .catch(() => {
            settle("");
          })
          .finally(() => {
            current.disposeCancellation();
            if (this.pending?.id === id) this.pending = null;
          });
      }, Math.max(0, options.debounceMs));
      this.debounceTimer = timer;
    });
  }

  cancelAll(): void {
    this.sequence += 1;
    this.cancelDebounce();
    this.cancelPending();
  }

  private cancelDebounce(): void {
    const cancel = this.debounceCancel;
    this.debounceCancel = null;
    cancel?.();
    if (this.debounceTimer) {
      this.debounceClearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const resolve = this.debounceResolve;
    this.debounceResolve = null;
    resolve?.("");
  }

  private cancelPending(): void {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    pending.disposeCancellation();
    pending.cancel();
  }
}

function registerFimCancellation(
  token: FimCancellationToken | undefined,
  listener: () => void,
): () => void {
  const disposable = token?.onCancellationRequested?.(listener);
  return () => {
    disposable?.dispose?.();
  };
}
