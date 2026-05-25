import { Command } from "cmdk";
import { useEffect } from "react";
import { Folder, FolderOpen, X } from "lucide-react";
import { useSession } from "@/store/session";
import { useWorkspace } from "@/store/workspace";

/**
 * "Open Recent…" picker. A focused alternative to the full File Finder
 * for folder-level navigation — picks from the most recently opened
 * workspace roots and lets the user jump between projects without
 * leaving the keyboard.
 *
 * Cross-platform note: Tauri's static menus can't host a dynamic
 * submenu easily, so we surface Open Recent as an in-app picker
 * driven by the same `file:open_recent` action the menu fires. This
 * keeps the experience identical on macOS, Windows, and Linux.
 */
export function OpenRecentPicker({ onClose }: { onClose: () => void }) {
  const recents = useSession((s) => s.recents);
  const removeRecent = useSession((s) => s.removeRecent);
  const setRoot = useWorkspace((s) => s.setRoot);

  // Close on Esc — overlay etiquette.
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

  const pick = (p: string) => {
    setRoot(p).catch(() => {});
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-pn-palette flex items-start justify-center pt-[14vh] bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Open recent folder"
        className="w-[640px] max-w-[92vw] rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Open recent" loop>
          <div className="border-b border-noir-line/60 px-4 py-3 flex items-center gap-3">
            <FolderOpen size={14} className="text-noir-accent" aria-hidden="true" />
            <Command.Input
              autoFocus
              aria-label="Filter recent folders"
              placeholder="Open recent folder…"
              className="flex-1 bg-transparent text-[14px] text-noir-text font-sans outline-none placeholder-noir-mute"
            />
            <kbd className="pn-kbd">Esc</kbd>
          </div>
          <Command.List className="max-h-[60vh] overflow-y-auto py-1">
            {recents.length === 0 ? (
              <Command.Empty className="px-4 py-3 text-[12px] text-noir-mute font-sans">
                No recent folders yet. Open a folder to populate this list.
              </Command.Empty>
            ) : (
              recents.map((p) => (
                <Command.Item
                  key={p}
                  value={p}
                  onSelect={() => pick(p)}
                  className="group flex items-center justify-between gap-3 px-4 py-2 text-[13px] font-mono text-noir-text aria-selected:bg-noir-ridge cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Folder size={13} className="shrink-0 text-noir-warn" />
                    <div className="min-w-0">
                      <div className="truncate">{basename(p)}</div>
                      <div className="text-[10.5px] text-noir-mute truncate">
                        {p}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecent(p);
                    }}
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-noir-mute hover:text-noir-text p-1 rounded"
                    title="Remove from list"
                    aria-label="Remove from list"
                  >
                    <X size={12} />
                  </button>
                </Command.Item>
              ))
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}
