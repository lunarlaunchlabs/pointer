import { createPortal as createPreactPortal } from "preact/compat";
import type { ReactNode } from "react";

export function createPortal(children: ReactNode, container: Element | DocumentFragment): ReactNode {
  return createPreactPortal(children as never, container) as never;
}
