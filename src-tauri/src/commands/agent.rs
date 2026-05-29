//! Legacy native agent harness.
//!
//! Design goals
//! ============
//! The active Pointer Ask / Plan / Agent runtime is OpenCode (see
//! `use_opencode_agent_runtime`). This native loop remains compiled for
//! migration and rollback while older session stores drain out.
//!
//! * Model-agnostic: we drive vanilla chat completions and ask the model to
//!   emit XML-ish tool blocks. This works reliably with Qwen2.5-Coder /
//!   DeepSeek-Coder-V2 / Llama 3 / Mistral without requiring native tool calls.
//! * Safe-by-default: destructive tools (`write_file`, `apply_diff`,
//!   `run_shell`, `delete_path`, `rename_path`) are gated on the agent
//!   `execution_mode`:
//!     - `plan`  — read-only; rejects all mutations.
//!     - `ask`   — emits an `approval_request` event and waits for the UI's
//!       `agent_approve` / `agent_reject` round-trip before mutating.
//!     - `auto`  — applies immediately (yolo mode for the brave).
//! * Self-correcting: after a mutation we run a deterministic verifier
//!   (re-read the file, optional `lint_command`) and feed the report back into
//!   the next turn so the model can fix what it broke.
//! * Observable: every transition (`step_start`, `request_sent`,
//!   `first_token`, `tool_call`, `tool_result`, `approval_request`,
//!   `verifier`, `plan`, `clarify`, `final`, `error`, `done`) emits a typed
//!   event so the frontend can render each step as a structured card.
//!
//! Tool surface
//! ============
//! Read-only:
//!   <read_file path="...">                  Read up to N KB (with offset/limit support).
//!   <list_dir path="...">                   List a directory (≤500 entries).
//!   <glob>pattern</glob>                    File discovery via `ignore` walker + glob match.
//!   <grep>pattern</grep>                    Literal text search across the workspace.
//!   <search_codebase>natural query</search_codebase>   Semantic search over the indexer.
//!   <think>scratch reasoning</think>        Free-form thought; not executed.
//!
//! Mutating (mode-gated):
//!   <write_file path="...">FULL FILE</write_file>
//!   <apply_diff path="...">SEARCH/REPLACE HUNKS</apply_diff>
//!   <delete_path>path</delete_path>
//!   <rename_path from="a" to="b" />
//!   <run_shell timeout_ms="...">cmd</run_shell>
//!
//! Control:
//!   <plan>1. step\n2. step\n…</plan>        Optional pre-execution plan.
//!   <task title="...">sub-goal</task>       Spawn a sub-agent (depth-limited).
//!   <clarify>question</clarify>             Ask the user; terminate with REQUIRES_INPUT.
//!   <final>summary</final>                  Done; terminates the loop.

#![allow(clippy::too_many_arguments)]

use crate::error::AppResult;
use crate::services::history::{entry_for_answer, entry_for_tool, ActionLedger, LedgerEntry};
use crate::services::inference::{acquire_inference, InferenceClaim, InferencePolicy};
use crate::services::opencode::{run_opencode, OpenCodeMode, OpenCodeRunRequest};
use crate::state::AppState;
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

const AGENT_SYSTEM: &str = include_str!("../../prompts/agent_system.txt");
/// Preflight-only prompt: small, tool-free system message that asks the
/// model to predict the step budget needed for a goal. Kept separate
/// from `AGENT_SYSTEM` because it changes much less often and the
/// estimator must NEVER think it's allowed to call tools.
const AGENT_ESTIMATOR: &str = include_str!("../../prompts/agent_estimator.txt");
/// Tuned for the kinds of multi-step tasks the larger local
/// checkpoints (qwen2.5-coder 14B/32B, deepseek-coder 33B) can
/// actually finish — e.g. "scaffold a new app with routing and a
/// login page". The previous 20-step / 10-minute caps were sized
/// for 7B models doing single-file fixes; they cut off larger
/// models mid-flow.
const DEFAULT_MAX_STEPS: u32 = 30;
const DEFAULT_MAX_RUNTIME_S: u64 = 1500;
/// Per-assistant-turn output cap. Smaller checkpoints stay well
/// under 1K tokens but the 32B family routinely emits 1.5–2K
/// tokens (verbose plans, full-file writes, detailed finals) and
/// hitting the cap mid-write produces malformed tool calls.
const DEFAULT_NUM_PREDICT: u64 = 2048;
const READ_FILE_DEFAULT_LIMIT: usize = 12_000;
pub(crate) const TOOL_RESULT_TRUNCATE: usize = 8_000;
const SUBTASK_MAX_DEPTH: u32 = 1;
/// Max seconds we wait for the NEXT byte from Ollama's streaming
/// response before declaring the model hung. The window is per
/// chunk (it resets on every received chunk), so the first chunk
/// has this entire budget to cover model warm-up (loading the
/// weights into VRAM can take 30+ seconds on a cold start), and
/// subsequent chunks rarely take more than a fraction of a second.
/// 90 s is generous enough to cover cold loads of 32 B models on
/// modest hardware without leaving the UI staring at a frozen
/// "thinking…" indicator forever — the failure mode that prompted
/// this whole skill / watchdog initiative.
const STREAM_IDLE_TIMEOUT_S: u64 = 90;

/// Execution stance for the agent loop.
///
/// Variant naming matches the unified Assistant UI:
/// `Plan` is read-only (no mutations), `AgentApprove` runs the
/// full tool loop but pauses on mutations for human approval, and
/// `AgentAuto` runs everything autonomously.
///
/// The wire format keeps the original `"ask"` / `"auto"` strings
/// for backwards compatibility with existing FE callers; new
/// callers may also use `"agent_approve"` / `"agent_auto"`. The
/// top-level UI `Ask` mode (chat-only, no tools) is NOT an
/// `ExecutionMode` — it goes through `assistant_ask` instead and
/// never enters the agent loop.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
pub enum ExecutionMode {
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "ask", alias = "agent_approve")]
    #[default]
    AgentApprove,
    #[serde(rename = "auto", alias = "agent_auto")]
    AgentAuto,
}

#[derive(Debug, Deserialize)]
pub struct AgentRequest {
    pub model: String,
    pub goal: String,
    #[serde(default)]
    pub workspace: Option<String>,
    /// Legacy native-loop budget. Ignored by the OpenCode runtime.
    #[serde(default)]
    pub max_steps: Option<u32>,
    /// Legacy native-loop runtime cap. Ignored by the OpenCode runtime.
    #[serde(default)]
    pub max_runtime_secs: Option<u64>,
    #[serde(default)]
    pub opencode_session_id: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub mode: Option<ExecutionMode>,
    #[serde(default)]
    pub lint_command: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub parent_request_id: Option<String>,
    #[serde(default)]
    pub depth: Option<u32>,
    /// Editor state the frontend chooses to share with the agent —
    /// open tab paths (relative to workspace) and the currently-
    /// focused file. Surfaced to the model via `<environment_details>`
    /// on every turn so it stays grounded in what the user is looking
    /// at without having to ask.
    #[serde(default)]
    pub open_tabs: Option<Vec<String>>,
    #[serde(default)]
    pub active_file: Option<String>,
    #[serde(default)]
    pub attached_files: Option<Vec<String>>,
}

/// Follow-up turn on an existing session. Same surface as `AgentRequest`
/// minus `goal`/`parent_request_id`/`depth` (a continued turn always
/// belongs to the original session and runs at the same depth), and
/// plus the prior Ollama `transcript` + the new `user_message`. The
/// backend appends the message to the transcript and runs the same
/// loop; no fresh `system + user_brief` is built — the model picks up
/// exactly where it left off.
#[derive(Debug, Deserialize)]
pub struct AgentContinueRequest {
    pub model: String,
    pub user_message: String,
    pub transcript: Vec<AgentMessage>,
    #[serde(default)]
    pub workspace: Option<String>,
    /// Legacy native-loop budget. Ignored by the OpenCode runtime.
    #[serde(default)]
    pub max_steps: Option<u32>,
    /// Legacy native-loop runtime cap. Ignored by the OpenCode runtime.
    #[serde(default)]
    pub max_runtime_secs: Option<u64>,
    #[serde(default)]
    pub opencode_session_id: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub mode: Option<ExecutionMode>,
    #[serde(default)]
    pub lint_command: Option<String>,
    #[serde(default)]
    pub open_tabs: Option<Vec<String>>,
    #[serde(default)]
    pub active_file: Option<String>,
    #[serde(default)]
    pub attached_files: Option<Vec<String>>,
    /// Prior action ledger persisted by the FE. When present we
    /// resume the same factual record so the model sees one
    /// `<previous_work>` block covering every turn of the session,
    /// not just whatever survived in the raw transcript.
    #[serde(default)]
    pub ledger: Option<Vec<LedgerEntry>>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct AgentMessage {
    pub role: String,
    pub content: String,
}

/// Tool-free preflight planning request — produces the `{steps, summary}`
/// budget estimate the UI uses to pre-fill the Max-steps input.
#[derive(Debug, Deserialize)]
pub struct AgentEstimateRequest {
    pub model: String,
    pub goal: String,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub mode: Option<ExecutionMode>,
}

#[derive(Debug, Serialize)]
pub struct AgentEstimateResult {
    pub steps: u32,
    pub summary: String,
}

/// In-flight approvals indexed by request_id. The frontend resolves them via
/// `agent_approve` / `agent_reject`.
struct Approval {
    tx: oneshot::Sender<ApprovalDecision>,
}

#[derive(Debug, Clone)]
struct ApprovalDecision {
    approved: bool,
    note: Option<String>,
}

static APPROVALS: once_cell::sync::Lazy<Mutex<HashMap<String, Approval>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

/// In-flight budget-bump requests indexed by request_id. Sibling of
/// `APPROVALS` — the loop pauses on `rx` after emitting a
/// `budget_bump_request` event, and the frontend resolves the pause
/// via `agent_budget_decision` (or implicitly via `agent_cancel`,
/// which sends `Cancel`).
struct BudgetBump {
    tx: oneshot::Sender<BudgetDecision>,
}

#[derive(Debug, Clone)]
enum BudgetDecision {
    /// Take the model's proposed value verbatim.
    Accept,
    /// Use the user's explicit override instead of the model's value.
    Override(u32),
    /// Tear down the run.
    Cancel,
}

static BUDGET_BUMPS: once_cell::sync::Lazy<Mutex<HashMap<String, BudgetBump>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

/// Parsed tool call from a streamed assistant turn.
///
/// Visible to sibling crate modules (e.g. `services::skills`) so
/// skill implementations can be composed of the same primitives the
/// agent loop dispatches directly.
#[derive(Debug, Clone)]
pub(crate) struct ToolCall {
    pub(crate) tool: String,
    pub(crate) attrs: HashMap<String, String>,
    pub(crate) body: String,
    /// Hash of (tool, attrs, body) for dedup detection.
    pub(crate) fingerprint: u64,
}

#[tauri::command]
pub async fn agent_run(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    request: AgentRequest,
) -> AppResult<()> {
    // First turn of a session. We build a fresh `system + user_brief`
    // transcript here and hand the loop the result. Follow-up turns
    // go through `agent_continue`, which reuses the same loop helper
    // with the prior transcript instead.
    let mode = request.mode.unwrap_or_default();
    let depth = request.depth.unwrap_or(0);
    let lint_command = request.lint_command.clone();

    let workspace = request
        .workspace
        .or_else(|| {
            state
                .workspace
                .lock()
                .as_ref()
                .map(|p| p.display().to_string())
        })
        .unwrap_or_default();
    let workspace = canonical_workspace_string(workspace);
    let evt = format!("agent:event:{}", request_id);

    let open_tabs = request.open_tabs.clone().unwrap_or_default();
    let active_file = request.active_file.clone();
    let attached_files = request.attached_files.clone().unwrap_or_default();
    let opencode_mode = if mode == ExecutionMode::Plan {
        OpenCodeMode::Plan
    } else {
        OpenCodeMode::Agent
    };
    let prompt = render_opencode_agent_prompt(
        &workspace,
        mode,
        request.context.as_deref(),
        &request.goal,
        &open_tabs,
        active_file.as_deref(),
    );
    if use_opencode_agent_runtime() {
        let _ = app.emit(
            &evt,
            json!({
                "kind": "started",
                "mode": mode,
                "depth": depth,
                "workspace": workspace,
                "runtime": "opencode",
            }),
        );
        return run_opencode(
            app.clone(),
            &state,
            OpenCodeRunRequest {
                request_id: request_id.clone(),
                model: request.model.clone(),
                workspace: workspace.clone(),
                prompt,
                mode: opencode_mode,
                title: match opencode_mode {
                    OpenCodeMode::Plan => "Plan mode".into(),
                    OpenCodeMode::Agent => "Agent mode".into(),
                    OpenCodeMode::Ask => "Ask mode".into(),
                },
                files: attached_files,
                opencode_session_id: request.opencode_session_id.clone(),
            },
        )
        .await
        .map(|_| ());
    }

    let max_steps = request.max_steps.unwrap_or(DEFAULT_MAX_STEPS).max(1);
    let max_runtime = Duration::from_secs(
        request
            .max_runtime_secs
            .unwrap_or(DEFAULT_MAX_RUNTIME_S)
            .max(15),
    );
    let _ = app.emit(
        &evt,
        json!({
            "kind": "started",
            "mode": mode,
            "max_steps": max_steps,
            "depth": depth,
            "workspace": workspace,
            "runtime": "native",
        }),
    );

    // Compose the system prompt:
    //   - the static AGENT_SYSTEM contract,
    //   - then dynamic sections appended below: project rules and the live
    //     MCP tool catalog so the model knows what's available without us
    //     having to bake them into the prompt file.
    let mut system_prompt = String::from(AGENT_SYSTEM);
    if let Some(rules) = load_project_rules(&workspace) {
        system_prompt.push_str("\n\n==================== PROJECT RULES ====================\n");
        system_prompt.push_str(&rules);
        system_prompt.push('\n');
    }
    let mcp_tools = state.mcp.all_tools();
    if !mcp_tools.is_empty() {
        system_prompt.push_str(&render_mcp_section(&mcp_tools));
    }

    let transcript: Vec<Value> = vec![
        json!({"role": "system", "content": system_prompt}),
        json!({
            "role": "user",
            "content": render_user_brief(&workspace, mode, &request.context, &request.goal),
        }),
    ];

    run_agent_loop(
        app,
        state,
        request_id,
        request.model,
        workspace,
        mode,
        max_steps,
        max_runtime,
        lint_command,
        depth,
        open_tabs,
        active_file,
        transcript,
        ActionLedger::new(),
    )
    .await
}

/// Follow-up turn on an existing session. The caller hands us the prior
/// Ollama transcript (captured by the FE via a `transcript_snapshot`
/// event at the end of the previous turn) plus a fresh `user_message`,
/// and we resume the same conversation — no new `system + user_brief`
/// is built, so the model picks up exactly where it left off without
/// re-reading the original goal.
#[tauri::command]
pub async fn agent_continue(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    request: AgentContinueRequest,
) -> AppResult<()> {
    let mode = request.mode.unwrap_or_default();
    let lint_command = request.lint_command.clone();

    let workspace = request
        .workspace
        .or_else(|| {
            state
                .workspace
                .lock()
                .as_ref()
                .map(|p| p.display().to_string())
        })
        .unwrap_or_default();
    let workspace = canonical_workspace_string(workspace);
    let evt = format!("agent:event:{}", request_id);

    let open_tabs = request.open_tabs.clone().unwrap_or_default();
    let active_file = request.active_file.clone();
    let attached_files = request.attached_files.clone().unwrap_or_default();
    let opencode_session_id = request.opencode_session_id.clone();
    let opencode_mode = if mode == ExecutionMode::Plan {
        OpenCodeMode::Plan
    } else {
        OpenCodeMode::Agent
    };
    let prompt = if opencode_session_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty())
    {
        render_opencode_agent_prompt(
            &workspace,
            mode,
            request.context.as_deref(),
            &request.user_message,
            &open_tabs,
            active_file.as_deref(),
        )
    } else {
        render_opencode_continue_prompt(
            &workspace,
            mode,
            &request.transcript,
            request.context.as_deref(),
            &request.user_message,
            &open_tabs,
            active_file.as_deref(),
        )
    };
    if use_opencode_agent_runtime() {
        let _ = app.emit(
            &evt,
            json!({
                "kind": "started",
                "mode": mode,
                // `depth` is meaningful only on the original run; subtasks
                // don't currently support continuation. Pass 0 so the UI
                // doesn't show a misleading sub-agent indicator.
                "depth": 0,
                "workspace": workspace,
                "runtime": "opencode",
            }),
        );
        return run_opencode(
            app.clone(),
            &state,
            OpenCodeRunRequest {
                request_id: request_id.clone(),
                model: request.model.clone(),
                workspace: workspace.clone(),
                prompt,
                mode: opencode_mode,
                title: match opencode_mode {
                    OpenCodeMode::Plan => "Plan mode".into(),
                    OpenCodeMode::Agent => "Agent mode".into(),
                    OpenCodeMode::Ask => "Ask mode".into(),
                },
                files: attached_files,
                opencode_session_id,
            },
        )
        .await
        .map(|_| ());
    }

    let max_steps = request.max_steps.unwrap_or(DEFAULT_MAX_STEPS).max(1);
    let max_runtime = Duration::from_secs(
        request
            .max_runtime_secs
            .unwrap_or(DEFAULT_MAX_RUNTIME_S)
            .max(15),
    );
    let _ = app.emit(
        &evt,
        json!({
            "kind": "started",
            "mode": mode,
            "max_steps": max_steps,
            "depth": 0,
            "workspace": workspace,
            "runtime": "native",
        }),
    );

    // Reuse the transcript the BE handed back to the FE last turn.
    // We also re-attach an `<environment_details>` block via the
    // loop's normal per-turn refresh, so the model sees the latest
    // tabs/active file even on continuation.
    let mut transcript: Vec<Value> = request
        .transcript
        .into_iter()
        .map(|m| json!({"role": m.role, "content": m.content}))
        .collect();

    // Compose the next user turn. Per-turn `context` (the @ mentions
    // the user attached alongside the follow-up message) goes ABOVE
    // the message — same shape as `render_user_brief` uses for the
    // first turn — so the model treats the references as scaffolding
    // for the upcoming reply rather than a separate aside.
    let mut next_user = String::new();
    if let Some(ctx) = request.context.as_deref() {
        let ctx = ctx.trim();
        if !ctx.is_empty() {
            next_user.push_str("Context:\n");
            next_user.push_str(ctx);
            next_user.push_str("\n\n");
        }
    }
    next_user.push_str(request.user_message.trim());
    transcript.push(json!({"role": "user", "content": next_user}));

    // Hydrate the prior ledger if the FE shipped one. A
    // follow-up turn without a ledger (legacy v2 session, fresh
    // crash recovery) starts empty — the model will still see the
    // raw transcript, just without the dedup hints.
    let mut ledger = ActionLedger::new();
    if let Some(prior) = request.ledger {
        for entry in prior {
            ledger.push(entry);
        }
    }

    run_agent_loop(
        app,
        state,
        request_id,
        request.model,
        workspace,
        mode,
        max_steps,
        max_runtime,
        lint_command,
        0,
        open_tabs,
        active_file,
        transcript,
        ledger,
    )
    .await
}

fn render_opencode_agent_prompt(
    workspace: &str,
    mode: ExecutionMode,
    context: Option<&str>,
    goal: &str,
    open_tabs: &[String],
    active_file: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str(&format!("Workspace: {workspace}\n"));
    out.push_str(&format!("Mode: {}\n\n", execution_mode_label(mode)));
    if let Some(active) = active_file {
        if !active.trim().is_empty() {
            out.push_str("Active editor file:\n");
            out.push_str(active.trim());
            out.push_str("\n\n");
        }
    }
    if !open_tabs.is_empty() {
        out.push_str("Open tabs:\n");
        for tab in open_tabs.iter().take(20) {
            out.push_str("- ");
            out.push_str(tab);
            out.push('\n');
        }
        out.push('\n');
    }
    if let Some(context) = context {
        let context = context.trim();
        if !context.is_empty() {
            out.push_str("Attached context:\n");
            out.push_str(context);
            out.push_str("\n\n");
            out.push_str("Attached context may include <brain-frontier> and <context-memory>, Pointer's deterministic external memory. Use included evidence first, use frontier candidates to choose the next missing file/spec/config to inspect, and avoid rediscovering facts already supplied. Treat it as navigation memory and evidence, not as permission to invent unseen code.\n\n");
        }
    }
    out.push_str("User goal:\n");
    out.push_str(goal.trim());
    if mode == ExecutionMode::Plan {
        out.push_str("\n\nPlan mode contract: gather bounded context, then stop searching and answer. Required reads before final: the active file when relevant; the directly related implementation file; directly related existing verification or specification context when it can be found; and project configuration needed to name the verification command. For interface work, include both the state/logic file and the file that renders the affected UI. Use the repository's own structure and naming conventions to discover tests, specs, examples, snapshots, fixtures, or validation commands; do not assume a language, framework, package manager, or test runner. Do not finalize until relevant verification context has been read or you explicitly state what you checked and that none exists. Do not propose framework or router API migrations unless package/config context proves the installed major version supports the target API; preserve current dependency major versions for behavior-preserving refactors. For theme/refactor plans, distinguish styled-components ThemeProvider from a custom React context. Do not claim components consume a custom context unless the code shows a hook/provider; if props are used, say props are used. Do not assume a reported bug exists: compare the proposed fix to the code you read. If the code already contains the proposed source change, do not claim it is missing; produce a no-source-change or regression-test-only plan and cite the exact existing behavior. If the user asks for a refactor, cleanup, feature, or creative change, do not no-op merely because the current behavior works; produce a behavior-preserving implementation plan. If the evidence disproves the suspected bug, do not restate that suspected bug as true anywhere in the final answer. If the final plan is no-source-change, the Assessment must not say the reported bug exists, remains visible, does not re-render, or still needs a source fix. When naming files or implementation areas, cite exact symbols visible in context instead of generic descriptions. Final response format: Context read: exact paths; Assessment: what the code proves; Plan: exact changes or no-source-change rationale; Verification: exact narrow command. Final output must be under 180 words and contain no internal debate, self-correction, or discarded hypotheses. Verification must name an actual project command from repository configuration when available. Prefer the narrowest existing verification that covers the touched behavior. Plan verification commands must be executable by Agent mode without package executors: never use npx, npm exec, pnpm dlx, yarn dlx, or bunx in a plan. Prefer package scripts such as npm test, npm run test:run, npm run build, cargo test, go test, pytest, or the repository's configured equivalent.");
        if goal.to_ascii_lowercase().contains("refactor")
            || goal.to_ascii_lowercase().contains("cleanup")
            || goal.to_ascii_lowercase().contains("clean up")
            || goal.to_ascii_lowercase().contains("feature")
            || goal.to_ascii_lowercase().contains("implement")
            || goal.to_ascii_lowercase().contains("improve")
        {
            out.push_str("\nThis is a change-planning request: the final Plan must include source changes and must not answer no source changes needed merely because current behavior works. If no focused verification exists for a refactor, prefer the repository's configured build or validation command.");
        }
    } else if mode == ExecutionMode::AgentApprove || mode == ExecutionMode::AgentAuto {
        out.push_str("\n\nAgent implementation constraints: make the minimal correct change for the goal, preserve unrelated structure and assets, and verify with the repository's own commands when available even if the user did not explicitly ask to run tests. If package scripts or equivalent project commands exist, attempt the narrowest relevant command after editing unless a command is explicitly forbidden. After any successful edit, a final answer with zero bash verification attempts is invalid; run a verification command or attempt one and report the real blocker before finalizing. If the user asks to add or update tests, you must edit or create the relevant test/spec file even when verification cannot run. Do not install, add, remove, or update dependencies unless the user explicitly asks; if verification is blocked by missing dependencies, report the blocked command instead of changing dependency state. Never run or even attempt package executors: npx, npm exec, pnpm dlx, yarn dlx, or bunx are forbidden even for eslint, vitest, mocha, or one-off probing. Use scripts already present in package.json such as npm test, npm run test:run, npm run build, npm run lint, or npm run typecheck. If no relevant script exists, use the closest existing script or report that verification is blocked; do not invent an npx command. If package.json, Cargo.toml, pyproject.toml, or similar config defines verification scripts, do not claim verification commands are unavailable; missing dependencies mean verification was blocked or failed, not absent. Final answer: one concise non-repetitive summary under 140 words with changed files plus a Verification: sentence naming the exact command attempted or the exact blocked command. Never say verification was skipped because the user did not ask, because the change was minimal, or because of user constraints.");
    }
    out
}

fn render_opencode_continue_prompt(
    workspace: &str,
    mode: ExecutionMode,
    transcript: &[AgentMessage],
    context: Option<&str>,
    user_message: &str,
    open_tabs: &[String],
    active_file: Option<&str>,
) -> String {
    let mut out = render_opencode_agent_prompt(
        workspace,
        mode,
        context,
        user_message,
        open_tabs,
        active_file,
    );
    if !transcript.is_empty() {
        out.push_str("\n\nPrevious Pointer transcript summary/context:\n");
        for msg in transcript.iter().rev().take(12).rev() {
            out.push_str(match msg.role.as_str() {
                "assistant" => "Assistant: ",
                "tool" => "Tool: ",
                "system" => "System: ",
                _ => "User: ",
            });
            out.push_str(msg.content.trim());
            out.push_str("\n\n");
        }
    }
    out
}

fn use_opencode_agent_runtime() -> bool {
    true
}

fn canonical_workspace_string(workspace: String) -> String {
    let trimmed = workspace.trim();
    if trimmed.is_empty() {
        return workspace;
    }
    std::fs::canonicalize(trimmed)
        .map(|p| p.display().to_string())
        .unwrap_or(workspace)
}

/// Legacy native-loop preflight planner. The OpenCode-backed Assistant
/// no longer uses a Pointer-side step budget; this command remains for
/// migration/rollback compatibility with the deprecated agent store.
#[tauri::command]
pub async fn agent_estimate(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    request: AgentEstimateRequest,
) -> AppResult<AgentEstimateResult> {
    let _permit = acquire_inference(
        &app,
        &state,
        InferenceClaim::new(
            request_id.clone(),
            request.model.clone(),
            "planner",
            "Agent estimate",
        ),
        InferencePolicy::RejectBusy,
    )
    .await?;
    let mut cancel = state.cancels.lock().issue(&request_id);
    let mode = request.mode.unwrap_or_default();
    let workspace = request
        .workspace
        .or_else(|| {
            state
                .workspace
                .lock()
                .as_ref()
                .map(|p| p.display().to_string())
        })
        .unwrap_or_default();

    let user = format!(
        "Workspace: {workspace}\nMode: {:?}\nGoal:\n{}",
        mode,
        request.goal.trim(),
    );

    let body = json!({
        "model": request.model,
        "messages": [
            {"role": "system", "content": AGENT_ESTIMATOR},
            {"role": "user", "content": user},
        ],
        "stream": false,
        "format": "json",
        "options": { "temperature": 0.1, "num_predict": 256 },
    });

    let client = reqwest::Client::new();
    let send = client
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send();
    let resp = tokio::select! {
        _ = cancel.recv() => {
            state.cancels.lock().clear(&request_id);
            return Err(crate::error::AppError::Msg("estimate: cancelled".into()));
        }
        resp = send => resp
            .map_err(|e| crate::error::AppError::Msg(format!("estimate: {e}")))?,
    };
    state.cancels.lock().clear(&request_id);
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(crate::error::AppError::Msg(format!(
            "estimate: Ollama returned {status}: {text}"
        )));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| crate::error::AppError::Msg(format!("estimate: parse: {e}")))?;
    let content = body
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim();
    // Even with `format: json` some checkpoints wrap the JSON in
    // ```json fences or prose. Strip a leading fence/prose envelope
    // before parsing so we don't punish the user for a model quirk.
    let json_payload = extract_first_json_object(content).unwrap_or_else(|| content.to_string());
    let parsed: Value = serde_json::from_str(&json_payload).map_err(|e| {
        crate::error::AppError::Msg(format!("estimate: model returned non-JSON: {e}"))
    })?;
    let steps_raw = parsed
        .get("steps")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| crate::error::AppError::Msg("estimate: missing `steps`".into()))?;
    let steps = steps_raw.clamp(1, 100) as u32;
    let summary = parsed
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(AgentEstimateResult { steps, summary })
}

/// Pull a single top-level JSON object out of a string the model
/// returned. Tolerates leading prose / Markdown fences (`` ```json ``)
/// that occasionally slip through even with `format: json`. Returns
/// the substring from the first `{` to the matching `}`, or `None`
/// if no balanced object is found.
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

/// The shared agent loop. Both `agent_run` (first turn) and
/// `agent_continue` (follow-up turn) bootstrap their initial
/// transcript and call into here. The loop owns the per-turn state
/// machine (step counter, cycle detection, transcript pruning),
/// handles mid-run `<budget_bump>` requests, and emits a
/// `transcript_snapshot` event right before each terminal event so
/// the FE can persist the BE's view of the conversation and resume
/// it on the next user message.
async fn run_agent_loop(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    model: String,
    workspace: String,
    mode: ExecutionMode,
    mut max_steps: u32,
    max_runtime: Duration,
    lint_command: Option<String>,
    depth: u32,
    open_tabs: Vec<String>,
    active_file: Option<String>,
    mut transcript: Vec<Value>,
    mut ledger: ActionLedger,
) -> AppResult<()> {
    let inference_kind = if mode == ExecutionMode::Plan {
        "plan"
    } else {
        "agent"
    };
    let _inference_permit = acquire_inference(
        &app,
        &state,
        InferenceClaim::new(
            request_id.clone(),
            model.clone(),
            inference_kind,
            match mode {
                ExecutionMode::Plan => "Planning",
                ExecutionMode::AgentApprove => "Agent run awaiting approvals",
                ExecutionMode::AgentAuto => "Agent run",
            },
        ),
        InferencePolicy::RejectBusy,
    )
    .await?;
    let mut cancel = state.cancels.lock().issue(&request_id);
    let evt = format!("agent:event:{}", request_id);
    let client = reqwest::Client::new();
    let started = Instant::now();
    let mut fingerprints: HashMap<u64, u32> = HashMap::new();
    // Count prose-only and malformed-tool turns. We forgive a couple
    // because local models often narrate or clip XML before settling
    // into the protocol, but repeated failures still terminate rather
    // than spinning forever.
    let mut prose_redirect_count: u8 = 0;
    let mut malformed_tool_redirect_count: u8 = 0;
    // Tracks whether this plan run has inspected package.json before
    // naming npm script argument forwarding. Without this, models
    // often invent commands like `npm test -- file` that the
    // manifest may not support.
    let mut plan_quality_redirect_count: u8 = 0;
    let mut manifest_read_for_plan = false;
    // Sliding window of recent fingerprints for cycle detection.
    // We look for repeats at windows of 1, 2, and 3 — three identical
    // calls in a row, A,B,A,B pings, and A,B,C,A,B,C cycles.
    let mut fingerprint_window: Vec<u64> = Vec::with_capacity(8);
    let mut termination = "max_steps";

    // `max_steps` is mutable because a granted `<budget_bump>` can
    // grow (or shrink, via Override) the cap mid-run. Using a
    // `while` lets the cap expand without restarting the loop.
    let mut step: u32 = 0;
    while step < max_steps {
        step += 1;
        if started.elapsed() > max_runtime {
            termination = "timeout";
            let _ = app.emit(
                &evt,
                json!({"kind": "error", "step": step, "text": format!(
                    "Agent exceeded runtime budget of {}s.",
                    max_runtime.as_secs(),
                )}),
            );
            break;
        }

        let _ = app.emit(
            &evt,
            json!({
                "kind": "step_start",
                "step": step,
                "model": model,
                "elapsed_ms": started.elapsed().as_millis() as u64,
            }),
        );

        // Refresh the environment block on every turn so the agent
        // always sees the latest workspace state (Cline pattern).
        let env_block = render_environment_details(
            &workspace,
            mode,
            &open_tabs,
            active_file.as_deref(),
            step,
            max_steps,
            started.elapsed(),
        );
        attach_environment_details(&mut transcript, &env_block);

        // Fresh-read injection: if the user's CURRENT message
        // mentions a path the ledger says we touched, attach the
        // current bytes inline so the model never iterates against
        // stale memory ("yesterday I wrote X; now also add Y to X"
        // works whether the model still remembers X or not).
        inject_fresh_reads(&mut transcript, &ledger, &workspace);

        // Smart pruning + ledger injection. The pruner collapses
        // stale per-file reads/diffs (keeping only the latest per
        // path) and drops old search results, then prepends the
        // structured `<previous_work>` block so the model has a
        // factual memory of the session even when the raw transcript
        // was compacted. See `smart_prune_transcript` for the rules.
        smart_prune_transcript(&mut transcript, &ledger);

        let body = json!({
            "model": model,
            "messages": transcript,
            "stream": true,
            "options": { "temperature": 0.2, "num_predict": DEFAULT_NUM_PREDICT },
        });
        let send_started = Instant::now();
        let resp_result = client
            .post("http://127.0.0.1:11434/api/chat")
            .json(&body)
            .send()
            .await;
        let resp = match resp_result {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit(
                    &evt,
                    json!({"kind": "error", "step": step, "text": format!(
                        "Could not reach Ollama at 127.0.0.1:11434 — {}", e,
                    )}),
                );
                termination = "transport_error";
                break;
            }
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            let _ = app.emit(
                &evt,
                json!({"kind": "error", "step": step, "text": format!(
                    "Ollama returned HTTP {}: {}", status, body_text,
                )}),
            );
            termination = "http_error";
            break;
        }
        let _ = app.emit(
            &evt,
            json!({"kind": "request_sent", "step": step, "elapsed_ms": send_started.elapsed().as_millis() as u64}),
        );

        let mut buf = String::new();
        let mut stream = resp.bytes_stream();
        let mut done_streaming = false;
        let mut first_token = true;
        // When the watchdog fires we bail the whole RUN, not just
        // the step — a stuck Ollama is almost always going to stay
        // stuck for the next step too, and we'd rather surface one
        // honest error than chain several with a misleading
        // partial-output retry behind each.
        let mut stream_stalled = false;
        let stream_started = Instant::now();
        while !done_streaming {
            tokio::select! {
                _ = cancel.recv() => {
                    // Persist what we have so far so a follow-up turn
                    // can resume from the partial conversation. The
                    // FE store consumes this synchronously.
                    emit_transcript_snapshot(&app, &evt, &transcript);
                    emit_ledger_snapshot(&app, &evt, &ledger);
                    let _ = app.emit(&evt, json!({"kind": "cancelled", "step": step}));
                    state.cancels.lock().clear(&request_id);
                    return Ok(());
                }
                // Idle watchdog: fires when no chunk arrives within
                // STREAM_IDLE_TIMEOUT_S. The sleep future is fresh
                // each iteration of the outer loop, so it naturally
                // resets every time we receive a chunk. This is the
                // fix for the "thinking · step 2 (first token in
                // 0ms)" indefinite hang the user saw — Ollama
                // occasionally accepts a request and then just
                // never streams a `done: true`. Without this branch
                // the agent loop sits in select! forever.
                _ = tokio::time::sleep(Duration::from_secs(STREAM_IDLE_TIMEOUT_S)) => {
                    let waited = stream_started.elapsed().as_secs();
                    let _ = app.emit(&evt, json!({
                        "kind": "error",
                        "step": step,
                        "text": format!(
                            "Model stream stalled — no tokens received for {}s (total wait {}s). \
                             The local model may be hung, OOM, or unable to load. \
                             Try a smaller model, restart Ollama, or check `ollama ps`.",
                            STREAM_IDLE_TIMEOUT_S, waited,
                        ),
                    }));
                    stream_stalled = true;
                    done_streaming = true;
                }
                next = stream.next() => {
                    match next {
                        None => break,
                        Some(Err(e)) => {
                            let _ = app.emit(&evt, json!({"kind":"error", "step": step, "text": e.to_string()}));
                            done_streaming = true;
                        }
                        Some(Ok(bytes)) => {
                            for line in bytes.split(|&b| b == b'\n') {
                                if line.is_empty() { continue; }
                                if let Ok(v) = serde_json::from_slice::<Value>(line) {
                                    if let Some(c) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
                                        if !c.is_empty() {
                                            if first_token {
                                                first_token = false;
                                                let _ = app.emit(&evt, json!({
                                                    "kind": "first_token",
                                                    "step": step,
                                                    "warmup_ms": stream_started.elapsed().as_millis() as u64,
                                                }));
                                            }
                                            buf.push_str(c);
                                            _inference_permit.note_tokens(1);
                                            let _ = app.emit(&evt, json!({"kind": "token", "step": step, "text": c}));
                                        }
                                    }
                                    if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                                        done_streaming = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        // Watchdog fired — terminate the run cleanly. The error
        // event above already told the UI what happened; we just
        // need to break out so the agent loop doesn't try to parse
        // the (possibly partial / definitely truncated) `buf` as a
        // tool call.
        if stream_stalled {
            emit_transcript_snapshot(&app, &evt, &transcript);
            emit_ledger_snapshot(&app, &evt, &ledger);
            termination = "stream_stalled";
            break;
        }
        transcript.push(json!({"role": "assistant", "content": buf.clone()}));

        // Strip out blocks the model is forbidden to emit before
        // parsing. Some checkpoints hallucinate a fake `<tool_result>`
        // (with invented file contents) and then emit a `<final>`
        // based on that fake. We discard those blocks so only the
        // real tool call survives. The sanitized turn replaces the
        // raw assistant text in the model transcript so future turns
        // never see invented tool output as conversation history.
        let parse_buf = sanitize_model_output(&buf);
        if parse_buf != buf {
            replace_last_assistant_turn(&mut transcript, parse_buf.clone());
        }

        // Surface a <plan> block, if any, for the UI to render as a checklist.
        // In Plan mode, first reject the common bad shape where the model
        // has already read files but the user-facing plan still says
        // "inspect/read/identify" instead of giving exact implementation
        // steps. The next good plan event supersedes this one in the UI.
        let plan_block = extract_block(&parse_buf, "plan");
        let needs_plan_rewrite = mode == ExecutionMode::Plan
            && plan_block
                .as_deref()
                .map(plan_looks_like_discovery_checklist)
                .unwrap_or(false);
        let needs_ui_render_context_rewrite = mode == ExecutionMode::Plan
            && plan_block
                .as_deref()
                .map(plan_mentions_ui_state_without_render_site)
                .unwrap_or(false);
        let needs_test_edit_rewrite = mode == ExecutionMode::Plan
            && plan_block
                .as_deref()
                .map(plan_edits_existing_test)
                .unwrap_or(false);
        if plan_quality_redirect_count < 8
            && (needs_plan_rewrite || needs_ui_render_context_rewrite || needs_test_edit_rewrite)
        {
            plan_quality_redirect_count += 1;
            let mut violations = Vec::new();
            if needs_plan_rewrite {
                violations
                    .push("it still contains discovery steps instead of implementation steps");
            }
            if needs_ui_render_context_rewrite {
                violations.push("it plans an interface state fix without naming the file that renders the affected UI");
            }
            if needs_test_edit_rewrite {
                violations.push("it proposes editing a test file even though the existing test should be used as the specification");
            }
            let redirect = format!(
                "Your <plan> is not ready to execute. Fix these violations: {}. \
                 The corrected plan must name exact source file(s), the exact source change, existing verification/specification context when available, and the narrowest one-shot verification command. \
                 For interface work, preserve all gathered evidence categories in the final plan: source file/change, render site, verification/specification file, and command. Do not trade one category away when adding another. \
                 Do not include discovery steps. Do not edit tests when an existing test already covers the behavior. {}{}",
                violations.join("; "),
                "",
                if manifest_read_for_plan {
                    "Use the repository's configured verification command, preserving required flags and narrowing it to the relevant verification target when the project supports that. If no relevant verification/specification file is in context yet, emit exactly one read-only tool call now to find it using repository naming conventions. If an interface render site is not in context yet, emit exactly one read-only tool call now to find it from the state or symbol name. Otherwise emit only <plan>...</plan> followed by <final>...</final>."
                } else {
                    "If project verification configuration is not in context, emit exactly one read-only tool call now to inspect likely repository configuration files. Otherwise emit only <plan>...</plan> followed by <final>...</final>."
                }
            );
            let _ = app.emit(
                &evt,
                json!({
                    "kind": "thought",
                    "step": step,
                    "text": "(refining plan: first plan was not executable enough)"
                }),
            );
            transcript.push(json!({
                "role": "user",
                "content": redirect,
            }));
            continue;
        }
        if let Some(plan) = plan_block.as_deref() {
            let _ = app.emit(&evt, json!({"kind": "plan", "step": step, "text": plan}));
        }
        if let Some(thought) = extract_block(&parse_buf, "think") {
            let _ = app.emit(
                &evt,
                json!({"kind": "thought", "step": step, "text": thought}),
            );
        }

        // Mid-run budget renegotiation. The model emits
        // `<budget_bump proposed="N">reason</budget_bump>` when it
        // realizes the goal needs more steps than the current cap
        // allows. We pause the loop on a per-request oneshot
        // (sibling of APPROVALS); the FE resolves via
        // `agent_budget_decision`. A `Cancel` decision (or an
        // outright `agent_cancel`) breaks out as cancelled.
        if let Some((proposed_raw, reason)) = parse_budget_bump(&parse_buf) {
            let proposed = proposed_raw.clamp(1, 100);
            let _ = app.emit(
                &evt,
                json!({
                    "kind": "budget_bump_request",
                    "step": step,
                    "proposed": proposed,
                    "reason": reason,
                }),
            );
            let (tx, rx) = oneshot::channel::<BudgetDecision>();
            BUDGET_BUMPS
                .lock()
                .insert(request_id.clone(), BudgetBump { tx });
            // Same 30-minute timeout pattern as APPROVALS so a forgotten
            // tab doesn't pin the loop forever.
            let decision = match tokio::time::timeout(Duration::from_secs(60 * 30), rx).await {
                Ok(Ok(d)) => d,
                Ok(Err(_)) => BudgetDecision::Cancel, // channel closed
                Err(_) => BudgetDecision::Cancel,     // timed out
            };
            match decision {
                BudgetDecision::Accept => {
                    if proposed > max_steps {
                        max_steps = proposed;
                    }
                    transcript.push(json!({
                        "role": "user",
                        "content": format!(
                            "The user accepted your budget bump. New step cap: {max_steps}. Continue with the next action."
                        ),
                    }));
                    continue;
                }
                BudgetDecision::Override(m) => {
                    let m = m.clamp(1, 100);
                    max_steps = m;
                    transcript.push(json!({
                        "role": "user",
                        "content": format!(
                            "The user overrode your budget proposal. New step cap: {max_steps}. Scope the next actions accordingly and emit a tool call or <final>."
                        ),
                    }));
                    continue;
                }
                BudgetDecision::Cancel => {
                    emit_transcript_snapshot(&app, &evt, &transcript);
                    emit_ledger_snapshot(&app, &evt, &ledger);
                    let _ = app.emit(&evt, json!({"kind": "cancelled", "step": step}));
                    state.cancels.lock().clear(&request_id);
                    return Ok(());
                }
            }
        }

        // Hallucination guard: if the model emits BOTH a tool call AND
        // a final/clarify in the same turn, the final/clarify is
        // almost always based on hallucinated tool output (the model
        // imagined the result). Prefer running the real tool call —
        // the model will produce a fresh final/clarify on the next
        // turn once it sees actual data.
        let tool_call_opt = parse_tool_call(&parse_buf);
        let mut ignored_extra_executable_tags = false;
        if tool_call_opt.is_some() {
            let (assistant_turn, ignored) = transcript_turn_for_executed_tool(&parse_buf);
            ignored_extra_executable_tags = ignored;
            replace_last_assistant_turn(&mut transcript, assistant_turn);
        }
        if tool_call_opt.is_none() {
            // <clarify> short-circuits with a request for user input.
            if let Some(question) = extract_block(&parse_buf, "clarify") {
                let _ = app.emit(
                    &evt,
                    json!({"kind": "clarify", "step": step, "text": question}),
                );
                termination = "clarify";
                break;
            }
            // <final> wins when there's no real tool call.
            if let Some(final_text) = extract_block(&parse_buf, "final") {
                ledger.push(entry_for_answer(
                    step,
                    now_ms(),
                    &execution_mode_label(mode),
                    &final_text,
                ));
                let _ = app.emit(
                    &evt,
                    json!({"kind": "final", "step": step, "text": final_text}),
                );
                termination = "final";
                break;
            }
            // In Plan mode the `<plan>` block is the actual artifact
            // the UI needs to enable Execute. Some local checkpoints
            // reliably produce a good plan but omit the redundant
            // `<final>` wrapper; accept the plan itself as the terminal
            // answer once it passed the quality gates above.
            if mode == ExecutionMode::Plan {
                if let Some(plan_text) = plan_block.as_deref() {
                    ledger.push(entry_for_answer(
                        step,
                        now_ms(),
                        &execution_mode_label(mode),
                        plan_text,
                    ));
                    let _ = app.emit(
                        &evt,
                        json!({"kind": "final", "step": step, "text": plan_text}),
                    );
                    termination = "final";
                    break;
                }
            }
        }

        // Parse the first tool call. If we see none, the model
        // emitted prose with no actionable tag (no tool, no plan,
        // no final, no clarify) — typical of large reasoning
        // models that pause to "narrate" between steps of a
        // multi-step task. Previously we treated that as an
        // implicit final and terminated, which cut off bigger
        // models mid-task. Now we send a SINGLE redirect ("emit a
        // tool call or <final>") and let the next turn either
        // continue the work or close out cleanly. We only redirect
        // ONCE per run so a model that genuinely has nothing left
        // to do can fall through to the implicit-final path on
        // the second prose-only turn.
        let Some(call) = tool_call_opt else {
            if let Some(tag) = first_malformed_tool_tag(&parse_buf) {
                if malformed_tool_redirect_count < 2 {
                    malformed_tool_redirect_count += 1;
                    let redirect = format!(
                        "Your previous turn looked like a malformed <{tag}> tool call, so nothing was executed. \
                         Emit exactly one complete XML tool block now, with all required attributes and the closing tag when the tool has a body. \
                         For apply_diff/edit_file, include complete <<<<<<< SEARCH / ======= / >>>>>>> REPLACE hunks copied from the current file. \
                         Do not explain in prose."
                    );
                    let _ = app.emit(
                        &evt,
                        json!({
                            "kind": "thought",
                            "step": step,
                            "text": format!("(redirected: malformed <{tag}> tool call — asking for one complete XML block)"),
                        }),
                    );
                    transcript.push(json!({
                        "role": "user",
                        "content": redirect,
                    }));
                    continue;
                }
            }

            if prose_redirect_count < 2 {
                prose_redirect_count += 1;
                let redirect = if mode == ExecutionMode::Plan {
                    "Your previous turn was prose only — no tool call, no <plan>, no <final>, no <clarify>. \
                     In PLAN MODE, either gather context with exactly one read-only tool call \
                     (discover, read_file, list_dir, glob, grep, search_codebase, list_code_definition_names), \
                     or if you are ready, emit a <plan> block with exact files/steps/verification followed by a <final> block. \
                     The <plan> block is what enables Execute. \
                     Do NOT explain further in prose; the harness only acts on tags."
                } else {
                    "Your previous turn was prose only — no tool call, no <final>, no <clarify>. \
                     If the goal isn't complete yet, emit the NEXT tool call now (one of: edit_file, rename_symbol, discover, run_check, read_file, list_dir, glob, grep, search_codebase, list_code_definition_names, write_file, apply_diff, delete_path, rename_path, run_shell, mcp_call, task). \
                     If the goal IS complete, emit exactly `<final>one-paragraph summary</final>` — nothing else. \
                     If you're blocked and need user input, emit `<clarify>your question</clarify>`. \
                     Do NOT explain further in prose; the harness only acts on tags."
                };
                let _ = app.emit(
                    &evt,
                    json!({
                        "kind": "thought",
                        "step": step,
                        "text": if mode == ExecutionMode::Plan {
                            "(redirected: turn had no tool call, <plan>, or <final> — asking for executable plan protocol)"
                        } else {
                            "(redirected: turn had no tool call or <final> — asking for next action)"
                        }
                    }),
                );
                transcript.push(json!({
                    "role": "user",
                    "content": redirect.to_string(),
                }));
                continue;
            }
            // Second prose-only turn — accept it as the final.
            let trimmed_final = parse_buf.trim().to_string();
            ledger.push(entry_for_answer(
                step,
                now_ms(),
                &execution_mode_label(mode),
                &trimmed_final,
            ));
            let _ = app.emit(
                &evt,
                json!({"kind": "final", "step": step, "text": trimmed_final}),
            );
            termination = "final";
            break;
        };

        // Dedup: if the model emits the same tool call twice in a row, intervene.
        let count = fingerprints.entry(call.fingerprint).or_insert(0);
        *count += 1;
        // Update the sliding window. Detect cycles at k=1,2,3.
        fingerprint_window.push(call.fingerprint);
        if fingerprint_window.len() > 12 {
            fingerprint_window.remove(0);
        }
        let in_cycle = detect_cycle(&fingerprint_window);
        if *count >= 3 || in_cycle {
            let kind = if *count >= 3 { "identical" } else { "cyclical" };
            let _ = app.emit(
                &evt,
                json!({"kind": "error", "step": step, "text": format!(
                    "Loop detected ({kind}): the agent is spinning on the same tool calls without progress. Stopping. Refine your goal or check what the agent already tried."
                )}),
            );
            termination = "loop_detected";
            break;
        }

        let _ = app.emit(
            &evt,
            json!({
                "kind": "tool_call",
                "step": step,
                "tool": call.tool,
                "attrs": serde_json::to_value(&call.attrs).unwrap_or(json!({})),
                "args": call.body,
            }),
        );

        let result = execute_tool(
            &app,
            &request_id,
            &call,
            &workspace,
            mode,
            step,
            depth,
            lint_command.as_deref(),
        )
        .await;

        let (status, text, extra) = match result {
            Ok(r) => (r.status, r.message, r.extra),
            Err(e) => ("error".to_string(), format!("ERROR: {e}"), None),
        };
        if status == "ok"
            && call.tool == "read_file"
            && call
                .attrs
                .get("path")
                .and_then(|p| Path::new(p).file_name())
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case("package.json"))
                .unwrap_or(false)
        {
            manifest_read_for_plan = true;
        }
        // Cross-turn dedup hint (ADVISORY ONLY). For read-only
        // tools, if the ledger already records this exact read or
        // search from an earlier turn, append a one-liner so the
        // model knows the data is in <previous_work>. We do NOT
        // block the call — iterating on prior work is legitimate
        // and `<fresh_reads>` should already inline current bytes.
        // This is a context hint, not a circuit breaker.
        let dedup_hint = cross_turn_dedup_hint(&call, &ledger);
        // Record the action in the structured ledger BEFORE we
        // emit any UI events — the FE listens for
        // `ledger_snapshot` AFTER `tool_result`, and we want the
        // entry to be visible the moment a follow-up turn could
        // resume from this point. `entry_for_tool` returns None
        // for failed/rejected calls, so a tool error doesn't
        // leave a false "you did X" footprint.
        let ledger_extra = extra.clone();
        if let Some(entry) = entry_for_tool(
            step,
            now_ms(),
            &execution_mode_label(mode),
            &call.tool,
            &call.attrs,
            &call.body,
            &status,
            &text,
            ledger_extra.as_ref(),
        ) {
            ledger.push(entry);
        }
        let _ = app.emit(
            &evt,
            json!({
                "kind": "tool_result",
                "step": step,
                "tool": call.tool,
                "status": status,
                "result": text,
                "extra": extra.unwrap_or(json!({})),
            }),
        );
        let mut tool_result_body = match dedup_hint {
            Some(hint) => format!(
                "<tool_result tool=\"{}\" status=\"{}\">\n{}\n</tool_result>\n<dedup_hint>\n{}\n</dedup_hint>",
                call.tool, status, truncate(&text, TOOL_RESULT_TRUNCATE), hint,
            ),
            None => format!(
                "<tool_result tool=\"{}\" status=\"{}\">\n{}\n</tool_result>",
                call.tool, status, truncate(&text, TOOL_RESULT_TRUNCATE),
            ),
        };
        if ignored_extra_executable_tags {
            tool_result_body.push_str(
                "\n<protocol_note>\nOnly the first tool call from your previous turn was executed. \
                 Any later tool calls, invented tool results, or final text in the same turn were ignored. \
                 Wait for real tool results and emit exactly one next action.\n</protocol_note>",
            );
        }
        transcript.push(json!({"role": "user", "content": tool_result_body}));

        // If a mutation just happened, also feed an optional verifier report.
        if MUTATING_TOOLS.contains(&call.tool.as_str()) && status == "ok" {
            let verifier_report = run_verifier(
                &app,
                &request_id,
                step,
                &workspace,
                &call,
                lint_command.as_deref(),
            )
            .await;
            let has_source_hygiene_issue = verifier_report
                .as_deref()
                .map(|report| report.contains("source hygiene issue"))
                .unwrap_or(false);
            if let Some(report) = verifier_report {
                transcript.push(json!({
                    "role": "user",
                    "content": format!("<verifier>\n{}\n</verifier>", truncate(&report, 4000)),
                }));
            }
            // Post-mutation directive: small local coders (Qwen-7B,
            // DeepSeek-7B) will otherwise waste a whole turn
            // hallucinating their own <verifier> block instead of
            // emitting a <final>. This single line nudge cuts that
            // failure mode in our offline harness from ~50% to 0%.
            // It mirrors exactly what scripts/quality/evalAgent.mjs
            // sends, so the offline eval and production stay in sync.
            transcript.push(json!({
                "role": "user",
                "content": if has_source_hygiene_issue {
                    "The file change has been APPLIED on disk, but the verifier found a source hygiene issue. The goal is NOT met yet. Your NEXT turn must be exactly one mutating tool call that removes the stale marker or contradictory old code — do not emit <final> yet.".to_string()
                } else {
                    "The file change has been APPLIED on disk. If the user explicitly requested tests/build/checks, the goal is NOT met until that verification command has run successfully; run that one-shot command next instead of finalizing. If the goal is met, your NEXT turn must be exactly a <final>…</final> block — nothing else, no other tags, no extra tool calls. If more work remains, emit the next tool call instead.".to_string()
                },
            }));
        }
        // After a failed apply_diff, guide the model based on WHY
        // it failed:
        //   * file missing → don't tell it to <read_file> the same
        //     path (that read will also fail). The error already
        //     suggested nearby paths; reinforce that.
        //   * SEARCH didn't match → ask it to <read_file> first so
        //     it can anchor against the exact bytes.
        // Without this split, small local coders cascade into a
        // doomed read → guess → fail loop and burn out their turn
        // budget (this is exactly the failure mode in the
        // index.html screenshot reported by the user).
        if call.tool == "apply_diff" && status == "error" {
            let path_attr = call.attrs.get("path").cloned().unwrap_or_default();
            let file_missing =
                text.contains("does not exist") || text.contains("No such file or directory");
            if file_missing {
                transcript.push(json!({
                    "role": "user",
                    "content":
                        "The file does NOT exist at that path. Do not call <read_file> on the same path \
                         — that will fail with the same error. Either pick one of the nearby matches \
                         from the error message above, or run <list_dir path=\".\" /> first to discover \
                         the real layout. If you intend to CREATE the file, use <write_file> instead.".to_string(),
                }));
            } else {
                transcript.push(json!({
                    "role": "user",
                    "content": format!(
                        "The SEARCH block didn't match the file byte-for-byte. Before retrying, call <read_file path=\"{}\" /> so you have the exact bytes to anchor against.",
                        path_attr
                    ),
                }));
            }
        }
        // Same logic for write_file when the parent dir doesn't
        // exist — usually the model also got the path wrong.
        if (call.tool == "delete_path" || call.tool == "rename_path")
            && status == "error"
            && (text.contains("No such file") || text.contains("does not exist"))
        {
            let path_attr = call
                .attrs
                .get("path")
                .or_else(|| call.attrs.get("from"))
                .cloned()
                .unwrap_or_default();
            let suggestions = find_similar_paths(&workspace, &path_attr);
            let suggestion_text = if suggestions.is_empty() {
                format!(
                    "Run <list_dir path=\".\" /> or <glob>**/{}</glob> to find the real path.",
                    Path::new(&path_attr)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&path_attr),
                )
            } else {
                format!(
                    "Did you mean one of: {}? If so, retry with that path.",
                    suggestions
                        .iter()
                        .map(|p| format!("`{}`", p))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            transcript.push(json!({
                "role": "user",
                "content": format!("The path `{}` does not exist. {}", path_attr, suggestion_text),
            }));
        }

        if mode == ExecutionMode::Plan
            && PLAN_FORBIDDEN_TOOLS.contains(&call.tool.as_str())
            && status != "ok"
        {
            transcript.push(json!({
                "role": "user",
                "content": format!(
                    "This is PLAN MODE — <{}> is forbidden and was not executed. Do NOT call run_shell, run_check, task, or mutating tools in Plan mode. If you already have the source file, relevant verification/specification context, and project verification configuration, emit a <plan> block with the exact source change and narrow verification command, followed by <final>.",
                    call.tool
                ),
            }));
        }
    }

    state.cancels.lock().clear(&request_id);
    // Snapshot the BE-side transcript so the FE can persist it and
    // resume the same conversation on a follow-up `agent_continue`.
    // Always emitted right before the terminal event so the FE
    // listener has the latest data before the session flips state.
    emit_transcript_snapshot(&app, &evt, &transcript);
    emit_ledger_snapshot(&app, &evt, &ledger);
    let _ = app.emit(&evt, json!({"kind": "done", "termination": termination, "elapsed_ms": started.elapsed().as_millis() as u64}));
    Ok(())
}

/// Capture the current Ollama-side transcript and forward it to the
/// FE so the next `agent_continue` call can resume the conversation.
/// Each entry is reduced to the `{role, content}` pair the model
/// understands; this matches the `AgentMessage` shape on the FE.
fn emit_transcript_snapshot(app: &AppHandle, evt: &str, transcript: &[Value]) {
    let messages: Vec<Value> = transcript
        .iter()
        .filter_map(|v| {
            let role = v.get("role").and_then(|r| r.as_str())?;
            let content = v.get("content").and_then(|c| c.as_str())?;
            Some(json!({"role": role, "content": content}))
        })
        .collect();
    let _ = app.emit(
        evt,
        json!({"kind": "transcript_snapshot", "messages": messages}),
    );
}

/// Capture the per-session action ledger and forward it to the FE
/// for persistence. Emitted alongside the transcript snapshot so a
/// follow-up `agent_continue` can resume from both — without the
/// ledger the model would lose the structured "what was done"
/// memory the moment a turn ends.
fn emit_ledger_snapshot(app: &AppHandle, evt: &str, ledger: &ActionLedger) {
    if let Ok(entries) = serde_json::to_value(&ledger.entries) {
        let _ = app.emit(evt, json!({"kind": "ledger_snapshot", "entries": entries}));
    }
}

fn replace_last_assistant_turn(transcript: &mut [Value], content: String) {
    if let Some(last) = transcript
        .iter_mut()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("assistant"))
    {
        last["content"] = Value::String(content);
    }
}

/// Keep only the assistant content that led to the tool call we will
/// actually execute. Some local models emit `<read_file/>` and then
/// immediately continue with `<apply_diff>` or `<final>` in the same
/// turn, imagining a result they have not received. The loop executes
/// exactly one tool call, so the transcript must record exactly that
/// one call; otherwise the next turn can treat unexecuted tags as
/// factual history.
fn transcript_turn_for_executed_tool(s: &str) -> (String, bool) {
    let Some((_start, end)) = first_tool_span(s) else {
        return (s.to_string(), false);
    };
    let ignored_extra = has_executable_tag(&s[end..]);
    (s[..end].to_string(), ignored_extra)
}

fn first_tool_span(s: &str) -> Option<(usize, usize)> {
    let mut best: Option<(usize, &str)> = None;
    for &tag in TOOL_TAGS {
        let needle = format!("<{tag}");
        if let Some(pos) = s.find(&needle) {
            if best.map(|(p, _)| pos < p).unwrap_or(true) {
                best = Some((pos, tag));
            }
        }
    }
    let (start, tag) = best?;
    let rest = &s[start..];
    let header_end_rel = rest.find('>')?;
    let header = &rest[..header_end_rel];
    let body_start = start + header_end_rel + 1;
    if header.trim_end().ends_with('/') {
        return Some((start, body_start));
    }
    let close = format!("</{tag}>");
    let close_start = s[body_start..].find(&close).map(|i| body_start + i)?;
    Some((start, close_start + close.len()))
}

fn has_executable_tag(s: &str) -> bool {
    TOOL_TAGS
        .iter()
        .copied()
        .chain(["final", "clarify", "tool_result", "verifier", "budget_bump"])
        .any(|tag| s.contains(&format!("<{tag}")))
}

fn first_malformed_tool_tag(s: &str) -> Option<&'static str> {
    // If a known tool tag appears but no complete tool span can be
    // parsed, the model usually clipped a closing tag or emitted a
    // half-formed XML block. Redirecting once or twice recovers far
    // better than treating the turn as prose.
    if first_tool_span(s).is_some() {
        return None;
    }

    let mut best: Option<(usize, &'static str)> = None;
    for &tag in TOOL_TAGS {
        let needle = format!("<{tag}");
        if let Some(pos) = s.find(&needle) {
            if best.map(|(p, _)| pos < p).unwrap_or(true) {
                best = Some((pos, tag));
            }
        }
    }
    best.map(|(_, tag)| tag)
}

/// Best-effort millisecond timestamp. `SystemTime::now()` can
/// technically be earlier than the UNIX epoch on misconfigured
/// systems; treat that case as 0 rather than failing the entire
/// ledger record.
fn now_ms() -> i64 {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Stable lowercase label for an ExecutionMode — matches the FE's
/// `AssistantMode` discriminator so the ledger renderer can show
/// "this turn ran in plan mode" without us ever shipping a `Debug`
/// representation of the enum.
fn execution_mode_label(mode: ExecutionMode) -> String {
    // We keep the wire-format labels (plan/ask/auto) the FE has
    // been sending for releases; renaming them would silently
    // re-bucket every session's existing ledger entries.
    match mode {
        ExecutionMode::Plan => "plan".to_string(),
        ExecutionMode::AgentApprove => "ask".to_string(),
        ExecutionMode::AgentAuto => "auto".to_string(),
    }
}

/// Parse a `<budget_bump proposed="N">reason</budget_bump>` block. The
/// `proposed` attribute is required; the body is the (optional) prose
/// the model writes to justify the bump. Returns `None` when the block
/// is missing or `proposed` doesn't parse as a positive integer.
fn parse_budget_bump(s: &str) -> Option<(u32, String)> {
    let open = "<budget_bump";
    let start = s.find(open)?;
    let after_open = s[start..].find('>').map(|i| start + i + 1)?;
    let close = "</budget_bump>";
    let end = s[after_open..].find(close).map(|i| after_open + i)?;
    let header = &s[start..after_open - 1]; // strip trailing '>'
    let attrs = parse_attrs(&header[open.len()..]);
    let proposed: u32 = attrs.get("proposed").and_then(|v| v.parse().ok())?;
    let reason = s[after_open..end].trim().to_string();
    Some((proposed, reason))
}

#[tauri::command]
pub async fn agent_cancel(state: State<'_, AppState>, request_id: String) -> AppResult<bool> {
    Ok(cancel_agent_request(&state, &request_id))
}

pub(crate) fn cancel_agent_request(state: &AppState, request_id: &str) -> bool {
    // Also unblock any pending approval so the loop can wind down cleanly.
    let _ = take_approval(request_id).map(|a| {
        a.tx.send(ApprovalDecision {
            approved: false,
            note: Some("cancelled".into()),
        })
    });
    // Likewise for a pending budget-bump pause — without this the
    // loop sits on the 30-min timeout even after the user hits Stop.
    let _ = take_budget_bump(request_id).map(|b| b.tx.send(BudgetDecision::Cancel));
    // Tell any in-flight <run_shell> for this request to die,
    // otherwise the user clicks "stop" but the agent loop sits
    // there waiting for `npm install` to finish for 15 minutes.
    cancel_shell_for(request_id);
    // Release any paused prompt waiters so the reader thread can
    // wind down instead of sitting on `recv_timeout(120s)`.
    cancel_shell_prompts_for(request_id);
    state.cancels.lock().cancel(request_id)
}

/// Resolve a paused `<budget_bump>` request. `accept` keeps the model's
/// proposed value; otherwise `override` substitutes the user's value
/// (when present). A non-accept call without an override is treated
/// as Cancel — the loop tears down rather than silently picking a
/// fallback. The loop clamps the final value to 1-100 either way.
#[tauri::command]
pub async fn agent_budget_decision(
    request_id: String,
    accept: bool,
    // `override` is a Rust keyword; use a raw identifier so Tauri's
    // auto-converted JS argument name matches without needing a
    // serde rename or rename_all on the command attribute.
    r#override: Option<u32>,
) -> AppResult<bool> {
    let Some(bump) = take_budget_bump(&request_id) else {
        return Ok(false);
    };
    let decision = if accept {
        BudgetDecision::Accept
    } else if let Some(m) = r#override {
        BudgetDecision::Override(m)
    } else {
        BudgetDecision::Cancel
    };
    let _ = bump.tx.send(decision);
    Ok(true)
}

fn take_budget_bump(request_id: &str) -> Option<BudgetBump> {
    BUDGET_BUMPS.lock().remove(request_id)
}

/// Forward a user-provided response for an interactive shell prompt
/// detected mid-run. The reader thread is blocked on a oneshot for
/// `prompt_id`; this delivers the response and the child gets the
/// bytes plus a trailing newline.
#[tauri::command]
pub async fn agent_shell_respond(prompt_id: String, response: String) -> AppResult<bool> {
    Ok(deliver_shell_prompt_response(&prompt_id, response))
}

/// Resolve a pending approval. Multiple approvals can be queued per request;
/// we match the most recent (FIFO would also be fine but agents only ever have
/// one in-flight at a time).
#[tauri::command]
pub async fn agent_approve(request_id: String, note: Option<String>) -> AppResult<bool> {
    if let Some(a) = take_approval(&request_id) {
        let _ = a.tx.send(ApprovalDecision {
            approved: true,
            note,
        });
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn agent_reject(request_id: String, note: Option<String>) -> AppResult<bool> {
    if let Some(a) = take_approval(&request_id) {
        let _ = a.tx.send(ApprovalDecision {
            approved: false,
            note,
        });
        Ok(true)
    } else {
        Ok(false)
    }
}

// -------------------- Tool execution ---------------------------------------

const MUTATING_TOOLS: &[&str] = &[
    "write_file",
    "apply_diff",
    "delete_path",
    "rename_path",
    "run_shell",
    // Every MCP call is treated as mutating by default. MCP servers can do
    // arbitrary things (POST to APIs, write files, run commands) and we
    // can't reliably introspect their effect, so we err on the safe side:
    // Plan mode refuses, Ask mode prompts, Auto mode runs.
    "mcp_call",
    // Skills that touch the filesystem. `discover` and `run_check`
    // are read-only and stay off this list. `run_check` executes a
    // shell command, so Plan mode blocks it through PLAN_FORBIDDEN_TOOLS
    // below without making Ask mode prompt for approval.
    "edit_file",
    "rename_symbol",
];

const PLAN_FORBIDDEN_TOOLS: &[&str] = &[
    "write_file",
    "apply_diff",
    "delete_path",
    "rename_path",
    "run_shell",
    "mcp_call",
    "edit_file",
    "rename_symbol",
    // These can execute arbitrary work through another agent or a
    // shell-backed checker. Plan mode is for reading and producing a
    // plan; verification commands belong in the plan, not in the run.
    "task",
    "run_check",
];

const TOOL_TAGS: &[&str] = &[
    // ── skills (composed workflows) ────────────────────────
    "edit_file",
    "rename_symbol",
    "discover",
    "run_check",
    // ── primitives ──────────────────────────────────────────
    "read_file",
    "list_dir",
    "glob",
    "grep",
    "search_codebase",
    "list_code_definition_names",
    "write_file",
    "apply_diff",
    "delete_path",
    "rename_path",
    "run_shell",
    "mcp_call",
    "task",
];

/// Result of a single tool dispatch. Visible to sibling crate
/// modules so skill orchestrators in `services::skills` can return
/// the same shape the agent loop already knows how to serialize and
/// stitch into the transcript.
#[derive(Debug)]
pub(crate) struct ToolOutput {
    /// "ok" | "error" | "pending" | "rejected"
    pub(crate) status: String,
    /// Text shown to the model and the UI card.
    pub(crate) message: String,
    /// Structured payload for richer UI rendering (diff card, error
    /// list, etc.). `None` for skills that have nothing extra to say.
    pub(crate) extra: Option<Value>,
}

async fn execute_tool(
    app: &AppHandle,
    request_id: &str,
    call: &ToolCall,
    workspace: &str,
    mode: ExecutionMode,
    step: u32,
    depth: u32,
    lint_command: Option<&str>,
) -> Result<ToolOutput, String> {
    let evt = format!("agent:event:{}", request_id);

    // Mode gate.
    if PLAN_FORBIDDEN_TOOLS.contains(&call.tool.as_str()) && mode == ExecutionMode::Plan {
        return Ok(ToolOutput {
            status: "error".into(),
            message: format!(
                "Tool '{}' is not allowed in plan-only mode. \
                 Use read-only code-inspection tools, then describe the edit and verification command in <plan> instead of executing it.",
                call.tool,
            ),
            extra: None,
        });
    }

    // AgentApprove-mode gate: require approval round-trip on each mutation.
    if MUTATING_TOOLS.contains(&call.tool.as_str()) && mode == ExecutionMode::AgentApprove {
        let (tx, rx) = oneshot::channel::<ApprovalDecision>();
        APPROVALS
            .lock()
            .insert(request_id.to_string(), Approval { tx });
        let _ = app.emit(
            &evt,
            json!({
                "kind": "approval_request",
                "step": step,
                "tool": call.tool,
                "attrs": serde_json::to_value(&call.attrs).unwrap_or(json!({})),
                "args": call.body,
            }),
        );
        // Wait, but periodically nudge so the UI can show an aging hint.
        let decision = match tokio::time::timeout(Duration::from_secs(60 * 30), rx).await {
            Ok(Ok(d)) => d,
            Ok(Err(_)) => ApprovalDecision {
                approved: false,
                note: Some("channel closed".into()),
            },
            Err(_) => ApprovalDecision {
                approved: false,
                note: Some("approval timed out (30m)".into()),
            },
        };
        if !decision.approved {
            return Ok(ToolOutput {
                status: "rejected".into(),
                message: format!(
                    "User rejected the {} call{}. Choose a different approach or ask a clarifying question.",
                    call.tool,
                    decision.note.as_ref().map(|n| format!(" ({n})")).unwrap_or_default(),
                ),
                extra: None,
            });
        }
    }

    match call.tool.as_str() {
        "read_file" => run_read_file(workspace, call).map(Ok)?,
        "list_dir" => run_list_dir(workspace, call).map(Ok)?,
        "glob" => run_glob(workspace, call).map(Ok)?,
        "grep" => run_grep(workspace, call).map(Ok)?,
        "search_codebase" => run_search_codebase(app, request_id, call).map(Ok)?,
        "list_code_definition_names" => run_list_code_definitions(workspace, call).map(Ok)?,
        "write_file" => run_write_file(app, step, workspace, call).map(Ok)?,
        "apply_diff" => run_apply_diff(app, step, workspace, call).map(Ok)?,
        "delete_path" => run_delete_path(app, step, workspace, call).map(Ok)?,
        "rename_path" => run_rename_path(app, step, workspace, call).map(Ok)?,
        "run_shell" => run_shell(app, request_id, workspace, call).await.map(Ok)?,
        "task" => run_subtask(app, call, workspace, depth, lint_command)
            .await
            .map(Ok)?,
        "mcp_call" => run_mcp_call(app, call).await.map(Ok)?,
        // ── Skills: bigger, deterministic compositions on top of
        //    the primitives above. See services/skills.rs for the
        //    design rationale and per-skill spec.
        "edit_file" => {
            crate::services::skills::run_edit_file(app, step, workspace, call, lint_command)
                .await
                .map(Ok)?
        }
        "rename_symbol" => {
            crate::services::skills::run_rename_symbol(app, step, workspace, call).map(Ok)?
        }
        "discover" => crate::services::skills::run_discover(workspace, call).map(Ok)?,
        "run_check" => crate::services::skills::run_run_check(app, request_id, workspace, call)
            .await
            .map(Ok)?,
        _ => Err(format!("unknown tool: {}", call.tool)),
    }
}

/// Dispatch an `<mcp_call server="X" tool="Y">JSON args</mcp_call>` block to
/// the MCP manager. Returns the server's `content` payload converted to
/// human-readable text so the model can react to it next turn.
async fn run_mcp_call(app: &AppHandle, call: &ToolCall) -> Result<ToolOutput, String> {
    let server = call
        .attrs
        .get("server")
        .cloned()
        .ok_or_else(|| "mcp_call: missing required attribute `server`".to_string())?;
    let tool = call
        .attrs
        .get("tool")
        .cloned()
        .ok_or_else(|| "mcp_call: missing required attribute `tool`".to_string())?;
    let body = call.body.trim();
    let arguments: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_str(body).map_err(|e| {
            format!(
                "mcp_call: body must be JSON object of tool arguments — {e}\n(got: {})",
                if body.len() > 200 { &body[..200] } else { body }
            )
        })?
    };
    let state = app.state::<AppState>();
    let raw = state
        .mcp
        .call_tool(&server, &tool, arguments.clone())
        .await
        .map_err(|e| format!("mcp_call {server}::{tool}: {e}"))?;
    let text = render_mcp_result(&raw);
    Ok(ToolOutput {
        status: "ok".into(),
        message: text,
        extra: Some(json!({
            "server": server,
            "tool": tool,
            "arguments": arguments,
            "result": raw,
        })),
    })
}

/// Flatten an MCP tools/call result into something the model can read.
/// Spec shape: `{ content: [ { type: "text", text }, ... ], isError?: bool }`.
fn render_mcp_result(v: &Value) -> String {
    let is_error = v.get("isError").and_then(|b| b.as_bool()).unwrap_or(false);
    let prefix = if is_error { "[isError] " } else { "" };
    let parts = v
        .get("content")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    if parts.is_empty() {
        return format!("{prefix}(empty content)");
    }
    let mut out = String::new();
    if !prefix.is_empty() {
        out.push_str(prefix);
    }
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            out.push_str("\n---\n");
        }
        let ty = p.get("type").and_then(|s| s.as_str()).unwrap_or("");
        match ty {
            "text" => {
                if let Some(t) = p.get("text").and_then(|s| s.as_str()) {
                    out.push_str(t);
                }
            }
            "image" => {
                // We don't pipe image bytes back into the text-only model.
                // Note their presence so the agent can decide what to do.
                let mime = p
                    .get("mimeType")
                    .and_then(|s| s.as_str())
                    .unwrap_or("image/*");
                out.push_str(&format!("[image: {mime}]"));
            }
            "resource" => {
                let uri = p
                    .get("resource")
                    .and_then(|r| r.get("uri"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("(no uri)");
                out.push_str(&format!("[resource: {uri}]"));
            }
            other => {
                out.push_str(&format!("[content type: {other}]"));
            }
        }
    }
    if out.len() > TOOL_RESULT_TRUNCATE {
        out.truncate(TOOL_RESULT_TRUNCATE);
        out.push_str("\n…(truncated)");
    }
    out
}

/// Build a dynamic system-prompt section that lists every tool the
/// currently-running MCP servers expose. We keep this terse — name +
/// one-line description + a short schema preview — because long
/// schemas blow the context budget on smaller models.
fn render_mcp_section(tools: &[(String, crate::services::mcp::McpTool)]) -> String {
    let mut by_server: HashMap<&str, Vec<&crate::services::mcp::McpTool>> = HashMap::new();
    for (server, t) in tools {
        by_server.entry(server.as_str()).or_default().push(t);
    }
    let mut server_names: Vec<&&str> = by_server.keys().collect();
    server_names.sort();
    let mut out = String::new();
    out.push_str("\n\n==================== MCP TOOLS ====================\n");
    out.push_str(
        "These tools come from external MCP servers connected by the user. \
         Call them with:\n\
         <mcp_call server=\"<server-name>\" tool=\"<tool-name>\">{json arguments}</mcp_call>\n\
         The body MUST be a JSON object matching the tool's input schema. \
         An empty body is shorthand for `{}`.\n\n",
    );
    for server in server_names {
        out.push_str(&format!("Server `{server}`:\n"));
        for t in by_server.get(*server).unwrap() {
            let desc = t.description.as_deref().unwrap_or("").trim();
            let short_desc = if desc.is_empty() {
                String::from("(no description)")
            } else {
                truncate_inline(desc, 200)
            };
            out.push_str(&format!("  • `{}` — {}\n", t.name, short_desc));
            if let Some(schema) = &t.input_schema {
                if let Some(props) = schema.get("properties").and_then(|p| p.as_object()) {
                    let required = schema
                        .get("required")
                        .and_then(|r| r.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str())
                                .collect::<std::collections::HashSet<_>>()
                        })
                        .unwrap_or_default();
                    let mut field_lines = vec![];
                    for (k, v) in props.iter().take(8) {
                        let ty = v.get("type").and_then(|s| s.as_str()).unwrap_or("any");
                        let req = if required.contains(k.as_str()) {
                            " (required)"
                        } else {
                            ""
                        };
                        field_lines.push(format!("      - {k}: {ty}{req}"));
                    }
                    if !field_lines.is_empty() {
                        out.push_str(&field_lines.join("\n"));
                        out.push('\n');
                    }
                }
            }
        }
    }
    out
}

fn truncate_inline(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(n).collect();
        t.push('…');
        t
    }
}

/// Load project rules from `.pointer/rules/**/*.md` (preferred) or
/// `AGENTS.md` at the workspace root. The convention mirrors Cursor's
/// `.cursorrules` / `cursor.rules.md` but with a folder so users can
/// keep a per-area set of rules without one giant file.
///
/// We cap the combined content to 32 KB so a runaway rule directory
/// can't blow the prompt budget. Files are concatenated in lexicographic
/// path order so the result is deterministic.
fn load_project_rules(workspace: &str) -> Option<String> {
    if workspace.is_empty() {
        return None;
    }
    let root = Path::new(workspace);
    if !root.is_dir() {
        return None;
    }
    let mut chunks: Vec<(PathBuf, String)> = vec![];
    let mut total = 0usize;
    const CAP: usize = 32 * 1024;

    let rules_dir = root.join(".pointer").join("rules");
    if rules_dir.is_dir() {
        let walker = walkdir::WalkDir::new(&rules_dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.path()
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| s.eq_ignore_ascii_case("md") || s.eq_ignore_ascii_case("mdc"))
                        .unwrap_or(false)
            });
        let mut entries: Vec<_> = walker.collect();
        entries.sort_by(|a, b| a.path().cmp(b.path()));
        for entry in entries {
            if total >= CAP {
                break;
            }
            if let Ok(s) = std::fs::read_to_string(entry.path()) {
                let mut s = s;
                if total + s.len() > CAP {
                    s.truncate(CAP - total);
                }
                total += s.len();
                chunks.push((entry.path().to_path_buf(), s));
            }
        }
    }

    let agents_md = root.join("AGENTS.md");
    if agents_md.is_file() && total < CAP {
        if let Ok(s) = std::fs::read_to_string(&agents_md) {
            let mut s = s;
            if total + s.len() > CAP {
                s.truncate(CAP - total);
            }
            chunks.push((agents_md, s));
        }
    }

    if chunks.is_empty() {
        return None;
    }
    let mut out = String::new();
    for (path, body) in chunks {
        let rel = path
            .strip_prefix(root)
            .ok()
            .and_then(|p| p.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| path.display().to_string());
        out.push_str(&format!("\n### {rel}\n"));
        out.push_str(body.trim());
        out.push('\n');
    }
    Some(out)
}

fn take_approval(request_id: &str) -> Option<Approval> {
    APPROVALS.lock().remove(request_id)
}

// -------------------- Individual tools -------------------------------------

pub(crate) fn run_read_file(workspace: &str, call: &ToolCall) -> Result<ToolOutput, String> {
    let raw_path = call
        .attrs
        .get("path")
        .cloned()
        .unwrap_or_else(|| call.body.trim().to_string());
    let abs = resolve(workspace, &raw_path);
    let bytes = std::fs::read(&abs).map_err(|e| format!("read_file {}: {}", raw_path, e))?;
    if bytes.iter().take(2000).any(|&b| b == 0) {
        return Ok(ToolOutput {
            status: "error".into(),
            message: format!("Refusing to read binary file: {raw_path}"),
            extra: None,
        });
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    let offset = call
        .attrs
        .get("offset")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    let limit = call
        .attrs
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(READ_FILE_DEFAULT_LIMIT);
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let from = offset.min(total);
    let to = (from + limit).min(total);
    let mut numbered = String::new();
    for (i, l) in lines[from..to].iter().enumerate() {
        numbered.push_str(&format!("{:>5}|{}\n", from + i + 1, l));
    }
    if to < total {
        numbered.push_str(&format!("… ({} more lines truncated)\n", total - to));
    }
    Ok(ToolOutput {
        status: "ok".into(),
        message: numbered,
        extra: Some(json!({"path": raw_path, "total_lines": total, "shown": to - from})),
    })
}

fn run_list_dir(workspace: &str, call: &ToolCall) -> Result<ToolOutput, String> {
    let raw_path = call
        .attrs
        .get("path")
        .cloned()
        .unwrap_or_else(|| call.body.trim().to_string());
    let abs = resolve(workspace, &raw_path);
    let mut entries = vec![];
    for e in std::fs::read_dir(&abs).map_err(|e| format!("list_dir {}: {}", raw_path, e))? {
        let Ok(e) = e else { continue };
        let kind = if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            "dir"
        } else {
            "file"
        };
        let name = e.file_name().to_string_lossy().to_string();
        let size = e.metadata().ok().map(|m| m.len()).unwrap_or(0);
        entries.push(format!("{:<5} {:>10}  {}", kind, size, name));
        if entries.len() >= 500 {
            entries.push("… (truncated at 500 entries)".to_string());
            break;
        }
    }
    Ok(ToolOutput {
        status: "ok".into(),
        message: entries.join("\n"),
        extra: Some(json!({"path": raw_path, "count": entries.len()})),
    })
}

/// `<list_code_definition_names path="src/">` — emit a fast outline
/// of the top-level definitions for every source file under `path`.
/// Mirrors Cline's tool of the same name. The goal is to let the
/// agent orient itself in an unfamiliar codebase without having to
/// read every file front-to-back.
///
/// Definitions extracted (language-tolerant regex; we don't try to
/// build an AST — that would be Tree-sitter territory):
///   * JS/TS/JSX/TSX: `export function X`, `export const X`,
///     `export class X`, `class X`, `function X`, `interface X`,
///     `type X`, plus `default export X`.
///   * Python: `def X(`, `class X(` / `class X:`.
///   * Rust: `fn X(`, `pub fn X(`, `struct X`, `enum X`, `trait X`,
///     `impl ... for X`, `impl X`.
///   * Go: `func X(`, `func (r R) Method(`, `type X`.
///   * Markdown: `# ` headers (top-level only) as an outline.
pub(crate) fn run_list_code_definitions(
    workspace: &str,
    call: &ToolCall,
) -> Result<ToolOutput, String> {
    let raw_path = call
        .attrs
        .get("path")
        .cloned()
        .unwrap_or_else(|| call.body.trim().to_string());
    let abs = resolve(workspace, &raw_path);
    let mut out = String::new();
    let mut files_scanned = 0u32;
    let mut total_defs = 0u32;
    let walker = ignore::WalkBuilder::new(&abs)
        .git_ignore(true)
        .ignore(true)
        .hidden(false)
        .build();
    for d in walker.flatten() {
        if !d.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = d.path();
        let rel = path
            .strip_prefix(workspace)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let Some(defs) = extract_definitions(path, &ext) else {
            continue;
        };
        files_scanned += 1;
        if defs.is_empty() {
            continue;
        }
        out.push_str(&format!("\n{}\n", rel));
        for (kind, name, line) in &defs {
            out.push_str(&format!("  {} {}  (L{})\n", kind, name, line));
            total_defs += 1;
        }
        if files_scanned >= 100 {
            out.push_str("\n… (truncated at 100 files)\n");
            break;
        }
    }
    if total_defs == 0 {
        return Ok(ToolOutput {
            status: "ok".into(),
            message: format!("(no recognised definitions under {})", raw_path),
            extra: Some(json!({"path": raw_path, "files": files_scanned, "defs": 0})),
        });
    }
    Ok(ToolOutput {
        status: "ok".into(),
        message: out.trim_end().to_string(),
        extra: Some(json!({"path": raw_path, "files": files_scanned, "defs": total_defs})),
    })
}

/// Extract definitions from a source file. Returns
/// `Vec<(kind, name, line)>` or None for unsupported types (binary,
/// huge files, etc.).
fn extract_definitions(path: &Path, ext: &str) -> Option<Vec<(&'static str, String, usize)>> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.iter().take(2000).any(|&b| b == 0) {
        return None;
    }
    if bytes.len() > 512 * 1024 {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut out = vec![];
    let lang = match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => "js",
        "py" => "py",
        "rs" => "rs",
        "go" => "go",
        "md" => "md",
        _ => return None,
    };
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        let line_no = i + 1;
        match lang {
            "js" => {
                // export function, function, export const, const, etc.
                for (re_str, kind) in [
                    (r"^export\s+(?:async\s+)?function\s+(\w+)", "fn"),
                    (r"^(?:async\s+)?function\s+(\w+)", "fn"),
                    (r"^export\s+(?:default\s+)?class\s+(\w+)", "class"),
                    (r"^class\s+(\w+)", "class"),
                    (r"^export\s+interface\s+(\w+)", "interface"),
                    (r"^interface\s+(\w+)", "interface"),
                    (r"^export\s+type\s+(\w+)", "type"),
                    (r"^type\s+(\w+)\s*=", "type"),
                    (r"^export\s+(?:const|let|var)\s+(\w+)", "const"),
                ] {
                    if let Some(name) = first_capture(re_str, trimmed) {
                        out.push((kind, name, line_no));
                        break;
                    }
                }
            }
            "py" => {
                if let Some(name) = first_capture(r"^def\s+(\w+)\s*\(", trimmed) {
                    out.push(("fn", name, line_no));
                } else if let Some(name) = first_capture(r"^class\s+(\w+)\s*[:\(]", trimmed) {
                    out.push(("class", name, line_no));
                }
            }
            "rs" => {
                for (re_str, kind) in [
                    (r"^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[<\(]", "fn"),
                    (r"^(?:pub\s+)?struct\s+(\w+)", "struct"),
                    (r"^(?:pub\s+)?enum\s+(\w+)", "enum"),
                    (r"^(?:pub\s+)?trait\s+(\w+)", "trait"),
                    (r"^impl(?:<[^>]*>)?\s+(\w+)", "impl"),
                ] {
                    if let Some(name) = first_capture(re_str, trimmed) {
                        out.push((kind, name, line_no));
                        break;
                    }
                }
            }
            "go" => {
                if let Some(name) = first_capture(r"^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(", trimmed) {
                    out.push(("fn", name, line_no));
                } else if let Some(name) = first_capture(r"^type\s+(\w+)\s+", trimmed) {
                    out.push(("type", name, line_no));
                }
            }
            "md" => {
                if let Some(name) = first_capture(r"^#\s+(.+)$", trimmed) {
                    out.push(("h1", name, line_no));
                }
            }
            _ => {}
        }
    }
    Some(out)
}

fn first_capture(pattern: &str, text: &str) -> Option<String> {
    let re = regex::Regex::new(pattern).ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

pub(crate) fn run_glob(workspace: &str, call: &ToolCall) -> Result<ToolOutput, String> {
    let pattern = call.body.trim();
    if pattern.is_empty() {
        return Err("glob: empty pattern".into());
    }
    let matcher = globset::Glob::new(pattern)
        .map_err(|e| format!("glob pattern: {e}"))?
        .compile_matcher();
    let walker = ignore::WalkBuilder::new(workspace)
        .git_ignore(true)
        .ignore(true)
        .hidden(false)
        .build();
    let mut hits = vec![];
    for d in walker.flatten() {
        let rel = d
            .path()
            .strip_prefix(workspace)
            .unwrap_or(d.path())
            .to_string_lossy()
            .to_string();
        if matcher.is_match(&rel) {
            hits.push(rel);
            if hits.len() >= 200 {
                hits.push("… (truncated at 200)".into());
                break;
            }
        }
    }
    Ok(ToolOutput {
        status: "ok".into(),
        message: if hits.is_empty() {
            "no matches".into()
        } else {
            hits.join("\n")
        },
        extra: Some(json!({"pattern": pattern, "count": hits.len()})),
    })
}

pub(crate) fn run_grep(workspace: &str, call: &ToolCall) -> Result<ToolOutput, String> {
    let q = call.body.trim();
    if q.is_empty() {
        return Err("grep: empty query".into());
    }
    // ripgrep-style behaviour: try to compile the query as a regex
    // first; on failure fall back to literal substring matching.
    // Models trained on real-world repos overwhelmingly emit regex
    // (e.g. `helper\d+\(`) for greps, so accepting both keeps the
    // surface honest. A failing compile still works fine as literal.
    let re = regex::RegexBuilder::new(q).multi_line(true).build().ok();
    let glob_filter = call
        .attrs
        .get("glob")
        .and_then(|p| globset::Glob::new(p).ok());
    let glob_matcher = glob_filter.map(|g| g.compile_matcher());
    let walker = ignore::WalkBuilder::new(workspace)
        .git_ignore(true)
        .ignore(true)
        .hidden(false)
        .build();
    let mut hits = vec![];
    for d in walker.flatten() {
        if !d.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let rel = d
            .path()
            .strip_prefix(workspace)
            .unwrap_or(d.path())
            .to_string_lossy()
            .to_string();
        if let Some(m) = &glob_matcher {
            if !m.is_match(&rel) {
                continue;
            }
        }
        let bytes = match std::fs::read(d.path()) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if bytes.iter().take(2000).any(|&b| b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            let matched = if let Some(re) = &re {
                re.is_match(line)
            } else {
                line.contains(q)
            };
            if matched {
                hits.push(format!("{}:{}: {}", rel, i + 1, line.trim_end()));
                if hits.len() >= 80 {
                    hits.push("… (truncated at 80 hits)".into());
                    return Ok(ToolOutput {
                        status: "ok".into(),
                        message: hits.join("\n"),
                        extra: Some(json!({"query": q, "count": hits.len()})),
                    });
                }
            }
        }
    }
    Ok(ToolOutput {
        status: "ok".into(),
        message: if hits.is_empty() {
            "no matches".into()
        } else {
            hits.join("\n")
        },
        extra: Some(json!({"query": q, "count": hits.len()})),
    })
}

fn run_search_codebase(
    app: &AppHandle,
    request_id: &str,
    call: &ToolCall,
) -> Result<ToolOutput, String> {
    let evt = format!("agent:event:{}", request_id);
    let _ = app.emit(
        &evt,
        json!({"kind":"tool_proxy", "tool": "search_codebase", "args": call.body}),
    );
    // The actual semantic search runs in the indexer command from the
    // frontend; we surface a hint here. If the frontend wants to wire a
    // synchronous answer in the future, expose it via state.
    Ok(ToolOutput {
        status: "ok".into(),
        message: format!("Codebase search proxied to indexer: {}", call.body.trim()),
        extra: Some(json!({"query": call.body.trim()})),
    })
}

fn run_write_file(
    app: &AppHandle,
    step: u32,
    workspace: &str,
    call: &ToolCall,
) -> Result<ToolOutput, String> {
    let path = call
        .attrs
        .get("path")
        .ok_or_else(|| "write_file: missing path attribute".to_string())?
        .clone();
    let abs = resolve(workspace, &path);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    // Snapshot the BEFORE state so the review card can show a diff
    // and the user can undo. We do this BEFORE the write so a partial
    // failure leaves the original file intact. `existed` lets us
    // distinguish create-vs-modify for the undo action.
    let existed = abs.exists();
    let before_bytes: Vec<u8> = if existed {
        std::fs::read(&abs).unwrap_or_default()
    } else {
        Vec::new()
    };
    std::fs::write(&abs, &call.body).map_err(|e| format!("write_file {}: {}", path, e))?;
    let change = if existed {
        // No-op overwrite (same bytes) returns None — we skip
        // recording so the review panel doesn't fill with noise.
        crate::commands::agent_changes::record_modify(
            app,
            step,
            &path,
            &before_bytes,
            call.body.as_bytes(),
        )
        .map_err(|e| format!("write_file snapshot {}: {}", path, e))?
    } else {
        Some(
            crate::commands::agent_changes::record_create(app, step, &path, call.body.as_bytes())
                .map_err(|e| format!("write_file snapshot {}: {}", path, e))?,
        )
    };
    let mut extra = json!({"path": path, "bytes": call.body.len()});
    if let Some(c) = change {
        extra["change"] = serde_json::to_value(c).unwrap_or(json!(null));
    }
    Ok(ToolOutput {
        status: "ok".into(),
        message: format!("Wrote {} ({} bytes)", path, call.body.len()),
        extra: Some(extra),
    })
}

pub(crate) fn run_apply_diff(
    app: &AppHandle,
    step: u32,
    workspace: &str,
    call: &ToolCall,
) -> Result<ToolOutput, String> {
    let path = call
        .attrs
        .get("path")
        .ok_or_else(|| "apply_diff: missing path attribute".to_string())?
        .clone();
    let abs = resolve(workspace, &path);
    let original = match std::fs::read_to_string(&abs) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // The file doesn't exist at the path the model guessed.
            // This is the #1 way the model gets stuck — it assumes a
            // sibling path next to a file it just created. Give it
            // actionable nearby suggestions instead of a generic
            // "No such file or directory" that just sends it back
            // for another (also wrong) <read_file>.
            let suggestions = find_similar_paths(workspace, &path);
            let hint = if suggestions.is_empty() {
                format!(
                    "apply_diff: file `{}` does not exist. \
                     Use <list_dir path=\".\" /> or <glob>**/{}</glob> to find the right path, \
                     or use <write_file path=\"{}\">…</write_file> if you intend to create it.",
                    path,
                    Path::new(&path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&path),
                    path,
                )
            } else {
                format!(
                    "apply_diff: file `{}` does not exist. \
                     Did you mean one of these (same basename, found in the workspace)? \
                     {}. \
                     If not, use <list_dir path=\".\" /> or <glob>**/{}</glob> to locate it, \
                     or <write_file> if you intend to create it.",
                    path,
                    suggestions
                        .iter()
                        .map(|p| format!("`{}`", p))
                        .collect::<Vec<_>>()
                        .join(", "),
                    Path::new(&path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&path),
                )
            };
            return Err(hint);
        }
        Err(e) => return Err(format!("apply_diff read {}: {}", path, e)),
    };
    let hunks = parse_search_replace(&call.body)?;
    if hunks.is_empty() {
        return Err("apply_diff: no SEARCH/REPLACE hunks parsed".into());
    }
    let mut current = original.clone();
    let mut applied = 0;
    let mut failed = vec![];
    for (i, h) in hunks.iter().enumerate() {
        if let Some(idx) = current.find(&h.search) {
            let mut next = String::with_capacity(current.len() + h.replace.len());
            next.push_str(&current[..idx]);
            next.push_str(&h.replace);
            next.push_str(&current[idx + h.search.len()..]);
            current = next;
            applied += 1;
        } else {
            failed.push(format!("hunk #{} did not match", i + 1));
        }
    }
    if applied == 0 {
        return Err(format!(
            "apply_diff: no hunks matched ({} attempted).\nFirst miss preview:\n{}",
            hunks.len(),
            hunks
                .first()
                .map(|h| h.search.lines().take(4).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default(),
        ));
    }
    std::fs::write(&abs, &current).map_err(|e| format!("apply_diff write {}: {}", path, e))?;
    // Record AFTER the write so we don't snapshot a state that's
    // about to be reverted by a downstream IO failure. record_modify
    // returns None when bytes are unchanged (defensive — apply_diff
    // already guards against zero-hunk cases above).
    let change = crate::commands::agent_changes::record_modify(
        app,
        step,
        &path,
        original.as_bytes(),
        current.as_bytes(),
    )
    .map_err(|e| format!("apply_diff snapshot {}: {}", path, e))?;
    let mut extra =
        json!({"path": path, "applied": applied, "total": hunks.len(), "failed": failed});
    if let Some(c) = change {
        extra["change"] = serde_json::to_value(c).unwrap_or(json!(null));
    }
    Ok(ToolOutput {
        status: "ok".into(),
        message: format!(
            "Applied {}/{} hunk{} to {}{}",
            applied,
            hunks.len(),
            if applied == 1 { "" } else { "s" },
            path,
            if failed.is_empty() {
                "".into()
            } else {
                format!(" ({} skipped)", failed.len())
            },
        ),
        extra: Some(extra),
    })
}

fn run_delete_path(
    app: &AppHandle,
    step: u32,
    workspace: &str,
    call: &ToolCall,
) -> Result<ToolOutput, String> {
    let path = call
        .attrs
        .get("path")
        .cloned()
        .unwrap_or_else(|| call.body.trim().to_string());
    if path.is_empty() {
        return Err("delete_path: missing path".into());
    }
    let abs = resolve(workspace, &path);
    let is_dir = abs.is_dir();
    // Snapshot the file's content BEFORE deletion so undo can
    // restore it. Directory deletes are not undo-able in v1 — the
    // snapshot would have to recurse + serialise an arbitrary tree,
    // which we'd rather skip than half-implement. We still let the
    // delete proceed, just without a change record.
    let before_bytes: Option<Vec<u8>> = if is_dir {
        None
    } else {
        std::fs::read(&abs).ok()
    };
    if is_dir {
        std::fs::remove_dir_all(&abs).map_err(|e| format!("delete_path {}: {}", path, e))?;
    } else {
        std::fs::remove_file(&abs).map_err(|e| format!("delete_path {}: {}", path, e))?;
    }
    let mut extra = json!({"path": path});
    if let Some(b) = before_bytes {
        let change = crate::commands::agent_changes::record_delete(app, step, &path, &b)
            .map_err(|e| format!("delete_path snapshot {}: {}", path, e))?;
        extra["change"] = serde_json::to_value(change).unwrap_or(json!(null));
    }
    Ok(ToolOutput {
        status: "ok".into(),
        message: format!("Deleted {path}"),
        extra: Some(extra),
    })
}

fn run_rename_path(
    app: &AppHandle,
    step: u32,
    workspace: &str,
    call: &ToolCall,
) -> Result<ToolOutput, String> {
    let from = call
        .attrs
        .get("from")
        .cloned()
        .ok_or_else(|| "rename_path: missing from".to_string())?;
    let to = call
        .attrs
        .get("to")
        .cloned()
        .ok_or_else(|| "rename_path: missing to".to_string())?;
    let abs_from = resolve(workspace, &from);
    let abs_to = resolve(workspace, &to);
    if let Some(parent) = abs_to.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    std::fs::rename(&abs_from, &abs_to)
        .map_err(|e| format!("rename_path {} -> {}: {}", from, to, e))?;
    let change = crate::commands::agent_changes::record_rename(app, step, &from, &to)
        .map_err(|e| format!("rename_path snapshot {} -> {}: {}", from, to, e))?;
    Ok(ToolOutput {
        status: "ok".into(),
        message: format!("Renamed {from} -> {to}"),
        extra: Some(json!({
            "from": from,
            "to": to,
            "change": serde_json::to_value(change).unwrap_or(json!(null)),
        })),
    })
}

/// Run a shell command. This used to be a one-liner around
/// `std::process::Command` that drained stdout/stderr only after
/// the child exited — which deadlocked the moment a chatty
/// installer (`npx create-react-app`, `npm install`, `cargo build`)
/// filled the ~64 KB OS pipe buffer. The child blocked on
/// `write()`, we kept waiting for it to exit, and the whole agent
/// loop froze until the 120 s timeout fired. Symptom: the IDE
/// looked hung.
///
/// The rewrite fixes that and a few related sharp edges:
///   * pipes are drained on dedicated reader threads (no deadlock),
///   * stdin is `Stdio::null()` so commands that prompt
///     interactively (CRA, `npm init`, `apt install`) hit EOF
///     instead of waiting forever for input,
///   * stdout/stderr chunks are streamed back to the frontend as
///     `shell_progress` events so the UI can render a live tail
///     instead of a frozen card,
///   * a cancel channel lets `agent_cancel` SIGTERM the child,
///   * the default timeout is raised from 2 → 5 minutes (the
///     hard cap remains 15 minutes), since install-class commands
///     routinely take longer than 2 minutes.
///
/// Output captured into the transcript is capped at 8 KB per
/// stream so a million-line CI log can't blow up the context
/// window; the live `shell_progress` stream is the place to look
/// at the full output if needed.
pub(crate) async fn run_shell(
    app: &AppHandle,
    request_id: &str,
    workspace: &str,
    call: &ToolCall,
) -> Result<ToolOutput, String> {
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;

    let cmd = call.body.trim();
    if cmd.is_empty() {
        return Err("run_shell: empty command".into());
    }
    // Parse the optional `wait_for=` attribute first — it changes
    // how we treat blocking commands. If the model explicitly says
    // "run this until you see X", we skip the refusal list and
    // honor the request. The poller below tears the process down
    // when the signal hits.
    let wait_for = call.attrs.get("wait_for").and_then(|s| parse_wait_for(s));
    if let Some(WaitForSpec::Invalid(reason)) = &wait_for {
        return Err(format!(
            "run_shell: invalid wait_for value: {reason}. Valid forms: \
             `wait_for=\"port:3000\"`, `wait_for=\"output:Listening on\"`, \
             `wait_for=\"file:dist/bundle.js\"`."
        ));
    }
    if wait_for.is_none() {
        // Pre-flight: refuse known blocking commands BEFORE spawning.
        // Detecting after spawn is correct as a safety net, but it
        // still costs ~2s + a misleading "process started then died"
        // signal. Refusing up-front gives the model an immediate,
        // clear error it can react to in the same turn.
        // SKIPPED when `wait_for=` is present — the model has
        // explicitly described the terminating signal.
        if let Some(msg) = blocking_command_refusal(cmd) {
            return Err(msg);
        }
    }
    // For `wait_for=` runs, we default to a much shorter timeout
    // (the whole point is to bail as soon as the signal hits) but
    // still let the model override it explicitly.
    let default_timeout_ms = if wait_for.is_some() {
        60 * 1000 // 1 minute is plenty for "wait until port is up"
    } else {
        5 * 60 * 1000
    };
    let timeout_ms = call
        .attrs
        .get("timeout_ms")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(default_timeout_ms)
        .min(15 * 60 * 1000);

    let (sh, flag) = if cfg!(windows) {
        ("cmd", "/C")
    } else {
        ("/bin/sh", "-c")
    };
    let workspace = workspace.to_string();
    let cmd_owned = cmd.to_string();
    let app_clone = app.clone();
    let req_id_owned = request_id.to_string();
    let evt_name = format!("agent:event:{}", request_id);
    let wait_for_owned = wait_for.clone();

    type ShellBlockingResult = Result<
        (
            i32,
            String,
            String,
            bool,
            Option<&'static str>,
            Option<String>,
        ),
        String,
    >;

    let join = tokio::task::spawn_blocking(move || -> ShellBlockingResult {
        // stdin is now `piped` (not `null`) so we can forward the
        // user's response when the child sits on an interactive
        // prompt like "Ok to proceed? (y) ". The reader thread
        // detects strong prompt patterns and emits a `shell_prompt`
        // event; the frontend collects the response and ships it
        // through `agent_shell_respond`, which we write into stdin
        // and continue.
        //
        // For commands that DON'T prompt, this is functionally
        // identical to the previous `Stdio::null()` since the
        // child sees an inherited empty stdin buffer.
        let mut command = std::process::Command::new(sh);
        command
            .arg(flag)
            .arg(&cmd_owned)
            .current_dir(if workspace.is_empty() { ".".into() } else { workspace.clone() })
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // CRITICAL on Unix: put the child in its own process group
        // via `setsid`. Without this, `npm run dev` spawns `vite`
        // as a grandchild in the SAME process group as our shell,
        // and `libc::kill(pid, SIGTERM)` only signals the shell.
        // The shell exits but `vite` keeps running and never closes
        // its inherited stdout, so our reader threads block on
        // `read()` and `child.wait()` returns immediately — but the
        // FD lives in the orphaned grandchild forever. We then sit
        // in `join_thread.join()` and the agent hangs.
        //
        // With `setsid`, the entire grandchild tree is in process
        // group `pid`. We then signal `-pid` (negative = "the whole
        // group") to take everything down cleanly.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                command.pre_exec(|| {
                    // setsid creates a new session AND process
                    // group with this process as the leader. Any
                    // descendants (`vite`, `node`, …) inherit the
                    // group automatically.
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let mut child = command.spawn().map_err(|e| format!("spawn: {e}"))?;
        let pid = child.id();

        // Register the PID so agent_cancel can reach in and SIGTERM
        // this process when the user clicks "stop."
        let cancelled = Arc::new(AtomicBool::new(false));
        register_shell_pid(&req_id_owned, pid, cancelled.clone());

        // Shared stdin handle — wrapped so both reader threads can
        // forward a user response when they detect a prompt.
        let child_stdin = child.stdin.take();
        let stdin_shared: Arc<Mutex<Option<std::process::ChildStdin>>> =
            Arc::new(Mutex::new(child_stdin));
        // Monotonic prompt counter so each prompt event gets a
        // unique id even within a single shell call.
        let prompt_counter = Arc::new(AtomicU64::new(0));
        // Set by either reader thread when it sees the streamed
        // output cross a "dev server is ready" pattern. The wait
        // loop polls this; when set, we SIGTERM the never-exiting
        // child and report success so the agent can keep going.
        // Holds the family name ("vite", "nextjs", …) so the
        // synthesized status message can be informative.
        let server_ready: Arc<Mutex<Option<&'static str>>> = Arc::new(Mutex::new(None));

        // Set when an explicit `wait_for=` condition is satisfied
        // (e.g. port 3000 bound, file dist/bundle.js appeared,
        // output substring matched). Carries a human-readable
        // description that goes into the result so the model knows
        // exactly which condition triggered termination.
        let wait_for_matched: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        // Lowercase substring the reader threads should look for in
        // the output tail. None when wait_for is port: / file: only.
        let wait_for_output_needle: Option<String> = match &wait_for_owned {
            Some(WaitForSpec::Output(s)) => Some(s.to_lowercase()),
            _ => None,
        };

        // Drain stdout/stderr on dedicated threads so OS pipe
        // buffers can't deadlock the child. Both threads also push
        // tail-of-output back to the frontend as `shell_progress`
        // events so the UI shows a live readout instead of a frozen
        // card. Cap captured bytes at 64 KB per stream — anything
        // beyond that is interesting only for live viewing.
        const CAPTURE_CAP: usize = 64 * 1024;
        // The tail covers the last ~4 KB so multi-line server
        // banners (Vite/Next.js typically print 3–6 lines before
        // they're truly ready) are visible to the detector. Prompt
        // detection only looks at the final line anyway, so this
        // doesn't increase false-prompt risk.
        const TAIL_WINDOW: usize = 4096;
        let make_reader = |
            mut pipe: Box<dyn std::io::Read + Send>,
            stream_name: &'static str,
            app: tauri::AppHandle,
            evt: String,
            req_id: String,
            stdin_arc: Arc<Mutex<Option<std::process::ChildStdin>>>,
            cancelled_flag: Arc<AtomicBool>,
            prompt_ctr: Arc<AtomicU64>,
            server_ready_arc: Arc<Mutex<Option<&'static str>>>,
            wait_for_output: Option<String>,
            wait_for_match_arc: Arc<Mutex<Option<String>>>,
        | {
            std::thread::spawn(move || -> String {
                let mut byte_buf = [0u8; 4096];
                let mut buf = String::new();
                let mut total = 0usize;
                // Tail used for prompt detection — covers the last
                // ~1 KB, including partial lines without a newline.
                let mut tail: Vec<u8> = Vec::with_capacity(TAIL_WINDOW + 64);
                // Suppress re-detection of the same prompt: once we
                // forward a response, ignore the next ~200ms of
                // bytes for detection purposes (the echo may still
                // match the prompt regex).
                let mut suppress_until = Instant::now() - Duration::from_secs(1);

                // Emit throttle: a chatty installer like `npm
                // install` produces thousands of lines/sec. Without
                // throttling we'd cross the Tauri IPC bridge once
                // per line, slamming the renderer with re-renders
                // and lighting up the CPU/fans for a frozen-feeling
                // UX. We batch up to FLUSH_INTERVAL of output (or
                // FLUSH_CHARS, whichever hits first) per stream and
                // emit one consolidated chunk. Prompt detection
                // still runs on every byte read so we don't add
                // pause latency.
                const FLUSH_INTERVAL: Duration = Duration::from_millis(100);
                const FLUSH_CHARS: usize = 4096;
                let mut pending_chunk = String::new();
                let mut last_flush = Instant::now();
                let flush_pending = |
                    pending_chunk: &mut String,
                    last_flush: &mut Instant,
                | {
                    if pending_chunk.is_empty() {
                        return;
                    }
                    let _ = app.emit(
                        &evt,
                        json!({
                            "kind": "shell_progress",
                            "request_id": req_id,
                            "stream": stream_name,
                            "chunk": pending_chunk.clone(),
                        }),
                    );
                    pending_chunk.clear();
                    *last_flush = Instant::now();
                };

                loop {
                    if cancelled_flag.load(Ordering::SeqCst) {
                        flush_pending(&mut pending_chunk, &mut last_flush);
                        break;
                    }
                    let n = match pipe.read(&mut byte_buf) {
                        Ok(0) => {
                            flush_pending(&mut pending_chunk, &mut last_flush);
                            break;
                        }
                        Ok(n) => n,
                        Err(_) => {
                            flush_pending(&mut pending_chunk, &mut last_flush);
                            break;
                        }
                    };
                    let chunk_bytes = &byte_buf[..n];
                    // Stream-as-utf8 (lossy is fine for terminal
                    // output; we never re-encode this).
                    let chunk = String::from_utf8_lossy(chunk_bytes).into_owned();

                    if total < CAPTURE_CAP {
                        let take = (CAPTURE_CAP - total).min(chunk.len());
                        buf.push_str(&chunk[..take]);
                        total += take;
                    }

                    pending_chunk.push_str(&chunk);
                    if pending_chunk.len() >= FLUSH_CHARS
                        || last_flush.elapsed() >= FLUSH_INTERVAL
                    {
                        flush_pending(&mut pending_chunk, &mut last_flush);
                    }

                    // Slide tail window.
                    tail.extend_from_slice(chunk_bytes);
                    if tail.len() > TAIL_WINDOW {
                        let drop = tail.len() - TAIL_WINDOW;
                        tail.drain(..drop);
                    }

                    // Explicit wait_for="output:…" check. Always
                    // takes precedence over auto-detect since the
                    // model has declared what it's looking for.
                    if let Some(needle) = &wait_for_output {
                        let mut match_guard = wait_for_match_arc.lock();
                        if match_guard.is_none() {
                            let tail_str = String::from_utf8_lossy(&tail);
                            if tail_str.to_lowercase().contains(needle) {
                                *match_guard = Some(format!(
                                    "matched wait_for=\"output:{}\"",
                                    needle,
                                ));
                            }
                        }
                    }

                    // Auto dev-server readiness detection: if the
                    // streamed output crosses a "Listening on …" /
                    // "Local: http://…" / "Compiled successfully"
                    // signal — across every major web framework —
                    // flag the wait loop so it gracefully SIGTERMs
                    // the never-exiting child. Without this the
                    // agent loop hangs on the dev server until the
                    // 5-minute timeout.
                    {
                        let mut ready_guard = server_ready_arc.lock();
                        if ready_guard.is_none() {
                            let tail_str = String::from_utf8_lossy(&tail);
                            if let Some(family) = detect_server_ready(&tail_str) {
                                *ready_guard = Some(family);
                            }
                        }
                    }

                    if Instant::now() < suppress_until {
                        continue;
                    }
                    let tail_str = String::from_utf8_lossy(&tail);
                    if let Some(prompt_text) = detect_prompt(&tail_str) {
                        // Flush pending output BEFORE prompting so
                        // the UI shows the question on screen
                        // before the input box opens.
                        flush_pending(&mut pending_chunk, &mut last_flush);
                        let pid_n = prompt_ctr.fetch_add(1, Ordering::SeqCst);
                        let prompt_id = format!("{}/{}", req_id, pid_n);
                        let (tx, rx) = std::sync::mpsc::channel::<String>();
                        register_shell_prompt(&prompt_id, tx);
                        let _ = app.emit(
                            &evt,
                            json!({
                                "kind": "shell_prompt",
                                "request_id": req_id,
                                "prompt_id": prompt_id,
                                "prompt": prompt_text,
                                "stream": stream_name,
                            }),
                        );
                        // Block up to 2 minutes for the user's
                        // reply. If we time out, send a newline so
                        // the child either takes its default (npm
                        // 7+ "Ok to proceed?" defaults to y on
                        // empty input) or fails fast.
                        let response = rx
                            .recv_timeout(Duration::from_secs(120))
                            .unwrap_or_default();
                        // `parking_lot::Mutex::lock` returns the
                        // guard directly (no Result).
                        let mut guard = stdin_arc.lock();
                        if let Some(ref mut sin) = *guard {
                            let _ = sin.write_all(response.as_bytes());
                            let _ = sin.write_all(b"\n");
                            let _ = sin.flush();
                        }
                        drop(guard);
                        // Suppress re-detection briefly.
                        suppress_until = Instant::now() + Duration::from_millis(200);
                        // Reset tail so the prompt text doesn't
                        // re-trigger on the next read.
                        tail.clear();
                    }
                }
                buf
            })
        };

        let stdout_handle = child.stdout.take().map(|p| {
            make_reader(
                Box::new(p),
                "stdout",
                app_clone.clone(),
                evt_name.clone(),
                req_id_owned.clone(),
                stdin_shared.clone(),
                cancelled.clone(),
                prompt_counter.clone(),
                server_ready.clone(),
                wait_for_output_needle.clone(),
                wait_for_matched.clone(),
            )
        });
        let stderr_handle = child.stderr.take().map(|p| {
            make_reader(
                Box::new(p),
                "stderr",
                app_clone.clone(),
                evt_name.clone(),
                req_id_owned.clone(),
                stdin_shared.clone(),
                cancelled.clone(),
                prompt_counter.clone(),
                server_ready.clone(),
                wait_for_output_needle.clone(),
                wait_for_matched.clone(),
            )
        });

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut timed_out = false;
        let mut user_cancelled = false;
        // Set when the reader detects a dev-server-ready banner.
        let mut server_terminated: Option<&'static str> = None;
        // Once readiness is detected we give the server ~1.5s to
        // finish emitting its banner before we send SIGTERM —
        // makes the captured output look clean.
        // Helper: send SIGTERM to the child's entire process group,
        // then escalate to SIGKILL on the group if it doesn't exit
        // within ~500ms. This is essential for `npm run dev` and
        // friends where `npm` spawns `vite` as a grandchild; without
        // group-targeted signals the grandchild outlives the SIGTERM
        // and our reader threads block forever on its open FDs.
        let kill_tree = |child: &mut std::process::Child| {
            #[cfg(unix)]
            unsafe {
                // -pid means "the process group whose leader is pid".
                // Safe because we set up the group via setsid() in
                // pre_exec; the leader is the child shell PID.
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
            #[cfg(not(unix))]
            let _ = child.kill();
            // Give the group up to 500ms to exit gracefully.
            let escalate_at = Instant::now() + Duration::from_millis(500);
            while Instant::now() < escalate_at {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            // SIGKILL the group — anything still alive (vite, esbuild,
            // node) gets dropped immediately. On non-unix, fall back
            // to killing just the child.
            #[cfg(unix)]
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            #[cfg(not(unix))]
            let _ = child.kill();
            let _ = child.wait();
        };

        let mut readiness_deadline: Option<Instant> = None;
        let mut wait_for_match_description: Option<String> = None;
        // Poll port/file every 500ms — cheap operations, no need
        // to hammer them. Output matching happens in the reader
        // threads in real time. Port-poll skipped until the first
        // 500ms so the child has a chance to bind before we check.
        let mut next_wait_poll = Instant::now() + Duration::from_millis(500);
        let workspace_path = std::path::PathBuf::from(if workspace.is_empty() {
            ".".to_string()
        } else {
            workspace.clone()
        });
        loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(_) => break,
                None => {
                    if cancelled.load(Ordering::SeqCst) {
                        user_cancelled = true;
                        kill_tree(&mut child);
                        break;
                    }

                    // ── wait_for=… condition checks ────────────
                    // Output matches are populated by the reader
                    // threads; port/file are polled here.
                    if wait_for_match_description.is_none() {
                        if let Some(desc) = wait_for_matched.lock().clone() {
                            wait_for_match_description = Some(desc);
                            readiness_deadline =
                                Some(Instant::now() + Duration::from_millis(500));
                        }
                    }
                    if wait_for_match_description.is_none() && Instant::now() >= next_wait_poll {
                        next_wait_poll =
                            Instant::now() + Duration::from_millis(500);
                        match &wait_for_owned {
                            Some(WaitForSpec::Port(port)) => {
                                if tcp_port_is_open(*port) {
                                    let desc = format!(
                                        "matched wait_for=\"port:{}\" (TCP listener accepting connections)",
                                        port,
                                    );
                                    *wait_for_matched.lock() = Some(desc.clone());
                                    wait_for_match_description = Some(desc);
                                    readiness_deadline = Some(
                                        Instant::now() + Duration::from_millis(500),
                                    );
                                }
                            }
                            Some(WaitForSpec::File(rel)) => {
                                let p = if std::path::Path::new(rel).is_absolute() {
                                    std::path::PathBuf::from(rel)
                                } else {
                                    workspace_path.join(rel)
                                };
                                if p.exists() {
                                    let desc = format!(
                                        "matched wait_for=\"file:{}\" (path exists on disk)",
                                        rel,
                                    );
                                    *wait_for_matched.lock() = Some(desc.clone());
                                    wait_for_match_description = Some(desc);
                                    readiness_deadline = Some(
                                        Instant::now() + Duration::from_millis(500),
                                    );
                                }
                            }
                            _ => {}
                        }
                    }

                    // Promote readiness detection from the reader
                    // threads. We only check once because the
                    // reader threads set it then leave it.
                    // Skip auto-detection when wait_for is set —
                    // the model has declared the canonical signal,
                    // we shouldn't second-guess it.
                    if server_terminated.is_none()
                        && wait_for_match_description.is_none()
                        && wait_for_owned.is_none()
                    {
                        let fam = *server_ready.lock();
                        if let Some(family) = fam {
                            server_terminated = Some(family);
                            readiness_deadline =
                                Some(Instant::now() + Duration::from_millis(1500));
                        }
                    }
                    if let Some(by) = readiness_deadline {
                        if Instant::now() >= by {
                            kill_tree(&mut child);
                            break;
                        }
                    }
                    if Instant::now() > deadline {
                        timed_out = true;
                        kill_tree(&mut child);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(80));
                }
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        unregister_shell_pid(&req_id_owned);
        let out = stdout_handle.and_then(|h| h.join().ok()).unwrap_or_default();
        let err = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();
        let code = if timed_out {
            return Err(format!("run_shell: timed out after {}ms (stdout/stderr captured below)\n--- stdout ---\n{}\n--- stderr ---\n{}", timeout_ms, truncate(&out, 4000), truncate(&err, 4000)));
        } else if user_cancelled {
            -2
        } else if server_terminated.is_some() || wait_for_match_description.is_some() {
            // Both flavors of "we tore it down on purpose" count
            // as success. The model needs to know the underlying
            // command was actually working when we cut it.
            0
        } else {
            status.code().unwrap_or(-1)
        };
        Ok((
            code,
            out,
            err,
            user_cancelled,
            server_terminated,
            wait_for_match_description,
        ))
    })
    .await
    .map_err(|e| format!("run_shell join: {e}"))?;

    let (code, out, err, user_cancelled, server_family, wait_for_match) = join?;
    let trimmed_out = truncate(&out, 8000);
    let trimmed_err = truncate(&err, 8000);
    // For dev-server-terminated runs, prepend a note so the model
    // (and the user) sees what happened — otherwise the agent
    // could try to "fix" the SIGTERM by re-running the same
    // command.
    let server_note = if let Some(desc) = &wait_for_match {
        Some(format!(
            "\n--- run_shell note ---\n\
             {} — the harness gracefully terminated the process after the condition held. \
             Treat this as success: the command was running normally when we stopped it.\n",
            desc,
        ))
    } else {
        server_family.map(|family| {
            format!(
                "\n--- run_shell note ---\n\
                 Detected a long-running foreground process ({family}) reaching steady state and gracefully terminated it. \
                 The command above does NOT exit on its own; in agent mode we don't keep servers/watchers running. \
                 For your next turn: either move on to a build/test command, or ask the user to run the dev server themselves. \
                 If you actually wanted to verify the process starts cleanly, pass `wait_for=\"port:N\"` or `wait_for=\"output:...\"` to make the intent explicit.\n"
            )
        })
    };
    let combined = format!(
        "exit={code}\n--- stdout ---\n{trimmed_out}\n--- stderr ---\n{trimmed_err}{}",
        server_note.as_deref().unwrap_or(""),
    );
    let status = if user_cancelled {
        "rejected"
    } else if code == 0 {
        "ok"
    } else {
        "error"
    };
    Ok(ToolOutput {
        status: status.into(),
        message: combined,
        extra: Some(json!({
            "exit_code": code,
            "stdout": trimmed_out,
            "stderr": trimmed_err,
            "cancelled": user_cancelled,
            "dev_server_detected": server_family,
            "wait_for_matched": wait_for_match,
        })),
    })
}

/// Detect whether a tail of stdout/stderr is sitting on an
/// interactive prompt that's waiting for user input. Returns the
/// human-readable prompt text (the last non-empty line) when a
/// strong pattern matches; `None` otherwise.
///
/// We deliberately only match HIGH-CONFIDENCE patterns — anything
/// less and we'd pause the agent on log lines that happen to end
/// in `?` or `:`. False positives are worse than false negatives
/// here because the 5-minute timeout still safety-nets a missed
/// prompt, but a wrong pause stops a working command.
///
/// Patterns currently recognised (case-insensitive where it makes
/// sense, with surrounding whitespace tolerance):
///   * `[y/n]`, `[Y/n]`, `[y/N]`, `(y/n)`, `(Y/n)`, `(y/N)`, `(yes/no)`
///   * trailing `(y)` — npm 7+ "Ok to proceed?" style
///   * `password:`, `passphrase:`, `passcode:` at end of line
///   * `Ok to proceed`, `Continue?`, `Are you sure`, `Proceed`
///   * `... ?` followed by ` ` at end of buffer (a printed prompt
///     with no newline AND a trailing question mark)
fn detect_prompt(tail: &str) -> Option<String> {
    // Look at just the last line — multi-line prompts always echo
    // the actual ASK on the final line.
    let last = tail
        .lines()
        .last()
        .map(|s| s.trim_end_matches(['\r', ' ', '\t']))
        .filter(|s| !s.is_empty())?;
    // But also keep the trailing whitespace context (for the
    // "ends with `? ` or `: `" no-newline patterns).
    let last_with_ws = tail.rsplit_once('\n').map(|(_, s)| s).unwrap_or(tail);
    let lower = last.to_lowercase();

    // Strong y/n patterns.
    const YN: &[&str] = &[
        "[y/n]", "[y/n]?", "(y/n)", "(yes/no)", "[yes/no]", " (y) ", " (y)?", "(y) ", "(y)?",
    ];
    for needle in YN {
        if lower.contains(needle) {
            return Some(last.to_string());
        }
    }

    // Password-class — the keyword and the colon may be separated
    // by other text (e.g. `Enter passphrase for /Users/x/.ssh/...:`
    // or `[sudo] password for alice:`). Require the keyword AND a
    // trailing colon on the same line.
    const PASS_KEYWORDS: &[&str] = &["password", "passphrase", "passcode", "pin"];
    for kw in PASS_KEYWORDS {
        if lower.contains(kw) && (last.ends_with(':') || last_with_ws.ends_with(": ")) {
            return Some(last.to_string());
        }
    }

    // Known phrases that always indicate a question.
    const PHRASES: &[&str] = &[
        "ok to proceed",
        "are you sure",
        "do you want to continue",
        "do you want to proceed",
        "continue?",
        "overwrite?",
        "proceed?",
    ];
    for needle in PHRASES {
        if lower.contains(needle) {
            return Some(last.to_string());
        }
    }

    // Final fallback: the buffer ENDS with `? ` (question mark
    // followed by space, no newline) — common for CLI prompts that
    // sit on the line waiting. Required: at least one alphabetic
    // character before, so we don't fire on `?` in JSON output.
    if let Some(prefix) = last_with_ws.strip_suffix("? ") {
        if prefix.chars().filter(|c| c.is_alphabetic()).count() >= 3 {
            return Some(prefix.trim_start().to_string() + "?");
        }
    }

    None
}

/// Classify a shell command BEFORE spawning. Returns an error
/// message when the command is a known foreground server / log
/// tail / file watcher — things that run forever and would freeze
/// the agent loop until the 5-minute timeout. The user is right
/// that refusing up-front is much better than spawning, waiting
/// for a "ready" banner, then SIGTERMing: it saves seconds, doesn't
/// leave half-started servers, and gives the model a clear signal
/// about what to do instead.
///
/// We use word-boundary matches and look at the FIRST meaningful
/// token after any leading `cd …&&` / `env VAR=… ` / `nohup ` /
/// `time ` prefixes, so `cd app && npm run dev` is classified the
/// same as a bare `npm run dev`.
fn blocking_command_refusal(cmd: &str) -> Option<String> {
    // Append a trailing space so trailing-bare-word patterns like
    // `"vite "` still match when the user types just `vite`. The
    // trim inside strip_leading_command_noise drops trailing
    // whitespace, so we have to put one back for boundary checks.
    let stripped = format!("{} ", strip_leading_command_noise(cmd).to_lowercase());

    // PHILOSOPHY: this list is intentionally small. Almost every
    // dev-server / framework will be caught by `detect_server_ready`
    // once it starts (Go, Rust, Java, Python, Ruby, Node — any
    // language that prints "Listening on …" or "Running on http://"
    // is auto-terminated after ~1.5s). We only refuse the cases
    // where:
    //   1. There is NO ready signal at all (interactive REPLs:
    //      bare `python`, `node`, `irb`, `psql`).
    //   2. The output stream itself never ends (log followers).
    //   3. The model can opt in by passing `wait_for=` to bypass
    //      this refusal (see the run_shell attr docs).
    //
    // If a command CAN be handled by detect_server_ready, we let
    // it through — refusal is for the unrecoverable cases only.

    // Honor `wait_for=` opt-in: if the model declared what it's
    // waiting for, we let any command through. The poller will
    // tear it down when the signal hits.
    // (handled at the call site by checking attrs before invoking
    // this fn; this comment is for context if anyone reads here.)

    // Order matters: specific watch-mode test runners must be
    // checked BEFORE the generic `watch ` pattern, otherwise
    // `tsc --watch` would match the wrong family ("watch(1)
    // repeating command") and the suggestion text would be wrong.
    let patterns: &[(&str, &str, &str)] = &[
        // Test runners in DEFAULT-watch mode where the model
        // clearly meant the one-shot equivalent.
        (
            "vitest --watch",
            "Vitest watch mode",
            "use `vitest --run` for a one-shot test run",
        ),
        (
            "jest --watch",
            "Jest watch mode",
            "use `jest --run` or bare `jest` for a one-shot test run",
        ),
        (
            "tsc --watch",
            "TypeScript watch mode",
            "use `tsc --noEmit` for one-shot type checking",
        ),
        (
            "tsc -w ",
            "TypeScript watch mode",
            "use `tsc --noEmit` for one-shot type checking",
        ),
        // Log followers — output never ends and there's no readiness signal.
        (
            "tail -f ",
            "log follower",
            "use `tail -n 100 <file>` for the last lines, or `cat <file>` if it's small",
        ),
        (
            "journalctl -f",
            "log follower",
            "use `journalctl -n 100` for the last 100 lines",
        ),
        (
            "logs -f",
            "log follower (kubectl/docker)",
            "drop `-f` and use `logs --tail=100` for a snapshot",
        ),
        (
            "less ",
            "interactive pager",
            "use `cat`, `head -n N`, or `tail -n N` to dump the content directly",
        ),
        ("less\n", "interactive pager", "use `cat` instead"),
        (
            "more ",
            "interactive pager",
            "use `cat` or `head -n N` instead",
        ),
        (
            "watch ",
            "watch(1) repeating command",
            "run the inner command once; the harness shows fresh output every turn",
        ),
    ];
    for (needle, family, suggestion) in patterns {
        if stripped.contains(needle) {
            return Some(format!(
                "run_shell refused: `{}` is a {} that produces no terminating signal. \
                 The agent loop has no way to know when it's \"done\". \
                 Instead, {}.",
                cmd.trim(),
                family,
                suggestion,
            ));
        }
    }
    None
}

/// Strip prefixes that aren't part of the "real" command — `cd …
/// &&`, `env VAR=val`, `nohup`, `time`, `sudo` — so the classifier
/// looks at what actually gets executed.
fn strip_leading_command_noise(cmd: &str) -> String {
    let mut s = cmd.trim().to_string();
    loop {
        let before = s.clone();
        // `cd PATH && rest` → `rest`
        if let Some(rest) = s.strip_prefix("cd ").and_then(|tail| {
            tail.split_once("&&")
                .map(|(_, rest)| rest.trim().to_string())
        }) {
            s = rest;
            continue;
        }
        // `env VAR=val ... cmd` → `cmd`
        if let Some(rest) = s.strip_prefix("env ") {
            // Skip tokens that look like VAR=value.
            let tokens: Vec<&str> = rest.split_whitespace().collect();
            let mut i = 0;
            while i < tokens.len() && tokens[i].contains('=') {
                i += 1;
            }
            s = tokens[i..].join(" ");
            continue;
        }
        let mut stripped_prefix = false;
        for prefix in ["nohup ", "time ", "sudo ", "/usr/bin/env "] {
            if let Some(rest) = s.strip_prefix(prefix) {
                s = rest.trim().to_string();
                stripped_prefix = true;
                break;
            }
        }
        if stripped_prefix {
            continue;
        }
        if s == before {
            break;
        }
    }
    s
}

/// Detect that a streamed shell output has reached the "server is
/// ready" state — Vite is serving, Next.js compiled, Webpack dev
/// server is listening, etc. These commands never exit on their
/// own; if we don't intervene, `run_shell` sits there until the
/// 5-minute timeout while the agent loop looks frozen to the user
/// (this is exactly the `npm run dev` failure mode reported in the
/// "create a react todo app" run).
///
/// When detection fires, the caller SIGTERMs the child and reports
/// success with a synthesized message — the dev server is running
/// in the background and the agent can move on to the next step.
///
/// Patterns are conservative — we want a high-confidence positive
/// signal before tearing down what the model asked us to run.
/// Declarative completion signal for `run_shell wait_for="…">`. The
/// model expresses *what it's waiting for* (a port to bind, output
/// to match, a file to appear) and the harness tears the process
/// down as soon as the condition holds. This is language-agnostic:
/// `wait_for="port:8080"` works for Go's `net/http`, Rust's `axum`,
/// Python's `flask run`, Ruby's `rails s`, .NET's Kestrel —
/// anything that ends up bound to that TCP port.
#[derive(Debug, Clone)]
pub(crate) enum WaitForSpec {
    /// Wait until a TCP port is accepting connections on localhost.
    /// `wait_for="port:3000"` — covers every web framework.
    Port(u16),
    /// Wait until stdout/stderr contains the given (case-insensitive
    /// substring) signal. `wait_for="output:Listening on"`.
    Output(String),
    /// Wait until a path exists on disk relative to the workspace.
    /// `wait_for="file:dist/bundle.js"` — handy for codegen tools
    /// that print nothing until they finish.
    File(String),
    /// Parse error surfaced back to the model.
    Invalid(String),
}

fn parse_wait_for(raw: &str) -> Option<WaitForSpec> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(rest) = s.strip_prefix("port:") {
        return match rest.trim().parse::<u16>() {
            Ok(p) if p > 0 => Some(WaitForSpec::Port(p)),
            _ => Some(WaitForSpec::Invalid(format!(
                "port:{rest} — expected a TCP port (1–65535)"
            ))),
        };
    }
    if let Some(rest) = s.strip_prefix("output:") {
        let needle = rest.trim();
        if needle.is_empty() {
            return Some(WaitForSpec::Invalid(
                "output: needs a non-empty substring".into(),
            ));
        }
        return Some(WaitForSpec::Output(needle.to_string()));
    }
    if let Some(rest) = s.strip_prefix("file:") {
        let path = rest.trim();
        if path.is_empty() {
            return Some(WaitForSpec::Invalid("file: needs a non-empty path".into()));
        }
        return Some(WaitForSpec::File(path.to_string()));
    }
    Some(WaitForSpec::Invalid(format!(
        "unrecognized prefix in `{s}` — use port:, output:, or file:"
    )))
}

/// Returns true if a TCP listener is accepting connections on
/// `127.0.0.1:port`. Used by the `wait_for="port:…"` poller. We
/// try IPv4 first (covers the overwhelming majority of dev
/// servers), then IPv6 loopback for frameworks that bind `::1`
/// only.
fn tcp_port_is_open(port: u16) -> bool {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
    let timeout = Duration::from_millis(200);
    for ip in [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ] {
        let addr = SocketAddr::new(ip, port);
        if TcpStream::connect_timeout(&addr, timeout).is_ok() {
            return true;
        }
    }
    false
}

fn detect_server_ready(tail: &str) -> Option<&'static str> {
    let lower = tail.to_lowercase();
    // The detector is language-agnostic: it looks for output that
    // universally means "this process is now in steady state and
    // waiting for connections / file changes / user input."
    // Patterns are grouped from most-confident to least-confident.
    // We check substrings (not regex) for speed since this runs on
    // every byte read from the child's stdout/stderr.

    // ── HTTP/TCP servers across ALL languages ────────────────────
    // Almost every web framework — Go, Rust, Python, Ruby, Node,
    // Java, .NET, Elixir, PHP — prints SOMETHING that includes
    // one of these phrases when the listener is bound and ready.
    const UNIVERSAL_LISTEN: &[&str] = &[
        "listening on ",
        "listening at ",
        "listening: ",
        "now listening on",  // .NET / Kestrel
        "started server on", // Go (net/http) / common
        "started server at",
        "server running at", // express, restify, plain node
        "server listening",
        "server is listening",
        "server started on",
        "server started at",
        "server ready on",
        "running on http", // Flask, FastAPI, Express
        "running at http",
        "serving at http",
        "serving http on", // Python http.server
        "serving on http",
        "ready in ",              // Vite ("ready in 430 ms")
        "ready on http",          // Next.js dev
        "ready - started server", // Next.js older
        "local:",                 // Vite/Next/CRA dev banner
        "bound to port",
        "bound to address",
        "started on port",
        "started application in", // Spring Boot
        "tomcat started on port", // Spring Boot
        "tomcat started",
        "application startup complete", // FastAPI / Uvicorn
        "startup complete",
        "uvicorn running on",             // Uvicorn / FastAPI
        "starting development server at", // Django
        "starting development server",
        "rocket has launched",   // Rust Rocket
        "actix-server running",  // Rust actix-web
        "axum::serve listening", // Rust axum
        "running on tcp",
        "running phoenix", // Elixir Phoenix
        "phoenix.endpoint",
        "phoenix server running",
        "puma starting",      // Ruby Puma
        "use ctrl-c to stop", // Rails / Puma
        "use ctrl-c to shutdown",
        "press ctrl-c to stop",
        "press ctrl+c to stop",
        "press ctrl+c to quit",
        "php development server",   // PHP -S
        "php * development server", // alt
        "(press ctrl+c to quit)",
        "compiled successfully", // CRA / webpack dev
        "compiled successfully!",
        "compiled client and server successfully",
    ];
    for needle in UNIVERSAL_LISTEN {
        if lower.contains(needle) {
            return Some("server");
        }
    }

    // ── File-system watchers / test-watchers in idle state ───────
    // These print a steady-state indicator AFTER finishing an
    // initial pass. They never exit; if the model asked for them
    // by accident the harness should reclaim the slot.
    const WATCHERS: &[&str] = &[
        "watching for file changes",
        "watching for changes",
        "watching files for changes",
        "file watcher: ready",
        "watch usage",              // vitest
        "press a to run all tests", // jest --watch
        "press q to quit",          // various
        "press q to exit",
        "press h to show help",
        "no tests found related to files changed",
        "ready to receive file changes",
        "esbuild: watching files for changes",
        "[hmr] waiting for update",
    ];
    for needle in WATCHERS {
        if lower.contains(needle) {
            return Some("watcher");
        }
    }

    // ── Generic localhost URL printed near the end ───────────────
    // Catches frameworks that don't say "listening" but DO advertise
    // their URL in the banner (Astro, SvelteKit, Solid Start).
    // Require the URL be followed by typical end-of-banner content
    // to reduce false positives — `http://localhost:` alone shows up
    // in error messages and tutorials.
    if (lower.contains("http://localhost:")
        || lower.contains("http://127.0.0.1:")
        || lower.contains("http://0.0.0.0:"))
        && (lower.contains("ready")
            || lower.contains("running")
            || lower.contains("started")
            || lower.contains("listening")
            || lower.contains("serving"))
    {
        return Some("server");
    }

    None
}

/// Pending prompt response channels keyed by `prompt_id`.
static SHELL_PROMPTS: once_cell::sync::Lazy<
    Mutex<HashMap<String, std::sync::mpsc::Sender<String>>>,
> = once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

fn register_shell_prompt(prompt_id: &str, tx: std::sync::mpsc::Sender<String>) {
    SHELL_PROMPTS.lock().insert(prompt_id.to_string(), tx);
}

fn deliver_shell_prompt_response(prompt_id: &str, response: String) -> bool {
    if let Some(tx) = SHELL_PROMPTS.lock().remove(prompt_id) {
        let _ = tx.send(response);
        true
    } else {
        false
    }
}

/// Cancel any pending prompts owned by this request_id. Used by
/// `agent_cancel` so the shell reader thread doesn't sit on a
/// `recv()` forever after the user clicks stop.
fn cancel_shell_prompts_for(request_id: &str) {
    let mut map = SHELL_PROMPTS.lock();
    let drained: Vec<String> = map
        .keys()
        .filter(|k| k.starts_with(&format!("{}/", request_id)))
        .cloned()
        .collect();
    for k in drained {
        if let Some(tx) = map.remove(&k) {
            // Sending the empty string releases the thread; the
            // reader writes "\n" anyway, which is the standard
            // "use default" response for most prompts.
            let _ = tx.send(String::new());
        }
    }
}

/// Track running shell PIDs so `agent_cancel` can SIGTERM them.
type ShellCancelFlag = Arc<std::sync::atomic::AtomicBool>;
type ShellPidMap = HashMap<String, (u32, ShellCancelFlag)>;

static SHELL_PIDS: once_cell::sync::Lazy<Mutex<ShellPidMap>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

fn register_shell_pid(request_id: &str, pid: u32, flag: ShellCancelFlag) {
    SHELL_PIDS
        .lock()
        .insert(request_id.to_string(), (pid, flag));
}

fn unregister_shell_pid(request_id: &str) {
    SHELL_PIDS.lock().remove(request_id);
}

/// Called by `agent_cancel` so an in-flight `run_shell` actually
/// dies, instead of waiting out a 15-minute timeout.
fn cancel_shell_for(request_id: &str) {
    if let Some((pid, flag)) = SHELL_PIDS.lock().get(request_id).cloned() {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        #[cfg(unix)]
        unsafe {
            // Negative PID = kill the whole process group. The shell
            // was spawned as a process group leader via pre_exec
            // setsid, so this brings down npm/vite/etc. cleanly. See
            // detailed rationale in run_shell where pre_exec is set.
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        // On non-unix the cancel flag flips and the run_shell loop
        // catches it on the next 80ms poll.
        let _ = pid;
    }
}

async fn run_subtask(
    app: &AppHandle,
    call: &ToolCall,
    workspace: &str,
    depth: u32,
    lint_command: Option<&str>,
) -> Result<ToolOutput, String> {
    if depth >= SUBTASK_MAX_DEPTH {
        return Ok(ToolOutput {
            status: "error".into(),
            message: format!(
                "Refusing to spawn a sub-task at depth {depth}; max depth is {SUBTASK_MAX_DEPTH}.",
            ),
            extra: None,
        });
    }
    let title = call
        .attrs
        .get("title")
        .cloned()
        .unwrap_or_else(|| "subtask".to_string());
    let goal = call.body.trim().to_string();
    if goal.is_empty() {
        return Err("task: empty body".into());
    }
    // Returning a hint; the frontend kicks off a fresh agent_run if it wants
    // to actually execute the sub-task. Keeping this synchronous would block
    // the main loop on another full chat — defer to UI orchestration.
    let _ = app.emit(
        "agent:subtask",
        json!({
            "parent_depth": depth,
            "title": title,
            "goal": goal,
            "workspace": workspace,
            "lint_command": lint_command,
        }),
    );
    Ok(ToolOutput {
        status: "ok".into(),
        message: format!("Queued sub-task: {title}"),
        extra: Some(json!({"title": title, "goal": goal})),
    })
}

// -------------------- Verifier ---------------------------------------------

fn has_stale_marker_word(s: &str) -> bool {
    s.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|word| matches!(word.to_ascii_uppercase().as_str(), "BUG" | "TODO" | "FIXME"))
}

fn normalize_marker_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn source_hygiene_warning(path: &str, text: &str, call: &ToolCall) -> Option<String> {
    if !matches!(
        call.tool.as_str(),
        "apply_diff" | "edit_file" | "write_file"
    ) {
        return None;
    }

    let copied_marker_lines: Vec<String> = call
        .body
        .lines()
        .map(normalize_marker_line)
        .filter(|line| !line.is_empty() && has_stale_marker_word(line))
        .collect();
    if copied_marker_lines.is_empty() {
        return None;
    }

    let mut retained = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        let normalized = normalize_marker_line(line);
        if has_stale_marker_word(&normalized)
            && copied_marker_lines
                .iter()
                .any(|source| source == &normalized)
        {
            retained.push((idx + 1, line.trim().to_string()));
        }
        if retained.len() >= 5 {
            break;
        }
    }

    if retained.is_empty() {
        return None;
    }

    let preview = retained
        .iter()
        .map(|(line, text)| format!("{path}:{line}: {text}"))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!(
        "source hygiene issue: `{path}` still contains stale BUG/TODO/FIXME marker(s) copied from the edited code:\n{preview}\nRemove or replace these stale markers before finalizing; tests passing is not enough while the edited source still describes the old bug."
    ))
}

async fn run_verifier(
    app: &AppHandle,
    request_id: &str,
    step: u32,
    workspace: &str,
    call: &ToolCall,
    lint_command: Option<&str>,
) -> Option<String> {
    let evt = format!("agent:event:{}", request_id);
    let mut report = String::new();

    // For path-targeting mutations, re-read the file and report its size +
    // first/last lines so the model can verify what it wrote.
    if let Some(path) = call.attrs.get("path") {
        let abs = resolve(workspace, path);
        if let Ok(text) = std::fs::read_to_string(&abs) {
            let lines: Vec<&str> = text.lines().collect();
            let total = lines.len();
            let head = lines.iter().take(3).copied().collect::<Vec<_>>().join("\n");
            let tail = lines
                .iter()
                .rev()
                .take(3)
                .copied()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            report.push_str(&format!(
                "post-state {path}: {total} lines, {} bytes\nhead:\n{head}\n…\ntail:\n{tail}\n",
                text.len()
            ));
            if let Some(warning) = source_hygiene_warning(path, &text, call) {
                report.push_str(&format!("\n{warning}\n"));
            }
        }
    }

    // Optional user-configured lint. We deliberately give this a tight budget;
    // the goal is fast feedback, not a full CI run.
    if let Some(cmd) = lint_command {
        let cmd = cmd.trim();
        if !cmd.is_empty() {
            let (sh, flag) = if cfg!(windows) {
                ("cmd", "/C")
            } else {
                ("/bin/sh", "-c")
            };
            let ws = workspace.to_string();
            let cmd_s = cmd.to_string();
            let result: Result<(i32, String, String), String> =
                tokio::task::spawn_blocking(move || {
                    let out = std::process::Command::new(sh)
                        .arg(flag)
                        .arg(&cmd_s)
                        .current_dir(if ws.is_empty() { ".".into() } else { ws })
                        .output()
                        .map_err(|e| e.to_string())?;
                    Ok((
                        out.status.code().unwrap_or(-1),
                        String::from_utf8_lossy(&out.stdout).to_string(),
                        String::from_utf8_lossy(&out.stderr).to_string(),
                    ))
                })
                .await
                .unwrap_or_else(|e| Err(e.to_string()));
            match result {
                Ok((code, so, se)) => {
                    report.push_str(&format!(
                        "\nlint `{cmd}` exit={code}\n{}\n{}\n",
                        truncate(&so, 1500),
                        truncate(&se, 1500),
                    ));
                }
                Err(e) => report.push_str(&format!("\nlint failed to run: {e}\n")),
            }
        }
    }

    if report.is_empty() {
        None
    } else {
        let _ = app.emit(
            &evt,
            json!({"kind": "verifier", "step": step, "tool": call.tool, "text": report}),
        );
        Some(report)
    }
}

// -------------------- Parsing helpers --------------------------------------

fn render_user_brief(
    workspace: &str,
    mode: ExecutionMode,
    context: &Option<String>,
    goal: &str,
) -> String {
    let mut out = String::new();
    out.push_str(&format!("Workspace: {workspace}\n"));
    out.push_str(&format!("Mode: {:?}\n", mode));
    // Workspace brief — same compact "what is this project" snapshot
    // chat injects into its system prompt. Lives in the FIRST user
    // message rather than the system prompt so it persists in the
    // transcript and the model can refer back to it across turns
    // without us re-shipping it on every tool call. Best-effort:
    // a missing/unreadable workspace is silently skipped rather than
    // failing the run.
    let brief = crate::commands::workspace::generate_brief(std::path::Path::new(workspace));
    let trimmed = brief.trim();
    if !trimmed.is_empty() {
        out.push_str("\nWorkspace brief (use to orient; reach for list_dir/read_file/glob/grep when you need more):\n");
        out.push_str(trimmed);
        out.push('\n');
    }
    if let Some(ctx) = context.as_deref() {
        let ctx = ctx.trim();
        if !ctx.is_empty() {
            out.push_str("\nContext:\n");
            out.push_str(ctx);
            out.push('\n');
        }
    }
    out.push_str("\nGoal:\n");
    out.push_str(goal.trim());
    out
}

/// Build the `<environment_details>` block that gets appended to the
/// latest user message before each model call. Cline-style: a fresh
/// snapshot of "what the user is looking at" on every turn keeps the
/// agent grounded without it having to ask. Cheap to compute and a
/// huge quality lift for unfamiliar codebases.
fn render_environment_details(
    workspace: &str,
    mode: ExecutionMode,
    open_tabs: &[String],
    active_file: Option<&str>,
    step: u32,
    max_steps: u32,
    elapsed: Duration,
) -> String {
    let mut out = String::new();
    out.push_str("<environment_details>\n");
    out.push_str(&format!("# Workspace\n{}\n\n", workspace));
    out.push_str(&format!("# Mode\n{:?}\n\n", mode));
    if mode == ExecutionMode::Plan {
        out.push_str(
            "# Plan mode allowed actions\nAllowed: read_file, list_dir, glob, grep, search_codebase, list_code_definition_names, discover, <plan>, <final>, <clarify>.\nForbidden: run_shell, run_check, task, write_file, apply_diff, edit_file, rename_symbol, delete_path, rename_path, mcp_call.\nMention verification commands in the plan; do not execute them.\n\n",
        );
    }
    out.push_str(&format!("# OS\n{}\n\n", std::env::consts::OS));
    out.push_str(&format!(
        // Surface the cap so the model can decide whether to call
        // `<budget_bump proposed=\"N\">…</budget_bump>` rather than
        // silently running out of steps mid-task.
        "# Session\nstep {} of {}; {}s elapsed\n\n",
        step,
        max_steps,
        elapsed.as_secs(),
    ));
    if let Some(active) = active_file {
        out.push_str(&format!("# Active editor file\n{}\n\n", active));
    }
    if !open_tabs.is_empty() {
        out.push_str(&format!("# Open tabs ({})\n", open_tabs.len()));
        // Cap at 20 so a packed editor doesn't blow up the context.
        for tab in open_tabs.iter().take(20) {
            out.push_str(&format!("{}\n", tab));
        }
        if open_tabs.len() > 20 {
            out.push_str(&format!("… ({} more)\n", open_tabs.len() - 20));
        }
        out.push('\n');
    }
    out.push_str("</environment_details>");
    out
}

/// Mutate the LAST user message in the transcript to carry a fresh
/// `<environment_details>` block. We strip any previous block first
/// (so we only ever have one, on the most-recent user turn) and then
/// append. This mirrors Cline's pattern.
fn attach_environment_details(transcript: &mut [Value], env: &str) {
    // Find last user message.
    for entry in transcript.iter_mut().rev() {
        let is_user = entry
            .get("role")
            .and_then(|r| r.as_str())
            .map(|s| s == "user")
            .unwrap_or(false);
        if !is_user {
            continue;
        }
        let original = entry
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        // Drop any pre-existing environment_details so we don't pile
        // up stale snapshots.
        let stripped = strip_environment_details(&original);
        let merged = if stripped.trim().is_empty() {
            env.to_string()
        } else {
            format!("{}\n\n{}", stripped.trim_end(), env)
        };
        entry["content"] = Value::String(merged);
        return;
    }
}

/// Soft context budget — roughly the number of characters we let the
/// transcript hold before we start compacting older entries. Sized
/// for the 32k context window the larger qwen / deepseek code
/// checkpoints ship with: at ~4 chars/token, 48k chars ≈ 12k tokens,
/// which leaves comfortable headroom for the system prompt (~3k
/// tokens), tool definitions / MCP catalog (~2k), tool results
/// (~4k), and the model's own reply (~2k). For smaller-context
/// models the prune still runs as soon as the transcript gets
/// uncomfortable.
const TRANSCRIPT_SOFT_BUDGET_CHARS: usize = 48_000;
fn transcript_chars(transcript: &[Value]) -> usize {
    transcript
        .iter()
        .filter_map(|m| m.get("content").and_then(|c| c.as_str()))
        .map(|s| s.len())
        .sum()
}

/// We always keep this many of the most-recent transcript messages
/// intact — the model's short-term reasoning chain lives here and
/// dropping it produces "the agent forgot what it just did" bugs.
const TRANSCRIPT_RECENT_TAIL: usize = 8;

/// File-aware smart pruner. Run on every step; semantics:
///
/// * Index 0 (system prompt) and 1 (initial brief / goal) are
///   ALWAYS preserved.
/// * The last `TRANSCRIPT_RECENT_TAIL` messages are ALWAYS preserved
///   verbatim — this is the model's working memory for the current
///   turn and stripping it is far costlier than dropping a stale
///   read result.
/// * In the middle, walk newest -> oldest:
///     - For every `read_file` / `apply_diff` / `edit_file` /
///       `write_file` `<tool_result>` we see, keep only the **first**
///       (most recent) occurrence per path. Older copies for the
///       same path are dropped: their content is stale anyway, and
///       the ledger captures that the write/edit happened.
///     - Drop all `grep` / `glob` / `search_codebase` /
///       `list_code_definition_names` results outright; the
///       searches themselves are recorded in the ledger and the
///       textual hit lists rarely matter two turns later.
///     - Always keep `<final>` / `<clarify>` blocks (they're
///       short and matter for resumption).
/// * After pruning, prepend the `<previous_work>` block built from
///   the ledger — so the model gets a structured, anti-redo-framed
///   memory of what's been done that survives any amount of
///   pruning.
///
/// We always render the ledger block when there's any entry,
/// regardless of whether structural pruning fired — local models
/// benefit from the explicit framing on EVERY turn (it stops the
/// "now also rename a function" iteration from being misread as
/// "you already did that, skip").
fn smart_prune_transcript(transcript: &mut Vec<Value>, ledger: &ActionLedger) {
    if transcript.len() < 3 {
        // System + brief only — nothing to prune, but we still want
        // to ensure the brief carries `<previous_work>` if the
        // ledger is non-empty (rare on a brand-new run; common
        // when resuming via `agent_continue`).
        ensure_previous_work_in_brief(transcript, ledger);
        return;
    }

    // Step 1: structural prune (file-aware) when the transcript is
    // getting big OR has multiple stale reads for the same path.
    let recent_start = transcript.len().saturating_sub(TRANSCRIPT_RECENT_TAIL);
    let prunable_end = recent_start.max(2);
    if prunable_end > 2 {
        // We iterate the prunable middle window NEWEST -> OLDEST so
        // the per-path "keep first" rule applies to the most recent
        // copy of each file. `to_drop` holds the indexes (relative
        // to the full transcript) we want to remove; we apply them
        // in reverse to preserve indexing while draining.
        let mut to_drop: Vec<usize> = vec![];
        let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
        for idx in (2..prunable_end).rev() {
            let Some(content) = transcript[idx].get("content").and_then(|c| c.as_str()) else {
                continue;
            };
            let kind = classify_transcript_entry(content);
            match kind {
                TranscriptEntryKind::FileResult { path, tool } => {
                    // `tool` is read_file | apply_diff | edit_file |
                    // write_file. Keep ONLY the newest per path.
                    if seen_paths.contains(&path) {
                        to_drop.push(idx);
                    } else {
                        seen_paths.insert(path);
                    }
                    let _ = tool; // currently unused — reserved for future
                                  // per-tool retention tuning (e.g. always keep
                                  // the latest write but drop reads more
                                  // aggressively).
                }
                TranscriptEntryKind::Search => {
                    // The search query is in the ledger; the result
                    // text rarely matters after the next turn.
                    to_drop.push(idx);
                }
                TranscriptEntryKind::Other => {}
            }
        }
        // Don't prune below the soft budget unless we're actually
        // over the budget — gratuitous pruning kills the model's
        // recent context on short runs.
        let over_budget = transcript_chars(transcript) >= TRANSCRIPT_SOFT_BUDGET_CHARS;
        let many_stale = to_drop.len() >= 3;
        if over_budget || many_stale {
            // Apply drops newest-first to keep indexes valid.
            to_drop.sort_unstable_by(|a, b| b.cmp(a));
            for idx in to_drop {
                if idx >= 2 && idx < transcript.len().saturating_sub(TRANSCRIPT_RECENT_TAIL) {
                    transcript.remove(idx);
                }
            }
        }
    }

    // Step 2: ensure the brief carries the latest <previous_work> block.
    ensure_previous_work_in_brief(transcript, ledger);
}

/// Replace (or insert) the `<previous_work>` block on the initial
/// user brief (index 1). The block is regenerated from the ledger
/// each turn so it always reflects the latest state. Idempotent:
/// a brief that already has a previous_work block is rewritten,
/// not double-wrapped.
fn ensure_previous_work_in_brief(transcript: &mut [Value], ledger: &ActionLedger) {
    let Some(block) = crate::services::history::render_previous_work(ledger) else {
        return;
    };
    if transcript.len() < 2 {
        return;
    }
    let Some(brief) = transcript.get_mut(1) else {
        return;
    };
    let is_user = brief
        .get("role")
        .and_then(|r| r.as_str())
        .map(|s| s == "user")
        .unwrap_or(false);
    if !is_user {
        return;
    }
    let original = brief
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let stripped = strip_previous_work(&original);
    let merged = if stripped.trim().is_empty() {
        block
    } else {
        // Put the previous_work block at the TOP of the brief so
        // the model sees the factual history before anything else.
        format!("{}\n\n{}", block, stripped.trim_start())
    };
    brief["content"] = Value::String(merged);
}

/// Remove any prior `<previous_work …>…</previous_work>` (plus its
/// paired `<previous_work_note>…</previous_work_note>`) from a
/// brief. Idempotent — used before re-injecting an updated ledger
/// block so we don't stack copies.
///
/// IMPORTANT: only the actual XML tag forms match. Bare prose
/// mentions of the string "previous_work" (e.g. inside a
/// `<fresh_reads>` framing paragraph) must NOT be treated as a
/// block start — that would devour everything after them.
fn strip_previous_work(s: &str) -> String {
    let mut out = String::new();
    let mut cursor = 0;
    while cursor < s.len() {
        // Find the next opening tag — must be `<previous_work>` or
        // `<previous_work ` (attributes follow). Bare matches like
        // "the <previous_work> block" elsewhere don't count.
        let rest = &s[cursor..];
        let start_idx = match find_real_tag_start(rest, "previous_work") {
            Some(i) => i,
            None => {
                out.push_str(rest);
                break;
            }
        };
        out.push_str(&rest[..start_idx]);
        cursor += start_idx;

        let after = &s[cursor..];
        // Walk past <previous_work…>…</previous_work>.
        let close = "</previous_work>";
        let Some(close_at) = after.find(close) else {
            // Malformed — drop to end and stop.
            break;
        };
        cursor += close_at + close.len();

        // If the note tag follows immediately (allowing whitespace),
        // strip it too.
        let tail = &s[cursor..];
        let trimmed_start = tail.trim_start();
        let consumed = tail.len() - trimmed_start.len();
        if trimmed_start.starts_with("<previous_work_note>") {
            cursor += consumed;
            let note_close = "</previous_work_note>";
            if let Some(end) = s[cursor..].find(note_close) {
                cursor += end + note_close.len();
            } else {
                break;
            }
        }
        // Eat trailing whitespace so we don't pile blank lines.
        while cursor < s.len() && (s.as_bytes()[cursor] == b'\n' || s.as_bytes()[cursor] == b' ') {
            cursor += 1;
        }
    }
    out
}

/// Find the byte offset of the next REAL opening tag with `name`,
/// i.e. `<name>` or `<name …>`. Returns None if no such tag exists.
/// Used so prose mentions of `<foo>` inside other content don't
/// false-positive as block boundaries.
fn find_real_tag_start(hay: &str, name: &str) -> Option<usize> {
    let mut from = 0;
    let needle = format!("<{name}");
    while from < hay.len() {
        let rel = hay[from..].find(&needle)?;
        let abs = from + rel;
        let after = abs + needle.len();
        let next = hay.as_bytes().get(after).copied();
        // Real opening tag is followed by `>` (e.g. `<previous_work>`),
        // whitespace (e.g. `<previous_work mode="agent">`), or
        // `/` (e.g. `<previous_work/>`).
        match next {
            Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'/') => {
                return Some(abs);
            }
            _ => {
                from = after;
                continue;
            }
        }
    }
    None
}

/// Coarse classification of a transcript message for pruning. We
/// look only at `<tool_result tool="…">` and `<final>` / `<clarify>`
/// — assistant turns (the actual tool calls) are kept intact
/// because they carry the reasoning thread.
enum TranscriptEntryKind {
    FileResult { path: String, tool: &'static str },
    Search,
    Other,
}

fn classify_transcript_entry(content: &str) -> TranscriptEntryKind {
    // Cheap early-out: only `<tool_result …>` entries are
    // prunable; assistant turns and follow-up nudges stay.
    let Some(tool_start) = content.find("<tool_result") else {
        return TranscriptEntryKind::Other;
    };
    let header_end = content[tool_start..]
        .find('>')
        .map(|i| tool_start + i)
        .unwrap_or(content.len());
    let header = &content[tool_start..header_end];
    let tool = if let Some(t) = header
        .split("tool=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
    {
        t
    } else {
        return TranscriptEntryKind::Other;
    };
    match tool {
        "read_file" | "write_file" | "apply_diff" | "edit_file" => {
            // Extract path from the body. tool_result doesn't carry
            // it as an attr, so we look for the same convention
            // the tools use in their messages: "Wrote PATH" /
            // "Applied N/M hunks to PATH" / line-numbered reads
            // prefix with their first line. For pruning purposes
            // it's enough to peek at the original tool_call args
            // — we use a lightweight regex over the assistant
            // turn right before. As a simpler heuristic that
            // works for all known shapes, scan for `path="..."`
            // anywhere in the content.
            if let Some(path) = content
                .split("path=\"")
                .nth(1)
                .and_then(|rest| rest.split('"').next())
            {
                let tool_static: &'static str = match tool {
                    "read_file" => "read_file",
                    "write_file" => "write_file",
                    "apply_diff" => "apply_diff",
                    "edit_file" => "edit_file",
                    _ => "read_file",
                };
                TranscriptEntryKind::FileResult {
                    path: path.to_string(),
                    tool: tool_static,
                }
            } else {
                TranscriptEntryKind::Other
            }
        }
        "grep" | "glob" | "search_codebase" | "list_code_definition_names" | "discover" => {
            TranscriptEntryKind::Search
        }
        _ => TranscriptEntryKind::Other,
    }
}

/// Soft cross-turn dedup hint. Returns Some(message) when a
/// read-only call duplicates work the ledger already captured in
/// an earlier turn. The returned text is meant to be appended to
/// the tool_result as `<dedup_hint>` — it does NOT block the call
/// and never fires for mutating tools.
///
/// The point is to remind the model: "you've seen this; the
/// content is in <previous_work> / <fresh_reads>; iterate from
/// there." Hard-blocking dedup would break legitimate iteration
/// (e.g., "now re-read X, the user wants the latest").
fn cross_turn_dedup_hint(call: &ToolCall, ledger: &ActionLedger) -> Option<String> {
    if ledger.is_empty() {
        return None;
    }
    match call.tool.as_str() {
        "read_file" => {
            let path = call.attrs.get("path")?.trim().trim_start_matches("./");
            if path.is_empty() {
                return None;
            }
            if ledger
                .read_paths()
                .iter()
                .any(|p| p.trim_start_matches("./") == path)
                || ledger
                    .written_paths()
                    .iter()
                    .any(|p| p.trim_start_matches("./") == path)
            {
                Some(format!(
                    "You already read or wrote `{}` earlier this session. \
                     Current contents (when relevant) are inlined under <previous_work> \
                     or <fresh_reads>. Only re-read if you suspect the file changed \
                     since the last <previous_work> snapshot.",
                    path
                ))
            } else {
                None
            }
        }
        "grep" | "search_codebase" => {
            // Match on the raw query — small models often type the
            // identical query when they "forget" they ran it.
            let q_attr = call
                .attrs
                .get("query")
                .or_else(|| call.attrs.get("pattern"));
            let q_body = if call.body.trim().is_empty() {
                None
            } else {
                Some(call.body.trim().to_string())
            };
            let query = q_attr.map(|s| s.trim().to_string()).or(q_body)?;
            if query.is_empty() {
                return None;
            }
            if ledger
                .search_queries()
                .iter()
                .any(|q| q.trim().eq_ignore_ascii_case(&query))
            {
                Some(format!(
                    "You already ran a search for `{}` earlier this session. \
                     Results are summarised in <previous_work>. Re-run only if \
                     the codebase may have changed.",
                    query
                ))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// If the LATEST user message mentions a path that's already in
/// the ledger (i.e. the agent wrote/edited/read it earlier this
/// session), attach the file's CURRENT content as a `<file>` block
/// so the model can iterate from the actual bytes instead of
/// reconstructing them from memory.
///
/// Without this, local models routinely "remember" a stale version
/// of a file they wrote two turns ago and propose patches against
/// that fake state, producing the failure mode the user reported:
/// "the agent re-ran a previous action."
///
/// Scope is deliberately conservative:
///   * Only paths that already appear in the ledger qualify. New
///     mentions go through the normal `<read_file>` tool.
///   * Cap at 3 fresh-read attachments per turn — beyond that the
///     model spends its context budget on file dumps instead of
///     reasoning, and the @-mention pipeline (chat-side) is the
///     right surface for bigger batches anyway.
///   * Cap each file at 6 KB so a giant generated file can't
///     blow the brief budget.
fn inject_fresh_reads(transcript: &mut [Value], ledger: &ActionLedger, workspace: &str) {
    if ledger.is_empty() {
        return;
    }
    // The LATEST user message is what we're about to send. For
    // the very first turn that's the goal/brief; for a continued
    // turn it's the new user_message; for a mid-loop tool result
    // it's the tool_result entry — in which case we DON'T inject
    // (there's no user prose to mine for path mentions).
    let last_idx = match transcript.iter().rposition(|m| {
        m.get("role")
            .and_then(|r| r.as_str())
            .map(|s| s == "user")
            .unwrap_or(false)
    }) {
        Some(i) => i,
        None => return,
    };
    let original = match transcript[last_idx].get("content").and_then(|c| c.as_str()) {
        Some(s) => s.to_string(),
        None => return,
    };
    // Skip tool_result entries — they're synthesized by the loop
    // and never reference paths the user means.
    if original.contains("<tool_result") {
        return;
    }
    let written_or_read: std::collections::HashSet<String> = ledger
        .written_paths()
        .union(&ledger.read_paths())
        .cloned()
        .collect();
    if written_or_read.is_empty() {
        return;
    }
    let mentions = extract_path_mentions(&original);
    let mut attached: Vec<(String, String)> = vec![]; // (rel_path, body)
    for path in mentions {
        if attached.len() >= 3 {
            break;
        }
        // Match either an exact ledger path or its basename — local
        // models often type `foo.ts` even when the ledger remembers
        // `src/foo.ts`.
        let normalized = path.trim_start_matches("./").to_string();
        let basename = std::path::Path::new(&normalized)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&normalized)
            .to_string();
        let resolved = written_or_read.iter().find(|p| {
            p.as_str() == normalized
                || p.as_str() == path
                || std::path::Path::new(p)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|b| b == basename)
                    .unwrap_or(false)
        });
        let Some(rel) = resolved else { continue };
        if attached.iter().any(|(p, _)| p == rel) {
            continue;
        }
        let abs = resolve(workspace, rel);
        match std::fs::read_to_string(&abs) {
            Ok(s) => {
                const FRESH_READ_CAP: usize = 6_000;
                let body = if s.len() > FRESH_READ_CAP {
                    let truncated: String = s.chars().take(FRESH_READ_CAP).collect();
                    format!("{truncated}\n…(truncated, fresh-read)")
                } else {
                    s
                };
                attached.push((rel.clone(), body));
            }
            Err(_) => continue,
        }
    }
    if attached.is_empty() {
        return;
    }
    let mut block = String::new();
    block.push_str("<fresh_reads>\n");
    block.push_str(
        "These files appear in the previous_work ledger AND are mentioned in the request below. \
         Current contents on disk (use these — do NOT re-call read_file for them):\n\n",
    );
    for (path, body) in &attached {
        block.push_str(&format!("<file path=\"{path}\">\n{body}\n</file>\n"));
    }
    block.push_str("</fresh_reads>");
    let merged = format!("{block}\n\n{}", original);
    transcript[last_idx]["content"] = Value::String(merged);
}

/// Pull plausible workspace-relative file paths out of a chunk of
/// user prose. We look for:
///   * Backtick-fenced paths: `src/foo.ts`
///   * Bare paths with a known-ish extension: src/foo.ts, foo.py, etc.
///   * `@` mentions: @src/foo.ts (matches the chat @-mention syntax)
///
/// Returns paths in the order they appear. Duplicates are dropped.
fn extract_path_mentions(s: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 1) Backtick-fenced spans
    let mut cursor = 0;
    let bytes = s.as_bytes();
    while cursor < bytes.len() {
        let Some(open) = s[cursor..].find('`') else {
            break;
        };
        let after = cursor + open + 1;
        let Some(close) = s[after..].find('`') else {
            break;
        };
        let span = &s[after..after + close];
        if looks_like_path(span) {
            let normalized = span.trim_start_matches('@').to_string();
            if seen.insert(normalized.clone()) {
                out.push(normalized);
            }
        }
        cursor = after + close + 1;
    }
    // 2) Bare and @-mentions
    for chunk in s.split(|c: char| {
        c.is_whitespace() || c == ',' || c == ';' || c == '(' || c == ')' || c == '[' || c == ']'
    }) {
        let trimmed = chunk
            .trim_matches(|c: char| c == '.' || c == ',' || c == '"' || c == '\'')
            .trim_start_matches('@')
            .to_string();
        if !looks_like_path(&trimmed) {
            continue;
        }
        if seen.insert(trimmed.clone()) {
            out.push(trimmed);
        }
    }
    out
}

fn looks_like_path(s: &str) -> bool {
    if s.is_empty() || s.len() > 200 {
        return false;
    }
    // Must contain a `/` OR a file extension that's plausibly a
    // source file. We deliberately favour false negatives — better
    // to skip a fresh-read attachment than to dump a random user
    // word like "1.0.2" into the brief.
    let has_slash = s.contains('/');
    let has_known_ext = [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".rs",
        ".py",
        ".go",
        ".java",
        ".kt",
        ".rb",
        ".php",
        ".cs",
        ".cpp",
        ".cc",
        ".c",
        ".h",
        ".hpp",
        ".swift",
        ".m",
        ".mm",
        ".sh",
        ".bash",
        ".zsh",
        ".lua",
        ".toml",
        ".yaml",
        ".yml",
        ".json",
        ".md",
        ".markdown",
        ".html",
        ".css",
        ".scss",
        ".sql",
        ".proto",
        ".vue",
        ".svelte",
    ]
    .iter()
    .any(|ext| s.ends_with(ext));
    if !has_slash && !has_known_ext {
        return false;
    }
    // Reject things that look like URLs.
    if s.starts_with("http://") || s.starts_with("https://") {
        return false;
    }
    // Reject things with whitespace.
    if s.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    true
}

fn strip_environment_details(s: &str) -> String {
    let mut out = String::new();
    let mut cursor = 0;
    while cursor < s.len() {
        match s[cursor..].find("<environment_details>") {
            Some(start) => {
                out.push_str(&s[cursor..cursor + start]);
                cursor += start;
                match s[cursor..].find("</environment_details>") {
                    Some(end) => {
                        cursor += end + "</environment_details>".len();
                    }
                    None => break,
                }
            }
            None => {
                out.push_str(&s[cursor..]);
                break;
            }
        }
    }
    out
}

/// Detect whether the tail of `window` repeats a pattern of length
/// 1, 2, or 3 — i.e. the agent is cycling through the same calls
/// without making progress. Returns `true` for runs like
/// `[A,A,A]`, `[A,B,A,B]`, or `[A,B,C,A,B,C]` at the end.
fn detect_cycle(window: &[u64]) -> bool {
    for k in 1..=3 {
        if window.len() < k * 2 {
            continue;
        }
        let tail = &window[window.len() - k * 2..];
        if (0..k).all(|i| tail[i] == tail[i + k]) {
            return true;
        }
    }
    false
}

/// Remove `<tool_result>` and `<verifier>` blocks the model is
/// forbidden to emit. Weaker checkpoints sometimes hallucinate an
/// entire roundtrip — tool call, fake tool_result with invented file
/// contents, then a final based on the fake. Stripping those blocks
/// before parsing means the real tool call always wins.
fn sanitize_model_output(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut cursor = 0;
    let bytes = s.as_bytes();
    while cursor < bytes.len() {
        let slice = &s[cursor..];
        let tool_open = slice.find("<tool_result");
        let verifier_open = slice.find("<verifier");
        let next = match (tool_open, verifier_open) {
            (Some(a), Some(b)) => Some((a.min(b), if a <= b { "tool_result" } else { "verifier" })),
            (Some(a), None) => Some((a, "tool_result")),
            (None, Some(b)) => Some((b, "verifier")),
            (None, None) => None,
        };
        let Some((start, tag)) = next else {
            out.push_str(slice);
            break;
        };
        out.push_str(&slice[..start]);
        let close = format!("</{tag}>");
        match slice[start..].find(&close) {
            Some(end) => {
                cursor += start + end + close.len();
            }
            None => {
                // Unclosed — drop everything from here on; it's
                // hallucination through to the end of the buffer.
                cursor += slice.len();
            }
        }
    }
    out
}

fn extract_block(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let start_tag = s.find(&open)?;
    let after_open = s[start_tag..].find('>').map(|i| start_tag + i + 1)?;
    let close = format!("</{tag}>");
    let end = s[after_open..].find(&close).map(|i| after_open + i)?;
    Some(s[after_open..end].trim().to_string())
}

fn plan_looks_like_discovery_checklist(plan: &str) -> bool {
    let lines: Vec<String> = plan
        .lines()
        .map(|line| line.trim().to_ascii_lowercase())
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return false;
    }
    let discovery_terms = [
        "examine",
        "look at",
        "read",
        "analyze",
        "inspect",
        "identify",
        "determine",
        "find",
        "figure out",
        "understand",
        "gather",
        "plan the verification",
        "plan verification",
    ];
    let implementation_terms = [
        "edit",
        "update",
        "change",
        "replace",
        "add",
        "remove",
        "reuse",
        "call",
        "pass",
        "wire",
        "fix",
        "verify with",
        "run `",
        "test with",
    ];
    let discovery_lines = lines
        .iter()
        .filter(|line| discovery_terms.iter().any(|term| line.contains(term)))
        .count();
    let first_line_is_discovery = lines
        .first()
        .map(|line| discovery_terms.iter().any(|term| line.contains(term)))
        .unwrap_or(false);
    let implementation_lines = lines
        .iter()
        .filter(|line| implementation_terms.iter().any(|term| line.contains(term)))
        .count();
    let lower = plan.to_ascii_lowercase();
    let verification_terms = [
        "npm ",
        "pnpm ",
        "yarn ",
        "bun ",
        "cargo ",
        "pytest",
        "mocha",
        "vitest",
        "jest",
        "go test",
        "mvn ",
        "gradle",
        "verify with",
    ];
    let has_concrete_verification = verification_terms.iter().any(|term| lower.contains(term));
    first_line_is_discovery
        || (discovery_lines >= 2
            && (implementation_lines <= discovery_lines || !has_concrete_verification))
}

fn plan_mentions_ui_state_without_render_site(plan: &str) -> bool {
    let lower = plan.to_ascii_lowercase();
    let mentions_ui_state = lower.contains("ui")
        || lower.contains("overlay")
        || lower.contains("showdropoverlay")
        || lower.contains("visible")
        || lower.contains("render");
    let names_render_site = lower.contains(".vue")
        || lower.contains(".tsx")
        || lower.contains(".jsx")
        || lower.contains(".css")
        || lower.contains("drop-overlay");
    mentions_ui_state && !names_render_site
}

fn plan_edits_existing_test(plan: &str) -> bool {
    let lower = plan.to_ascii_lowercase();
    lower.lines().any(|line| {
        (line.contains("update")
            || line.contains("edit")
            || line.contains("change")
            || line.contains("modify")
            || line.contains("add"))
            && line.contains("test/")
            && (line.contains(".js")
                || line.contains(".jsx")
                || line.contains(".ts")
                || line.contains(".tsx")
                || line.contains(".mjs")
                || line.contains(".cjs"))
    })
}

fn parse_tool_call(s: &str) -> Option<ToolCall> {
    // Tools in priority order; we pick the first that appears.
    // Skills come BEFORE their underlying primitives so a model that
    // emits `<edit_file path="x">…</edit_file>` is routed to the
    // skill (with rollback + verification) rather than dispatched as
    // a raw `<apply_diff>` if both somehow appear in the same turn.
    let mut best: Option<(usize, &str)> = None;
    for &t in TOOL_TAGS {
        let needle = format!("<{t}");
        if let Some(pos) = s.find(&needle) {
            if best.map(|(p, _)| pos < p).unwrap_or(true) {
                best = Some((pos, t));
            }
        }
    }
    let (pos, tag) = best?;
    // Attribute & body extraction.
    let rest = &s[pos..];
    let header_end = rest.find('>')?;
    let header = &rest[..header_end];
    let body_start = pos + header_end + 1;
    let attrs = parse_attrs(&header[1 + tag.len()..]);
    // Self-closing form: `<read_file path="x" />`. The system
    // prompt teaches this shape (see prompts/agent_system.txt) and
    // it's the natural choice for attribute-only tools like
    // `read_file`, `list_dir`, `delete_path`, `rename_path`. The
    // header in that case ends with `/` (with optional trailing
    // whitespace before it); there's no `</tag>` to find and the
    // body is empty. Without this branch, every self-closing call
    // returned `None` here and the harness treated the turn as
    // prose-only — the model's "redirected → no_tool" failure
    // mode.
    let self_closing = header.trim_end().ends_with('/');
    let body = if self_closing {
        String::new()
    } else {
        let close = format!("</{tag}>");
        let body_end = s[body_start..].find(&close).map(|i| body_start + i)?;
        s[body_start..body_end].to_string()
    };
    let body_trimmed = body.trim_matches('\n').to_string();
    let fp = fingerprint(tag, &attrs, &body_trimmed);
    Some(ToolCall {
        tool: tag.to_string(),
        attrs,
        body: body_trimmed,
        fingerprint: fp,
    })
}

fn parse_attrs(s: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let key_start = i;
        while i < bytes.len()
            && bytes[i] != b'='
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'/'
            && bytes[i] != b'>'
        {
            i += 1;
        }
        if key_start == i {
            break;
        }
        let key = &s[key_start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            out.insert(key.to_string(), String::new());
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let quote = if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
            let q = bytes[i];
            i += 1;
            Some(q)
        } else {
            None
        };
        let val_start = i;
        match quote {
            Some(q) => {
                while i < bytes.len() && bytes[i] != q {
                    i += 1;
                }
                let val = &s[val_start..i];
                if i < bytes.len() {
                    i += 1;
                }
                out.insert(key.to_string(), val.to_string());
            }
            None => {
                while i < bytes.len()
                    && !bytes[i].is_ascii_whitespace()
                    && bytes[i] != b'>'
                    && bytes[i] != b'/'
                {
                    i += 1;
                }
                let val = &s[val_start..i];
                out.insert(key.to_string(), val.to_string());
            }
        }
    }
    out
}

pub(crate) struct Hunk {
    pub(crate) search: String,
    pub(crate) replace: String,
}

pub(crate) fn parse_search_replace(s: &str) -> Result<Vec<Hunk>, String> {
    let mut out = vec![];
    let bytes = s.as_bytes();
    let s_marker = b"<<<<<<< SEARCH";
    let alt_marker = b"<<<<<<<SEARCH"; // tolerate no-space variant
    let sep_marker = b"=======";
    let r_marker = b">>>>>>> REPLACE";
    let alt_rmarker = b">>>>>>>REPLACE";
    let mut i = 0;
    while i < bytes.len() {
        let start = find_subslice(&bytes[i..], s_marker)
            .map(|p| p + i)
            .or_else(|| find_subslice(&bytes[i..], alt_marker).map(|p| p + i));
        let Some(s_at) = start else { break };
        // Skip to next newline after SEARCH marker (potential trailing tokens).
        let after_search = s[s_at..]
            .find('\n')
            .map(|p| s_at + p + 1)
            .ok_or_else(|| "no newline after SEARCH".to_string())?;
        let sep_at = find_subslice(&bytes[after_search..], sep_marker)
            .map(|p| p + after_search)
            .ok_or_else(|| "missing ======= separator".to_string())?;
        let after_sep = s[sep_at..]
            .find('\n')
            .map(|p| sep_at + p + 1)
            .ok_or_else(|| "no newline after =======".to_string())?;
        let r_at = find_subslice(&bytes[after_sep..], r_marker)
            .map(|p| p + after_sep)
            .or_else(|| find_subslice(&bytes[after_sep..], alt_rmarker).map(|p| p + after_sep))
            .ok_or_else(|| "missing >>>>>>> REPLACE marker".to_string())?;
        let search = s[after_search..sep_at].trim_end_matches('\n').to_string();
        let replace = s[after_sep..r_at].trim_end_matches('\n').to_string();
        out.push(Hunk { search, replace });
        // Advance past the REPLACE marker line.
        i = s[r_at..]
            .find('\n')
            .map(|p| r_at + p + 1)
            .unwrap_or(bytes.len());
    }
    Ok(out)
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn fingerprint(tool: &str, attrs: &HashMap<String, String>, body: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    tool.hash(&mut h);
    let mut keys: Vec<&String> = attrs.keys().collect();
    keys.sort();
    for k in keys {
        k.hash(&mut h);
        attrs[k].hash(&mut h);
    }
    body.hash(&mut h);
    h.finish()
}

pub(crate) fn resolve(workspace: &str, path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() || workspace.is_empty() {
        p.to_path_buf()
    } else {
        PathBuf::from(workspace).join(p)
    }
}

/// When a tool tries to operate on a file that doesn't exist, walk
/// the workspace looking for files with the same basename (case-
/// insensitive). This is what turns the otherwise-fatal
///   `apply_diff read src/index.html: No such file or directory`
/// into an actionable
///   `… try 'index.html' or 'public/index.html'.`
///
/// Caps both the search and the result list so the cost stays
/// bounded even in huge repos (gitignore is respected).
pub(crate) fn find_similar_paths(workspace: &str, missing: &str) -> Vec<String> {
    if workspace.is_empty() {
        return vec![];
    }
    let basename = Path::new(missing)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    if basename.is_empty() {
        return vec![];
    }
    let mut hits = vec![];
    let walker = ignore::WalkBuilder::new(workspace)
        .git_ignore(true)
        .ignore(true)
        .hidden(false)
        .max_depth(Some(8))
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_str().unwrap_or("").to_lowercase();
        if name == basename {
            let rel = entry
                .path()
                .strip_prefix(workspace)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .to_string();
            hits.push(rel);
            if hits.len() >= 8 {
                break;
            }
        }
    }
    hits
}

pub(crate) fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{truncated}\n… (truncated)")
    }
}

#[allow(dead_code)]
pub fn _ensure_state_arc_unused() {
    // referenced to silence the dead_code warning on Arc usage above.
    let _ = Arc::new(());
}

// ---------------------------------------------------------------------------
// Unit tests for the agent's prompt-building + MCP helpers. These do not
// require a running model, an MCP server, or any state, so they live
// inline rather than in tests/.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::mcp::McpTool;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn parse_budget_bump_extracts_proposed_and_reason() {
        let body = "<think>too small</think>\n<budget_bump proposed=\"50\">need to refactor 12 more files</budget_bump>";
        let (n, reason) = parse_budget_bump(body).unwrap();
        assert_eq!(n, 50);
        assert!(reason.contains("12 more files"));
    }

    #[test]
    fn parse_budget_bump_rejects_missing_proposed() {
        // The `proposed` attribute is required; without it we treat
        // the block as malformed and the loop falls through to the
        // normal tool-call parser instead of pausing.
        let body = "<budget_bump>no value</budget_bump>";
        assert!(parse_budget_bump(body).is_none());
    }

    #[test]
    fn parse_budget_bump_returns_none_when_absent() {
        let body = "<final>nothing to see here</final>";
        assert!(parse_budget_bump(body).is_none());
    }

    #[test]
    fn extract_first_json_object_unwraps_fenced_payload() {
        let s = "```json\n{\"steps\": 7, \"summary\": \"Touch a couple files\"}\n```\n";
        let out = extract_first_json_object(s).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["steps"], 7);
    }

    #[test]
    fn extract_first_json_object_handles_braces_inside_strings() {
        // The closing `}` inside the string value mustn't end the
        // object early — the parser tracks string state and ignores
        // braces between quotes.
        let s = r#"prose {"summary": "use a {} placeholder", "steps": 4} trailing"#;
        let out = extract_first_json_object(s).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["steps"], 4);
    }

    #[test]
    fn environment_details_includes_workspace_and_mode() {
        let env = render_environment_details(
            "/Users/x/project",
            ExecutionMode::AgentAuto,
            &["src/a.ts".to_string(), "src/b.ts".to_string()],
            Some("src/a.ts"),
            3,
            30,
            Duration::from_secs(42),
        );
        assert!(env.contains("<environment_details>"));
        assert!(env.contains("</environment_details>"));
        assert!(env.contains("/Users/x/project"));
        assert!(env.contains("Auto"));
        assert!(env.contains("src/a.ts"));
        assert!(env.contains("step 3 of 30"));
    }

    #[test]
    fn strip_environment_details_removes_blocks() {
        let s = "hello\n<environment_details>\nworkspace=X\n</environment_details>\nworld";
        let out = strip_environment_details(s);
        assert_eq!(out, "hello\n\nworld");
    }

    #[test]
    fn attach_environment_details_replaces_existing_block() {
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "first goal\n<environment_details>\nold\n</environment_details>"}),
        ];
        attach_environment_details(&mut t, "<environment_details>\nnew\n</environment_details>");
        let last = t.last().unwrap().get("content").unwrap().as_str().unwrap();
        assert!(last.contains("first goal"));
        assert!(last.contains("new"));
        assert!(!last.contains("old"));
    }

    #[test]
    fn attach_environment_details_targets_last_user_message() {
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "goal"}),
            json!({"role": "assistant", "content": "reply"}),
            json!({"role": "user", "content": "tool_result"}),
        ];
        attach_environment_details(&mut t, "<environment_details>\nx\n</environment_details>");
        let last = t.last().unwrap().get("content").unwrap().as_str().unwrap();
        assert!(last.contains("tool_result"));
        assert!(last.contains("<environment_details>"));
        // Earlier user message must be untouched.
        let first_user = t[1].get("content").unwrap().as_str().unwrap();
        assert_eq!(first_user, "goal");
    }

    #[test]
    fn pruner_skips_when_short_and_no_ledger() {
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "goal"}),
            json!({"role": "assistant", "content": "<read_file path=\"a\" />"}),
            json!({"role": "user", "content": "<tool_result tool=\"read_file\" status=\"ok\" path=\"a\">..</tool_result>"}),
        ];
        let before = t.len();
        smart_prune_transcript(&mut t, &ActionLedger::new());
        // Short transcript + empty ledger: nothing should change.
        assert_eq!(t.len(), before);
        // Brief must not have been wrapped with previous_work.
        assert_eq!(t[1].get("content").unwrap().as_str().unwrap(), "goal");
    }

    #[test]
    fn pruner_keeps_latest_diff_per_file_drops_older_reads() {
        // Two reads of `src/foo.ts`, then a final read. After
        // pruning we should keep only the newest copy for that
        // path. We push enough bytes so over-budget fires.
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "goal"}),
        ];
        let big = "Y".repeat(TRANSCRIPT_SOFT_BUDGET_CHARS / 4);
        // 6 stale reads + 1 final read of the same path → 6 should drop
        for i in 0..6 {
            t.push(json!({"role": "assistant", "content": format!("<read_file path=\"src/foo.ts\" /> {i}")}));
            t.push(json!({"role": "user", "content": format!("<tool_result tool=\"read_file\" status=\"ok\" path=\"src/foo.ts\">{big}\nv{i}</tool_result>")}));
        }
        // Now keep enough "recent tail" so the latest read survives.
        for i in 0..TRANSCRIPT_RECENT_TAIL {
            t.push(json!({"role": "assistant", "content": format!("think turn {i}")}));
        }
        let pre_len = t.len();
        smart_prune_transcript(&mut t, &ActionLedger::new());
        // At least the duplicate stale reads should have been removed.
        assert!(t.len() < pre_len, "pruner failed to drop stale reads");
        // Brief and system always stay.
        assert_eq!(t[0].get("role").unwrap(), "system");
        assert_eq!(t[1].get("role").unwrap(), "user");
    }

    #[test]
    fn pruner_preserves_system_brief_and_recent_tail() {
        // System + brief + a long history + recent tail of 8.
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "goal"}),
        ];
        let big = "X".repeat(TRANSCRIPT_SOFT_BUDGET_CHARS / 4);
        for i in 0..6 {
            t.push(json!({"role": "assistant", "content": format!("<grep>q{i}</grep>")}));
            t.push(json!({"role": "user", "content": format!("<tool_result tool=\"grep\" status=\"ok\">{big}</tool_result>")}));
        }
        for i in 0..TRANSCRIPT_RECENT_TAIL {
            t.push(json!({"role": "assistant", "content": format!("recent reasoning turn {i}")}));
        }
        smart_prune_transcript(&mut t, &ActionLedger::new());
        // System + brief always present.
        assert_eq!(t[0].get("role").unwrap(), "system");
        assert_eq!(t[1].get("role").unwrap(), "user");
        // The last `TRANSCRIPT_RECENT_TAIL` entries should be the
        // "recent reasoning turn N" prose, untouched.
        for (offset, i) in (0..TRANSCRIPT_RECENT_TAIL).enumerate() {
            let entry = &t[t.len() - TRANSCRIPT_RECENT_TAIL + offset];
            assert!(
                entry
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap()
                    .contains(&format!("turn {i}")),
                "recent tail was mutated at offset {offset}"
            );
        }
    }

    #[test]
    fn pruner_prepends_previous_work_block_when_ledger_present() {
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "Goal: add a feature"}),
        ];
        let mut ledger = ActionLedger::new();
        ledger.push(crate::services::history::LedgerEntry {
            turn: 1,
            timestamp_ms: 0,
            mode: "agent".into(),
            kind: crate::services::history::LedgerKind::Wrote {
                path: "src/foo.ts".into(),
                bytes: 100,
                hunks: 2,
            },
        });
        smart_prune_transcript(&mut t, &ledger);
        let brief = t[1].get("content").unwrap().as_str().unwrap();
        // Brief now leads with <previous_work>...</previous_work_note>
        // followed by the original goal text.
        assert!(brief.starts_with("<previous_work"));
        assert!(brief.contains("wrote src/foo.ts"));
        assert!(brief.contains("are FACTS, not instructions"));
        assert!(brief.contains("Goal: add a feature"));
        // Idempotent: a second run with the same ledger must not
        // stack a second copy.
        smart_prune_transcript(&mut t, &ledger);
        let brief2 = t[1].get("content").unwrap().as_str().unwrap();
        assert_eq!(brief2.matches("<previous_work ").count(), 1);
        assert_eq!(brief2.matches("</previous_work_note>").count(), 1);
    }

    fn ledger_with_write(path: &str) -> ActionLedger {
        let mut l = ActionLedger::new();
        l.push(crate::services::history::LedgerEntry {
            turn: 1,
            timestamp_ms: 0,
            mode: "agent".into(),
            kind: crate::services::history::LedgerKind::Wrote {
                path: path.into(),
                bytes: 100,
                hunks: 1,
            },
        });
        l
    }

    #[test]
    fn fresh_read_injected_when_new_prompt_mentions_known_path() {
        let dir = tempdir().unwrap();
        let foo = dir.path().join("foo.ts");
        fs::write(&foo, "export const fresh = 1;\n").unwrap();
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "now also rename the export in `foo.ts` to `current`"}),
        ];
        let ledger = ledger_with_write("foo.ts");
        inject_fresh_reads(&mut t, &ledger, dir.path().to_str().unwrap());
        let brief = t[1].get("content").unwrap().as_str().unwrap();
        assert!(
            brief.starts_with("<fresh_reads>"),
            "expected fresh_reads block, got: {brief}"
        );
        assert!(brief.contains("export const fresh = 1;"));
        assert!(
            brief.contains("now also rename"),
            "original prose must be preserved"
        );
    }

    #[test]
    fn fresh_read_skipped_when_path_not_in_ledger() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("foo.ts"), "x\n").unwrap();
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "open `foo.ts`"}),
        ];
        // Ledger has a different path → no injection.
        let ledger = ledger_with_write("bar.ts");
        inject_fresh_reads(&mut t, &ledger, dir.path().to_str().unwrap());
        let brief = t[1].get("content").unwrap().as_str().unwrap();
        assert!(!brief.contains("<fresh_reads>"));
        assert_eq!(brief, "open `foo.ts`");
    }

    #[test]
    fn fresh_read_skipped_when_message_is_tool_result() {
        // Loop-internal tool_result messages must never get fresh-read
        // injection — the path mentions there are tool params, not
        // user intent.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("foo.ts"), "x\n").unwrap();
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "goal"}),
            json!({"role": "assistant", "content": "<read_file path=\"foo.ts\" />"}),
            json!({"role": "user", "content": "<tool_result tool=\"read_file\" path=\"foo.ts\">stuff</tool_result>"}),
        ];
        let ledger = ledger_with_write("foo.ts");
        inject_fresh_reads(&mut t, &ledger, dir.path().to_str().unwrap());
        let last = t.last().unwrap().get("content").unwrap().as_str().unwrap();
        assert!(!last.contains("<fresh_reads>"));
        assert!(last.starts_with("<tool_result"));
    }

    #[test]
    fn fresh_read_caps_attachments_per_turn() {
        let dir = tempdir().unwrap();
        let mut ledger = ActionLedger::new();
        for name in ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] {
            fs::write(dir.path().join(name), format!("// {name}\n")).unwrap();
            ledger.push(crate::services::history::LedgerEntry {
                turn: 1,
                timestamp_ms: 0,
                mode: "agent".into(),
                kind: crate::services::history::LedgerKind::Wrote {
                    path: name.into(),
                    bytes: 10,
                    hunks: 1,
                },
            });
        }
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "look at `a.ts`, `b.ts`, `c.ts`, `d.ts`, and `e.ts`"}),
        ];
        inject_fresh_reads(&mut t, &ledger, dir.path().to_str().unwrap());
        let brief = t[1].get("content").unwrap().as_str().unwrap();
        // Cap is 3 — we expect exactly 3 <file> entries.
        assert_eq!(
            brief.matches("<file path=").count(),
            3,
            "fresh_reads cap not enforced"
        );
    }

    #[test]
    fn fresh_read_truncates_giant_files() {
        let dir = tempdir().unwrap();
        let big = "X".repeat(50_000);
        fs::write(dir.path().join("big.ts"), &big).unwrap();
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "update `big.ts`"}),
        ];
        let ledger = ledger_with_write("big.ts");
        inject_fresh_reads(&mut t, &ledger, dir.path().to_str().unwrap());
        let brief = t[1].get("content").unwrap().as_str().unwrap();
        assert!(brief.contains("(truncated, fresh-read)"));
        // Must be much smaller than the original.
        assert!(brief.len() < 12_000);
    }

    #[test]
    fn extract_path_mentions_finds_backticked_and_bare() {
        let prose = "edit `src/foo.ts` and also bar/baz.py, but skip http://example.com/x.ts";
        let mentions = extract_path_mentions(prose);
        assert!(mentions.iter().any(|p| p == "src/foo.ts"));
        assert!(mentions.iter().any(|p| p == "bar/baz.py"));
        assert!(!mentions.iter().any(|p| p.contains("example.com")));
    }

    #[test]
    fn extract_path_mentions_handles_at_mention_syntax() {
        let mentions = extract_path_mentions("please look at @src/components/Foo.tsx now");
        assert!(mentions.iter().any(|p| p == "src/components/Foo.tsx"));
    }

    #[test]
    fn extract_path_mentions_rejects_version_strings() {
        // "1.0.2" looks like a path but isn't. Critical false-positive
        // to avoid — would otherwise pollute the brief with version
        // numbers.
        let mentions = extract_path_mentions("we shipped 1.0.2 yesterday and 2.13.0 today");
        assert!(mentions.is_empty(), "got false positives: {mentions:?}");
    }

    fn mk_read_call(path: &str) -> ToolCall {
        let mut attrs = HashMap::new();
        attrs.insert("path".into(), path.into());
        ToolCall {
            tool: "read_file".into(),
            attrs,
            body: String::new(),
            fingerprint: 0,
        }
    }

    fn mk_grep_call(query: &str) -> ToolCall {
        let mut attrs = HashMap::new();
        attrs.insert("query".into(), query.into());
        ToolCall {
            tool: "grep".into(),
            attrs,
            body: String::new(),
            fingerprint: 0,
        }
    }

    fn mk_apply_diff_call(path: &str, body: &str) -> ToolCall {
        let mut attrs = HashMap::new();
        attrs.insert("path".into(), path.into());
        ToolCall {
            tool: "apply_diff".into(),
            attrs,
            body: body.into(),
            fingerprint: 0,
        }
    }

    #[test]
    fn source_hygiene_warns_when_patch_leaves_copied_bug_marker() {
        let body = r#"<<<<<<< SEARCH
      // BUG: overlay remains visible after drop events.
      showDropOverlay.value = true
=======
      // BUG: overlay remains visible after drop events.
      showDropOverlay.value = false
>>>>>>> REPLACE"#;
        let text = "if (type === 'drop') {\n      // BUG: overlay remains visible after drop events.\n      showDropOverlay.value = false\n}";
        let call = mk_apply_diff_call("src/composables/useDragDrop.js", body);
        let warning = source_hygiene_warning("src/composables/useDragDrop.js", text, &call)
            .expect("expected stale marker warning");

        assert!(warning.contains("source hygiene issue"));
        assert!(warning.contains("src/composables/useDragDrop.js:2"));
        assert!(warning.contains("overlay remains visible"));
    }

    #[test]
    fn source_hygiene_is_clear_after_marker_is_removed() {
        let body = r#"<<<<<<< SEARCH
      // BUG: overlay remains visible after drop events.
      showDropOverlay.value = true
=======
      showDropOverlay.value = false
>>>>>>> REPLACE"#;
        let text = "if (type === 'drop') {\n      showDropOverlay.value = false\n}";
        let call = mk_apply_diff_call("src/composables/useDragDrop.js", body);

        assert!(source_hygiene_warning("src/composables/useDragDrop.js", text, &call).is_none());
    }

    #[test]
    fn source_hygiene_ignores_unrelated_existing_markers() {
        let body = r#"<<<<<<< SEARCH
      showDropOverlay.value = true
=======
      showDropOverlay.value = false
>>>>>>> REPLACE"#;
        let text = "// TODO: unrelated future cleanup\nshowDropOverlay.value = false\n";
        let call = mk_apply_diff_call("src/composables/useDragDrop.js", body);

        assert!(source_hygiene_warning("src/composables/useDragDrop.js", text, &call).is_none());
    }

    #[test]
    fn cross_turn_dedup_emits_soft_hint_for_repeat_read() {
        let mut ledger = ActionLedger::new();
        ledger.push(crate::services::history::LedgerEntry {
            turn: 1,
            timestamp_ms: 0,
            mode: "agent".into(),
            kind: crate::services::history::LedgerKind::Read {
                paths: vec!["src/foo.ts".into()],
            },
        });
        let hint = cross_turn_dedup_hint(&mk_read_call("src/foo.ts"), &ledger);
        let msg = hint.expect("expected dedup hint for repeated read");
        assert!(msg.contains("src/foo.ts"));
        assert!(msg.to_lowercase().contains("only re-read"));
    }

    #[test]
    fn cross_turn_dedup_silent_for_new_path() {
        let mut ledger = ActionLedger::new();
        ledger.push(crate::services::history::LedgerEntry {
            turn: 1,
            timestamp_ms: 0,
            mode: "agent".into(),
            kind: crate::services::history::LedgerKind::Read {
                paths: vec!["src/foo.ts".into()],
            },
        });
        // Different path → no hint.
        assert!(cross_turn_dedup_hint(&mk_read_call("src/bar.ts"), &ledger).is_none());
    }

    #[test]
    fn cross_turn_dedup_emits_hint_for_repeat_grep() {
        let mut ledger = ActionLedger::new();
        ledger.push(crate::services::history::LedgerEntry {
            turn: 2,
            timestamp_ms: 0,
            mode: "agent".into(),
            kind: crate::services::history::LedgerKind::Searched {
                queries: vec!["TODO".into()],
            },
        });
        let hint = cross_turn_dedup_hint(&mk_grep_call("TODO"), &ledger);
        assert!(hint.is_some(), "expected dedup hint for repeated grep");
    }

    #[test]
    fn cross_turn_dedup_never_fires_for_mutating_tools() {
        let mut ledger = ActionLedger::new();
        ledger.push(crate::services::history::LedgerEntry {
            turn: 1,
            timestamp_ms: 0,
            mode: "agent".into(),
            kind: crate::services::history::LedgerKind::Wrote {
                path: "src/foo.ts".into(),
                bytes: 10,
                hunks: 1,
            },
        });
        // Even though src/foo.ts was already written, a NEW write
        // call must never get a dedup hint — iteration is legitimate.
        let mut attrs = HashMap::new();
        attrs.insert("path".into(), "src/foo.ts".into());
        let call = ToolCall {
            tool: "write_file".into(),
            attrs,
            body: "new bytes".into(),
            fingerprint: 0,
        };
        assert!(
            cross_turn_dedup_hint(&call, &ledger).is_none(),
            "iteration on prior write must not be blocked or hinted"
        );

        let mut attrs = HashMap::new();
        attrs.insert("path".into(), "src/foo.ts".into());
        let call = ToolCall {
            tool: "apply_diff".into(),
            attrs,
            body: "@@\n+x\n".into(),
            fingerprint: 0,
        };
        assert!(
            cross_turn_dedup_hint(&call, &ledger).is_none(),
            "edit on prior write must not be blocked or hinted"
        );
    }

    #[test]
    fn cross_turn_dedup_silent_when_ledger_empty() {
        let call = mk_read_call("src/foo.ts");
        assert!(cross_turn_dedup_hint(&call, &ActionLedger::new()).is_none());
    }

    // ── End-to-end intelligence scenarios ───────────────────────────
    //
    // These cover the bug the user reported: history must prevent
    // redundant re-execution WITHOUT blocking legitimate iteration.

    #[test]
    fn iteration_scenario_user_asks_to_modify_prior_write_not_treated_as_redo() {
        // Turn 1: agent wrote src/foo.ts. Turn 2: user asks "also
        // rename the function in foo.ts". The next turn's brief
        // should:
        //   * carry a <previous_work> block recording the prior
        //     write (so the model knows context),
        //   * inline the CURRENT content of foo.ts under
        //     <fresh_reads> so the model edits real bytes,
        //   * NOT issue a hard "you already wrote this, refuse"
        //     dedup against the FOLLOW-UP write call.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("foo.ts"), "export function old() {}\n").unwrap();

        let mut ledger = ActionLedger::new();
        ledger.push(crate::services::history::LedgerEntry {
            turn: 1,
            timestamp_ms: 1,
            mode: "agent".into(),
            kind: crate::services::history::LedgerKind::Wrote {
                path: "foo.ts".into(),
                bytes: 28,
                hunks: 1,
            },
        });

        // Simulate the transcript right before turn 2 dispatches.
        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "now also rename old() in `foo.ts` to current()"}),
        ];
        inject_fresh_reads(&mut t, &ledger, dir.path().to_str().unwrap());
        smart_prune_transcript(&mut t, &ledger);

        let brief = t[1].get("content").unwrap().as_str().unwrap();
        assert!(
            brief.contains("<previous_work"),
            "missing previous_work header"
        );
        assert!(brief.contains("wrote foo.ts"));
        assert!(
            brief.contains("<fresh_reads>"),
            "fresh_reads must inline current bytes"
        );
        assert!(
            brief.contains("export function old()"),
            "current file content missing"
        );
        assert!(brief.contains("rename old()"), "user request must survive");

        // Now simulate the model deciding to write the file again.
        // The dedup hinter must NOT flag a follow-up edit/write —
        // iteration is the whole point.
        let mut attrs = HashMap::new();
        attrs.insert("path".into(), "foo.ts".into());
        let edit = ToolCall {
            tool: "edit_file".into(),
            attrs,
            body: "patch".into(),
            fingerprint: 0,
        };
        assert!(
            cross_turn_dedup_hint(&edit, &ledger).is_none(),
            "edit on prior write must not be blocked"
        );
    }

    #[test]
    fn redo_scenario_user_asks_to_revert_lands_as_new_action() {
        // Turn 1: agent wrote foo.ts. Turn 2: user says "undo the
        // last change — restore foo.ts to use `old()`." The brief
        // must still expose the file's CURRENT content so the model
        // patches reality, not its memory of reality.
        let dir = tempdir().unwrap();
        // The on-disk content is the NEW (post-write) version.
        fs::write(dir.path().join("foo.ts"), "export function current() {}\n").unwrap();

        let mut ledger = ActionLedger::new();
        ledger.push(crate::services::history::LedgerEntry {
            turn: 1,
            timestamp_ms: 1,
            mode: "agent".into(),
            kind: crate::services::history::LedgerKind::Wrote {
                path: "foo.ts".into(),
                bytes: 32,
                hunks: 1,
            },
        });

        let mut t = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "undo the previous change to `foo.ts` and restore `old()`"}),
        ];
        inject_fresh_reads(&mut t, &ledger, dir.path().to_str().unwrap());
        smart_prune_transcript(&mut t, &ledger);

        let brief = t[1].get("content").unwrap().as_str().unwrap();
        assert!(brief.contains("wrote foo.ts"));
        assert!(
            brief.contains("export function current()"),
            "fresh_reads must show post-write state so the model knows what to undo"
        );
        assert!(brief.contains("undo the previous change"));

        // A NEW write to revert the change is not redo-from-memory;
        // it's a legitimate next action. Dedup hint must not fire.
        let mut attrs = HashMap::new();
        attrs.insert("path".into(), "foo.ts".into());
        let write = ToolCall {
            tool: "write_file".into(),
            attrs,
            body: "export function old() {}\n".into(),
            fingerprint: 0,
        };
        assert!(cross_turn_dedup_hint(&write, &ledger).is_none());
    }

    #[test]
    fn execution_mode_wire_format_back_compat() {
        // Existing FE callers send "plan"/"ask"/"auto". After the
        // rename to (Plan, AgentApprove, AgentAuto) these wire
        // strings MUST still deserialize so live FE builds keep
        // working through the rollout.
        let plan: ExecutionMode = serde_json::from_str("\"plan\"").unwrap();
        let ask: ExecutionMode = serde_json::from_str("\"ask\"").unwrap();
        let auto: ExecutionMode = serde_json::from_str("\"auto\"").unwrap();
        assert_eq!(plan, ExecutionMode::Plan);
        assert_eq!(ask, ExecutionMode::AgentApprove);
        assert_eq!(auto, ExecutionMode::AgentAuto);
        // New aliases also work for the unified FE.
        let approve: ExecutionMode = serde_json::from_str("\"agent_approve\"").unwrap();
        let agent_auto: ExecutionMode = serde_json::from_str("\"agent_auto\"").unwrap();
        assert_eq!(approve, ExecutionMode::AgentApprove);
        assert_eq!(agent_auto, ExecutionMode::AgentAuto);
        // Serializing emits the legacy strings so ledger entries
        // and event payloads stay stable.
        assert_eq!(
            serde_json::to_string(&ExecutionMode::Plan).unwrap(),
            "\"plan\""
        );
        assert_eq!(
            serde_json::to_string(&ExecutionMode::AgentApprove).unwrap(),
            "\"ask\""
        );
        assert_eq!(
            serde_json::to_string(&ExecutionMode::AgentAuto).unwrap(),
            "\"auto\""
        );
    }

    #[test]
    fn execution_mode_label_matches_wire_format() {
        // The ledger uses these labels in `<previous_work mode="…">`
        // and as the `mode` string in LedgerEntry. They must keep
        // matching the wire format so the FE can correlate them.
        assert_eq!(execution_mode_label(ExecutionMode::Plan), "plan");
        assert_eq!(execution_mode_label(ExecutionMode::AgentApprove), "ask");
        assert_eq!(execution_mode_label(ExecutionMode::AgentAuto), "auto");
    }

    #[test]
    fn ask_turn_produces_answered_only_entry() {
        // Ask-mode turns (and rare Agent text-only turns) must
        // record a one-line `AnsweredOnly` entry so a follow-up
        // turn knows the conversational thread exists without
        // re-reading the full answer text.
        let entry = crate::services::history::entry_for_answer(
            1, 1234567, "ask",
            "The buffer pool design uses clock-sweep eviction. We chose it because ARC was tested but rejected for memory overhead reasons that don't apply here.",
        );
        assert_eq!(entry.turn, 1);
        assert_eq!(entry.mode, "ask");
        match entry.kind {
            crate::services::history::LedgerKind::AnsweredOnly { summary } => {
                assert!(summary.contains("buffer pool design"));
                // First sentence only — second sentence gets cut.
                assert!(!summary.contains("ARC was tested"));
            }
            _ => panic!("expected AnsweredOnly"),
        }
    }

    #[test]
    fn extract_definitions_handles_typescript() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("x.ts");
        fs::write(
            &p,
            "export function login(u: string) { return u; }\nexport class User {}\nexport interface Session { id: string }\n",
        )
        .unwrap();
        let defs = extract_definitions(&p, "ts").unwrap();
        assert!(defs.iter().any(|(k, n, _)| *k == "fn" && n == "login"));
        assert!(defs.iter().any(|(k, n, _)| *k == "class" && n == "User"));
        assert!(defs
            .iter()
            .any(|(k, n, _)| *k == "interface" && n == "Session"));
    }

    /// Prompt detection — strong patterns must fire, ambiguous
    /// log-shaped text must NOT. False positives are worse than
    /// false negatives, so the guard rails matter.
    #[test]
    fn detect_prompt_fires_on_strong_yn_patterns() {
        let cases = [
            "Need to install the following packages:\n  create-react-app@5.0.1\nOk to proceed? (y) ",
            "Are you sure you want to delete this repository? [y/N] ",
            "Continue? [Y/n] ",
            "Overwrite existing file? (yes/no): ",
        ];
        for case in cases {
            assert!(
                detect_prompt(case).is_some(),
                "expected detection in: {:?}",
                case,
            );
        }
    }

    #[test]
    fn detect_prompt_fires_on_password_prompts() {
        assert!(detect_prompt("Enter passphrase for /Users/x/.ssh/id_ed25519: ").is_some());
        assert!(detect_prompt("[sudo] password for sameer: ").is_some());
    }

    #[test]
    fn detect_prompt_fires_on_trailing_question_with_space() {
        assert!(detect_prompt("What is your project name? ").is_some());
    }

    #[test]
    fn detect_prompt_does_not_fire_on_log_output() {
        // Each of these has a colon or question mark but is NOT a
        // prompt — would be a false positive that pauses a running
        // command for no reason.
        let cases = [
            "[INFO] Connecting to: registry.npmjs.org",
            "Downloading: 23%",
            "{\n  \"key\": \"value\",\n  \"flag\": true\n}",
            "What is going on here, anyway? \nMore log output\n", // trailing newline = no live prompt
            "loaded plugin: typescript",
            "Found 0 errors. Watching for file changes.",
            "compiled successfully",
            "",
            "?", // standalone — not enough surrounding alpha
        ];
        for case in cases {
            assert!(
                detect_prompt(case).is_none(),
                "false positive in: {:?}",
                case,
            );
        }
    }

    #[test]
    fn detect_server_ready_matches_common_dev_servers() {
        // Each of these is a real banner the corresponding tool
        // prints when its dev server is up. Detection turns the
        // never-exiting child into a graceful "ok, move on" so
        // the agent can keep going. Cross-language coverage is the
        // point — this is not just for JS/TS frameworks.
        let cases: &[&str] = &[
            // ── JavaScript / TypeScript ecosystem ──────────────
            "> my-react-todo-app@0.0.0 dev\n> vite\n\n  VITE v8.0.14  ready in 430 ms\n\n  ➜  Local:   http://localhost:5173/",
            "▲ Next.js 14.2.3\n- Local:        http://localhost:3000\n",
            "Compiled successfully!\n\nYou can now view my-app in the browser.\n\n  Local:            http://localhost:3000\n  On Your Network:  http://192.168.1.5:3000",
            "Server listening on port 8080",
            " astro  v4.5.10 started in 1.5s\n  Local    http://localhost:4321/",
            // ── Python ────────────────────────────────────────
            "WARNING: This is a development server.\n * Running on http://127.0.0.1:5000",
            "Watching for file changes with StatReloader\nPerforming system checks...\n\nStarting development server at http://127.0.0.1:8000/",
            "INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)",
            "INFO:     Application startup complete.",
            "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...",
            // ── Ruby ───────────────────────────────────────────
            "* Listening on http://127.0.0.1:3000\nUse Ctrl-C to stop",
            "Puma starting in single mode...\n* Listening on http://0.0.0.0:9292",
            // ── Go ─────────────────────────────────────────────
            "2026/05/24 18:10:01 Starting server on :8080\n2026/05/24 18:10:01 Server listening at http://localhost:8080",
            // ── Rust ───────────────────────────────────────────
            "🚀 Rocket has launched from http://127.0.0.1:8000",
            "INFO  axum::serve listening on 0.0.0.0:3000",
            // ── Java / Spring ──────────────────────────────────
            "Tomcat started on port 8080 (http) with context path ''\nStarted Application in 3.214 seconds",
            // ── .NET / Kestrel ─────────────────────────────────
            "info: Microsoft.Hosting.Lifetime[14]\n      Now listening on: http://localhost:5000",
            // ── PHP ───────────────────────────────────────────
            "[Sun May 24 18:10:01 2026] PHP 8.2.0 Development Server (http://localhost:8000) started",
            // ── Elixir / Phoenix ───────────────────────────────
            "[info] Running PhoenixWeb.Endpoint with cowboy 2.10.0 at 0.0.0.0:4000 (http)",
            // ── File watchers in steady state ──────────────────
            "[1:14:32 PM] Found 0 errors. Watching for file changes.",
            "Watch Usage\n  press a to run all tests",
            "vitest v1.2.0\n  Watch Usage\n  > Press a to run all tests",
        ];
        for case in cases {
            assert!(
                detect_server_ready(case).is_some(),
                "expected detection in: {:?}",
                &case[..case.len().min(120)],
            );
        }
    }

    #[test]
    fn parse_wait_for_accepts_known_forms() {
        match parse_wait_for("port:3000") {
            Some(WaitForSpec::Port(p)) => assert_eq!(p, 3000),
            other => panic!("expected Port(3000), got {:?}", other),
        }
        match parse_wait_for("port: 8080 ") {
            Some(WaitForSpec::Port(p)) => assert_eq!(p, 8080),
            other => panic!("expected Port(8080), got {:?}", other),
        }
        match parse_wait_for("output:Listening on") {
            Some(WaitForSpec::Output(s)) => assert_eq!(s, "Listening on"),
            other => panic!("expected Output, got {:?}", other),
        }
        match parse_wait_for("file:dist/bundle.js") {
            Some(WaitForSpec::File(p)) => assert_eq!(p, "dist/bundle.js"),
            other => panic!("expected File, got {:?}", other),
        }
    }

    #[test]
    fn parse_wait_for_rejects_invalid() {
        assert!(matches!(
            parse_wait_for("port:abc"),
            Some(WaitForSpec::Invalid(_))
        ));
        assert!(matches!(
            parse_wait_for("port:0"),
            Some(WaitForSpec::Invalid(_))
        ));
        assert!(matches!(
            parse_wait_for("output:"),
            Some(WaitForSpec::Invalid(_))
        ));
        assert!(matches!(
            parse_wait_for("file:"),
            Some(WaitForSpec::Invalid(_))
        ));
        assert!(matches!(
            parse_wait_for("nonsense"),
            Some(WaitForSpec::Invalid(_))
        ));
        // Empty is None (no wait_for specified at all).
        assert!(parse_wait_for("").is_none());
        assert!(parse_wait_for("  ").is_none());
    }

    #[test]
    fn tcp_port_is_open_returns_false_for_unbound_port() {
        // Picking a high port nobody normally binds. If this
        // flakes someone's local dev box is serving on 53999.
        assert!(!tcp_port_is_open(53999));
    }

    #[test]
    fn detect_server_ready_does_not_fire_on_one_shot_output() {
        // Build / test / install logs that should NOT trip the
        // server-ready signal. False positives here would tear
        // down legitimate one-shot commands mid-way.
        let cases: &[&str] = &[
            "added 234 packages in 12s\n",
            "Successfully installed react react-dom",
            "Test Suites: 5 passed, 5 total\nTests: 28 passed",
            "Cargo build finished `dev` profile in 1.2s",
            "Build completed in 3s\nbundle size: 124 KB",
            "",
            "warning package.json: No license field",
        ];
        for case in cases {
            assert!(
                detect_server_ready(case).is_none(),
                "false positive in: {:?}",
                case,
            );
        }
    }

    #[test]
    fn blocking_refusal_catches_unrecoverable_commands() {
        // The refusal list is intentionally small — only commands
        // with no terminating signal of any kind. Dev servers go
        // through `detect_server_ready` for graceful auto-kill;
        // they should NOT be in this list anymore.
        let cases: &[&str] = &[
            // Log followers — output never ends.
            "tail -f /var/log/syslog",
            "journalctl -f",
            "kubectl logs -f my-pod",
            "docker logs -f mycontainer",
            // Interactive pagers — wait for keystrokes.
            "less /var/log/syslog",
            "more package.json",
            // watch(1) — never exits.
            "watch -n 5 ls",
            // Watch-mode test runners where the model clearly meant
            // the one-shot variant.
            "tsc --watch",
            "tsc -w",
            "jest --watch src/",
            "vitest --watch",
        ];
        for case in cases {
            let result = blocking_command_refusal(case);
            assert!(
                result.is_some(),
                "expected refusal for {:?} but got None",
                case,
            );
        }
    }

    #[test]
    fn blocking_refusal_lets_dev_servers_through_to_detection() {
        // Critical behavior change: dev servers are NO LONGER
        // refused up-front. They're allowed through so
        // `detect_server_ready` can gracefully SIGTERM them once
        // ready. This keeps the system language-agnostic — `go
        // run ./cmd/server`, `python app.py`, `rails s`, etc. all
        // get the same treatment without needing per-command
        // pattern lists.
        let dev_servers: &[&str] = &[
            "npm run dev",
            "npm start",
            "yarn dev",
            "pnpm dev",
            "bun dev",
            "next dev",
            "vite",
            "webpack serve",
            "ng serve",
            "flask run",
            "python manage.py runserver",
            "rails server",
            "rails s -p 4000",
            "php artisan serve",
            "python -m http.server 8000",
            "nodemon server.js",
            "nuxt dev",
            "astro dev",
            "go run ./cmd/server",
            "cargo run",
            "java -jar app.jar",
            "dotnet run",
        ];
        for case in dev_servers {
            let result = blocking_command_refusal(case);
            assert!(
                result.is_none(),
                "regression: {:?} is now refused, but should be allowed through for auto-detection: {:?}",
                case,
                result,
            );
        }
    }

    #[test]
    fn blocking_refusal_handles_cd_and_env_prefixes() {
        // The classifier should see through common prefixes the
        // model uses to chain context-switches with the real cmd.
        assert!(blocking_command_refusal("cd /var && tail -f log").is_some());
        assert!(blocking_command_refusal("env LOG=1 tail -f log").is_some());
        assert!(blocking_command_refusal("sudo journalctl -f").is_some());
    }

    #[test]
    fn blocking_refusal_allows_one_shot_commands() {
        // These must NOT be refused — they're the kinds of
        // verifications we want the agent to actually run.
        let allowed: &[&str] = &[
            "npm install",
            "npm install --save-dev typescript",
            "npm run build",
            "npm test",
            "npm test -- --run",
            "npm run lint",
            "yarn install",
            "yarn build",
            "pnpm install",
            "pnpm build",
            "tsc --noEmit",
            "cargo build",
            "cargo test",
            "cargo check",
            "go build ./...",
            "go test ./...",
            "mvn compile",
            "pytest",
            "vitest --run",
            "ls -la",
            "cat package.json",
            "git status",
            "tail -n 50 logs.txt",
            "grep -r 'TODO' src/",
            "echo hello",
            "node script.js",
            "python script.py",
        ];
        for case in allowed {
            let result = blocking_command_refusal(case);
            assert!(
                result.is_none(),
                "false positive: refused {:?} with: {:?}",
                case,
                result,
            );
        }
    }

    #[test]
    fn blocking_refusal_message_is_actionable() {
        // The model needs more than "no" — it needs the alternative
        // so it can recover in the same turn.
        let msg = blocking_command_refusal("tail -f /var/log/syslog").unwrap();
        assert!(
            msg.contains("tail -f /var/log/syslog"),
            "missing original command: {msg}"
        );
        assert!(
            msg.contains("tail -n"),
            "missing snapshot alternative: {msg}"
        );
        let msg = blocking_command_refusal("tsc --watch").unwrap();
        assert!(
            msg.contains("tsc --noEmit"),
            "missing one-shot suggestion: {msg}"
        );
    }

    #[test]
    fn strip_leading_command_noise_strips_known_prefixes() {
        assert_eq!(strip_leading_command_noise("npm run dev"), "npm run dev");
        assert_eq!(
            strip_leading_command_noise("cd app && npm run dev"),
            "npm run dev",
        );
        assert_eq!(
            strip_leading_command_noise("env PORT=4000 NODE_ENV=development npm run dev"),
            "npm run dev",
        );
        assert_eq!(
            strip_leading_command_noise("nohup time sudo npm start"),
            "npm start",
        );
        // Idempotent — repeated invocations don't change a clean cmd.
        let clean = strip_leading_command_noise("ls -la");
        assert_eq!(strip_leading_command_noise(&clean), "ls -la");
    }

    #[test]
    fn default_budgets_accommodate_large_local_models() {
        // Regression guard: if anyone trims these back to the 7B
        // defaults the larger checkpoints will silently stop
        // completing multi-step tasks again. The numbers don't
        // need to be exact — just floors.
        let max_steps = std::hint::black_box(DEFAULT_MAX_STEPS);
        let max_runtime_s = std::hint::black_box(DEFAULT_MAX_RUNTIME_S);
        let num_predict = std::hint::black_box(DEFAULT_NUM_PREDICT);
        let soft_budget = std::hint::black_box(TRANSCRIPT_SOFT_BUDGET_CHARS);
        let recent_tail = std::hint::black_box(TRANSCRIPT_RECENT_TAIL);
        assert!(
            max_steps >= 30,
            "max_steps too low for 32B-class tasks: {max_steps}"
        );
        assert!(
            max_runtime_s >= 1200,
            "runtime cap too short for slow inference: {max_runtime_s}"
        );
        assert!(
            num_predict >= 2048,
            "per-turn token cap too low for large models: {num_predict}"
        );
        assert!(
            soft_budget >= 40_000,
            "context budget too small for 32K-context models"
        );
        assert!(
            recent_tail >= 6,
            "recent-tail floor too aggressive: smart pruner needs working memory"
        );
    }

    #[test]
    fn shell_prompt_delivery_roundtrips() {
        let (tx, rx) = std::sync::mpsc::channel();
        register_shell_prompt("req-x/0", tx);
        assert!(deliver_shell_prompt_response("req-x/0", "y".into()));
        assert_eq!(
            rx.recv_timeout(Duration::from_millis(50)).ok(),
            Some("y".into())
        );
        // After delivery, the slot is gone.
        assert!(!deliver_shell_prompt_response("req-x/0", "n".into()));
    }

    #[test]
    fn cancel_shell_prompts_releases_pending_waiters() {
        let (tx_a, rx_a) = std::sync::mpsc::channel();
        let (tx_b, rx_b) = std::sync::mpsc::channel();
        let (tx_c, rx_c) = std::sync::mpsc::channel();
        register_shell_prompt("req-y/0", tx_a);
        register_shell_prompt("req-y/1", tx_b);
        register_shell_prompt("req-z/0", tx_c);
        cancel_shell_prompts_for("req-y");
        // y's prompts both released with empty string.
        assert_eq!(
            rx_a.recv_timeout(Duration::from_millis(50)).ok(),
            Some(String::new())
        );
        assert_eq!(
            rx_b.recv_timeout(Duration::from_millis(50)).ok(),
            Some(String::new())
        );
        // z's prompt untouched.
        assert!(rx_c.recv_timeout(Duration::from_millis(50)).is_err());
        // Clean up.
        deliver_shell_prompt_response("req-z/0", String::new());
    }

    /// The pipe-deadlock regression: previously, a child writing
    /// more than the OS pipe buffer (~64 KB on macOS) would block
    /// because we only drained stdout/stderr AFTER the child
    /// exited. We simulate that with `yes` truncated to ~200 KB —
    /// more than enough to fill the buffer. With the old code this
    /// would time out; with the reader-thread fix it finishes
    /// quickly and we capture the bytes.
    #[test]
    #[cfg(unix)]
    fn run_shell_does_not_deadlock_on_chatty_output() {
        // Skip if `yes` and `head` aren't available (extremely rare
        // on macOS/Linux). Use a low repetition that still exceeds
        // the typical 64 KB pipe buffer.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let call = ToolCall {
            tool: "run_shell".into(),
            attrs: {
                let mut a = HashMap::new();
                a.insert("timeout_ms".into(), "15000".into());
                a
            },
            // Produce ~200 KB of output — would deadlock a
            // post-exit drain. `head -c 200000` short-circuits.
            body: "yes 'pointer-deadlock-test' | head -c 200000".into(),
            fingerprint: 0,
        };
        let dir = tempdir().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        // We can't easily build a real AppHandle in a unit test;
        // instead, verify the drain logic in isolation by spawning
        // the child directly with reader threads (mirrors run_shell
        // but without the Tauri emit). If THIS deadlocks, the
        // real version would too.
        use std::io::{BufRead, BufReader};
        let body = &call.body;
        let timeout = Duration::from_millis(15_000);
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(body)
            .current_dir(&ws)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn");
        let so = child.stdout.take().unwrap();
        let h1 = std::thread::spawn(move || {
            let mut r = BufReader::new(so);
            let mut buf = String::new();
            let mut line = String::new();
            while r.read_line(&mut line).unwrap_or(0) > 0 {
                buf.push_str(&line);
                line.clear();
                if buf.len() > 300_000 {
                    break;
                }
            }
            buf
        });
        let deadline = Instant::now() + timeout;
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "child deadlocked (regression: pipe drainer missing)"
            );
            std::thread::sleep(Duration::from_millis(40));
        }
        let captured = h1.join().unwrap();
        assert!(
            captured.len() >= 100_000,
            "expected >=100 KB drained, got {}",
            captured.len()
        );
        let _ = rt;
    }

    /// stdin must be closed so commands that prompt
    /// (`npx create-react-app` asks "Ok to proceed?") don't sit
    /// waiting for input that will never come.
    #[test]
    #[cfg(unix)]
    fn run_shell_stdin_is_null_so_interactive_prompts_dont_hang() {
        // `read` blocks until stdin yields a line. With stdin set
        // to /dev/null it gets immediate EOF and falls through.
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("read line; echo done")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn");
        let started = Instant::now();
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "stdin not closed: child blocked on read"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// SHELL_PIDS is the registry that lets agent_cancel kill an
    /// in-flight run_shell. Registration and unregistration must
    /// round-trip; cancel must flip the flag.
    #[test]
    fn shell_cancel_flag_round_trips() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let flag = Arc::new(AtomicBool::new(false));
        register_shell_pid("test-req", 99999, flag.clone());
        cancel_shell_for("test-req");
        assert!(flag.load(Ordering::SeqCst), "cancel did not set flag");
        unregister_shell_pid("test-req");
        // After unregister, cancel becomes a no-op.
        let flag2 = Arc::new(AtomicBool::new(false));
        cancel_shell_for("test-req");
        assert!(!flag2.load(Ordering::SeqCst));
    }

    #[test]
    fn find_similar_paths_returns_basename_matches() {
        let dir = tempdir().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        fs::create_dir_all(dir.path().join("public")).unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("index.html"), "<html/>").unwrap();
        fs::write(dir.path().join("public/index.html"), "<html/>").unwrap();
        fs::write(dir.path().join("src/main.js"), "x").unwrap();
        let hits = find_similar_paths(&ws, "src/index.html");
        // Both real index.html files surfaced; src/main.js excluded.
        assert!(hits.iter().any(|h| h == "index.html"));
        assert!(hits.iter().any(|h| h == "public/index.html"));
        assert!(!hits.iter().any(|h| h == "src/main.js"));
    }

    #[test]
    fn find_similar_paths_is_case_insensitive() {
        let dir = tempdir().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("README.md"), "x").unwrap();
        let hits = find_similar_paths(&ws, "docs/readme.md");
        assert_eq!(hits, vec!["README.md".to_string()]);
    }

    #[test]
    fn find_similar_paths_empty_when_no_match() {
        let dir = tempdir().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("a.txt"), "x").unwrap();
        let hits = find_similar_paths(&ws, "src/zzz.html");
        assert!(hits.is_empty());
    }

    #[test]
    fn extract_definitions_handles_python_and_rust() {
        let dir = tempdir().unwrap();
        let py = dir.path().join("x.py");
        fs::write(&py, "def hello():\n    pass\n\nclass Greeter:\n    pass\n").unwrap();
        let defs = extract_definitions(&py, "py").unwrap();
        assert!(defs.iter().any(|(k, n, _)| *k == "fn" && n == "hello"));
        assert!(defs.iter().any(|(k, n, _)| *k == "class" && n == "Greeter"));

        let rs = dir.path().join("y.rs");
        fs::write(&rs, "pub fn run() {}\npub struct Foo;\npub trait Bar {}\n").unwrap();
        let defs = extract_definitions(&rs, "rs").unwrap();
        assert!(defs.iter().any(|(k, n, _)| *k == "fn" && n == "run"));
        assert!(defs.iter().any(|(k, n, _)| *k == "struct" && n == "Foo"));
        assert!(defs.iter().any(|(k, n, _)| *k == "trait" && n == "Bar"));
    }

    #[test]
    fn detect_cycle_finds_identical_runs() {
        assert!(detect_cycle(&[1, 1]));
        assert!(detect_cycle(&[7, 7, 7]));
        // Single identical pair at the tail counts.
        assert!(detect_cycle(&[1, 2, 3, 3]));
    }

    #[test]
    fn detect_cycle_finds_ab_ab() {
        assert!(detect_cycle(&[1, 2, 1, 2]));
        assert!(detect_cycle(&[9, 1, 2, 1, 2]));
        assert!(!detect_cycle(&[1, 2, 1, 3]));
    }

    #[test]
    fn detect_cycle_finds_abc_abc() {
        assert!(detect_cycle(&[1, 2, 3, 1, 2, 3]));
        assert!(!detect_cycle(&[1, 2, 3, 1, 2, 4]));
    }

    #[test]
    fn detect_cycle_ignores_short_windows() {
        assert!(!detect_cycle(&[]));
        assert!(!detect_cycle(&[1]));
        // A,B,C with no repeat.
        assert!(!detect_cycle(&[1, 2, 3]));
    }

    #[test]
    fn sanitize_strips_hallucinated_tool_result() {
        let input = "<read_file path=\"a.js\" />\n<tool_result tool=\"read_file\" status=\"ok\">fake</tool_result>\n<final>done</final>";
        let out = sanitize_model_output(input);
        assert!(out.contains("<read_file"));
        assert!(!out.contains("tool_result"));
        assert!(out.contains("<final>"));
    }

    #[test]
    fn sanitize_handles_unclosed_tool_result() {
        let input = "real text <tool_result>partial without close";
        let out = sanitize_model_output(input);
        assert_eq!(out, "real text ");
    }

    #[test]
    fn sanitize_strips_verifier_blocks() {
        let input = "<final>summary</final>\n<verifier>secret tests</verifier>";
        let out = sanitize_model_output(input);
        assert!(out.contains("<final>summary</final>"));
        assert!(!out.contains("verifier"));
    }

    #[test]
    fn sanitize_is_idempotent_when_clean() {
        let input = "<read_file path=\"x\" />\n<final>ok</final>";
        let out = sanitize_model_output(input);
        assert_eq!(out, input);
    }

    #[test]
    fn transcript_turn_keeps_only_executed_tool_call() {
        let input = "<think>need current bytes</think>\n<read_file path=\"src/a.js\" />\n<apply_diff path=\"src/a.js\">x</apply_diff>\n<final>done</final>";
        let (turn, ignored) = transcript_turn_for_executed_tool(input);
        assert!(ignored);
        assert!(turn.contains("<think>need current bytes</think>"));
        assert!(turn.contains("<read_file path=\"src/a.js\" />"));
        assert!(!turn.contains("<apply_diff"));
        assert!(!turn.contains("<final>"));
    }

    #[test]
    fn transcript_turn_keeps_body_tool_through_close_tag() {
        let input = "<apply_diff path=\"src/a.js\">\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n</apply_diff>\n<run_check />";
        let (turn, ignored) = transcript_turn_for_executed_tool(input);
        assert!(ignored);
        assert!(turn.ends_with("</apply_diff>"));
        assert!(!turn.contains("<run_check"));
    }

    #[test]
    fn malformed_tool_tag_detects_clipped_body_tool() {
        let input = "<apply_diff path=\"src/a.js\">\n<<<<<<< SEARCH\nold\n=======\nnew";
        assert_eq!(first_malformed_tool_tag(input), Some("apply_diff"));
        assert_eq!(
            first_malformed_tool_tag("<apply_diff path=\"src/a.js\">x</apply_diff>"),
            None
        );
    }

    // Self-closing tags are the canonical form taught by the system
    // prompt (`<read_file path="x" />`, `<list_dir path="." />`,
    // `<rename_path from="a" to="b" />`, etc.) and the form local
    // coder models reach for first. The harness MUST recognize them
    // or every attribute-only call falls through to the
    // prose-redirect → "no_tool" termination, which is exactly the
    // failure mode the user hit in the Tomato/Potato run on
    // qwen2.5-coder:32b.
    #[test]
    fn parse_tool_call_handles_self_closing_read_file() {
        let call = parse_tool_call("<read_file path=\"test/test.ts\" />")
            .expect("self-closing should parse");
        assert_eq!(call.tool, "read_file");
        assert_eq!(
            call.attrs.get("path").map(String::as_str),
            Some("test/test.ts")
        );
        assert!(call.body.is_empty());
    }

    #[test]
    fn parse_tool_call_handles_self_closing_without_space() {
        // No whitespace between the last attribute value and `/>`.
        let call = parse_tool_call("<read_file path=\"a\"/>").expect("must parse");
        assert_eq!(call.tool, "read_file");
        assert_eq!(call.attrs.get("path").map(String::as_str), Some("a"));
    }

    #[test]
    fn parse_tool_call_handles_self_closing_multi_attr() {
        // rename_path has two required attrs — exercised here both
        // to confirm parse_attrs cooperates with the self-closing
        // branch and to cover one of the other attribute-only tools.
        let call =
            parse_tool_call("<rename_path from=\"old/p\" to=\"new/p\" />").expect("must parse");
        assert_eq!(call.tool, "rename_path");
        assert_eq!(call.attrs.get("from").map(String::as_str), Some("old/p"));
        assert_eq!(call.attrs.get("to").map(String::as_str), Some("new/p"));
        assert!(call.body.is_empty());
    }

    #[test]
    fn parse_tool_call_self_closing_with_trailing_slash_in_path() {
        // Regression: a path that itself ends with `/` (a
        // directory) must not be confused with the self-closing
        // marker. The `/` we care about is OUTSIDE the quoted
        // attribute value.
        let call = parse_tool_call("<list_dir path=\"src/\" />").expect("must parse");
        assert_eq!(call.tool, "list_dir");
        assert_eq!(call.attrs.get("path").map(String::as_str), Some("src/"));
        // And the non-self-closing form with a directory path must
        // still hand control to the body-extraction branch (which
        // here returns None because there's no </list_dir>).
        assert!(parse_tool_call("<list_dir path=\"src/\">").is_none());
    }

    #[test]
    fn parse_tool_call_still_handles_body_tags() {
        // Sanity check: tools with bodies (write_file, apply_diff,
        // grep, glob) keep working — the self-closing branch only
        // fires when the header itself ends with `/`.
        let call = parse_tool_call("<write_file path=\"a.ts\">const x = 1;\n</write_file>")
            .expect("write_file with body should parse");
        assert_eq!(call.tool, "write_file");
        assert_eq!(call.body, "const x = 1;");
        let call = parse_tool_call("<grep glob=\"*.rs\">TODO</grep>").expect("grep should parse");
        assert_eq!(call.tool, "grep");
        assert_eq!(call.body, "TODO");
    }

    #[test]
    fn parse_tool_call_picks_first_tool_when_self_closing_appears_first() {
        // Mixed input: a self-closing read_file followed by a
        // write_file with a body. We must pick the read_file
        // (earlier position) and not get confused by the later
        // tool's `>` characters.
        let s = "<read_file path=\"a\" />\n<write_file path=\"b.ts\">x</write_file>";
        let call = parse_tool_call(s).expect("must pick read_file");
        assert_eq!(call.tool, "read_file");
        assert_eq!(call.attrs.get("path").map(String::as_str), Some("a"));
        assert!(call.body.is_empty());
    }

    // ── Skill parser routing ──────────────────────────────────────────
    // Skills appear in `parse_tool_call`'s priority list BEFORE the
    // primitives, so model output that uses the skill form gets
    // routed through services::skills (not the underlying primitive).
    // These tests pin that contract; if someone reorders the tools
    // list and accidentally swaps priorities, the tests catch it.

    #[test]
    fn parse_tool_call_routes_edit_file_skill() {
        let s = "<edit_file path=\"src/x.ts\">\n<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE\n</edit_file>";
        let call = parse_tool_call(s).expect("edit_file should parse");
        assert_eq!(call.tool, "edit_file");
        assert_eq!(call.attrs.get("path").map(String::as_str), Some("src/x.ts"));
        assert!(call.body.contains("<<<<<<< SEARCH"));
    }

    #[test]
    fn parse_tool_call_routes_rename_symbol_skill_self_closing() {
        let s = "<rename_symbol old=\"Foo\" new=\"Bar\" scope=\"src/\" />";
        let call = parse_tool_call(s).expect("rename_symbol should parse");
        assert_eq!(call.tool, "rename_symbol");
        assert_eq!(call.attrs.get("old").map(String::as_str), Some("Foo"));
        assert_eq!(call.attrs.get("new").map(String::as_str), Some("Bar"));
        assert_eq!(call.attrs.get("scope").map(String::as_str), Some("src/"));
        assert!(call.body.is_empty());
    }

    #[test]
    fn parse_tool_call_routes_discover_skill() {
        let s = "<discover>authentication middleware and sessions</discover>";
        let call = parse_tool_call(s).expect("discover should parse");
        assert_eq!(call.tool, "discover");
        assert!(call.body.contains("authentication"));
    }

    #[test]
    fn parse_tool_call_routes_run_check_skill_self_closing() {
        let call = parse_tool_call("<run_check />").expect("run_check should parse");
        assert_eq!(call.tool, "run_check");
        assert!(call.body.is_empty());
    }

    #[test]
    fn parse_tool_call_prefers_skill_over_primitive_when_both_present() {
        // Regression guard: if both an <edit_file> skill call and an
        // <apply_diff> primitive call appear in the same turn (the
        // model sometimes hedges), the skill wins because skills
        // come first in the priority list. This matters because
        // apply_diff alone skips the regression check — the whole
        // point of edit_file is to add that check.
        let s = "<edit_file path=\"a.ts\">x</edit_file>\n<apply_diff path=\"a.ts\">y</apply_diff>";
        let call = parse_tool_call(s).expect("must parse");
        assert_eq!(call.tool, "edit_file");
    }

    #[test]
    fn skill_tags_match_parser_priority_list() {
        // Single source of truth check: every tag in
        // services::skills::SKILL_TAGS must be reachable via
        // parse_tool_call. If a skill is added to the const but
        // forgotten in the parser, this test catches it.
        for tag in crate::services::skills::SKILL_TAGS {
            let s = format!("<{tag} />");
            let call = parse_tool_call(&s).unwrap_or_else(|| {
                panic!(
                    "skill tag <{tag}/> did not parse — is it in parse_tool_call's priority list?"
                )
            });
            assert_eq!(&call.tool, tag);
        }
    }

    #[test]
    fn skill_tags_appear_in_system_prompt() {
        // Documentation check: the SKILLS section of agent_system.txt
        // must mention every skill the parser knows about (and vice
        // versa). Otherwise the model never learns the skill exists
        // and we burn the prompt tokens on dead entries.
        for tag in crate::services::skills::SKILL_TAGS {
            let needle = format!("<{tag}");
            assert!(
                AGENT_SYSTEM.contains(&needle),
                "skill tag <{tag}> is in SKILL_TAGS but not documented in agent_system.txt",
            );
        }
    }

    #[test]
    fn skill_mutating_set_matches_filesystem_touching_skills() {
        // edit_file and rename_symbol write to disk — they MUST be
        // in MUTATING_TOOLS so Plan-mode refuses them and Ask-mode
        // prompts. discover and run_check do not write, so they
        // must NOT be in the list (otherwise Plan mode would block
        // benign reads).
        assert!(MUTATING_TOOLS.contains(&"edit_file"));
        assert!(MUTATING_TOOLS.contains(&"rename_symbol"));
        assert!(!MUTATING_TOOLS.contains(&"discover"));
        assert!(!MUTATING_TOOLS.contains(&"run_check"));
    }

    #[test]
    fn plan_forbidden_tools_blocks_shell_backed_workflows() {
        assert!(PLAN_FORBIDDEN_TOOLS.contains(&"run_shell"));
        assert!(PLAN_FORBIDDEN_TOOLS.contains(&"run_check"));
        assert!(PLAN_FORBIDDEN_TOOLS.contains(&"task"));
        assert!(!PLAN_FORBIDDEN_TOOLS.contains(&"read_file"));
        assert!(!PLAN_FORBIDDEN_TOOLS.contains(&"discover"));
    }

    #[test]
    fn stream_idle_timeout_is_in_sensible_range() {
        // The watchdog terminates the run if no model chunk arrives
        // within this window. Lower bound: long enough to cover
        // first-token warm-up on a cold 32 B model (~30 s). Upper
        // bound: short enough that a genuine hang doesn't leave the
        // user staring at "thinking..." for minutes (the failure
        // mode that prompted adding the watchdog). 60–300 s is the
        // safe band.
        let timeout_s = std::hint::black_box(STREAM_IDLE_TIMEOUT_S);
        assert!(
            (60..=300).contains(&timeout_s),
            "STREAM_IDLE_TIMEOUT_S = {timeout_s} is outside the 60-300 s safe range",
        );
    }

    #[test]
    fn render_mcp_result_extracts_text_content() {
        let v = json!({
            "content": [
                { "type": "text", "text": "hello" },
                { "type": "text", "text": "world" }
            ]
        });
        let s = render_mcp_result(&v);
        assert!(s.contains("hello"));
        assert!(s.contains("world"));
        assert!(s.contains("---"));
    }

    #[test]
    fn render_mcp_result_marks_errors() {
        let v = json!({
            "isError": true,
            "content": [{ "type": "text", "text": "boom" }]
        });
        let s = render_mcp_result(&v);
        assert!(s.starts_with("[isError]"), "got: {s}");
    }

    #[test]
    fn render_mcp_result_describes_non_text_content() {
        let v = json!({
            "content": [
                { "type": "image", "mimeType": "image/png" },
                { "type": "resource", "resource": { "uri": "file:///x" } }
            ]
        });
        let s = render_mcp_result(&v);
        assert!(s.contains("[image: image/png]"));
        assert!(s.contains("[resource: file:///x]"));
    }

    #[test]
    fn render_mcp_section_includes_tool_names_and_required_fields() {
        let tools = vec![(
            "fs".to_string(),
            McpTool {
                name: "read_file".to_string(),
                description: Some("Read a file from disk".to_string()),
                input_schema: Some(json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "absolute path" }
                    },
                    "required": ["path"]
                })),
            },
        )];
        let section = render_mcp_section(&tools);
        assert!(section.contains("MCP TOOLS"));
        assert!(section.contains("Server `fs`"));
        assert!(section.contains("`read_file`"));
        assert!(section.contains("Read a file from disk"));
        assert!(section.contains("path: string (required)"));
    }

    #[test]
    fn load_project_rules_returns_none_for_empty_workspace() {
        assert!(load_project_rules("").is_none());
        assert!(load_project_rules("/this/path/does/not/exist").is_none());
    }

    #[test]
    fn load_project_rules_concatenates_md_files_deterministically() {
        let dir = tempdir().unwrap();
        let rules_dir = dir.path().join(".pointer").join("rules");
        fs::create_dir_all(&rules_dir).unwrap();
        fs::write(rules_dir.join("01-style.md"), "Prefer functional style.").unwrap();
        fs::write(rules_dir.join("02-tests.md"), "Always add tests.").unwrap();
        // Non-markdown should be ignored.
        fs::write(rules_dir.join("notes.txt"), "ignored").unwrap();

        let out = load_project_rules(dir.path().to_str().unwrap()).expect("rules present");
        let style_pos = out.find("Prefer functional style").unwrap();
        let tests_pos = out.find("Always add tests").unwrap();
        // Lexicographic order should put 01-style.md before 02-tests.md.
        assert!(style_pos < tests_pos);
        assert!(out.contains(".pointer/rules/01-style.md"));
        assert!(!out.contains("ignored"));
    }

    #[test]
    fn load_project_rules_also_picks_up_agents_md() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("AGENTS.md"),
            "Tone: terse. Always run `cargo test`.",
        )
        .unwrap();
        let out = load_project_rules(dir.path().to_str().unwrap()).expect("rules present");
        assert!(out.contains("AGENTS.md"));
        assert!(out.contains("Tone: terse"));
    }

    #[test]
    fn load_project_rules_is_capped() {
        // Generate a file larger than the 32 KB cap and confirm the
        // function returns a non-empty but bounded blob.
        let dir = tempdir().unwrap();
        let rules_dir = dir.path().join(".pointer").join("rules");
        fs::create_dir_all(&rules_dir).unwrap();
        let big = "X".repeat(50 * 1024);
        fs::write(rules_dir.join("00-big.md"), &big).unwrap();
        let out = load_project_rules(dir.path().to_str().unwrap()).expect("rules present");
        assert!(out.len() <= 50 * 1024); // certainly bounded by content size
                                         // Sanity: the cap should kick in well below the original size.
        assert!(out.len() < 40 * 1024, "got {} bytes", out.len());
    }

    #[test]
    fn truncate_inline_keeps_short_strings_unchanged() {
        assert_eq!(truncate_inline("hi", 10), "hi");
    }

    #[test]
    fn truncate_inline_caps_long_strings_with_ellipsis() {
        let s = truncate_inline("abcdefghij", 5);
        assert_eq!(s, "abcde…");
    }
}
