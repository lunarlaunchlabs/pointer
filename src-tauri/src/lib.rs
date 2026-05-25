mod commands;
mod error;
mod menu;
pub mod services;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Persists window position + size across launches. Default
        // state flags include Size + Position + Maximized, which is
        // exactly what users expect from a desktop IDE. The plugin
        // writes to its own JSON store so it doesn't interfere with
        // our settings persistence.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // FS commands
            commands::fs::read_workspace_tree,
            commands::fs::read_text_file,
            commands::fs::write_text_file,
            commands::fs::create_file,
            commands::fs::create_dir,
            commands::fs::delete_path,
            commands::fs::rename_path,
            commands::fs::search_files,
            commands::fs::search_directories,
            commands::fs::search_text,
            commands::fs::replace_text,
            commands::fs::watch_workspace,
            commands::fs::unwatch_workspace,
            commands::fs::reveal_in_filer,
            commands::format::format_text,
            // Workspace brief — compact "what is this project" snapshot
            // injected into both the chat system prompt and the agent's
            // initial user brief.
            commands::workspace::workspace_brief,
            // Agent change journal — snapshot/keep/undo for each
            // mutating tool call the agent ran in a session, exposed
            // to the FE so it can render a "Review changes" card at
            // end of turn.
            commands::agent_changes::agent_change_diff,
            commands::agent_changes::agent_undo_change,
            commands::agent_changes::agent_keep_change,
            commands::agent_changes::agent_purge_changes,
            // Git
            commands::git::git_status_for_workspace,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_discard,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_fetch,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_create_branch,
            commands::git::git_diff,
            commands::git::git_show_file,
            commands::git::git_blame_file,
            commands::git::git_log,
            // Integrated terminal
            commands::terminal::terminal_open,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            // Ollama
            commands::ollama::ollama_status,
            commands::ollama::ollama_install,
            commands::ollama::ollama_start,
            commands::ollama::ollama_stop,
            commands::ollama::ollama_delete_model,
            commands::ollama::ollama_uninstall,
            commands::ollama::ollama_list_models,
            commands::ollama::ollama_pull,
            commands::ollama::ollama_chat,
            commands::ollama::ollama_generate,
            commands::ollama::ollama_fim,
            commands::ollama::ollama_embed,
            commands::ollama::ollama_cancel,
            commands::ollama::ollama_unload_model,
            commands::ollama::ollama_ps,
            // Models / HF
            commands::models::recommend_models,
            commands::models::system_memory_gb,
            commands::models::set_hf_token,
            commands::models::get_hf_token,
            commands::models::clear_hf_token,
            commands::models::hf_token_status,
            commands::models::hf_search_models,
            commands::models::hf_import_gguf,
            // Context
            commands::context::index_workspace,
            commands::context::search_codebase,
            commands::context::chunk_file,
            commands::context::index_status,
            // Agent
            commands::agent::agent_run,
            commands::agent::agent_continue,
            commands::agent::agent_estimate,
            commands::agent::agent_cancel,
            commands::agent::agent_approve,
            commands::agent::agent_reject,
            commands::agent::agent_budget_decision,
            commands::agent::agent_shell_respond,
            // Unified Assistant (Ask passthrough + Plan→Agent promotion)
            commands::assistant::assistant_ask,
            commands::assistant::agent_execute_plan,
            // Fast Apply (speculative-edits scaffold)
            commands::fast_apply::ollama_fast_apply,
            // System monitor
            commands::system::system_snapshot,
            commands::system::kill_owned_process,
            commands::system::hardware_profile,
            // File ingestion (images, PDFs, spreadsheets)
            commands::files::classify_file,
            commands::files::process_file,
            // MCP (Model Context Protocol) client
            commands::mcp::mcp_load_config,
            commands::mcp::mcp_save_config,
            commands::mcp::mcp_upsert_server,
            commands::mcp::mcp_remove_server,
            commands::mcp::mcp_list_servers,
            commands::mcp::mcp_start_server,
            commands::mcp::mcp_stop_server,
            commands::mcp::mcp_restart_server,
            commands::mcp::mcp_list_tools,
            commands::mcp::mcp_call_tool,
            commands::mcp::mcp_get_logs,
            // Factory reset
            commands::app_state::reset_app_state,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_title("Pointer");
                }
            }
            // Install the native menu bar. We swallow errors here because a
            // missing menu is an annoyance, not a reason to abort startup.
            if let Err(e) = menu::install(&app.handle()) {
                log::warn!("failed to install native menu: {e}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pointer")
        .run(|app_handle, event| {
            use tauri::Manager;
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    let state = app_handle.state::<AppState>();
                    state.shutdown_ollama();
                    // Reap MCP children synchronously on the runtime so no
                    // user-spawned MCP server outlives the editor.
                    let mcp = state.mcp.clone();
                    let _ = tokio::runtime::Handle::try_current().map(|h| {
                        h.block_on(async move {
                            mcp.shutdown_all().await;
                        })
                    });
                }
                _ => {}
            }
        });
}
