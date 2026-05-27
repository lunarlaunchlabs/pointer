//! Tauri IPC bindings for the MCP client.
//!
//! Every command is a thin shim over [`crate::services::mcp::McpManager`].
//! Errors are bubbled up as plain strings so the frontend can render
//! them inside the MCP panel without any further mapping.

use crate::error::{AppError, AppResult};
use crate::services::mcp::{McpConfig, McpTool, ServerConfig, ServerSnapshot};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

/// Ensure the MCP manager knows where to read/write `mcp.json`. We use the
/// app data dir so the file lives wherever Tauri stores per-user state
/// (e.g. `~/Library/Application Support/com.pointer.editor/mcp.json` on macOS).
fn ensure_config_path(app: &AppHandle, state: &State<'_, AppState>) -> AppResult<PathBuf> {
    let path = match state.mcp.config_path() {
        Some(p) => p,
        None => {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| AppError::Msg(format!("app_data_dir: {e}")))?;
            std::fs::create_dir_all(&dir).map_err(AppError::from)?;
            let p = dir.join("mcp.json");
            state.mcp.set_config_path(p.clone());
            p
        }
    };
    Ok(path)
}

#[tauri::command]
pub async fn mcp_load_config(app: AppHandle, state: State<'_, AppState>) -> AppResult<McpConfig> {
    ensure_config_path(&app, &state)?;
    let cfg = state.mcp.load_config().map_err(AppError::Msg)?;
    state.mcp.sync_from_config(&cfg).await;
    Ok(cfg)
}

#[tauri::command]
pub async fn mcp_save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: McpConfig,
) -> AppResult<McpConfig> {
    ensure_config_path(&app, &state)?;
    state.mcp.save_config(&config).map_err(AppError::Msg)?;
    state.mcp.sync_from_config(&config).await;
    Ok(config)
}

#[derive(Debug, Deserialize)]
pub struct McpUpsertRequest {
    pub name: String,
    pub config: ServerConfig,
}

/// Add or update a single server entry. We load + mutate + save so two
/// callers don't trample each other.
#[tauri::command]
pub async fn mcp_upsert_server(
    app: AppHandle,
    state: State<'_, AppState>,
    request: McpUpsertRequest,
) -> AppResult<McpConfig> {
    ensure_config_path(&app, &state)?;
    let mut cfg = state.mcp.load_config().map_err(AppError::Msg)?;
    cfg.servers.insert(request.name, request.config);
    state.mcp.save_config(&cfg).map_err(AppError::Msg)?;
    state.mcp.sync_from_config(&cfg).await;
    Ok(cfg)
}

#[tauri::command]
pub async fn mcp_remove_server(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> AppResult<McpConfig> {
    ensure_config_path(&app, &state)?;
    // Stop first so the spawned subprocess actually exits.
    let _ = state.mcp.stop_server(&name).await;
    let mut cfg = state.mcp.load_config().map_err(AppError::Msg)?;
    cfg.servers.remove(&name);
    state.mcp.save_config(&cfg).map_err(AppError::Msg)?;
    state.mcp.sync_from_config(&cfg).await;
    Ok(cfg)
}

#[tauri::command]
pub async fn mcp_list_servers(state: State<'_, AppState>) -> AppResult<Vec<ServerSnapshot>> {
    Ok(state.mcp.list_servers())
}

#[tauri::command]
pub async fn mcp_start_server(
    state: State<'_, AppState>,
    name: String,
) -> AppResult<ServerSnapshot> {
    state.mcp.start_server(&name).await.map_err(AppError::Msg)
}

#[tauri::command]
pub async fn mcp_stop_server(state: State<'_, AppState>, name: String) -> AppResult<()> {
    state.mcp.stop_server(&name).await.map_err(AppError::Msg)
}

#[tauri::command]
pub async fn mcp_restart_server(
    state: State<'_, AppState>,
    name: String,
) -> AppResult<ServerSnapshot> {
    state.mcp.restart_server(&name).await.map_err(AppError::Msg)
}

#[tauri::command]
pub async fn mcp_list_tools(state: State<'_, AppState>, name: String) -> AppResult<Vec<McpTool>> {
    // Always refresh so the UI sees the server's live state. Falls back to
    // the cached list on error.
    match state.mcp.refresh_tools(&name).await {
        Ok(t) => Ok(t),
        Err(e) => {
            log::warn!("mcp_list_tools refresh failed for {name}: {e}; returning cache");
            Ok(state.mcp.list_tools(&name))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct McpCallToolRequest {
    pub server: String,
    pub tool: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Serialize)]
pub struct McpCallToolResponse {
    pub result: Value,
}

#[tauri::command]
pub async fn mcp_call_tool(
    state: State<'_, AppState>,
    request: McpCallToolRequest,
) -> AppResult<McpCallToolResponse> {
    let result = state
        .mcp
        .call_tool(&request.server, &request.tool, request.arguments)
        .await
        .map_err(AppError::Msg)?;
    Ok(McpCallToolResponse { result })
}

#[tauri::command]
pub async fn mcp_get_logs(state: State<'_, AppState>, name: String) -> AppResult<Vec<String>> {
    Ok(state.mcp.get_logs(&name))
}
