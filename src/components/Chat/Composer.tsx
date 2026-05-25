/**
 * Chat composer — multi-line input + mention picker + attachment bar.
 *
 * Built on the shared `MentionInput`, `MentionPicker` and
 * `ReferenceChips` primitives so the agent panel can mount the same UX
 * without a fork. The composer is otherwise unaware of chat semantics —
 * its parent (Sidebar / AgentPanel) decides what `onSend` does.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  FileUp,
  Loader2,
  Paperclip,
  Square,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Reference } from "@/store/chat";
import { useEditorStore } from "@/store/editor";
import { useDiagnostics, type Diagnostic } from "@/store/diagnostics";
import {
  useSettings,
  isFeatureUsable,
  featureBlockReason,
  type AiFeature,
} from "@/store/settings";
import { ipc } from "@/lib/ipc";
import { toast } from "@/components/Toast";
import {
  applyMention,
  intentFromQuery,
  mentionToken,
  probeMention,
} from "@/lib/mentions";
import { MentionInput } from "@/components/Mention/MentionInput";
import {
  MentionPicker,
  type MentionSelection,
} from "@/components/Mention/MentionPicker";
import { ReferenceChips } from "@/components/Mention/ReferenceChips";

export type ComposerProps = {
  disabled?: boolean;
  streaming?: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  /** Pending references — chips above the textarea. */
  references: Reference[];
  /** Add a reference to the pending list. */
  onAddReference: (r: Reference) => void;
  /** Remove the i-th reference from the pending list. */
  onRemoveReference: (i: number) => void;
  /** Placeholder shown when there's no input yet. */
  placeholder?: string;
  /** Submit hint shown in the footer. */
  submitHint?: string;
};

export function Composer({
  disabled,
  streaming,
  onSend,
  onCancel,
  references,
  onAddReference,
  onRemoveReference,
  placeholder,
  submitHint,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [processing, setProcessing] =
    useState<{ path: string; label: string } | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Editor-level state the composer reads through to surface options
  // (current file → @Paperclip, current selection → @selection, etc.).
  const active = useEditorStore((s) => s.getActive());
  const selection = useEditorStore((s) => s.selection);
  const visionModel = useSettings((s) => s.visionModel);
  const documentModel = useSettings((s) => s.documentModel);
  // The mention picker only enables @codebase when indexing is actually
  // operational (toggle on + runtime up + embedder installed). We mirror
  // the same gate the build-context layer uses.
  const codebaseUsable = useSettings((s) => isFeatureUsable("indexing", s));

  // Mention probe — re-derived on every keystroke from the textarea
  // text + cursor position.
  const [probe, setProbe] = useState<
    | { open: false }
    | { open: true; atStart: number; atEnd: number; query: string }
  >({ open: false });

  // Live file / folder suggestions for the picker. We debounce slightly
  // so a user typing fast doesn't fire one IPC per keystroke. Folder
  // results are only fetched when the user is in `@folder` mode — the
  // distinction is important so a plain `@App` query doesn't surface
  // directory rows alongside file rows.
  const [fileCandidates, setFileCandidates] = useState<{ path: string }[]>([]);
  const [folderCandidates, setFolderCandidates] = useState<{ path: string }[]>(
    [],
  );
  useEffect(() => {
    if (!probe.open) return;
    const { remainder, category } = intentFromQuery(probe.query);
    if (category && category !== "file" && category !== "folder") return;
    const id = setTimeout(async () => {
      try {
        if (category === "folder") {
          const folders = await ipc.searchDirectories(remainder, 16);
          setFolderCandidates(folders.map((f) => ({ path: f.path })));
          setFileCandidates([]);
        } else {
          const files = await ipc.searchFiles(remainder, 16);
          setFileCandidates(files.map((f) => ({ path: f.path })));
          setFolderCandidates([]);
        }
      } catch {
        setFileCandidates([]);
        setFolderCandidates([]);
      }
    }, 60);
    return () => clearTimeout(id);
  }, [probe.open, probe.open && probe.query]);

  // Diagnostics feed for the @diagnostic picker — flattened, sorted,
  // capped. We pull from the shared diagnostics store so the same list
  // shown in the Problems panel is what surfaces here.
  const diagnosticsByUri = useDiagnostics((s) => s.byUri);
  const diagnostics = useMemo<Diagnostic[]>(() => {
    const all = Object.values(diagnosticsByUri).flat();
    return all
      .sort(
        (a, b) =>
          sevRank(b.severity) - sevRank(a.severity) ||
          a.name.localeCompare(b.name) ||
          a.startLine - b.startLine,
      )
      .slice(0, 100);
  }, [diagnosticsByUri]);

  // Tokens to highlight in the mirror overlay. We keep the *current*
  // mention text out of the token list so the in-progress query
  // doesn't flicker between styled and unstyled.
  const highlightTokens = useMemo(
    () => references.map((r) => mentionTokenFor(r)),
    [references],
  );

  // Handlers -------------------------------------------------------------

  const submit = () => {
    if (!text.trim() || disabled) return;
    onSend(text);
    setText("");
    setProbe({ open: false });
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    // Let the picker swallow Enter / Arrow keys when it's open — it
    // installs its own window-level keydown listener above us, so we
    // simply don't touch Enter while the probe is open with rows.
    if (probe.open) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (streaming) onCancel();
      else submit();
    }
  };

  const onChange = (next: string) => {
    setText(next);
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? next.length;
    const p = probeMention(next, caret);
    setProbe(p);
  };

  const onPickMention = (sel: MentionSelection) => {
    if (!probe.open) return;
    // Pure "category" picks (e.g. user selected the @codebase header
    // without typing a query) should not commit a reference yet — they
    // should keep the picker open and let the user type a refinement.
    // We re-target the picker by leaving the `@` text but switching to
    // the category-specific query.
    if (sel.kind === "category") {
      // Selecting a category just confirms the alias and keeps typing.
      // We splice `@<alias>` (no trailing space) so the picker stays
      // open with the alias as the new query — the user can type
      // their refinement immediately.
      const alias = CATEGORY_ALIASES[sel.category];
      const insertion = `@${alias}`;
      const { text: nextText, caret } = applyMention(text, probe, insertion);
      setText(nextText);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(caret, caret);
          setProbe(probeMention(nextText, caret));
        }
      });
      return;
    }
    if (sel.kind === "file") {
      onAddReference({ kind: "file", path: sel.path });
      replaceMention(mentionToken({ kind: "file", path: sel.path }));
      return;
    }
    if (sel.kind === "folder") {
      onAddReference({ kind: "folder", path: sel.path });
      replaceMention(mentionToken({ kind: "folder", path: sel.path }));
      return;
    }
    if (sel.kind === "selection") {
      if (!selection || !active) {
        toast.info("Nothing selected", {
          body: "Highlight some code first, then try again.",
        });
        return;
      }
      onAddReference({
        kind: "selection",
        path: active.path,
        startLine: selection.startLine,
        endLine: selection.endLine,
        text: selection.text,
      });
      replaceMention(
        mentionToken({
          kind: "selection",
          path: active.path,
          startLine: selection.startLine,
          endLine: selection.endLine,
        }),
      );
      return;
    }
    if (sel.kind === "diagnostic") {
      const d = sel.diagnostic;
      // Pull a tiny snippet from the diagnostic range so the LLM can
      // quote the offending lines. We fetch on-demand to avoid keeping
      // a copy of every diagnostic body in store memory.
      const path = uriToPath(d.uri);
      ipc
        .readTextFile(path)
        .then((src) => {
          const snippet = lineRange(src, d.startLine, d.endLine);
          onAddReference({
            kind: "diagnostic",
            path,
            startLine: d.startLine,
            startCol: d.startCol,
            endLine: d.endLine,
            endCol: d.endCol,
            severity: d.severity,
            message: d.message,
            source: d.source,
            code: d.code,
            snippet,
          });
        })
        .catch(() => {
          // Even if reading fails (file moved, etc.), we still attach
          // the diagnostic metadata — the LLM can answer with the
          // message alone.
          onAddReference({
            kind: "diagnostic",
            path,
            startLine: d.startLine,
            startCol: d.startCol,
            endLine: d.endLine,
            endCol: d.endCol,
            severity: d.severity,
            message: d.message,
            source: d.source,
            code: d.code,
            snippet: "",
          });
        });
      replaceMention(
        mentionToken({
          kind: "diagnostic",
          path,
          startLine: d.startLine,
          code: d.code,
        }),
      );
      return;
    }
    if (sel.kind === "codebase") {
      onAddReference({ kind: "codebase", query: sel.query });
      replaceMention(mentionToken({ kind: "codebase", query: sel.query }));
      return;
    }
  };

  const replaceMention = (token: string) => {
    if (!probe.open) return;
    // Always commit a token followed by a single space so the user can
    // keep typing immediately. `applyMention` dedupes against an
    // already-spaced tail so we never produce a double gap.
    const insertion = `${token} `;
    const { text: nextText, caret } = applyMention(text, probe, insertion);
    setText(nextText);
    setProbe({ open: false });
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(caret, caret);
      }
    });
  };

  // File attachment (vision / document / spreadsheet ingestion). Unchanged
  // from before — kept here because it's tightly coupled to the composer
  // chrome (paperclip button, processing banner, error toasts).
  const attachFromDisk = async () => {
    if (processing) return;
    let picked: string | string[] | null = null;
    try {
      picked = await openDialog({
        multiple: false,
        directory: false,
        title: "Attach a file",
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
          { name: "PDFs", extensions: ["pdf"] },
          { name: "Spreadsheets", extensions: ["xlsx", "xls", "xlsm", "ods", "csv", "tsv"] },
          { name: "Text", extensions: ["txt", "md", "json", "yaml", "yml", "toml"] },
          { name: "All", extensions: ["*"] },
        ],
      });
    } catch (e) {
      toast.error("Couldn't open file picker", {
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;

    let info;
    try {
      info = await ipc.classifyFile(path);
    } catch (e) {
      toast.error("Couldn't read that file", {
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    if (info.kind === "unsupported") {
      toast.warn("File type not supported", {
        body:
          info.reason ??
          "Pointer ingests images, PDFs, spreadsheets and text files.",
      });
      return;
    }

    const requiredFeature: AiFeature | null =
      info.required_purpose === "vision"
        ? "vision"
        : info.required_purpose === "document"
        ? "document"
        : null;
    if (requiredFeature && !isFeatureUsable(requiredFeature)) {
      const reason = featureBlockReason(requiredFeature);
      const purposeLabel =
        info.required_purpose === "vision" ? "vision" : "document";
      toast.warn(`Can't process this ${info.label.toLowerCase()}`, {
        body: `${reason} Pick a ${purposeLabel} model in AI Control Panel → Models.`,
        sticky: true,
      });
      return;
    }
    const requiredModel = requiredFeature
      ? requiredFeature === "vision"
        ? visionModel
        : documentModel
      : null;

    setProcessing({ path, label: info.label });
    try {
      const result = await ipc.processFile({
        path,
        model: requiredModel ?? undefined,
      });
      onAddReference({
        kind: "processed",
        path,
        fileKind: result.kind,
        label: result.label,
        model: result.model_name,
        content: result.content,
        raw_bytes: result.raw_bytes,
      });
      if (result.used_model && result.model_name) {
        toast.success(`Attached ${result.label.toLowerCase()}`, {
          body: `Processed with ${result.model_name} (auto-unloaded).`,
        });
      } else {
        toast.success(`Attached ${result.label.toLowerCase()}`);
      }
    } catch (e) {
      toast.error("Couldn't attach file", {
        body: e instanceof Error ? e.message : String(e),
        sticky: true,
      });
    } finally {
      setProcessing(null);
    }
  };

  return (
    <div className="border-t border-noir-line bg-noir-chrome/60 p-3 space-y-2">
      {processing && (
        <div className="rounded-md border border-noir-accent/30 bg-noir-accent/5 px-2.5 py-1.5 text-[11px] font-sans text-noir-accent flex items-center gap-2 min-w-0">
          <Loader2 size={11} className="animate-spin shrink-0" />
          <span className="min-w-0 truncate">
            Processing {processing.label.toLowerCase()} — spinning the model
            up just for this.
          </span>
          <span className="ml-auto font-mono text-[10px] text-noir-mute truncate max-w-[40%] shrink-0">
            {shorten(processing.path)}
          </span>
        </div>
      )}
      <ReferenceChips
        references={references}
        onRemove={onRemoveReference}
      />
      <div className="relative">
        <MentionInput
          ref={taRef}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          highlightTokens={highlightTokens}
          placeholder={
            disabled
              ? "Set up local model first…"
              : placeholder ?? "Ask, edit, generate… use @ to reference"
          }
          disabled={disabled}
          ariaLabel={placeholder ?? "Message — type @ to reference files, selection, or codebase"}
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1">
          <button
            onClick={() => {
              if (active) onAddReference({ kind: "file", path: active.path });
            }}
            disabled={!active}
            className="p-1.5 text-noir-mute hover:text-noir-accent disabled:opacity-30"
            title="Attach current file"
            aria-label="Attach current file"
          >
            <Paperclip size={12} aria-hidden="true" />
          </button>
          <button
            onClick={attachFromDisk}
            disabled={!!processing}
            className="p-1.5 text-noir-mute hover:text-noir-accent disabled:opacity-30"
            title="Attach a file from disk (images, PDFs, spreadsheets)"
            aria-label="Attach a file from disk"
          >
            {processing ? (
              <Loader2 size={12} aria-hidden="true" className="animate-spin text-noir-accent" />
            ) : (
              <FileUp size={12} aria-hidden="true" />
            )}
          </button>
          {selection && (
            <button
              onClick={() => {
                if (!active || !selection) return;
                onAddReference({
                  kind: "selection",
                  path: active.path,
                  startLine: selection.startLine,
                  endLine: selection.endLine,
                  text: selection.text,
                });
              }}
              className="text-[10px] px-1.5 py-0.5 rounded bg-noir-accent/15 text-noir-accent hover:bg-noir-accent/25"
              title={`Attach selection L${selection.startLine}–${selection.endLine}`}
              aria-label={`Attach editor selection from line ${selection.startLine} to ${selection.endLine}`}
            >
              Sel
            </button>
          )}
          {streaming ? (
            <button
              onClick={onCancel}
              className="p-1.5 rounded-md bg-noir-err/20 text-noir-err hover:bg-noir-err/30"
              title="Stop"
              aria-label="Stop generating"
            >
              <Square size={12} aria-hidden="true" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={disabled || !text.trim()}
              className="p-1.5 rounded-md bg-noir-accent text-white disabled:bg-noir-ridge disabled:text-noir-mute"
              title="Send"
              aria-label="Send message"
            >
              <ArrowUp size={12} aria-hidden="true" />
            </button>
          )}
        </div>
        {probe.open && (
          <MentionPicker
            anchorRef={taRef}
            query={probe.query}
            fileCandidates={fileCandidates}
            folderCandidates={folderCandidates}
            diagnostics={diagnostics}
            hasSelection={!!selection}
            codebaseUsable={codebaseUsable}
            attached={references}
            onPick={onPickMention}
            onClose={() => setProbe({ open: false })}
          />
        )}
      </div>
      <div className="text-[10px] font-sans text-noir-mute flex justify-between">
        <span>
          {disabled ? (
            <span className="text-noir-err">
              Ollama isn't running — Setup from ⌘⇧P.
            </span>
          ) : (
            <>
              <span className="pn-kbd">⏎</span>{" "}
              {submitHint ?? "send"} ·{" "}
              <span className="pn-kbd">⇧⏎</span> newline
            </>
          )}
        </span>
        <span>
          <span className="pn-kbd">@</span> mention ·{" "}
          <span className="pn-kbd">file</span> upload images / PDFs / sheets
        </span>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers (local — narrow scope, not worth a separate module)
// ──────────────────────────────────────────────────────────────────────

/** Alias text we splice back into the textarea when the user picks a
 *  category header (rather than a concrete item). Keeping the picker
 *  open with a category-targeted query is more discoverable than
 *  closing it immediately. */
const CATEGORY_ALIASES: Record<
  "file" | "folder" | "selection" | "codebase" | "diagnostic" | "symbol",
  string
> = {
  file: "",
  folder: "folder",
  selection: "selection",
  codebase: "codebase",
  diagnostic: "diagnostic",
  symbol: "symbol",
};

function mentionTokenFor(r: Reference): string {
  switch (r.kind) {
    case "file":
      return mentionToken({ kind: "file", path: r.path });
    case "folder":
      return mentionToken({ kind: "folder", path: r.path });
    case "selection":
      return mentionToken({
        kind: "selection",
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
      });
    case "codebase":
      return mentionToken({ kind: "codebase", query: r.query });
    case "symbol":
      return mentionToken({ kind: "symbol", name: r.name });
    case "diagnostic":
      return mentionToken({
        kind: "diagnostic",
        path: r.path,
        startLine: r.startLine,
        code: r.code,
      });
    case "processed":
      // Processed attachments aren't typed in the textarea — they come
      // from the paperclip button. Returning the file token still lets
      // the mirror highlight a manually-typed reference if the user
      // chooses to write one.
      return mentionToken({ kind: "file", path: r.path });
  }
}

function uriToPath(uri: string): string {
  // Monaco URIs come through as `file:///abs/path`. Slice off the scheme
  // and the Windows leading-slash that follows.
  return uri.replace(/^file:\/\//, "").replace(/^\/([A-Za-z]):/, "$1:");
}

function lineRange(src: string, startLine: number, endLine: number): string {
  const lines = src.split(/\r?\n/);
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, endLine);
  return lines.slice(from, to).join("\n");
}

function sevRank(s: Diagnostic["severity"]): number {
  switch (s) {
    case "error":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
    case "hint":
      return 0;
  }
}

function shorten(p: string): string {
  return p.split(/[\\/]/).slice(-2).join("/");
}
