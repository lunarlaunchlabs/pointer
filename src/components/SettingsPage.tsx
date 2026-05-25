import { useMemo, useState } from "react";
import {
  Code,
  Eye,
  FileText,
  GitBranch,
  Keyboard,
  Palette,
  Save,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useSettings } from "@/store/settings";
import { Switch } from "@/components/Switch";
import { dispatchAction } from "@/lib/actions";

/**
 * Dedicated Settings page. A searchable, categorized view of every
 * preference. Modeled after VS Code's Settings UI — a left rail of
 * categories, a search box, and a list of rows that update the
 * persisted store immediately.
 *
 * The AI control panel still owns model + feature toggles; this
 * page focuses on Editor / Appearance / Files / Keymap / About.
 */
type Category = {
  id: string;
  label: string;
  icon: React.ReactNode;
};

const CATEGORIES: Category[] = [
  { id: "editor", label: "Editor", icon: <Code size={13} /> },
  { id: "files", label: "Files", icon: <FileText size={13} /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={13} /> },
  { id: "accessibility", label: "Accessibility", icon: <Eye size={13} /> },
  { id: "git", label: "Source Control", icon: <GitBranch size={13} /> },
  { id: "terminal", label: "Terminal", icon: <Terminal size={13} /> },
  { id: "ai", label: "AI", icon: <Sparkles size={13} /> },
  { id: "keymap", label: "Keymap", icon: <Keyboard size={13} /> },
];

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [category, setCategory] = useState<string>("editor");
  const [q, setQ] = useState("");

  const s = useSettings();

  // Each setting is described once so search + render share the
  // same source of truth. Categories are tags so a single setting
  // can show up under multiple top-level buckets if it matters.
  const allSettings = useMemo<SettingRow[]>(
    () => [
      // Editor
      {
        id: "fontSize",
        category: "editor",
        label: "Font size",
        description: "Editor font size in pixels.",
        keywords: "font text size",
        render: () => (
          <NumberField
            value={s.editorFontSize}
            min={10}
            max={28}
            step={1}
            onChange={s.setEditorFontSize}
            label="Editor font size"
          />
        ),
      },
      {
        id: "tabSize",
        category: "editor",
        label: "Tab size",
        description: "How many spaces an indent step represents.",
        keywords: "indent tab",
        render: () => (
          <NumberField
            value={s.editorTabSize}
            min={1}
            max={8}
            step={1}
            onChange={s.setEditorTabSize}
            label="Tab size"
          />
        ),
      },
      {
        id: "insertSpaces",
        category: "editor",
        label: "Insert spaces",
        description: "Use spaces (instead of tabs) for indentation.",
        keywords: "indent tab spaces",
        render: () => (
          <Switch
            label="Insert spaces"
            checked={s.editorInsertSpaces}
            onChange={s.setEditorInsertSpaces}
          />
        ),
      },
      {
        id: "wordWrap",
        category: "editor",
        label: "Word wrap",
        description: "Soft-wrap long lines instead of horizontal scroll.",
        keywords: "wrap line",
        render: () => (
          <Switch
            label="Word wrap"
            checked={s.editorWordWrap}
            onChange={s.setEditorWordWrap}
          />
        ),
      },
      {
        id: "renderWhitespace",
        category: "editor",
        label: "Render whitespace",
        description: "Show dots for spaces and arrows for tabs.",
        keywords: "whitespace dots",
        render: () => (
          <Switch
            label="Render whitespace"
            checked={s.editorRenderWhitespace}
            onChange={s.setEditorRenderWhitespace}
          />
        ),
      },
      {
        id: "stickyScroll",
        category: "editor",
        label: "Sticky scroll",
        description: "Keep enclosing function / class headers visible while scrolling.",
        keywords: "sticky scroll header",
        render: () => (
          <Switch
            label="Sticky scroll"
            checked={s.editorStickyScroll}
            onChange={s.setEditorStickyScroll}
          />
        ),
      },
      {
        id: "breadcrumbs",
        category: "editor",
        label: "Breadcrumbs",
        description: "Show the file's path above the editor.",
        keywords: "breadcrumbs path",
        render: () => (
          <Switch
            label="Show breadcrumbs"
            checked={s.editorBreadcrumbs}
            onChange={s.setEditorBreadcrumbs}
          />
        ),
      },
      {
        id: "minimap",
        category: "editor",
        label: "Minimap",
        description: "Show the miniature scrollable map on the right side of the editor.",
        keywords: "minimap preview overview",
        render: () => (
          <Switch
            label="Show minimap"
            checked={s.editorMinimap}
            onChange={s.setEditorMinimap}
          />
        ),
      },
      // Files
      {
        id: "trimTrailingWhitespace",
        category: "files",
        label: "Trim trailing whitespace",
        description: "Remove trailing spaces / tabs from every line on save.",
        keywords: "trim whitespace save trailing",
        render: () => (
          <Switch
            label="Trim trailing whitespace"
            checked={s.editorTrimTrailingWhitespace}
            onChange={s.setEditorTrimTrailingWhitespace}
          />
        ),
      },
      {
        id: "insertFinalNewline",
        category: "files",
        label: "Insert final newline",
        description: "Ensure files end with a single trailing newline on save.",
        keywords: "newline final save",
        render: () => (
          <Switch
            label="Insert final newline"
            checked={s.editorInsertFinalNewline}
            onChange={s.setEditorInsertFinalNewline}
          />
        ),
      },
      {
        id: "treeSort",
        category: "files",
        label: "File tree sort",
        description:
          "How entries are ordered in the file tree. Type-first groups folders above files; name-only is a pure alphabetical list.",
        keywords: "tree sort order folders alphabetical",
        render: () => (
          <Select
            value={s.treeSort}
            label="File tree sort order"
            options={[
              { id: "type", label: "Folders first, then alphabetical" },
              { id: "name", label: "Alphabetical (mixed)" },
            ]}
            onChange={(v) => s.setTreeSort(v as typeof s.treeSort)}
          />
        ),
      },
      {
        id: "formatOnSave",
        category: "files",
        label: "Format on save",
        description:
          "Trim trailing whitespace and ensure a trailing newline when saving. Language-specific formatters (Prettier, rustfmt, gofmt…) run too when installed.",
        keywords: "format save prettier rustfmt gofmt",
        render: () => (
          <Switch
            label="Format on save"
            checked={s.editorFormatOnSave}
            onChange={s.setEditorFormatOnSave}
          />
        ),
      },
      {
        id: "autoSave",
        category: "files",
        label: "Auto save",
        description:
          "Off: explicit save only. Focus loss: save when the editor blurs. After delay: save N seconds after the last keystroke.",
        keywords: "save auto",
        render: () => (
          <Select
            value={s.editorAutoSave}
            label="Auto save mode"
            options={[
              { id: "off", label: "Off" },
              { id: "focusLoss", label: "On focus loss" },
              { id: "afterDelay", label: "After delay" },
            ]}
            onChange={(v) => s.setEditorAutoSave(v as typeof s.editorAutoSave)}
          />
        ),
      },
      {
        id: "autoSaveDelay",
        category: "files",
        label: "Auto save delay (ms)",
        description: "How long to wait after the last keystroke before saving.",
        keywords: "save auto delay",
        render: () => (
          <NumberField
            value={s.editorAutoSaveDelayMs}
            min={200}
            max={60000}
            step={100}
            onChange={s.setEditorAutoSaveDelayMs}
            label="Auto save delay in milliseconds"
          />
        ),
      },
      {
        id: "hotExit",
        category: "files",
        label: "Hot exit",
        description:
          "Preserve unsaved buffer contents across reloads / restarts.",
        keywords: "save hot exit recover",
        render: () => (
          <Switch
            label="Hot exit"
            checked={s.editorHotExit}
            onChange={s.setEditorHotExit}
          />
        ),
      },
      // Appearance
      {
        id: "appTheme",
        category: "appearance",
        label: "Theme",
        description: "Switch between Pointer Noir (dark) and Pointer Light.",
        keywords: "theme dark light",
        render: () => (
          <Select
            value={s.appTheme}
            label="App theme"
            options={[
              { id: "noir", label: "Pointer Noir (dark)" },
              { id: "light", label: "Pointer Light" },
            ]}
            onChange={(v) => s.setAppTheme(v as typeof s.appTheme)}
          />
        ),
      },
      // Accessibility
      {
        id: "reduceMotion",
        category: "accessibility",
        label: "Reduce motion",
        description:
          "Disable transitions, pulses, and other animations across the UI. Respected automatically when the OS-level setting is on.",
        keywords: "motion animation accessibility",
        render: () => (
          <Switch
            label="Reduce motion"
            checked={s.reduceMotion}
            onChange={s.setReduceMotion}
          />
        ),
      },
      // Source Control
      {
        id: "gitInlineBlame",
        category: "git",
        label: "Inline git blame",
        description:
          "Show the last commit's author, date, and message at the end of the cursor line for tracked files.",
        keywords: "git blame inline annotation gutter author commit",
        render: () => (
          <Switch
            label="Inline git blame"
            checked={s.gitInlineBlame}
            onChange={s.setGitInlineBlame}
          />
        ),
      },
      // Terminal — pointers; the actual terminal config lives in the
      // shell's rc files but we want users to discover the action.
      {
        id: "newTerminal",
        category: "terminal",
        label: "New terminal",
        description: "Open a fresh terminal tab in the workspace root.",
        keywords: "terminal shell open",
        render: () => (
          <button
            onClick={() => {
              dispatchAction("view:new_terminal");
              onClose();
            }}
            className="text-[12px] text-noir-accent hover:underline"
          >
            Open terminal →
          </button>
        ),
      },
      {
        id: "toggleTerminal",
        category: "terminal",
        label: "Toggle terminal panel",
        description: "Show or hide the bottom panel without closing any running shells.",
        keywords: "terminal panel toggle hide",
        render: () => (
          <span className="pn-kbd text-[10px]">⌘J</span>
        ),
      },
      // AI feature toggles + AI Control Panel link
      {
        id: "chatEnabled",
        category: "ai",
        label: "Chat",
        description:
          "Per-feature gate for the chat panel. Disables chat-related UI affordances and silences inline-chat IPC calls.",
        keywords: "ai chat enable",
        render: () => (
          <Switch
            label="Enable AI chat"
            checked={s.chatEnabled}
            onChange={s.setChatEnabled}
          />
        ),
      },
      {
        id: "agentEnabled",
        category: "ai",
        label: "Agent",
        description:
          "Per-feature gate for the autonomous agent. Disables agent UI surfaces and prevents tool-using sessions from being launched.",
        keywords: "ai agent enable",
        render: () => (
          <Switch
            label="Enable AI agent"
            checked={s.agentEnabled}
            onChange={s.setAgentEnabled}
          />
        ),
      },
      {
        id: "inlineEditEnabled",
        category: "ai",
        label: "Inline edit (⌘K)",
        description:
          "Per-feature gate for the editor's ⌘K inline-edit popover. Disable to stop the gesture from intercepting.",
        keywords: "ai inline edit cmd k command",
        render: () => (
          <Switch
            label="Enable inline edit"
            checked={s.inlineEditEnabled}
            onChange={s.setInlineEditEnabled}
          />
        ),
      },
      {
        id: "fimEnabled",
        category: "ai",
        label: "Tab completion (FIM)",
        description:
          "Per-feature gate for fill-in-the-middle tab completion. Disable to stop ghost-text suggestions while typing.",
        keywords: "ai fim tab completion ghost text",
        render: () => (
          <Switch
            label="Enable tab completion"
            checked={s.fimEnabled}
            onChange={s.setFimEnabled}
          />
        ),
      },
      {
        id: "fimDebounceMs",
        category: "ai",
        label: "Tab completion debounce (ms)",
        description:
          "Wait this long after the last keystroke before asking the model for a suggestion. Lower = snappier, higher = fewer false starts.",
        keywords: "ai fim debounce delay completion",
        render: () => (
          <NumberField
            value={s.fimDebounceMs}
            min={50}
            max={2000}
            step={25}
            onChange={s.setFimDebounceMs}
            label="Tab completion debounce milliseconds"
          />
        ),
      },
      {
        id: "indexingEnabled",
        category: "ai",
        label: "Workspace indexing",
        description:
          "Per-feature gate for the background workspace embedding index. Disable to skip building the index for chat / agent context.",
        keywords: "ai indexing embed workspace",
        render: () => (
          <Switch
            label="Enable workspace indexing"
            checked={s.indexingEnabled}
            onChange={s.setIndexingEnabled}
          />
        ),
      },
      {
        id: "ollamaAutostart",
        category: "ai",
        label: "Auto-start Ollama",
        description:
          "Launch the local Ollama daemon when Pointer starts (and the binary is installed). Off means you launch the daemon manually.",
        keywords: "ai ollama autostart runtime",
        render: () => (
          <Switch
            label="Auto-start Ollama on launch"
            checked={s.ollamaAutostart}
            onChange={s.setOllamaAutostart}
          />
        ),
      },
      {
        id: "aiPanel",
        category: "ai",
        label: "AI Control Panel",
        description: "Manage models, features, and runtime in one place.",
        keywords: "ai model chat agent fim ollama panel control",
        render: () => (
          <button
            onClick={() => {
              dispatchAction("ai:show_ai");
              onClose();
            }}
            className="text-[12px] text-noir-accent hover:underline"
          >
            Open AI panel →
          </button>
        ),
      },
      // Keymap
      {
        id: "shortcuts",
        category: "keymap",
        label: "Keyboard shortcuts",
        description: "Browse the full keyboard cheat sheet.",
        keywords: "shortcut keymap keybinding",
        render: () => (
          <button
            onClick={() => {
              dispatchAction("help:shortcuts");
              onClose();
            }}
            className="text-[12px] text-noir-accent hover:underline"
          >
            Show shortcuts →
          </button>
        ),
      },
      {
        id: "workspaceSettings",
        category: "keymap",
        label: "Workspace overrides",
        description:
          "Per-workspace setting overrides live in .pointer/settings.json. Use them to pin a font size, tab size, or theme for a specific project.",
        keywords: "workspace settings pointer overrides project",
        render: () => (
          <button
            onClick={() => {
              dispatchAction("settings:open_workspace");
              onClose();
            }}
            className="text-[12px] text-noir-accent hover:underline"
          >
            Open workspace settings →
          </button>
        ),
      },
      {
        id: "snippets",
        category: "keymap",
        label: "Workspace snippets",
        description:
          "Per-workspace code snippets live in .pointer/snippets.json. Each snippet shows up in Monaco's completion list.",
        keywords: "snippets workspace completion templates",
        render: () => (
          <button
            onClick={() => {
              dispatchAction("settings:open_snippets");
              onClose();
            }}
            className="text-[12px] text-noir-accent hover:underline"
          >
            Edit snippets →
          </button>
        ),
      },
    ],
    [s, onClose],
  );

  const filteredSettings = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return allSettings.filter((r) => r.category === category);
    return allSettings.filter((r) =>
      `${r.label} ${r.description ?? ""} ${r.keywords ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [allSettings, category, q]);

  return (
    <div
      className="fixed inset-0 z-pn-modal bg-black/50 backdrop-blur-sm flex items-center justify-center"
      onMouseDown={onClose}
    >
      <div
        className="w-[min(900px,95vw)] h-[min(640px,86vh)] flex flex-col rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="px-4 py-3 border-b border-noir-line/60 flex items-center gap-3">
          <SettingsIcon size={14} className="text-noir-accent" />
          <span id="settings-title" className="text-[13px] font-medium text-noir-text">
            Settings
          </span>
          <div className="ml-3 flex-1 flex items-center gap-2 px-2 py-1 rounded border border-noir-line bg-noir-canvas">
            <Search size={12} className="text-noir-mute" />
            <input
              type="text"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search settings…"
              className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-noir-mute"
            />
          </div>
          <button
            onClick={onClose}
            className="text-noir-mute hover:text-noir-text"
            aria-label="Close settings"
          >
            <X size={14} />
          </button>
        </header>
        <div className="flex-1 min-h-0 flex">
          {!q && (
            <nav
              className="w-44 shrink-0 border-r border-noir-line/60 py-2 text-[12px]"
              aria-label="Settings categories"
            >
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCategory(c.id)}
                  aria-current={category === c.id ? "page" : undefined}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${
                    category === c.id
                      ? "bg-noir-ridge/40 text-noir-text"
                      : "text-noir-subtext hover:bg-noir-ridge/30 hover:text-noir-text"
                  }`}
                >
                  <span className="text-noir-mute" aria-hidden="true">
                    {c.icon}
                  </span>
                  {c.label}
                </button>
              ))}
            </nav>
          )}
          <div className="flex-1 overflow-y-auto py-3 px-5">
            {filteredSettings.length === 0 && (
              <div className="text-[12px] text-noir-mute">
                No settings match “{q}”.
              </div>
            )}
            <ul className="space-y-3">
              {filteredSettings.map((row) => (
                <li
                  key={row.id}
                  className="flex items-start justify-between gap-6 border-b border-noir-line/40 pb-3"
                >
                  <div className="min-w-0">
                    <div className="text-[12.5px] text-noir-text">
                      {row.label}
                    </div>
                    {row.description && (
                      <div className="text-[11px] text-noir-mute mt-0.5 leading-relaxed">
                        {row.description}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 self-center">{row.render()}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <footer className="px-4 py-2 border-t border-noir-line/60 text-[10.5px] text-noir-mute flex items-center gap-2">
          <Save size={11} />
          Changes save instantly. Some settings (font, theme) apply immediately;
          others (auto-save) take effect on next edit.
        </footer>
      </div>
    </div>
  );
}

type SettingRow = {
  id: string;
  category: string;
  label: string;
  description?: string;
  keywords?: string;
  render: () => React.ReactNode;
};

function NumberField({
  value,
  min,
  max,
  step,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  /** Accessible name when the visual label sits in a separate column.
   *  Required for screen readers — without it the input appears as
   *  an unlabelled spinbutton. */
  label?: string;
}) {
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (!Number.isFinite(n)) return;
        onChange(Math.max(min, Math.min(max, n)));
      }}
      className="pn-input w-24 text-[12px]"
    />
  );
}

function Select({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="pn-input text-[12px]"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
