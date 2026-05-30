//! OpenCode runtime adapter for Pointer's Assistant surface.
//!
//! Pointer owns the UI, scheduling, cancellation, and event ledger. OpenCode is
//! the headless coding-agent runtime underneath Ask / Plan / Agent. We generate
//! a Pointer-owned config so the user's repository is not modified and so
//! Ollama remains the only model provider. OpenCode's data/state/cache live
//! under Pointer app data so session memory can survive follow-up turns.

use crate::commands::agent_changes;
use crate::error::{AppError, AppResult};
use crate::services::inference::{acquire_inference, InferenceClaim, InferencePolicy};
use crate::state::AppState;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;

const OLLAMA_OPENAI_BASE: &str = "http://127.0.0.1:11434/v1";
const OLLAMA_DIRECT_BASE: &str = "http://127.0.0.1:11434";
const CHANGE_SNAPSHOT_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const CHANGE_SNAPSHOT_MAX_TOTAL_BYTES: u64 = 96 * 1024 * 1024;
const PROCESS_TAIL_LIMIT: usize = 8_000;
const DIRECT_PATCH_MAX_CONTEXT_BYTES: usize = 92_000;
const DIRECT_PATCH_MAX_FILE_BYTES: usize = 24_000;

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
    pub files: Vec<String>,
    pub opencode_session_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct OpenCodeRunOutput {
    pub text: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct BashRecord {
    command: String,
    status: String,
    output: String,
}

#[derive(Default)]
struct WorkspaceSnapshot {
    files: HashMap<String, Vec<u8>>,
    truncated: bool,
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

    if req.workspace.trim().is_empty() {
        return Err(AppError::Msg(
            "No workspace is open for this OpenCode run.".into(),
        ));
    }
    let workspace = PathBuf::from(req.workspace.trim());
    let workspace = std::fs::canonicalize(&workspace).unwrap_or(workspace);
    let bin = resolve_opencode_bin()?;
    let runtime = prepare_runtime_dir(&app, &req.model)?;
    let model_arg = opencode_model_arg(&req.model);
    let agent_name = match req.mode {
        OpenCodeMode::Ask => "pointer-ask",
        OpenCodeMode::Plan => "pointer-plan",
        OpenCodeMode::Agent => "pointer-agent",
    };
    let before_snapshot = if req.mode == OpenCodeMode::Agent {
        Some(snapshot_workspace(&workspace))
    } else {
        None
    };

    let mut cmd = Command::new(bin);
    cmd.current_dir(&workspace)
        .arg("run")
        .arg("--pure")
        .arg("--dir")
        .arg(&workspace)
        .arg("--model")
        .arg(&model_arg);
    if let Some(variant) = opencode_variant(&req.mode) {
        cmd.arg("--variant").arg(variant);
    }
    cmd.arg("--agent")
        .arg(agent_name)
        .arg("--format")
        .arg("json")
        .arg("--title")
        .arg(&req.title)
        .env("OPENCODE_CONFIG", runtime.config_path.as_os_str())
        .env("XDG_DATA_HOME", runtime.data_dir.as_os_str())
        .env("XDG_STATE_HOME", runtime.state_dir.as_os_str())
        .env("XDG_CACHE_HOME", runtime.cache_dir.as_os_str())
        .env("OPENAI_API_KEY", "pointer-local")
        .env("OLLAMA_API_KEY", "pointer-local")
        .env("OLLAMA_CONTEXT_LENGTH", "32768")
        .env("OLLAMA_NUM_PARALLEL", "1")
        .env("OPENCODE_DISABLE_EXTERNAL_SKILLS", "1")
        .env("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(session_id) = req
        .opencode_session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cmd.arg("--session").arg(session_id);
    }
    cmd.arg(&req.prompt);

    for file in &req.files {
        let file = file.trim();
        if !file.is_empty() {
            if req.mode == OpenCodeMode::Ask && req.prompt.contains("<file path=") {
                continue;
            }
            let Some(file_arg) = opencode_file_arg(&workspace, file) else {
                continue;
            };
            if req.mode != OpenCodeMode::Agent && is_large_workspace_file(&workspace, &file_arg) {
                continue;
            }
            cmd.arg(format!("--file={file_arg}"));
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
    let process_tail = Arc::new(Mutex::new(String::new()));
    let stderr = child.stderr.take();
    if let Some(stderr) = stderr {
        let app_for_stderr = app.clone();
        let rid = req.request_id.clone();
        let process_tail = process_tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = strip_ansi(&line);
                if trimmed.trim().is_empty() {
                    continue;
                }
                {
                    let mut tail = process_tail.lock().await;
                    append_process_tail(&mut tail, &trimmed);
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
    let mut bash_records: Vec<BashRecord> = Vec::new();
    let mut saw_agent_mutation = false;
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
                        {
                            let mut tail = process_tail.lock().await;
                            append_process_tail(&mut tail, &trimmed);
                        }
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
                        let tool_name = opencode_tool_name(&parsed);
                        let tool_status = opencode_tool_status(&parsed);
                        if req.mode == OpenCodeMode::Agent
                            && tool_status == "completed"
                            && is_mutating_opencode_tool(tool_name)
                        {
                            saw_agent_mutation = true;
                        }
                        if tool_name == "bash" {
                            bash_records.push(BashRecord {
                                command: parsed
                                    .get("part")
                                    .and_then(|p| p.get("state"))
                                    .and_then(|s| s.get("input"))
                                    .and_then(|i| i.get("command"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .to_string(),
                                status: tool_status.to_string(),
                                output: parsed
                                    .get("part")
                                    .and_then(|p| p.get("state"))
                                    .and_then(|s| s.get("output"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .to_string(),
                            });
                        }
                        if req.mode != OpenCodeMode::Ask {
                            emit_tool_event(&app, &evt, step.max(1), &workspace, &parsed);
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
    let mut direct_fallback_final: Option<String> = None;
    if !status.success() {
        let tail = process_tail.lock().await.clone();
        let msg = last_error.unwrap_or_else(|| opencode_exit_message(status, &tail));
        if req.mode == OpenCodeMode::Agent && !saw_agent_mutation {
            if let Some(before) = before_snapshot.as_ref() {
                let after_failure = snapshot_workspace(&workspace);
                if workspace_snapshot_changed(before, &after_failure) {
                    let summary = "OpenCode changed files but exited with an error. Pointer captured the resulting diff for review.".to_string();
                    direct_fallback_final = Some(summary.clone());
                    out.text.push_str("\n\n");
                    out.text.push_str(&summary);
                } else {
                    match run_direct_ollama_patch_fallback(
                        &app,
                        state,
                        &req,
                        &workspace,
                        before,
                        &msg,
                        &evt,
                        step.max(1),
                        &mut cancel,
                    )
                    .await
                    {
                        Ok(Some(summary)) => {
                            direct_fallback_final = Some(summary.clone());
                            out.text.push_str("\n\n");
                            out.text.push_str(&summary);
                        }
                        Ok(None) => {
                            let _ = app.emit(
                                &evt,
                                json!({ "kind": "error", "step": step.max(1), "text": msg }),
                            );
                            let _ = app.emit(&evt, json!({ "kind": "done", "termination": "error", "elapsed_ms": start.elapsed().as_millis() as u64 }));
                            return Err(AppError::Msg(msg));
                        }
                        Err(error) => {
                            let text = format!("{msg}\n\nDirect Ollama fallback failed: {error}");
                            let _ = app.emit(
                                &evt,
                                json!({ "kind": "error", "step": step.max(1), "text": text }),
                            );
                            let _ = app.emit(&evt, json!({ "kind": "done", "termination": "error", "elapsed_ms": start.elapsed().as_millis() as u64 }));
                            return Err(AppError::Msg(text));
                        }
                    }
                }
            } else {
                let _ = app.emit(
                    &evt,
                    json!({ "kind": "error", "step": step.max(1), "text": msg }),
                );
                let _ = app.emit(&evt, json!({ "kind": "done", "termination": "error", "elapsed_ms": start.elapsed().as_millis() as u64 }));
                return Err(AppError::Msg(msg));
            }
        } else if req.mode == OpenCodeMode::Ask {
            let _ = app.emit(&chat_evt, json!({ "error": msg, "done": true }));
            return Err(AppError::Msg(msg));
        } else {
            let _ = app.emit(
                &evt,
                json!({ "kind": "error", "step": step.max(1), "text": msg }),
            );
            let _ = app.emit(&evt, json!({ "kind": "done", "termination": "error", "elapsed_ms": start.elapsed().as_millis() as u64 }));
            return Err(AppError::Msg(msg));
        }
    }

    let change_records = if req.mode == OpenCodeMode::Agent {
        if let Some(before) = before_snapshot.as_ref() {
            let mut after = snapshot_workspace(&workspace);
            let structural = run_structural_integration_fallback(
                &workspace,
                before,
                &after,
                &req.prompt,
                &req.files,
            )?;
            if !structural.is_empty() {
                let _ = app.emit(
                    &evt,
                    json!({
                        "kind": "tool_result",
                        "step": step.max(1),
                        "tool": "pointer_supervisor",
                        "status": "ok",
                        "result": format!(
                            "Structural integration completed {} file update{}",
                            structural.len(),
                            if structural.len() == 1 { "" } else { "s" }
                        ),
                        "extra": {
                            "reason": "deterministic_structural_integration",
                            "applied": structural,
                        },
                    }),
                );
                after = snapshot_workspace(&workspace);
            }
            let records = record_workspace_changes(&app, step.max(1), &workspace, before, &after)?;
            emit_change_records(
                &app,
                &evt,
                step.max(1),
                &records,
                before.truncated || after.truncated,
            );
            records
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    if req.mode == OpenCodeMode::Agent
        && (!change_records.is_empty() || saw_agent_mutation)
        && !bash_records
            .iter()
            .any(|record| !record.command.trim().is_empty())
    {
        if let Some(record) = run_deterministic_verification_fallback(&app, &evt, &workspace).await
        {
            bash_records.push(record);
        }
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
            let plan = sanitize_verification_claims(
                &sanitize_workspace_paths(&normalize_final_text(plan_source), &workspace),
                &bash_records,
            );
            let _ = app.emit(
                &evt,
                json!({ "kind": "plan", "step": step.max(1), "text": plan }),
            );
            let _ = app.emit(
                &evt,
                json!({ "kind": "final", "step": step.max(1), "text": plan }),
            );
            emit_snapshots(&app, &evt, &req, &plan, out.session_id.as_deref());
            let _ = app.emit(&evt, json!({ "kind": "done", "termination": "final", "elapsed_ms": start.elapsed().as_millis() as u64 }));
        }
        OpenCodeMode::Agent => {
            let answer_source = if let Some(fallback) = direct_fallback_final.as_deref() {
                fallback
            } else if text_since_tool.trim().is_empty() {
                &out.text
            } else {
                &text_since_tool
            };
            let final_text = ensure_verification_status(
                &sanitize_verification_claims(
                    &sanitize_workspace_paths(&normalize_final_text(answer_source), &workspace),
                    &bash_records,
                ),
                &bash_records,
            );
            let _ = app.emit(
                &evt,
                json!({ "kind": "final", "step": step.max(1), "text": final_text }),
            );
            emit_snapshots(&app, &evt, &req, &final_text, out.session_id.as_deref());
            let _ = app.emit(&evt, json!({ "kind": "done", "termination": "final", "elapsed_ms": start.elapsed().as_millis() as u64 }));
        }
    }

    Ok(out)
}

fn append_process_tail(tail: &mut String, line: &str) {
    tail.push_str(line.trim_end());
    tail.push('\n');
    if tail.len() > PROCESS_TAIL_LIMIT {
        *tail = tail
            .chars()
            .rev()
            .take(PROCESS_TAIL_LIMIT)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }
}

fn opencode_exit_message(status: ExitStatus, tail: &str) -> String {
    let tail = tail.trim();
    if tail.is_empty() {
        format!("opencode exited with {status}")
    } else {
        format!("opencode exited with {status}\n\n{tail}")
    }
}

fn emit_tool_event(app: &AppHandle, evt: &str, step: u32, workspace: &Path, parsed: &Value) {
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
    let attrs = attrs_from_input(&input, workspace);
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

fn opencode_tool_name(parsed: &Value) -> &str {
    parsed
        .get("part")
        .and_then(|p| p.get("tool"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
}

fn opencode_tool_status(parsed: &Value) -> &str {
    parsed
        .get("part")
        .and_then(|p| p.get("state"))
        .and_then(|s| s.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
}

fn is_mutating_opencode_tool(tool: &str) -> bool {
    matches!(
        tool,
        "edit"
            | "write"
            | "patch"
            | "apply_patch"
            | "apply_diff"
            | "rename"
            | "delete"
            | "move"
            | "todowrite"
    )
}

fn snapshot_workspace(root: &Path) -> WorkspaceSnapshot {
    let mut snapshot = WorkspaceSnapshot::default();
    let mut total = 0u64;
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| {
            if entry.path() == root {
                return true;
            }
            !(entry.file_type().is_dir() && should_skip_snapshot_dir(entry.path(), root))
        })
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if entry.file_type().is_dir() {
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if should_skip_snapshot_path(path, root) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() > CHANGE_SNAPSHOT_MAX_FILE_BYTES {
            snapshot.truncated = true;
            continue;
        }
        if total.saturating_add(metadata.len()) > CHANGE_SNAPSHOT_MAX_TOTAL_BYTES {
            snapshot.truncated = true;
            break;
        }
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        if bytes.len() as u64 != metadata.len() {
            continue;
        }
        if is_probably_binary(&bytes) {
            snapshot.truncated = true;
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .ok()
            .map(|p| normalize_rel_path(p))
            .unwrap_or_else(|| path.display().to_string());
        total = total.saturating_add(bytes.len() as u64);
        snapshot.files.insert(rel, bytes);
    }
    snapshot
}

fn should_skip_snapshot_dir(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    rel.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        matches!(
            name.as_ref(),
            ".git"
                | "node_modules"
                | "dist"
                | "build"
                | "target"
                | "coverage"
                | ".next"
                | ".nuxt"
                | ".svelte-kit"
                | ".turbo"
                | ".cache"
                | "vendor"
                | "Pods"
                | "DerivedData"
        )
    })
}

fn should_skip_snapshot_path(path: &Path, root: &Path) -> bool {
    if should_skip_snapshot_dir(path.parent().unwrap_or(root), root) {
        return true;
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    matches!(
        name,
        "package-lock.json"
            | "pnpm-lock.yaml"
            | "yarn.lock"
            | "bun.lockb"
            | "Cargo.lock"
            | ".DS_Store"
    )
}

fn is_probably_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

fn normalize_rel_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn record_workspace_changes(
    app: &AppHandle,
    step: u32,
    workspace: &Path,
    before: &WorkspaceSnapshot,
    after: &WorkspaceSnapshot,
) -> AppResult<Vec<agent_changes::FileChangeRecord>> {
    let mut paths = before
        .files
        .keys()
        .chain(after.files.keys())
        .cloned()
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    let mut records = Vec::new();
    for path in paths.into_iter().take(80) {
        match (before.files.get(&path), after.files.get(&path)) {
            (None, Some(after_bytes)) => {
                records.push(agent_changes::record_create(app, step, &path, after_bytes)?);
            }
            (Some(before_bytes), None) => {
                records.push(agent_changes::record_delete(
                    app,
                    step,
                    &path,
                    before_bytes,
                )?);
            }
            (Some(before_bytes), Some(after_bytes)) if before_bytes != after_bytes => {
                if let Some(record) =
                    agent_changes::record_modify(app, step, &path, before_bytes, after_bytes)?
                {
                    records.push(record);
                }
            }
            _ => {}
        }
    }
    if records.is_empty() {
        // If OpenCode wrote a new file in a directory we skipped because it
        // looked generated, there is deliberately nothing to review. Keeping
        // this branch explicit makes that tradeoff visible in code review.
        let _ = workspace;
    }
    Ok(records)
}

fn workspace_snapshot_changed(before: &WorkspaceSnapshot, after: &WorkspaceSnapshot) -> bool {
    if before.files.len() != after.files.len() {
        return true;
    }
    before
        .files
        .iter()
        .any(|(path, bytes)| after.files.get(path) != Some(bytes))
}

#[derive(Debug, Deserialize)]
struct DirectPatchPlan {
    #[serde(default)]
    edits: Vec<DirectPatchEdit>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DirectPatchEdit {
    path: String,
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    replace: String,
    #[serde(default)]
    create: bool,
}

struct DirectPatchContextFile {
    path: String,
    text: String,
    score: i32,
}

async fn run_direct_ollama_patch_fallback(
    app: &AppHandle,
    state: &AppState,
    req: &OpenCodeRunRequest,
    workspace: &Path,
    before: &WorkspaceSnapshot,
    opencode_error: &str,
    evt: &str,
    step: u32,
    cancel: &mut tokio::sync::broadcast::Receiver<()>,
) -> AppResult<Option<String>> {
    let context = select_direct_patch_context(workspace, before, &req.prompt, &req.files);
    if context.is_empty() {
        return Ok(None);
    }
    let _ = app.emit(
        evt,
        json!({
            "kind": "tool_call",
            "step": step,
            "tool": "pointer_direct_ollama_patch",
            "attrs": {
                "reason": "opencode_failed_before_write",
                "files": context.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
            },
            "args": serde_json::to_string_pretty(&json!({
                "reason": "OpenCode exited before applying a mutating tool",
                "model": req.model,
            })).unwrap_or_else(|_| "{}".into()),
        }),
    );

    let mut last_apply_error: Option<String> = None;
    for attempt in 1..=2 {
        let prompt = render_direct_patch_prompt(
            workspace,
            &req.prompt,
            opencode_error,
            &context,
            last_apply_error.as_deref(),
        );
        let response = direct_ollama_generate(req, state, &prompt, cancel).await?;
        let Some(json_text) = extract_first_json_object(&response) else {
            last_apply_error = Some("model did not return a JSON object".into());
            continue;
        };
        let plan: DirectPatchPlan = match serde_json::from_str(&json_text) {
            Ok(plan) => plan,
            Err(error) => {
                last_apply_error = Some(format!("model returned invalid JSON: {error}"));
                continue;
            }
        };
        if plan.edits.is_empty() {
            let _ = app.emit(
                evt,
                json!({
                    "kind": "tool_result",
                    "step": step,
                    "tool": "pointer_direct_ollama_patch",
                    "status": "error",
                    "result": "Direct Ollama fallback found no safe patch to apply.",
                    "extra": { "attempt": attempt },
                }),
            );
            return Ok(None);
        }
        match apply_direct_patch_plan(workspace, before, &plan.edits) {
            Ok(changed) if !changed.is_empty() => {
                let summary = direct_patch_final_summary(&plan, &changed);
                let _ = app.emit(
                    evt,
                    json!({
                        "kind": "tool_result",
                        "step": step,
                        "tool": "pointer_direct_ollama_patch",
                        "status": "ok",
                        "result": summary,
                        "extra": {
                            "attempt": attempt,
                            "changed": changed,
                        },
                    }),
                );
                return Ok(Some(summary));
            }
            Ok(_) => {
                last_apply_error = Some("patch was valid but produced no file changes".into());
            }
            Err(error) => {
                last_apply_error = Some(error);
            }
        }
    }

    Err(AppError::Msg(last_apply_error.unwrap_or_else(|| {
        "direct Ollama fallback could not produce a patch".into()
    })))
}

async fn direct_ollama_generate(
    req: &OpenCodeRunRequest,
    state: &AppState,
    prompt: &str,
    cancel: &mut tokio::sync::broadcast::Receiver<()>,
) -> AppResult<String> {
    let body = json!({
        "model": opencode_model_id(&req.model),
        "prompt": prompt,
        "system": "You are Pointer's direct Ollama patch fallback. Return only the requested JSON object. Do not use Markdown fences or commentary.",
        "stream": false,
        "think": false,
        "options": {
            "temperature": 0.1,
            "num_ctx": 32768,
            "num_predict": 4096
        }
    });
    let client = reqwest::Client::new();
    let send = client
        .post(format!("{OLLAMA_DIRECT_BASE}/api/generate"))
        .json(&body)
        .send();
    let resp = tokio::select! {
        _ = cancel.recv() => {
            return Err(AppError::Msg("direct Ollama fallback cancelled".into()));
        }
        resp = send => resp?,
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Msg(format!(
            "direct Ollama fallback returned HTTP {status}: {text}",
        )));
    }
    let parsed: Value = tokio::select! {
        _ = cancel.recv() => {
            return Err(AppError::Msg("direct Ollama fallback cancelled".into()));
        }
        parsed = resp.json() => parsed?,
    };
    let text = parsed
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if !text.trim().is_empty() {
        state
            .inference
            .note_tokens(&req.request_id, estimate_tokens(&text));
    }
    Ok(text)
}

fn render_direct_patch_prompt(
    workspace: &Path,
    user_prompt: &str,
    opencode_error: &str,
    context: &[DirectPatchContextFile],
    previous_error: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str("OpenCode failed before applying any file write. Produce a bounded patch using only the repository evidence below.\n");
    out.push_str("Return exactly this JSON shape:\n");
    out.push_str(r#"{"summary":"one concise sentence","edits":[{"path":"relative/file","search":"exact current text to replace","replace":"new text"},{"path":"relative/new-file","create":true,"replace":"full file contents"}]}"#);
    out.push_str("\nRules:\n");
    out.push_str(
        "- Paths must be workspace-relative and must not contain .. or absolute prefixes.\n",
    );
    out.push_str("- For existing files, search must be an exact substring copied from the supplied file content.\n");
    out.push_str("- Prefer the smallest edit that satisfies the request.\n");
    out.push_str("- If the supplied evidence is insufficient, return {\"summary\":\"insufficient evidence\",\"edits\":[]}.\n\n");
    out.push_str(&format!(
        "Workspace: {}\n",
        workspace
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workspace")
    ));
    out.push_str("User request:\n");
    out.push_str(user_prompt.trim());
    out.push_str("\n\nOpenCode error:\n");
    out.push_str(opencode_error.trim());
    if let Some(error) = previous_error {
        out.push_str("\n\nPrevious patch attempt failed:\n");
        out.push_str(error);
    }
    out.push_str("\n\nRepository evidence:\n");
    for file in context {
        out.push_str("\n<file path=\"");
        out.push_str(&file.path);
        out.push_str("\">\n");
        out.push_str(&file.text);
        if !file.text.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("</file>\n");
    }
    out
}

fn select_direct_patch_context(
    workspace: &Path,
    before: &WorkspaceSnapshot,
    prompt: &str,
    attached_files: &[String],
) -> Vec<DirectPatchContextFile> {
    let terms = prompt_terms(prompt);
    let mut attached = attached_files
        .iter()
        .filter_map(|path| opencode_file_arg(workspace, path))
        .collect::<Vec<_>>();
    attached.extend(referenced_prompt_paths(workspace, prompt));
    attached.sort();
    attached.dedup();
    let mut files = before
        .files
        .iter()
        .filter_map(|(path, bytes)| {
            if !is_direct_patch_context_path(path) || bytes.len() > DIRECT_PATCH_MAX_FILE_BYTES {
                return None;
            }
            let text = std::str::from_utf8(bytes).ok()?.to_string();
            let lower_path = path.to_ascii_lowercase();
            let lower_text = text.to_ascii_lowercase();
            let mut score = 0;
            if attached.iter().any(|attached_path| attached_path == path) {
                score += 120;
            }
            for term in &terms {
                if lower_path.contains(term) {
                    score += 20;
                }
                if lower_text.contains(term) {
                    score += 6;
                }
            }
            if is_aggregator_like_file(path, &text) {
                score += 18;
            }
            if score <= 0 {
                return None;
            }
            Some(DirectPatchContextFile {
                path: path.clone(),
                text,
                score,
            })
        })
        .collect::<Vec<_>>();
    files.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));

    let mut total = 0usize;
    let mut out = Vec::new();
    for file in files {
        let next_total = total.saturating_add(file.text.len());
        if next_total > DIRECT_PATCH_MAX_CONTEXT_BYTES {
            continue;
        }
        total = next_total;
        out.push(file);
        if out.len() >= 12 {
            break;
        }
    }
    out
}

fn referenced_prompt_paths(workspace: &Path, prompt: &str) -> Vec<String> {
    prompt
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.contains(' ')
                && !line.ends_with(':')
                && (line.contains('/') || line.contains('.'))
        })
        .filter_map(|line| opencode_file_arg(workspace, line))
        .collect()
}

fn prompt_terms(prompt: &str) -> Vec<String> {
    let mut out = prompt
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|term| term.len() >= 4)
        .filter(|term| {
            !matches!(
                *term,
                "this" | "that" | "with" | "from" | "into" | "another"
            )
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    out.sort();
    out.dedup();
    out
}

fn is_direct_patch_context_path(path: &str) -> bool {
    if is_integratable_source_artifact(path) {
        return true;
    }
    matches!(
        Path::new(path)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("json" | "toml" | "yaml" | "yml" | "md" | "mdx" | "html" | "css" | "scss")
    )
}

fn apply_direct_patch_plan(
    workspace: &Path,
    before: &WorkspaceSnapshot,
    edits: &[DirectPatchEdit],
) -> Result<Vec<String>, String> {
    if edits.is_empty() {
        return Ok(Vec::new());
    }
    if edits.len() > 12 {
        return Err("direct patch rejected: too many edits".into());
    }
    let mut pending: Vec<(PathBuf, String, Vec<u8>)> = Vec::new();
    for edit in edits {
        let rel = safe_direct_patch_path(&edit.path)?;
        let abs = workspace.join(&rel);
        if should_skip_snapshot_path(&abs, workspace) {
            return Err(format!("direct patch rejected unsafe path `{}`", edit.path));
        }
        let rel_key = normalize_rel_path(&rel);
        if edit.create || !before.files.contains_key(&rel_key) {
            if abs.exists() {
                return Err(format!(
                    "direct patch create target already exists `{rel_key}`"
                ));
            }
            if edit.replace.trim().is_empty() {
                return Err(format!("direct patch create target is empty `{rel_key}`"));
            }
            pending.push((abs, rel_key, edit.replace.as_bytes().to_vec()));
            continue;
        }

        let current = std::fs::read_to_string(&abs)
            .map_err(|e| format!("direct patch read `{rel_key}` failed: {e}"))?;
        let search = edit
            .search
            .as_deref()
            .ok_or_else(|| format!("direct patch missing search text for `{rel_key}`"))?;
        if search.is_empty() {
            return Err(format!("direct patch empty search text for `{rel_key}`"));
        }
        if !current.contains(search) {
            return Err(format!(
                "direct patch search text did not match `{rel_key}`"
            ));
        }
        let next = current.replacen(search, &edit.replace, 1);
        if next == current {
            return Err(format!("direct patch produced no change for `{rel_key}`"));
        }
        pending.push((abs, rel_key, next.into_bytes()));
    }

    let mut changed = Vec::new();
    for (abs, rel, bytes) in pending {
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("direct patch mkdir `{}` failed: {e}", parent.display()))?;
        }
        std::fs::write(&abs, bytes)
            .map_err(|e| format!("direct patch write `{rel}` failed: {e}"))?;
        changed.push(rel);
    }
    changed.sort();
    changed.dedup();
    Ok(changed)
}

fn safe_direct_patch_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err("direct patch path is empty".into());
    }
    let path = Path::new(&trimmed);
    if path.is_absolute() {
        return Err(format!("direct patch rejected absolute path `{trimmed}`"));
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!(
            "direct patch rejected parent traversal `{trimmed}`"
        ));
    }
    if trimmed.starts_with(".git/") || trimmed == ".git" {
        return Err("direct patch rejected .git path".into());
    }
    Ok(PathBuf::from(trimmed))
}

fn direct_patch_final_summary(plan: &DirectPatchPlan, changed: &[String]) -> String {
    let summary = plan
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Applied a direct Ollama fallback patch after OpenCode exited before editing.");
    format!(
        "{summary}\n\nFiles changed: {}.\nPointer used direct Ollama fallback because OpenCode exited before applying edits.",
        changed.join(", "),
    )
}

fn extract_first_json_object(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn run_structural_integration_fallback(
    workspace: &Path,
    before: &WorkspaceSnapshot,
    after: &WorkspaceSnapshot,
    prompt: &str,
    context_files: &[String],
) -> AppResult<Vec<String>> {
    let created = created_source_files_needing_integration(before, after);
    if created.is_empty() {
        return Ok(Vec::new());
    }
    let candidates = structural_candidate_files(after, prompt, context_files, &created);
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let mut applied = Vec::new();
    for created_file in created {
        for candidate_file in &candidates {
            if let Some(mut changed) = try_integrate_module_registry_file(
                workspace,
                after,
                prompt,
                &created_file,
                candidate_file,
            )? {
                applied.append(&mut changed);
                break;
            }
        }
    }
    applied.sort();
    applied.dedup();
    Ok(applied)
}

fn created_source_files_needing_integration(
    before: &WorkspaceSnapshot,
    after: &WorkspaceSnapshot,
) -> Vec<String> {
    let mut out = after
        .files
        .keys()
        .filter(|path| !before.files.contains_key(*path))
        .filter(|path| is_integratable_source_artifact(path))
        .filter(|path| !workspace_mentions_created_file(after, path))
        .cloned()
        .collect::<Vec<_>>();
    out.sort();
    out.truncate(6);
    out
}

fn is_integratable_source_artifact(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    matches!(
        Path::new(&lower).extension().and_then(|ext| ext.to_str()),
        Some(
            "astro"
                | "c"
                | "cc"
                | "cpp"
                | "cs"
                | "css"
                | "go"
                | "h"
                | "hpp"
                | "html"
                | "java"
                | "js"
                | "jsx"
                | "kt"
                | "less"
                | "mjs"
                | "py"
                | "rb"
                | "rs"
                | "sass"
                | "scss"
                | "svelte"
                | "ts"
                | "tsx"
                | "vue"
        )
    )
}

fn workspace_mentions_created_file(snapshot: &WorkspaceSnapshot, target: &str) -> bool {
    let base = Path::new(target)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let stem = path_stem(target).to_ascii_lowercase();
    let target_lower = target.to_ascii_lowercase();
    let symbols = snapshot
        .files
        .get(target)
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .map(default_export_symbol)
        .unwrap_or(None)
        .into_iter()
        .map(|symbol| symbol.to_ascii_lowercase())
        .collect::<Vec<_>>();
    for (path, bytes) in &snapshot.files {
        if path == target {
            continue;
        }
        let Ok(body) = std::str::from_utf8(bytes) else {
            continue;
        };
        let lower = body.to_ascii_lowercase();
        if base.len() >= 4 && lower.contains(&base) {
            return true;
        }
        if stem.len() >= 4 && lower.contains(&stem) {
            return true;
        }
        if lower.contains(&target_lower) {
            return true;
        }
        if symbols
            .iter()
            .any(|symbol| symbol.len() >= 4 && lower.contains(symbol))
        {
            return true;
        }
        let spec = relative_module_spec(path, target);
        if mentions_module_spec(body, &spec) {
            return true;
        }
    }
    false
}

fn structural_candidate_files(
    snapshot: &WorkspaceSnapshot,
    prompt: &str,
    context_files: &[String],
    created: &[String],
) -> Vec<String> {
    let mut scored: HashMap<String, i32> = HashMap::new();
    let created_dirs = created
        .iter()
        .map(|path| parent_dir(path))
        .collect::<Vec<_>>();
    let prompt_lower = prompt.to_ascii_lowercase();
    let add_score = |scores: &mut HashMap<String, i32>, file: &str, score: i32| {
        if score < 35 || !is_integratable_source_artifact(file) {
            return;
        }
        scores
            .entry(file.to_string())
            .and_modify(|current| *current = (*current).max(score))
            .or_insert(score);
    };
    for file in context_files {
        add_score(&mut scored, file, 45);
    }
    for (file, bytes) in &snapshot.files {
        if created.iter().any(|created_file| created_file == file) {
            continue;
        }
        let Ok(body) = std::str::from_utf8(bytes) else {
            continue;
        };
        let file_dir = parent_dir(file);
        let imports = extract_relative_imports(body);
        let mut score = 0;
        if is_aggregator_like_file(file, body) {
            score += 70;
        }
        if is_entry_like_file(file, body) {
            score += 35;
        }
        if created_dirs.iter().any(|dir| dir == &file_dir) {
            score += 55;
        }
        if imports.iter().any(|spec| {
            resolve_relative_import(file, spec, snapshot)
                .map(|resolved| created_dirs.iter().any(|dir| parent_dir(&resolved) == *dir))
                .unwrap_or(false)
        }) {
            score += 45;
        }
        if prompt_lower
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .filter(|term| term.len() >= 5)
            .any(|term| {
                file.to_ascii_lowercase().contains(term) || body.to_ascii_lowercase().contains(term)
            })
        {
            score += 15;
        }
        add_score(&mut scored, file, score);
    }
    let mut items = scored.into_iter().collect::<Vec<_>>();
    items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    items.into_iter().map(|(file, _)| file).take(8).collect()
}

fn try_integrate_module_registry_file(
    workspace: &Path,
    snapshot: &WorkspaceSnapshot,
    prompt: &str,
    created_file: &str,
    candidate_file: &str,
) -> AppResult<Option<Vec<String>>> {
    if !looks_like_module_file(created_file) || !looks_like_module_file(candidate_file) {
        return Ok(None);
    }
    let Some(created_body) = snapshot
        .files
        .get(created_file)
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
    else {
        return Ok(None);
    };
    let Some(candidate_body) = snapshot
        .files
        .get(candidate_file)
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
    else {
        return Ok(None);
    };
    let Some(symbol) = default_export_symbol(created_body) else {
        return Ok(None);
    };
    if candidate_body.contains(&symbol) || extract_relative_imports(candidate_body).is_empty() {
        return Ok(None);
    }
    let import_line = format!(
        "import {symbol} from '{}';",
        relative_module_spec(candidate_file, created_file)
    );
    let with_import = insert_import_declaration(candidate_body, &import_line);
    let Some((next_candidate, references_title)) =
        insert_module_registry_entry(&with_import, &symbol)
    else {
        return Ok(None);
    };
    if patch_would_corrupt_module(candidate_body, &next_candidate) {
        return Ok(None);
    }
    std::fs::write(workspace.join(candidate_file), next_candidate).map_err(AppError::Io)?;
    let mut applied = vec![candidate_file.to_string()];
    if references_title && !module_symbol_has_title(created_body, &symbol) {
        let titled = insert_module_title_assignment(
            created_body,
            &symbol,
            &title_for_created_module(prompt, &symbol),
        );
        if !patch_would_corrupt_module(created_body, &titled) {
            std::fs::write(workspace.join(created_file), titled).map_err(AppError::Io)?;
            applied.push(created_file.to_string());
        }
    }
    Ok(Some(applied))
}

fn looks_like_module_file(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "vue" | "svelte")
    )
}

fn default_export_symbol(body: &str) -> Option<String> {
    for pattern in [
        r"\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)",
        r"\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)",
        r"\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?",
    ] {
        let re = Regex::new(pattern).ok()?;
        if let Some(hit) = re.captures(body).and_then(|captures| captures.get(1)) {
            return Some(hit.as_str().to_string());
        }
    }
    None
}

fn insert_import_declaration(body: &str, import_line: &str) -> String {
    if body.contains(import_line) {
        return body.to_string();
    }
    let mut lines = body.lines().map(str::to_string).collect::<Vec<_>>();
    let mut insert_at = 0usize;
    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("import ")
            || trimmed.starts_with("import\"")
            || trimmed.starts_with("import'")
        {
            insert_at = idx + 1;
        } else if !trimmed.is_empty() && !trimmed.starts_with("//") {
            break;
        }
    }
    lines.insert(insert_at, import_line.to_string());
    format!("{}\n", lines.join("\n"))
}

fn insert_module_registry_entry(body: &str, symbol: &str) -> Option<(String, bool)> {
    if body.contains(&format!("Component: {symbol}")) {
        return None;
    }
    let component_re =
        Regex::new(r"(?s)(const\s+[A-Za-z_$][\w$]*\s*=\s*\[.*?)(\n\]\.map|\n\];)").ok()?;
    if let Some(hit) = component_re.captures(body) {
        let prefix = hit.get(1)?.as_str();
        if prefix.contains("Component:") {
            let references_title = Regex::new(r"\b[A-Za-z_$][\w$]*\.title\b")
                .ok()?
                .is_match(prefix);
            let entry = if references_title {
                format!("  {{ Component: {symbol}, title: {symbol}.title }},")
            } else {
                format!("  {{ Component: {symbol} }},")
            };
            let start = hit.get(1)?.start();
            let end = hit.get(1)?.end();
            let mut next = String::new();
            next.push_str(&body[..start]);
            next.push_str(prefix.trim_end());
            next.push('\n');
            next.push_str(&entry);
            next.push_str(&body[end..]);
            return Some((next, references_title));
        }
    }
    let default_array_re = Regex::new(r"(?s)(export\s+default\s+\[.*?)(\n\];)").ok()?;
    if let Some(hit) = default_array_re.captures(body) {
        let start = hit.get(1)?.start();
        let end = hit.get(1)?.end();
        let prefix = hit.get(1)?.as_str();
        let mut next = String::new();
        next.push_str(&body[..start]);
        next.push_str(prefix.trim_end());
        next.push('\n');
        next.push_str(&format!("  {symbol},"));
        next.push_str(&body[end..]);
        return Some((next, false));
    }
    None
}

fn patch_would_corrupt_module(before: &str, after: &str) -> bool {
    if has_import_after_executable_code(after) {
        return true;
    }
    let before_defaults = before.matches("export default").count();
    let after_defaults = after.matches("export default").count();
    before_defaults >= 1 && after_defaults > before_defaults
}

fn has_import_after_executable_code(body: &str) -> bool {
    let mut saw_executable = false;
    for line in body.lines().map(str::trim) {
        if line.is_empty()
            || line.starts_with("//")
            || line.starts_with("/*")
            || line.starts_with('*')
        {
            continue;
        }
        if line.starts_with("import ")
            || line.starts_with("import\"")
            || line.starts_with("import'")
        {
            if saw_executable {
                return true;
            }
            continue;
        }
        if line.starts_with("export type ") || line.starts_with("export interface ") {
            continue;
        }
        saw_executable = true;
    }
    false
}

fn module_symbol_has_title(body: &str, symbol: &str) -> bool {
    body.contains(&format!("{symbol}.title"))
}

fn insert_module_title_assignment(body: &str, symbol: &str, title: &str) -> String {
    let assignment = format!("{symbol}.title = \"{}\";", title.replace('"', "\\\""));
    let export = format!("export default {symbol};");
    if body.contains(&export) {
        return body.replace(&export, &format!("{assignment}\n\n{export}"));
    }
    format!("{}\n{assignment}\n", body.trim_end())
}

fn title_for_created_module(prompt: &str, symbol: &str) -> String {
    let called = Regex::new(r#"(?i)\bcalled\s+["']?([A-Za-z0-9][A-Za-z0-9 _-]{1,80})["']?"#)
        .ok()
        .and_then(|re| re.captures(prompt))
        .and_then(|captures| captures.get(1).map(|m| m.as_str().to_string()));
    if let Some(value) = called {
        let cleaned = Regex::new("(?i)\\bslide\\b|\\bcomponent\\b|\\bview\\b|\\bpage\\b")
            .map(|re| re.replace_all(&value, "").to_string())
            .unwrap_or(value);
        let title = title_case_words(&cleaned);
        if !title.is_empty() {
            return title;
        }
    }
    title_case_words(
        &Regex::new("(?i)(Slide|Component|View|Page)$")
            .map(|re| re.replace(symbol, "").to_string())
            .unwrap_or_else(|_| symbol.to_string()),
    )
}

fn title_case_words(value: &str) -> String {
    split_identifier_words(value)
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn split_identifier_words(value: &str) -> String {
    let mut out = String::new();
    let mut prev_lower_or_digit = false;
    for ch in value.replace(['_', '-'], " ").chars() {
        if ch.is_ascii_uppercase() && prev_lower_or_digit {
            out.push(' ');
        }
        prev_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        out.push(ch);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn extract_relative_imports(body: &str) -> Vec<String> {
    let Ok(re) = Regex::new(
        r#"(?:import\s+(?:[^'"]+?\s+from\s+)?|export\s+[^'"]+?\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}/[^'"]+)['"]"#,
    ) else {
        return Vec::new();
    };
    re.captures_iter(body)
        .filter_map(|captures| {
            captures.get(1).map(|m| {
                m.as_str()
                    .split(['?', '#'])
                    .next()
                    .unwrap_or("")
                    .to_string()
            })
        })
        .filter(|spec| !spec.is_empty())
        .collect()
}

fn resolve_relative_import(
    from_file: &str,
    spec: &str,
    snapshot: &WorkspaceSnapshot,
) -> Option<String> {
    let base = Path::new(from_file)
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(spec);
    let base = normalize_rel_path(&base);
    [
        base.clone(),
        format!("{base}.js"),
        format!("{base}.jsx"),
        format!("{base}.ts"),
        format!("{base}.tsx"),
        format!("{base}.vue"),
        format!("{base}/index.js"),
        format!("{base}/index.jsx"),
        format!("{base}/index.ts"),
        format!("{base}/index.tsx"),
        format!("{base}/index.vue"),
    ]
    .into_iter()
    .find(|candidate| snapshot.files.contains_key(candidate))
}

fn relative_module_spec(from_file: &str, target_file: &str) -> String {
    let from_dir = parent_dir(from_file);
    let from_parts = from_dir
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>();
    let target_parts = target_file
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>();
    let mut common = 0usize;
    while common < from_parts.len()
        && common < target_parts.len()
        && from_parts[common] == target_parts[common]
    {
        common += 1;
    }
    let mut rel_parts = Vec::new();
    for _ in common..from_parts.len() {
        rel_parts.push("..");
    }
    rel_parts.extend(target_parts.iter().skip(common).copied());
    let mut spec = rel_parts.join("/");
    if !spec.starts_with('.') {
        spec = format!("./{spec}");
    }
    if let Some(stripped) = spec.rsplit_once('.') {
        if !stripped.0.ends_with('/') {
            spec = stripped.0.to_string();
        }
    }
    spec
}

fn mentions_module_spec(body: &str, spec: &str) -> bool {
    body.contains(&format!("'{spec}'")) || body.contains(&format!("\"{spec}\""))
}

fn is_aggregator_like_file(path: &str, body: &str) -> bool {
    let imports = extract_relative_imports(body);
    if imports.len() < 3 {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    lower.ends_with("/index.js")
        || lower.ends_with("/index.jsx")
        || lower.ends_with("/index.ts")
        || lower.ends_with("/index.tsx")
        || lower.contains("registry")
        || lower.contains("routes")
        || lower.contains("manifest")
        || (body.contains("export default") && (body.contains('[') || body.contains('{')))
}

fn is_entry_like_file(path: &str, body: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    (lower.ends_with("/main.js")
        || lower.ends_with("/main.ts")
        || lower.ends_with("/app.jsx")
        || lower.ends_with("/app.tsx")
        || lower.ends_with("/index.js")
        || lower.ends_with("/index.ts"))
        && !extract_relative_imports(body).is_empty()
}

fn path_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string()
}

fn parent_dir(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(normalize_rel_path)
        .unwrap_or_default()
}

fn emit_change_records(
    app: &AppHandle,
    evt: &str,
    step: u32,
    records: &[agent_changes::FileChangeRecord],
    truncated: bool,
) {
    for record in records {
        let _ = app.emit(
            evt,
            json!({
                "kind": "tool_result",
                "step": step,
                "tool": "agent_change",
                "status": "ok",
                "result": format!("{} {}", change_kind_label(record), record.path),
                "extra": {
                    "change": record,
                    "snapshot_truncated": truncated,
                },
            }),
        );
    }
}

fn change_kind_label(record: &agent_changes::FileChangeRecord) -> &'static str {
    match record.kind {
        agent_changes::ChangeKind::Create => "created",
        agent_changes::ChangeKind::Modify => "modified",
        agent_changes::ChangeKind::Delete => "deleted",
        agent_changes::ChangeKind::Rename => "renamed",
    }
}

fn attrs_from_input(input: &Value, workspace: &Path) -> serde_json::Map<String, Value> {
    let mut attrs = serde_json::Map::new();
    if let Some(obj) = input.as_object() {
        for key in ["filePath", "path", "pattern", "command", "description"] {
            if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
                attrs.insert(
                    key.to_string(),
                    json!(workspace_relative_tool_value(workspace, v)),
                );
            }
        }
    }
    attrs
}

fn workspace_relative_tool_value(workspace: &Path, value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let path = Path::new(trimmed);
    path.strip_prefix(workspace)
        .ok()
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .or_else(|| existing_workspace_relative_suffix(workspace, path))
        .filter(|rel| !rel.is_empty())
        .unwrap_or_else(|| trimmed.to_string())
}

fn opencode_file_arg(workspace: &Path, file: &str) -> Option<String> {
    let trimmed = file.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        if let Ok(rel) = path.strip_prefix(workspace) {
            if workspace.join(rel).exists() {
                return Some(rel.to_string_lossy().replace('\\', "/"));
            }
        }
        return None;
    }
    if workspace.join(path).exists() {
        return Some(path.to_string_lossy().replace('\\', "/"));
    }
    existing_workspace_relative_suffix(workspace, path)
}

fn existing_workspace_relative_suffix(workspace: &Path, path: &Path) -> Option<String> {
    let parts = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_os_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    for start in 1..parts.len() {
        let suffix = parts[start..].iter().collect::<PathBuf>();
        if workspace.join(&suffix).exists() {
            return Some(suffix.to_string_lossy().replace('\\', "/"));
        }
    }
    None
}

fn emit_snapshots(
    app: &AppHandle,
    evt: &str,
    req: &OpenCodeRunRequest,
    answer: &str,
    opencode_session_id: Option<&str>,
) {
    let _ = app.emit(
        evt,
        json!({
            "kind": "transcript_snapshot",
            "messages": [
                { "role": "user", "content": req.prompt },
                { "role": "assistant", "content": answer }
            ],
            "opencode_session_id": opencode_session_id,
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

fn prepare_runtime_dir(app: &AppHandle, model: &str) -> AppResult<RuntimeDir> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Msg(format!("app_data_dir: {e}")))?
        .join("opencode");
    let data_dir = root.join("data");
    let state_dir = root.join("state");
    let cache_dir = root.join("cache");
    let config_dir = root.join("configs");
    std::fs::create_dir_all(&data_dir).map_err(AppError::Io)?;
    std::fs::create_dir_all(&state_dir).map_err(AppError::Io)?;
    std::fs::create_dir_all(&cache_dir).map_err(AppError::Io)?;
    std::fs::create_dir_all(&config_dir).map_err(AppError::Io)?;
    let model_id = opencode_model_id(model);
    let config_path = config_dir.join(format!("{}.json", config_key(&model_id)));
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
                        "limit": { "context": 32768, "output": 1536 }
                    }
                }
            }
        },
        "agent": {
            "pointer-ask": {
                "model": model_arg,
                "description": "Pointer Ask mode",
                "prompt": "Ask mode: answer from attached context or repository files you read. For named-file questions, read/use that file first. For behavior-flow questions, trace definition-to-consumer hops with exact repository-relative paths and read matches before answering. Use <context-memory> as deterministic evidence/navigation memory, not as permission to invent unseen code. Mention exact visible symbols/settings only, preserve spelling, and include a compact Key identifiers sentence when useful. Avoid fenced code unless requested. Do not modify files.",
                "permission": {
                    "edit": "deny",
                    "bash": "deny",
                    "task": "deny",
                    "todowrite": "deny",
                    "skill": "deny",
                    "webfetch": "deny",
                    "websearch": "deny"
                }
            },
            "pointer-plan": {
                "model": model_arg,
                "description": "Pointer Plan mode",
                "prompt": "Plan mode: inspect bounded evidence, then produce an executable plan without editing or running shell commands. Read active/named files when relevant, directly related implementation files, analogous examples for additive work, likely tests/specs/fixtures, and project config for verification. Use only repository-relative paths returned by tools; if a read fails, list the parent and retry the exact relative path. Do not assume a language, framework, package manager, or bug. Final format under 180 words: Context read; Assessment; Plan; Verification with an exact configured command.",
                "permission": {
                    "edit": "deny",
                    "bash": "deny",
                    "task": "deny",
                    "todowrite": "deny",
                    "skill": "deny",
                    "webfetch": "deny",
                    "websearch": "deny"
                }
            },
            "pointer-agent": {
                "model": model_arg,
                "description": "Pointer Agent mode",
                "prompt": "Agent mode: gather minimal evidence, make the smallest relevant edit, preserve unrelated code/assets, and verify with the narrowest configured repository command when available. Use attached context and <context-memory> as deterministic evidence; if they are sufficient, proceed to edits and re-read only files you will modify or need in full. For additive/edit tasks with clear target files and one analogous example visible, perform at most two extra reads before the first edit. Do not keep reading examples once one useful local pattern is visible. Do not install/update dependencies or run destructive git/deploy/database commands unless explicitly requested. Do not use one-off package executors such as npx, npm exec, pnpm dlx, yarn dlx, or bunx. Final response must concisely list changed files and the real verification command/result.",
                "permission": {
                    "edit": "allow",
                    "write": "allow",
                    "apply_patch": "allow",
                    "read": "allow",
                    "glob": "allow",
                    "grep": "allow",
                    "list": "allow",
                    "lsp": "allow",
                    "bash": {
                        "*": "allow",
                        "*npm install*": "deny",
                        "*npm i *": "deny",
                        "*npm add*": "deny",
                        "*npm update*": "deny",
                        "*npm exec*": "deny",
                        "*npx *": "deny",
                        "*pnpm install*": "deny",
                        "*pnpm add*": "deny",
                        "*pnpm dlx*": "deny",
                        "*yarn install*": "deny",
                        "*yarn add*": "deny",
                        "*yarn dlx*": "deny",
                        "*bun install*": "deny",
                        "*bun add*": "deny",
                        "*bunx *": "deny",
                        "*pip install*": "deny",
                        "*pip3 install*": "deny",
                        "*uv pip install*": "deny",
                        "*poetry add*": "deny",
                        "*cargo install*": "deny",
                        "*git reset*": "deny",
                        "*git checkout*": "deny",
                        "*git clean*": "deny",
                        "*git push*": "deny",
                        "*rm -rf*": "deny"
                    },
                    "external_directory": "deny",
                    "webfetch": "deny",
                    "websearch": "deny"
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
    // OpenCode owns session history, caches, and project context in its data
    // and state dirs. Pointer keeps those under app_data/opencode so follow-up
    // turns can resume the same OpenCode session instead of reconstructing
    // memory from our own lossy transcript snapshots.
    let _ = path;
}

fn is_large_workspace_file(workspace: &Path, file: &str) -> bool {
    let path = PathBuf::from(file);
    let path = if path.is_absolute() {
        path
    } else {
        workspace.join(path)
    };
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 24_000)
        .unwrap_or(false)
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

fn config_key(model_id: &str) -> String {
    model_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn opencode_model_arg(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.contains('/') {
        trimmed.to_string()
    } else {
        format!("ollama/{trimmed}")
    }
}

fn opencode_variant(mode: &OpenCodeMode) -> Option<String> {
    let mode_key = match mode {
        OpenCodeMode::Ask => "ASK",
        OpenCodeMode::Plan => "PLAN",
        OpenCodeMode::Agent => "AGENT",
    };
    std::env::var(format!("POINTER_OPENCODE_{mode_key}_VARIANT"))
        .ok()
        .or_else(|| std::env::var("POINTER_OPENCODE_VARIANT").ok())
        .map(|value| value.trim().to_string())
        .or_else(|| match mode {
            OpenCodeMode::Agent => Some("default".to_string()),
            OpenCodeMode::Ask | OpenCodeMode::Plan => Some("minimal".to_string()),
        })
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("default"))
}

fn normalize_final_text(text: &str) -> String {
    let trimmed = text.trim();
    for marker in [
        "\n## Goal",
        "\n## Constraints & Preferences",
        "\n## Progress",
        "\nContinue if you have next steps",
    ] {
        if let Some(idx) = trimmed.find(marker) {
            if idx > 80 {
                return trimmed[..idx].trim().to_string();
            }
        }
    }
    for marker in [
        "\n## Final Assessment",
        "\n## Final Answer",
        "\n## Conclusion",
        "\n## Summary",
        "\n# Final Assessment",
        "\n# Final Answer",
        "\n# Conclusion",
        "\n# Summary",
    ] {
        if let Some(idx) = trimmed.rfind(marker) {
            if idx > trimmed.len() / 4 || marker.contains("Summary") {
                return trimmed[idx + 1..].trim().to_string();
            }
        }
    }
    let lower = trimmed.to_ascii_lowercase();
    for marker in [
        "\ni've successfully implemented",
        "\ni have successfully implemented",
        "\n## changes made",
    ] {
        if let Some(idx) = lower.rfind(marker) {
            if idx > trimmed.len() / 3 {
                return trimmed[..idx].trim().to_string();
            }
        }
    }
    for needle in [
        "i've successfully implemented",
        "i have successfully implemented",
        "successfully implemented",
        "i've implemented",
        "i have implemented",
    ] {
        if let Some(idx) = lower.rfind(needle) {
            if idx > trimmed.len() / 3 {
                let before = &lower[..idx];
                if before.contains("summarize")
                    || before.contains("summary")
                    || before.contains("what i've done")
                    || before.contains("what i have done")
                {
                    return trimmed[..idx].trim().to_string();
                }
            }
        }
    }
    for needle in [
        "i've successfully",
        "i have successfully",
        "i've updated",
        "i have updated",
        "the changes:",
    ] {
        if let Some(first) = lower.find(needle) {
            if let Some(rel_second) = lower[first + needle.len()..].find(needle) {
                let second = first + needle.len() + rel_second;
                if second > 120 && second > trimmed.len() / 3 {
                    return trimmed[..second].trim().to_string();
                }
            }
        }
    }
    for restart in [
        "\ni've successfully",
        "\ni have successfully",
        "i've successfully",
        "i have successfully",
        "i've successfully refactored",
        "i've successfully updated",
        "i've successfully improved",
        "i've improved",
        "i've made",
        "i have successfully refactored",
        "i have successfully updated",
        "i have made",
        "i have improved",
        "i understand that",
    ] {
        if let Some(idx) = lower.find(restart) {
            if idx > 120 && idx > trimmed.len() / 3 {
                return trimmed[..idx].trim().to_string();
            }
            if idx > 40 && idx < 320 && lower[..idx].contains("i'll")
                || idx > 40 && idx < 320 && lower[..idx].contains("i will")
                || idx > 40 && idx < 320 && lower[..idx].contains("let me")
                || idx > 40 && idx < 320 && lower[..idx].contains("try to")
                || idx > 40 && idx < 320 && lower[..idx].contains("trying to")
            {
                return trimmed[idx..].trim().to_string();
            }
        }
    }
    remove_repeated_boundary_sentence(&dedupe_repeated_lines(trimmed))
}

fn dedupe_repeated_lines(text: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<&str> = Vec::new();
    for line in text.lines() {
        let normalized = line
            .trim()
            .to_ascii_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let meaningful =
            normalized.len() >= 18 && normalized.chars().any(|ch| ch.is_ascii_alphanumeric());
        if meaningful && seen.contains(&normalized) {
            continue;
        }
        if meaningful {
            seen.insert(normalized);
        }
        out.push(line);
    }
    out.join("\n").replace("\n\n\n", "\n\n").trim().to_string()
}

fn remove_repeated_boundary_sentence(text: &str) -> String {
    let trimmed = text.trim();
    let Some(end) = trimmed
        .char_indices()
        .find_map(|(idx, ch)| matches!(ch, '.' | '!' | '?').then_some(idx + ch.len_utf8()))
    else {
        return trimmed.to_string();
    };
    if !(30..=220).contains(&end) {
        return trimmed.to_string();
    }
    let sentence = trimmed[..end].trim();
    let rest = trimmed[end..].trim_start();
    if rest
        .to_ascii_lowercase()
        .contains(&sentence.to_ascii_lowercase())
    {
        return rest.trim().to_string();
    }
    trimmed.to_string()
}

fn sanitize_workspace_paths(text: &str, workspace: &Path) -> String {
    let root = normalize_path_string(workspace);
    if root.is_empty() {
        return text.to_string();
    }
    text.replace(&format!("{root}/"), "").replace(&root, ".")
}

fn normalize_path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn sanitize_verification_claims(text: &str, records: &[BashRecord]) -> String {
    let blocked_package_executor = records
        .iter()
        .any(|record| record.status != "completed" && is_package_executor_command(&record.command));
    if !blocked_package_executor {
        return text.to_string();
    }
    let mut out = text.to_string();
    for pattern in [
        r"(?i)\bAll (?:unit |existing )?tests (?:continue to )?pass[^.]*\.",
        r"(?i)\bAll tests are passing[^.]*\.",
        r"(?i)\bAll existing tests continue to pass[^.]*\.",
        r"(?i)\bAll unit tests pass[^.]*\.",
    ] {
        if let Ok(re) = Regex::new(pattern) {
            out = re
                .replace_all(
                    &out,
                    "Verification could not be completed in this environment.",
                )
                .to_string();
        }
    }
    if !out.to_ascii_lowercase().contains("verification:") {
        out.push_str("\n\nVerification: not completed; Pointer blocked package executor/dependency commands and the temp workspace did not have the required test binary available.");
    }
    out.trim().to_string()
}

fn ensure_verification_status(text: &str, records: &[BashRecord]) -> String {
    if text.to_ascii_lowercase().contains("verification:") || records.is_empty() {
        return text.to_string();
    }
    let Some(record) = records
        .iter()
        .rev()
        .find(|record| !record.command.trim().is_empty())
    else {
        return text.to_string();
    };
    let status = if record.status == "completed" {
        "completed successfully".to_string()
    } else {
        let detail =
            first_meaningful_line(&record.output).unwrap_or_else(|| "no output".to_string());
        format!("failed or was blocked: {detail}")
    };
    format!(
        "{}\n\nVerification: `{}` {}.",
        text.trim(),
        record.command,
        status
    )
}

async fn run_deterministic_verification_fallback(
    app: &AppHandle,
    evt: &str,
    workspace: &Path,
) -> Option<BashRecord> {
    let command = select_verification_command(workspace)?;
    if is_package_executor_command(&command) {
        return None;
    }
    let _ = app.emit(
        evt,
        json!({
            "kind": "tool_call",
            "step": 0,
            "tool": "bash",
            "attrs": { "command": command.clone() },
            "args": serde_json::to_string_pretty(&json!({
                "command": command.clone(),
                "description": "Pointer deterministic verification fallback"
            })).unwrap_or_else(|_| "{}".into()),
        }),
    );

    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-lc")
        .arg(&command)
        .current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let (status, output) = match timeout(Duration::from_secs(120), cmd.output()).await {
        Ok(Ok(output)) => {
            let mut text = String::new();
            text.push_str(&String::from_utf8_lossy(&output.stdout));
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            (
                if output.status.success() {
                    "completed"
                } else {
                    "error"
                }
                .to_string(),
                strip_ansi(&text)
                    .trim()
                    .chars()
                    .rev()
                    .take(8000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>(),
            )
        }
        Ok(Err(error)) => ("error".to_string(), error.to_string()),
        Err(_) => (
            "error".to_string(),
            "verification command timed out after 120 seconds".to_string(),
        ),
    };

    let ui_status = if status == "completed" { "ok" } else { "error" };
    let _ = app.emit(
        evt,
        json!({
            "kind": "tool_result",
            "step": 0,
            "tool": "bash",
            "status": ui_status,
            "result": output,
            "extra": {
                "deterministic_verification": true,
                "command": command.clone(),
            },
        }),
    );
    Some(BashRecord {
        command,
        status,
        output,
    })
}

fn select_verification_command(workspace: &Path) -> Option<String> {
    let package_json = workspace.join("package.json");
    if package_json.exists() {
        if let Ok(text) = std::fs::read_to_string(&package_json) {
            if let Ok(pkg) = serde_json::from_str::<Value>(&text) {
                if let Some(scripts) = pkg.get("scripts").and_then(|v| v.as_object()) {
                    for name in ["test:run", "test", "build", "lint", "typecheck", "check"] {
                        if !scripts
                            .get(name)
                            .and_then(|v| v.as_str())
                            .is_some_and(|s| !s.trim().is_empty())
                        {
                            continue;
                        }
                        let pm = package_manager(workspace);
                        if name == "test" {
                            return Some(if pm == "npm" {
                                "npm test -- --watchAll=false".to_string()
                            } else {
                                format!("{pm} test")
                            });
                        }
                        return Some(if pm == "npm" {
                            format!("npm run {name}")
                        } else {
                            format!("{pm} run {name}")
                        });
                    }
                }
            }
        }
    }
    if workspace.join("Cargo.toml").exists() {
        return Some("cargo test".to_string());
    }
    if workspace.join("go.mod").exists() {
        return Some("go test ./...".to_string());
    }
    if workspace.join("pyproject.toml").exists() {
        return Some("pytest".to_string());
    }
    if workspace.join("pom.xml").exists() {
        return Some("mvn test".to_string());
    }
    if workspace.join("build.gradle").exists() || workspace.join("build.gradle.kts").exists() {
        return Some("./gradlew test".to_string());
    }
    None
}

fn package_manager(workspace: &Path) -> &'static str {
    if workspace.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if workspace.join("yarn.lock").exists() {
        "yarn"
    } else if workspace.join("bun.lockb").exists() || workspace.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    }
}

fn first_meaningful_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(240).collect())
}

fn is_package_executor_command(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    lower.contains("npx ")
        || lower.contains("npm exec")
        || lower.contains("pnpm dlx")
        || lower.contains("yarn dlx")
        || lower.contains("bunx ")
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

    #[test]
    fn opencode_exit_message_includes_process_tail() {
        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg("exit 1")
            .status()
            .unwrap();
        let msg = opencode_exit_message(status, "File not found: Add a new slide\n");
        assert!(msg.contains("opencode exited with exit status: 1"));
        assert!(msg.contains("File not found: Add a new slide"));
    }

    #[test]
    fn opencode_tool_values_are_workspace_relative_when_possible() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::write(project.join("src/entry.txt"), "content").unwrap();
        let abs = project.join("src/entry.txt");
        assert_eq!(
            workspace_relative_tool_value(dir.path(), &abs.to_string_lossy()),
            "project/src/entry.txt"
        );
        assert_eq!(
            workspace_relative_tool_value(dir.path(), "project/src/entry.txt"),
            "project/src/entry.txt"
        );
        assert_eq!(
            opencode_file_arg(&project, "project/src/entry.txt").as_deref(),
            Some("src/entry.txt")
        );
        assert_eq!(
            opencode_file_arg(&project, &abs.to_string_lossy()).as_deref(),
            Some("src/entry.txt")
        );
        assert_eq!(
            opencode_file_arg(
                &project,
                &dir.path().join("other/src/entry.txt").to_string_lossy()
            ),
            None
        );
        assert_eq!(
            workspace_relative_tool_value(&project, "project/src/entry.txt"),
            "src/entry.txt"
        );
        assert_eq!(opencode_file_arg(dir.path(), "missing/entry.txt"), None);
    }

    #[test]
    fn selects_package_script_without_package_executors() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"test":"vitest","build":"vite build"}}"#,
        )
        .unwrap();
        assert_eq!(
            select_verification_command(dir.path()).as_deref(),
            Some("npm test -- --watchAll=false")
        );
    }

    #[test]
    fn appends_verification_status_when_model_omits_it() {
        let text = ensure_verification_status(
            "Updated src/foo.ts.",
            &[BashRecord {
                command: "npm test -- --watchAll=false".into(),
                status: "error".into(),
                output: "react-scripts: command not found".into(),
            }],
        );
        assert!(text.contains("Verification: `npm test -- --watchAll=false` failed or was blocked"));
        assert!(text.contains("react-scripts: command not found"));
    }

    #[test]
    fn structural_integration_wires_created_module_registry() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path();
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::write(
            project.join("src/index.js"),
            [
                "import OldWidget from './OldWidget';",
                "",
                "const widgets = [",
                "  { Component: OldWidget, title: OldWidget.title },",
                "].map((item) => item);",
                "",
                "export default widgets;",
                "",
            ]
            .join("\n"),
        )
        .unwrap();
        std::fs::write(
            project.join("src/OldWidget.jsx"),
            "const OldWidget = () => null;\nOldWidget.title = 'Old';\nexport default OldWidget;\n",
        )
        .unwrap();
        let before = snapshot_workspace(project);
        std::fs::write(
            project.join("src/CreditsWidget.jsx"),
            "const CreditsWidget = () => null;\nexport default CreditsWidget;\n",
        )
        .unwrap();
        let after = snapshot_workspace(project);
        let applied = run_structural_integration_fallback(
            project,
            &before,
            &after,
            "Add a new widget called Credits",
            &["src/index.js".into()],
        )
        .unwrap();
        let index = std::fs::read_to_string(project.join("src/index.js")).unwrap();
        let created = std::fs::read_to_string(project.join("src/CreditsWidget.jsx")).unwrap();
        assert!(applied.contains(&"src/index.js".to_string()));
        assert!(index.contains("import CreditsWidget from './CreditsWidget';"));
        assert!(index.contains("{ Component: CreditsWidget, title: CreditsWidget.title },"));
        assert!(created.contains("CreditsWidget.title = \"Credits\";"));
    }

    #[test]
    fn direct_patch_plan_applies_exact_search_replace_and_create() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path();
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::write(project.join("src/main.txt"), "alpha\nbeta\n").unwrap();
        let before = snapshot_workspace(project);
        let edits = vec![
            DirectPatchEdit {
                path: "src/main.txt".into(),
                search: Some("beta\n".into()),
                replace: "gamma\n".into(),
                create: false,
            },
            DirectPatchEdit {
                path: "src/new.txt".into(),
                search: None,
                replace: "created\n".into(),
                create: true,
            },
        ];

        let changed = apply_direct_patch_plan(project, &before, &edits).unwrap();

        assert_eq!(changed, vec!["src/main.txt", "src/new.txt"]);
        assert_eq!(
            std::fs::read_to_string(project.join("src/main.txt")).unwrap(),
            "alpha\ngamma\n",
        );
        assert_eq!(
            std::fs::read_to_string(project.join("src/new.txt")).unwrap(),
            "created\n",
        );
    }

    #[test]
    fn direct_patch_rejects_traversal_and_non_matching_search() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path();
        std::fs::write(project.join("main.txt"), "alpha\n").unwrap();
        let before = snapshot_workspace(project);
        let traversal = vec![DirectPatchEdit {
            path: "../outside.txt".into(),
            search: None,
            replace: "bad".into(),
            create: true,
        }];
        assert!(apply_direct_patch_plan(project, &before, &traversal)
            .unwrap_err()
            .contains("parent traversal"));

        let missing = vec![DirectPatchEdit {
            path: "main.txt".into(),
            search: Some("missing".into()),
            replace: "gamma".into(),
            create: false,
        }];
        assert!(apply_direct_patch_plan(project, &before, &missing)
            .unwrap_err()
            .contains("did not match"));
    }

    #[test]
    fn extracts_json_object_from_model_envelope() {
        let text = "Sure:\n```json\n{\"summary\":\"ok\",\"edits\":[]}\n```";
        assert_eq!(
            extract_first_json_object(text).as_deref(),
            Some("{\"summary\":\"ok\",\"edits\":[]}")
        );
    }
}
