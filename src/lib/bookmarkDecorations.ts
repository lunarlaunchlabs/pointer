import { useEffect, useMemo, useRef } from "@/lib/preactSignalCompat";
import type * as monaco from "monaco-editor";
import { useBookmarks } from "@/store/bookmarks";

/**
 * Render gutter decorations for every bookmark on the active file.
 * Uses a stable `glyphMargin` style so toggling a bookmark is a
 * single decoration delta (cheap), not a wholesale re-paint.
 *
 * The class name is defined in `index.css` (`.pn-bookmark-glyph`) —
 * we don't inline the styling because Monaco passes the className
 * through to its own glyph DOM and our app-wide CSS variables are
 * the easiest way to keep it themable.
 */
export function useBookmarkDecorations(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  path: string | null,
): void {
  const decoIdsRef = useRef<string[]>([]);
  // Subscribe to the raw bookmarks array (stable reference across
  // unrelated store updates) and filter in a memo. Returning a
  // freshly-filtered array from the selector itself would break
  // Zustand v5's strict reference equality and trigger an infinite
  // re-render loop via useSyncExternalStore.
  const allBookmarks = useBookmarks((s) => s.bookmarks);
  const marks = useMemo(
    () => (path ? allBookmarks.filter((b) => b.path === path) : []),
    [allBookmarks, path],
  );

  useEffect(() => {
    if (!editor) return;
    const ed = editor;
    const next: monaco.editor.IModelDeltaDecoration[] = marks.map((m) => ({
      range: {
        startLineNumber: m.line,
        endLineNumber: m.line,
        startColumn: 1,
        endColumn: 1,
      },
      options: {
        isWholeLine: false,
        glyphMarginClassName: "pn-bookmark-glyph",
        glyphMarginHoverMessage: { value: `Bookmark · ${m.preview}` },
        overviewRuler: {
          color: "rgba(255, 45, 126, 0.7)",
          position: 4, // monaco.editor.OverviewRulerLane.Full
        },
      },
    }));
    decoIdsRef.current = ed.deltaDecorations(decoIdsRef.current, next);
    return () => {
      try {
        decoIdsRef.current = ed.deltaDecorations(decoIdsRef.current, []);
      } catch {
        /* editor disposed */
      }
    };
  }, [editor, marks]);
}
