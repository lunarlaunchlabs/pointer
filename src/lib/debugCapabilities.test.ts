import { describe, expect, it } from "vitest";
import {
  debuggerCapabilitiesForPath,
  inferDebuggerCapabilities,
} from "./debugCapabilities";

describe("debugCapabilities", () => {
  it("maps individual source files to their debugger adapters", () => {
    expect(debuggerCapabilitiesForPath("/repo/src/App.tsx")[0]).toMatchObject({
      language: "typescript",
      adapter: "js-debug",
    });
    expect(debuggerCapabilitiesForPath("/repo/src/main.rs")[0]).toMatchObject({
      language: "rust",
      adapter: "CodeLLDB / lldb-dap",
    });
    expect(debuggerCapabilitiesForPath("/repo/app.py")[0]).toMatchObject({
      language: "python",
      adapter: "debugpy",
    });
  });

  it("infers framework-level capabilities from common manifests", () => {
    const caps = inferDebuggerCapabilities([
      "/repo/package.json",
      "/repo/vite.config.ts",
      "/repo/src-tauri/Cargo.toml",
      "/repo/pyproject.toml",
      "/repo/go.mod",
    ]);
    expect(caps.map((c) => c.language)).toEqual(
      expect.arrayContaining(["typescript", "rust", "python", "go"]),
    );
  });

  it("dedupes capabilities when manifests and source files point to the same adapter", () => {
    const caps = inferDebuggerCapabilities([
      "/repo/package.json",
      "/repo/src/App.tsx",
      "/repo/vitest.config.ts",
    ]);
    expect(caps.filter((c) => c.language === "typescript")).toHaveLength(1);
  });
});
