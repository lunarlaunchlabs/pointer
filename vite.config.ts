import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
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
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "esnext",
    sourcemap: true,
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
              id.includes("react/") ||
              id.includes("react-dom") ||
              id.includes("scheduler")
            ) {
              return "react-vendor";
            }
            if (
              id.includes("lucide-react") ||
              id.includes("cmdk") ||
              id.includes("zustand") ||
              id.includes("clsx") ||
              id.includes("nanoid")
            ) {
              return "ui-vendor";
            }
            return "vendor";
          }
        },
      },
    },
  },
}));
