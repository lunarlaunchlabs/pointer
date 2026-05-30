import type { Config } from "tailwindcss";

const pn = (name: string, fallback: string) =>
  `rgb(var(--pn-${name}-rgb, ${fallback}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Read from CSS variables so Pointer themes can swap
        // at runtime without rebuilding Tailwind. Legacy hex
        // fallbacks live in :root and body.pn-theme-light in
        // index.css; the values below are just the lookup keys.
        noir: {
          bg: pn("body-bg", "5 4 7"),
          canvas: pn("canvas", "8 7 11"),
          panel: pn("panel", "14 12 16"),
          chrome: pn("chrome", "21 18 26"),
          ridge: pn("ridge", "33 23 34"),
          line: pn("line", "67 34 56"),
          mute: pn("mute", "141 127 139"),
          text: pn("text", "242 237 245"),
          subtext: pn("subtext", "199 187 203"),
          accent: pn("accent", "255 45 126"),
          accentSoft: pn("accent", "255 45 126"),
          ok: pn("ok", "124 232 183"),
          warn: pn("warn", "255 211 122"),
          err: pn("err", "255 92 134"),
        },
        pn: {
          surface: pn("panel", "14 12 16"),
          "surface-2": pn("chrome", "21 18 26"),
          "surface-3": pn("ridge", "33 23 34"),
          border: pn("line", "67 34 56"),
          text: pn("text", "242 237 245"),
          "text-muted": pn("mute", "141 127 139"),
          danger: pn("err", "255 92 134"),
          accent: pn("accent", "255 45 126"),
          "accent-foreground": pn("canvas", "8 7 11"),
        },
      },
      fontFamily: {
        mono: [
          '"JetBrains Mono"',
          '"JetBrainsMono Nerd Font"',
          '"Fira Code"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
        sans: [
          '"Inter"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "sans-serif",
        ],
      },
      fontSize: {
        editor: ["14px", { lineHeight: "1.55", letterSpacing: "0" }],
      },
      boxShadow: {
        glow:
          "0 0 0 1px rgb(var(--pn-accent-rgb, 255 45 126) / 0.2), 0 0 24px -4px rgb(var(--pn-accent-rgb, 255 45 126) / 0.27)",
        soft: "0 1px 0 0 #ffffff08 inset, 0 8px 24px -12px #000",
      },
      backdropBlur: {
        xs: "2px",
      },
      // ──────────────────────────────────────────────────────────────────
      // Z-INDEX SCALE — single source of truth for stacking order.
      // Use these named layers via `z-pn-<layer>` instead of arbitrary
      // values. Higher numbers always win regardless of stacking context.
      //
      // CSS stacking traps to remember when adding a new overlay:
      //   - `backdrop-blur*`, `transform`, `filter`, `mix-blend-mode`,
      //     `opacity` (< 1), and any `will-change` of those properties all
      //     create new stacking contexts that *trap* `z-index` of
      //     descendants. The Titlebar, FileTree aside, and RightDock are
      //     blurred, and most modals also use `backdrop-blur-md`. Any
      //     popover whose visual extent must escape its blurred ancestor
      //     MUST be `createPortal`'d to `document.body` and use
      //     `position: fixed`. Otherwise it'll appear behind unrelated
      //     elements no matter how high its z-index is.
      //   - `overflow: auto/scroll/hidden` doesn't create a stacking
      //     context, but it *does* clip absolutely-positioned children. A
      //     dropdown anchored inside a scrolling container will visually
      //     truncate at the scroll boundary; portal it to escape.
      // ──────────────────────────────────────────────────────────────────
      //   dock-handle     : resize handles for side panels                10
      //   editor-overlay  : in-editor overlays (DiffOverlay)               20
      //   inline-edit     : Cmd+K floating widget                          25
      //   panel-popover   : dropdowns / pickers inline inside the right
      //                     dock & chat (chat session picker, agent model
      //                     picker, composer mentions). Safe because their
      //                     ancestors don't clip the visual extent.        30
      //   titlebar-popover: titlebar dropdowns (Models popover). Portaled
      //                     to body to escape the titlebar's blur.         50
      //   palette         : ⌘P / ⌘⇧P / FileFinder                          60
      //   modal           : centered modals (Onboarding, AIPanel modal,
      //                     SystemMonitor, Confirm)                        70
      //   modal-popover   : dropdowns invoked from inside a modal (e.g.
      //                     AIPanel Assignment pickers). MUST be portaled
      //                     to body and positioned with `fixed` because
      //                     modals use `backdrop-blur` *and* their bodies
      //                     scroll — both would otherwise clip the popover.80
      //   context-menu    : right-click menus — sits above modals so
      //                     in-modal right-clicks work                     90
      //   toast           : transient notifications — top of stack       100
      zIndex: {
        "pn-dock-handle": "10",
        "pn-editor-overlay": "20",
        "pn-inline-edit": "25",
        "pn-panel-popover": "30",
        "pn-titlebar-popover": "50",
        "pn-palette": "60",
        "pn-modal": "70",
        "pn-modal-popover": "80",
        "pn-context-menu": "90",
        "pn-toast": "100",
      },
    },
  },
  plugins: [],
} satisfies Config;
