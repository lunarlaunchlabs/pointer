import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { createPortal } from "react-dom";
import { Bookmark as BookmarkIcon, Trash2 } from "lucide-react";
import { useBookmarks } from "@/store/bookmarks";
import { useEditorStore } from "@/store/editor";
import { useWorkspace } from "@/store/workspace";

/**
 * Quick picker that lists every bookmark in the workspace, grouped
 * implicitly by file via the `<file>:<line>` value string. Filters
 * by file path, line preview, or line number — whatever the user
 * naturally types. Selecting jumps to the position.
 */
export function BookmarksPicker({ onClose }: { onClose: () => void }) {
  const root = useWorkspace((s) => s.root);
  const all = useBookmarks((s) => s.bookmarks);
  const clearAll = useBookmarks((s) => s.clearAll);
  const [filter, setFilter] = useState("");

  // Esc to close — cmdk's input would otherwise swallow it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const visible = [...all].sort((a, b) => {
    const byPath = a.path.localeCompare(b.path);
    return byPath !== 0 ? byPath : a.line - b.line;
  });

  const open = async (path: string, line: number) => {
    onClose();
    await useEditorStore.getState().openFile(path);
    // openFile leaves the editor scrolled to the previously-saved
    // position; dispatch a reveal so we land on the bookmarked line
    // even if the user has been browsing elsewhere in the file.
    useEditorStore.getState().revealAt(path, line, 1);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-pn-modal flex items-start justify-center pt-24 bg-black/40 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Bookmarks"
        className="w-[560px] max-w-[92vw] rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command shouldFilter className="font-sans" label="Bookmarks">
          <div className="px-3 py-2 border-b border-noir-line/60 flex items-center gap-2">
            <BookmarkIcon size={12} className="text-noir-accent" aria-hidden="true" />
            <Command.Input
              value={filter}
              onValueChange={setFilter}
              placeholder={
                visible.length === 0
                  ? "No bookmarks. Press ⌘⌥K in the editor to add one."
                  : "Jump to bookmark…"
              }
              autoFocus
              aria-label="Filter bookmarks"
              className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-noir-mute"
            />
            {visible.length > 0 && (
              <button
                onClick={clearAll}
                className="text-[10.5px] text-noir-mute hover:text-noir-text shrink-0 inline-flex items-center gap-1"
                title="Remove every bookmark"
                aria-label="Clear all bookmarks"
              >
                <Trash2 size={11} aria-hidden="true" /> Clear all
              </button>
            )}
            <kbd className="pn-kbd text-[10px] shrink-0">Esc</kbd>
          </div>
          <Command.List className="max-h-[420px] overflow-y-auto py-1">
            <Command.Empty className="px-3 py-3 text-[12px] text-noir-mute text-center">
              No matching bookmarks.
            </Command.Empty>
            {visible.map((b) => {
              const name = b.path.split(/[\\/]/).pop() ?? b.path;
              const rel = root && b.path.startsWith(root)
                ? b.path.slice(root.length).replace(/^[\\/]+/, "")
                : b.path;
              return (
                <Command.Item
                  key={`${b.path}::${b.line}`}
                  value={`${rel}:${b.line} ${b.preview}`}
                  onSelect={() => open(b.path, b.line)}
                  className="px-3 py-1.5 mx-1 rounded-md flex items-start gap-2 cursor-pointer text-[12px] data-[selected=true]:bg-noir-accent/15"
                >
                  <BookmarkIcon
                    size={11}
                    className="text-noir-accent shrink-0 mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-noir-text">{name}</span>
                      <span className="text-noir-mute text-[10.5px] font-mono">
                        :{b.line}
                      </span>
                    </div>
                    <div className="text-noir-mute text-[10.5px] font-mono truncate">
                      {b.preview || "(empty line)"}
                    </div>
                  </div>
                </Command.Item>
              );
            })}
          </Command.List>
        </Command>
      </div>
    </div>,
    document.body,
  );
}
