use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use sysinfo::System;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "com.pointer.editor";
const KEYRING_ACCOUNT_HF: &str = "huggingface_token";

/// Resolved location of where the HF token actually lives.
#[derive(Debug, Serialize)]
pub struct HfTokenStatus {
    pub present: bool,
    /// "keychain" | "file" | null
    pub location: Option<String>,
    /// Short preview like "hf_…3X9Q" so the user can verify they saved the
    /// expected one without exposing the secret.
    pub preview: Option<String>,
    /// Absolute path to the on-disk fallback (always reported, even when the
    /// active source is the keychain) so the user can verify with their own
    /// eyes that something is on disk.
    pub file_path: Option<String>,
    /// True when the secondary keychain entry also holds the token.
    pub in_keychain: bool,
    /// True when the on-disk file holds the token.
    pub in_file: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelRecommendation {
    pub id: String,
    pub purpose: String,
    pub size_gb: f32,
    pub min_ram_gb: f32,
    pub description: String,
    pub recommended: bool,
}

#[tauri::command]
pub async fn system_memory_gb() -> AppResult<f32> {
    let mut sys = System::new();
    sys.refresh_memory();
    let bytes = sys.total_memory();
    Ok((bytes as f32) / (1024.0 * 1024.0 * 1024.0))
}

#[tauri::command]
pub async fn recommend_models() -> AppResult<Vec<ModelRecommendation>> {
    let mut sys = System::new();
    sys.refresh_memory();
    let total_gb = (sys.total_memory() as f32) / (1024.0 * 1024.0 * 1024.0);

    let candidates = vec![
        ModelRecommendation {
            id: "qwen2.5-coder:1.5b-base".into(),
            purpose: "fim".into(),
            size_gb: 1.0,
            min_ram_gb: 4.0,
            description: "Tiny FIM model for tab completion. Very fast.".into(),
            recommended: total_gb >= 4.0,
        },
        ModelRecommendation {
            id: "qwen2.5-coder:3b-base".into(),
            purpose: "fim".into(),
            size_gb: 2.0,
            min_ram_gb: 6.0,
            description: "Higher-quality FIM tab completion.".into(),
            recommended: total_gb >= 16.0,
        },
        ModelRecommendation {
            id: "qwen2.5-coder:7b-instruct".into(),
            purpose: "chat".into(),
            size_gb: 4.4,
            min_ram_gb: 8.0,
            description: "Capable chat & inline edit for 8–16GB machines.".into(),
            recommended: total_gb >= 8.0 && total_gb < 24.0,
        },
        ModelRecommendation {
            id: "qwen2.5-coder:14b-instruct".into(),
            purpose: "chat".into(),
            size_gb: 8.5,
            min_ram_gb: 16.0,
            description: "Strong chat / inline edit. Sweet spot for 16–32GB.".into(),
            recommended: total_gb >= 16.0 && total_gb < 48.0,
        },
        ModelRecommendation {
            id: "qwen2.5-coder:32b-instruct".into(),
            purpose: "chat".into(),
            size_gb: 19.0,
            min_ram_gb: 32.0,
            description: "Top-tier reasoning. Best on 32GB+.".into(),
            recommended: total_gb >= 32.0,
        },
        ModelRecommendation {
            id: "deepseek-coder-v2:16b".into(),
            purpose: "chat".into(),
            size_gb: 8.9,
            min_ram_gb: 16.0,
            description: "Alternative chat / agent model with strong refactoring.".into(),
            recommended: total_gb >= 16.0,
        },
        ModelRecommendation {
            id: "nomic-embed-text".into(),
            purpose: "embed".into(),
            size_gb: 0.3,
            min_ram_gb: 2.0,
            description: "Small embedding model for the codebase index.".into(),
            recommended: true,
        },
    ];

    Ok(candidates)
}

/// Save the HF token.
///
/// Storage strategy: the **on-disk file** is the durable, primary store; the
/// OS keychain is a best-effort mirror layered on top.
///
/// Why both, and why the file is primary:
/// * In `cargo tauri dev` the binary signature changes between rebuilds, so
///   macOS's keychain treats each launch as a different identity and may
///   silently stop returning entries it previously accepted. Linux session
///   keyrings also drop on logout. The file in the app data dir survives
///   these. So the file is what we trust to *persist*.
/// * The keychain, when it works, is the right place for secrets (encrypted
///   by the user account). We still write it so production / signed builds
///   benefit; reads prefer it over the file.
///
/// After writing, we re-read the file we just wrote (the operation we can
/// actually guarantee) so the UI can't lie about "saved".
#[tauri::command]
pub async fn set_hf_token(app: AppHandle, token: String) -> AppResult<HfTokenStatus> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::Msg("empty token".into()));
    }

    // Durable write first. If this fails we abort — there's no point claiming
    // success against a flaky keychain when the safety net is gone.
    let path = token_file(&app)?;
    if let Err(e) = file_set(&app, &token) {
        log::error!("hf_token: file write FAILED at {}: {e}", path.display());
        return Err(AppError::Msg(format!(
            "Couldn't write the token to {}: {e}",
            path.display(),
        )));
    }
    log::info!(
        "hf_token: wrote durable copy to {} (len={} bytes)",
        path.display(),
        token.len(),
    );

    // Best-effort keychain mirror. Failure here is informational only; we
    // already have the durable file.
    let in_keychain = match keyring_set(&token) {
        Ok(()) => {
            log::info!("hf_token: keychain mirror succeeded");
            true
        }
        Err(e) => {
            log::warn!("hf_token: keychain unavailable, file-only ({e})");
            false
        }
    };

    // Verify the durable write round-trips. This is the contract we promise
    // the UI — if this fails, there is genuinely nothing on disk.
    let in_file = match file_get(&app)? {
        Some(got) if got == token => true,
        Some(_) => {
            return Err(AppError::Msg(format!(
                "Token file at {} round-tripped a different value. Disk may be \
                 read-only or interrupted mid-write.",
                path.display(),
            )));
        }
        None => {
            return Err(AppError::Msg(format!(
                "Token file at {} disappeared right after writing. Check that \
                 the directory isn't being cleaned by another process.",
                path.display(),
            )));
        }
    };

    let location = if in_keychain { "keychain" } else { "file" };
    log::info!(
        "hf_token: save verified · source={location} in_file={in_file} \
         in_keychain={in_keychain}"
    );

    Ok(HfTokenStatus {
        present: true,
        location: Some(location.into()),
        preview: Some(preview(&token)),
        file_path: Some(path.display().to_string()),
        in_keychain,
        in_file,
    })
}

#[tauri::command]
pub async fn get_hf_token(app: AppHandle) -> AppResult<Option<String>> {
    Ok(read_token_with_location(&app).map(|(t, _)| t))
}

#[tauri::command]
pub async fn hf_token_status(app: AppHandle) -> AppResult<HfTokenStatus> {
    // Probe both stores independently so the UI can show the user exactly
    // what survived the last launch.
    let kc = keyring_get().ok().flatten();
    let fs = file_get(&app).ok().flatten();
    let in_keychain = kc.is_some();
    let in_file = fs.is_some();
    let path = token_file(&app).ok().map(|p| p.display().to_string());

    let active = kc.as_deref().or(fs.as_deref());
    match active {
        Some(t) => Ok(HfTokenStatus {
            present: true,
            location: Some(if in_keychain { "keychain".into() } else { "file".into() }),
            preview: Some(preview(t)),
            file_path: path,
            in_keychain,
            in_file,
        }),
        None => Ok(HfTokenStatus {
            present: false,
            location: None,
            preview: None,
            file_path: path,
            in_keychain: false,
            in_file: false,
        }),
    }
}

#[tauri::command]
pub async fn clear_hf_token(app: AppHandle) -> AppResult<()> {
    // Clear both stores so we don't resurrect on next launch from whichever
    // one happens to still have a value.
    if let Err(e) = keyring_clear() {
        log::warn!("keyring clear: {e}");
    }
    if let Err(e) = file_clear(&app) {
        log::warn!("file clear: {e}");
    }
    Ok(())
}

// -------------------- internals --------------------------------------------

fn keyring_set(token: &str) -> keyring::Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT_HF)?;
    entry.set_password(token)
}

fn keyring_get() -> keyring::Result<Option<String>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT_HF)?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

fn keyring_clear() -> keyring::Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT_HF)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}

fn token_file(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Msg(format!("app_data_dir: {e}")))?;
    let secrets = dir.join("secrets");
    std::fs::create_dir_all(&secrets)?;
    Ok(secrets.join("hf_token"))
}

fn file_set(app: &AppHandle, token: &str) -> AppResult<()> {
    let path = token_file(app)?;
    std::fs::write(&path, token.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn file_get(app: &AppHandle) -> AppResult<Option<String>> {
    let path = token_file(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)?;
    let s = String::from_utf8_lossy(&bytes).trim().to_string();
    if s.is_empty() {
        Ok(None)
    } else {
        Ok(Some(s))
    }
}

fn file_clear(app: &AppHandle) -> AppResult<()> {
    let path = token_file(app)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

fn read_token_with_location(app: &AppHandle) -> Option<(String, String)> {
    match keyring_get() {
        Ok(Some(t)) => return Some((t, "keychain".into())),
        Ok(None) => {}
        Err(e) => log::warn!("keyring get: {e}"),
    }
    match file_get(app) {
        Ok(Some(t)) => Some((t, "file".into())),
        Ok(None) => None,
        Err(e) => {
            log::warn!("file get: {e}");
            None
        }
    }
}

fn preview(token: &str) -> String {
    let len = token.chars().count();
    if len <= 10 {
        return "•••".to_string();
    }
    let prefix: String = token.chars().take(3).collect();
    let suffix: String = token.chars().rev().take(4).collect::<String>().chars().rev().collect();
    format!("{prefix}…{suffix}")
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HfSearchHit {
    pub id: String,
    pub downloads: Option<u64>,
    pub likes: Option<u64>,
    pub gated: bool,
    pub tags: Vec<String>,
    pub pipeline_tag: Option<String>,
}

#[tauri::command]
pub async fn hf_search_models(
    app: AppHandle,
    query: String,
    limit: Option<u32>,
) -> AppResult<Vec<HfSearchHit>> {
    let token = read_token_with_location(&app).map(|(t, _)| t);
    let mut req = reqwest::Client::new()
        .get("https://huggingface.co/api/models")
        .query(&[
            ("search", query.as_str()),
            ("limit", &limit.unwrap_or(20).to_string()),
            ("filter", "gguf"),
        ]);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let v: Value = req.send().await?.json().await?;
    let mut hits = vec![];
    if let Some(arr) = v.as_array() {
        for m in arr {
            hits.push(HfSearchHit {
                id: m.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                downloads: m.get("downloads").and_then(|x| x.as_u64()),
                likes: m.get("likes").and_then(|x| x.as_u64()),
                gated: m
                    .get("gated")
                    .map(|x| match x {
                        Value::Bool(b) => *b,
                        Value::String(s) => !s.is_empty() && s != "false",
                        _ => false,
                    })
                    .unwrap_or(false),
                tags: m
                    .get("tags")
                    .and_then(|x| x.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|t| t.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
                pipeline_tag: m
                    .get("pipeline_tag")
                    .and_then(|x| x.as_str())
                    .map(String::from),
            });
        }
    }
    Ok(hits)
}

#[derive(Debug, Deserialize)]
pub struct ImportRequest {
    pub repo: String,
    pub file: String,
    pub local_name: Option<String>,
}

/// Download a GGUF from HF and register it with Ollama via `ollama create`.
#[tauri::command]
pub async fn hf_import_gguf(
    app: tauri::AppHandle,
    request_id: String,
    request: ImportRequest,
) -> AppResult<String> {
    use tauri::Emitter;
    let token = read_token_with_location(&app).map(|(t, _)| t);

    let dir = std::env::temp_dir().join("pointer_hf_imports");
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(&request.file);

    let url = format!(
        "https://huggingface.co/{}/resolve/main/{}?download=true",
        request.repo, request.file
    );
    let mut req = reqwest::Client::new().get(&url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await?;
    if !resp.status().is_success() {
        return Err(AppError::Msg(format!(
            "HF download failed: HTTP {}",
            resp.status()
        )));
    }
    let total = resp.content_length();
    let mut stream = resp.bytes_stream();

    let evt = format!("hf:import:{}", request_id);
    let mut file = std::fs::File::create(&dest)?;
    use std::io::Write;
    use futures_util::StreamExt;
    let mut written: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        file.write_all(&bytes)?;
        written += bytes.len() as u64;
        let _ = app.emit(
            &evt,
            json!({"phase": "download", "written": written, "total": total}),
        );
    }
    drop(file);
    let _ = app.emit(&evt, json!({"phase": "download_done"}));

    // Build a Modelfile and run `ollama create`.
    let local_name = request.local_name.unwrap_or_else(|| {
        let stem = std::path::Path::new(&request.file)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "imported".into());
        stem.to_lowercase().replace(['.', '_'], "-")
    });

    let modelfile_path = dir.join(format!("{local_name}.Modelfile"));
    let content = format!("FROM {}\n", dest.display());
    std::fs::write(&modelfile_path, content)?;

    let _ = app.emit(&evt, json!({"phase": "ollama_create"}));
    let out = std::process::Command::new("ollama")
        .arg("create")
        .arg(&local_name)
        .arg("-f")
        .arg(&modelfile_path)
        .output()
        .map_err(|e| AppError::Msg(format!("ollama create spawn: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(AppError::Msg(format!("ollama create failed: {stderr}")));
    }
    let _ = app.emit(&evt, json!({"phase": "done", "model": local_name }));
    Ok(local_name)
}
