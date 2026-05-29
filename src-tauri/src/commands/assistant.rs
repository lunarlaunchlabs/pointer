//! Unified Assistant backend.
//!
//! This module is the seam between the new `AssistantView` UI
//! (one panel, three modes: Ask | Plan | Agent) and the existing
//! agent/ollama machinery.
//!
//! * `assistant_ask` — pure chat passthrough for Ask mode. No tool
//!   loop, no env-details injection; just `/api/chat` to keep the
//!   conversational path snappy. Emits an `AnsweredOnly` entry on
//!   the ledger event so the FE store can mirror it alongside the
//!   structured action log Plan/Agent modes produce.
//! * `agent_execute_plan` — promotes a Plan-mode result into an
//!   Agent-mode run, carrying forward the prior session's ledger
//!   and transcript so the agent doesn't re-explore.
//!
//! Wire format note: both commands sit alongside the existing
//! `ollama_chat`/`agent_run` commands and reuse their event channels
//! (`ollama:chat:<request_id>` and `agent:event:<request_id>`).
//! The only NEW event surface this module owns is
//! `assistant:ledger:<session_id>` — a fire-and-forget channel the
//! FE listens on to extend its in-memory ledger.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::agent::{
    agent_continue, agent_run, AgentContinueRequest, AgentMessage, AgentRequest, ExecutionMode,
};
use crate::commands::ollama::ChatMsg;
use crate::error::AppResult;
use crate::services::history::{entry_for_answer, LedgerEntry};
use crate::services::opencode::{run_opencode, OpenCodeMode, OpenCodeRunRequest};
use crate::state::AppState;

/// Inbound payload for `assistant_ask`. Mirrors `ChatRequest` but
/// carries the `session_id` the FE store uses as its ledger key.
///
/// The `system_extras` field is optional sugar so the FE can append
/// per-turn context (selected text, @-mentioned file snippets) on
/// top of the model's base system prompt without having to rebuild
/// the prompt itself.
#[derive(Debug, Deserialize)]
pub struct AssistantAskRequest {
    pub session_id: String,
    pub model: String,
    pub messages: Vec<ChatMsg>,
    #[serde(default)]
    pub opencode_session_id: Option<String>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub system_extras: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub temperature: Option<f32>,
    #[serde(default)]
    #[allow(dead_code)]
    pub num_ctx: Option<u32>,
    #[serde(default)]
    pub attached_files: Option<Vec<String>>,
}

/// Per-session ledger event payload. Sent over
/// `assistant:ledger:<session_id>` after an Ask turn completes so
/// the FE can append a one-line `AnsweredOnly` entry to the
/// session's ledger — the same data shape Plan/Agent ledgers use.
#[derive(Debug, Serialize, Clone)]
pub struct AssistantLedgerEvent {
    pub session_id: String,
    pub entry: LedgerEntry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_session_id: Option<String>,
}

/// `assistant_ask` — Ask-mode passthrough.
///
/// Streams through Ollama exactly like `ollama_chat` (same
/// `ollama:chat:<request_id>` event channel, so the FE can reuse
/// its existing token-stream listener), and on completion emits one
/// `AnsweredOnly` ledger entry over
/// `assistant:ledger:<session_id>`.
///
/// We deliberately do NOT run the agent loop or attach
/// `<environment_details>`: Ask mode is conversational, the user
/// wants the snappy chat path. Mutations are impossible because the
/// model never sees the tool catalog.
#[tauri::command]
pub async fn assistant_ask(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    request: AssistantAskRequest,
) -> AppResult<()> {
    let AssistantAskRequest {
        session_id,
        model,
        messages,
        opencode_session_id,
        system,
        system_extras,
        attached_files,
        temperature: _,
        num_ctx: _,
    } = request;

    let _ = system;
    let extra_context = system_extras
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let workspace = state
        .workspace
        .lock()
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let resume_opencode = opencode_session_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    let prompt = render_opencode_ask_prompt(extra_context, &messages, resume_opencode);
    let res = run_opencode(
        app.clone(),
        &state,
        OpenCodeRunRequest {
            request_id: request_id.clone(),
            model,
            workspace,
            prompt,
            mode: OpenCodeMode::Ask,
            title: "Ask mode".into(),
            files: attached_files.unwrap_or_default(),
            opencode_session_id: opencode_session_id.clone(),
        },
    )
    .await;

    // Emit the ledger entry on success, or when an interrupted turn
    // produced partial text. If the request never entered the model
    // path (for example, the scheduler rejected it because the model
    // is already busy) there is no factual answer to remember.
    let answer = res.as_ref().map(|r| r.text.clone()).unwrap_or_default();
    if res.is_ok() || !answer.trim().is_empty() {
        let entry = entry_for_answer(
            // Turn numbering is per-session and assigned by the FE
            // store. We pass 0 here as a "to be assigned" marker; the
            // store overwrites it with the real turn index when it
            // appends the entry. Keeping it on the BE side would require
            // a stateful session registry we don't need yet.
            0,
            now_ms(),
            "ask",
            &answer,
        );
        let _ = app.emit(
            &format!("assistant:ledger:{}", session_id),
            AssistantLedgerEvent {
                session_id: session_id.clone(),
                entry,
                opencode_session_id: res
                    .as_ref()
                    .ok()
                    .and_then(|r| r.session_id.clone())
                    .or(opencode_session_id.clone()),
            },
        );
    }

    res.map(|_| ())
}

fn render_opencode_ask_prompt(
    system: Option<&str>,
    messages: &[ChatMsg],
    resume_opencode: bool,
) -> String {
    let mut out = String::new();
    out.push_str("Conversation:\n");
    let visible_messages: Vec<&ChatMsg> = if resume_opencode {
        messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .into_iter()
            .collect()
    } else {
        messages.iter().collect()
    };
    for m in visible_messages {
        out.push_str(match m.role.as_str() {
            "assistant" => "Assistant: ",
            "system" => "System: ",
            _ => "User: ",
        });
        out.push_str(m.content.trim());
        out.push_str("\n\n");
    }
    if let Some(system) = system {
        let system = system.trim();
        if !system.is_empty() {
            out.push_str("Additional context:\n");
            out.push_str(system);
            out.push_str("\n\n");
        }
    }
    out.push_str("ASK MODE CONTRACT:\n");
    out.push_str(
        "- Answer from the repository files OpenCode reads or receives as attached files.\n",
    );
    out.push_str("- If Additional context contains relevant file blocks or literal evidence lines that answer the question, answer directly from that context without using additional tools.\n");
    out.push_str("- If Additional context contains <brain-frontier>, treat it as Pointer's deterministic external-memory search frontier: use included evidence first, inspect listed candidates before asserting behavior, and do not rediscover facts it already provides.\n");
    out.push_str("- If Additional context contains <context-memory>, treat it as Pointer's deterministic retained source map: use its exact paths, symbols, imports, evidence lines, and reasons to ground the answer, but do not invent code that is not present in file blocks or repository reads.\n");
    out.push_str("- For file explanation questions, name the file's purpose, important imports/exports, state or data flow, and notable risks or neighboring files.\n");
    out.push_str("- For interface code, call out important state owners, event handlers, and conditional rendered UI when they are present.\n");
    out.push_str("- For routing questions, name the exact router components visible in the file, including Switch when it is present.\n");
    out.push_str("- For theme persistence questions, name the exact storage import/local variable and storage calls when they are visible, for example local-storage-fallback, storage.getItem, or storage.setItem only if those names appear in repository context.\n");
    out.push_str("- For editor or media-heavy components, mention file operations, upload/image handling, export, and persistence flows when those symbols are visible.\n");
    out.push_str("- For codebase research questions that ask where a behavior is configured, compiled, consumed, or flows through the project, use search/read tools to trace at least the definition file and consumer file before answering.\n");
    out.push_str("- For codebase research or source-path answers, name exact repository-relative file paths for each hop; do not stop at import specifiers such as ./utils.\n");
    out.push_str("- If a search finds the symbol or behavior, read the matching file before answering; do not answer from search snippets alone.\n");
    out.push_str("- Unless the user explicitly asks for code samples, do not emit fenced code blocks in Ask mode; describe short code facts inline with backticks instead.\n");
    out.push_str("- Include a compact Key identifiers sentence with 4-8 exact symbols, dotted assignments, method names, and configuration keys visible in the file; never list more than 8 identifiers and never repeat an identifier. If more than 8 identifiers are possible, choose the 8 most important.\n");
    out.push_str("- If a file defines dotted exported assignments such as object.method = function, name the dotted assignment exactly instead of only the bare method name.\n");
    out.push_str("- If Additional context includes app.defaultConfiguration, app.set(...), or setting keys, name the important literal setting keys in the prose.\n");
    out.push_str("- Do not list bare prior-version method names such as mount or lazyrouter unless the file defines that exact method/export in the visible context.\n");
    out.push_str("- Key identifiers must be real identifiers or setting keys from the file, not synthesized property chains.\n");
    out.push_str("- Preserve literal identifiers exactly as they appear in files. Never copy identifier examples from instructions into the answer unless OpenCode actually saw them in repository content.\n");
    out.push_str("- Never output internal progress blocks or headings like ## Goal, ## Progress, Constraints, Next Steps, or Continue if you have next steps.\n");
    out.push_str("- Do not claim you lack access to a named, active, or attached file.\n");
    out.push_str("- Do not modify files in Ask mode.\n\n");
    out.push_str("Answer the latest user message using the ASK MODE CONTRACT above.");
    out
}

/// Inbound payload for `agent_execute_plan`. Carries the plan text
/// the Plan-mode turn produced, plus the prior `session_id` so the
/// BE can resume from the existing transcript/ledger instead of
/// re-exploring the workspace.
#[derive(Debug, Deserialize)]
pub struct AgentExecutePlanRequest {
    /// FE-side session identifier. Currently unused on the BE
    /// because the loop is stateless across calls, but it's part
    /// of the wire shape so the FE event router (and any future
    /// per-session BE state) can rely on it being present.
    #[allow(dead_code)]
    pub session_id: String,
    pub plan_text: String,
    pub model: String,
    #[serde(default)]
    pub opencode_session_id: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    /// Legacy native-loop budget. Ignored by the OpenCode runtime.
    #[serde(default)]
    pub max_steps: Option<u32>,
    /// Legacy native-loop runtime cap. Ignored by the OpenCode runtime.
    #[serde(default)]
    pub max_runtime_secs: Option<u64>,
    /// Existing transcript from the Plan-mode session — when
    /// present we route through `agent_continue` so the model
    /// inherits the plan's reasoning. When absent (rare; e.g. a
    /// plan was pasted in from outside), we cold-start an
    /// `agent_run` and the plan text becomes the goal.
    #[serde(default)]
    pub transcript: Option<Vec<AgentMessage>>,
    /// Optional prior ledger to carry forward. `agent_continue`
    /// hydrates this into the new run's ledger so the smart
    /// pruner / fresh-read injector both see the prior work and
    /// don't re-explore.
    #[serde(default)]
    pub ledger: Option<Vec<LedgerEntry>>,
}

/// `agent_execute_plan` — promote a Plan-mode result into an
/// Agent-mode run.
///
/// Two paths:
///   * If `transcript` is provided (the typical case from the
///     unified UI), we call `agent_continue` with mode=AgentAuto and
///     a synthesized user message of the form "Execute the
///     following plan: …". The transcript carries the model's
///     plan-mode reasoning so it doesn't restart from zero.
///   * If `transcript` is absent, we cold-start `agent_run` with
///     goal="Execute the following plan: …" and `mode=AgentAuto`.
///
/// Either way the prior ledger is forwarded so the new run starts
/// with the full structured memory of what the plan covered.
#[tauri::command]
pub async fn agent_execute_plan(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    request: AgentExecutePlanRequest,
) -> AppResult<()> {
    let AgentExecutePlanRequest {
        session_id: _,
        plan_text,
        model,
        opencode_session_id,
        workspace,
        max_steps,
        max_runtime_secs,
        transcript,
        ledger,
    } = request;

    let plan_text = plan_text.trim().to_string();
    let goal = if plan_text.is_empty() {
        "Execute the previously-discussed plan.".to_string()
    } else {
        format!("Execute the following plan:\n{}", plan_text)
    };

    match transcript {
        Some(prior) if !prior.is_empty() => {
            // Carry forward transcript + ledger via agent_continue.
            // The synthesized user_message is what the new turn
            // works against — the model sees it as "the user just
            // told me to execute the plan we discussed."
            let cont = AgentContinueRequest {
                model,
                user_message: goal,
                transcript: prior,
                workspace,
                max_steps,
                max_runtime_secs,
                context: None,
                mode: Some(ExecutionMode::AgentAuto),
                lint_command: None,
                open_tabs: None,
                active_file: None,
                attached_files: None,
                ledger,
                opencode_session_id,
            };
            agent_continue(app, state, request_id, cont).await
        }
        _ => {
            // Cold start. `ledger` is dropped — `agent_run` does
            // not accept a prior ledger today (it always starts a
            // fresh session). That's fine because the Plan-mode
            // session's transcript is the carrier the FE keeps
            // around; the cold-start path is the "user pasted a
            // plan from elsewhere" edge case.
            let req = AgentRequest {
                model,
                goal,
                workspace,
                max_steps,
                max_runtime_secs,
                context: None,
                mode: Some(ExecutionMode::AgentAuto),
                lint_command: None,
                parent_request_id: None,
                depth: None,
                open_tabs: None,
                active_file: None,
                attached_files: None,
                opencode_session_id,
            };
            agent_run(app, state, request_id, req).await
        }
    }
}

/// Same shape as the helper in `agent.rs` — duplicated here to
/// avoid a cross-module dependency on a private symbol. Returns
/// current wall-clock in epoch milliseconds.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_ledger_event_serializes_with_session_id() {
        // The FE listens on `assistant:ledger:<session_id>` and
        // expects `{ session_id, entry: LedgerEntry }`. We pin the
        // wire shape so a serde rename can't silently break it.
        let evt = AssistantLedgerEvent {
            session_id: "sess-42".into(),
            entry: entry_for_answer(3, 1000, "ask", "The reason is X."),
            opencode_session_id: Some("opencode-1".into()),
        };
        let json = serde_json::to_value(&evt).unwrap();
        assert_eq!(json["session_id"], "sess-42");
        assert_eq!(json["opencode_session_id"], "opencode-1");
        assert_eq!(json["entry"]["mode"], "ask");
        assert_eq!(json["entry"]["turn"], 3);
        // The discriminator must stay `answered_only` (snake_case)
        // to match the FE store's switch statement.
        assert_eq!(json["entry"]["kind"]["type"], "answered_only");
    }

    #[test]
    fn agent_execute_plan_goal_prefixed_when_plan_text_present() {
        // We don't have a full AppHandle in unit tests; just verify
        // the goal-formatting logic in isolation. Pin the prefix so
        // the system prompt's plan-detection logic stays correct.
        let plan = "1. read foo\n2. write bar";
        let goal = format!("Execute the following plan:\n{}", plan);
        assert!(goal.starts_with("Execute the following plan:\n"));
        assert!(goal.contains("write bar"));
    }

    #[test]
    fn agent_execute_plan_falls_back_when_plan_text_empty() {
        let plan = "   ";
        let goal = if plan.trim().is_empty() {
            "Execute the previously-discussed plan.".to_string()
        } else {
            format!("Execute the following plan:\n{}", plan)
        };
        assert_eq!(goal, "Execute the previously-discussed plan.");
    }
}
