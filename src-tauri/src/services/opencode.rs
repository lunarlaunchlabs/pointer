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
const CHANGE_SNAPSHOT_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const CHANGE_SNAPSHOT_MAX_TOTAL_BYTES: u64 = 96 * 1024 * 1024;
const PROCESS_TAIL_LIMIT: usize = 8_000;

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
        .arg(&model_arg)
        .arg("--agent")
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
    if !status.success() {
        let tail = process_tail.lock().await.clone();
        let msg = last_error.unwrap_or_else(|| opencode_exit_message(status, &tail));
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

    let change_records = if req.mode == OpenCodeMode::Agent {
        if let Some(before) = before_snapshot.as_ref() {
            let after = snapshot_workspace(&workspace);
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
            let plan =
                sanitize_verification_claims(&normalize_final_text(plan_source), &bash_records);
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
            let answer_source = if text_since_tool.trim().is_empty() {
                &out.text
            } else {
                &text_since_tool
            };
            let final_text = ensure_verification_status(
                &sanitize_verification_claims(&normalize_final_text(answer_source), &bash_records),
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
                        "limit": { "context": 32768, "output": 4096 }
                    }
                }
            }
        },
        "agent": {
            "pointer-ask": {
                "model": model_arg,
                "description": "Pointer Ask mode",
                "prompt": "Answer questions about the current codebase using read-only repository context. If the user asks about a named or attached file, read that file first and center the answer on that file rather than giving a broad repository overview. If attached context contains relevant file blocks or literal evidence lines that answer the question, answer directly from that context without using additional tools. If attached context contains <context-memory>, treat it as Pointer's deterministic retained source map: use its exact paths, symbols, imports, evidence lines, and reasons to ground the answer, but do not invent code that is not present in file blocks or repository reads. If the user asks how a behavior flows through the codebase, read the directly related definition and consumer files before answering. If a search finds the symbol or behavior, read the matching file before answering; do not answer from search snippets alone. For codebase research or source-path answers, name exact repository-relative file paths for each hop; do not stop at import specifiers such as ./utils. Unless the user explicitly asks for code samples, do not emit fenced code blocks in Ask mode; describe short code facts inline with backticks instead. For interface code, call out important state owners, event handlers, and conditional rendered UI when they are present. For routing questions, name the exact router components visible in the file, including Switch when it is present. For theme persistence questions, name the exact storage import/local variable and storage calls when they are visible, for example local-storage-fallback, storage.getItem, or storage.setItem only if those names appear in repository context. For editor or media-heavy components, mention file operations, upload/image handling, export, and persistence flows when those symbols are visible. When a file defines default/configuration methods, name the important literal setting keys and defaults visible in those methods. If attached context includes app.defaultConfiguration, app.set(...), or setting keys, name the important literal setting keys in the prose. Do not list bare prior-version method names such as mount or lazyrouter unless the file defines that exact method/export in the visible context. Include a compact Key identifiers sentence with 4-8 exact symbols, dotted assignments, method names, and configuration keys visible in the file; never list more than 8 identifiers and never repeat an identifier. If more than 8 identifiers are possible, choose the 8 most important. If a file defines dotted exported assignments such as object.method = function, name the dotted assignment exactly instead of only the bare method name. Key identifiers must be real identifiers or setting keys from the file, not synthesized property chains. Preserve literal identifiers exactly as they appear in files. Never copy identifier examples from instructions into the answer unless OpenCode actually saw them in repository content. Never output internal progress blocks or headings like ## Goal, ## Progress, Constraints, Next Steps, or Continue if you have next steps. Do not claim you lack access to a named, active, or attached file. Do not modify files.",
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
                "prompt": "Create executable engineering plans for the current codebase. Read the relevant files yourself before finalizing, but keep context gathering bounded. If attached context contains <context-memory>, use it as Pointer's deterministic retained source map to choose the next file, preserve exact paths, and avoid re-discovering facts already supplied. Required reads before final: the active file when relevant; the directly related implementation file; directly related existing verification or specification context when it can be found; and project configuration needed to name the verification command. For interface work, include both the state/logic file and the file that renders the affected UI. Use the repository's own structure and naming conventions to discover tests, specs, examples, snapshots, fixtures, or validation commands; do not assume a language, framework, package manager, or test runner. Do not finalize until relevant verification context has been read or you explicitly state what you checked and that none exists. After reading the source, verification context, and project configuration, finalize instead of continuing to search. Do not propose framework or router API migrations unless package/config context proves the installed major version supports the target API; preserve current dependency major versions for behavior-preserving refactors. For theme/refactor plans, distinguish styled-components ThemeProvider from a custom React context. Do not claim components consume a custom context unless the code shows a hook/provider; if props are used, say props are used. Do not assume a reported bug exists: compare the proposed fix to the code you read. If the code already contains the proposed source change, do not claim it is missing; produce a no-source-change or regression-test-only plan and cite the exact existing behavior. If the user asks for a refactor, cleanup, feature, or creative change, do not no-op merely because the current behavior works; produce a behavior-preserving implementation plan. If the evidence disproves the suspected bug, do not restate that suspected bug as true anywhere in the final answer. If the final plan is no-source-change, the Assessment must not say the reported bug exists, remains visible, does not re-render, or still needs a source fix. Do not edit, write, delete, rename, run shell commands, create todos, use skills, or delegate to tasks. Final response format: Context read: exact paths; Assessment: what the code proves; Plan: exact changes or no-source-change rationale; Verification: exact narrow command. Final output must be under 180 words and contain no internal debate, self-correction, or discarded hypotheses. Verification must name an actual project command from repository configuration when available. Always include at least one exact narrow verification command the user can run; prefer the narrowest existing verification that covers the touched behavior. Plan verification commands must be executable by Agent mode without package executors: never use npx, npm exec, pnpm dlx, yarn dlx, or bunx in a plan. Prefer package scripts such as npm test, npm run test:run, npm run build, cargo test, go test, pytest, or the repository's configured equivalent. If the existing code is already correct, say that directly and cite the files and verification evidence that prove it, plus the exact command to rerun that verification.",
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
                "prompt": "Implement the user's requested code change in the current repository. Gather the minimum necessary context, edit only files required for the task, preserve unrelated structure and assets, and verify with the narrowest existing project command when available even if the user did not explicitly ask to run tests. If attached context contains <context-memory>, use it as Pointer's deterministic retained source map to choose the next file, preserve exact paths, and avoid re-discovering facts already supplied. If package scripts or equivalent project commands exist, attempt the narrowest relevant command after editing unless a command is explicitly forbidden. After any successful edit, a final answer with zero bash verification attempts is invalid; run a verification command or attempt one and report the real blocker before finalizing. If the user asks to add or update tests, you must edit or create the relevant test/spec file even when verification cannot run. Do not install, add, remove, or update dependencies unless the user explicitly asks; if verification is blocked by missing dependencies, report the blocked command instead of changing dependency state. Never run or even attempt package executors: npx, npm exec, pnpm dlx, yarn dlx, or bunx are forbidden even for eslint, vitest, mocha, or one-off probing. Use scripts already present in package.json such as npm test, npm run test:run, npm run build, npm run lint, or npm run typecheck. If no relevant script exists, use the closest existing script or report that verification is blocked; do not invent an npx command. If package.json, Cargo.toml, pyproject.toml, or similar config defines verification scripts, do not claim verification commands are unavailable; missing dependencies mean verification was blocked or failed, not absent. Do not run destructive git commands, pushes, resets, cleanups, or broad filesystem deletion. Final response must be concise, non-repetitive, and focused on changed files plus a Verification: sentence naming the exact command attempted or the exact blocked command. Never say verification was skipped because the user did not ask, because the change was minimal, or because of user constraints.",
                "permission": {
                    "edit": "allow",
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
}
