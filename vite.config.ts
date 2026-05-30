import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;
const sourcemap = process.env.POINTER_SOURCEMAPS === "1";

export default defineConfig(async () => ({
  plugins: [preact()],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      { find: "react/jsx-runtime", replacement: "preact/compat/jsx-runtime" },
      { find: "react/jsx-dev-runtime", replacement: "preact/compat/jsx-dev-runtime" },
      { find: "react-dom/client", replacement: "preact/compat/client" },
      { find: "react-dom/test-utils", replacement: "preact/test-utils" },
      { find: "react-dom", replacement: "preact/compat" },
      { find: "react", replacement: "preact/compat" },
    ],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: [
        "**/.git/**",
        "**/dist/**",
        "**/src-tauri/**",
        "**/target/**",
      ],
    },
  },
  optimizeDeps: {
    exclude: ["shiki", "@shikijs/monaco", "@shikijs/vscode-textmate"],
  },
  build: {
    target: "esnext",
    sourcemap,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const normalizedId = id.split(path.sep).join("/");
          if (id.includes("node_modules")) {
            if (normalizedId.includes("node_modules/monaco-editor/")) {
              if (
                normalizedId.includes("/esm/vs/basic-languages/") ||
                normalizedId.includes("/esm/vs/language/")
              ) {
                return undefined;
              }
              return "monaco";
            }
            if (id.includes("@monaco-editor/react")) {
              return "monaco";
            }
            if (id.includes("@xterm/")) return "terminal-vendor";
            if (id.includes("@tauri-apps/")) return "tauri-vendor";
            if (
              id.includes("preact/") ||
              id.includes("@preact/")
            ) {
              return "preact-vendor";
            }
            if (
              id.includes("/node_modules/shiki/") ||
              id.includes("/node_modules/@shikijs/")
            ) {
              return "shiki-vendor";
            }
            if (
              id.includes("/node_modules/react-markdown/") ||
              id.includes("/node_modules/remark-") ||
              id.includes("/node_modules/mdast-") ||
              id.includes("/node_modules/micromark") ||
              id.includes("/node_modules/unist-") ||
              id.includes("/node_modules/vfile")
            ) {
              return "markdown-vendor";
            }
            if (
              id.includes("lucide-preact") ||
              id.includes("cmdk") ||
              id.includes("clsx") ||
              id.includes("nanoid")
            ) {
              return "ui-vendor";
            }
          }
        },
      },
    },
  },
}));
