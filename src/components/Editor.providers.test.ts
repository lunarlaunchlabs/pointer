import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@monaco-editor/react", () => ({
  default: () => null,
}));

import { registerGlobalAiProviders } from "./Editor";

class FakeRange {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
}

function fakeMonaco() {
  const providers: Record<string, any> = {};
  const monaco = {
    Emitter: class {
      event = vi.fn();
      fire = vi.fn();
    },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    Range: FakeRange,
    Uri: {
      file: (path: string) => ({
        path,
        toString: () => `file://${path}`,
      }),
    },
    editor: {
      registerCommand: vi.fn(),
      onDidChangeMarkers: vi.fn(),
      getModelMarkers: vi.fn(() => []),
    },
    languages: {
      CompletionItemKind: {
        Text: 1,
        Method: 2,
        Function: 3,
        Constructor: 4,
        Field: 5,
        Variable: 6,
        Class: 7,
        Interface: 8,
        Module: 9,
        Property: 10,
        Value: 12,
        Enum: 13,
        Keyword: 14,
        Snippet: 15,
        Color: 16,
        File: 17,
        Reference: 18,
        EnumMember: 20,
        Constant: 21,
        Struct: 22,
        Event: 23,
        Operator: 24,
        TypeParameter: 25,
      },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCodeActionProvider: vi.fn(),
      registerCodeLensProvider: vi.fn(),
      registerDefinitionProvider: vi.fn((_selector, provider) => {
        providers.definition = provider;
      }),
      registerReferenceProvider: vi.fn((_selector, provider) => {
        providers.references = provider;
      }),
      registerHoverProvider: vi.fn((_selector, provider) => {
        providers.hover = provider;
      }),
      registerCompletionItemProvider: vi.fn((_selector, provider) => {
        providers.completion = provider;
      }),
      registerInlineCompletionsProvider: vi.fn((_selector, provider) => {
        providers.inline = provider;
      }),
    },
  };
  return { monaco, providers };
}

function fakeModel(line: string) {
  return {
    uri: { toString: () => "file:///repo/src/App.ts" },
    getLineContent: () => line,
    getLanguageId: () => "typescript",
    getValue: () => `export const makeUrl = () => "/";\n${line}\n`,
  };
}

describe("Editor Monaco providers", () => {
  it("uses LSP references first, then falls back to whole-word workspace search", async () => {
    const { monaco, providers } = fakeMonaco();
    registerGlobalAiProviders(monaco as any);

    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "lsp_references") {
        return [
          {
            path: "/repo/src/App.ts",
            line: 1,
            column: 14,
            endLine: 1,
            endColumn: 21,
          },
        ];
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const line = "const value = makeUrl('/home')";
    const fromLsp = await providers.references.provideReferences(
      fakeModel(line),
      { lineNumber: 2, column: line.indexOf("makeUrl") + 2 },
    );

    expect(fromLsp).toHaveLength(1);
    expect(fromLsp[0].uri.path).toBe("/repo/src/App.ts");
    expect(fromLsp[0].range.startLineNumber).toBe(1);
    expect(fromLsp[0].range.startColumn).toBe(14);

    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "lsp_references") throw new Error("server warming");
      if (cmd === "search_text") {
        return [
          {
            path: "/repo/src/routes.ts",
            line: 8,
            text: "router.get(makeUrl('/home'))",
            col: 11,
            match_len: 7,
          },
        ];
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const fromSearch = await providers.references.provideReferences(
      fakeModel(line),
      { lineNumber: 2, column: line.indexOf("makeUrl") + 2 },
    );

    expect(invoke).toHaveBeenCalledWith("search_text", {
      query: "makeUrl",
      limit: 100,
      options: { case_sensitive: true, whole_word: true },
    });
    expect(fromSearch).toHaveLength(1);
    expect(fromSearch[0].uri.path).toBe("/repo/src/routes.ts");
    expect(fromSearch[0].range.startColumn).toBe(12);
    expect(fromSearch[0].range.endColumn).toBe(19);
  });
});
