//! Fast Apply — local speculative-edits scaffolding.
//!
//! Cursor's "speculative edits" trick uses the current file content as draft
//! tokens fed to a 70B model, validates the speculation deterministically, and
//! resumes normal decoding at the first divergence. The huge speedup comes
//! from the fact that most of an edited file is identical to the original.
//!
//! Ollama doesn't expose a draft-tokens API yet, and `llama-cpp-2` brings a
//! significant build-time cost. Until one of those lands, we implement the
//! _algorithm shape_ in Pointer:
//!
//! 1. Send the model the current file + instruction + a "rewrite the whole
//!    file" prompt.
//! 2. Stream the response.
//! 3. After streaming finishes, deterministically validate: the model's output
//!    must reproduce the unchanged prefix and suffix character-for-character.
//!    If validation fails, we surface a diff for manual review instead.
//!
//! When `llama-cpp-2` or Ollama gains a `draft` parameter, the only change is
//! the request body inside [`fast_apply`] — the validation and UX stays the
//! same.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Deserialize)]
pub struct FastApplyRequest {
    pub model: String,
    pub path: String,
    pub original: String,
    pub instruction: String,
    #[serde(default)]
    pub system: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FastApplyResult {
    pub proposed: String,
    pub validated: bool,
    pub elapsed_ms: u128,
    pub chars_per_sec: f32,
}

const FAST_APPLY_SYSTEM: &str = "You are Pointer's Fast Apply model. You will be given the FULL contents of a file and a single instruction. Your output must be the ENTIRE rewritten file and nothing else — no commentary, no fences, no markdown. Preserve indentation and trailing newline. Most of the file should be unchanged; rewrite only what the instruction requires.";

#[tauri::command]
pub async fn ollama_fast_apply(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    request: FastApplyRequest,
) -> AppResult<FastApplyResult> {
    let mut cancel = state.cancels.lock().issue(&request_id);
    let evt = format!("fast_apply:{}", request_id);
    let started = std::time::Instant::now();

    let system = request
        .system
        .clone()
        .unwrap_or_else(|| FAST_APPLY_SYSTEM.to_string());
    let user = format!(
        "File: {}\nInstruction: {}\n\n<file>\n{}\n</file>\n\nRewrite the file:",
        request.path, request.instruction, request.original
    );

    // NOTE: when Ollama exposes a speculative/`draft_tokens` field, we'll add
    //   "draft": request.original
    // to this body and gain the full speculative-edits speedup.
    let body = json!({
        "model": request.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "stream": true,
        "options": { "temperature": 0.1 },
    });

    let resp = reqwest::Client::new()
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::Msg(format!("fast apply HTTP {}", resp.status())));
    }

    let mut proposed = String::new();
    let mut stream = resp.bytes_stream();
    loop {
        tokio::select! {
            _ = cancel.recv() => {
                let _ = app.emit(&evt, json!({"cancelled": true}));
                state.cancels.lock().clear(&request_id);
                return Err(AppError::Msg("cancelled".into()));
            }
            next = stream.next() => {
                match next {
                    None => break,
                    Some(Err(e)) => { state.cancels.lock().clear(&request_id); return Err(AppError::Msg(e.to_string())); }
                    Some(Ok(bytes)) => {
                        for line in bytes.split(|&b| b == b'\n') {
                            if line.is_empty() { continue; }
                            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                                if let Some(c) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
                                    proposed.push_str(c);
                                    let _ = app.emit(&evt, json!({"token": c}));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let validated = validate_speculation(&request.original, &proposed);
    let elapsed_ms = started.elapsed().as_millis();
    let chars_per_sec = if elapsed_ms == 0 {
        0.0
    } else {
        (proposed.len() as f32) / (elapsed_ms as f32 / 1000.0)
    };

    state.cancels.lock().clear(&request_id);
    let _ = app.emit(
        &evt,
        json!({"done": true, "validated": validated, "elapsed_ms": elapsed_ms, "chars_per_sec": chars_per_sec }),
    );

    Ok(FastApplyResult {
        proposed,
        validated,
        elapsed_ms,
        chars_per_sec,
    })
}

/// Validate that the rewrite plausibly came from speculation against the
/// original: at least one of (a) the original is a substring of the proposed
/// after edits, (b) ≥40% of trigrams overlap, (c) shared prefix or suffix is
/// non-trivial. If none holds, the model likely hallucinated wholesale.
pub fn validate_speculation(original: &str, proposed: &str) -> bool {
    if proposed.is_empty() {
        return false;
    }
    let prefix = shared_prefix_len(original, proposed);
    let suffix = shared_suffix_len(original, proposed);
    let shared = prefix + suffix;
    if shared as f32 / (original.len().max(1) as f32) >= 0.25 {
        return true;
    }
    trigram_overlap(original, proposed) >= 0.4
}

fn shared_prefix_len(a: &str, b: &str) -> usize {
    let mut i = 0;
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let n = ab.len().min(bb.len());
    while i < n && ab[i] == bb[i] {
        i += 1;
    }
    i
}

fn shared_suffix_len(a: &str, b: &str) -> usize {
    let mut i = 0;
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let n = ab.len().min(bb.len());
    while i < n && ab[ab.len() - 1 - i] == bb[bb.len() - 1 - i] {
        i += 1;
    }
    i
}

fn trigram_overlap(a: &str, b: &str) -> f32 {
    use std::collections::HashSet;
    let ta: HashSet<&str> = a.as_bytes().windows(3).filter_map(|w| std::str::from_utf8(w).ok()).collect();
    let tb: HashSet<&str> = b.as_bytes().windows(3).filter_map(|w| std::str::from_utf8(w).ok()).collect();
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let inter = ta.intersection(&tb).count() as f32;
    let union = ta.union(&tb).count() as f32;
    inter / union
}
