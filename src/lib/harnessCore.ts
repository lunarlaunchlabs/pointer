/**
 * Deterministic IDE-agent harness primitives.
 *
 * This is intentionally model-agnostic. Prompts may ask for good behavior,
 * but this module makes unsafe or low-evidence behavior impossible at the
 * runtime boundary: modes expose narrow tools, Agent mode has explicit phase
 * gates, transcripts are graded with a shared taxonomy, and harness changes
 * must carry an experiment card.
 */

export type HarnessMode =
  | "chat"
  | "ask"
  | "plan"
  | "agent"
  | "autocomplete"
  | "commit_message"
  | "verify"
  | "repair"
  | "review";

export type ToolName =
  | "list_tree"
  | "read_file"
  | "search_text"
  | "search_symbols"
  | "get_diagnostics"
  | "find_tests_for_file"
  | "apply_patch"
  | "write_file"
  | "delete_file"
  | "run_command"
  | "run_destructive_command"
  | "git_diff"
  | "git_status"
  | "commit"
  | "create_checkpoint"
  | "rollback";

export type AgentPhase =
  | "understand"
  | "localize"
  | "plan"
  | "checkpoint"
  | "patch"
  | "format"
  | "verify"
  | "critique"
  | "shrink_diff"
  | "final";

export type FailureTag =
  | "edited_too_early"
  | "did_not_read_relevant_file"
  | "ignored_test_failure"
  | "overbroad_patch"
  | "hallucinated_api"
  | "bad_plan"
  | "bad_tool_call"
  | "stale_context"
  | "failed_recovery"
  | "unnecessary_shell"
  | "insufficient_verification"
  | "autocomplete_too_long"
  | "autocomplete_hallucinated_symbol"
  | "commit_message_inaccurate"
  | "unsafe_command";

export const FailureTaxonomy: Record<FailureTag, { severity: "low" | "medium" | "high" | "critical"; description: string }> = {
  edited_too_early: {
    severity: "critical",
    description: "Agent attempted a mutation before producing an evidence packet.",
  },
  did_not_read_relevant_file: {
    severity: "high",
    description: "Answer or patch lacks reads for the files needed to justify it.",
  },
  ignored_test_failure: {
    severity: "critical",
    description: "Verification failed but the agent finalized or overclaimed success.",
  },
  overbroad_patch: {
    severity: "high",
    description: "Patch touches unrelated files or rewrites more than needed.",
  },
  hallucinated_api: {
    severity: "high",
    description: "Output references APIs, files, tests, or behavior not grounded in evidence.",
  },
  bad_plan: {
    severity: "medium",
    description: "Plan is vague, unverified, risky, or edits before inspection.",
  },
  bad_tool_call: {
    severity: "medium",
    description: "Tool call is malformed, unavailable in mode, or irrelevant.",
  },
  stale_context: {
    severity: "medium",
    description: "Agent acted on old context after files or diagnostics changed.",
  },
  failed_recovery: {
    severity: "high",
    description: "Agent failed to repair after a tool or verification failure.",
  },
  unnecessary_shell: {
    severity: "medium",
    description: "Agent used shell when a typed read/search tool was sufficient.",
  },
  insufficient_verification: {
    severity: "high",
    description: "Final result lacks the narrowest meaningful verification.",
  },
  autocomplete_too_long: {
    severity: "medium",
    description: "Inline completion is too broad for low-latency tab acceptance.",
  },
  autocomplete_hallucinated_symbol: {
    severity: "high",
    description: "Completion introduces a symbol not supported by local context.",
  },
  commit_message_inaccurate: {
    severity: "high",
    description: "Commit message mentions files or behavior not present in the diff.",
  },
  unsafe_command: {
    severity: "critical",
    description: "Agent attempted a destructive, privileged, exfiltrating, or deploy command.",
  },
};

export type PermissionDecision =
  | { allow: true }
  | { allow: false; reason: string; tag: FailureTag; requiresApproval?: boolean };

export type ToolCall = {
  tool: ToolName;
  args?: Record<string, unknown>;
};

export type EvidencePacket = {
  problem_summary: string;
  relevant_files: string[];
  root_cause_hypothesis: string;
  minimal_change_strategy: string;
  tests_or_checks_to_run: string[];
};

export type TranscriptEvent =
  | { kind: "mode"; mode: HarnessMode }
  | { kind: "phase"; phase: AgentPhase }
  | { kind: "tool"; mode: HarnessMode; tool: ToolName; args?: Record<string, unknown>; allowed: boolean; reason?: string }
  | { kind: "evidence"; packet: EvidencePacket }
  | { kind: "patch"; files: string[]; added: number; removed: number }
  | { kind: "verification"; command: string; passed: boolean; output?: string }
  | { kind: "judge"; index: number; dimension: JudgeDimension; vote: "Y" | "N" | "invalid"; raw: string }
  | { kind: "final"; text: string };

export type TranscriptRubric = {
  task_success: number;
  repo_understanding: number;
  tool_order: number;
  evidence_use: number;
  patch_minimality: number;
  verification_quality: number;
  safety: number;
  final_answer_quality: number;
  latency: number;
};

export type TranscriptGrade = {
  score: number;
  rubric: TranscriptRubric;
  failures: FailureTag[];
};

export const MODE_TOOLS: Record<HarnessMode, Set<ToolName>> = {
  chat: new Set([]),
  ask: new Set([
    "list_tree",
    "read_file",
    "search_text",
    "search_symbols",
    "get_diagnostics",
    "git_status",
  ]),
  plan: new Set([
    "list_tree",
    "read_file",
    "search_text",
    "search_symbols",
    "get_diagnostics",
    "find_tests_for_file",
    "git_status",
  ]),
  agent: new Set([
    "list_tree",
    "read_file",
    "search_text",
    "search_symbols",
    "get_diagnostics",
    "find_tests_for_file",
    "git_status",
    "apply_patch",
    "write_file",
    "run_command",
    "create_checkpoint",
    "rollback",
  ]),
  autocomplete: new Set([]),
  commit_message: new Set(["git_diff", "git_status", "read_file"]),
  verify: new Set(["run_command", "get_diagnostics", "git_status"]),
  repair: new Set([
    "read_file",
    "search_text",
    "get_diagnostics",
    "apply_patch",
    "run_command",
    "rollback",
  ]),
  review: new Set([
    "list_tree",
    "read_file",
    "search_text",
    "search_symbols",
    "get_diagnostics",
    "git_diff",
    "git_status",
  ]),
};

const MUTATING_TOOLS = new Set<ToolName>([
  "apply_patch",
  "write_file",
  "delete_file",
  "run_destructive_command",
  "commit",
]);

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bsudo\b/,
  /\bcurl\b.*\|\s*(?:sh|bash)\b/,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fd\b/,
  /\bnpm\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\byarn\s+publish\b/,
  /\bdeploy\b/,
  /\bdrop\s+database\b/i,
];

export class PermissionEngine {
  decide(mode: HarnessMode, call: ToolCall, state?: AgentOrchestratorState): PermissionDecision {
    if (!MODE_TOOLS[mode].has(call.tool)) {
      return {
        allow: false,
        reason: `${call.tool} is not available in ${mode} mode.`,
        tag: MUTATING_TOOLS.has(call.tool) ? "edited_too_early" : "bad_tool_call",
      };
    }
    if (call.tool === "run_command" || call.tool === "run_destructive_command") {
      const command = String(call.args?.command ?? "");
      if (isDangerousCommand(command) || call.tool === "run_destructive_command") {
        return {
          allow: false,
          reason: `Blocked dangerous command: ${command}`,
          tag: "unsafe_command",
          requiresApproval: true,
        };
      }
    }
    if (mode === "agent" && MUTATING_TOOLS.has(call.tool)) {
      if (!state?.evidencePacket) {
        return {
          allow: false,
          reason: "Agent mutations require an evidence packet first.",
          tag: "edited_too_early",
        };
      }
      if (!state.checkpointId) {
        return {
          allow: false,
          reason: "Agent mutations require a checkpoint first.",
          tag: "edited_too_early",
        };
      }
    }
    if (mode === "repair" && call.tool === "apply_patch") {
      const files = arrayArg(call.args?.files);
      const allowed = new Set(state?.touchedFiles ?? []);
      const outside = files.filter((file) => !allowed.has(file));
      if (outside.length > 0) {
        return {
          allow: false,
          reason: `Repair can only edit files touched in the current attempt: ${outside.join(", ")}`,
          tag: "overbroad_patch",
        };
      }
    }
    return { allow: true };
  }
}

export type AgentOrchestratorState = {
  mode: HarnessMode;
  phase: AgentPhase;
  evidencePacket: EvidencePacket | null;
  checkpointId: string | null;
  touchedFiles: string[];
  verification: Array<{ command: string; passed: boolean }>;
};

export class AgentOrchestrator {
  readonly permissionEngine: PermissionEngine;
  readonly recorder: TranscriptRecorder;
  state: AgentOrchestratorState = {
    mode: "agent",
    phase: "understand",
    evidencePacket: null,
    checkpointId: null,
    touchedFiles: [],
    verification: [],
  };

  constructor(permissionEngine = new PermissionEngine(), recorder = new TranscriptRecorder()) {
    this.permissionEngine = permissionEngine;
    this.recorder = recorder;
    this.recorder.record({ kind: "mode", mode: "agent" });
    this.recorder.record({ kind: "phase", phase: "understand" });
  }

  setEvidence(packet: EvidencePacket): void {
    validateEvidencePacket(packet);
    this.state.evidencePacket = packet;
    this.transition("checkpoint");
    this.recorder.record({ kind: "evidence", packet });
  }

  checkpoint(id: string): void {
    if (!this.state.evidencePacket) {
      throw new Error("Cannot checkpoint before evidence packet.");
    }
    this.state.checkpointId = id;
    this.transition("patch");
  }

  route(call: ToolCall): PermissionDecision {
    const decision = this.permissionEngine.decide(this.state.mode, call, this.state);
    this.recorder.record({
      kind: "tool",
      mode: this.state.mode,
      tool: call.tool,
      args: call.args,
      allowed: decision.allow,
      reason: decision.allow ? undefined : decision.reason,
    });
    if (decision.allow && call.tool === "apply_patch") {
      const files = arrayArg(call.args?.files);
      this.state.touchedFiles = [...new Set([...this.state.touchedFiles, ...files])];
      this.recorder.record({
        kind: "patch",
        files,
        added: Number(call.args?.added ?? 0),
        removed: Number(call.args?.removed ?? 0),
      });
      this.transition("format");
    }
    return decision;
  }

  recordVerification(command: string, passed: boolean, output?: string): void {
    this.state.verification.push({ command, passed });
    this.recorder.record({ kind: "verification", command, passed, output });
    this.transition(passed ? "critique" : "patch");
  }

  finalize(text: string): PermissionDecision {
    if (this.state.touchedFiles.length > 0 && this.state.verification.length === 0) {
      return {
        allow: false,
        reason: "Agent final summary requires verification after edits.",
        tag: "insufficient_verification",
      };
    }
    this.transition("final");
    this.recorder.record({ kind: "final", text });
    return { allow: true };
  }

  private transition(phase: AgentPhase): void {
    this.state.phase = phase;
    this.recorder.record({ kind: "phase", phase });
  }
}

export class ToolRouter {
  constructor(private readonly permissionEngine = new PermissionEngine()) {}

  canRoute(mode: HarnessMode, call: ToolCall, state?: AgentOrchestratorState): PermissionDecision {
    return this.permissionEngine.decide(mode, call, state);
  }
}

export class ContextBuilder {
  buildEvidencePacket(input: EvidencePacket): EvidencePacket {
    validateEvidencePacket(input);
    return {
      ...input,
      relevant_files: [...new Set(input.relevant_files)],
      tests_or_checks_to_run: [...new Set(input.tests_or_checks_to_run)],
    };
  }
}

export class PatchManager {
  private nextId = 1;
  private checkpoints = new Map<string, Map<string, string>>();

  createCheckpoint(files: Record<string, string>): string {
    const id = `checkpoint-${this.nextId++}`;
    this.checkpoints.set(id, new Map(Object.entries(files)));
    return id;
  }

  rollback(id: string): Record<string, string> {
    const snapshot = this.checkpoints.get(id);
    if (!snapshot) throw new Error(`Unknown checkpoint: ${id}`);
    return Object.fromEntries(snapshot.entries());
  }
}

export class Verifier {
  ladderFor(stack: "rust" | "typescript" | "tauri" | "generic"): string[] {
    if (stack === "rust") {
      return ["cargo fmt --check", "cargo check", "cargo clippy -- -D warnings", "cargo test"];
    }
    if (stack === "typescript") {
      return ["pnpm typecheck", "pnpm lint", "pnpm test --run", "pnpm build"];
    }
    if (stack === "tauri") {
      return ["cargo check", "pnpm typecheck", "pnpm build", "cargo tauri build --debug"];
    }
    return ["syntax", "formatter", "typecheck", "unit tests", "broader tests"];
  }
}

export type CriticVerdict = {
  verdict: "PASS" | "BLOCK" | "NEEDS_REPAIR";
  reasons: string[];
  required_repairs: string[];
  regression_risks: string[];
};

export class Critic {
  review(events: TranscriptEvent[]): CriticVerdict {
    const grade = new TranscriptGrader().grade(events);
    const critical = grade.failures.filter((tag) => FailureTaxonomy[tag].severity === "critical");
    if (critical.length > 0) {
      return {
        verdict: "BLOCK",
        reasons: critical.map((tag) => FailureTaxonomy[tag].description),
        required_repairs: critical.map((tag) => `Repair ${tag}`),
        regression_risks: grade.failures,
      };
    }
    if (grade.failures.length > 0) {
      return {
        verdict: "NEEDS_REPAIR",
        reasons: grade.failures.map((tag) => FailureTaxonomy[tag].description),
        required_repairs: grade.failures.map((tag) => `Address ${tag}`),
        regression_risks: grade.failures,
      };
    }
    return { verdict: "PASS", reasons: [], required_repairs: [], regression_risks: [] };
  }
}

export type JudgeInput = {
  initialPrompt: string;
  producedOutput: string;
  foundImportantBecause: string;
  taskClass?: "research" | "scout" | "plan" | "agent" | "commit" | "review" | string;
  dueDiligenceTrace?: string[] | string;
  successCriteria?: string[];
  diligenceCriteria?: string[];
};

export type JudgeDimension = "outcome" | "diligence";

export type JudgeVote = {
  index: number;
  dimension: JudgeDimension;
  raw: string;
  vote: "Y" | "N" | "invalid";
  attempts: string[];
};

export type JudgeVerdict = {
  verdict: "PASS" | "BLOCK";
  requiredYes: number;
  totalVotes: number;
  yes: number;
  no: number;
  invalid: number;
  votes: JudgeVote[];
};

export type AgentPromptFrame = {
  prompt: string;
  label?: string;
  clearsContext?: boolean;
};

export type JudgedStageInput = JudgeInput & {
  stage: string;
  attempt?: number;
  maxAttempts?: number;
  promptStack?: AgentPromptFrame[];
  failedPromptIndex?: number;
  promptAttempt?: number;
  maxAttemptsPerPrompt?: number;
};

export type JudgedStageResult =
  | { status: "complete"; stage: string; verdict: JudgeVerdict }
  | {
      status: "retry";
      stage: string;
      verdict: JudgeVerdict;
      nextAttempt: number;
      retryPrompt: string;
      retryPromptIndex: number;
      clearContext: boolean;
      backtracked: boolean;
    }
  | { status: "blocked"; stage: string; verdict: JudgeVerdict; reason: string };

export type JudgeCall = (
  prompt: string,
  index: number,
  dimension: JudgeDimension,
) => Promise<string> | string;

export class Judge {
  constructor(
    private readonly calls = 3,
    private readonly requiredYes = Math.ceil(calls * 2 * (2 / 3)),
    private readonly recorder?: TranscriptRecorder,
    private readonly maxInvalidRetries = 2,
  ) {}

  buildPrompt(input: JudgeInput, index: number, dimension: JudgeDimension): string {
    const criteria =
      dimension === "outcome"
        ? formatCriteria(
            input.successCriteria,
            [
              "The output answers the initial prompt.",
              "The output is grounded in the supplied findings.",
              "The output does not overclaim or invent facts.",
            ],
          )
        : formatCriteria(
            input.diligenceCriteria,
            [
              "The agent inspected enough relevant context for the task class.",
              "The path taken could reasonably support the produced output.",
              "The agent did not skip obvious files, diagnostics, tests, or search steps.",
            ],
          );
    const evidenceBlock =
      dimension === "outcome"
        ? ["What the agent found and why it thinks it matters:", input.foundImportantBecause.trim()]
        : [
            "Agent path taken before the output:",
            formatDiligenceTrace(input.dueDiligenceTrace),
          ];
    return [
      `You are Judge ${index + 1} of ${this.calls}.`,
      `Task class: ${input.taskClass ?? "general"}.`,
      `Vote type: ${dimension}.`,
      "Respond with exactly one character: Y or N.",
      dimension === "outcome"
        ? "Y means the produced output fully satisfies the initial prompt using only the supplied findings."
        : "Y means the agent path shows enough due diligence for the task before producing the output.",
      "N means anything is missing, unsupported, vague, unsafe, unverified, under-inspected, or overclaimed.",
      "Do not explain. Do not add punctuation. Do not output any other text.",
      "",
      "Initial prompt:",
      input.initialPrompt.trim(),
      "",
      ...evidenceBlock,
      "",
      "Produced output to judge:",
      input.producedOutput.trim(),
      "",
      "Success criteria:",
      criteria,
    ].join("\n");
  }

  async run(input: JudgeInput, call: JudgeCall): Promise<JudgeVerdict> {
    const votes: JudgeVote[] = [];
    for (let index = 0; index < this.calls; index += 1) {
      for (const dimension of ["outcome", "diligence"] as const) {
        const attempts: string[] = [];
        let raw = "";
        let vote: JudgeVote["vote"] = "invalid";
        for (let attempt = 0; attempt <= this.maxInvalidRetries; attempt += 1) {
          const prompt =
            attempt === 0
              ? this.buildPrompt(input, index, dimension)
              : this.buildRetryPrompt(input, index, dimension, attempts.at(-1) ?? "");
          raw = String(await call(prompt, index, dimension)).trim();
          attempts.push(raw);
          vote = parseJudgeVote(raw);
          if (vote !== "invalid") break;
        }
        const item: JudgeVote = { index, dimension, raw, vote, attempts };
        votes.push(item);
        this.recorder?.record({ kind: "judge", index, dimension, vote, raw });
      }
    }
    const yes = votes.filter((vote) => vote.vote === "Y").length;
    const no = votes.filter((vote) => vote.vote === "N").length;
    const invalid = votes.filter((vote) => vote.vote === "invalid").length;
    return {
      verdict: yes >= this.requiredYes && invalid === 0 ? "PASS" : "BLOCK",
      requiredYes: this.requiredYes,
      totalVotes: votes.length,
      yes,
      no,
      invalid,
      votes,
    };
  }

  private buildRetryPrompt(
    input: JudgeInput,
    index: number,
    dimension: JudgeDimension,
    invalidOutput: string,
  ): string {
    return [
      this.buildPrompt(input, index, dimension),
      "",
      "Your previous response was invalid:",
      invalidOutput,
      "",
      "Retry now. Output exactly one character: Y or N.",
    ].join("\n");
  }
}

export class StageJudge {
  constructor(private readonly judge = new Judge()) {}

  async evaluate(input: JudgedStageInput, call: JudgeCall): Promise<JudgedStageResult> {
    const current = currentPromptFrame(input);
    const attempt = input.promptAttempt ?? input.attempt ?? 1;
    const maxAttempts = input.maxAttemptsPerPrompt ?? input.maxAttempts ?? 3;
    const verdict = await this.judge.run(
      {
        ...input,
        initialPrompt: [
          `Scheduled stage: ${input.stage}`,
          `Attempt: ${attempt} of ${maxAttempts}`,
          current.label ? `Agent prompt: ${current.label}` : "Agent prompt:",
          "",
          current.prompt,
        ].join("\n"),
      },
      call,
    );
    if (verdict.verdict === "PASS") {
      return { status: "complete", stage: input.stage, verdict };
    }
    const replay = nextPromptReplay(input, attempt, maxAttempts);
    if (replay) {
      return {
        status: "retry",
        stage: input.stage,
        verdict,
        nextAttempt: replay.nextAttempt,
        retryPrompt: replay.frame.prompt,
        retryPromptIndex: replay.index,
        clearContext: Boolean(replay.frame.clearsContext),
        backtracked: replay.backtracked,
      };
    }
    return {
      status: "blocked",
      stage: input.stage,
      verdict,
      reason: `Stage ${input.stage} failed judge validation after exhausting its prompt stack.`,
    };
  }
}

function currentPromptFrame(input: JudgedStageInput): AgentPromptFrame {
  const stack = normalizedPromptStack(input);
  const index = currentPromptIndex(input, stack);
  return stack[index];
}

function nextPromptReplay(
  input: JudgedStageInput,
  attempt: number,
  maxAttempts: number,
): { frame: AgentPromptFrame; index: number; nextAttempt: number; backtracked: boolean } | null {
  const stack = normalizedPromptStack(input);
  const index = currentPromptIndex(input, stack);
  if (attempt < maxAttempts) {
    return { frame: stack[index], index, nextAttempt: attempt + 1, backtracked: false };
  }
  const previousIndex = index - 1;
  if (previousIndex >= 0) {
    return { frame: stack[previousIndex], index: previousIndex, nextAttempt: 1, backtracked: true };
  }
  return null;
}

function normalizedPromptStack(input: JudgedStageInput): AgentPromptFrame[] {
  const stack = (input.promptStack ?? []).filter((frame) => frame.prompt.trim());
  if (stack.length > 0) return stack;
  return [{ prompt: input.initialPrompt }];
}

function currentPromptIndex(input: JudgedStageInput, stack: AgentPromptFrame[]): number {
  const requested = input.failedPromptIndex ?? stack.length - 1;
  return Math.max(0, Math.min(requested, stack.length - 1));
}

export type AgentArchetype =
  | "cartographer"
  | "scout"
  | "scout_troop_leader"
  | "researcher"
  | "evidence_collector"
  | "summarizer"
  | "consolidator"
  | "evaluator"
  | "splitter"
  | "normalizer"
  | "red_team"
  | "action_proposer"
  | "action_taker"
  | "judge"
  | "critic"
  | "verifier"
  | "drafter"
  | "memory_curator";

export type AgentActionMode = "none" | "propose" | "take";

export type HarnessMemoryKind =
  | "prompt"
  | "proposal"
  | "judge_verdict"
  | "tool_result"
  | "directory_listing"
  | "file_metadata"
  | "file_content"
  | "diff_chunk"
  | "chunk_summary"
  | "file_summary"
  | "decision"
  | "action_plan"
  | "draft"
  | "verification"
  | "final";

export type HarnessMemoryStatus = "pending" | "approved" | "rejected" | "superseded";

export type HarnessMemorySource = {
  tool?: ToolName;
  path?: string;
  range?: string;
  promptId?: string;
};

export type HarnessMemory<T = unknown> = {
  id: string;
  laneId: string;
  stage: string;
  kind: HarnessMemoryKind;
  archetype: AgentArchetype;
  content: T;
  summary?: string;
  tags: string[];
  parentIds: string[];
  status: HarnessMemoryStatus;
  confidence?: number;
  createdAt: number;
  source?: HarnessMemorySource;
};

export type MemoryLane = {
  id: string;
  label: string;
  parentId?: string;
  createdAt: number;
};

export type MemoryWrite<T = unknown> = {
  laneId?: string;
  stage: string;
  kind: HarnessMemoryKind;
  archetype: AgentArchetype;
  content: T;
  summary?: string;
  tags?: string[];
  parentIds?: string[];
  status?: HarnessMemoryStatus;
  confidence?: number;
  source?: HarnessMemorySource;
};

export class MemoryGraph {
  private nextMemoryId = 1;
  private nextLaneId = 1;
  private memories = new Map<string, HarnessMemory>();
  private lanes = new Map<string, MemoryLane>();

  constructor(baseLaneId = "main", label = "Main") {
    this.lanes.set(baseLaneId, { id: baseLaneId, label, createdAt: Date.now() });
  }

  forkLane(label: string, parentId = "main"): string {
    if (!this.lanes.has(parentId)) throw new Error(`Unknown parent lane: ${parentId}`);
    const id = `lane-${this.nextLaneId++}`;
    this.lanes.set(id, { id, label, parentId, createdAt: Date.now() });
    return id;
  }

  add<T>(write: MemoryWrite<T>): HarnessMemory<T> {
    const laneId = write.laneId ?? "main";
    if (!this.lanes.has(laneId)) throw new Error(`Unknown memory lane: ${laneId}`);
    const memory: HarnessMemory<T> = {
      id: `memory-${this.nextMemoryId++}`,
      laneId,
      stage: write.stage,
      kind: write.kind,
      archetype: write.archetype,
      content: write.content,
      summary: write.summary,
      tags: [...new Set(write.tags ?? [])],
      parentIds: [...new Set(write.parentIds ?? [])],
      status: write.status ?? "pending",
      confidence: write.confidence,
      createdAt: Date.now(),
      source: write.source,
    };
    this.memories.set(memory.id, memory);
    return memory;
  }

  get<T = unknown>(id: string): HarnessMemory<T> | undefined {
    return this.memories.get(id) as HarnessMemory<T> | undefined;
  }

  getLane(id: string): MemoryLane | undefined {
    const lane = this.lanes.get(id);
    return lane ? { ...lane } : undefined;
  }

  snapshot(): { lanes: MemoryLane[]; memories: HarnessMemory[] } {
    return {
      lanes: [...this.lanes.values()].map((lane) => ({ ...lane })),
      memories: [...this.memories.values()]
        .map((memory) => ({ ...memory, tags: [...memory.tags], parentIds: [...memory.parentIds] }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    };
  }

  byLane(laneId: string, options?: { approvedOnly?: boolean }): HarnessMemory[] {
    return [...this.memories.values()]
      .filter((memory) => memory.laneId === laneId)
      .filter((memory) => !options?.approvedOnly || memory.status === "approved")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  byKind(kind: HarnessMemoryKind, options?: { laneId?: string; approvedOnly?: boolean }): HarnessMemory[] {
    return [...this.memories.values()]
      .filter((memory) => memory.kind === kind)
      .filter((memory) => !options?.laneId || memory.laneId === options.laneId)
      .filter((memory) => !options?.approvedOnly || memory.status === "approved")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  childrenOf(parentId: string): HarnessMemory[] {
    return [...this.memories.values()].filter((memory) => memory.parentIds.includes(parentId));
  }

  lineage(id: string): HarnessMemory[] {
    const seen = new Set<string>();
    const out: HarnessMemory[] = [];
    const visit = (memoryId: string) => {
      if (seen.has(memoryId)) return;
      seen.add(memoryId);
      const memory = this.memories.get(memoryId);
      if (!memory) return;
      for (const parent of memory.parentIds) visit(parent);
      out.push(memory);
    };
    visit(id);
    return out;
  }

  setStatus(id: string, status: HarnessMemoryStatus): HarnessMemory {
    const memory = this.memories.get(id);
    if (!memory) throw new Error(`Unknown memory: ${id}`);
    const updated = { ...memory, status };
    this.memories.set(id, updated);
    return updated;
  }

  materializeContext(options: {
    laneId?: string;
    kinds?: HarnessMemoryKind[];
    tags?: string[];
    approvedOnly?: boolean;
    limit?: number;
  } = {}): HarnessMemory[] {
    const kindSet = options.kinds ? new Set(options.kinds) : null;
    const tagSet = options.tags ? new Set(options.tags) : null;
    return [...this.memories.values()]
      .filter((memory) => !options.laneId || memory.laneId === options.laneId)
      .filter((memory) => !kindSet || kindSet.has(memory.kind))
      .filter((memory) => !tagSet || memory.tags.some((tag) => tagSet.has(tag)))
      .filter((memory) => !options.approvedOnly || memory.status === "approved")
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
      .reverse();
  }
}

export type AgentArchetypeDefinition = {
  archetype: AgentArchetype;
  actionMode: AgentActionMode;
  purpose: string;
  outputs: HarnessMemoryKind[];
  requiresJudgeBeforeUse: boolean;
};

export const AGENT_ARCHETYPES: Record<AgentArchetype, AgentArchetypeDefinition> = {
  cartographer: {
    archetype: "cartographer",
    actionMode: "none",
    purpose: "Map visible workspace structure into durable, queryable memory.",
    outputs: ["prompt", "directory_listing", "file_metadata"],
    requiresJudgeBeforeUse: false,
  },
  scout: {
    archetype: "scout",
    actionMode: "propose",
    purpose: "Propose where to look next from the prompt and available structure.",
    outputs: ["proposal"],
    requiresJudgeBeforeUse: true,
  },
  scout_troop_leader: {
    archetype: "scout_troop_leader",
    actionMode: "propose",
    purpose: "Select which proposed files deserve collection after deterministic listing.",
    outputs: ["decision"],
    requiresJudgeBeforeUse: true,
  },
  researcher: {
    archetype: "researcher",
    actionMode: "none",
    purpose: "Read approved context and extract grounded observations.",
    outputs: ["tool_result", "file_metadata", "file_content"],
    requiresJudgeBeforeUse: false,
  },
  evidence_collector: {
    archetype: "evidence_collector",
    actionMode: "none",
    purpose: "Run deterministic read-only collection after proposals are approved.",
    outputs: ["tool_result", "file_metadata", "file_content", "diff_chunk"],
    requiresJudgeBeforeUse: false,
  },
  summarizer: {
    archetype: "summarizer",
    actionMode: "none",
    purpose: "Compress one bounded context chunk into durable memory.",
    outputs: ["chunk_summary", "file_summary"],
    requiresJudgeBeforeUse: true,
  },
  consolidator: {
    archetype: "consolidator",
    actionMode: "none",
    purpose: "Merge approved memories without introducing new facts.",
    outputs: ["file_summary", "decision"],
    requiresJudgeBeforeUse: true,
  },
  evaluator: {
    archetype: "evaluator",
    actionMode: "propose",
    purpose: "Decide whether approved memory is sufficient for the user's goal.",
    outputs: ["decision"],
    requiresJudgeBeforeUse: true,
  },
  splitter: {
    archetype: "splitter",
    actionMode: "propose",
    purpose: "Detect mixed work and propose safe split boundaries.",
    outputs: ["action_plan", "decision"],
    requiresJudgeBeforeUse: true,
  },
  normalizer: {
    archetype: "normalizer",
    actionMode: "none",
    purpose: "Clean and bound generated text without adding facts.",
    outputs: ["draft", "final"],
    requiresJudgeBeforeUse: false,
  },
  red_team: {
    archetype: "red_team",
    actionMode: "none",
    purpose: "Attack drafts for hallucination, low-value wording, and unsupported claims.",
    outputs: ["decision", "judge_verdict"],
    requiresJudgeBeforeUse: false,
  },
  action_proposer: {
    archetype: "action_proposer",
    actionMode: "propose",
    purpose: "Propose a bounded mutation or command for an action taker.",
    outputs: ["action_plan"],
    requiresJudgeBeforeUse: true,
  },
  action_taker: {
    archetype: "action_taker",
    actionMode: "take",
    purpose: "Perform an approved action through narrow typed tools.",
    outputs: ["tool_result", "verification"],
    requiresJudgeBeforeUse: false,
  },
  judge: {
    archetype: "judge",
    actionMode: "none",
    purpose: "Vote on whether a proposed output or decision is valid.",
    outputs: ["judge_verdict"],
    requiresJudgeBeforeUse: false,
  },
  critic: {
    archetype: "critic",
    actionMode: "none",
    purpose: "Review completed work for regressions, overclaims, and missing checks.",
    outputs: ["decision"],
    requiresJudgeBeforeUse: false,
  },
  verifier: {
    archetype: "verifier",
    actionMode: "none",
    purpose: "Run or inspect verification evidence without editing.",
    outputs: ["verification"],
    requiresJudgeBeforeUse: false,
  },
  drafter: {
    archetype: "drafter",
    actionMode: "none",
    purpose: "Produce final user-facing text from approved memory only.",
    outputs: ["draft", "final"],
    requiresJudgeBeforeUse: true,
  },
  memory_curator: {
    archetype: "memory_curator",
    actionMode: "none",
    purpose: "Promote, reject, supersede, and retrieve durable memories.",
    outputs: ["decision"],
    requiresJudgeBeforeUse: false,
  },
};

export type JudgeGatePolicy =
  | { kind: "none" }
  | { kind: "stage"; requiredYes?: number; judges?: number }
  | { kind: "item"; requiredYes?: number; judges?: number };

export type HarnessLayerSpec = {
  id: string;
  name: string;
  archetype: AgentArchetype;
  actionMode: AgentActionMode;
  inputKinds: HarnessMemoryKind[];
  outputKinds: HarnessMemoryKind[];
  allowedTools: ToolName[];
  judge: JudgeGatePolicy;
  writesApprovedMemory: boolean;
};

export class HarnessBlueprint {
  constructor(
    readonly id: string,
    readonly mode: HarnessMode,
    readonly layers: HarnessLayerSpec[],
  ) {}

  validate(): string[] {
    const issues: string[] = [];
    for (const layer of this.layers) {
      const archetype = AGENT_ARCHETYPES[layer.archetype];
      if (archetype.actionMode !== layer.actionMode) {
        issues.push(`${layer.id} action mode does not match ${layer.archetype}.`);
      }
      if (
        layer.actionMode === "propose" &&
        archetype.requiresJudgeBeforeUse &&
        layer.judge.kind === "none"
      ) {
        issues.push(`${layer.id} proposes memory without a judge gate.`);
      }
      if (layer.actionMode === "take" && this.mode !== "agent" && this.mode !== "repair") {
        issues.push(`${layer.id} takes actions in ${this.mode} mode.`);
      }
      for (const tool of layer.allowedTools) {
        if (!MODE_TOOLS[this.mode].has(tool)) {
          issues.push(`${layer.id} uses ${tool}, unavailable in ${this.mode} mode.`);
        }
      }
    }
    return issues;
  }

  actionTakerLayers(): HarnessLayerSpec[] {
    return this.layers.filter((layer) => layer.actionMode === "take");
  }
}

export type CouncilItem<T> = {
  id: string;
  label: string;
  value: T;
};

export type CouncilVote = {
  judgeIndex: number;
  raw: string;
  vote: "Y" | "N" | "invalid";
};

export type CouncilItemVerdict<T> = {
  item: CouncilItem<T>;
  approved: boolean;
  requiredYes: number;
  yes: number;
  no: number;
  invalid: number;
  votes: CouncilVote[];
};

export type CouncilResult<T> = {
  approved: CouncilItemVerdict<T>[];
  rejected: CouncilItemVerdict<T>[];
  all: CouncilItemVerdict<T>[];
};

export type CouncilJudgeCall<T> = (
  prompt: string,
  judgeIndex: number,
  item: CouncilItem<T>,
) => Promise<string> | string;

export class JudgeCouncil {
  constructor(
    private readonly judges = 3,
    private readonly requiredYes = Math.ceil(judges * (2 / 3)),
    private readonly recorder?: TranscriptRecorder,
  ) {}

  async evaluateItems<T>(
    items: CouncilItem<T>[],
    buildPrompt: (item: CouncilItem<T>) => string,
    call: CouncilJudgeCall<T>,
  ): Promise<CouncilResult<T>> {
    const all: CouncilItemVerdict<T>[] = [];
    for (const item of items) {
      const votes: CouncilVote[] = [];
      for (let judgeIndex = 0; judgeIndex < this.judges; judgeIndex += 1) {
        const prompt = [
          `You are judge ${judgeIndex + 1} of ${this.judges}.`,
          "Vote on this single proposed item. Respond with exactly one character: Y or N.",
          "",
          buildPrompt(item),
        ].join("\n");
        const raw = String(await call(prompt, judgeIndex, item)).trim();
        const vote = parseJudgeVote(raw);
        votes.push({ judgeIndex, raw, vote });
        this.recorder?.record({ kind: "judge", index: judgeIndex, dimension: "outcome", vote, raw });
      }
      const yes = votes.filter((vote) => vote.vote === "Y").length;
      const no = votes.filter((vote) => vote.vote === "N").length;
      const invalid = votes.filter((vote) => vote.vote === "invalid").length;
      all.push({
        item,
        approved: yes >= this.requiredYes && invalid === 0,
        requiredYes: this.requiredYes,
        yes,
        no,
        invalid,
        votes,
      });
    }
    return {
      approved: all.filter((verdict) => verdict.approved),
      rejected: all.filter((verdict) => !verdict.approved),
      all,
    };
  }
}

export class LayeredHarness {
  constructor(
    readonly blueprint: HarnessBlueprint,
    readonly memory = new MemoryGraph(),
  ) {}

  validate(): string[] {
    return this.blueprint.validate();
  }

  remember<T>(write: MemoryWrite<T>): HarnessMemory<T> {
    return this.memory.add(write);
  }

  contextFor(layerId: string): HarnessMemory[] {
    const layer = this.blueprint.layers.find((candidate) => candidate.id === layerId);
    if (!layer) throw new Error(`Unknown layer: ${layerId}`);
    return this.memory.materializeContext({
      kinds: layer.inputKinds,
      approvedOnly: true,
    });
  }
}

function formatCriteria(items: string[] | undefined, fallback: string[]): string {
  return (items && items.length > 0 ? items : fallback)
    .map((item) => `- ${item}`)
    .join("\n");
}

function formatDiligenceTrace(trace: JudgeInput["dueDiligenceTrace"]): string {
  if (Array.isArray(trace) && trace.length > 0) {
    return trace.map((item) => `- ${item}`).join("\n");
  }
  if (typeof trace === "string" && trace.trim()) return trace.trim();
  return "- No trace supplied.";
}

export class TranscriptRecorder {
  private events: TranscriptEvent[] = [];

  record(event: TranscriptEvent): void {
    this.events.push(event);
  }

  snapshot(): TranscriptEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

function parseJudgeVote(raw: string): JudgeVote["vote"] {
  const normalized = raw.trim().toUpperCase();
  if (normalized === "Y") return "Y";
  if (normalized === "N") return "N";
  return "invalid";
}

export class TranscriptGrader {
  grade(events: TranscriptEvent[]): TranscriptGrade {
    const failures = new Set<FailureTag>();
    const denied = events.filter(
      (event): event is Extract<TranscriptEvent, { kind: "tool" }> =>
        event.kind === "tool" && !event.allowed,
    );
    for (const event of denied) {
      if (event.reason?.includes("dangerous")) failures.add("unsafe_command");
      else if (MUTATING_TOOLS.has(event.tool)) failures.add("edited_too_early");
      else failures.add("bad_tool_call");
    }
    const patchIndex = events.findIndex((event) => event.kind === "patch");
    const evidenceIndex = events.findIndex((event) => event.kind === "evidence");
    if (patchIndex >= 0 && (evidenceIndex < 0 || evidenceIndex > patchIndex)) {
      failures.add("edited_too_early");
    }
    const patches = events.filter((event) => event.kind === "patch");
    const verifications = events.filter((event) => event.kind === "verification");
    if (patches.length > 0 && verifications.length === 0) {
      failures.add("insufficient_verification");
    }
    if (verifications.some((event) => !event.passed)) {
      let lastFailed = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        const candidate = events[i];
        if (candidate.kind === "verification" && !candidate.passed) {
          lastFailed = i;
          break;
        }
      }
      const finalAfterFailure = events.some((event, index) => {
        return event.kind === "final" && index > lastFailed;
      });
      if (finalAfterFailure) failures.add("ignored_test_failure");
    }
    if (patches.some((event) => event.files.length > 6 || event.added + event.removed > 800)) {
      failures.add("overbroad_patch");
    }

    const rubric: TranscriptRubric = {
      task_success: failures.size === 0 ? 1 : 0,
      repo_understanding: evidenceIndex >= 0 ? 1 : 0.4,
      tool_order: failures.has("edited_too_early") ? 0 : 1,
      evidence_use: evidenceIndex >= 0 ? 1 : 0,
      patch_minimality: failures.has("overbroad_patch") ? 0 : 1,
      verification_quality: verifications.some((event) => event.passed) ? 1 : patches.length ? 0 : 0.7,
      safety: failures.has("unsafe_command") ? 0 : 1,
      final_answer_quality: events.some((event) => event.kind === "final") ? 1 : 0.5,
      latency: 1,
    };
    const score = Object.values(rubric).reduce((sum, value) => sum + value, 0) / 9;
    return { score, rubric, failures: [...failures] };
  }
}

export type Scenario = {
  id: string;
  mode: HarnessMode;
  prompt: string;
  expectedFailures?: FailureTag[];
};

export class ScenarioRunner {
  constructor(
    private readonly grader = new TranscriptGrader(),
    private readonly stageJudge = new StageJudge(),
  ) {}

  run(events: TranscriptEvent[]): TranscriptGrade {
    return this.grader.grade(events);
  }

  async runScheduledStages(
    stages: JudgedStageInput[],
    call: JudgeCall,
  ): Promise<JudgedStageResult[]> {
    const results: JudgedStageResult[] = [];
    for (const stage of stages) {
      const result = await this.stageJudge.evaluate(stage, call);
      results.push(result);
      if (result.status !== "complete") break;
    }
    return results;
  }
}

export class RepoCurator {
  rank(repos: Array<{ path: string; setupMinutes: number; frameworks: string[]; stableTests: boolean }>): string[] {
    return [...repos]
      .sort((a, b) => {
        const aScore = a.frameworks.length * 3 + (a.stableTests ? 3 : 0) - a.setupMinutes;
        const bScore = b.frameworks.length * 3 + (b.stableTests ? 3 : 0) - b.setupMinutes;
        return bScore - aScore;
      })
      .map((repo) => repo.path);
  }
}

export class TaskGenerator {
  askTasks(): string[] {
    return [
      "Where is authentication enforced?",
      "What files control this route?",
      "Which component owns this state?",
      "What tests cover this behavior?",
    ];
  }

  mutationTasks(): string[] {
    return [
      "invert boolean",
      "rename API field on one side only",
      "remove await",
      "break route path",
      "delete import",
      "weaken validation",
      "introduce off-by-one",
    ];
  }
}

export type ExperimentCard = {
  hypothesis: string;
  observed_failures: FailureTag[];
  proposed_change: string;
  expected_improvement: string[];
  risk: string;
  evals_to_run: string[];
  acceptance_criteria: string[];
};

export class RegressionRunner {
  acceptExperiment(card: ExperimentCard, before: TranscriptGrade, after: TranscriptGrade): boolean {
    if (!validateExperimentCard(card)) return false;
    const criticalRegression = after.failures.some(
      (tag) => FailureTaxonomy[tag].severity === "critical" && !before.failures.includes(tag),
    );
    return after.score > before.score && !criticalRegression;
  }
}

export function validateExperimentCard(card: ExperimentCard): boolean {
  return Boolean(
    card.hypothesis.trim() &&
      card.proposed_change.trim() &&
      card.observed_failures.length > 0 &&
      card.expected_improvement.length > 0 &&
      card.evals_to_run.length > 0 &&
      card.acceptance_criteria.length > 0,
  );
}

function validateEvidencePacket(packet: EvidencePacket): void {
  if (!packet.problem_summary.trim()) throw new Error("Evidence packet missing problem summary.");
  if (packet.relevant_files.length === 0) throw new Error("Evidence packet needs relevant files.");
  if (!packet.root_cause_hypothesis.trim()) {
    throw new Error("Evidence packet missing root cause hypothesis.");
  }
  if (!packet.minimal_change_strategy.trim()) {
    throw new Error("Evidence packet missing minimal change strategy.");
  }
  if (packet.tests_or_checks_to_run.length === 0) {
    throw new Error("Evidence packet needs tests or checks.");
  }
}

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function arrayArg(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
