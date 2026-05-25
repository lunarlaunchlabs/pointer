/**
 * Vitest configuration.
 *
 * Lives in its own file (rather than nested inside `vite.config.ts`)
 * because the test-side configuration deliberately *avoids* the
 * `@vitejs/plugin-react` Babel transform and the Monaco code-splitting
 * — both are heavy and unnecessary for unit tests. Keeping the two
 * configs separate also means `vitest` boots in ~1s on cold start.
 *
 * Environment: jsdom, since most unit subjects touch the DOM (React
 * hooks, Zustand stores that listen to window events). For pure logic
 * tests (modelFitness, lang, capability gates) jsdom adds <50ms over
 * node and we keep one consistent environment across files.
 */

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    // Avoid the watcher picking up Rust target dirs during development.
    exclude: ["node_modules", "src-tauri/target/**", "dist/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
