use crate::error::{AppError, AppResult};
use crate::services::lsp::{
    LanguageServerStatus, LspCompletionItem, LspCompletionResolveRequest, LspDocumentHighlight,
    LspDocumentRequest, LspDocumentSymbol, LspFileTextEdit, LspHover, LspInlayHint,
    LspInlayHintsRequest, LspLocation, LspRenameRequest, LspSignatureHelp, LspTextDocumentRequest,
    StoppedLanguageServer,
};
use crate::state::AppState;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStopIdleRequest {
    pub workspace: Option<String>,
    pub stop_all: bool,
    #[serde(default)]
    pub languages: Vec<String>,
}

#[tauri::command]
pub async fn lsp_status(
    state: State<'_, AppState>,
    workspace: Option<String>,
) -> AppResult<Vec<LanguageServerStatus>> {
    let root = resolve_workspace(&state, workspace)?;
    Ok(state.lsp.statuses(&root).await)
}

#[tauri::command]
pub async fn lsp_stop_idle(
    state: State<'_, AppState>,
    request: LspStopIdleRequest,
) -> AppResult<Vec<StoppedLanguageServer>> {
    let root = resolve_workspace(&state, request.workspace)?;
    Ok(state
        .lsp
        .stop_idle(&root, request.stop_all, &request.languages)
        .await)
}

#[tauri::command]
pub async fn lsp_did_open(
    app: AppHandle,
    state: State<'_, AppState>,
    doc: LspDocumentRequest,
) -> AppResult<()> {
    let root = resolve_workspace_for_path(&state, &doc.path)?;
    state
        .lsp
        .did_open_or_change(app, &root, doc)
        .await
        .map_err(AppError::Msg)
}

#[tauri::command]
pub async fn lsp_did_change(
    app: AppHandle,
    state: State<'_, AppState>,
    doc: LspDocumentRequest,
) -> AppResult<()> {
    let root = resolve_workspace_for_path(&state, &doc.path)?;
    state
        .lsp
        .did_open_or_change(app, &root, doc)
        .await
        .map_err(AppError::Msg)
}

#[tauri::command]
pub async fn lsp_hover(
    app: AppHandle,
    state: State<'_, AppState>,
    req: LspTextDocumentRequest,
) -> AppResult<Option<LspHover>> {
    let root = resolve_workspace_for_path(&state, &req.path)?;
    state
        .lsp
        .hover(app, &root, req)
        .await
        .map_err(AppError::Msg)
}

#[tauri::command]
pub async fn lsp_definition(
    app: AppHandle,
    state: State<'_, AppState>,
    req: LspTextDocumentRequest,
) -> AppResult<Vec<LspLocation>> {
    let root = resolve_workspace_for_path(&state, &req.path)?;
    state
        .lsp
        .definition(app, &root, req)
        .await
        .map_err(AppError::Msg)
}

#[tauri::command]
pub async fn lsp_references(
    app: AppHandle,
    state: State<'_, AppState>,
    req: LspTextDocumentRequest,
) -> AppResult<Vec<LspLocation>> {
    let root = resolve_workspace_for_path(&state, &req.path)?;
    state
        .lsp
        .references(app, &root, req)
        .await
        .map_err(AppError::Msg)
}

#[tauri::command]
pub async fn lsp_completion(
    app: AppHandle,
    state: State<'_, AppState>,
    req: LspTextDocumentRequest,
) -> AppResult<Vec<LspCompletionItem>> {
    let root = resolve_workspace_for_path(&state, &req.path)?;
    state
        .lsp
        .completion(app, &root, req)
        .await
        .map_err(AppError::Msg)
}

#[tauri::command]
pub async fn lsp_completion_resolve(
    app: AppHandle,
    state: State<'_, AppState>,
    req: LspCompletionResolveRequest,
) -> AppResult<LspCompletionItem> {
    let root = resolve_workspace_for_path(&state, &req.path)?;
    state
        .lsp
        .completion_resolve(app, &root, req)
        .await
        .map_err(AppError::Msg)
}

#[tauri::command]
pub async fn lsp_document_symbols(
    app: AppHandle,
    state: State<'_, AppState>,
    doc: LspDocumentRequest,
) -> AppResult<Vec<LspDocumentSymbol>> {
    let root = resolve_workspace_for_path(&state, &doc.path)?;
    state
        .lsp
        .document_symbols(app, &root, doc)
        .await
        .map_err(AppError::Msg)
}

#[tauri::command]
pub async fn lsp_signature_help(
    app: AppHandle,
    state: State<'_, AppState>,
    req: LspTextDocumentRequest,
) -> AppResult<Option<LspSignatureHelp>> {
    let root = resolve_workspace_for_path(&state, &req.path)?;
    state
        .lsp
        .signature_help(app, &root, req)
        .await
        .map_err(AppError::Msg)
}

#[tauri::command]
pub async fn lsp_document_highlight(
    app: AppHandle,
    state: State<'_, AppState>,
    req: LspTextDocumentRequest,
) -> AppResult<Vec<LspDocumentHighlight>> {
    let root = resolve_workspace_for_path(&state, &req.path)?;
    state
        .lsp
        .document_highlight(app, &root, req)
        .await
        .map_err(AppError::Msg)
}

#[tauri::command]
pub async fn lsp_inlay_hints(
    app: AppHandle,
    state: State<'_, AppState>,
    req: LspInlayHintsRequest,
) -> AppResult<Vec<LspInlayHint>> {
    let root = resolve_workspace_for_path(&state, &req.path)?;
    state
        .lsp
        .inlay_hints(app, &root, req)
        .await
        .map_err(AppError::Msg)
}

#[tauri::command]
pub async fn lsp_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    req: LspRenameRequest,
) -> AppResult<Vec<LspFileTextEdit>> {
    let root = resolve_workspace_for_path(&state, &req.path)?;
    state
        .lsp
        .rename(app, &root, req)
        .await
        .map_err(AppError::Msg)
}

fn resolve_workspace(state: &State<'_, AppState>, explicit: Option<String>) -> AppResult<PathBuf> {
    if let Some(root) = explicit.filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(root));
    }
    state
        .workspace
        .lock()
        .clone()
        .ok_or_else(|| AppError::Msg("No workspace is open.".into()))
}

fn resolve_workspace_for_path(state: &State<'_, AppState>, path: &str) -> AppResult<PathBuf> {
    if let Some(root) = state.workspace.lock().clone() {
        return Ok(root);
    }
    let p = PathBuf::from(path);
    p.parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| AppError::Msg("No workspace is open.".into()))
}
