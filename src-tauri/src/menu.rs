//! Native application menu bar.
//!
//! On macOS this becomes the global menubar at the top of the screen — the one
//! every "real" IDE has. We build it once at startup, then route every custom
//! item id back to the React frontend as a `menu:action` event. The frontend
//! handles the action with the same code paths used by the in-app shortcuts,
//! so users always get identical behaviour whether they click File → Save or
//! press ⌘S.
//!
//! Predefined items (Quit / Undo / Cut / …) are wired up by Tauri directly to
//! the OS and don't surface as menu events.

use tauri::{
    menu::{
        AboutMetadataBuilder, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, MenuItemKind,
        PredefinedMenuItem, SubmenuBuilder,
    },
    AppHandle, Emitter, Runtime,
};

const THEMES_MENU_ID: &str = "menu:themes";
const DEFAULT_THEME_MENU_ID: &str = "theme:pointer-noir";
const THEME_MENU_ITEMS: &[(&str, &str)] = &[
    ("theme:pointer-noir", "Pointer Noir"),
    ("theme:pointer-gris", "Pointer Gris"),
    ("theme:pointer-blanc", "Pointer Blanc"),
    ("theme:pointer-magnet", "Pointer Magnet"),
    ("theme:pointer-alien", "Pointer Alien"),
    ("theme:pointer-pastelle", "Pointer Pastelle"),
    ("theme:pointer-paladin", "Pointer Paladin"),
    ("theme:pointer-desert-sage", "Pointer Desert Sage"),
    ("theme:pointer-salmon", "Pointer Salmon"),
    ("theme:pointer-dark-photon", "Pointer Dark Photon"),
    ("theme:pointer-harmonic-tide", "Pointer Harmonic Tide"),
    ("theme:pointer-rocket", "Pointer Rocket"),
    ("theme:pointer-meteor", "Pointer Meteor"),
    ("theme:pointer-dark-cola", "Pointer Dark Cola"),
    ("theme:pointer-vampire", "Pointer Vampire"),
    ("theme:pointer-monkey-pro", "Pointer Monkey Pro"),
];

/// Build and install the application menu. Call once during `setup`.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let version = app.package_info().version.to_string();
    let about_meta = AboutMetadataBuilder::new()
        .name(Some("Pointer".to_string()))
        .version(Some(version))
        .comments(Some(
            "An AI-first code editor powered by local open-source models.".to_string(),
        ))
        .website(Some("https://github.com".to_string()))
        .build();

    // ── Pointer (app submenu) ────────────────────────────────────────────
    let app_menu = SubmenuBuilder::new(app, "Pointer")
        .item(&PredefinedMenuItem::about(
            app,
            Some("About Pointer"),
            Some(about_meta),
        )?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("settings:open", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("ai:show_ai", "AI Control Panel…")
                .accelerator("CmdOrCtrl+Shift+,")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("app:onboarding", "Setup / Onboarding…").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::services(app, Some("Services"))?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Hide Pointer"))?)
        .item(&PredefinedMenuItem::hide_others(app, Some("Hide Others"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("Show All"))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit Pointer"))?)
        .build()?;

    // ── File ────────────────────────────────────────────────────────────
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("file:new", "New File")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file:new_folder", "New Folder")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("file:open_folder", "Open Folder…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file:open_recent", "Open Recent…")
                .accelerator("CmdOrCtrl+R")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file:new_untitled", "New Untitled File")
                .accelerator("CmdOrCtrl+Alt+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file:find_file", "Find File…")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("file:save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file:save_all", "Save All")
                .accelerator("CmdOrCtrl+Alt+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("file:close_tab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tabs:reopen_closed", "Reopen Closed Tab")
                .accelerator("CmdOrCtrl+Shift+T")
                .build(app)?,
        )
        .item(&PredefinedMenuItem::close_window(
            app,
            Some("Close Window"),
        )?)
        .build()?;

    // ── Edit ────────────────────────────────────────────────────────────
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, Some("Undo"))?)
        .item(&PredefinedMenuItem::redo(app, Some("Redo"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("Cut"))?)
        .item(&PredefinedMenuItem::copy(app, Some("Copy"))?)
        .item(&PredefinedMenuItem::paste(app, Some("Paste"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("Select All"))?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("edit:palette", "Command Palette…")
                .accelerator("CmdOrCtrl+Shift+P")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("edit:find_in_files", "Find in Files…")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("editor:goto_line", "Go to Line…")
                .accelerator("CmdOrCtrl+G")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("editor:goto_definition", "Go to Definition")
                .accelerator("F12")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("editor:peek_definition", "Peek Definition")
                .accelerator("Alt+F12")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("editor:goto_symbol_file", "Go to Symbol in File…")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("editor:format_document", "Format Document")
                .accelerator("CmdOrCtrl+Shift+I")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("editor:rename_symbol", "Rename Symbol").build(app)?)
        .build()?;

    // ── AI ──────────────────────────────────────────────────────────────
    // Surfacing AI as a first-class menu signals what makes Pointer different.
    // Feature toggles are surfaced here too so the keyboard-driven user can
    // turn an entire feature off without hunting through the AI panel.
    let ai_menu = SubmenuBuilder::new(app, "AI")
        // The legacy "Toggle Chat" / "Show Agent" items both fed into
        // the same right-dock surface; they collapse here into one
        // unified "Toggle Assistant" item, with the picker inside the
        // panel choosing Ask | Plan | Agent. ⌘L keeps its accelerator
        // so muscle memory survives the rename.
        .item(
            &MenuItemBuilder::with_id("ai:toggle_assistant", "Toggle Assistant")
                .accelerator("CmdOrCtrl+L")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("ai:assistant_ask", "Assistant: Ask Mode").build(app)?)
        .item(&MenuItemBuilder::with_id("ai:assistant_plan", "Assistant: Plan Mode").build(app)?)
        .item(&MenuItemBuilder::with_id("ai:assistant_agent", "Assistant: Agent Mode").build(app)?)
        .item(&MenuItemBuilder::with_id("ai:show_history", "Show History").build(app)?)
        .item(&MenuItemBuilder::with_id("ai:show_ai", "AI Control Panel").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("ai:inline_edit", "Inline Edit Selection")
                .accelerator("CmdOrCtrl+K")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("ai:index_workspace", "Index Workspace").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("ai:toggle_feature_chat", "Enable / Disable Chat")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("ai:toggle_feature_agent", "Enable / Disable Agent")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(
                "ai:toggle_feature_inline_edit",
                "Enable / Disable Inline Edit",
            )
            .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("ai:toggle_fim", "Enable / Disable Tab Completion")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(
                "ai:toggle_feature_indexing",
                "Enable / Disable Codebase Indexing",
            )
            .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("ai:toggle_ollama", "Start / Stop Ollama").build(app)?)
        .build()?;

    // ── View ────────────────────────────────────────────────────────────
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("view:toggle_tree", "Toggle File Tree")
                .accelerator("CmdOrCtrl+B")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("view:toggle_dock", "Toggle Right Panel").build(app)?)
        .item(
            &MenuItemBuilder::with_id("view:toggle_terminal", "Toggle Terminal")
                .accelerator("CmdOrCtrl+J")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view:new_terminal", "New Terminal")
                .accelerator("CmdOrCtrl+`")
                .build(app)?,
        )
        .item(
            // No accelerator: ⌘⇧M is taken by System Monitor (above) and
            // ⌘⇧P is the Command Palette. The status-bar warning chip and
            // this menu item are the primary entry points.
            &MenuItemBuilder::with_id("view:toggle_problems", "Problems").build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("view:system_monitor", "System Monitor")
                .accelerator("CmdOrCtrl+Shift+M")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("view:reveal_in_tree", "Reveal Active File in Tree")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("view:toggle_minimap", "Toggle Minimap").build(app)?)
        .item(
            &MenuItemBuilder::with_id("view:toggle_word_wrap", "Toggle Word Wrap")
                .accelerator("Alt+Z")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("view:font_zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view:font_zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view:font_zoom_reset", "Reset Zoom")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::fullscreen(
            app,
            Some("Enter Full Screen"),
        )?)
        .build()?;

    // ── Themes ──────────────────────────────────────────────────────────
    // Theme selection is routed through the same action bus as commands so
    // the native menu, Settings page, command palette, and editor all share
    // one persisted source of truth.
    let theme_item = |id: &str, label: &str| {
        CheckMenuItemBuilder::with_id(id, label)
            .checked(id == DEFAULT_THEME_MENU_ID)
            .build(app)
    };
    let themes_menu = SubmenuBuilder::with_id(app, THEMES_MENU_ID, "Themes")
        .item(&theme_item("theme:pointer-noir", "Pointer Noir")?)
        .item(&theme_item("theme:pointer-gris", "Pointer Gris")?)
        .item(&theme_item("theme:pointer-blanc", "Pointer Blanc")?)
        .item(&theme_item("theme:pointer-magnet", "Pointer Magnet")?)
        .item(&theme_item("theme:pointer-alien", "Pointer Alien")?)
        .item(&theme_item("theme:pointer-pastelle", "Pointer Pastelle")?)
        .separator()
        .item(&theme_item("theme:pointer-paladin", "Pointer Paladin")?)
        .item(&theme_item(
            "theme:pointer-desert-sage",
            "Pointer Desert Sage",
        )?)
        .item(&theme_item("theme:pointer-salmon", "Pointer Salmon")?)
        .item(&theme_item(
            "theme:pointer-dark-photon",
            "Pointer Dark Photon",
        )?)
        .item(&theme_item(
            "theme:pointer-harmonic-tide",
            "Pointer Harmonic Tide",
        )?)
        .separator()
        .item(&theme_item("theme:pointer-rocket", "Pointer Rocket")?)
        .item(&theme_item("theme:pointer-meteor", "Pointer Meteor")?)
        .item(&theme_item("theme:pointer-dark-cola", "Pointer Dark Cola")?)
        .item(&theme_item("theme:pointer-vampire", "Pointer Vampire")?)
        .item(&theme_item(
            "theme:pointer-monkey-pro",
            "Pointer Monkey Pro",
        )?)
        .build()?;

    // ── Source Control ─────────────────────────────────────────────────
    let scm_menu = SubmenuBuilder::new(app, "Source Control")
        .item(
            &MenuItemBuilder::with_id("git:show_panel", "Show Source Control Panel")
                .accelerator("CmdOrCtrl+Shift+G")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("git:fetch", "Fetch").build(app)?)
        .item(&MenuItemBuilder::with_id("git:pull", "Pull").build(app)?)
        .item(&MenuItemBuilder::with_id("git:push", "Push").build(app)?)
        .build()?;

    // ── Window ──────────────────────────────────────────────────────────
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, Some("Minimize"))?)
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(
            app,
            Some("Bring All to Front"),
        )?)
        .build()?;

    // ── Help ────────────────────────────────────────────────────────────
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("help:shortcuts", "Keyboard Shortcuts…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("help:onboarding", "Re-run Setup").build(app)?)
        .item(&MenuItemBuilder::with_id("help:docs", "Documentation").build(app)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &ai_menu,
            &view_menu,
            &themes_menu,
            &scm_menu,
            &window_menu,
            &help_menu,
        ])
        .build()?;

    app.set_menu(menu)?;

    // Route every custom item back to the frontend, where the same Zustand
    // actions used by the in-app shortcuts will fire. Predefined items (cut /
    // copy / quit / …) never reach this callback — the OS handles them.
    let handle = app.clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id().0.as_str().to_string();
        // Marker for menu-bar events so the frontend doesn't have to grep ids.
        let _ = handle.emit("menu:action", serde_json::json!({ "id": id }));
    });

    Ok(())
}

pub(crate) fn set_active_theme<R: Runtime>(
    app: &AppHandle<R>,
    theme_id: &str,
) -> tauri::Result<()> {
    let active_id = format!("theme:{theme_id}");
    if !THEME_MENU_ITEMS.iter().any(|(id, _)| *id == active_id) {
        return Ok(());
    }

    let Some(themes_menu) = app
        .menu()
        .and_then(|menu| menu.get(THEMES_MENU_ID))
        .and_then(|item| match item {
            MenuItemKind::Submenu(submenu) => Some(submenu),
            _ => None,
        })
    else {
        return Ok(());
    };

    for &(id, _) in THEME_MENU_ITEMS {
        if let Some(check_item) = themes_menu
            .get(id)
            .and_then(|item| item.as_check_menuitem().cloned())
        {
            check_item.set_checked(id == active_id)?;
        }
    }

    Ok(())
}
