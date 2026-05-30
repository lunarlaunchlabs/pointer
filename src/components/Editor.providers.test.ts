import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@monaco-editor/react", () => ({
  default: () => null,
}));

import { registerGlobalAiProviders } from "./Editor";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

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
      DocumentHighlightKind: { Text: 1, Read: 2, Write: 3 },
      InlayHintKind: { Type: 1, Parameter: 2 },
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
      registerDocumentHighlightProvider: vi.fn((_selector, provider) => {
        providers.documentHighlight = provider;
      }),
      registerSignatureHelpProvider: vi.fn((_selector, provider) => {
        providers.signatureHelp = provider;
      }),
      registerInlayHintsProvider: vi.fn((_selector, provider) => {
        providers.inlayHints = provider;
      }),
      registerRenameProvider: vi.fn((_selector, provider) => {
        providers.rename = provider;
      }),
      registerInlineCompletionsProvider: vi.fn((_selector, provider) => {
        providers.inline = provider;
      }),
      InlineCompletionTriggerKind: { Automatic: 0, Explicit: 1 },
    },
  };
  return { monaco, providers };
}

function fakeModel(line: string, language = "typescript") {
  const value = `export const makeUrl = () => "/";\n${line}\nmakeUrl('/about')`;
  const lines = value.split("\n");
  const sliceRange = (range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }) => {
    const selected = lines.slice(range.startLineNumber - 1, range.endLineNumber);
    if (selected.length === 0) return "";
    selected[0] = selected[0].slice(Math.max(0, range.startColumn - 1));
    const last = selected.length - 1;
    selected[last] = selected[last].slice(0, Math.max(0, range.endColumn - 1));
    return selected.join("\n");
  };
  return {
    uri: { path: "/repo/src/App.ts", toString: () => "file:///repo/src/App.ts" },
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? line,
    getLanguageId: () => language,
    getValue: () => value,
    getValueInRange: sliceRange,
    getLineCount: () => lines.length,
    getLineMaxColumn: (lineNumber: number) =>
      (lines[lineNumber - 1] ?? "").length + 1,
    getVersionId: () => 1,
  };
}

describe("Editor Monaco providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettings.setState({
      ollamaReady: false,
      installedModels: [],
      fimEnabled: true,
      fimModel: "",
      fimTriggerMode: "automatic",
    });
    useWorkspace.setState({ root: "/repo" });
  });

  it("uses LSP definitions first, then falls back to declaration search", async () => {
    const { monaco, providers } = fakeMonaco();
    registerGlobalAiProviders(monaco as any);

    const line = "const value = makeUrl('/home')";
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "lsp_definition") {
        return [
          {
            path: "/repo/src/url.ts",
            line: 3,
            column: 17,
            endLine: 3,
            endColumn: 24,
          },
        ];
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const fromLsp = await providers.definition.provideDefinition(
      fakeModel(line),
      { lineNumber: 2, column: line.indexOf("makeUrl") + 2 },
    );

    expect(fromLsp).toHaveLength(1);
    expect(fromLsp[0].uri.path).toBe("/repo/src/url.ts");
    expect(fromLsp[0].range.startLineNumber).toBe(3);

    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "lsp_definition") throw new Error("server warming");
      if (cmd === "search_text") {
        expect(args).toMatchObject({
          options: { regex: true, case_sensitive: true },
        });
        return [
          {
            path: "/repo/src/helpers.ts",
            line: 9,
            text: "export function makeUrl(path: string) {",
          },
        ];
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const fromSearch = await providers.definition.provideDefinition(
      fakeModel(line),
      { lineNumber: 2, column: line.indexOf("makeUrl") + 2 },
    );

    expect(fromSearch).toHaveLength(1);
    expect(fromSearch[0].uri.path).toBe("/repo/src/helpers.ts");
    expect(fromSearch[0].range.startLineNumber).toBe(9);
  });

  it("registers global providers once per Monaco instance", () => {
    const { monaco } = fakeMonaco();

    registerGlobalAiProviders(monaco as any);
    registerGlobalAiProviders(monaco as any);

    expect(monaco.languages.registerHoverProvider).toHaveBeenCalledTimes(1);
    expect(monaco.languages.registerSignatureHelpProvider).toHaveBeenCalledTimes(1);
    expect(monaco.languages.registerCompletionItemProvider).toHaveBeenCalledTimes(1);
    expect(monaco.languages.registerInlineCompletionsProvider).toHaveBeenCalledTimes(1);
  });

  it("keeps TypeScript and JavaScript LSP hover/signature help available", async () => {
    const { monaco, providers } = fakeMonaco();
    registerGlobalAiProviders(monaco as any);

    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "lsp_hover") {
        return {
          contents: "```ts\nfunction makeUrl(path: string): string\n```",
          range: null,
        };
      }
      if (cmd === "lsp_signature_help") {
        return {
          signatures: [
            {
              label: "makeUrl(path: string): string",
              documentation: null,
              parameters: [{ label: "path", documentation: null }],
            },
          ],
          activeSignature: 0,
          activeParameter: 0,
        };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const line = "const value = makeUrl('/home')";
    const model = fakeModel(line);
    const position = { lineNumber: 2, column: line.indexOf("makeUrl") + 2 };

    await expect(providers.hover.provideHover(model, position)).resolves.toMatchObject({
      contents: [{ value: "```ts\nfunction makeUrl(path: string): string\n```" }],
    });
    await expect(
      providers.signatureHelp.provideSignatureHelp(model, position),
    ).resolves.toMatchObject({
      value: {
        signatures: [expect.objectContaining({ label: "makeUrl(path: string): string" })],
      },
    });
  });

  it("falls back from imported package symbols to dependency declaration files", async () => {
    const { monaco, providers } = fakeMonaco();
    registerGlobalAiProviders(monaco as any);

    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "lsp_definition") return [];
      if (cmd === "read_text_file") {
        const path = (args as { path?: string } | undefined)?.path;
        if (path === "/repo/node_modules/@scope/tool/package.json") {
          return JSON.stringify({ types: "index.d.ts" });
        }
        if (path === "/repo/node_modules/@scope/tool/index.d.ts") {
          return "export declare function PointerPackageApi(): string;";
        }
        throw new Error(`missing ${path}`);
      }
      if (cmd === "search_text") throw new Error("search should not be needed");
      throw new Error(`unexpected ${cmd}`);
    });

    const line = "export const value = PointerPackageApi();";
    const model = fakeModel([
      "import { PointerPackageApi } from '@scope/tool';",
      line,
    ].join("\n"));
    const definition = await providers.definition.provideDefinition(model, {
      lineNumber: 3,
      column: line.indexOf("PointerPackageApi") + 2,
    });

    expect(definition[0].uri.path).toBe("/repo/node_modules/@scope/tool/index.d.ts");
    expect(definition[0].range.startLineNumber).toBe(1);
    expect(definition[0].range.startColumn).toBe(25);
  });

  it("dedupes repeated LSP hover blocks before Monaco renders them", async () => {
    const { monaco, providers } = fakeMonaco();
    registerGlobalAiProviders(monaco as any);

    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "lsp_hover") {
        return {
          contents: [
            "```python",
            "def make_url(path: str) -> str",
            "```",
            "",
            "```python",
            "def make_url(path: str) -> str",
            "```",
          ].join("\n"),
          range: null,
        };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const line = "value = make_url('/home')";
    const model = fakeModel(line, "python");
    const hover = await providers.hover.provideHover(model, {
      lineNumber: 2,
      column: line.indexOf("make_url") + 2,
    });

    expect(hover.contents).toEqual([
      { value: "```python\ndef make_url(path: str) -> str\n```" },
    ]);
  });

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

  it("adapts LSP highlights, signature help, inlay hints, and rename edits into Monaco providers", async () => {
    const { monaco, providers } = fakeMonaco();
    registerGlobalAiProviders(monaco as any);

    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "lsp_document_highlight") {
        return [
          {
            range: { startLine: 2, startColumn: 15, endLine: 2, endColumn: 22 },
            kind: 2,
          },
        ];
      }
      if (cmd === "lsp_signature_help") {
        return {
          signatures: [
            {
              label: "makeUrl(path: string)",
              documentation: "Build a URL.",
              parameters: [{ label: "path", documentation: "Route path." }],
            },
            {
              label: "makeUrl(path: string)",
              documentation: "Build a URL.",
              parameters: [{ label: "path", documentation: "Route path." }],
            },
          ],
          activeSignature: 0,
          activeParameter: 0,
        };
      }
      if (cmd === "lsp_rename") {
        return [
          {
            path: "/repo/src/App.ts",
            range: { startLine: 2, startColumn: 15, endLine: 2, endColumn: 22 },
            newText: "makeHref",
          },
        ];
      }
      if (cmd === "lsp_inlay_hints") {
        return [
          {
            label: ": string",
            tooltip: "Inferred type",
            line: 2,
            column: 12,
            kind: 1,
            paddingLeft: true,
            paddingRight: false,
          },
        ];
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const line = "const value = makeUrl('/home')";
    const model = fakeModel(line, "python");
    const position = { lineNumber: 2, column: line.indexOf("makeUrl") + 2 };

    const highlights = await providers.documentHighlight.provideDocumentHighlights(
      model,
      position,
    );
    expect(highlights[0].range.startLineNumber).toBe(2);
    expect(highlights[0].kind).toBe(monaco.languages.DocumentHighlightKind.Read);

    const signature = await providers.signatureHelp.provideSignatureHelp(
      model,
      position,
    );
    expect(signature.value.signatures[0].label).toBe("makeUrl(path: string)");
    expect(signature.value.signatures).toHaveLength(1);
    expect(signature.value.activeParameter).toBe(0);

    const hints = await providers.inlayHints.provideInlayHints(
      model,
      new monaco.Range(1, 1, 3, 1),
    );
    expect(hints.hints[0].label).toBe(": string");
    expect(hints.hints[0].position.lineNumber).toBe(2);
    expect(hints.hints[0].kind).toBe(monaco.languages.InlayHintKind.Type);

    const rename = await providers.rename.provideRenameEdits(
      model,
      position,
      "makeHref",
    );
    expect(rename.edits[0].resource.path).toBe("/repo/src/App.ts");
    expect(rename.edits[0].textEdit.text).toBe("makeHref");
  });

  it("keeps manual tab completion quiet until the explicit shortcut asks", async () => {
    const { monaco, providers } = fakeMonaco();
    registerGlobalAiProviders(monaco as any);
    useSettings.setState({
      ollamaReady: true,
      installedModels: ["fim:latest"],
      fimModel: "fim:latest",
      fimEnabled: true,
      fimTriggerMode: "manual",
    });

    const line = "const next = ";
    const model = fakeModel(line);
    const position = { lineNumber: 2, column: line.length + 1 };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(),
    };

    const automatic = await providers.inline.provideInlineCompletions(
      model,
      position,
      { triggerKind: monaco.languages.InlineCompletionTriggerKind.Automatic },
      token,
    );
    expect(automatic.items).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();

    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "ollama_fim") {
        expect(args).toMatchObject({
          request: {
            model: "fim:latest",
            num_predict: 96,
          },
        });
        return '"ready"';
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const explicit = await providers.inline.provideInlineCompletions(
      model,
      position,
      { triggerKind: monaco.languages.InlineCompletionTriggerKind.Explicit },
      token,
    );

    expect(explicit.items[0].insertText).toBe('"ready"');
  });
});
