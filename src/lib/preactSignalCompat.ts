import * as compat from "preact/compat";
import {
  batch,
  computed,
  effect,
  signal,
  untracked,
  useComputed,
  useSignal,
  useSignalEffect,
} from "@preact/signals";
import type {
  CSSProperties,
  DependencyList,
  Dispatch,
  EffectCallback,
  FunctionComponent,
  MutableRefObject,
  ReactNode,
  Ref,
  RefObject,
  SetStateAction,
} from "react";
import type * as ReactTypes from "react";

export {
  batch,
  computed,
  effect,
  signal,
  untracked,
  useComputed,
  useSignal,
  useSignalEffect,
};
export const Children = compat.Children;
export const Fragment = compat.Fragment;
export const StrictMode = compat.StrictMode;
export const Suspense = compat.Suspense as unknown as typeof ReactTypes.Suspense;
export const cloneElement = compat.cloneElement;
export const createContext = compat.createContext;
export const createElement = compat.createElement;
export const createRef = compat.createRef;
export const forwardRef = compat.forwardRef as unknown as typeof ReactTypes.forwardRef;
export const isValidElement = compat.isValidElement;
export const lazy = compat.lazy as unknown as typeof ReactTypes.lazy;
export const memo = compat.memo as unknown as typeof ReactTypes.memo;
export const startTransition = compat.startTransition;
export type {
  CSSProperties,
  DependencyList,
  Dispatch,
  EffectCallback,
  FunctionComponent,
  MutableRefObject,
  ReactNode,
  Ref,
  RefObject,
  SetStateAction,
};

type SignalRef<T> = MutableRefObject<T>;

function resolveInitialState<T>(initialState: T | (() => T)): T {
  return typeof initialState === "function" ? (initialState as () => T)() : initialState;
}

export function useSignalRef<T>(initialValue: T): SignalRef<T> {
  const stored = useSignal<T>(initialValue);
  const ref = compat.useMemo(
    () =>
      ({
        get current() {
          return stored.value;
        },
        set current(value: T) {
          stored.value = value;
        },
      }) as SignalRef<T>,
    [],
  );
  return ref;
}

export function useLiveSignal<T>(externalSignal: { value: T }): ReturnType<typeof useSignal<T>> {
  const local = useSignal<T>(externalSignal.value);
  useSignalEffect(() => {
    local.value = externalSignal.value;
  });
  return local;
}

export function useState<T>(initialState: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const value = useSignal<T>(undefined as T);
  const initialized = compat.useRef(false);
  const setterRef = compat.useRef<Dispatch<SetStateAction<T>>>();

  if (!initialized.current) {
    value.value = resolveInitialState(initialState);
    initialized.current = true;
  }

  if (!setterRef.current) {
    setterRef.current = (nextValue) => {
      batch(() => {
        value.value =
          typeof nextValue === "function"
            ? (nextValue as (previousValue: T) => T)(value.peek())
            : nextValue;
      });
    };
  }

  return [value.value, setterRef.current];
}

export function useRef<T>(initialValue: T): SignalRef<T>;
export function useRef<T>(initialValue: T | null): RefObject<T>;
export function useRef<T = undefined>(): MutableRefObject<T | undefined>;
export function useRef<T>(initialValue?: T) {
  return useSignalRef(initialValue as T);
}

export const useEffect = compat.useEffect;
export const useLayoutEffect = compat.useLayoutEffect;
export const useMemo = compat.useMemo;
export const useCallback = compat.useCallback;
export const useReducer = compat.useReducer;
export const useId = compat.useId;
export const useContext = compat.useContext;
export const useImperativeHandle = compat.useImperativeHandle;
export const useDebugValue = compat.useDebugValue;

const React = {
  ...compat,
  batch,
  computed,
  effect,
  signal,
  untracked,
  useCallback,
  useComputed,
  useContext,
  useDebugValue,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useLiveSignal,
  useMemo,
  useReducer,
  useRef,
  useSignal,
  useSignalEffect,
  useSignalRef,
  useState,
};

export default React;
