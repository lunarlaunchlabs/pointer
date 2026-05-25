import type { languages, Position, editor as MonacoEditor } from "monaco-editor";
import type * as MonacoNs from "monaco-editor";
import { ipc } from "@/lib/ipc";

/**
 * Lightweight, VSCode-flavored snippet support. The user puts a
 * single `.pointer/snippets.json` at the workspace root that maps
 * a prefix to a multi-line body (supporting Monaco's `$1`, `$2`,
 * `${1:placeholder}` tab-stop syntax). On open we register a
 * single CompletionItemProvider that surfaces those entries as
 * code-completion suggestions.
 *
 * Example file:
 *
 *     {
 *       "react-fc": {
 *         "prefix": "rfc",
 *         "body": [
 *           "export function ${1:Component}() {",
 *           "  return <div>$0</div>;",
 *           "}"
 *         ],
 *         "description": "React functional component"
 *       }
 *     }
 *
 * Languages are filtered by an optional `scope` array on each
 * snippet (e.g. `["typescript", "typescriptreact"]`); omit to
 * match every language.
 */
export type SnippetDef = {
  prefix: string;
  body: string | string[];
  description?: string;
  scope?: string[];
};

let active: SnippetDef[] = [];
let providerDisposable: { dispose: () => void } | null = null;

/** Load (or reload) snippets from disk and (re)register the
 *  completion provider. Idempotent — safe to call on every
 *  workspace switch. */
export async function loadSnippets(
  root: string | null,
  monaco: typeof MonacoNs,
): Promise<number> {
  active = [];
  if (root) {
    try {
      const raw = await ipc.readTextFile(`${root}/.pointer/snippets.json`);
      const parsed = JSON.parse(raw) as Record<string, SnippetDef>;
      active = Object.values(parsed).filter(
        (s) => s && typeof s.prefix === "string" && (typeof s.body === "string" || Array.isArray(s.body)),
      );
    } catch {
      /* no snippets file or invalid JSON — leave list empty */
    }
  }
  // Re-register so the provider closure sees the new active list.
  providerDisposable?.dispose();
  providerDisposable = monaco.languages.registerCompletionItemProvider(
    { pattern: "**" },
    {
      provideCompletionItems(
        model: MonacoEditor.ITextModel,
        position: Position,
      ): languages.ProviderResult<languages.CompletionList> {
        if (active.length === 0) return { suggestions: [] };
        const langId = model.getLanguageId();
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const suggestions: languages.CompletionItem[] = [];
        for (const s of active) {
          if (s.scope && s.scope.length > 0 && !s.scope.includes(langId)) {
            continue;
          }
          const body = Array.isArray(s.body) ? s.body.join("\n") : s.body;
          suggestions.push({
            label: { label: s.prefix, description: s.description ?? "" },
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: s.description ?? "Pointer snippet",
            documentation: {
              value: `\`\`\`\n${body}\n\`\`\``,
              isTrusted: false,
              supportHtml: false,
            },
            range,
          });
        }
        return { suggestions };
      },
    },
  );
  return active.length;
}

/** Create `.pointer/snippets.json` with a tiny seed so the user has
 *  a starting template. Returns the absolute path so callers can
 *  open it in the editor. */
export async function ensureSnippetsFile(root: string): Promise<string> {
  const dir = `${root}/.pointer`;
  const path = `${dir}/snippets.json`;
  try {
    await ipc.readTextFile(path);
    return path;
  } catch {
    /* create */
  }
  await ipc.createDir(dir).catch(() => {});
  const seed: Record<string, SnippetDef> = {
    "react-fc": {
      prefix: "rfc",
      body: [
        "export function ${1:Component}() {",
        "  return <div>$0</div>;",
        "}",
      ],
      description: "React functional component",
      scope: ["typescriptreact", "javascriptreact"],
    },
    "console-log": {
      prefix: "clg",
      body: "console.log($0);",
      description: "console.log",
      scope: ["javascript", "typescript", "javascriptreact", "typescriptreact"],
    },
  };
  await ipc.writeTextFile(path, `${JSON.stringify(seed, null, 2)}\n`);
  return path;
}
