import { render as compatRender } from "preact/compat";
import { act } from "preact/test-utils";
import type { ComponentChild } from "preact";
import {
  fireEvent as domFireEvent,
  getQueriesForElement,
  prettyDOM,
  queries,
  type BoundFunctions,
  type Queries,
} from "@testing-library/dom";
export * from "@testing-library/dom";
export { act };

export const fireEvent = new Proxy(domFireEvent, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      let result: unknown;
      act(() => {
        result = value(...args);
      });
      return result;
    };
  },
}) as typeof domFireEvent;

type RenderOptions = {
  container?: HTMLElement;
  baseElement?: HTMLElement;
};

const mountedContainers = new Set<HTMLElement>();

export function render<Q extends Queries = typeof queries>(
  ui: ComponentChild,
  options: RenderOptions = {},
): {
  container: HTMLElement;
  baseElement: HTMLElement;
  debug: (el?: HTMLElement | DocumentFragment) => void;
  rerender: (nextUi: ComponentChild) => void;
  unmount: () => void;
} & BoundFunctions<Q> {
  const container =
    options.container ?? document.body.appendChild(document.createElement("div"));
  const baseElement = options.baseElement ?? container;
  mountedContainers.add(container);

  act(() => {
    compatRender(ui, container);
  });

  return {
    container,
    baseElement,
    debug: (el = baseElement) => {
      console.log(prettyDOM(el instanceof Element ? el : baseElement));
    },
    rerender: (nextUi) => {
      act(() => {
        compatRender(nextUi, container);
      });
    },
    unmount: () => {
      cleanupContainer(container);
    },
    ...(getQueriesForElement(baseElement) as BoundFunctions<Q>),
  };
}

export function cleanup() {
  for (const container of [...mountedContainers]) {
    cleanupContainer(container);
  }
}

function cleanupContainer(container: HTMLElement) {
  if (!mountedContainers.has(container)) return;
  act(() => {
    compatRender(null, container);
  });
  mountedContainers.delete(container);
  container.remove();
}

const maybeAfterEach = (globalThis as { afterEach?: (fn: () => void) => void })
  .afterEach;
if (typeof maybeAfterEach === "function") {
  maybeAfterEach(cleanup);
}
