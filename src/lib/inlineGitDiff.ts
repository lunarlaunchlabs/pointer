import { useEffect, useRef } from "@/lib/preactSignalCompat";
import type * as monaco from "monaco-editor";
import { toast } from "@/components/Toast";
import { ipc } from "@/lib/ipc";
import { languageFromPath } from "@/lib/lang";
import { pathFromMonacoUri } from "@/lib/monacoUri";
import { useDiffViewer } from "@/store/diffViewer";
import { useGit } from "@/store/git";
import { useWorkspace } from "@/store/workspace";

export type InlineGitDiffChangeKind = "added" | "modified" | "deleted";

export type InlineGitDiffChange = {
  kind: InlineGitDiffChangeKind;
  /** 1-based line in the modified buffer where the marker should anchor. */
  lineNumber: number;
  /** Number of modified-buffer lines covered. Deleted-only hunks use 0. */
  lineCount: number;
  /** Number of HEAD lines replaced or removed. */
  originalLineCount: number;
  /** Small sample for hover text. Full original content stays in Git/diff view. */
  originalLines?: string[];
};

const EXACT_DIFF_CELL_LIMIT = 420_000;
const MAX_RENDERED_HUNKS = 1_500;
const HOVER_LINE_LIMIT = 8;

export function computeInlineGitDiff(
  original: string,
  modified: string,
): InlineGitDiffChange[] {
  const before = normalizedLines(original);
  const after = normalizedLines(modified);
  if (sameLines(before, after)) return [];
  if (before.length === 0) {
    return after.length
      ? [{ kind: "added", lineNumber: 1, lineCount: after.length, originalLineCount: 0 }]
      : [];
  }
  if (after.length === 0) {
    return [
      {
        kind: "deleted",
        lineNumber: 1,
        lineCount: 0,
        originalLineCount: before.length,
        originalLines: sampleLines(before),
      },
    ];
  }

  if (before.length * after.length > EXACT_DIFF_CELL_LIMIT) {
    return computeCoarseInlineGitDiff(before, after);
  }

  const dp = Array.from(
    { length: before.length + 1 },
    () => new Uint32Array(after.length + 1),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = dp[i];
    const nextRow = dp[i + 1];
    for (let j = after.length - 1; j >= 0; j -= 1) {
      row[j] =
        before[i] === after[j]
          ? nextRow[j + 1] + 1
          : Math.max(nextRow[j], row[j + 1]);
    }
  }

  const changes: InlineGitDiffChange[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      i += 1;
      j += 1;
      continue;
    }

    const startOriginal = i;
    const startModified = j;
    const removed: string[] = [];
    let addedCount = 0;

    while (
      (i < before.length || j < after.length) &&
      !(i < before.length && j < after.length && before[i] === after[j])
    ) {
      if (j < after.length && (i >= before.length || dp[i][j + 1] >= dp[i + 1][j])) {
        addedCount += 1;
        j += 1;
      } else if (i < before.length) {
        removed.push(before[i]);
        i += 1;
      }
    }

    pushInlineChange(changes, {
      startModified,
      addedCount,
      removed,
      modifiedLineCount: after.length,
      originalLineCount: before.length - startOriginal,
    });
  }

  return changes;
}

export function relativeGitPath(workspace: string, absolutePath: string): string | null {
  const root = normalizeAbs(workspace);
  const abs = normalizeAbs(absolutePath);
  if (!root || !abs) return null;
  if (abs === root) return "";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!abs.startsWith(prefix)) return null;
  return abs.slice(prefix.length).replace(/^\/+/, "");
}

export function useInlineGitDiff(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  path: string | null,
): void {
  const root = useWorkspace((s) => s.root);
  const lastRefresh = useGit((s) => s.lastRefresh);
  const collectionRef =
    useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const originalRef = useRef<{
    path: string;
    relativePath: string;
    content: string;
  } | null>(null);
  const requestRef = useRef(0);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!editor) return;
    const action = editor.addAction({
      id: "pointer.git.showCurrentFileDiff",
      label: "Pointer: Show Git Diff for Current File",
      contextMenuGroupId: "1_pointer",
      contextMenuOrder: 1.25,
      run: async (ed) => {
        await showCurrentFileDiff(ed);
      },
    });
    const clickSub = editor.onMouseDown((event) => {
      const target = event.target.element as HTMLElement | null;
      if (!target || !String(target.className).includes("pn-git-diff")) return;
      void showCurrentFileDiff(editor);
    });
    return () => {
      action.dispose();
      clickSub.dispose();
    };
  }, [editor]);

  useEffect(() => {
    const ed = editor;
    const relativePath = root && path ? relativeGitPath(root, path) : null;
    if (!ed || !root || !path || path.startsWith("untitled:") || !relativePath) {
      clearGitDiffDecorations(collectionRef);
      originalRef.current = null;
      return;
    }

    let cancelled = false;
    const request = requestRef.current + 1;
    requestRef.current = request;
    clearGitDiffDecorations(collectionRef);
    originalRef.current = null;

    const paint = () => {
      if (cancelled || requestRef.current !== request) return;
      const original = originalRef.current;
      const model = ed.getModel();
      if (!original || !model || pathFromMonacoUri(model.uri.toString()) !== path) {
        clearGitDiffDecorations(collectionRef);
        return;
      }
      const changes = computeInlineGitDiff(original.content, model.getValue());
      applyGitDiffDecorations(ed, collectionRef, changes.slice(0, MAX_RENDERED_HUNKS));
    };

    ipc
      .gitShowFile(root, relativePath, "head")
      .then((content) => {
        if (cancelled || requestRef.current !== request) return;
        originalRef.current = { path, relativePath, content };
        paint();
      })
      .catch(() => {
        if (cancelled) return;
        originalRef.current = null;
        clearGitDiffDecorations(collectionRef);
      });

    const schedulePaint = () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(paint, 120);
    };
    const contentSub = ed.onDidChangeModelContent(schedulePaint);
    const modelSub = ed.onDidChangeModel(schedulePaint);

    return () => {
      cancelled = true;
      contentSub.dispose();
      modelSub.dispose();
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      clearGitDiffDecorations(collectionRef);
    };
  }, [editor, root, path, lastRefresh]);
}

async function showCurrentFileDiff(
  editor: monaco.editor.ICodeEditor,
): Promise<void> {
  const model = editor.getModel();
  const root = useWorkspace.getState().root;
  if (!model || !root) {
    toast.warn("Open a file in a Git workspace first");
    return;
  }

  const path = pathFromMonacoUri(model.uri.toString());
  const relativePath = relativeGitPath(root, path);
  if (!relativePath) {
    toast.warn("Git diff unavailable", {
      body: "This file is outside the open workspace.",
    });
    return;
  }

  try {
    const original = await ipc.gitShowFile(root, relativePath, "head");
    useDiffViewer.getState().show({
      title: `${relativePath} (HEAD ↔ working tree)`,
      language: languageFromPath(path),
      original,
      modified: model.getValue(),
      readOnly: true,
      path,
      source: "head",
    });
  } catch (error) {
    toast.warn("Git diff unavailable", {
      body: error instanceof Error ? error.message : String(error),
    });
  }
}

function applyGitDiffDecorations(
  editor: monaco.editor.IStandaloneCodeEditor,
  collectionRef: { current: monaco.editor.IEditorDecorationsCollection | null },
  changes: InlineGitDiffChange[],
): void {
  const model = editor.getModel();
  if (!model || changes.length === 0) {
    clearGitDiffDecorations(collectionRef);
    return;
  }
  const lineCount = model.getLineCount();
  const decorations = changes.map((change) => {
    const lineNumber = clamp(change.lineNumber, 1, lineCount);
    const span = Math.max(change.lineCount, 1);
    const endLineNumber = clamp(lineNumber + span - 1, lineNumber, lineCount);
    return {
      range: {
        startLineNumber: lineNumber,
        startColumn: 1,
        endLineNumber,
        endColumn: model.getLineMaxColumn(endLineNumber),
      },
      options: decorationOptions(change),
    };
  });

  if (!collectionRef.current) {
    collectionRef.current = editor.createDecorationsCollection();
  }
  collectionRef.current.set(decorations);
}

function clearGitDiffDecorations(collectionRef: {
  current: monaco.editor.IEditorDecorationsCollection | null;
}): void {
  collectionRef.current?.clear();
}

function decorationOptions(
  change: InlineGitDiffChange,
): monaco.editor.IModelDecorationOptions {
  const label = gitChangeLabel(change);
  const base: monaco.editor.IModelDecorationOptions = {
    isWholeLine: true,
    className: `pn-git-diff-line pn-git-diff-line-${change.kind}`,
    glyphMarginClassName: `pn-git-diff-glyph pn-git-diff-glyph-${change.kind}`,
    linesDecorationsClassName: `pn-git-diff-bar pn-git-diff-bar-${change.kind}`,
    hoverMessage: [{ value: gitChangeHover(change, label) }],
  };
  if (change.kind === "deleted") {
    return {
      ...base,
      after: {
        content: `  - ${label}`,
        inlineClassName: "pn-git-diff-deleted-text",
      },
    };
  }
  return base;
}

function gitChangeLabel(change: InlineGitDiffChange): string {
  if (change.kind === "added") {
    return change.lineCount === 1 ? "1 added line" : `${change.lineCount} added lines`;
  }
  if (change.kind === "deleted") {
    return change.originalLineCount === 1
      ? "1 deleted line"
      : `${change.originalLineCount} deleted lines`;
  }
  const added = change.lineCount === 1 ? "1 line" : `${change.lineCount} lines`;
  const removed =
    change.originalLineCount === 1 ? "1 original line" : `${change.originalLineCount} original lines`;
  return `${added} changed from ${removed}`;
}

function gitChangeHover(change: InlineGitDiffChange, label: string): string {
  const sample = change.originalLines?.length
    ? `\n\nOriginal:\n\`\`\`\n${change.originalLines.join("\n")}\n\`\`\``
    : "";
  return `**Git change:** ${label}\n\nRun **Pointer: Show Git Diff for Current File** for the full diff.${sample}`;
}

function computeCoarseInlineGitDiff(
  before: string[],
  after: string[],
): InlineGitDiffChange[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const addedCount = after.length - prefix - suffix;
  const changes: InlineGitDiffChange[] = [];
  pushInlineChange(changes, {
    startModified: prefix,
    addedCount,
    removed,
    modifiedLineCount: after.length,
    originalLineCount: before.length - prefix,
  });
  return changes;
}

function pushInlineChange(
  changes: InlineGitDiffChange[],
  input: {
    startModified: number;
    addedCount: number;
    removed: string[];
    modifiedLineCount: number;
    originalLineCount: number;
  },
): void {
  if (input.addedCount <= 0 && input.removed.length <= 0) return;
  const lineNumber = Math.max(
    1,
    Math.min(input.modifiedLineCount || 1, input.startModified + 1),
  );
  if (input.addedCount > 0 && input.removed.length > 0) {
    changes.push({
      kind: "modified",
      lineNumber,
      lineCount: input.addedCount,
      originalLineCount: input.removed.length,
      originalLines: sampleLines(input.removed),
    });
    return;
  }
  if (input.addedCount > 0) {
    changes.push({
      kind: "added",
      lineNumber,
      lineCount: input.addedCount,
      originalLineCount: 0,
    });
    return;
  }
  changes.push({
    kind: "deleted",
    lineNumber,
    lineCount: 0,
    originalLineCount: input.removed.length || input.originalLineCount,
    originalLines: sampleLines(input.removed),
  });
}

function normalizedLines(value: string): string[] {
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, index) => line === b[index]);
}

function sampleLines(lines: string[]): string[] {
  return lines.slice(0, HOVER_LINE_LIMIT);
}

function normalizeAbs(path: string): string {
  const normal = path.replace(/\\/g, "/");
  if (normal === "/") return normal;
  return normal.replace(/\/+$/, "");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
