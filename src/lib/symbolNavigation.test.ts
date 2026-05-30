import { describe, expect, it } from "vitest";
import {
  definitionSearchPatterns,
  findLocalDefinitions,
  symbolAtPosition,
} from "@/lib/symbolNavigation";

describe("symbolAtPosition", () => {
  it("extracts the identifier under a one-based Monaco cursor column", () => {
    const line = "const userStore = createStore()";

    expect(symbolAtPosition(line, line.indexOf("userStore") + 3)).toEqual({
      symbol: "userStore",
      startColumn: 7,
      endColumn: 16,
    });
  });

  it("ignores language keywords and tiny symbols", () => {
    expect(symbolAtPosition("return user", 3)).toBeNull();
    expect(symbolAtPosition("x + y", 1)).toBeNull();
  });
});

describe("definitionSearchPatterns", () => {
  it("emits language-specific declaration regexes", () => {
    expect(definitionSearchPatterns("Router", "typescript")).toContain(
      String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?class\s+Router\b`,
    );
    expect(
      definitionSearchPatterns("App", "tsx").some((pattern) =>
        pattern.includes("(?:const|let|var)") && pattern.includes("App"),
      ),
    ).toBe(true);
    expect(definitionSearchPatterns("handle", "rust")).toContain(
      String.raw`^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+handle\b`,
    );
    expect(definitionSearchPatterns("serve", "go")).toContain(
      String.raw`^\s*func\s+(?:\([^)]+\)\s+)?serve\b`,
    );
  });
});

describe("findLocalDefinitions", () => {
  it("finds TypeScript function-like declarations", () => {
    const source = [
      "export const makeUrl = (path: string) => path",
      "const value = makeUrl('/home')",
    ].join("\n");

    expect(findLocalDefinitions(source, "makeUrl", "typescript")).toEqual([
      {
        line: 1,
        column: 14,
        text: "export const makeUrl = (path: string) => path",
      },
    ]);
  });

  it("finds TypeScript declaration-file exports", () => {
    expect(
      findLocalDefinitions(
        "export declare function PointerPackageApi(): string;",
        "PointerPackageApi",
        "typescript",
      ),
    ).toEqual([
      {
        line: 1,
        column: 25,
        text: "export declare function PointerPackageApi(): string;",
      },
    ]);
  });

  it("finds Python and Rust definitions", () => {
    expect(
      findLocalDefinitions("async def load_user(id):\n  return id", "load_user", "python"),
    ).toHaveLength(1);
    expect(
      findLocalDefinitions("pub(crate) fn run_check() {}", "run_check", "rust"),
    ).toHaveLength(1);
  });
});
