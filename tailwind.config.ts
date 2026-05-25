import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Read from CSS variables so themes (Noir / Light) can swap
        // at runtime without rebuilding Tailwind. Legacy hex
        // fallbacks live in :root and body.pn-theme-light in
        // index.css; the values below are just the lookup keys.
        noir: {
          canvas: "var(--pn-canvas)",
          panel: "var(--pn-panel)",
          chrome: "var(--pn-chrome)",
          ridge: "var(--pn-ridge)",
          line: "var(--pn-line)",
          mute: "var(--pn-mute)",
          text: "var(--pn-text)",
          subtext: "var(--pn-subtext)",
          accent: "var(--pn-accent)",
          accentSoft: "#FF2D7E22",
          ok: "var(--pn-ok)",
          warn: "var(--pn-warn)",
          err: "var(--pn-err)",
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
        glow: "0 0 0 1px #FF2D7E33, 0 0 24px -4px #FF2D7E44",
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
