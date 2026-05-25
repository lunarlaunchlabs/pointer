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
