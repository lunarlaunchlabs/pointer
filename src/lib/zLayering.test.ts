/**
 * Z-index layering contract — the single source of truth for how
 * Pointer's overlays stack on top of each other.
 *
 * This test pulls the actual `zIndex` values out of the Tailwind
 * config (so the scale and the test can never drift) and asserts:
 *
 *   • The named layers ascend in the documented order.
 *   • Every legitimate stack relationship holds (toast > context-menu,
 *     context-menu > modal, modal-popover > modal, etc.).
 *   • No two layers collide.
 *   • A grep of the source code finds *only* layer tokens (no raw
 *     `z-10` / `z-[N]` / inline `zIndex` numerics for overlays). The
 *     editor scrollbars and similar in-flow widgets that don't
 *     overlap our chrome are exempt.
 *
 * Treat this file as the authoritative ordering. When a new overlay
 * needs to be added:
 *   1. Pick the right token (or add a new one to tailwind.config.ts).
 *   2. Extend the ORDER and EXPECTED arrays here.
 *   3. Use the token (`z-pn-<layer>`) on the surface.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindConfig from "../../tailwind.config";

// The scale's intended ascending order. Higher index = paints on top.
const ORDER = [
  "pn-dock-handle",
  "pn-editor-overlay",
  "pn-inline-edit",
  "pn-panel-popover",
  "pn-titlebar-popover",
  "pn-palette",
  "pn-modal",
  "pn-modal-popover",
  "pn-context-menu",
  "pn-toast",
] as const;

type LayerName = (typeof ORDER)[number];

// The exact numeric values we expect from the Tailwind config. Keeping
// these inline (not derived) lets a code review catch any accidental
// value changes — a bumped number would land here as a failing test.
const EXPECTED: Record<LayerName, number> = {
  "pn-dock-handle": 10,
  "pn-editor-overlay": 20,
  "pn-inline-edit": 25,
  "pn-panel-popover": 30,
  "pn-titlebar-popover": 50,
  "pn-palette": 60,
  "pn-modal": 70,
  "pn-modal-popover": 80,
  "pn-context-menu": 90,
  "pn-toast": 100,
};

function configZ(): Record<string, string> {
  return (
    (tailwindConfig.theme?.extend?.zIndex as Record<string, string>) ?? {}
  );
}

describe("z-index scale", () => {
  it("defines every documented layer token", () => {
    const z = configZ();
    for (const layer of ORDER) {
      expect(z[layer], `missing token ${layer}`).toBeDefined();
    }
  });

  it("uses the documented numeric values", () => {
    const z = configZ();
    for (const layer of ORDER) {
      expect(parseInt(z[layer], 10)).toBe(EXPECTED[layer]);
    }
  });

  it("strictly ascends in documented order", () => {
    const z = configZ();
    let prev = -Infinity;
    for (const layer of ORDER) {
      const v = parseInt(z[layer], 10);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("has unique numeric values (no two layers collide)", () => {
    const z = configZ();
    const values = ORDER.map((l) => parseInt(z[l], 10));
    expect(new Set(values).size).toBe(values.length);
  });

  // The next set of assertions encodes the *intent* of the scale —
  // these relationships are what the user actually feels. If somebody
  // reorders the scale, these are the safety net.
  const z = configZ();
  const v = (k: LayerName) => parseInt(z[k], 10);

  it("toasts always paint above everything (last-write-wins UI)", () => {
    for (const layer of ORDER) {
      if (layer === "pn-toast") continue;
      expect(v("pn-toast")).toBeGreaterThan(v(layer));
    }
  });

  it("context-menu paints above modals so in-modal right-click works", () => {
    expect(v("pn-context-menu")).toBeGreaterThan(v("pn-modal"));
    expect(v("pn-context-menu")).toBeGreaterThan(v("pn-modal-popover"));
  });

  it("modal-popover (assignment pickers) paints above the modal body", () => {
    expect(v("pn-modal-popover")).toBeGreaterThan(v("pn-modal"));
  });

  it("modals paint above the command palette", () => {
    expect(v("pn-modal")).toBeGreaterThan(v("pn-palette"));
  });

  it("titlebar popovers paint above the editor / panel chrome", () => {
    expect(v("pn-titlebar-popover")).toBeGreaterThan(v("pn-panel-popover"));
    expect(v("pn-titlebar-popover")).toBeGreaterThan(v("pn-editor-overlay"));
    expect(v("pn-titlebar-popover")).toBeGreaterThan(v("pn-inline-edit"));
  });

  it("inline-edit paints above the diff overlay", () => {
    expect(v("pn-inline-edit")).toBeGreaterThan(v("pn-editor-overlay"));
  });
});

describe("source code uses only the named scale", () => {
  // Grep every component for raw z-* utilities. The only legitimate
  // uses are: `z-pn-*` (the named scale) and Monaco internals (which
  // don't go through Tailwind). This guard catches accidental
  // regressions where a developer types `className="… z-50 …"`.
  const SRC = resolve(__dirname, "..");
  const FILES = [
    "components/Editor.tsx",
    "components/Mention/MentionPicker.tsx",
    "components/Chat/AgentPanel.tsx",
    "components/Chat/Sidebar.tsx",
    "components/Titlebar.tsx",
    "components/AIPanel.tsx",
    "components/RightDock.tsx",
    "components/FileFinder.tsx",
    "components/CommandPalette.tsx",
    "components/SystemMonitor.tsx",
    "components/FindInFiles.tsx",
    "components/Toast.tsx",
    "components/Onboarding/Wizard.tsx",
    "components/Confirm.tsx",
    "components/DiffOverlay.tsx",
    "components/ContextMenu.tsx",
    "components/InlineEdit.tsx",
    "components/Popover.tsx",
    "components/StatusBar.tsx",
    "components/Welcome.tsx",
    "components/Problems/ProblemsPanel.tsx",
  ];

  // Match any literal Tailwind z utility (z-0, z-50, z-[123]) but
  // NOT the named scale (z-pn-*). The negative lookahead `(?!pn-)`
  // is what enforces "only named layers".
  const RAW_Z = /\bz-(?!pn-)(?:\[[^\]]+\]|\d+|auto)\b/;

  // Strip JS / TS / JSX comments before scanning so a sentence like
  // "the stacking context itself sits at z-auto" inside a doc
  // comment doesn't trip the guard. Crude but adequate for our
  // hand-authored sources.
  const stripComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      .replace(/(^|[^:/])\/\/[^\n]*/g, "$1"); // line comments (preserve URLs)

  it.each(FILES)("does not introduce a raw z utility (%s)", (rel) => {
    let src = "";
    try {
      src = readFileSync(resolve(SRC, rel), "utf-8");
    } catch {
      // File may not exist on every branch; skip rather than fail.
      return;
    }
    const code = stripComments(src);
    expect(
      RAW_Z.test(code),
      `Found a raw \`z-*\` utility in ${rel}. Use \`z-pn-<layer>\` instead.`,
    ).toBe(false);
  });

  // Inline numeric zIndex is even more dangerous — it bypasses
  // Tailwind entirely. We allow the Popover primitive to use it once
  // (for its `position: fixed` style block) BUT it only ever sets
  // class names, not numeric values. Sweep every component file.
  it.each(FILES)("does not set a numeric inline zIndex (%s)", (rel) => {
    let src = "";
    try {
      src = readFileSync(resolve(SRC, rel), "utf-8");
    } catch {
      return;
    }
    const code = stripComments(src);
    // Match `zIndex: 123` / `"zIndex": 123` / `'zIndex': 123` style
    // settings — but allow `zIndex: "var(--…)"` and `zIndex: foo`
    // (variable assignments which the developer must have audited).
    const INLINE_NUMERIC = /zIndex\s*:\s*\d/;
    expect(
      INLINE_NUMERIC.test(code),
      `Inline numeric zIndex in ${rel}. Use a Tailwind layer class.`,
    ).toBe(false);
  });
});
