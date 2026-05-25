import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { nanoid } from "nanoid";

export type FsEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  /** Last modified time as a unix epoch (seconds). May be omitted by
   *  older builds — callers should treat absent as "unknown". */
  mtime?: number | null;
};

export type FileHit = { path: string; name: string };
export type TextHit = {
  path: string;
  line: number;
  text: string;
  /** Backend may omit on older builds; treat missing as "unknown column". */
  col?: number;
  /** Backend may omit on older builds; treat missing as the legacy "match
   *  spans the whole substring you asked for" behavior. */
  match_len?: number;
};
export type SearchOptions = {
  case_sensitive?: boolean;
  whole_word?: boolean;
  regex?: boolean;
};
export type ReplaceResult = { files_changed: number; replacements: number };

export type OllamaStatus = {
  installed: boolean;
  running: boolean;
  version: string | null;
  base_url: string;
};

export type OllamaModel = {
  name: string;
  size: number | null;
  modified_at: string | null;
};

/** Detailed outcome of an `ollama_stop` attempt. The Rust side tries hard to
 *  bring the daemon down regardless of who started it; this struct lets the
 *  UI explain *what* happened rather than just "true/false". */
export type OllamaStopResult = {
  stopped: boolean;
  killed_owned: boolean;
  killed_foreign_pids: number[];
  still_running: boolean;
};

export type ModelRecommendation = {
  id: string;
  purpose: "fim" | "chat" | "embed";
  size_gb: number;
  min_ram_gb: number;
  description: string;
  recommended: boolean;
};

export type Chunk = {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  language: string;
};

export type ScoredChunk = { chunk: Chunk; score: number };

export type IndexStatus = {
  in_progress: boolean;
  indexed_files: number;
  indexed_chunks: number;
  root: string | null;
};

export type ProcInfo = {
  pid: number;
  parent_pid: number | null;
  name: string;
  cmd: string;
  /** "pointer" | "renderer" | "ollama" | "ollama_runner" | "other" */
  kind: string;
  cpu_percent: number;
  mem_bytes: number;
  owned_by_pointer: boolean;
};

export type UninstallStep = {
  label: string;
  path: string | null;
  ok: boolean;
  message: string | null;
};

export type UninstallReport = {
  steps: UninstallStep[];
};

export type ResetOptions = {
  clear_settings?: boolean;
  clear_hf_token?: boolean;
  clear_index?: boolean;
  stop_ollama?: boolean;
};

export type ResetStep = {
  label: string;
  ok: boolean;
  message: string | null;
};

export type ResetReport = {
  steps: ResetStep[];
};

export type TerminalOpenResult = {
  id: string;
  shell: string;
};

export type TerminalExitPayload = {
  code: number | null;
};

export type GitFileStatus =
  | "untracked"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "conflicted"
  | "ignored";

export type GitFileEntry = {
  path: string;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
};

export type GitStatus = {
  is_repo: boolean;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  /** Map from *workspace-relative* path → status. Forward-slashed even on
   *  Windows for stable lookup. */
  files: Record<string, GitFileStatus>;
  /** Per-file detail for the SCM panel — staged vs unstaged. */
  entries: GitFileEntry[];
  dirty_count: number;
  error: string | null;
};

export type GitBranch = {
  name: string;
  current: boolean;
  remote: boolean;
  last_commit: string;
  upstream: string | null;
};

export type GitLogEntry = {
  hash: string;
  short_hash: string;
  author: string;
  email: string;
  relative_date: string;
  subject: string;
};

export type GitBlameLine = {
  hash: string;
  short_hash: string;
  author: string;
  date: string;
  summary: string;
  boundary: boolean;
};

export type HfTokenStatus = {
  present: boolean;
  /** Active source for reads: "keychain" when the keychain has it; "file"
   *  otherwise. Null when nothing is saved. */
  location: "keychain" | "file" | null;
  /** Short preview like "hf_…3X9Q" so the user can verify they saved the
   *  expected one without exposing the secret. */
  preview: string | null;
  /** Absolute path to the on-disk file fallback. Reported even when the
   *  active source is the keychain so the user can verify on disk. */
  file_path: string | null;
  /** True if the secondary keychain entry holds the token. */
  in_keychain: boolean;
  /** True if the on-disk file holds the token. */
  in_file: boolean;
};

export type SystemSnapshot = {
  cpu_percent: number;
  cpu_count: number;
  mem_total: number;
  mem_used: number;
  swap_total: number;
  swap_used: number;
  uptime_secs: number;
  host_name: string | null;
  os_name: string | null;
  processes: ProcInfo[];
  pointer_cpu_percent: number;
  pointer_mem_bytes: number;
};

export type HardwareProfile = {
  cpu_count: number;
  cpu_name: string | null;
  cpu_brand: string | null;
  total_ram_bytes: number;
  available_ram_bytes: number;
  swap_total: number;
  gpu_label: string | null;
  os_name: string | null;
  os_version: string | null;
  host_name: string | null;
  arch: string;
};

export type LoadedModel = {
  name: string;
  size_bytes: number;
  /** "cpu" | "gpu" | "mixed" */
  processor: string;
  expires_at: string | null;
};

/** Kind reported by the Rust classifier — keep in sync with FileKind. */
export type FileKind = "image" | "pdf" | "spreadsheet" | "plain" | "unsupported";

export type FileKindInfo = {
  kind: FileKind;
  /** "vision" | "document" | null */
  required_purpose: "vision" | "document" | null;
  label: string;
  reason: string | null;
};

export type ProcessFileResult = {
  kind: FileKind;
  label: string;
  content: string;
  raw_bytes: number;
  used_model: boolean;
  model_name: string | null;
};

// ---------- MCP (Model Context Protocol) -----------------------------------

// ---------- Assistant ledger (per-session action record) -------------------
//
// Mirrors the Rust `LedgerEntry` shape exactly. Serde emits the kind
// discriminator as `{ type: "...", ...fields }`; we model that with a
// discriminated union so callers can switch on `kind.type` exhaustively.
// Keep this in sync with `src-tauri/src/services/history.rs`.

/** Modes are stored as their wire labels so the FE renderer can show
 *  per-turn provenance ("this turn ran in plan mode"). */
export type LedgerMode = "ask" | "plan" | "agent" | "auto";

export type LedgerKind =
  | { type: "wrote"; path: string; bytes: number; hunks: number }
  | { type: "deleted"; path: string }
  | { type: "renamed"; from: string; to: string }
  | {
      type: "symbol_renamed";
      old: string;
      new: string;
      files: string[];
      references_replaced: number;
    }
  | { type: "ran_shell"; command_summary: string; exit_code: number }
  | { type: "read"; paths: string[] }
  | { type: "searched"; queries: string[] }
  | { type: "answered_only"; summary: string };

export type LedgerEntry = {
  turn: number;
  timestamp_ms: number;
  mode: string;
  kind: LedgerKind;
};

/** Payload of the `assistant:ledger:<session_id>` event fired by the
 *  backend after an Ask turn completes. The store appends `entry`
 *  to the session's ledger and bumps its turn counter. */
export type AssistantLedgerEvent = {
  session_id: string;
  entry: LedgerEntry;
};

/** Stored per-server spec — mirrors the Cursor / Claude Desktop format. */
export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  disabled?: boolean;
};

export type McpConfig = {
  mcpServers: Record<string, McpServerConfig>;
};

export type McpServerStatus = "stopped" | "starting" | "ready" | "error";

export type McpServerSnapshot = {
  name: string;
  config: McpServerConfig;
  status: McpServerStatus;
  error: string | null;
  server_info: unknown | null;
  started_at_ms: number | null;
  tool_count: number;
};

export type McpTool = {
  name: string;
  description: string | null;
  inputSchema: unknown | null;
};

export const ipc = {
  // FS
  readWorkspaceTree: (path: string) =>
    invoke<FsEntry[]>("read_workspace_tree", { path }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) =>
    invoke<void>("write_text_file", { path, contents }),
  createFile: (path: string) => invoke<void>("create_file", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  deletePath: (path: string) => invoke<void>("delete_path", { path }),
  renamePath: (from: string, to: string) =>
    invoke<void>("rename_path", { from, to }),
  searchFiles: (query: string, limit = 50) =>
    invoke<FileHit[]>("search_files", { query, limit }),
  searchDirectories: (query: string, limit = 50) =>
    invoke<FileHit[]>("search_directories", { query, limit }),
  searchText: (query: string, limit = 200, options?: SearchOptions) =>
    invoke<TextHit[]>("search_text", { query, limit, options }),
  replaceText: (query: string, replacement: string, options?: SearchOptions) =>
    invoke<ReplaceResult>("replace_text", { query, replacement, options }),
  formatText: (path: string, content: string) =>
    invoke<{
      content: string;
      formatted: boolean;
      formatter: string;
      error: string | null;
    }>("format_text", { path, content }),
  watchWorkspace: (path: string) =>
    invoke<void>("watch_workspace", { path }),
  unwatchWorkspace: () => invoke<void>("unwatch_workspace"),
  /**
   * Compact "what is this project" snapshot: workspace name, top-level
   * listing (filtered by .gitignore + a small noise-dir denylist),
   * manifest highlights (package.json / Cargo.toml / pyproject.toml /
   * go.mod / Gemfile), first ~20 lines of README, and the git remote
   * if any. Capped at ~1.5 KB. Both chat and the agent inject this
   * into their prompts so the model knows what repo it's looking at
   * without needing to grep around first.
   */
  workspaceBrief: (root?: string) =>
    invoke<{ text: string; bytes: number; generated_at: number }>(
      "workspace_brief",
      { root },
    ),
  revealInFiler: (path: string) =>
    invoke<void>("reveal_in_filer", { path }),

  // Git — read-only status. Always returns a value; errors are encoded
  // inline so callers don't need to wrap every poll in try/catch.
  gitStatus: (workspace: string) =>
    invoke<GitStatus>("git_status_for_workspace", { workspace }),
  gitStage: (workspace: string, paths: string[]) =>
    invoke<string>("git_stage", { workspace, paths }),
  gitUnstage: (workspace: string, paths: string[]) =>
    invoke<string>("git_unstage", { workspace, paths }),
  gitDiscard: (workspace: string, paths: string[]) =>
    invoke<string>("git_discard", { workspace, paths }),
  gitCommit: (workspace: string, message: string) =>
    invoke<string>("git_commit", { workspace, message }),
  gitPush: (workspace: string) => invoke<string>("git_push", { workspace }),
  gitPull: (workspace: string) => invoke<string>("git_pull", { workspace }),
  gitFetch: (workspace: string) => invoke<string>("git_fetch", { workspace }),
  gitBranches: (workspace: string) =>
    invoke<GitBranch[]>("git_branches", { workspace }),
  gitCheckout: (workspace: string, branch: string) =>
    invoke<string>("git_checkout", { workspace, branch }),
  gitCreateBranch: (workspace: string, branch: string) =>
    invoke<string>("git_create_branch", { workspace, branch }),
  gitDiff: (workspace: string, path: string, staged: boolean) =>
    invoke<string>("git_diff", { workspace, path, staged }),
  /** Return the full contents of a path as it exists at HEAD or in the
   *  index. Empty string when the file didn't exist in that source —
   *  callers can render that as "all additions" without special-casing. */
  gitShowFile: (
    workspace: string,
    path: string,
    source: "head" | "staged",
  ) => invoke<string>("git_show_file", { workspace, path, source }),
  gitLog: (workspace: string, limit?: number) =>
    invoke<GitLogEntry[]>("git_log", { workspace, limit }),
  /** Per-line blame for the given path. Empty array means "no blame
   *  available" (untracked, brand-new file, etc.) — callers must
   *  treat that as a silent no-op rather than an error. */
  gitBlameFile: (workspace: string, path: string) =>
    invoke<GitBlameLine[]>("git_blame_file", { workspace, path }),

  // Integrated terminal. Output streams back on `terminal:data:<id>` and
  // exit on `terminal:exit:<id>` (subscribe via listenEvent in the UI).
  terminalOpen: (id: string, cwd: string | null, cols: number, rows: number) =>
    invoke<TerminalOpenResult>("terminal_open", { id, cwd, cols, rows }),
  terminalWrite: (id: string, data: string) =>
    invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),
  terminalClose: (id: string) => invoke<void>("terminal_close", { id }),

  // Ollama
  ollamaStatus: () => invoke<OllamaStatus>("ollama_status"),
  ollamaInstall: () => invoke<void>("ollama_install"),
  ollamaStart: () => invoke<void>("ollama_start"),
  ollamaStop: () => invoke<OllamaStopResult>("ollama_stop"),
  ollamaUnloadModel: (model: string) =>
    invoke<void>("ollama_unload_model", { model }),
  ollamaPs: () => invoke<LoadedModel[]>("ollama_ps"),
  ollamaDeleteModel: (model: string) =>
    invoke<void>("ollama_delete_model", { model }),
  ollamaUninstall: (purgeModels: boolean) =>
    invoke<UninstallReport>("ollama_uninstall", { purgeModels }),
  ollamaListModels: () => invoke<OllamaModel[]>("ollama_list_models"),
  ollamaPull: (model: string, requestId: string) =>
    invoke<void>("ollama_pull", { model, requestId }),
  ollamaChat: (
    requestId: string,
    request: {
      model: string;
      messages: { role: "system" | "user" | "assistant"; content: string }[];
      system?: string;
      temperature?: number;
      num_ctx?: number;
    },
  ) => invoke<void>("ollama_chat", { requestId, request }),
  ollamaGenerate: (
    requestId: string,
    request: {
      model: string;
      prompt: string;
      system?: string;
      stop?: string[];
      temperature?: number;
      num_predict?: number;
      raw?: boolean;
    },
  ) => invoke<void>("ollama_generate", { requestId, request }),
  ollamaFim: (
    requestId: string,
    request: {
      model: string;
      prefix: string;
      suffix: string;
      num_predict?: number;
      stop?: string[];
    },
  ) => invoke<string>("ollama_fim", { requestId, request }),
  ollamaEmbed: (model: string, input: string[]) =>
    invoke<number[][]>("ollama_embed", { model, input }),
  ollamaCancel: (requestId: string) =>
    invoke<boolean>("ollama_cancel", { requestId }),

  // Models / HF
  recommendModels: () => invoke<ModelRecommendation[]>("recommend_models"),
  systemMemoryGb: () => invoke<number>("system_memory_gb"),
  setHfToken: (token: string) =>
    invoke<HfTokenStatus>("set_hf_token", { token }),
  getHfToken: () => invoke<string | null>("get_hf_token"),
  hfTokenStatus: () => invoke<HfTokenStatus>("hf_token_status"),
  clearHfToken: () => invoke<void>("clear_hf_token"),
  hfSearchModels: (query: string, limit = 20) =>
    invoke<
      {
        id: string;
        downloads: number | null;
        likes: number | null;
        gated: boolean;
        tags: string[];
        pipeline_tag: string | null;
      }[]
    >("hf_search_models", { query, limit }),
  hfImportGguf: (
    requestId: string,
    request: { repo: string; file: string; local_name?: string },
  ) => invoke<string>("hf_import_gguf", { requestId, request }),

  // Context
  indexWorkspace: (request: { root: string; embed_model?: string }) =>
    invoke<void>("index_workspace", { request }),
  searchCodebase: (request: {
    query: string;
    limit?: number;
    embed_model?: string;
  }) => invoke<ScoredChunk[]>("search_codebase", { request }),
  chunkFile: (path: string) => invoke<Chunk[]>("chunk_file", { path }),
  indexStatus: () => invoke<IndexStatus>("index_status"),

  // Agent
  agentRun: (
    requestId: string,
    request: {
      model: string;
      goal: string;
      workspace?: string;
      max_steps?: number;
      max_runtime_secs?: number;
      context?: string;
      mode?: "plan" | "ask" | "auto";
      lint_command?: string;
      depth?: number;
      // Editor state — surfaced to the agent every turn via
      // <environment_details> so it stays grounded in what the user
      // is looking at without needing to ask.
      open_tabs?: string[];
      active_file?: string;
    },
  ) => invoke<void>("agent_run", { requestId, request }),
  /**
   * Continue an existing agent session with a follow-up user message.
   * Same shape as `agent_run` but takes the prior `transcript` and the
   * new `user_message`; the backend appends and resumes the loop
   * instead of building a fresh system+user_brief.
   */
  agentContinue: (
    requestId: string,
    request: {
      model: string;
      user_message: string;
      transcript: { role: string; content: string }[];
      workspace?: string;
      max_steps?: number;
      max_runtime_secs?: number;
      context?: string;
      mode?: "plan" | "ask" | "auto";
      lint_command?: string;
      open_tabs?: string[];
      active_file?: string;
      /**
       * Prior action ledger persisted by the assistant store. When
       * sent, the backend resumes the same factual record so the
       * smart pruner and fresh-read injector both see prior work
       * and don't re-explore. Optional for v0 callers; new callers
       * (unified Assistant) always pass it.
       */
      ledger?: LedgerEntry[];
    },
  ) => invoke<void>("agent_continue", { requestId, request }),
  /**
   * Preflight planner. Runs a quick, tool-free model call that
   * returns `{ steps, summary }` for the given goal so the UI can
   * pre-fill the Max-steps input with a model-suggested budget.
   */
  agentEstimate: (
    requestId: string,
    request: {
      model: string;
      goal: string;
      workspace?: string;
      mode?: "plan" | "ask" | "auto";
    },
  ) =>
    invoke<{ steps: number; summary: string }>(
      "agent_estimate",
      { requestId, request },
    ),
  agentCancel: (requestId: string) =>
    invoke<boolean>("agent_cancel", { requestId }),
  agentApprove: (requestId: string, note?: string) =>
    invoke<boolean>("agent_approve", { requestId, note }),
  agentReject: (requestId: string, note?: string) =>
    invoke<boolean>("agent_reject", { requestId, note }),
  /**
   * Resolve a paused `<budget_bump>` request. Sister to
   * `agent_approve` / `agent_reject` but with an optional `override`
   * value (when the user picks a different number than what the
   * model proposed).
   */
  agentBudgetDecision: (
    requestId: string,
    decision: { accept: boolean; override?: number },
  ) =>
    invoke<boolean>("agent_budget_decision", {
      requestId,
      accept: decision.accept,
      override: decision.override,
    }),

  // Agent change journal — keep/undo/diff for the mutating tool
  // calls the agent ran. The FE only ever passes around opaque
  // change_ids (UUIDs) it received via `tool_result.extra.change`;
  // the snapshot content lives in the backend's app_data dir.
  agentChangeDiff: (changeId: string) =>
    invoke<{ before: string; after: string; binary: boolean }>(
      "agent_change_diff",
      { changeId },
    ),
  agentUndoChange: (req: {
    changeId: string;
    workspace: string;
    kind: "create" | "modify" | "delete" | "rename";
    path: string;
    from?: string;
  }) =>
    invoke<void>("agent_undo_change", {
      // Backend expects a single `req` payload — keep this in sync
      // with the UndoChangeRequest deserializer in agent_changes.rs.
      req: {
        change_id: req.changeId,
        workspace: req.workspace,
        kind: req.kind,
        path: req.path,
        from: req.from,
      },
    }),
  agentKeepChange: (changeId: string) =>
    invoke<void>("agent_keep_change", { changeId }),
  agentPurgeChanges: (changeIds: string[]) =>
    invoke<void>("agent_purge_changes", { changeIds }),

  // Unified Assistant (Ask passthrough + Plan→Agent promotion).
  //
  // `assistantAsk` streams over the same `ollama:chat:<requestId>`
  // channel `ollamaChat` uses (no listener changes needed), and on
  // completion the BE fires one `assistant:ledger:<session_id>`
  // event so the store can append an `AnsweredOnly` entry.
  //
  // `agentExecutePlan` is the promotion path: it carries forward
  // the prior session's transcript + ledger so the new Agent run
  // doesn't re-explore the workspace the plan turn already
  // examined.
  assistantAsk: (
    requestId: string,
    request: {
      session_id: string;
      model: string;
      messages: { role: "system" | "user" | "assistant"; content: string }[];
      system?: string;
      system_extras?: string;
      temperature?: number;
      num_ctx?: number;
    },
  ) => invoke<void>("assistant_ask", { requestId, request }),
  agentExecutePlan: (
    requestId: string,
    request: {
      session_id: string;
      plan_text: string;
      model: string;
      workspace?: string;
      max_steps?: number;
      max_runtime_secs?: number;
      transcript?: { role: string; content: string }[];
      ledger?: LedgerEntry[];
    },
  ) => invoke<void>("agent_execute_plan", { requestId, request }),

  // System monitor
  systemSnapshot: () => invoke<SystemSnapshot>("system_snapshot"),
  killOwnedProcess: (pid: number) =>
    invoke<boolean>("kill_owned_process", { pid }),
  hardwareProfile: () => invoke<HardwareProfile>("hardware_profile"),

  // File ingestion
  classifyFile: (path: string) =>
    invoke<FileKindInfo>("classify_file", { path }),
  processFile: (args: {
    path: string;
    model?: string;
    instruction?: string;
  }) => invoke<ProcessFileResult>("process_file", { args }),

  // App state / factory reset
  resetAppState: (options?: ResetOptions) =>
    invoke<ResetReport>("reset_app_state", { options }),

  // MCP (Model Context Protocol)
  mcpLoadConfig: () => invoke<McpConfig>("mcp_load_config"),
  mcpSaveConfig: (config: McpConfig) =>
    invoke<McpConfig>("mcp_save_config", { config }),
  mcpUpsertServer: (name: string, config: McpServerConfig) =>
    invoke<McpConfig>("mcp_upsert_server", { request: { name, config } }),
  mcpRemoveServer: (name: string) =>
    invoke<McpConfig>("mcp_remove_server", { name }),
  mcpListServers: () => invoke<McpServerSnapshot[]>("mcp_list_servers"),
  mcpStartServer: (name: string) =>
    invoke<McpServerSnapshot>("mcp_start_server", { name }),
  mcpStopServer: (name: string) => invoke<void>("mcp_stop_server", { name }),
  mcpRestartServer: (name: string) =>
    invoke<McpServerSnapshot>("mcp_restart_server", { name }),
  mcpListTools: (name: string) =>
    invoke<McpTool[]>("mcp_list_tools", { name }),
  mcpCallTool: (server: string, tool: string, args: unknown) =>
    invoke<{ result: unknown }>("mcp_call_tool", {
      request: { server, tool, arguments: args },
    }),
  mcpGetLogs: (name: string) => invoke<string[]>("mcp_get_logs", { name }),

  // Fast Apply (speculative-edits scaffold)
  ollamaFastApply: (
    requestId: string,
    request: {
      model: string;
      path: string;
      original: string;
      instruction: string;
      system?: string;
    },
  ) =>
    invoke<{
      proposed: string;
      validated: boolean;
      elapsed_ms: number;
      chars_per_sec: number;
    }>("ollama_fast_apply", { requestId, request }),
};

export function newRequestId(prefix = "req"): string {
  return `${prefix}_${nanoid(10)}`;
}

export type ChatToken =
  | { token: string }
  | { done: true; stats?: unknown }
  | { cancelled: true; done: true }
  | { error: string; done: true };

export async function listenEvent<T>(
  event: string,
  cb: (payload: T) => void,
): Promise<UnlistenFn> {
  return await listen<T>(event, (e) => cb(e.payload));
}
