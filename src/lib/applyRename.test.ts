/**
 * Apply-rename tests.
 *
 * The applier takes a confirmed rename suggestion and rewrites every
 * other affected file. We stub the IPC layer so tests can:
 *
 *   • Verify *only* whole-word identifier matches get rewritten
 *     (substring matches like `oldNameLonger` must not).
 *   • Verify string-literal and comment occurrences are LEFT ALONE
 *     by default — replacing inside strings/comments is risky.
 *   • Verify the source file is never touched (it was already
 *     renamed there).
 *   • Verify writes only happen when content actually changed.
 *   • Verify errors from one file don't block the others (best-
 *     effort apply).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipcModule from "@/lib/ipc";
import { applyRenameAcrossWorkspace } from "./applyRename";

const readMock = vi.fn<(path: string) => Promise<string>>();
const writeMock = vi.fn<(path: string, contents: string) => Promise<void>>();

beforeEach(() => {
  readMock.mockReset();
  writeMock.mockReset();
  vi.spyOn(ipcModule.ipc, "readTextFile").mockImplementation(readMock);
  vi.spyOn(ipcModule.ipc, "writeTextFile").mockImplementation(writeMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyRenameAcrossWorkspace", () => {
  it("rewrites whole-word occurrences across hit files", async () => {
    readMock.mockImplementation(async (path) => {
      if (path === "src/x.ts") return "import { foo } from './a';\nfoo();\n";
      if (path === "src/y.ts") return "const z = foo + 1;\n";
      return "";
    });
    await applyRenameAcrossWorkspace({
      oldName: "foo",
      newName: "bar",
      sourcePath: "src/source.ts",
      hits: [
        { path: "src/x.ts", line: 1, text: "import { foo } from './a';" },
        { path: "src/y.ts", line: 1, text: "const z = foo + 1;" },
      ],
    });
    expect(writeMock).toHaveBeenCalledWith(
      "src/x.ts",
      "import { bar } from './a';\nbar();\n",
    );
    expect(writeMock).toHaveBeenCalledWith("src/y.ts", "const z = bar + 1;\n");
  });

  it("leaves substring matches alone", async () => {
    readMock.mockResolvedValue("fooBar(); foo_longer(); foo();");
    await applyRenameAcrossWorkspace({
      oldName: "foo",
      newName: "baz",
      sourcePath: "src/source.ts",
      hits: [{ path: "src/x.ts", line: 1, text: "foo()" }],
    });
    // Only the bare `foo()` token changed; `fooBar` and `foo_longer`
    // (different identifiers) are untouched.
    expect(writeMock).toHaveBeenCalledWith(
      "src/x.ts",
      "fooBar(); foo_longer(); baz();",
    );
  });

  it("leaves string-literal occurrences alone", async () => {
    readMock.mockResolvedValue('let x = "foo";\nfoo();\n');
    await applyRenameAcrossWorkspace({
      oldName: "foo",
      newName: "bar",
      sourcePath: "src/source.ts",
      hits: [{ path: "src/x.ts", line: 2, text: "foo()" }],
    });
    expect(writeMock).toHaveBeenCalledWith(
      "src/x.ts",
      'let x = "foo";\nbar();\n',
    );
  });

  it("leaves line-comment occurrences alone", async () => {
    readMock.mockResolvedValue("// foo is the old name\nfoo();\n");
    await applyRenameAcrossWorkspace({
      oldName: "foo",
      newName: "bar",
      sourcePath: "src/source.ts",
      hits: [{ path: "src/x.ts", line: 2, text: "foo()" }],
    });
    expect(writeMock).toHaveBeenCalledWith(
      "src/x.ts",
      "// foo is the old name\nbar();\n",
    );
  });

  it("never writes the source file", async () => {
    readMock.mockResolvedValue("foo();");
    await applyRenameAcrossWorkspace({
      oldName: "foo",
      newName: "bar",
      sourcePath: "src/source.ts",
      hits: [{ path: "src/source.ts", line: 1, text: "foo()" }],
    });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("skips files where the rename produced no change", async () => {
    readMock.mockResolvedValue("nothing to see here");
    await applyRenameAcrossWorkspace({
      oldName: "foo",
      newName: "bar",
      sourcePath: "src/source.ts",
      hits: [{ path: "src/x.ts", line: 1, text: "foo()" }],
    });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("dedupes hits by path before reading", async () => {
    readMock.mockResolvedValue("foo();");
    await applyRenameAcrossWorkspace({
      oldName: "foo",
      newName: "bar",
      sourcePath: "src/source.ts",
      hits: [
        { path: "src/x.ts", line: 1, text: "foo()" },
        { path: "src/x.ts", line: 2, text: "foo();" },
      ],
    });
    expect(readMock).toHaveBeenCalledTimes(1);
  });

  it("propagates failures from individual files but completes the rest", async () => {
    readMock.mockImplementation(async (path) => {
      if (path === "src/bad.ts") throw new Error("permission denied");
      return "foo()";
    });
    await applyRenameAcrossWorkspace({
      oldName: "foo",
      newName: "bar",
      sourcePath: "src/source.ts",
      hits: [
        { path: "src/bad.ts", line: 1, text: "foo()" },
        { path: "src/good.ts", line: 1, text: "foo()" },
      ],
    });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith("src/good.ts", "bar()");
  });
});
