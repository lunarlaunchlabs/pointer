import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, Sparkles } from "lucide-react";
import { ipc, listenEvent, newRequestId } from "@/lib/ipc";
import { useSettings } from "@/store/settings";
import { useEditorStore } from "@/store/editor";
import { useDiagnostics, type Diagnostic } from "@/store/diagnostics";
import { applyHunks, parseSearchReplace } from "@/lib/diff";
import { useRecentEdits } from "@/store/recentEdits";
import { buildInlineEditContext } from "@/lib/inlineEditContext";
import { languageFromPath } from "@/lib/lang";

export function InlineEdit({
  selection,
  position,
  onClose,
  onProposeDiff,
}: {
  selection: { startLine: number; endLine: number; text: string };
  position: { top: number; left: number };
  onClose: () => void;
  onProposeDiff: (original: string, proposed: string, description?: string) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const streamBufferRef = useRef("");
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const chatModel = useSettings((s) => s.chatModel);
  const active = useEditorStore((s) => s.getActive());

  // Diagnostics intersecting the current selection. When present, we
  // surface them inline and offer a one-click "Fix this" prefill so
  // the user doesn't have to retype the lint message into the prompt.
  const diagnosticsByUri = useDiagnostics((s) => s.byUri);
  const overlappingDiags = useMemo<Diagnostic[]>(() => {
    if (!active) return [];
    const uri = pathToUri(active.path);
    const list = diagnosticsByUri[uri] ?? [];
    return list.filter(
      (d) =>
        d.endLine >= selection.startLine && d.startLine <= selection.endLine,
    );
  }, [diagnosticsByUri, active?.path, selection.startLine, selection.endLine]);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    const instruction = prompt.trim();
    if (!instruction || !active || streaming) return;
    setStreaming(true);
    streamBufferRef.current = "";
    setPartial("");
    setError(null);
    const rid = newRequestId("cmdk");
    const system = `You are Pointer's inline editor. The user has selected lines ${selection.startLine}-${selection.endLine} of file ${active.path}. Respond with EXACTLY ONE search/replace block using this format and nothing else:

<<<<<<< SEARCH ${active.path}
${selection.text}
=======
...your replacement...
>>>>>>> REPLACE

Preserve indentation. Honour the surrounding style (naming, imports,
type usage). Do not include backticks or commentary.`;

    // Build an enriched user message that gives the chat model
    //   • the selection (verbatim),
    //   • ~8 lines of surrounding code (style + structure cues),
    //   • the pattern signature around the selection,
    //   • any overlapping diagnostics (lint messages the model
    //     should respect when fixing),
    //   • a short snippet of recently-edited files (the working set,
    //     so the model knows what helpers / types are at hand).
    // The selection and surrounding context are sacred; recent
    // files get dropped first when the budget is tight.
    const recents = useRecentEdits
      .getState()
      .selectRecent(active.path, 3)
      .map((r) => ({ path: r.path, content: r.content }));
    const ctx = buildInlineEditContext({
      filePath: active.path,
      fileContent: active.content,
      selection,
      language: languageFromPath(active.path) ?? "typescript",
      recentFiles: recents,
      diagnostics: overlappingDiags.map((d) => ({
        line: d.startLine,
        message: d.message,
        severity: d.severity,
      })),
      budgetChars: 3_000,
    });
    const userMessage = `${ctx.userMessage}\n\nInstruction: ${instruction}`;

    let off: (() => void) | null = null;
    try {
      off = await listenEvent<
        | { token: string }
        | { done: true }
        | { error: string; done: true }
      >(`ollama:chat:${rid}`, (p) => {
        if ("token" in p) {
          streamBufferRef.current += p.token;
          setPartial(streamBufferRef.current);
        }
        if ("error" in p) {
          setError(p.error);
          if ("done" in p && p.done) {
            off?.();
            setStreaming(false);
          }
          return;
        }
        if ("done" in p && p.done) {
          off?.();
          setStreaming(false);
          const hunks = parseSearchReplace(streamBufferRef.current);
          if (hunks.length > 0 && active) {
            const { text: out, applied } = applyHunks(active.content, hunks);
            if (applied > 0) {
              onProposeDiff(active.content, out, instruction);
            } else {
              setError("Could not match the selection to apply the edit.");
            }
          } else {
            setError("Model didn't return a search/replace block.");
          }
        }
      });

      await ipc.ollamaChat(rid, {
        model: chatModel,
        messages: [{ role: "user", content: userMessage }],
        system,
        temperature: 0.2,
        purpose: "inline_edit",
        title: `Inline edit ${active?.path ?? ""}`,
      });
    } catch (e) {
      off?.();
      setStreaming(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="absolute z-pn-inline-edit pn-pulse"
      style={{
        top: Math.max(40, Math.min(position.top, window.innerHeight - 200)),
        left: Math.max(8, Math.min(position.left, window.innerWidth - 480)),
        width: 480,
      }}
      role="dialog"
      aria-label={`Inline edit for lines ${selection.startLine} through ${selection.endLine}`}
      aria-modal="false"
    >
      <div className="rounded-lg border border-noir-accent/40 bg-noir-panel/95 shadow-soft overflow-hidden backdrop-blur-md">
        <div className="px-3 pt-2 pb-1 flex items-center gap-2 border-b border-noir-line/60">
          <Sparkles size={12} className="text-noir-accent" aria-hidden="true" />
          <span className="font-sans text-[11px] text-noir-subtext">
            Inline edit • {selection.startLine}–{selection.endLine}
          </span>
          <div className="flex-1" />
          <span className="font-sans text-[10px] text-noir-mute">
            <kbd className="pn-kbd">Esc</kbd> to close
          </span>
        </div>
        {overlappingDiags.length > 0 && (
          <div
            className="px-3 py-1.5 border-b border-noir-line/60 bg-noir-warn/5 flex items-center gap-2 text-[11px] font-sans"
            role="status"
            aria-live="polite"
          >
            <AlertCircle
              size={11}
              className={
                overlappingDiags.some((d) => d.severity === "error")
                  ? "text-noir-err"
                  : "text-noir-warn"
              }
              aria-hidden="true"
            />
            <span className="flex-1 truncate text-noir-text">
              {overlappingDiags[0].message}
              {overlappingDiags.length > 1 && (
                <span className="text-noir-mute ml-1">
                  +{overlappingDiags.length - 1} more
                </span>
              )}
            </span>
            <button
              className="px-1.5 py-0.5 rounded text-[10px] text-noir-accent hover:bg-noir-ridge/60"
              onClick={() => {
                setPrompt(diagnosticPrompt(overlappingDiags));
                inputRef.current?.focus();
              }}
              title="Pre-fill the prompt with a 'fix these errors' instruction"
            >
              Fix these
            </button>
          </div>
        )}
        <textarea
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          placeholder={
            overlappingDiags.length
              ? "Click 'Fix these' or describe a different change…"
              : "Refactor this to..."
          }
          aria-label="Inline edit instruction"
          className="w-full bg-transparent text-[13px] text-noir-text px-3 py-2 outline-none resize-none placeholder-noir-mute font-sans"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {(streaming || partial) && (
          <div className="border-t border-noir-line/60 max-h-40 overflow-y-auto">
            <pre
              data-cmdk-buffer
              className="text-[11px] text-noir-subtext px-3 py-2 whitespace-pre-wrap font-mono"
              aria-live="polite"
              aria-label="Generated edit preview"
            >
              {partial}
            </pre>
          </div>
        )}
        {error && (
          <div
            className="border-t border-noir-err/30 px-3 py-2 text-[11px] text-noir-err font-sans bg-noir-err/5"
            role="alert"
          >
            {error}
          </div>
        )}
        <div className="px-3 py-2 flex items-center justify-end gap-2 border-t border-noir-line/60 bg-noir-chrome/40">
          <button onClick={onClose} className="pn-button font-sans" aria-label="Cancel inline edit (Escape)">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={streaming}
            className="pn-button-accent font-sans flex items-center gap-1.5"
            aria-label={streaming ? "Generating edit, please wait" : "Generate inline edit (Enter)"}
          >
            {streaming ? (
              <>
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                Generating
              </>
            ) : (
              <>
                <Sparkles size={11} aria-hidden="true" />
                Generate <kbd className="opacity-70 ml-1">⏎</kbd>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Render a "fix these issues" prompt that summarises every overlapping
 *  diagnostic. We include the source/code so the model has enough
 *  context to write a targeted fix rather than guessing. */
function diagnosticPrompt(diags: Diagnostic[]): string {
  if (diags.length === 1) {
    const d = diags[0];
    const code = d.code ? ` (${d.source} ${d.code})` : ` (${d.source})`;
    return `Fix this ${d.severity}${code}: ${d.message}`;
  }
  const lines = diags.map((d) => {
    const code = d.code ? `[${d.source} ${d.code}] ` : `[${d.source}] `;
    return `- L${d.startLine}: ${code}${d.message}`;
  });
  return `Fix the following ${diags.length} issues in this selection:\n${lines.join("\n")}`;
}

/** Convert an absolute file path into the Monaco URI form used by the
 *  diagnostics store (`file:///abs/path`). Mirror of `uriToPath`
 *  helpers elsewhere — kept here so InlineEdit doesn't depend on the
 *  send-to-AI module. */
function pathToUri(p: string): string {
  if (p.startsWith("file://")) return p;
  return p.startsWith("/") ? `file://${p}` : `file:///${p}`;
}
