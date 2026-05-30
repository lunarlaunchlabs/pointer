import { batch, signal, useSignal, useSignalEffect } from "@preact/signals";

type PartialState<T> = Partial<T> | T;
type StateCreator<T> = (
  set: StoreApi<T>["setState"],
  get: StoreApi<T>["getState"],
  api: StoreApi<T>,
) => T;
type Listener<T> = (state: T, previousState: T) => void;

export type StoreApi<T> = {
  setState: (
    partial: PartialState<T> | ((state: T) => PartialState<T>),
    replace?: boolean,
  ) => void;
  getState: () => T;
  getInitialState: () => T;
  subscribe: (listener: Listener<T>) => () => void;
};

export type UseSignalStore<T> = {
  (): T;
  <U>(selector: (state: T) => U): U;
} & StoreApi<T>;

export function create<T>(creator: StateCreator<T>): UseSignalStore<T> {
  const stateSignal = signal<T>(undefined as T);
  const listeners = new Set<Listener<T>>();
  let initialState: T;

  const api: StoreApi<T> = {
    setState(partial, replace) {
      const previous = stateSignal.peek();
      const partialState =
        typeof partial === "function"
          ? (partial as (state: T) => PartialState<T>)(previous)
          : partial;
      const next =
        replace || !isPlainObject(partialState)
          ? (partialState as T)
          : ({ ...(previous as object), ...(partialState as object) } as T);
      if (Object.is(next, previous)) return;
      batch(() => {
        stateSignal.value = next;
        for (const listener of listeners) listener(next, previous);
      });
    },
    getState() {
      return stateSignal.peek();
    },
    getInitialState() {
      return initialState;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  initialState = creator(api.setState, api.getState, api);
  stateSignal.value = initialState;

  function useStore<U>(selector?: (state: T) => U): T | U {
    const select = selector ?? ((state: T) => state as unknown as U);
    const selected = useSignal(select(stateSignal.peek()));
    useSignalEffect(() => {
      const next = select(stateSignal.value);
      if (!Object.is(selected.peek(), next)) {
        selected.value = next;
      }
    });
    return selected.value;
  }

  return Object.assign(useStore, api) as UseSignalStore<T>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
