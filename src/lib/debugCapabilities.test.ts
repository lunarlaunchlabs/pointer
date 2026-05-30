import { describe, expect, it } from "vitest";
import {
  DEBUGGER_COMPATIBILITY_MATRIX,
  debuggerCapabilitiesForPath,
  inferDebuggerCapabilities,
} from "./debugCapabilities";
import {
  DEBUGGER_LAUNCH_CRITICAL_LANGUAGES,
  DEBUGGER_REQUIRED_FLOWS,
} from "./debugCompatibilityMatrix";

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
    expect(debuggerCapabilitiesForPath("/repo/native/main.cpp")[0]).toMatchObject({
      language: "cpp",
      adapter: "lldb-dap / cpptools",
    });
    expect(debuggerCapabilitiesForPath("/repo/app/Sources/App.swift")[0]).toMatchObject({
      language: "swift",
      adapter: "lldb-dap",
    });
    expect(debuggerCapabilitiesForPath("/repo/mobile/lib/main.dart")[0]).toMatchObject({
      language: "dart",
      adapter: "dart-debug-adapter",
    });
    expect(debuggerCapabilitiesForPath("/repo/build.gradle.kts")[0]).toMatchObject({
      language: "kotlin",
      adapter: "java-debug",
    });
    expect(debuggerCapabilitiesForPath("/repo/scripts/task.ps1")[0]).toMatchObject({
      language: "powershell",
      adapter: "PowerShell Editor Services",
    });
  });

  it("infers framework-level capabilities from common manifests", () => {
    const caps = inferDebuggerCapabilities([
      "/repo/package.json",
      "/repo/vite.config.ts",
      "/repo/src-tauri/Cargo.toml",
      "/repo/pyproject.toml",
      "/repo/go.mod",
      "/repo/CMakeLists.txt",
      "/repo/Package.swift",
      "/repo/pubspec.yaml",
      "/repo/mix.exs",
      "/repo/deps.edn",
      "/repo/build.sbt",
    ]);
    expect(caps.map((c) => c.language)).toEqual(
      expect.arrayContaining([
        "javascript",
        "typescript",
        "rust",
        "python",
        "go",
        "cpp",
        "swift",
        "dart",
        "elixir",
        "clojure",
        "scala",
      ]),
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

  it("keeps a launch-critical compatibility matrix for production debugger coverage", () => {
    expect(DEBUGGER_REQUIRED_FLOWS).toEqual([
      "adapter inference",
      "gutter breakpoint",
      "enable disable breakpoint",
      "conditional breakpoint",
      "logpoint",
      "captured value",
      "send breakpoint to assistant",
      "send value to assistant",
    ]);

    expect(DEBUGGER_LAUNCH_CRITICAL_LANGUAGES).toEqual(
      expect.arrayContaining([
        "javascript",
        "typescript",
        "python",
        "java",
        "csharp",
        "go",
        "rust",
        "cpp",
        "c",
        "php",
        "ruby",
        "swift",
        "kotlin",
        "dart",
        "shell",
        "powershell",
      ]),
    );
  });

  it("maps every compatibility-matrix sample source to its adapter", () => {
    for (const cap of DEBUGGER_COMPATIBILITY_MATRIX) {
      expect(cap.adapter, cap.language).toBeTruthy();
      expect(cap.installHint, cap.language).toBeTruthy();
      expect(cap.launchKinds.length, cap.language).toBeGreaterThan(0);
      expect(cap.frameworks.length, cap.language).toBeGreaterThan(0);
      expect(cap.samplePaths.length, cap.language).toBeGreaterThan(0);

      for (const samplePath of cap.samplePaths) {
        expect(
          debuggerCapabilitiesForPath(`/repo/${samplePath}`).map((x) => x.language),
          `${cap.language} sample ${samplePath}`,
        ).toContain(cap.language);
      }
    }
  });

  it("infers every compatibility-matrix manifest regardless of file order", () => {
    for (const cap of DEBUGGER_COMPATIBILITY_MATRIX) {
      for (const manifestPath of cap.manifestPaths) {
        const concrete = manifestPath.startsWith("*.")
          ? `Demo${manifestPath.slice(1)}`
          : manifestPath;
        expect(
          inferDebuggerCapabilities([
            "/repo/README.md",
            `/repo/${concrete}`,
            "/repo/docs/notes.txt",
          ]).map((x) => x.language),
          `${cap.language} manifest ${manifestPath}`,
        ).toContain(cap.language);
      }
    }
  });
});
