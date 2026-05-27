//! OpenCode runtime adapter for Pointer's Assistant surface.
//!
//! Pointer owns the UI, scheduling, cancellation, and event ledger. OpenCode is
//! the headless coding-agent runtime underneath Ask / Plan / Agent. We generate
//! an ephemeral config per run so the user's repository is not modified and so
//! Ollama remains the only model provider.

use crate::error::{AppError, AppResult};
use crate::services::inference::{acquire_inference, InferenceClaim, InferencePolicy};
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const OLLAMA_OPENAI_BASE: &str = "http://127.0.0.1:11434/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenCodeMode {
    Ask,
    Plan,
    Agent,
}

#[derive(Debug, Clone)]
pub struct OpenCodeRunRequest {
    pub request_id: String,
    pub model: String,
    pub workspace: String,
    pub prompt: String,
    pub mode: OpenCodeMode,
    pub title: String,
    pub max_steps: u32,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct OpenCodeRunOutput {
    pub text: String,
    pub session_id: Option<String>,
}

pub async fn run_opencode(
    app: AppHandle,
    state: &AppState,
    req: OpenCodeRunRequest,
) -> AppResult<OpenCodeRunOutput> {
    let kind = match req.mode {
        OpenCodeMode::Ask => "chat",
        OpenCodeMode::Plan => "planner",
        OpenCodeMode::Agent => "agent",
    };
    let _permit = acquire_inference(
        &app,
        state,
        InferenceClaim::new(
            req.request_id.clone(),
            req.model.clone(),
            kind,
            req.title.clone(),
        ),
        InferencePolicy::RejectBusy,
    )
    .await?;
    let mut cancel = state.cancels.lock().issue(&req.request_id);

    let workspace = if req.workspace.trim().is_empty() {
        std::env::current_dir().map_err(AppError::Io)?
    } else {
        PathBuf::from(req.workspace.trim())
    };
    let bin = resolve_opencode_bin()?;
    let runtime = prepare_runtime_dir(&req.model)?;
    let model_arg = opencode_model_arg(&req.model);
    let agent_name = match req.mode {
        OpenCodeMode::Ask => "pointer-ask",
        OpenCodeMode::Plan => "plan",
        OpenCodeMode::Agent => "build",
    };

    let mut cmd = Command::new(bin);
    cmd.current_dir(&workspace)
        .arg("run")
        .arg("--pure")
        .arg("--model")
        .arg(&model_arg)
        .arg("--agent")
        .arg(agent_name)
        .arg("--format")
        .arg("json")
        .arg("--title")
        .arg(&req.title)
        .arg(&req.prompt)
        .env("OPENCODE_CONFIG", runtime.config_path.as_os_str())
        .env("XDG_DATA_HOME", runtime.data_dir.as_os_str())
        .env("XDG_STATE_HOME", runtime.state_dir.as_os_str())
        .env("XDG_CACHE_HOME", runtime.cache_dir.as_os_str())
        .env("OPENAI_API_KEY", "pointer-local")
        .env("OLLAMA_API_KEY", "pointer-local")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for file in &req.files {
        let file = file.trim();
        if !file.is_empty() {
            cmd.arg(format!("--file={file}"));
        }
    }

    // In non-interactive agent mode opencode cannot round-trip a permission
    // dialog through Pointer yet. Ask and Plan run with mutating tools disabled
    // by their agent config; Agent uses opencode's build permissions.
    if req.mode == OpenCodeMode::Agent {
        cmd.arg("--dangerously-skip-permissions");
    }

    let mut child = cmd.spawn().map_err(|e| {
        AppError::Msg(format!(
            "failed to start opencode. Install with `npm install` or set POINTER_OPENCODE_BIN. {e}"
        ))
    })?;
    let _owned_process = child
        .id()
        .map(|pid| state.register_opencode_child(req.request_id.clone(), pid));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Msg("opencode stdout unavailable".into()))?;
    let stderr = child.stderr.take();
    if let Some(stderr) = stderr {
        let app_for_stderr = app.clone();
        let rid = req.request_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = strip_ansi(&line);
                if trimmed.trim().is_empty() {
                    continue;
                }
                let _ = app_for_stderr.emit(
                    &format!("agent:event:{rid}"),
                    json!({
                        "kind": "shell_progress",
                        "stream": "stderr",
                        "chunk": format!("{trimmed}\n"),
                    }),
                );
            }
        });
    }

    let start = Instant::now();
    let mut lines = BufReader::new(stdout).lines();
    let mut out = OpenCodeRunOutput::default();
    let mut text_since_tool = String::new();
    let mut step: u32 = 0;
    let mut saw_first_text = false;
    let mut last_error: Option<String> = None;
    let evt = format!("agent:event:{}", req.request_id);
    let chat_evt = format!("ollama:chat:{}", req.request_id);

    loop {
        tokio::select! {
            _ = cancel.recv() => {
                let _ = child.kill().await;
                emit_cancelled(&app, &req);
                cleanup_runtime_dir(&runtime.root);
                return Ok(out);
            }
            line = lines.next_line() => {
                let Some(line) = line.map_err(AppError::Io)? else { break; };
                let trimmed = strip_ansi(&line);
                if trimmed.trim().is_empty() {
                    continue;
                }
                let parsed: Value = match serde_json::from_str(&trimmed) {
                    Ok(v) => v,
                    Err(_) => {
                        if req.mode != OpenCodeMode::Ask {
                            let _ = app.emit(&evt, json!({
                                "kind": "shell_progress",
                                "stream": "stderr",
                                "chunk": format!("{trimmed}\n"),
                            }));
                        }
                        continue;
                    }
                };
                if let Some(session_id) = parsed.get("sessionID").and_then(|v| v.as_str()) {
                    out.session_id = Some(session_id.to_string());
                }
                match parsed.get("type").and_then(|v| v.as_str()).unwrap_or_default() {
                    "step_start" => {
                        step = step.saturating_add(1);
                        if req.mode != OpenCodeMode::Ask {
                            let _ = app.emit(&evt, json!({
                                "kind": "step_start",
                                "step": step,
                                "model": req.model,
                                "elapsed_ms": start.elapsed().as_millis() as u64,
                            }));
                        }
                    }
                    "text" => {
                        let text = parsed
                            .get("part")
                            .and_then(|p| p.get("text"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        if text.is_empty() {
                            continue;
                        }
                        out.text.push_str(text);
                        text_since_tool.push_str(text);
                        state.inference.note_tokens(&req.request_id, estimate_tokens(text));
                        match req.mode {
                            OpenCodeMode::Ask => {
                                let _ = app.emit(&chat_evt, json!({ "token": text }));
                            }
                            OpenCodeMode::Plan | OpenCodeMode::Agent => {
                                if !saw_first_text {
                                    saw_first_text = true;
                                    let _ = app.emit(&evt, json!({
                                        "kind": "first_token",
                                        "step": step.max(1),
                                        "warmup_ms": start.elapsed().as_millis() as u64,
                                    }));
                                }
                                let _ = app.emit(&evt, json!({
                                    "kind": "token",
                                    "step": step.max(1),
                                    "text": text,
                                }));
                            }
                        }
                    }
                    "tool_use" => {
                        text_since_tool.clear();
                        if req.mode != OpenCodeMode::Ask {
                            emit_tool_event(&app, &evt, step.max(1), &parsed);
                        }
                    }
                    "error" => {
                        let msg = parsed
                            .get("error")
                            .and_then(|e| e.get("data"))
                            .and_then(|d| d.get("message"))
                            .and_then(|v| v.as_str())
                            .or_else(|| parsed.get("error").and_then(|e| e.get("message")).and_then(|v| v.as_str()))
                            .unwrap_or("opencode error")
                            .to_string();
                        last_error = Some(msg.clone());
                        if req.mode == OpenCodeMode::Ask {
                            let _ = app.emit(&chat_evt, json!({ "error": msg, "done": true }));
                        } else {
                            let _ = app.emit(&evt, json!({ "kind": "error", "step": step.max(1), "text": msg }));
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let status = child.wait().await.map_err(AppError::Io)?;
    cleanup_runtime_dir(&runtime.root);
    if !status.success() {
        let msg = last_error.unwrap_or_else(|| format!("opencode exited with {status}"));
        if req.mode == OpenCodeMode::Ask {
            let _ = app.emit(&chat_evt, json!({ "error": msg, "done": true }));
        } else {
            let _ = app.emit(
                &evt,
                json!({ "kind": "error", "step": step.max(1), "text": msg }),
            );
            let _ = app.emit(&evt, json!({ "kind": "done", "termination": "error", "elapsed_ms": start.elapsed().as_millis() as u64 }));
        }
        return Err(AppError::Msg(msg));
    }

    match req.mode {
        OpenCodeMode::Ask => {
            let _ = app.emit(&chat_evt, json!({ "done": true }));
        }
        OpenCodeMode::Plan => {
            let plan_source = if text_since_tool.trim().is_empty() {
                &out.text
            } else {
                &text_since_tool
            };
            let plan = normalize_final_text(plan_source);
            let _ = app.emit(
                &evt,
                json!({ "kind": "plan", "step": step.max(1), "text": plan }),
            );
            let _ = app.emit(
                &evt,
                json!({ "kind": "final", "step": step.max(1), "text": plan }),
            );
            emit_snapshots(&app, &evt, &req, &plan);
            let _ = app.emit(&evt, json!({ "kind": "done", "termination": "final", "elapsed_ms": start.elapsed().as_millis() as u64 }));
        }
        OpenCodeMode::Agent => {
            let answer_source = if text_since_tool.trim().is_empty() {
                &out.text
            } else {
                &text_since_tool
            };
            let final_text = normalize_final_text(answer_source);
            let _ = app.emit(
                &evt,
                json!({ "kind": "final", "step": step.max(1), "text": final_text }),
            );
            emit_snapshots(&app, &evt, &req, &final_text);
            let _ = app.emit(&evt, json!({ "kind": "done", "termination": "final", "elapsed_ms": start.elapsed().as_millis() as u64 }));
        }
    }

    Ok(out)
}

fn emit_tool_event(app: &AppHandle, evt: &str, step: u32, parsed: &Value) {
    let Some(part) = parsed.get("part") else {
        return;
    };
    let tool = part
        .get("tool")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let state = part.get("state").unwrap_or(&Value::Null);
    let input = state.get("input").cloned().unwrap_or(Value::Null);
    let output = state
        .get("output")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let status = state
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("completed")
        .to_string();
    let attrs = attrs_from_input(&input);
    let args = serde_json::to_string_pretty(&input).unwrap_or_else(|_| "{}".into());

    let _ = app.emit(
        evt,
        json!({
            "kind": "tool_call",
            "step": step,
            "tool": tool,
            "attrs": attrs,
            "args": args,
        }),
    );
    let _ = app.emit(
        evt,
        json!({
            "kind": "tool_result",
            "step": step,
            "tool": tool,
            "status": if status == "completed" { "ok" } else { &status },
            "result": output,
            "extra": { "opencode": part },
        }),
    );
}

fn attrs_from_input(input: &Value) -> serde_json::Map<String, Value> {
    let mut attrs = serde_json::Map::new();
    if let Some(obj) = input.as_object() {
        for key in ["filePath", "path", "pattern", "command", "description"] {
            if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
                attrs.insert(key.to_string(), json!(v));
            }
        }
    }
    attrs
}

fn emit_snapshots(app: &AppHandle, evt: &str, req: &OpenCodeRunRequest, answer: &str) {
    let _ = app.emit(
        evt,
        json!({
            "kind": "transcript_snapshot",
            "messages": [
                { "role": "user", "content": req.prompt },
                { "role": "assistant", "content": answer }
            ],
        }),
    );
    let _ = app.emit(
        evt,
        json!({
            "kind": "ledger_snapshot",
            "entries": [],
        }),
    );
}

fn emit_cancelled(app: &AppHandle, req: &OpenCodeRunRequest) {
    match req.mode {
        OpenCodeMode::Ask => {
            let _ = app.emit(
                &format!("ollama:chat:{}", req.request_id),
                json!({ "cancelled": true, "done": true }),
            );
        }
        OpenCodeMode::Plan | OpenCodeMode::Agent => {
            let evt = format!("agent:event:{}", req.request_id);
            let _ = app.emit(&evt, json!({ "kind": "cancelled" }));
            let _ = app.emit(
                &evt,
                json!({ "kind": "done", "termination": "cancelled", "elapsed_ms": 0 }),
            );
        }
    }
}

struct RuntimeDir {
    root: PathBuf,
    config_path: PathBuf,
    data_dir: PathBuf,
    state_dir: PathBuf,
    cache_dir: PathBuf,
}

fn prepare_runtime_dir(model: &str) -> AppResult<RuntimeDir> {
    let root = std::env::temp_dir().join(format!("pointer-opencode-{}", uuid::Uuid::new_v4()));
    let data_dir = root.join("data");
    let state_dir = root.join("state");
    let cache_dir = root.join("cache");
    std::fs::create_dir_all(&data_dir).map_err(AppError::Io)?;
    std::fs::create_dir_all(&state_dir).map_err(AppError::Io)?;
    std::fs::create_dir_all(&cache_dir).map_err(AppError::Io)?;
    let config_path = root.join("opencode.json");
    let model_id = opencode_model_id(model);
    let model_arg = format!("ollama/{model_id}");
    let config = json!({
        "$schema": "https://opencode.ai/config.json",
        "model": model_arg,
        "small_model": model_arg,
        "share": "disabled",
        "autoupdate": false,
        "provider": {
            "ollama": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Ollama (local)",
                "options": { "baseURL": OLLAMA_OPENAI_BASE },
                "models": {
                    model_id.clone(): {
                        "name": model_id.clone(),
                        "limit": { "context": 32768, "output": 4096 }
                    }
                }
            }
        },
        "agent": {
            "pointer-ask": {
                "model": model_arg,
                "description": "Pointer Ask mode",
                "prompt": "Answer questions about the current codebase using read-only repository context. If the user asks about a named or attached file, read that file first and center the answer on that file rather than giving a broad repository overview. Include a compact Key identifiers sentence with exact identifiers, dotted method names, and configuration keys visible in the file. For object methods, preserve their dotted form such as app.handle or app.use. Do not modify files.",
                "tools": {
                    "edit": false,
                    "write": false,
                    "bash": false,
                    "task": false,
                    "webfetch": false,
                    "websearch": false
                }
            }
        },
    });
    std::fs::write(&config_path, serde_json::to_vec_pretty(&config)?).map_err(AppError::Io)?;
    Ok(RuntimeDir {
        root,
        config_path,
        data_dir,
        state_dir,
        cache_dir,
    })
}

fn cleanup_runtime_dir(path: &Path) {
    let _ = std::fs::remove_dir_all(path);
}

fn resolve_opencode_bin() -> AppResult<PathBuf> {
    if let Ok(p) = std::env::var("POINTER_OPENCODE_BIN") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Ok(path);
        }
    }

    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("node_modules/.bin/opencode"));
        candidates.push(cwd.join("../node_modules/.bin/opencode"));
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("../node_modules/.bin/opencode"));
    candidates.push(manifest.join("node_modules/.bin/opencode"));
    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    if let Some(path) = find_on_path("opencode") {
        return Ok(path);
    }
    Err(AppError::Msg(
        "opencode is required for Pointer assistant modes. Run `npm install` in the Pointer repo or install `opencode` on PATH.".into(),
    ))
}

fn find_on_path(bin: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(bin);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn opencode_model_id(model: &str) -> String {
    model
        .trim()
        .strip_prefix("ollama/")
        .unwrap_or_else(|| model.trim())
        .to_string()
}

fn opencode_model_arg(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.contains('/') {
        trimmed.to_string()
    } else {
        format!("ollama/{trimmed}")
    }
}

fn normalize_final_text(text: &str) -> String {
    text.trim().to_string()
}

fn estimate_tokens(text: &str) -> u64 {
    ((text.len() as u64) / 4).max(1)
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for n in chars.by_ref() {
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_arg_wraps_plain_ollama_model() {
        assert_eq!(
            opencode_model_arg("qwen3-coder:30b"),
            "ollama/qwen3-coder:30b"
        );
        assert_eq!(
            opencode_model_arg("ollama/qwen3-coder:30b"),
            "ollama/qwen3-coder:30b"
        );
    }

    #[test]
    fn strips_basic_ansi_sequences() {
        assert_eq!(strip_ansi("\u{1b}[91mError\u{1b}[0m"), "Error");
    }
}
