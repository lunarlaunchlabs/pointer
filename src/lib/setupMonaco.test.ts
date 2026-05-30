import { describe, expect, it, vi } from "vitest";
import { javascriptTypeScriptMonarch, setupMonaco } from "@/lib/setupMonaco";

vi.mock("@/lib/shikiMonaco", () => ({
  setupShikiMonaco: vi.fn(),
}));

describe("setupMonaco", () => {
  it("runs once per Monaco instance, not once per module lifetime", () => {
    const first = fakeMonaco();
    const second = fakeMonaco();

    setupMonaco(first as any, "typescript");
    setupMonaco(first as any, "typescript");
    setupMonaco(second as any, "typescript");

    expect(first.languages.typescript.typescriptDefaults.setCompilerOptions).toHaveBeenCalledTimes(1);
    expect(second.languages.typescript.typescriptDefaults.setCompilerOptions).toHaveBeenCalledTimes(1);
  });

  it("re-applies JavaScript and TypeScript token providers after Monaco lazy setup", () => {
    vi.useFakeTimers();
    try {
      const monaco = fakeMonaco();

      setupMonaco(monaco as any, "typescript");

      expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
        "typescript",
        expect.objectContaining({ tokenizer: expect.any(Object) }),
      );
      const initialRegistrations = monaco.languages.setMonarchTokensProvider.mock.calls.length;

      vi.advanceTimersByTime(2500);

      expect(monaco.languages.setMonarchTokensProvider.mock.calls.length).toBeGreaterThan(
        initialRegistrations,
      );
      expect(
        monaco.languages.setMonarchTokensProvider.mock.calls.filter(
          ([language]) => language === "typescript",
        ).length,
      ).toBeGreaterThan(1);
      expect(
        monaco.languages.setMonarchTokensProvider.mock.calls.filter(
          ([language]) => language === "javascript",
        ).length,
      ).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps JSX text children out of TypeScript keyword tokenization", () => {
    const language = javascriptTypeScriptMonarch() as any;
    const jsxTextTokens = language.tokenizer.jsxText.map((rule: unknown[]) => rule[1]);

    expect(language.tokenizer.jsxTag).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([expect.any(RegExp), expect.objectContaining({ switchTo: "@jsxText" })]),
      ]),
    );
    expect(language.tokenizer.jsxText).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([expect.any(RegExp), expect.objectContaining({ next: "@jsxExpression" })]),
        expect.arrayContaining([expect.any(RegExp), expect.objectContaining({ next: "@pop" })]),
      ]),
    );
    expect(JSON.stringify(language.tokenizer.jsxText)).not.toContain("@keywords");
    expect(jsxTextTokens).toContain("");
    expect(jsxTextTokens).not.toContain("identifier");
  });
});

function fakeMonaco() {
  const defaults = () => ({
    setCompilerOptions: vi.fn(),
    setDiagnosticsOptions: vi.fn(),
    setEagerModelSync: vi.fn(),
  });
  return {
    languages: {
      register: vi.fn(),
      setMonarchTokensProvider: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      typescript: {
        ScriptTarget: { ESNext: "ESNext" },
        ModuleKind: { ESNext: "ESNext" },
        ModuleResolutionKind: { NodeJs: "NodeJs" },
        JsxEmit: { ReactJSX: "ReactJSX" },
        typescriptDefaults: defaults(),
        javascriptDefaults: defaults(),
      },
      json: {
        jsonDefaults: {
          setDiagnosticsOptions: vi.fn(),
        },
      },
    },
  };
}
