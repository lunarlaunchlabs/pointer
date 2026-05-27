import { describe, expect, it, vi } from "vitest";
import {
  extractFileMentions,
  inferImplicitFileReferences,
  mergeReferences,
} from "./implicitContext";
import type { Reference } from "@/store/chat";

describe("implicit file context", () => {
  it("extracts plain filename mentions from natural language", () => {
    expect(extractFileMentions("Tell me about App.jsx")).toEqual(["App.jsx"]);
    expect(extractFileMentions("Compare `src/App.tsx:12` with package.json.")).toEqual([
      "src/App.tsx",
      "package.json",
    ]);
  });

  it("resolves a unique filename mention through workspace search", async () => {
    const searchFiles = vi.fn(async () => [
      { path: "/repo/src/App.jsx", name: "App.jsx" },
    ]);
    const refs = await inferImplicitFileReferences("Tell me about App.jsx", {
      searchFiles,
    });
    expect(searchFiles).toHaveBeenCalledWith("App.jsx", 25);
    expect(refs).toEqual([{ kind: "file", path: "/repo/src/App.jsx" }]);
  });

  it("prefers the active editor path when duplicate basenames exist", async () => {
    const refs = await inferImplicitFileReferences("Explain App.jsx", {
      activePath: "/repo/examples/App.jsx",
      openTabs: ["/repo/src/App.jsx", "/repo/examples/App.jsx"],
      searchFiles: vi.fn(async () => [
        { path: "/repo/src/App.jsx", name: "App.jsx" },
        { path: "/repo/examples/App.jsx", name: "App.jsx" },
      ]),
    });
    expect(refs).toEqual([{ kind: "file", path: "/repo/examples/App.jsx" }]);
  });

  it("does not guess when duplicate basenames are ambiguous", async () => {
    const refs = await inferImplicitFileReferences("Explain App.jsx", {
      searchFiles: vi.fn(async () => [
        { path: "/repo/src/App.jsx", name: "App.jsx" },
        { path: "/repo/examples/App.jsx", name: "App.jsx" },
      ]),
    });
    expect(refs).toEqual([]);
  });

  it("does not duplicate explicitly attached files or selections", async () => {
    const existingRefs: Reference[] = [{ kind: "selection", path: "/repo/src/App.jsx", startLine: 1, endLine: 3, text: "x" }];
    const refs = await inferImplicitFileReferences("Tell me about App.jsx", {
      existingRefs,
      searchFiles: vi.fn(async () => [
        { path: "/repo/src/App.jsx", name: "App.jsx" },
      ]),
    });
    expect(refs).toEqual([]);
  });

  it("merges explicit and implicit references without duplicates", () => {
    const refs = mergeReferences(
      [{ kind: "file", path: "/repo/src/App.jsx" }],
      [{ kind: "file", path: "/repo/src/App.jsx" }, { kind: "file", path: "/repo/src/main.jsx" }],
    );
    expect(refs).toEqual([
      { kind: "file", path: "/repo/src/App.jsx" },
      { kind: "file", path: "/repo/src/main.jsx" },
    ]);
  });
});
