import { DiffEditor, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useCallback, useRef } from "@/lib/preactSignalCompat";
import { ArrowLeftRight, ExternalLink, X } from "@/lib/lucide";
import { setPointerMonacoTheme } from "@/lib/shikiMonaco";
import { useDiffViewer } from "@/store/diffViewer";
import { useEditorStore } from "@/store/editor";
import { useSettings } from "@/store/settings";

/**
 * Side-by-side diff viewer rendered in place of the regular Monaco
 * editor whenever `useDiffViewer.spec` is set. Driven by the Source
 * Control panel today; the same surface is what the agent's
 * "preview a proposed change" flow will eventually plug into.
 *
 * The toolbar above the diff offers:
 *   • Title (original ↔ modified labels)
 *   • Swap sides (handy when reading inverted git output)
 *   • "Open file" — closes the diff and reveals the underlying path
 *   • Close (Esc)
 */
export function DiffView() {
  const spec = useDiffViewer((s) => s.spec);
  const close = useDiffViewer((s) => s.close);
  const openFile = useEditorStore((s) => s.openFile);
  const appTheme = useSettings((s) => s.appTheme);
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const swapRef = useRef(false);

  const onMount = useCallback(
    (e: editor.IStandaloneDiffEditor, m: Monaco) => {
      editorRef.current = e;
      setPointerMonacoTheme(m, appTheme);
    },
    [appTheme],
  );

  if (!spec) return null;

  const original = swapRef.current ? spec.modified : spec.original;
  const modified = swapRef.current ? spec.original : spec.modified;

  return (
    <div
      className="absolute inset-0 z-pn-editor-overlay flex flex-col bg-noir-canvas"
      role="region"
      aria-label={`Diff: ${spec.title}`}
    >
      <div
        className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-noir-line bg-noir-chrome/70 text-[12px] font-sans"
        role="toolbar"
        aria-label="Diff toolbar"
      >
        <span className="text-noir-text truncate">{spec.title}</span>
        <span className="text-noir-mute text-[10.5px] uppercase tracking-wider hidden sm:inline">
          {swapRef.current ? "modified ↔ original" : "original ↔ modified"}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => {
            swapRef.current = !swapRef.current;
            // Force re-render via close+show without losing the spec.
            useDiffViewer.setState((s) => ({ spec: s.spec ? { ...s.spec } : null }));
          }}
          className="px-1.5 py-0.5 rounded text-noir-subtext hover:text-noir-text hover:bg-noir-ridge/60 inline-flex items-center gap-1"
          title="Swap original / modified"
          aria-label="Swap original and modified sides"
        >
          <ArrowLeftRight size={11} aria-hidden="true" /> Swap
        </button>
        {spec.path && (
          <button
            onClick={() => {
              const p = spec.path!;
              close();
              openFile(p);
            }}
            className="px-1.5 py-0.5 rounded text-noir-subtext hover:text-noir-text hover:bg-noir-ridge/60 inline-flex items-center gap-1"
            title="Open file in editor"
            aria-label={`Open ${spec.path} in editor`}
          >
            <ExternalLink size={11} aria-hidden="true" /> Open file
          </button>
        )}
        <button
          onClick={close}
          className="px-1.5 py-0.5 rounded text-noir-subtext hover:text-noir-text hover:bg-noir-ridge/60 inline-flex items-center gap-1"
          title="Close diff (Esc)"
          aria-label="Close diff view"
        >
          <X size={11} aria-hidden="true" /> Close
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <DiffEditor
          height="100%"
          original={original}
          modified={modified}
          language={spec.language || "plaintext"}
          theme={appTheme}
          beforeMount={(monaco) => setPointerMonacoTheme(monaco, appTheme)}
          onMount={onMount}
          options={{
            readOnly: spec.readOnly,
            originalEditable: false,
            renderSideBySide: true,
            renderOverviewRuler: true,
            renderIndicators: true,
            ignoreTrimWhitespace: false,
            fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
            fontSize: 13,
            lineHeight: 1.55,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderLineHighlight: "none",
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            guides: { indentation: true },
          }}
        />
      </div>
    </div>
  );
}
