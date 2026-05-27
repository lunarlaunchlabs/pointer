use crate::error::AppResult;
use crate::services::inference::{emit_change, InferenceSnapshot};
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn inference_status(state: State<'_, AppState>) -> AppResult<InferenceSnapshot> {
    Ok(state.inference.snapshot())
}

#[tauri::command]
pub async fn inference_cancel(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
) -> AppResult<bool> {
    // Agent requests have extra sidecars (approval waits and shell children).
    // The helper is intentionally safe to call for non-agent requests too.
    let cancelled_agent_sidecars =
        crate::commands::agent::cancel_agent_request(&state, &request_id);
    let cancelled_token = state.cancels.lock().cancel(&request_id);
    let marked = state.inference.mark_cancelling(&request_id);
    emit_change(&app, &state.inference);
    Ok(cancelled_agent_sidecars || cancelled_token || marked)
}
