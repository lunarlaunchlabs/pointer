import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useWorkspace } from "@/store/workspace";
import { useEditorStore } from "@/store/editor";
import { useSettings } from "@/store/settings";
import { useSession } from "@/store/session";
import { dispatchAction } from "@/lib/actions";
import { usePaletteRecents } from "@/store/paletteRecents";
import { Clock } from "lucide-react";

export function CommandPalette({
  onClose,
  openFinder,
  toggleAssistant,
  openOnboarding,
  openAIPanel,
  openMonitor,
}: {
  onClose: () => void;
  openFinder: () => void;
  toggleAssistant: () => void;
  openOnboarding: () => void;
  openAIPanel: () => void;
  openMonitor: () => void;
}) {
  const [value, setValue] = useState("");
  const openFolder = useWorkspace((s) => s.openFolder);
  const root = useWorkspace((s) => s.root);
  const saveAll = useEditorStore((s) => s.saveAll);
  const fimEnabled = useSettings((s) => s.fimEnabled);
  const setFimEnabled = useSettings((s) => s.setFimEnabled);
  const treeCollapsed = useSession((s) => s.treeCollapsed);
  const noteTreeCollapsed = useSession((s) => s.noteTreeCollapsed);
  const recents = usePaletteRecents((s) => s.recents);
  const pushRecent = usePaletteRecents((s) => s.push);
  const initRecents = usePaletteRecents((s) => s.init);
  useEffect(() => {
    void initRecents();
  }, [initRecents]);
  // unused warning suppression: keep imports referenced if cmd-palette grows
  void value;

  const run = async (label: string, fn: () => unknown | Promise<unknown>) => {
    await fn();
    onClose();
    // We don't record raw `run("label", fn)` invocations as recents
    // because the closure isn't replayable. Use `runAction` below for
    // entries you want to surface in the Recently Used section.
    void label;
  };
  /** Like `run`, but records the action id so it can be replayed
   *  from the Recently Used group later. Prefer this for any
   *  palette item that maps cleanly to a single action. */
  const runAction = async (id: string, label: string) => {
    pushRecent({ id, label });
    dispatchAction(id as Parameters<typeof dispatchAction>[0]);
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
        aria-label="Command palette"
        className="w-[640px] max-w-[92vw] rounded-xl border border-noir-line bg-noir-panel shadow-soft overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command palette" loop>
          <div className="border-b border-noir-line/60 px-4 py-3 flex items-center gap-3">
            <span className="text-noir-accent" aria-hidden="true">▸</span>
            <Command.Input
              value={value}
              onValueChange={setValue}
              autoFocus
              aria-label="Type a command"
              placeholder="Type a command…"
              className="flex-1 bg-transparent text-[14px] text-noir-text font-sans outline-none placeholder-noir-mute"
            />
            <kbd className="pn-kbd shrink-0">Esc</kbd>
          </div>
          <Command.List className="max-h-[60vh] overflow-y-auto py-1">
            <Command.Empty className="px-4 py-3 text-[12px] text-noir-mute font-sans">
              No matching commands.
            </Command.Empty>

            {recents.length > 0 && (
              <Command.Group heading="Recently used" className="text-noir-mute">
                {recents.slice(0, 6).map((r) => (
                  <Command.Item
                    key={`recent-${r.id}`}
                    value={`recent ${r.id} ${r.label}`}
                    onSelect={() => runAction(r.id, r.label)}
                    className="flex items-center justify-between px-4 py-2 text-[13px] font-sans text-noir-text aria-selected:bg-noir-ridge cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <Clock size={11} className="text-noir-mute" aria-hidden="true" />
                      {r.label}
                    </span>
                    <span className="pn-kbd text-[10px] opacity-70">
                      {timeAgo(r.ts)}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group heading="File" className="text-noir-mute">
              <Item
                label="Open Folder"
                shortcut="⌘O"
                onSelect={() => run("open", openFolder)}
              />
              <Item
                label="Open Recent…"
                shortcut="⌘R"
                onSelect={() => runAction("file:open_recent", "Open Recent…")}
              />
              <Item
                label="New Untitled File"
                shortcut="⌘⌥N"
                onSelect={() =>
                  runAction("file:new_untitled", "New Untitled File")
                }
              />
              <Item
                label="Find File"
                shortcut="⌘P"
                onSelect={() => run("find", openFinder)}
              />
              <Item
                label="Find in Files"
                shortcut="⌘⇧F"
                onSelect={() =>
                  runAction("edit:find_in_files", "Find in Files")
                }
              />
              <Item
                label="Save"
                shortcut="⌘S"
                onSelect={() => runAction("file:save", "Save")}
              />
              <Item
                label="Save All"
                shortcut="⌘⌥S"
                onSelect={() => run("saveall", saveAll)}
              />
              <Item
                label="Save without Formatting"
                shortcut="⌘K S"
                onSelect={() =>
                  runAction(
                    "file:save_without_formatting",
                    "Save without Formatting",
                  )
                }
              />
              <Item
                label="Revert File"
                onSelect={() => runAction("file:revert", "Revert File")}
              />
              <Item
                label="Close Tab"
                shortcut="⌘W"
                onSelect={() => runAction("file:close_tab", "Close Tab")}
              />
              <Item
                label="Reopen Closed Tab"
                shortcut="⌘⇧T"
                onSelect={() =>
                  runAction("tabs:reopen_closed", "Reopen Closed Tab")
                }
              />
              <Item
                label="Close Others"
                onSelect={() =>
                  run("close_others", () => dispatchAction("tabs:close_others"))
                }
              />
              <Item
                label="Close To The Right"
                onSelect={() =>
                  run("close_right", () => dispatchAction("tabs:close_to_right"))
                }
              />
              <Item
                label="Close All Tabs"
                onSelect={() =>
                  run("close_all", () => dispatchAction("tabs:close_all"))
                }
              />
            </Command.Group>

            <Command.Group heading="Editor" className="text-noir-mute">
              <Item
                label="Go Back"
                shortcut="⌃-"
                onSelect={() =>
                  run("nav_back", () => dispatchAction("editor:nav_back"))
                }
              />
              <Item
                label="Go Forward"
                shortcut="⌃⇧-"
                onSelect={() =>
                  run("nav_forward", () => dispatchAction("editor:nav_forward"))
                }
              />
              <Item
                label="Go to Line"
                shortcut="⌘G"
                onSelect={() =>
                  run("goto_line", () => dispatchAction("editor:goto_line"))
                }
              />
              <Item
                label="Go to Definition"
                shortcut="F12"
                onSelect={() =>
                  run("goto_definition", () =>
                    dispatchAction("editor:goto_definition"),
                  )
                }
              />
              <Item
                label="Peek Definition"
                shortcut="⌥F12"
                onSelect={() =>
                  run("peek_definition", () =>
                    dispatchAction("editor:peek_definition"),
                  )
                }
              />
              <Item
                label="Go to Symbol in File"
                shortcut="⌘⇧O"
                onSelect={() =>
                  run("symbol_file", () => dispatchAction("editor:goto_symbol_file"))
                }
              />
              <Item
                label="Format Document"
                shortcut="⌘⇧I"
                onSelect={() =>
                  runAction("editor:format_document", "Format Document")
                }
              />
              <Item
                label="Format Selection"
                onSelect={() =>
                  runAction("editor:format_selection", "Format Selection")
                }
              />
              <Item
                label="Transpose Characters"
                onSelect={() =>
                  runAction("editor:transpose_chars", "Transpose Characters")
                }
              />
              <Item
                label="Rename Symbol"
                shortcut="F2"
                onSelect={() =>
                  run("rename", () => dispatchAction("editor:rename_symbol"))
                }
              />
              <Item
                label="Replace in Files"
                onSelect={() =>
                  run("replace", () => dispatchAction("edit:replace_in_files"))
                }
              />
              <Item
                label="Toggle Line Comment"
                shortcut="⌘/"
                onSelect={() =>
                  run("comment", () => dispatchAction("editor:toggle_line_comment"))
                }
              />
              <Item
                label="Toggle Block Comment"
                shortcut="⇧⌥A"
                onSelect={() =>
                  run("blockcomment", () => dispatchAction("editor:toggle_block_comment"))
                }
              />
              <Item
                label="Duplicate Selection"
                shortcut="⇧⌥↓"
                onSelect={() =>
                  run("dupe", () => dispatchAction("editor:duplicate_line"))
                }
              />
              <Item
                label="Join Lines"
                onSelect={() =>
                  run("join", () => dispatchAction("editor:join_lines"))
                }
              />
              <Item
                label="Sort Lines Ascending"
                onSelect={() =>
                  run("sortasc", () => dispatchAction("editor:sort_lines_asc"))
                }
              />
              <Item
                label="Sort Lines Descending"
                onSelect={() =>
                  run("sortdesc", () => dispatchAction("editor:sort_lines_desc"))
                }
              />
              <Item
                label="Trim Trailing Whitespace"
                onSelect={() =>
                  run("trim", () => dispatchAction("editor:trim_trailing_whitespace"))
                }
              />
              <Item
                label="Transform to Uppercase"
                onSelect={() =>
                  run("upper", () => dispatchAction("editor:upper_case"))
                }
              />
              <Item
                label="Transform to Lowercase"
                onSelect={() =>
                  run("lower", () => dispatchAction("editor:lower_case"))
                }
              />
              <Item
                label="Transform to Title Case"
                onSelect={() =>
                  run("titlecase", () => dispatchAction("editor:title_case"))
                }
              />
              <Item
                label="Insert UUID"
                onSelect={() =>
                  run("uuid", () => dispatchAction("editor:insert_uuid"))
                }
              />
              <Item
                label="Insert Date/Time"
                onSelect={() =>
                  run("date", () => dispatchAction("editor:insert_datetime"))
                }
              />
              <Item
                label="Fold Region"
                shortcut="⌘⌥["
                onSelect={() => run("fold", () => dispatchAction("editor:fold"))}
              />
              <Item
                label="Unfold Region"
                shortcut="⌘⌥]"
                onSelect={() => run("unfold", () => dispatchAction("editor:unfold"))}
              />
              <Item
                label="Fold All"
                onSelect={() => run("foldAll", () => dispatchAction("editor:fold_all"))}
              />
              <Item
                label="Unfold All"
                onSelect={() => run("unfoldAll", () => dispatchAction("editor:unfold_all"))}
              />
              <Item
                label="Toggle Markdown Preview"
                shortcut="⌘⇧V"
                onSelect={() =>
                  run("mdtoggle", () => dispatchAction("md:toggle_preview"))
                }
              />
              <Item
                label="Open Markdown Preview to the Side"
                onSelect={() =>
                  run("mdside", () => dispatchAction("md:open_preview_side"))
                }
              />
              <Item
                label="Next Problem"
                shortcut="F8"
                onSelect={() =>
                  run("nextprob", () => dispatchAction("editor:next_problem"))
                }
              />
              <Item
                label="Previous Problem"
                shortcut="⇧F8"
                onSelect={() =>
                  run("prevprob", () => dispatchAction("editor:prev_problem"))
                }
              />
            </Command.Group>

            <Command.Group heading="Source Control" className="text-noir-mute">
              <Item
                label="Open Source Control Panel"
                onSelect={() =>
                  run("scm", () => dispatchAction("git:show_panel"))
                }
              />
              <Item
                label="Git: Fetch"
                onSelect={() => run("fetch", () => dispatchAction("git:fetch"))}
              />
              <Item
                label="Git: Pull"
                onSelect={() => run("pull", () => dispatchAction("git:pull"))}
              />
              <Item
                label="Git: Push"
                onSelect={() => run("push", () => dispatchAction("git:push"))}
              />
            </Command.Group>

            <Command.Group heading="View" className="text-noir-mute">
              <Item
                label={treeCollapsed ? "Show File Tree" : "Hide File Tree"}
                shortcut="⌘B"
                onSelect={() =>
                  run("tree", () => noteTreeCollapsed(!treeCollapsed))
                }
              />
              <Item
                label="Reveal Active File in Tree"
                onSelect={() =>
                  run("reveal", () => dispatchAction("view:reveal_in_tree"))
                }
              />
              <Item
                label="Focus File Tree Filter"
                onSelect={() =>
                  run("treefilter", () => dispatchAction("tree:focus_filter"))
                }
              />
              <Item
                label="Collapse All Folders"
                onSelect={() =>
                  run("collapse", () => dispatchAction("tree:collapse_all"))
                }
              />
              <Item
                label="Toggle Terminal"
                shortcut="⌘J"
                onSelect={() =>
                  run("term", () => dispatchAction("view:toggle_terminal"))
                }
              />
              <Item
                label="Toggle Problems"
                onSelect={() =>
                  run("problems", () => dispatchAction("view:toggle_problems"))
                }
              />
              <Item
                label="Run Project Check"
                onSelect={() =>
                  run("check", () => dispatchAction("diagnostics:run_project_check"))
                }
              />
              <Item
                label="Toggle Minimap"
                onSelect={() =>
                  run("minimap", () => dispatchAction("view:toggle_minimap"))
                }
              />
              <Item
                label="Toggle Word Wrap"
                shortcut="⌥Z"
                onSelect={() =>
                  run("wrap", () => dispatchAction("view:toggle_word_wrap"))
                }
              />
              <Item
                label="Zoom In Editor"
                shortcut="⌘+"
                onSelect={() =>
                  run("zoomin", () => dispatchAction("view:font_zoom_in"))
                }
              />
              <Item
                label="Zoom Out Editor"
                shortcut="⌘-"
                onSelect={() =>
                  run("zoomout", () => dispatchAction("view:font_zoom_out"))
                }
              />
              <Item
                label="Reset Editor Zoom"
                shortcut="⌘0"
                onSelect={() =>
                  run("zoomreset", () => dispatchAction("view:font_zoom_reset"))
                }
              />
              <Item
                label="System Monitor"
                shortcut="⌘⇧M"
                onSelect={() => run("monitor", openMonitor)}
              />
            </Command.Group>

            <Command.Group heading="Tools" className="text-noir-mute">
              <Item
                label="Run Task…"
                shortcut="⌘⇧B"
                onSelect={() => runAction("tasks:run", "Run Task…")}
              />
              <Item
                label="Edit Tasks (.pointer/tasks.json)"
                onSelect={() => runAction("tasks:edit", "Edit Tasks")}
              />
              <Item
                label="Toggle Bookmark"
                shortcut="⌘⌥K"
                onSelect={() => runAction("bookmark:toggle", "Toggle Bookmark")}
              />
              <Item
                label="Next Bookmark"
                shortcut="⌘⌥."
                onSelect={() => runAction("bookmark:next", "Next Bookmark")}
              />
              <Item
                label="Previous Bookmark"
                shortcut="⌘⌥,"
                onSelect={() => runAction("bookmark:prev", "Previous Bookmark")}
              />
              <Item
                label="List Bookmarks…"
                onSelect={() => runAction("bookmark:list", "List Bookmarks")}
              />
              <Item
                label="Clear Bookmarks (file)"
                onSelect={() =>
                  runAction("bookmark:clear_file", "Clear Bookmarks (file)")
                }
              />
              <Item
                label="Clear Bookmarks (all)"
                onSelect={() =>
                  runAction("bookmark:clear_all", "Clear Bookmarks (all)")
                }
              />
              <Item
                label="Toggle Zen Mode"
                shortcut="⌘K Z"
                onSelect={() => runAction("view:toggle_zen", "Toggle Zen Mode")}
              />
              <Item
                label="Notifications"
                onSelect={() =>
                  runAction("help:notifications", "Notifications")
                }
              />
              <Item
                label="Change Language Mode…"
                onSelect={() =>
                  runAction("editor:change_language", "Change Language Mode")
                }
              />
              <Item
                label="Change End of Line Sequence…"
                onSelect={() =>
                  runAction("editor:change_eol", "Change End of Line Sequence")
                }
              />
            </Command.Group>

            <Command.Group heading="Settings" className="text-noir-mute">
              <Item
                label="Open Settings"
                shortcut="⌘,"
                onSelect={() =>
                  run("settings", () => dispatchAction("settings:open"))
                }
              />
              <Item
                label="Open Workspace Settings (.pointer/settings.json)"
                onSelect={() =>
                  run("workspace_settings", () =>
                    dispatchAction("settings:open_workspace"),
                  )
                }
              />
              <Item
                label="Edit Snippets (.pointer/snippets.json)"
                onSelect={() =>
                  run("snippets", () =>
                    dispatchAction("settings:open_snippets"),
                  )
                }
              />
              <Item
                label="Keyboard Shortcuts"
                shortcut="⌘?"
                onSelect={() =>
                  run("shortcuts", () => dispatchAction("help:shortcuts"))
                }
              />
            </Command.Group>

            <Command.Group heading="AI" className="text-noir-mute">
              <Item
                label="AI Control Panel"
                shortcut="⌘⇧,"
                onSelect={() => run("ai", openAIPanel)}
              />
              <Item
                label="Toggle Assistant"
                shortcut="⌘L"
                onSelect={() => run("assistant", toggleAssistant)}
              />
              <Item
                label="Assistant: Ask Mode"
                onSelect={() =>
                  run("ask", () => dispatchAction("ai:assistant_ask"))
                }
              />
              <Item
                label="Assistant: Plan Mode"
                onSelect={() =>
                  run("plan", () => dispatchAction("ai:assistant_plan"))
                }
              />
              <Item
                label="Assistant: Agent Mode"
                onSelect={() =>
                  run("agent", () => dispatchAction("ai:assistant_agent"))
                }
              />
              <Item
                label="Show History"
                onSelect={() =>
                  run("history", () => dispatchAction("ai:show_history"))
                }
              />
              <Item
                label={`Tab Completion: ${fimEnabled ? "On" : "Off"}`}
                onSelect={() =>
                  run("tab", () => setFimEnabled(!fimEnabled))
                }
              />
              {root && (
                <Item
                  label="Index Codebase"
                  onSelect={() =>
                    // Route through the same action the menu uses so every
                    // gate (toggle, model selected, model installed,
                    // runtime up) applies uniformly. The action surfaces a
                    // precise toast if the feature isn't ready.
                    run("index", () => dispatchAction("ai:index_workspace"))
                  }
                />
              )}
              <Item
                label="Setup / Onboarding"
                onSelect={() => run("setup", openOnboarding)}
              />
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function timeAgo(ts: number): string {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

function Item({
  label,
  shortcut,
  onSelect,
}: {
  label: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex items-center justify-between px-4 py-2 text-[13px] font-sans text-noir-text aria-selected:bg-noir-ridge cursor-pointer"
    >
      <span>{label}</span>
      {shortcut && <span className="pn-kbd">{shortcut}</span>}
    </Command.Item>
  );
}
