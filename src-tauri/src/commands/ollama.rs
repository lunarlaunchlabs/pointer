use crate::error::{AppError, AppResult};
use crate::services::inference::{acquire_inference, InferenceClaim, InferencePolicy};
use crate::state::AppState;
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Command;
use tauri::{AppHandle, Emitter, State};

const OLLAMA_BASE: &str = "http://127.0.0.1:11434";

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .pool_max_idle_per_host(8)
        .build()
        .expect("http client")
});

#[derive(Debug, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub base_url: String,
}

fn binary_exists(name: &str) -> bool {
    which_like(name).is_some()
}

fn which_like(name: &str) -> Option<String> {
    if let Ok(path) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path.split(sep) {
            let full = std::path::Path::new(dir).join(name);
            if full.is_file() {
                return Some(full.display().to_string());
            }
            #[cfg(windows)]
            {
                let exe = full.with_extension("exe");
                if exe.is_file() {
                    return Some(exe.display().to_string());
                }
            }
        }
    }
    // Common install locations
    for p in [
        "/usr/local/bin/ollama",
        "/opt/homebrew/bin/ollama",
        "/usr/bin/ollama",
        "/Applications/Ollama.app/Contents/Resources/ollama",
        "/Applications/Ollama.app/Contents/MacOS/Ollama",
    ] {
        if std::path::Path::new(p).is_file() {
            return Some(p.to_string());
        }
    }
    None
}

#[tauri::command]
pub async fn ollama_status() -> AppResult<OllamaStatus> {
    let installed = binary_exists("ollama") || which_like("ollama").is_some();
    let (running, version) = match HTTP
        .get(format!("{OLLAMA_BASE}/api/version"))
        .timeout(std::time::Duration::from_millis(1200))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            let v: Value = r.json().await.unwrap_or(json!({}));
            (
                true,
                v.get("version").and_then(|x| x.as_str()).map(String::from),
            )
        }
        _ => (false, None),
    };
    Ok(OllamaStatus {
        installed,
        running,
        version,
        base_url: OLLAMA_BASE.to_string(),
    })
}

#[tauri::command]
pub async fn ollama_install(app: AppHandle) -> AppResult<()> {
    let _ = app;
    #[cfg(target_os = "macos")]
    {
        // Prefer the official installer script if curl is present.
        let _ = Command::new("/bin/sh")
            .arg("-c")
            .arg("curl -fsSL https://ollama.com/install.sh | sh")
            .spawn()
            .map_err(|e| AppError::Msg(format!("install spawn: {e}")))?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("/bin/sh")
            .arg("-c")
            .arg("curl -fsSL https://ollama.com/install.sh | sh")
            .spawn()
            .map_err(|e| AppError::Msg(format!("install spawn: {e}")))?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        return Err(AppError::Msg(
            "Auto-install on Windows is not yet implemented. Please install Ollama from https://ollama.com/download.".into(),
        ));
    }
    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
pub async fn ollama_start(state: State<'_, AppState>) -> AppResult<()> {
    // If a daemon is already up — installed as a system service or launched
    // manually — we leave ownership with whoever started it. Pointer only
    // tears down children it spawned itself.
    if HTTP
        .get(format!("{OLLAMA_BASE}/api/version"))
        .timeout(std::time::Duration::from_millis(500))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
    {
        return Ok(());
    }

    if let Some(path) = which_like("ollama") {
        let child = Command::new(path)
            .arg("serve")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| AppError::Msg(format!("ollama serve: {e}")))?;
        log::info!("spawned Ollama child pid={}", child.id());
        *state.ollama_child.lock() = Some(child);
    } else {
        return Err(AppError::Msg(
            "Ollama binary not found. Install it first.".into(),
        ));
    }
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct OllamaStopResult {
    /// Whether the API is gone after the stop attempt.
    pub stopped: bool,
    /// True iff we took down a child we spawned ourselves.
    pub killed_owned: bool,
    /// PIDs of foreign `ollama serve` processes we SIGTERM'd / SIGKILL'd.
    pub killed_foreign_pids: Vec<u32>,
    /// True iff /api/version still answers after all our attempts. When this
    /// is true the UI surfaces a "couldn't stop" toast — almost always means
    /// Ollama is a launchd / system service that respawns immediately.
    pub still_running: bool,
}

/// Bring down the Ollama daemon — whether Pointer spawned it or not.
///
/// Order of operations:
///   1. Terminate any child we own. Cleanest path, no permission issues.
///   2. Scan `sysinfo` for foreign `ollama serve` processes and SIGTERM them.
///      This covers the "user ran `ollama serve` in a terminal" case and the
///      "Pointer was relaunched and lost its child handle" case.
///   3. Poll `/api/version` until it stops answering (or ~5s).
///   4. If anything is still alive, escalate to SIGKILL on the same PIDs and
///      poll once more.
///   5. Tell the UI what we did so it can show a precise message — including
///      "we couldn't stop it" when launchd respawns the process.
#[tauri::command]
pub async fn ollama_stop(state: State<'_, AppState>) -> AppResult<OllamaStopResult> {
    let killed_owned = state.ollama_child.lock().is_some();

    // Take down our own child first, off the async runtime — the old impl
    // blocked the executor for up to 2s which is what made the button "spin".
    // The parking_lot MutexGuard is not Send, so we deliberately scope the
    // `.take()` into its own block before any `.await`.
    let owned_child: Option<std::process::Child> = {
        let mut guard = state.ollama_child.lock();
        guard.take()
    };
    if let Some(child) = owned_child {
        tokio::task::spawn_blocking(move || shutdown_child(child))
            .await
            .ok();
    }

    // Scan for foreign `ollama serve` processes. We're intentionally narrow
    // here — only the daemon, not `ollama` CLI invocations that are pulling
    // a model or running a one-off `ollama run`.
    let foreign = find_ollama_serve_pids();
    let mut killed_foreign_pids: Vec<u32> = Vec::new();
    #[cfg(unix)]
    for pid in &foreign {
        unsafe {
            libc::kill(*pid as i32, libc::SIGTERM);
        }
        killed_foreign_pids.push(*pid);
    }
    #[cfg(not(unix))]
    for pid in &foreign {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string()])
            .status();
        killed_foreign_pids.push(*pid);
    }

    // Wait for the API to actually go away. We poll because SIGTERM can take
    // a moment to drain in-flight inference requests.
    let stopped = wait_for_api_down(std::time::Duration::from_secs(4)).await;

    // If it's still alive after SIGTERM, escalate to SIGKILL on the foreign
    // PIDs we found.
    let stopped = if stopped {
        true
    } else {
        #[cfg(unix)]
        for pid in &foreign {
            unsafe {
                libc::kill(*pid as i32, libc::SIGKILL);
            }
        }
        wait_for_api_down(std::time::Duration::from_secs(2)).await
    };

    let still_running = !stopped;
    if still_running {
        log::warn!(
            "ollama_stop: API still answering after kills. Foreign PIDs tried: {:?}. \
             Likely a launchd service or Docker container is respawning it.",
            killed_foreign_pids,
        );
    } else {
        log::info!(
            "ollama_stop: API down. killed_owned={killed_owned} foreign={:?}",
            killed_foreign_pids,
        );
    }

    Ok(OllamaStopResult {
        stopped,
        killed_owned,
        killed_foreign_pids,
        still_running,
    })
}

/// SIGTERM (then escalate to kill) a Child we own. Mirrors the logic in
/// `AppState::shutdown_ollama` but is callable from a blocking worker so the
/// async Tauri command doesn't stall the runtime.
fn shutdown_child(mut child: std::process::Child) {
    let pid = child.id();
    log::info!("shutting down owned Ollama child (pid {})", pid);
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(75)),
                Err(_) => break,
            }
        }
        let _ = child.kill();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// Look up running `ollama serve` PIDs without holding any of our own locks.
/// We use sysinfo (already pulled in for the system monitor).
fn find_ollama_serve_pids() -> Vec<u32> {
    use sysinfo::{ProcessRefreshKind, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::everything(),
    );

    let mut pids = Vec::new();
    for (pid, proc) in sys.processes() {
        let name = proc.name().to_string_lossy().to_lowercase();
        if !name.contains("ollama") {
            continue;
        }
        // Match either the macOS GUI helper (`Ollama`) running its daemon
        // mode, or `ollama serve` started from a shell. We deliberately skip
        // model runners (`ollama-runner`, `llama-server`) because killing the
        // serve parent already cleans them up.
        let cmd: Vec<String> = proc
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().to_string())
            .collect();
        let joined = cmd.join(" ").to_lowercase();
        let is_runner = joined.contains("runner") || joined.contains("llama-server");
        if is_runner {
            continue;
        }
        let is_serve = cmd.iter().any(|a| a == "serve")
            || joined.contains("ollama serve")
            || joined.contains("ollama.app");
        if is_serve || name == "ollama" {
            pids.push(pid.as_u32());
        }
    }
    pids
}

/// Poll /api/version until it stops answering, or the timeout elapses.
/// Returns true if the API is down.
async fn wait_for_api_down(timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        let alive = HTTP
            .get(format!("{OLLAMA_BASE}/api/version"))
            .timeout(std::time::Duration::from_millis(300))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if !alive {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    false
}

/// Drop a single model from VRAM/RAM without uninstalling it. We do this by
/// re-issuing a `/api/generate` with `keep_alive: 0`, which Ollama treats as
/// "unload now". This is the manual lever the system monitor exposes — the
/// file-ingestion path already passes keep_alive=0 on the request itself.
#[tauri::command]
pub async fn ollama_unload_model(model: String) -> AppResult<()> {
    let model = model.trim();
    if model.is_empty() {
        return Err(AppError::Msg("model name is empty".into()));
    }
    unload_model_name(model).await
}

pub async fn unload_models_by_name(models: Vec<String>) {
    for model in models {
        let model = normalize_ollama_model_name(&model);
        if model.is_empty() {
            continue;
        }
        if let Err(e) = unload_model_name(&model).await {
            log::warn!("failed to unload Ollama model `{model}` during shutdown: {e}");
        }
    }
}

async fn unload_model_name(model: &str) -> AppResult<()> {
    let resp = HTTP
        .post(format!("{OLLAMA_BASE}/api/generate"))
        .json(&json!({
            "model": model,
            "prompt": "",
            "keep_alive": 0,
            "stream": false,
        }))
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Msg(format!(
            "unload {model}: HTTP {status} — {body}"
        )));
    }
    Ok(())
}

fn normalize_ollama_model_name(model: &str) -> String {
    model
        .trim()
        .strip_prefix("ollama/")
        .unwrap_or(model.trim())
        .to_string()
}

#[derive(Debug, Serialize)]
pub struct LoadedModel {
    pub name: String,
    pub size_bytes: u64,
    /// "gpu", "cpu", or "mixed" — derived from Ollama's `size_vram` vs `size`.
    pub processor: String,
    /// ISO timestamp at which Ollama will unload this model if untouched.
    pub expires_at: Option<String>,
}

/// Hit Ollama's `/api/ps` and translate to the shape the System Monitor needs.
/// This is the only reliable way to know what's actually loaded in memory —
/// `sysinfo` sees the runner processes but not their model identity.
#[tauri::command]
pub async fn ollama_ps() -> AppResult<Vec<LoadedModel>> {
    let resp = HTTP
        .get(format!("{OLLAMA_BASE}/api/ps"))
        .timeout(std::time::Duration::from_millis(1500))
        .send()
        .await;
    let resp = match resp {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(vec![]),
    };
    let v: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Ok(vec![]),
    };
    let arr = v
        .get("models")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for m in arr {
        let name = m
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let size_total = m.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
        let size_vram = m.get("size_vram").and_then(|x| x.as_u64()).unwrap_or(0);
        let processor = if size_vram == 0 {
            "cpu"
        } else if size_vram >= size_total {
            "gpu"
        } else {
            "mixed"
        }
        .to_string();
        let expires_at = m
            .get("expires_at")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        out.push(LoadedModel {
            name,
            size_bytes: size_total,
            processor,
            expires_at,
        });
    }
    Ok(out)
}

/// Delete a model from the local Ollama store. Requires the daemon to be
/// running; the API call frees the disk blobs and the manifest.
#[tauri::command]
pub async fn ollama_delete_model(model: String) -> AppResult<()> {
    let model = model.trim();
    if model.is_empty() {
        return Err(AppError::Msg("model name is empty".into()));
    }
    let resp = HTTP
        .delete(format!("{OLLAMA_BASE}/api/delete"))
        .json(&json!({ "name": model }))
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Msg(format!(
            "delete {model}: HTTP {status} — {body}",
        )));
    }
    log::info!("deleted model {model}");
    Ok(())
}

/// Step-by-step uninstall report so the UI can show which parts actually
/// succeeded — many of these require user-mode permissions on the path.
#[derive(Debug, Serialize)]
pub struct UninstallStep {
    pub label: String,
    pub path: Option<String>,
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UninstallReport {
    pub steps: Vec<UninstallStep>,
}

/// Wipe Ollama from disk: stop the daemon, optionally remove the local model
/// store, and remove the binary + macOS app bundle. We never use sudo; any
/// path we can't write to is reported back so the UI can suggest a Terminal
/// command for the user to finish manually.
#[tauri::command]
pub async fn ollama_uninstall(
    state: State<'_, AppState>,
    purge_models: bool,
) -> AppResult<UninstallReport> {
    let mut steps: Vec<UninstallStep> = Vec::new();

    // 1. Stop any owned daemon. shutdown_ollama is idempotent.
    state.shutdown_ollama();
    steps.push(UninstallStep {
        label: "stopped owned daemon".into(),
        path: None,
        ok: true,
        message: None,
    });

    // 2. SIGTERM any other running ollama processes. Best-effort; pkill may
    //    not exist on every distro but it exists on macOS and most Linuxes.
    #[cfg(unix)]
    {
        let killed = std::process::Command::new("pkill")
            .arg("-x")
            .arg("ollama")
            .status();
        match killed {
            Ok(s) => steps.push(UninstallStep {
                label: "pkill -x ollama".into(),
                path: None,
                ok: s.success() || s.code() == Some(1), // 1 == no processes matched
                message: Some(format!("exit {}", s.code().unwrap_or(-1))),
            }),
            Err(e) => steps.push(UninstallStep {
                label: "pkill -x ollama".into(),
                path: None,
                ok: false,
                message: Some(e.to_string()),
            }),
        }
    }

    // 3. Optionally remove the local model store (~/.ollama).
    if purge_models {
        let home = home_dir();
        let model_dir = home.as_ref().map(|h| h.join(".ollama"));
        if let Some(p) = model_dir {
            steps.push(remove_path(&p, "remove ~/.ollama"));
        } else {
            steps.push(UninstallStep {
                label: "remove ~/.ollama".into(),
                path: None,
                ok: false,
                message: Some("could not resolve $HOME".into()),
            });
        }
    }

    // 4. Remove the binary if we can find it on PATH.
    if let Some(binary) = which_like("ollama") {
        steps.push(remove_path(
            std::path::Path::new(&binary),
            "remove ollama binary",
        ));
    }

    // 5. macOS app bundle, if present.
    #[cfg(target_os = "macos")]
    {
        let p = std::path::Path::new("/Applications/Ollama.app");
        if p.exists() {
            steps.push(remove_path(p, "remove Ollama.app"));
        }
    }

    // 6. Linux systemd unit (best-effort).
    #[cfg(target_os = "linux")]
    {
        let p = std::path::Path::new("/etc/systemd/system/ollama.service");
        if p.exists() {
            steps.push(remove_path(p, "remove ollama.service"));
        }
    }

    Ok(UninstallReport { steps })
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

fn remove_path(p: &std::path::Path, label: &str) -> UninstallStep {
    let path_str = p.display().to_string();
    if !p.exists() {
        return UninstallStep {
            label: label.into(),
            path: Some(path_str),
            ok: true,
            message: Some("nothing to remove".into()),
        };
    }
    let res = if p.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    };
    match res {
        Ok(()) => UninstallStep {
            label: label.into(),
            path: Some(path_str),
            ok: true,
            message: None,
        },
        Err(e) => UninstallStep {
            label: label.into(),
            path: Some(path_str),
            ok: false,
            message: Some(e.to_string()),
        },
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
}

#[tauri::command]
pub async fn ollama_list_models() -> AppResult<Vec<OllamaModel>> {
    let r = HTTP.get(format!("{OLLAMA_BASE}/api/tags")).send().await?;
    let v: Value = r.json().await?;
    let mut models = vec![];
    if let Some(arr) = v.get("models").and_then(|x| x.as_array()) {
        for m in arr {
            models.push(OllamaModel {
                name: m
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                size: m.get("size").and_then(|x| x.as_u64()),
                modified_at: m
                    .get("modified_at")
                    .and_then(|x| x.as_str())
                    .map(String::from),
            });
        }
    }
    Ok(models)
}

#[tauri::command]
pub async fn ollama_pull(app: AppHandle, model: String, request_id: String) -> AppResult<()> {
    let resp = HTTP
        .post(format!("{OLLAMA_BASE}/api/pull"))
        .json(&json!({ "name": model, "stream": true }))
        .send()
        .await?;
    let mut stream = resp.bytes_stream();
    let evt = format!("ollama:pull:{}", request_id);
    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        for line in bytes.split(|&b| b == b'\n') {
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                let _ = app.emit(&evt, v);
            }
        }
    }
    let _ = app.emit(&evt, json!({ "status": "done" }));
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMsg>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub num_ctx: Option<u32>,
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[tauri::command]
pub async fn ollama_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    request: ChatRequest,
) -> AppResult<()> {
    let permit = acquire_inference(
        &app,
        &state,
        InferenceClaim::new(
            request_id.clone(),
            request.model.clone(),
            request.purpose.clone().unwrap_or_else(|| "chat".into()),
            request
                .title
                .clone()
                .unwrap_or_else(|| "Assistant chat".into()),
        ),
        InferencePolicy::RejectBusy,
    )
    .await?;
    let mut cancel = state.cancels.lock().issue(&request_id);
    let mut messages: Vec<Value> = vec![];
    if let Some(sys) = &request.system {
        messages.push(json!({ "role": "system", "content": sys }));
    }
    for m in &request.messages {
        messages.push(json!({ "role": m.role, "content": m.content }));
    }

    let mut options = serde_json::Map::new();
    if let Some(t) = request.temperature {
        options.insert("temperature".into(), json!(t));
    }
    if let Some(n) = request.num_ctx {
        options.insert("num_ctx".into(), json!(n));
    }

    let body = json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
        "options": options,
    });

    let resp = HTTP
        .post(format!("{OLLAMA_BASE}/api/chat"))
        .json(&body)
        .send()
        .await?;
    let evt = format!("ollama:chat:{}", request_id);

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = app.emit(
            &evt,
            json!({ "error": format!("HTTP {}: {}", status, text), "done": true }),
        );
        state.cancels.lock().clear(&request_id);
        return Err(AppError::Msg(format!("ollama chat error {status}")));
    }

    let mut stream = resp.bytes_stream();
    loop {
        tokio::select! {
            _ = cancel.recv() => {
                let _ = app.emit(&evt, json!({ "cancelled": true, "done": true }));
                break;
            }
            next = stream.next() => {
                match next {
                    None => {
                        let _ = app.emit(&evt, json!({ "done": true }));
                        break;
                    }
                    Some(Err(e)) => {
                        let _ = app.emit(&evt, json!({ "error": e.to_string(), "done": true }));
                        break;
                    }
                    Some(Ok(bytes)) => {
                        for line in bytes.split(|&b| b == b'\n') {
                            if line.is_empty() { continue; }
                            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                                let token = v.get("message")
                                    .and_then(|m| m.get("content"))
                                    .and_then(|c| c.as_str())
                                    .unwrap_or("");
                                let done = v.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
                                if !token.is_empty() {
                                    permit.note_tokens(1);
                                    let _ = app.emit(&evt, json!({"token": token}));
                                }
                                if done {
                                    let _ = app.emit(&evt, json!({"done": true, "stats": v}));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    state.cancels.lock().clear(&request_id);
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct GenerateRequest {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub stop: Option<Vec<String>>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub num_predict: Option<u32>,
    #[serde(default)]
    pub raw: Option<bool>,
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[tauri::command]
pub async fn ollama_generate(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    request: GenerateRequest,
) -> AppResult<()> {
    let permit = acquire_inference(
        &app,
        &state,
        InferenceClaim::new(
            request_id.clone(),
            request.model.clone(),
            request
                .purpose
                .clone()
                .unwrap_or_else(|| "generation".into()),
            request
                .title
                .clone()
                .unwrap_or_else(|| "Text generation".into()),
        ),
        InferencePolicy::RejectBusy,
    )
    .await?;
    let mut cancel = state.cancels.lock().issue(&request_id);
    let mut options = serde_json::Map::new();
    if let Some(t) = request.temperature {
        options.insert("temperature".into(), json!(t));
    }
    if let Some(n) = request.num_predict {
        options.insert("num_predict".into(), json!(n));
    }
    if let Some(stop) = &request.stop {
        options.insert("stop".into(), json!(stop));
    }
    let body = json!({
        "model": request.model,
        "prompt": request.prompt,
        "system": request.system,
        "raw": request.raw.unwrap_or(false),
        "stream": true,
        "options": options,
    });
    let resp = HTTP
        .post(format!("{OLLAMA_BASE}/api/generate"))
        .json(&body)
        .send()
        .await?;
    let evt = format!("ollama:gen:{}", request_id);
    if !resp.status().is_success() {
        let status = resp.status();
        let _ = app.emit(
            &evt,
            json!({ "error": format!("HTTP {}", status), "done": true }),
        );
        state.cancels.lock().clear(&request_id);
        return Err(AppError::Msg(format!("ollama generate error {status}")));
    }
    let mut stream = resp.bytes_stream();
    loop {
        tokio::select! {
            _ = cancel.recv() => {
                let _ = app.emit(&evt, json!({ "cancelled": true, "done": true }));
                break;
            }
            next = stream.next() => {
                match next {
                    None => { let _ = app.emit(&evt, json!({"done": true})); break; }
                    Some(Err(e)) => { let _ = app.emit(&evt, json!({"error": e.to_string(), "done": true})); break; }
                    Some(Ok(bytes)) => {
                        for line in bytes.split(|&b| b == b'\n') {
                            if line.is_empty() { continue; }
                            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                                let token = v.get("response").and_then(|c| c.as_str()).unwrap_or("");
                                let done = v.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
                                if !token.is_empty() {
                                    permit.note_tokens(1);
                                    let _ = app.emit(&evt, json!({"token": token}));
                                }
                                if done { let _ = app.emit(&evt, json!({"done": true, "stats": v})); }
                            }
                        }
                    }
                }
            }
        }
    }
    state.cancels.lock().clear(&request_id);
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct FimRequest {
    pub model: String,
    pub prefix: String,
    pub suffix: String,
    #[serde(default)]
    pub num_predict: Option<u32>,
    #[serde(default)]
    pub stop: Option<Vec<String>>,
}

#[tauri::command]
pub async fn ollama_fim(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    request: FimRequest,
) -> AppResult<String> {
    let permit = acquire_inference(
        &app,
        &state,
        InferenceClaim::new(
            request_id.clone(),
            request.model.clone(),
            "inline_suggestion",
            "Tab completion",
        )
        .interruptible(),
        InferencePolicy::ReplaceMatchingInterruptible,
    )
    .await?;
    let mut cancel = state.cancels.lock().issue(&request_id);
    // Qwen2.5-Coder FIM template.
    let prompt = format!(
        "<|fim_prefix|>{}<|fim_suffix|>{}<|fim_middle|>",
        request.prefix, request.suffix
    );
    let mut stop = vec![
        "<|fim_prefix|>".to_string(),
        "<|fim_suffix|>".to_string(),
        "<|fim_middle|>".to_string(),
        "<|endoftext|>".to_string(),
        "<|file_sep|>".to_string(),
        "<|im_end|>".to_string(),
    ];
    if let Some(extra) = request.stop {
        stop.extend(extra);
    }
    let body = json!({
        "model": request.model,
        "prompt": prompt,
        "raw": true,
        "stream": true,
        "options": {
            "temperature": 0.2,
            "num_predict": request.num_predict.unwrap_or(96),
            "stop": stop,
        },
    });
    let resp = HTTP
        .post(format!("{OLLAMA_BASE}/api/generate"))
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        state.cancels.lock().clear(&request_id);
        return Err(AppError::Msg(format!("FIM HTTP {}", resp.status())));
    }
    let mut out = String::new();
    let mut stream = resp.bytes_stream();
    loop {
        tokio::select! {
            _ = cancel.recv() => break,
            next = stream.next() => {
                match next {
                    None => break,
                    Some(Err(e)) => { state.cancels.lock().clear(&request_id); return Err(AppError::Msg(e.to_string())); }
                    Some(Ok(bytes)) => {
                        for line in bytes.split(|&b| b == b'\n') {
                            if line.is_empty() { continue; }
                            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                                if let Some(tok) = v.get("response").and_then(|x| x.as_str()) {
                                    if !tok.is_empty() {
                                        permit.note_tokens(1);
                                    }
                                    out.push_str(tok);
                                }
                                if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                                    state.cancels.lock().clear(&request_id);
                                    return Ok(out);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    state.cancels.lock().clear(&request_id);
    Ok(out)
}

#[tauri::command]
pub async fn ollama_embed(
    app: AppHandle,
    state: State<'_, AppState>,
    model: String,
    input: Vec<String>,
) -> AppResult<Vec<Vec<f32>>> {
    let request_id = format!("embed_{}", uuid::Uuid::new_v4().simple());
    let _permit = acquire_inference(
        &app,
        &state,
        InferenceClaim::new(
            request_id,
            model.clone(),
            "embedding",
            format!(
                "Embedding {} input{}",
                input.len(),
                if input.len() == 1 { "" } else { "s" }
            ),
        )
        .non_cancellable(),
        InferencePolicy::RejectBusy,
    )
    .await?;
    let resp = HTTP
        .post(format!("{OLLAMA_BASE}/api/embed"))
        .json(&json!({ "model": model, "input": input }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::Msg(format!("embed HTTP {}", resp.status())));
    }
    let v: Value = resp.json().await?;
    let mut out = Vec::new();
    if let Some(arr) = v.get("embeddings").and_then(|x| x.as_array()) {
        for emb in arr {
            if let Some(nums) = emb.as_array() {
                out.push(
                    nums.iter()
                        .map(|n| n.as_f64().unwrap_or(0.0) as f32)
                        .collect(),
                );
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn ollama_cancel(state: State<'_, AppState>, request_id: String) -> AppResult<bool> {
    Ok(state.cancels.lock().cancel(&request_id))
}
