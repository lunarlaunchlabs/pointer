import { describe, expect, it } from "vitest";
import {
  AgentOrchestrator,
  Critic,
  DecisionCouncilRuntime,
  FailureTaxonomy,
  HarnessBlueprint,
  Judge,
  JudgeCouncil,
  MemoryGraph,
  StrictLayerRuntime,
  PermissionEngine,
  RegressionRunner,
  ScenarioRunner,
  StageJudge,
  TodoLedger,
  TranscriptRecorder,
  TranscriptGrader,
  validateExperimentCard,
  type ExperimentCard,
  type TranscriptEvent,
} from "./harnessCore";

const evidence = {
  problem_summary: "Git output controls scroll away.",
  relevant_files: ["src/components/Git/SourceControlPanel.tsx"],
  root_cause_hypothesis: "The close button lives inside the scrollable log.",
  minimal_change_strategy: "Move scrolling to the log body and keep a fixed header.",
  tests_or_checks_to_run: ["npm run e2e -- e2e/file-tree-and-assistant.spec.ts"],
};

describe("harness core", () => {
  it("enforces mode-level tool permissions", () => {
    const permissions = new PermissionEngine();
    expect(permissions.decide("ask", { tool: "read_file" }).allow).toBe(true);
    const denied = permissions.decide("ask", { tool: "apply_patch" });
    expect(denied.allow).toBe(false);
    if (!denied.allow) expect(denied.tag).toBe("edited_too_early");
  });

  it("blocks dangerous shell commands even in verify mode", () => {
    const permissions = new PermissionEngine();
    const denied = permissions.decide("verify", {
      tool: "run_command",
      args: { command: "git reset --hard HEAD" },
    });
    expect(denied.allow).toBe(false);
    if (!denied.allow) {
      expect(denied.tag).toBe("unsafe_command");
      expect(denied.requiresApproval).toBe(true);
    }
  });

  it("requires evidence and checkpoint before agent edits", () => {
    const agent = new AgentOrchestrator();
    const early = agent.route({
      tool: "apply_patch",
      args: { files: ["src/App.tsx"] },
    });
    expect(early.allow).toBe(false);

    agent.setEvidence(evidence);
    const beforeCheckpoint = agent.route({
      tool: "apply_patch",
      args: { files: ["src/App.tsx"] },
    });
    expect(beforeCheckpoint.allow).toBe(false);

    agent.checkpoint("checkpoint-1");
    const allowed = agent.route({
      tool: "apply_patch",
      args: { files: ["src/components/Git/SourceControlPanel.tsx"], added: 4, removed: 2 },
    });
    expect(allowed.allow).toBe(true);
  });

  it("grades missing verification after a patch as insufficient verification", () => {
    const events: TranscriptEvent[] = [
      { kind: "mode", mode: "agent" },
      { kind: "evidence", packet: evidence },
      {
        kind: "patch",
        files: ["src/components/Git/SourceControlPanel.tsx"],
        added: 4,
        removed: 2,
      },
      { kind: "final", text: "Fixed." },
    ];
    const grade = new TranscriptGrader().grade(events);
    expect(grade.failures).toContain("insufficient_verification");
  });

  it("critic blocks critical failures and stays read-only", () => {
    const events: TranscriptEvent[] = [
      {
        kind: "tool",
        mode: "agent",
        tool: "run_command",
        args: { command: "rm -rf ." },
        allowed: false,
        reason: "Blocked dangerous command",
      },
    ];
    const verdict = new Critic().review(events);
    expect(verdict.verdict).toBe("BLOCK");
    expect(verdict.regression_risks).toContain("unsafe_command");
  });

  it("stores approved memories across parallel lanes with lineage", () => {
    const memory = new MemoryGraph();
    const scoutLane = memory.forkLane("scout: source control");
    const prompt = memory.add({
      stage: "seed",
      kind: "prompt",
      archetype: "memory_curator",
      content: "Generate a commit message.",
      status: "approved",
    });
    const proposal = memory.add({
      laneId: scoutLane,
      stage: "scout_targets",
      kind: "proposal",
      archetype: "scout",
      content: { path: "src/lib/gitWorkflow.ts" },
      parentIds: [prompt.id],
      tags: ["commit", "target"],
    });
    const summary = memory.add({
      laneId: scoutLane,
      stage: "chunk_summarizers",
      kind: "chunk_summary",
      archetype: "summarizer",
      content: "Commit drafts reject low-value filler.",
      parentIds: [proposal.id],
      status: "approved",
      tags: ["commit", "summary"],
    });

    expect(new Set(memory.materializeContext({ approvedOnly: true }).map((item) => item.id))).toEqual(
      new Set([prompt.id, summary.id]),
    );
    expect(memory.lineage(summary.id).map((item) => item.id)).toEqual([
      prompt.id,
      proposal.id,
      summary.id,
    ]);
  });

  it("runs judge councils with one vote per item from each judge", async () => {
    const result = await new JudgeCouncil().evaluateItems(
      [
        { id: "a", label: "src/lib/gitWorkflow.ts", value: "src/lib/gitWorkflow.ts" },
        { id: "b", label: "README.md", value: "README.md" },
      ],
      (item) => `Should this file be collected for commit drafting?\n${item.label}`,
      async (_prompt, judgeIndex, item) => {
        if (item.id === "a") return judgeIndex < 2 ? "Y" : "N";
        return judgeIndex === 0 ? "Y" : "N";
      },
    );
    expect(result.approved.map((item) => item.item.id)).toEqual(["a"]);
    expect(result.rejected.map((item) => item.item.id)).toEqual(["b"]);
    expect(result.all[0].yes).toBe(2);
    expect(result.all[0].requiredYes).toBe(2);
  });

  it("promotes decisions only after a council verdict is written to memory", async () => {
    const memory = new MemoryGraph();
    const runtime = new DecisionCouncilRuntime(memory);
    const result = await runtime.approveDecision(
      {
        stage: "file_scout",
        kind: "proposal",
        archetype: "file_scout",
        content: { path: "src/lib/harnessCore.ts", reason: "Owns the harness runtime." },
        summary: "Read the harness runtime",
      },
      async (_prompt, judgeIndex) => (judgeIndex < 2 ? "Y" : "N"),
    );

    expect(result.approved).toBe(true);
    expect(memory.get(result.memory.id)?.status).toBe("approved");
    const verdicts = memory.byKind("judge_verdict", { approvedOnly: true });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].parentIds).toEqual([result.memory.id]);
  });

  it("rejects decisions that fail council instead of making them usable context", async () => {
    const memory = new MemoryGraph();
    const result = await new DecisionCouncilRuntime(memory).approveDecision(
      {
        stage: "symbol_scout",
        kind: "proposal",
        archetype: "symbol_scout",
        content: { symbol: "ImaginaryApi" },
        summary: "Inspect an unsupported symbol",
      },
      async () => "N",
    );

    expect(result.approved).toBe(false);
    expect(memory.materializeContext({ approvedOnly: true, kinds: ["proposal"] })).toEqual([]);
    expect(memory.get(result.memory.id)?.status).toBe("rejected");
  });

  it("requires a judged navigator after an approved layer before advancing", async () => {
    const blueprint = new HarnessBlueprint("strict-test", "ask", [
      {
        id: "scout",
        name: "Scout files",
        archetype: "file_scout",
        actionMode: "propose",
        inputKinds: [],
        outputKinds: ["proposal"],
        allowedTools: [],
        judge: { kind: "item" },
        writesApprovedMemory: false,
      },
      {
        id: "read",
        name: "Read approved file",
        archetype: "context_retriever",
        actionMode: "none",
        inputKinds: ["proposal"],
        outputKinds: ["context_slice"],
        allowedTools: ["read_file"],
        judge: { kind: "none" },
        writesApprovedMemory: true,
      },
    ]);
    const runtime = new StrictLayerRuntime(blueprint, new MemoryGraph());
    const result = await runtime.runDecisionAndNavigate(
      "scout",
      {
        content: { path: "src/lib/harnessCore.ts" },
        summary: "Read the harness runtime",
      },
      async () => "Y",
    );

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.nextLayerId).toBe("read");
      expect(result.navigation.memory.content.action).toBe("continue");
      expect(runtime.memory.byKind("navigation", { approvedOnly: true })).toHaveLength(1);
      expect(runtime.memory.byKind("judge_verdict", { approvedOnly: true })).toHaveLength(2);
    }
  });

  it("blocks advancement when the navigator council rejects the next step", async () => {
    const blueprint = new HarnessBlueprint("strict-test", "ask", [
      {
        id: "scout",
        name: "Scout files",
        archetype: "file_scout",
        actionMode: "propose",
        inputKinds: [],
        outputKinds: ["proposal"],
        allowedTools: [],
        judge: { kind: "item" },
        writesApprovedMemory: false,
      },
      {
        id: "read",
        name: "Read approved file",
        archetype: "context_retriever",
        actionMode: "none",
        inputKinds: ["proposal"],
        outputKinds: ["context_slice"],
        allowedTools: ["read_file"],
        judge: { kind: "none" },
        writesApprovedMemory: true,
      },
    ]);
    const runtime = new StrictLayerRuntime(blueprint, new MemoryGraph());
    const result = await runtime.runDecisionAndNavigate(
      "scout",
      {
        content: { path: "src/lib/harnessCore.ts" },
        summary: "Read the harness runtime",
      },
      async (_prompt, _judgeIndex, item) => (item.value.kind === "navigation" ? "N" : "Y"),
    );

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toContain("Navigator");
      expect(result.navigation?.memory.status).toBe("rejected");
    }
  });

  it("stores todo checkboxes in memory and updates completion through the ledger", () => {
    const memory = new MemoryGraph();
    const todos = new TodoLedger(memory);
    const scout = todos.add({
      title: "Find files that answer the ask-mode prompt",
      stage: "scout",
      assignedArchetype: "file_scout",
    });
    expect(scout.content.status).toBe("pending");
    todos.start(scout.content.id);
    const completed = todos.complete(scout.content.id, ["memory-99"]);

    expect(completed.content.status).toBe("completed");
    expect(completed.content.evidenceMemoryIds).toContain("memory-99");
    expect(todos.open()).toEqual([]);
    expect(memory.byKind("todo", { approvedOnly: true })).toHaveLength(1);
  });

  it("blocks action takers until an approved action plan exists", () => {
    const blueprint = new HarnessBlueprint("agent-test", "agent", [
      {
        id: "patch",
        name: "Apply approved patch",
        archetype: "action_taker",
        actionMode: "take",
        inputKinds: ["action_plan"],
        outputKinds: ["tool_result"],
        allowedTools: ["apply_patch"],
        judge: { kind: "none" },
        writesApprovedMemory: true,
      },
    ]);
    const memory = new MemoryGraph();
    const runtime = new StrictLayerRuntime(blueprint, memory);
    expect(runtime.canTakeAction("patch", "missing").allow).toBe(false);
    const plan = memory.add({
      stage: "patch_planner",
      kind: "action_plan",
      archetype: "patch_planner",
      content: { files: ["src/App.tsx"], reason: "Minimal fix." },
      summary: "Patch one file",
      status: "approved",
    });
    expect(runtime.canTakeAction("patch", plan.id).allow).toBe(true);
  });

  it("runs outcome and diligence votes and requires four of six Y", async () => {
    const recorder = new TranscriptRecorder();
    const judge = new Judge(3, 4, recorder);
    const verdict = await judge.run(
      {
        initialPrompt: "Fix commit message generation.",
        foundImportantBecause: "The agent found path leaks in consolidated summaries.",
        dueDiligenceTrace: [
          "git_diff staged files",
          "read_file src/lib/gitWorkflow.ts",
          "run tests for gitWorkflow",
        ],
        producedOutput: "Added path-leak guards and regression tests.",
        successCriteria: [
          "The output names concrete changes.",
          "The output does not leak paths or fixture strings.",
        ],
      },
      async (_prompt, index, dimension) =>
        index === 2 || dimension === "diligence" ? "N" : "Y",
    );
    expect(verdict.verdict).toBe("BLOCK");
    expect(verdict.yes).toBe(2);
    expect(verdict.no).toBe(4);
    expect(verdict.totalVotes).toBe(6);
    expect(verdict.requiredYes).toBe(4);
    expect(recorder.snapshot().filter((event) => event.kind === "judge")).toHaveLength(6);
  });

  it("passes judge with four yes votes across outcome and diligence", async () => {
    const verdict = await new Judge().run(
      {
        taskClass: "scout",
        initialPrompt: "Find where auth is enforced.",
        foundImportantBecause: "The scout found middleware and route guards.",
        dueDiligenceTrace: ["list_tree src", "search_text auth", "read_file middleware/auth.ts"],
        producedOutput: "Authentication is enforced by middleware and route guards.",
      },
      async (_prompt, index, dimension) =>
        index === 2 && dimension === "diligence" ? "N" : "Y",
    );
    expect(verdict.verdict).toBe("PASS");
    expect(verdict.yes).toBe(5);
  });

  it("retries invalid judge output before recording a vote", async () => {
    const attempts: string[] = [];
    const verdict = await new Judge().run(
      {
        initialPrompt: "Explain App.jsx.",
        foundImportantBecause: "The agent did not read App.jsx.",
        dueDiligenceTrace: ["No read_file App.jsx call."],
        producedOutput: "Looks like a React app.",
      },
      async (prompt, index, dimension) => {
        attempts.push(prompt);
        return index === 0 && dimension === "outcome" && attempts.length === 1
          ? "Y because it seems fine"
          : "N";
      },
    );
    expect(verdict.verdict).toBe("BLOCK");
    expect(verdict.invalid).toBe(0);
    expect(verdict.no).toBeGreaterThan(0);
    expect(verdict.votes[0].attempts).toEqual(["Y because it seems fine", "N"]);
    expect(attempts[1]).toContain("Your previous response was invalid");
  });

  it("blocks only after judge retry budget is exhausted", async () => {
    const verdict = await new Judge(3, 3, undefined, 1).run(
      {
        initialPrompt: "Explain App.jsx.",
        foundImportantBecause: "The agent did not read App.jsx.",
        dueDiligenceTrace: ["No read_file App.jsx call."],
        producedOutput: "Looks like a React app.",
      },
      async () => "Maybe",
    );
    expect(verdict.verdict).toBe("BLOCK");
    expect(verdict.invalid).toBe(6);
    expect(verdict.votes.every((vote) => vote.attempts.length === 2)).toBe(true);
  });

  it("includes agent path in diligence prompts", async () => {
    const prompts: string[] = [];
    const verdict = await new Judge().run(
      {
        taskClass: "research",
        initialPrompt: "Summarize the staged diff.",
        foundImportantBecause: "The diff adds chunked memory and state-machine safeguards.",
        dueDiligenceTrace: ["git_diff --cached", "read_file src/lib/harnessCore.ts"],
        producedOutput: "feat(ai): add harness safeguards and chunked commit drafting",
      },
      async (prompt) => {
        prompts.push(prompt);
        return "Y";
      },
    );
    expect(verdict.verdict).toBe("PASS");
    expect(verdict.yes).toBe(6);
    expect(prompts.some((prompt) => prompt.includes("Vote type: diligence"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("git_diff --cached"))).toBe(true);
  });

  it("marks a scheduled stage complete only when the judge passes", async () => {
    const result = await new StageJudge().evaluate(
      {
        stage: "localize",
        initialPrompt: "Find the files responsible for source control commits.",
        foundImportantBecause: "The scout read the source control panel and git workflow module.",
        dueDiligenceTrace: [
          "search_text commit message",
          "read_file src/components/Git/SourceControlPanel.tsx",
          "read_file src/lib/gitWorkflow.ts",
        ],
        producedOutput: "Commit message generation is owned by the source control panel and git workflow helpers.",
      },
      async () => "Y",
    );
    expect(result.status).toBe("complete");
    expect(result.stage).toBe("localize");
    expect(result.verdict.yes).toBe(6);
  });

  it("retries a scheduled stage instead of advancing when validation fails", async () => {
    const result = await new StageJudge().evaluate(
      {
        stage: "scout",
        attempt: 1,
        maxAttempts: 3,
        initialPrompt: "Explain App.jsx.",
        foundImportantBecause: "The scout guessed based on the filename.",
        dueDiligenceTrace: ["list_tree src"],
        producedOutput: "App.jsx renders the application.",
      },
      async (_prompt, _index, dimension) => (dimension === "outcome" ? "N" : "Y"),
    );
    expect(result.status).toBe("retry");
    if (result.status === "retry") {
      expect(result.nextAttempt).toBe(2);
      expect(result.retryPrompt).toBe("Explain App.jsx.");
      expect(result.retryPromptIndex).toBe(0);
      expect(result.backtracked).toBe(false);
    }
  });

  it("backtracks to the previous agent prompt after three failed validations", async () => {
    const result = await new StageJudge().evaluate(
      {
        stage: "localize",
        failedPromptIndex: 1,
        promptAttempt: 3,
        maxAttemptsPerPrompt: 3,
        promptStack: [
          {
            label: "scout",
            prompt: "Search the repo for the owner of commit drafting.",
            clearsContext: true,
          },
          {
            label: "inspect",
            prompt: "Read the files that own commit drafting and produce the evidence packet.",
          },
        ],
        initialPrompt: "Localize commit drafting.",
        foundImportantBecause: "The inspect prompt still produced unsupported file ownership.",
        dueDiligenceTrace: ["search_text commit", "read_file unrelated.ts"],
        producedOutput: "Commit drafting is owned by an unrelated file.",
      },
      async () => "N",
    );
    expect(result.status).toBe("retry");
    if (result.status === "retry") {
      expect(result.retryPrompt).toBe("Search the repo for the owner of commit drafting.");
      expect(result.retryPromptIndex).toBe(0);
      expect(result.nextAttempt).toBe(1);
      expect(result.clearContext).toBe(true);
      expect(result.backtracked).toBe(true);
    }
  });

  it("blocks a scheduled stage after its retry budget is exhausted", async () => {
    const result = await new StageJudge().evaluate(
      {
        stage: "verify",
        attempt: 2,
        maxAttempts: 2,
        initialPrompt: "Verify the patch.",
        foundImportantBecause: "The agent did not run the relevant check.",
        dueDiligenceTrace: ["No verification command ran."],
        producedOutput: "Tests passed.",
      },
      async () => "N",
    );
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toContain("verify");
      expect(result.reason).toContain("prompt stack");
      expect(result.verdict.no).toBe(6);
    }
  });

  it("does not advance later scheduled stages until the current stage is judged complete", async () => {
    const results = await new ScenarioRunner().runScheduledStages(
      [
        {
          stage: "scout",
          initialPrompt: "Find where commit drafting happens.",
          foundImportantBecause: "The scout only checked a directory listing.",
          dueDiligenceTrace: ["list_tree src"],
          producedOutput: "Commit drafting is probably in source control.",
        },
        {
          stage: "patch",
          initialPrompt: "Patch the commit draft flow.",
          foundImportantBecause: "This should not run until scout passes.",
          dueDiligenceTrace: ["apply_patch"],
          producedOutput: "Patched the flow.",
        },
      ],
      async (_prompt, _index, dimension) => (dimension === "outcome" ? "N" : "Y"),
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("retry");
    expect(results[0].stage).toBe("scout");
  });

  it("validates experiment cards before accepting harness changes", () => {
    const card: ExperimentCard = {
      hypothesis: "Diff-derived fallback prevents generic commit messages.",
      observed_failures: ["commit_message_inaccurate"],
      proposed_change: "Use staged diff symbols when model summaries are generic.",
      expected_improvement: ["Commit messages stop saying related behavior."],
      risk: "Could over-index on symbol names.",
      evals_to_run: ["npm run test -- src/lib/gitWorkflow.test.ts"],
      acceptance_criteria: ["No generic related-behavior output."],
    };
    expect(validateExperimentCard(card)).toBe(true);
    expect(FailureTaxonomy.commit_message_inaccurate.severity).toBe("high");
  });

  it("accepts regression runs only when score improves without new critical failures", () => {
    const before = new TranscriptGrader().grade([
      { kind: "patch", files: ["src/App.tsx"], added: 2, removed: 1 },
    ]);
    const after = new TranscriptGrader().grade([
      { kind: "evidence", packet: evidence },
      { kind: "patch", files: ["src/App.tsx"], added: 2, removed: 1 },
      { kind: "verification", command: "npm test", passed: true },
      { kind: "final", text: "Done." },
    ]);
    const card: ExperimentCard = {
      hypothesis: "Evidence gates improve agent process quality.",
      observed_failures: ["edited_too_early"],
      proposed_change: "Require evidence before mutation.",
      expected_improvement: ["Patch starts after localization."],
      risk: "May add latency.",
      evals_to_run: ["npm run eval:terminal"],
      acceptance_criteria: ["Score improves without critical regression."],
    };
    expect(new RegressionRunner().acceptExperiment(card, before, after)).toBe(true);
  });
});
