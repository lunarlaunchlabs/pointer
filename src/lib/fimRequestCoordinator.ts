type TimerHandle = ReturnType<typeof setTimeout>;

export type FimCancellationToken = {
  readonly isCancellationRequested?: boolean;
  onCancellationRequested?: (listener: () => void) => { dispose?: () => void } | void;
};

export type FimRequestCoordinatorOptions = {
  debounceMs: number;
  fingerprint?: string;
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
};

type SharedFimRequest = {
  fingerprint: string;
  promise: Promise<string>;
};

export class FimRequestCoordinator {
  private debounceTimer: TimerHandle | null = null;
  private debounceResolve: ((value: string) => void) | null = null;
  private debounceClearTimeout: (handle: TimerHandle) => void = clearTimeout;
  private pending: PendingFimRequest | null = null;
  private shared: SharedFimRequest | null = null;
  private sequence = 0;

  async request(options: FimRequestCoordinatorOptions): Promise<string> {
    if (
      options.fingerprint &&
      this.shared?.fingerprint === options.fingerprint
    ) {
      return this.shared.promise;
    }

    this.cancelDebounce();
    this.cancelPending();
    this.shared = null;

    const sequence = ++this.sequence;
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.debounceClearTimeout = clearTimeoutFn;

    const promise = new Promise<string>((resolve) => {
      let settled = false;
      const settle = (value: string) => {
        if (settled) return;
        settled = true;
        if (this.debounceResolve === settle) this.debounceResolve = null;
        resolve(value);
      };

      this.debounceResolve = settle;

      let timer: TimerHandle | null = null;

      timer = setTimeoutFn(() => {
        this.debounceTimer = null;
        if (this.debounceResolve === settle) this.debounceResolve = null;

        if (sequence !== this.sequence) {
          settle("");
          return;
        }

        const id = options.createRequestId();
        const current: PendingFimRequest = {
          id,
          cancel: () => {
            void options.cancelRequest(id);
          },
        };
        this.pending = current;

        options
          .generate(id)
          .then((text) => {
            const stillCurrent =
              this.pending?.id === id && sequence === this.sequence;
            settle(stillCurrent ? text : "");
          })
          .catch(() => {
            settle("");
          })
          .finally(() => {
            if (this.pending?.id === id) this.pending = null;
          });
      }, Math.max(0, options.debounceMs));
      this.debounceTimer = timer;
    });

    if (options.fingerprint) {
      const shared = {
        fingerprint: options.fingerprint,
        promise,
      };
      this.shared = shared;
      void promise.finally(() => {
        if (this.shared === shared) this.shared = null;
      });
    }

    return promise;
  }

  cancelAll(): void {
    this.sequence += 1;
    this.shared = null;
    this.cancelDebounce();
    this.cancelPending();
  }

  private cancelDebounce(): void {
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
    pending.cancel();
  }
}
