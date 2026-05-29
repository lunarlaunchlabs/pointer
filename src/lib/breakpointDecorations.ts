import { useEffect, useMemo, useRef } from "react";
import type * as monaco from "monaco-editor";
import { useDebuggerStore } from "@/store/debugger";

export function useBreakpointDecorations(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  path: string | null,
): void {
  const ids = useRef<string[]>([]);
  const all = useDebuggerStore((s) => s.breakpoints);
  const breakpoints = useMemo(
    () => (path ? all.filter((bp) => bp.path === path) : []),
    [all, path],
  );

  useEffect(() => {
    if (!editor) return;
    ids.current = editor.deltaDecorations(
      ids.current,
      breakpoints.map((bp) => ({
        range: {
          startLineNumber: bp.line,
          endLineNumber: bp.line,
          startColumn: 1,
          endColumn: 1,
        },
        options: {
          isWholeLine: false,
          glyphMarginClassName: bp.enabled
            ? "pn-breakpoint-glyph"
            : "pn-breakpoint-glyph pn-breakpoint-disabled",
          glyphMarginHoverMessage: {
            value: breakpointHover(bp),
          },
          overviewRuler: {
            color: bp.enabled
              ? "rgba(255, 111, 145, 0.85)"
              : "rgba(122, 122, 139, 0.7)",
            position: 4,
          },
        },
      })),
    );
    return () => {
      try {
        ids.current = editor.deltaDecorations(ids.current, []);
      } catch {
        /* editor disposed */
      }
    };
  }, [editor, breakpoints]);
}

function breakpointHover(bp: {
  line: number;
  condition?: string;
  logMessage?: string;
  enabled: boolean;
}): string {
  const parts = [
    `${bp.enabled ? "Breakpoint" : "Disabled breakpoint"} · line ${bp.line}`,
  ];
  if (bp.condition) parts.push(`Condition: \`${bp.condition}\``);
  if (bp.logMessage) parts.push(`Log: \`${bp.logMessage}\``);
  return parts.join("\n\n");
}
