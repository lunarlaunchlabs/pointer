import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Edit3, Split, Eye } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEditorStore } from "@/store/editor";

/**
 * Live Markdown preview rendered as either a full-width pane or a
 * split-view alongside the source editor. The user toggles preview
 * mode per file via the `md:toggle_preview` action (⇧⌘V) or the
 * "Open Preview to the Side" action (⌘K V) — both surfaces are
 * dispatched from App.tsx.
 *
 * Implementation note: we deliberately keep this purely
 * presentational — the underlying source lives in the editor
 * store's Tab.content, so external edits, hot exit, and undo all
 * continue to behave correctly.
 */
export type MarkdownMode = "preview" | "split";

export function MarkdownView({
  path,
  mode,
  onSetMode,
  onClose,
}: {
  path: string;
  mode: MarkdownMode;
  onSetMode: (m: MarkdownMode | null) => void;
  onClose: () => void;
}) {
  const tab = useEditorStore((s) => s.tabs.find((t) => t.path === path));
  const [pulse, setPulse] = useState(false);
  // Subtle visual cue that re-rendering happened — a 200ms pulse
  // on the rail bar avoids the page feeling static while typing.
  useEffect(() => {
    if (!tab) return;
    setPulse(true);
    const id = setTimeout(() => setPulse(false), 220);
    return () => clearTimeout(id);
  }, [tab?.content]);

  const content = tab?.content ?? "";
  const root = useMemo(() => {
    // Resolve relative-image paths to the file's parent directory so
    // `![](./screenshot.png)` works. Done by rewriting URLs before
    // ReactMarkdown sees them — much simpler than configuring a
    // custom remark plugin.
    const dir = path.replace(/[\\/][^\\/]+$/, "");
    return content.replace(
      /(\!\[[^\]]*\]\()(\.[\/\\][^)]+|[^\)/:]+\.[A-Za-z0-9]+)(\))/g,
      (_m, lead, p, tail) => `${lead}${convertLocal(dir, p)}${tail}`,
    );
  }, [content, path]);

  return (
    <div
      className={`absolute inset-0 z-pn-editor-overlay flex flex-col bg-noir-canvas ${
        mode === "split" ? "left-1/2" : ""
      }`}
    >
      <div
        className={`h-8 shrink-0 flex items-center gap-2 px-3 border-b border-noir-line bg-noir-chrome/60 text-[11px] font-mono text-noir-subtext ${
          pulse ? "text-noir-accent" : ""
        }`}
      >
        <Eye size={11} />
        <span className="truncate flex-1">{path.split(/[\\/]/).pop()}</span>
        <button
          onClick={() => onSetMode(mode === "preview" ? "split" : "preview")}
          title={mode === "preview" ? "Switch to split view" : "Switch to full preview"}
          aria-label={mode === "preview" ? "Switch to split view" : "Switch to full preview"}
          className="p-1 rounded hover:text-noir-text hover:bg-noir-ridge/60 inline-flex items-center gap-1"
        >
          <Split size={11} aria-hidden="true" />
        </button>
        <button
          onClick={onClose}
          title="Close preview (back to source)"
          aria-label="Close preview"
          className="p-1 rounded hover:text-noir-text hover:bg-noir-ridge/60 inline-flex items-center gap-1"
        >
          <Edit3 size={11} aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-8 py-6">
        <article className="pn-md max-w-3xl mx-auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {root || "_Empty document._"}
          </ReactMarkdown>
        </article>
      </div>
    </div>
  );
}

/** Rewrite an `![](./foo.png)` URL into a tauri:// asset URL when it
 *  points at a local file. External / data URLs pass through. */
function convertLocal(dir: string, url: string): string {
  if (/^[a-z]+:/i.test(url) || url.startsWith("//")) return url; // already absolute
  const abs = url.startsWith("/") ? url : `${dir}/${url}`;
  try {
    return convertFileSrc(abs);
  } catch {
    return url;
  }
}
