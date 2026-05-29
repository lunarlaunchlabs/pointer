/**
 * Tests for the shared buildContext pipeline.
 *
 * Both chat and agent feed user references through this function, so
 * the contract is high-stakes:
 *   • The output frames each reference kind into the agreed XML-ish
 *     blocks (file / selection / diagnostic / codebase / processed).
 *   • Higher-priority references survive a tight token budget.
 *   • Codebase references silently degrade when indexing isn't ready
 *     (instead of throwing — the picker handled the gate).
 *   • The current-file fall-through anchor is only attached when no
 *     explicit reference already pins the same file.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { buildContext } from "./buildContext";

describe("buildContext", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("returns undefined when there are no references and no anchor", async () => {
    const out = await buildContext([], { embedModel: "nomic-embed-text:latest" });
    expect(out).toBeUndefined();
  });

  it("renders a file reference into a <file> block", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "read_text_file") return "const a = 1;\n";
      throw new Error(`unexpected ${cmd}`);
    });
    const out = await buildContext([{ kind: "file", path: "src/a.ts" }]);
    expect(out).toContain('<file path="src/a.ts">');
    expect(out).toContain("const a = 1;");
  });

  it("renders a selection block with line range", async () => {
    const out = await buildContext([
      {
        kind: "selection",
        path: "src/foo.ts",
        startLine: 3,
        endLine: 5,
        text: "x();",
      },
    ]);
    expect(out).toContain('<selection path="src/foo.ts" lines="3-5">');
    expect(out).toContain("x();");
  });

  it("renders diagnostics with severity, source and snippet", async () => {
    const out = await buildContext([
      {
        kind: "diagnostic",
        path: "src/foo.ts",
        startLine: 7,
        startCol: 4,
        endLine: 7,
        endCol: 12,
        severity: "error",
        source: "ts",
        code: "TS2304",
        message: "Cannot find name 'foo'.",
        snippet: "console.log(foo);",
      },
    ]);
    expect(out).toContain('<diagnostic path="src/foo.ts"');
    expect(out).toContain('severity="error"');
    expect(out).toContain('code="TS2304"');
    expect(out).toContain("Cannot find name 'foo'.");
    expect(out).toContain("console.log(foo);");
  });

  it("renders breakpoint and debug-value references", async () => {
    const out = await buildContext([
      {
        kind: "breakpoint",
        path: "src/foo.ts",
        line: 12,
        enabled: true,
        condition: "user == null",
      },
      {
        kind: "debugValue",
        name: "user",
        value: "{ id: 1, name: 'Sameer' }",
        type: "User",
        path: "src/foo.ts",
        line: 12,
        scope: "locals",
      },
    ]);
    expect(out).toContain('<breakpoint path="src/foo.ts" line="12" enabled="true">');
    expect(out).toContain("condition: user == null");
    expect(out).toContain('<debug-value name="user" type="User" path="src/foo.ts" line="12" scope="locals">');
    expect(out).toContain("{ id: 1, name: 'Sameer' }");
  });

  it("skips codebase refs when indexing is not usable", async () => {
    const out = await buildContext([{ kind: "codebase", query: "lookup" }], {
      codebaseUsable: false,
      embedModel: "nomic-embed-text:latest",
    });
    expect(out).toBeUndefined();
    // …and the IPC was not called for codebase search.
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "search_codebase",
      expect.anything(),
    );
  });

  it("includes the current file anchor when no overlapping ref exists", async () => {
    const out = await buildContext([], {
      currentFile: { path: "src/x.ts", content: "let x = 0;" },
    });
    expect(out).toContain('<file path="src/x.ts">');
    expect(out).toContain("let x = 0;");
  });

  it("includes direct relative imports from the current file as neighbor context", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd !== "read_text_file") throw new Error(`unexpected ${cmd}`);
      if ((args as { path: string }).path === "/repo/src/Nav.jsx") {
        return "export function Nav() { return null; }";
      }
      throw new Error("missing");
    });

    const out = await buildContext([], {
      currentFile: {
        path: "/repo/src/App.jsx",
        content: "import { Nav } from './Nav';\nexport default function App() { return <Nav />; }",
      },
    });

    expect(out).toContain('<file path="/repo/src/App.jsx">');
    expect(out).toContain('<file path="/repo/src/Nav.jsx">');
    expect(out).toContain("export function Nav()");
    expect(out).toContain("<context-memory>");
    expect(out).toContain("/repo/src/Nav.jsx (direct import from /repo/src/App.jsx)");
  });

  it("builds a prompt-guided context brain for plan and agent turns", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      const path = (args as { path?: string }).path;
      if (cmd === "search_files") {
        const query = (args as { query: string }).query;
        if (query === "package.json") {
          return [{ path: "/repo/package.json", name: "package.json" }];
        }
        if (query.includes("query.test")) {
          return [{ path: "/repo/test/query.test.js", name: "query.test.js" }];
        }
        return [];
      }
      if (cmd === "search_text") {
        const query = (args as { query: string }).query;
        if (query === "query parser") {
          return [
            { path: "/repo/lib/query.js", line: 3, text: "exports.compile = function compileQueryParser(val) {" },
          ];
        }
        if (query.includes("from './query'")) {
          return [{ path: "/repo/lib/app.js", line: 7, text: "var compileQueryParser = require('./query');" }];
        }
        return [];
      }
      if (cmd === "read_text_file") {
        if (path === "/repo/package.json") {
          return JSON.stringify({ scripts: { test: "mocha --reporter spec" } });
        }
        if (path === "/repo/lib/query.js") {
          return "exports.compile = function compileQueryParser(val) { return val; }";
        }
        if (path === "/repo/test/query.test.js") {
          return "describe('query parser', function () { it('compiles', function () {}); });";
        }
      }
      throw new Error(`unexpected ${cmd} ${path ?? ""}`);
    });

    const out = await buildContext([], {
      mode: "plan",
      userPrompt: "Plan how to improve the query parser validation",
    });

    expect(out).toContain('<file path="/repo/package.json">');
    expect(out).toContain('<file path="/repo/lib/query.js">');
    expect(out).toContain('<file path="/repo/test/query.test.js">');
    expect(out).toContain("<brain-frontier>");
    expect(out).toContain("intent: read-only executable planning");
    expect(out).toContain("verification/specification candidate");
    expect(out).toContain("<context-memory>");
    expect(out).toContain("project manifest / verification config");
    expect(out).toContain("prompt-guided workspace search");
  });

  it("builds an ask-mode research frontier before the model answers", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      const query = (args as { query?: string }).query ?? "";
      const path = (args as { path?: string }).path;
      if (cmd === "search_text") {
        if (query === "oauth callback") {
          return [
            {
              path: "/repo/server/auth/routes.py",
              line: 12,
              text: "def oauth_callback(request):",
            },
          ];
        }
        return [];
      }
      if (cmd === "read_text_file" && path === "/repo/server/auth/routes.py") {
        return "def oauth_callback(request):\n    return exchange_code(request)\n";
      }
      throw new Error(`unexpected ${cmd} ${query || path || ""}`);
    });

    const out = await buildContext([], {
      mode: "ask",
      userPrompt: "Where is the `oauth callback` handled?",
    });

    expect(out).toContain("<brain-frontier>");
    expect(out).toContain("intent: codebase research");
    expect(out).toContain('<file path="/repo/server/auth/routes.py">');
    expect(out).toContain("oauth_callback");
  });

  it("discovers verification candidates without assuming a language stack", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      const query = (args as { query?: string }).query ?? "";
      const path = (args as { path?: string }).path;
      if (cmd === "search_files") {
        if (query === "Cargo.toml") {
          return [{ path: "/repo/Cargo.toml", name: "Cargo.toml" }];
        }
        if (query === "tokenizer_test") {
          return [{ path: "/repo/tests/tokenizer_test.rs", name: "tokenizer_test.rs" }];
        }
        return [];
      }
      if (cmd === "search_text") {
        if (query === "tokenizer regression") {
          return [{ path: "/repo/src/tokenizer.rs", line: 8, text: "pub fn tokenize(input: &str)" }];
        }
        return [];
      }
      if (cmd === "read_text_file") {
        if (path === "/repo/Cargo.toml") {
          return "[package]\nname = \"parser\"\n";
        }
        if (path === "/repo/src/tokenizer.rs") {
          return "pub fn tokenize(input: &str) -> Vec<&str> { input.split_whitespace().collect() }";
        }
        if (path === "/repo/tests/tokenizer_test.rs") {
          return "#[test]\nfn tokenizer_regression() {}";
        }
      }
      throw new Error(`unexpected ${cmd} ${query || path || ""}`);
    });

    const out = await buildContext([], {
      mode: "agent",
      userPrompt: "Fix the tokenizer regression and verify it",
    });

    expect(out).toContain('<file path="/repo/Cargo.toml">');
    expect(out).toContain('<file path="/repo/src/tokenizer.rs">');
    expect(out).toContain('<file path="/repo/tests/tokenizer_test.rs">');
    expect(out).toContain("intent: implementation with verification");
  });

  it("does NOT duplicate the current file when explicitly referenced", async () => {
    vi.mocked(invoke).mockResolvedValue("const a = 1;");
    const out = await buildContext([{ kind: "file", path: "src/a.ts" }], {
      currentFile: { path: "src/a.ts", content: "const a = 1;" },
    });
    // Only one <file> block, not two — `src/a.ts` is referenced exactly once.
    const occurrences = (out ?? "").split('<file path="src/a.ts">').length - 1;
    expect(occurrences).toBe(1);
  });

  it("does NOT include the current file when a selection of it exists", async () => {
    const out = await buildContext(
      [
        {
          kind: "selection",
          path: "src/x.ts",
          startLine: 1,
          endLine: 2,
          text: "x;",
        },
      ],
      { currentFile: { path: "src/x.ts", content: "let x = 0;" } },
    );
    // The full-file anchor must be suppressed — the selection already
    // pins our attention to this file.
    expect(out).not.toMatch(/<file path="src\/x\.ts">/);
    expect(out).toContain('<selection path="src/x.ts"');
  });

  it("renders processed attachments verbatim with the model name", async () => {
    const out = await buildContext([
      {
        kind: "processed",
        path: "/tmp/spec.pdf",
        fileKind: "pdf",
        label: "PDF",
        model: "minicpm-v:8b",
        content: "Hello PDF",
        raw_bytes: 1234,
      },
    ]);
    expect(out).toContain("attached pdf");
    expect(out).toContain("processed-by: minicpm-v:8b");
    expect(out).toContain("Hello PDF");
  });

  it("drops low-priority items first when the budget is tight", async () => {
    // The explicit @file ref reads through the IPC mock and produces a
    // small file body that fits the budget. The current-file anchor
    // is far too large to fit, so the budgeter prunes it (priority 40
    // < the file's priority 80).
    vi.mocked(invoke).mockResolvedValue("ok");
    const fatAnchorContent = "z".repeat(4000);
    const out = await buildContext(
      [{ kind: "file", path: "src/small.ts" }],
      {
        budgetTokens: 200,
        currentFile: { path: "src/other.ts", content: fatAnchorContent },
      },
    );
    expect(out).toContain('<file path="src/small.ts">');
    expect(out).not.toContain('<file path="src/other.ts">');
  });
});
