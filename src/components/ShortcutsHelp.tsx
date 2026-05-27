import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";

/**
 * Keyboard shortcuts cheat sheet. Single source of truth for the
 * gestures the app exposes — searchable, copyable, and useful when
 * the user wants to know "what was that shortcut again?" without
 * hunting through menus.
 *
 * Each row is grouped by category. The keys mirror what the App.tsx
 * handler and src-tauri/src/menu.rs accelerators bind, so this stays
 * accurate by code review rather than runtime introspection (which
 * Monaco doesn't reliably expose for our custom commands).
 */
type Shortcut = { keys: string; label: string };
type Group = { name: string; items: Shortcut[] };

// Sequence text for OS — Tauri menu uses CmdOrCtrl; UI shows the
// glyph for the user's platform. We detect by user-agent (good enough
// inside Tauri, where the host platform is known).
const IS_MAC =
  typeof navigator !== "undefined"
    ? /Mac|iPhone|iPad/.test(navigator.platform)
    : true;
const MOD = IS_MAC ? "⌘" : "Ctrl";
const ALT = IS_MAC ? "⌥" : "Alt";
const SHIFT = IS_MAC ? "⇧" : "Shift";
const CTRL = IS_MAC ? "⌃" : "Ctrl";

const GROUPS: Group[] = [
  {
    name: "Files & Tabs",
    items: [
      { keys: `${MOD} P`, label: "Find file by name" },
      { keys: `${MOD} O`, label: "Open folder" },
      { keys: `${MOD} R`, label: "Open recent folder" },
      { keys: `${MOD} ${ALT} N`, label: "New untitled file" },
      { keys: `${MOD} S`, label: "Save active file" },
      { keys: `${MOD} ${ALT} S`, label: "Save all" },
      { keys: `${MOD} W`, label: "Close tab" },
      { keys: `${MOD} ${SHIFT} T`, label: "Reopen closed tab" },
      { keys: `${MOD} ${ALT} →`, label: "Next tab" },
      { keys: `${MOD} ${ALT} ←`, label: "Previous tab" },
    ],
  },
  {
    name: "Search & Navigation",
    items: [
      { keys: `${MOD} ${SHIFT} P`, label: "Command palette" },
      { keys: `${MOD} ${SHIFT} F`, label: "Find in files" },
      { keys: `${MOD} F`, label: "Find in current file" },
      { keys: `${ALT} ${MOD} F`, label: "Replace in current file" },
      { keys: `${MOD} G`, label: "Go to line" },
      { keys: `${MOD} ${SHIFT} O`, label: "Go to symbol in file" },
      { keys: `${MOD} T`, label: "Go to symbol in workspace" },
      { keys: "F12", label: "Go to definition" },
      { keys: `${ALT} F12`, label: "Peek definition" },
      { keys: `${SHIFT} F12`, label: "Find all references" },
    ],
  },
  {
    name: "Editor",
    items: [
      { keys: "F2", label: "Rename symbol" },
      { keys: `${MOD} ${SHIFT} I`, label: "Format document" },
      { keys: `${MOD} /`, label: "Toggle line comment" },
      { keys: `${MOD} D`, label: "Add next match to selection" },
      { keys: `${ALT} ↑ / ↓`, label: "Move line up / down" },
      { keys: `${SHIFT} ${ALT} ↑ / ↓`, label: "Copy line up / down" },
      { keys: `${MOD} ]`, label: "Indent line" },
      { keys: `${MOD} [`, label: "Outdent line" },
      { keys: "F8", label: "Next problem" },
      { keys: `${SHIFT} F8`, label: "Previous problem" },
      { keys: `${MOD} ${SHIFT} V`, label: "Toggle Markdown preview" },
      { keys: `${MOD} ${ALT} [`, label: "Fold region" },
      { keys: `${MOD} ${ALT} ]`, label: "Unfold region" },
      { keys: `${CTRL} -`, label: "Go back (cursor history)" },
      { keys: `${CTRL} ${SHIFT} -`, label: "Go forward (cursor history)" },
    ],
  },
  {
    name: "AI",
    items: [
      { keys: `${MOD} L`, label: "Toggle Assistant / send selection to Ask" },
      { keys: `${MOD} ${SHIFT} L`, label: "Send selection to Agent" },
      { keys: `${MOD} K`, label: "Inline edit (selection or current line)" },
      { keys: `${MOD} ${SHIFT} ,`, label: "AI control panel" },
    ],
  },
  {
    name: "View",
    items: [
      { keys: `${MOD} +`, label: "Zoom in editor" },
      { keys: `${MOD} -`, label: "Zoom out editor" },
      { keys: `${MOD} 0`, label: "Reset editor zoom" },
      { keys: `${ALT} Z`, label: "Toggle word wrap" },
      { keys: `${MOD} ${SHIFT} E`, label: "Focus file tree filter" },
      { keys: `${MOD} ${SHIFT} G`, label: "Show source control panel" },
    ],
  },
  {
    name: "Layout",
    items: [
      { keys: `${MOD} B`, label: "Toggle file tree" },
      { keys: `${MOD} J`, label: "Toggle terminal panel" },
      { keys: `${MOD} \``, label: "Focus / open terminal" },
      { keys: `${MOD} ${SHIFT} M`, label: "System monitor" },
      { keys: `${MOD} ,`, label: "Open Settings" },
      { keys: `${MOD} ?`, label: "Show this cheat sheet" },
      { keys: `${MOD} K Z`, label: "Toggle Zen mode" },
      { keys: "Esc", label: "Close overlays" },
    ],
  },
  {
    name: "Bookmarks & Tasks",
    items: [
      { keys: `${MOD} ${SHIFT} B`, label: "Run task" },
      { keys: `${MOD} ${ALT} K`, label: "Toggle bookmark on current line" },
      { keys: `${MOD} ${ALT} .`, label: "Next bookmark" },
      { keys: `${MOD} ${ALT} ,`, label: "Previous bookmark" },
    ],
  },
  {
    name: "Cmd+K chord",
    items: [
      { keys: `${MOD} K Z`, label: "Zen mode" },
      { keys: `${MOD} K S`, label: "Save without formatting" },
      { keys: `${MOD} K M`, label: "Toggle minimap" },
      { keys: `${MOD} K W`, label: "Toggle word wrap" },
      { keys: `${MOD} K T`, label: "Toggle terminal" },
      { keys: `${MOD} K O`, label: "Open folder" },
      { keys: `${MOD} K ${SHIFT} S`, label: "Keyboard shortcuts" },
    ],
  },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");

  // Esc to close — standard overlay etiquette.
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

  const filtered = useMemo(() => {
    if (!q.trim()) return GROUPS;
    const needle = q.toLowerCase();
    return GROUPS.map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          i.label.toLowerCase().includes(needle) ||
          i.keys.toLowerCase().includes(needle),
      ),
    })).filter((g) => g.items.length > 0);
  }, [q]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-20"
      onMouseDown={onClose}
    >
      <div
        className="w-[min(720px,92vw)] max-h-[80vh] flex flex-col rounded-lg bg-noir-panel border border-noir-line shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-help-title"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-noir-line">
          <div className="flex items-center gap-2 text-sm font-medium text-noir-text">
            <h2 id="shortcuts-help-title" className="m-0 text-sm font-medium text-noir-text">
              Keyboard shortcuts
            </h2>
            <span className="text-noir-mute" aria-hidden="true">·</span>
            <span className="text-noir-mute text-xs">
              {IS_MAC ? "macOS" : "Windows / Linux"}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-noir-mute hover:text-noir-text"
            aria-label="Close keyboard shortcuts"
            title="Close (Esc)"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="px-4 py-2 border-b border-noir-line flex items-center gap-2 text-sm" role="search">
          <Search size={14} className="text-noir-mute" aria-hidden="true" />
          <input
            autoFocus
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search shortcuts…"
            aria-label="Search keyboard shortcuts"
            className="flex-1 bg-transparent outline-none placeholder:text-noir-mute"
          />
        </div>
        <div
          className="flex-1 overflow-auto px-4 py-3 space-y-5"
          role="region"
          aria-live="polite"
          aria-label={`${filtered.reduce((n, g) => n + g.items.length, 0)} shortcuts shown`}
        >
          {filtered.map((g) => (
            <section key={g.name} aria-labelledby={`shortcut-group-${g.name}`}>
              <h3
                id={`shortcut-group-${g.name}`}
                className="text-[11px] uppercase tracking-wider text-noir-mute mb-2"
              >
                {g.name}
              </h3>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                {g.items.map((i) => (
                  <li
                    key={i.label}
                    className="flex items-center justify-between text-sm text-noir-text gap-3"
                  >
                    <span className="truncate">{i.label}</span>
                    <kbd
                      className="shrink-0 font-mono text-[11px] text-noir-subtext bg-noir-canvas border border-noir-line rounded px-1.5 py-0.5"
                      aria-label={`Shortcut: ${i.keys}`}
                    >
                      {i.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {filtered.length === 0 && (
            <div className="text-sm text-noir-mute py-6 text-center" role="status">
              No shortcuts match “{q}”.
            </div>
          )}
        </div>
        <footer className="px-4 py-2 border-t border-noir-line text-[11px] text-noir-mute">
          Tip: most editor commands are also discoverable via the command palette
          (<kbd>{MOD} {SHIFT} P</kbd>).
        </footer>
      </div>
    </div>
  );
}
