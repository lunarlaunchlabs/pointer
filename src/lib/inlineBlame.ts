import { useEffect, useRef } from "react";
import type * as monaco from "monaco-editor";
import { ipc, type GitBlameLine } from "@/lib/ipc";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";

/**
 * Per-line "current line" git blame annotation, shown as a faint
 * trailing decoration on the line containing the cursor. Mirrors
 * VS Code's GitLens "current line blame" — far cheaper than the
 * full inline-per-line treatment because we only render one
 * decoration at a time.
 *
 * Why current-line only? Annotating every line at once turns into
 * visual noise and the per-line decoration cost in Monaco is
 * O(n) per repaint. The current-line approach gives 90% of the
 * value at ~0 overhead.
 *
 * Caching: we fetch the blame for a file once and reuse it for the
 * lifetime of the tab. The blame is invalidated on file save (the
 * user just rewrote some of those lines, so the local cache is
 * stale anyway). We also debounce cursor moves so a rapid arrow-
 * key scroll doesn't churn decorations.
 */
export function useInlineBlame(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  path: string | null,
  dirty: boolean,
): void {
  const blameRef = useRef<GitBlameLine[] | null>(null);
  const decoIdsRef = useRef<string[]>([]);
  const debounceRef = useRef<number | null>(null);
  const blameEnabled = useSettings((s) => s.gitInlineBlame ?? true);
  const root = useWorkspace((s) => s.root);

  // Fetch blame once per tab change. We deliberately skip dirty
  // files — the line numbers no longer correspond to what's in git,
  // and a wrong annotation is worse than no annotation.
  useEffect(() => {
    blameRef.current = null;
    if (!blameEnabled || !root || !path || dirty) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await ipc.gitBlameFile(root, path);
        if (!cancelled) blameRef.current = result;
      } catch {
        if (!cancelled) blameRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, root, dirty, blameEnabled]);

  // Decoration installer. Reads the cursor position and (re)paints
  // a single after-line decoration with the blame for that line.
  useEffect(() => {
    if (!editor || !blameEnabled) return;
    const ed = editor;
    const update = () => {
      const blame = blameRef.current;
      const model = ed.getModel();
      if (!model || !blame) {
        // Clear stale decorations if blame went away.
        if (decoIdsRef.current.length) {
          decoIdsRef.current = ed.deltaDecorations(decoIdsRef.current, []);
        }
        return;
      }
      const pos = ed.getPosition();
      if (!pos) return;
      const idx = pos.lineNumber - 1;
      if (idx < 0 || idx >= blame.length) {
        decoIdsRef.current = ed.deltaDecorations(decoIdsRef.current, []);
        return;
      }
      const entry = blame[idx];
      // Don't annotate the "Not Committed Yet" placeholder git
      // emits for unstaged edits — those are noise.
      if (entry.author === "Not Committed Yet" || entry.hash.startsWith("0000")) {
        decoIdsRef.current = ed.deltaDecorations(decoIdsRef.current, []);
        return;
      }
      const text = ` ${entry.author} · ${entry.date} · ${entry.summary}`;
      decoIdsRef.current = ed.deltaDecorations(decoIdsRef.current, [
        {
          range: {
            startLineNumber: pos.lineNumber,
            endLineNumber: pos.lineNumber,
            startColumn: model.getLineMaxColumn(pos.lineNumber),
            endColumn: model.getLineMaxColumn(pos.lineNumber),
          },
          options: {
            after: {
              content: text,
              inlineClassName: "pn-inline-blame",
            },
            isWholeLine: false,
          },
        },
      ]);
    };
    const debounced = () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(update, 80);
    };
    const subA = ed.onDidChangeCursorPosition(debounced);
    const subB = ed.onDidChangeModel(debounced);
    update();
    return () => {
      subA.dispose();
      subB.dispose();
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      if (decoIdsRef.current.length) {
        try {
          decoIdsRef.current = ed.deltaDecorations(decoIdsRef.current, []);
        } catch {
          /* editor already disposed */
        }
      }
    };
  }, [editor, blameEnabled]);
}
