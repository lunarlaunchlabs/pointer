/**
 * Vitest configuration.
 *
 * Lives in its own file (rather than nested inside `vite.config.ts`)
 * because the test-side configuration deliberately *avoids* the
 * the full app Monaco code-splitting
 * — both are heavy and unnecessary for unit tests. Keeping the two
 * configs separate also means `vitest` boots in ~1s on cold start.
 *
 * Environment: jsdom, since most unit subjects touch the DOM (React
 * hooks, Zustand stores that listen to window events). For pure logic
 * tests (modelFitness, lang, capability gates) jsdom adds <50ms over
 * node and we keep one consistent environment across files.
 */

import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import path from "node:path";

export default defineConfig({
  plugins: [preact()],
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
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      {
        find: "@testing-library/react",
        replacement: path.resolve(
          __dirname,
          "./src/test/testing-library-react-compat.ts",
        ),
      },
      { find: "react/jsx-runtime", replacement: "preact/compat/jsx-runtime" },
      { find: "react/jsx-dev-runtime", replacement: "preact/compat/jsx-dev-runtime" },
      { find: "react-dom/client", replacement: "preact/compat/client" },
      { find: "react-dom/test-utils", replacement: "preact/test-utils" },
      { find: "react-dom", replacement: "preact/compat" },
      { find: "react", replacement: "preact/compat" },
    ],
  },
});
