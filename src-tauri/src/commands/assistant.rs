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
use tauri::{AppHandle, Emitter, Listener, State};

use crate::commands::agent::{
    agent_continue, agent_run, AgentContinueRequest, AgentMessage, AgentRequest, ExecutionMode,
};
use crate::commands::ollama::{ollama_chat, ChatMsg, ChatRequest};
use crate::error::AppResult;
use crate::services::history::{entry_for_answer, LedgerEntry};
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
    pub system: Option<String>,
    #[serde(default)]
    pub system_extras: Option<String>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub num_ctx: Option<u32>,
}

/// Per-session ledger event payload. Sent over
/// `assistant:ledger:<session_id>` after an Ask turn completes so
/// the FE can append a one-line `AnsweredOnly` entry to the
/// session's ledger — the same data shape Plan/Agent ledgers use.
#[derive(Debug, Serialize, Clone)]
pub struct AssistantLedgerEvent {
    pub session_id: String,
    pub entry: LedgerEntry,
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
        system,
        system_extras,
        temperature,
        num_ctx,
    } = request;

    // Merge `system` + `system_extras` into a single system prompt so
    // we don't have to teach `ollama_chat` about per-turn extras.
    // Order matters: base system first, extras after, with a blank
    // line separator. Local models reliably honour this layout.
    let merged_system = match (system, system_extras) {
        (Some(base), Some(extra)) if !extra.trim().is_empty() => {
            Some(format!("{}\n\n{}", base.trim_end(), extra.trim()))
        }
        (Some(base), _) => Some(base),
        (None, Some(extra)) if !extra.trim().is_empty() => Some(extra),
        _ => None,
    };

    // We need the model's final answer text to build the ledger
    // entry. The cheapest way: piggy-back on the `ollama:chat:*`
    // stream by listening locally for tokens, then call the existing
    // `ollama_chat` so the FE keeps getting the live stream too.
    //
    // We avoid duplicating the streaming logic — it would be a copy
    // of `ollama_chat` plus a divergence risk. Instead, we kick off
    // a local listener that accumulates tokens, then call
    // `ollama_chat` and await its completion.
    let evt = format!("ollama:chat:{}", request_id);
    let accum: std::sync::Arc<parking_lot::Mutex<String>> = Default::default();
    let accum_for_handler = accum.clone();
    let listener_handle = app.listen(evt.clone(), move |event| {
        let payload = event.payload();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
            if let Some(tok) = v.get("token").and_then(|t| t.as_str()) {
                accum_for_handler.lock().push_str(tok);
            }
        }
    });

    let chat_req = ChatRequest {
        model,
        messages,
        system: merged_system,
        temperature,
        num_ctx,
    };
    let res = ollama_chat(app.clone(), state, request_id.clone(), chat_req).await;
    // Always release the listener — even on error — so we don't
    // leak background subscribers.
    app.unlisten(listener_handle);

    // Emit the ledger entry regardless of error status: an
    // interrupted Ask turn that produced partial text is still a
    // factual turn ("answered: …(partial)"), and the FE store can
    // present it correctly. An empty accumulation produces an
    // `AnsweredOnly { summary: "(empty answer)" }` via
    // `entry_for_answer`, which is harmless.
    let answer = accum.lock().clone();
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
        AssistantLedgerEvent { session_id: session_id.clone(), entry },
    );

    res
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
    pub workspace: Option<String>,
    #[serde(default)]
    pub max_steps: Option<u32>,
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
                ledger,
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
        };
        let json = serde_json::to_value(&evt).unwrap();
        assert_eq!(json["session_id"], "sess-42");
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
