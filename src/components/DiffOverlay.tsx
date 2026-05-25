import { DiffEditor } from "@monaco-editor/react";
import { Check, X, Zap } from "lucide-react";
import { POINTER_NOIR_ID, pointerNoirTheme } from "@/theme/pointer-noir";
import { useEditorStore } from "@/store/editor";

export function DiffOverlay({
  original,
  proposed,
  description,
  stats,
  onAccept,
  onReject,
}: {
  original: string;
  proposed: string;
  description?: string;
  stats?: { validated: boolean; elapsedMs: number; charsPerSec: number };
  onAccept: () => void;
  onReject: () => void;
}) {
  const active = useEditorStore((s) => s.getActive());
  const language = active?.language ?? "plaintext";

  return (
    <div
      className="absolute inset-0 z-pn-editor-overlay bg-noir-canvas/85 backdrop-blur-sm flex flex-col"
      role="region"
      aria-label="Proposed AI change"
    >
      <div
        className="h-9 px-4 flex items-center justify-between bg-noir-chrome/80 border-b border-noir-line"
        role="toolbar"
        aria-label="Diff actions"
      >
        <div className="flex items-center gap-2 font-sans text-[12px]">
          <span className="text-noir-accent" aria-hidden="true">▸</span>
          <span className="text-noir-text">Proposed change</span>
          {description && (
            <span className="text-noir-mute truncate max-w-md ml-2">
              — {description}
            </span>
          )}
          {stats && (
            <span
              className={`ml-2 inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded border ${
                stats.validated
                  ? "border-noir-ok/40 bg-noir-ok/10 text-noir-ok"
                  : "border-noir-warn/40 bg-noir-warn/10 text-noir-warn"
              }`}
              title="Fast Apply ran a deterministic prefix/suffix check on the rewrite."
            >
              <Zap size={9} aria-hidden="true" />
              {stats.validated ? "validated" : "review carefully"} ·{" "}
              {Math.round(stats.charsPerSec)} ch/s
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onReject}
            className="pn-button font-sans flex items-center gap-1.5"
            aria-label="Reject proposed change (Escape)"
          >
            <X size={11} aria-hidden="true" />
            Reject
          </button>
          <button
            onClick={onAccept}
            className="pn-button-accent font-sans flex items-center gap-1.5"
            aria-label="Accept proposed change (Enter)"
          >
            <Check size={11} aria-hidden="true" />
            Accept <kbd className="opacity-70 ml-1">⏎</kbd>
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <DiffEditor
          original={original}
          modified={proposed}
          language={language}
          theme={POINTER_NOIR_ID}
          beforeMount={(monaco) => {
            monaco.editor.defineTheme(POINTER_NOIR_ID, pointerNoirTheme);
          }}
          options={{
            renderSideBySide: true,
            readOnly: true,
            originalEditable: false,
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            fontSize: 13,
            lineHeight: 1.55,
            scrollBeyondLastLine: false,
            renderLineHighlight: "none",
            minimap: { enabled: false },
            renderOverviewRuler: false,
          }}
        />
      </div>
    </div>
  );
}
