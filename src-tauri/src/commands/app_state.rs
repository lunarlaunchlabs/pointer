//! Factory-reset support. Lets the user return Pointer to its first-launch
//! state without uninstalling the app — clears the persistent settings store,
//! the HF token (both keychain and file fallback), and optionally the OS
//! caches we own. Used by the AI panel's "Reset Pointer" button.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Deserialize, Default)]
pub struct ResetOptions {
    /// Wipe the persisted settings store (pointer.json): model picks, FIM
    /// debounce, recents, session, onboarded flag, ...
    #[serde(default = "true_default")]
    pub clear_settings: bool,
    /// Clear the Hugging Face token from both the keychain and the file
    /// fallback.
    #[serde(default = "true_default")]
    pub clear_hf_token: bool,
    /// Remove the local indexer SQLite DBs.
    #[serde(default)]
    pub clear_index: bool,
    /// Stop the Ollama daemon Pointer started, if any. Doesn't uninstall it.
    #[serde(default = "true_default")]
    pub stop_ollama: bool,
}

fn true_default() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct ResetReport {
    pub steps: Vec<ResetStep>,
}

#[derive(Debug, Serialize)]
pub struct ResetStep {
    pub label: String,
    pub ok: bool,
    pub message: Option<String>,
}

#[tauri::command]
pub async fn reset_app_state(
    app: AppHandle,
    state: State<'_, AppState>,
    options: Option<ResetOptions>,
) -> AppResult<ResetReport> {
    let opts = options.unwrap_or_default();
    let mut steps: Vec<ResetStep> = Vec::new();

    if opts.stop_ollama {
        let was_owned = state.ollama_child.lock().is_some();
        state.shutdown_ollama();
        steps.push(ResetStep {
            label: "stop owned Ollama daemon".into(),
            ok: true,
            message: Some(if was_owned {
                "stopped".into()
            } else {
                "no owned daemon".into()
            }),
        });
    }

    if opts.clear_settings {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::Msg(format!("app_data_dir: {e}")))?;
        let settings_file = dir.join("pointer.json");
        if settings_file.exists() {
            match std::fs::remove_file(&settings_file) {
                Ok(()) => steps.push(ResetStep {
                    label: "remove settings store".into(),
                    ok: true,
                    message: Some(settings_file.display().to_string()),
                }),
                Err(e) => steps.push(ResetStep {
                    label: "remove settings store".into(),
                    ok: false,
                    message: Some(format!("{}: {e}", settings_file.display())),
                }),
            }
        } else {
            steps.push(ResetStep {
                label: "remove settings store".into(),
                ok: true,
                message: Some("nothing to remove".into()),
            });
        }
    }

    if opts.clear_hf_token {
        match crate::commands::models::clear_hf_token(app.clone()).await {
            Ok(()) => steps.push(ResetStep {
                label: "clear HF token".into(),
                ok: true,
                message: None,
            }),
            Err(e) => steps.push(ResetStep {
                label: "clear HF token".into(),
                ok: false,
                message: Some(e.to_string()),
            }),
        }
    }

    if opts.clear_index {
        if let Ok(dir) = app.path().app_data_dir() {
            let index_dir = dir.join("index");
            if index_dir.exists() {
                match std::fs::remove_dir_all(&index_dir) {
                    Ok(()) => steps.push(ResetStep {
                        label: "remove indexer cache".into(),
                        ok: true,
                        message: Some(index_dir.display().to_string()),
                    }),
                    Err(e) => steps.push(ResetStep {
                        label: "remove indexer cache".into(),
                        ok: false,
                        message: Some(format!("{}: {e}", index_dir.display())),
                    }),
                }
            }
        }
    }

    Ok(ResetReport { steps })
}
