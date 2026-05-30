/**
 * Central action registry.
 *
 * Everything an IDE user can trigger — from the native menu bar, the command
 * palette, a keyboard shortcut, the welcome screen, or a chrome button —
 * ultimately resolves to one of these named actions. Each handler is a small
 * app-scoped pub-sub subscription so React components can register themselves
 * without prop-drilling, and the macOS native menu can fire any action without
 * knowing which component owns it.
 *
 * Why a module-local bus instead of Zustand? Some actions (open palette, focus
 * inline edit, etc.) are *transient view triggers*, not state updates. A bus
 * keeps view triggers out of persisted state and avoids needless re-renders.
 */

export type ActionId =
  // app
  | "app:preferences"
  | "app:onboarding"
  // themes
  | "theme:pointer-noir"
  | "theme:pointer-gris"
  | "theme:pointer-blanc"
  | "theme:pointer-magnet"
  | "theme:pointer-alien"
  | "theme:pointer-pastelle"
  | "theme:pointer-paladin"
  | "theme:pointer-desert-sage"
  | "theme:pointer-salmon"
  | "theme:pointer-dark-photon"
  | "theme:pointer-harmonic-tide"
  | "theme:pointer-rocket"
  | "theme:pointer-meteor"
  | "theme:pointer-dark-cola"
  | "theme:pointer-vampire"
  | "theme:pointer-monkey-pro"
  // file
  | "file:new"
  | "file:new_folder"
  | "file:open_folder"
  | "file:open_recent"
  | "file:new_untitled"
  | "file:find_file"
  | "file:save"
  | "file:save_without_formatting"
  | "file:revert"
  | "editor:format_selection"
  | "editor:transpose_chars"
  | "file:save_all"
  | "file:close_tab"
  // edit
  | "edit:palette"
  | "edit:find_in_files"
  | "edit:replace_in_files"
  | "file:compare_select"
  | "file:compare_with_selected"
  | "file:compare_active_with_clipboard"
  // editor (in-file)
  | "editor:nav_back"
  | "editor:nav_forward"
  | "editor:fold"
  | "editor:unfold"
  | "editor:fold_all"
  | "editor:unfold_all"
  | "editor:sort_lines_asc"
  | "editor:sort_lines_desc"
  | "editor:trim_trailing_whitespace"
  | "editor:upper_case"
  | "editor:lower_case"
  | "editor:title_case"
  | "editor:duplicate_line"
  | "editor:toggle_line_comment"
  | "editor:toggle_block_comment"
  | "editor:join_lines"
  | "editor:insert_uuid"
  | "editor:insert_datetime"
  | "editor:goto_line"
  | "editor:goto_definition"
  | "editor:peek_definition"
  | "editor:goto_symbol_file"
  | "editor:goto_symbol_workspace"
  | "editor:toggle_indent"
  | "editor:change_language"
  | "editor:change_eol"
  | "editor:format_document"
  | "editor:rename_symbol"
  | "editor:next_problem"
  | "editor:prev_problem"
  | "diagnostics:run_project_check"
  // debug
  | "debug:show_panel"
  | "debug:toggle_breakpoint"
  // tabs
  | "tabs:reopen_closed"
  | "tabs:close_others"
  | "tabs:close_to_right"
  | "tabs:close_all"
  | "tabs:pin_active"
  | "tabs:next"
  | "tabs:prev"
  // settings
  | "settings:open"
  | "settings:open_workspace"
  | "settings:open_snippets"
  | "settings:keybindings"
  // ai
  // `ai:toggle_chat` is the legacy command id for opening the chat
  // sidebar; we now route it through the unified Assistant. The new
  // canonical id is `ai:toggle_assistant` plus per-mode shortcuts.
  // The legacy ids are kept as aliases for one release so user
  // keybindings continue to work.
  | "ai:toggle_chat"
  | "ai:show_agent"
  | "ai:toggle_assistant"
  | "ai:assistant_ask"
  | "ai:assistant_plan"
  | "ai:assistant_agent"
  | "ai:show_history"
  | "ai:show_ai"
  | "ai:inline_edit"
  | "ai:toggle_fim"
  | "ai:request_fim"
  | "ai:index_workspace"
  | "ai:toggle_feature_chat"
  | "ai:toggle_feature_agent"
  | "ai:toggle_feature_inline_edit"
  | "ai:toggle_feature_indexing"
  | "ai:toggle_ollama"
  // view
  | "view:toggle_tree"
  | "view:toggle_dock"
  | "view:toggle_terminal"
  | "view:new_terminal"
  | "view:toggle_problems"
  | "view:system_monitor"
  | "view:reveal_in_tree"
  | "view:toggle_minimap"
  | "view:toggle_word_wrap"
  | "view:toggle_zen"
  | "tasks:run"
  | "tasks:edit"
  | "bookmark:toggle"
  | "bookmark:next"
  | "bookmark:prev"
  | "bookmark:list"
  | "bookmark:clear_file"
  | "bookmark:clear_all"
  | "view:font_zoom_in"
  | "view:font_zoom_out"
  | "view:font_zoom_reset"
  // tree
  | "tree:focus_filter"
  | "tree:collapse_all"
  // markdown
  | "md:toggle_preview"
  | "md:open_preview_side"
  // git
  | "git:show_panel"
  | "git:fetch"
  | "git:pull"
  | "git:push"
  // help
  | "help:onboarding"
  | "help:docs"
  | "help:shortcuts"
  | "help:about"
  | "help:notifications";

type ActionListener = (id: ActionId) => void;

const listeners: (ActionListener | null)[] = [];

/** Fire an action. Anyone subscribed via `onAction(id, fn)` will run. */
export function dispatchAction(id: ActionId): void {
  for (let i = 0; i < listeners.length; i++) {
    listeners[i]?.(id);
  }
}

/** Subscribe to a specific action. Returns an unsubscribe function. */
export function onAction(id: ActionId, fn: () => void): () => void {
  const handler: ActionListener = (actionId) => {
    if (actionId === id) fn();
  };
  const index = listeners.length;
  listeners[index] = handler;
  return () => {
    listeners[index] = null;
  };
}
