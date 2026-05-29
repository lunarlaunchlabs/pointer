# Pointer quality harness

A live, end-to-end evaluator for Pointer's four AI surfaces — FIM,
Chat, Inline-edit (Cmd+K), and Agent — driven against the locally
installed Ollama model. Unlike unit tests, this harness sends real
prompts to the real model the app uses, parses the responses with
Pointer's actual parser, applies the diffs to a fixture, and runs
behavioural tests against the result.

## How to run

```sh
# Make sure Ollama is running and the chat/fim/agent model is loaded:
ollama serve &
ollama pull qwen2.5-coder:7b-instruct

# Single round, all surfaces.
npm run eval

# Stability run — 5 rounds, identifies flaky scenarios.
npm run eval:stability

# Specific surface only.
node scripts/quality/run.mjs --only=chat,agent

# Terminal workbench that mirrors the app's Ask / Plan / Agent flows.
npm run assistant:terminal -- --repo /Users/sameer/express

# Probe every stage of staged-diff commit generation.
npm run probe:commit -- --model qwen2.5-coder:14b-instruct

# Deterministic chaos probe: injects bad raw model output and proves the
# normalizers repair it before the user sees the summary/message.
npm run probe:commit -- --mock --fail-on-warnings

# Same probe with the six-vote judge layer on the final output and trace.
npm run probe:commit -- --mock --judge --fail-on-warnings

# Fast terminal smoke across real repos.
npm run eval:terminal

# Different model:
POINTER_MODEL=qwen2.5-coder:14b-instruct npm run eval
```

## What each evaluator tests

### FIM (`evalFim.mjs`)

Sends real FIM prompts (`<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>`)
to the model with `raw: true`, matching `ollama_fim.rs` byte-for-byte.
Scenarios:

* **function-body**: completion of an arrow-chained reducer; verified
  by splicing and running 4 behavioural cases.
* **object-literal-continuation**: must add at least one key-value
  pair matching the established shape.
* **import-list-continuation**: model must add a bare identifier that
  fits the React import list.
* **cross-file-context**: prompt is enriched with a `<|file_sep|>`
  reference file (the way `buildFimContext` does in production); the
  completion must use the symbol exposed by the reference.
* **switch-case-continuation**: model must continue a switch ladder
  with at least a partial `case "…":` label.

### Chat (`evalChat.mjs`)

Uses the exact `chatSystemPrompt` from `src/store/chat.ts`. Scenarios:

* **edit-existing-fix-bug**: patch an off-by-one in a sum function.
* **edit-existing-add-feature**: add input validation while keeping
  existing behaviour for valid inputs.
* **create-new-file**: generate a brand-new utility module using ESM.

Each scenario applies the parsed hunks via Pointer's `applyHunks`,
then runs behavioural tests. A scenario passes only when the produced
code applies cleanly AND passes the behavioural tests.

### Inline edit (`evalInline.mjs`)

Mirrors `InlineEdit.tsx`'s system prompt + user message shape.
Scenarios:

* **fix-off-by-one**: single-line loop fix.
* **rewrite-implementation**: rewrite an iterative function body to a
  recursive one — same signature, same outputs.
* **fix-diagnostic**: an overlapping diagnostic is shown to the model,
  which must resolve it without breaking behaviour.

### Agent (`evalAgent.mjs`)

Drives a multi-turn loop with the actual `agent_system.txt` prompt and
a faithful JS port of `parse_tool_call` from `agent.rs`. The tool
runtime backs onto an in-memory VFS for fs ops, and `run_shell`
materializes the VFS to a real temp directory so test-driven loops
(`node --test`, `python3`, etc.) actually execute.

Scenarios span 17 distinct categories of agent behaviour:

| Category | Scenario | What it tests |
|---|---|---|
| `bug-fix` | `find-and-fix-bug` | read → apply_diff → final on an INI parser bug |
| `refactor` | `multi-file-rename` | grep → patch (multi-hunk) → final, renaming across 2 files |
| `explore-edit` | `explore-then-edit` | read helper, then patch a caller |
| `scope` | `conservative-scope` | file has 3 bugs; fix ONLY the one in scope |
| `no-op` | `already-satisfied` | goal already met → just `<final>`, no mutations |
| `create` | `create-utility` | new file via `write_file` at an exact path |
| `lang:python` | `python-bug-fix` | apply_diff on `.py` + run-shell verification |
| `recovery` | `recover-from-missing` | wrong-path apply_diff fails → re-read → succeed |
| `plan` | `plan-mode-readonly` | plan-mode rejects mutations; agent emits `<plan>` + `<final>` |
| `large-file` | `large-file-targeted-edit` | 60-line file, find & fix the one bad helper |
| `investigate` | `misleading-hint` | user blames wrong file; agent finds real bug elsewhere |
| `clarify` | `clarify-missing-target` | function doesn't exist → `<clarify>`, don't invent |
| `explain` | `explanation-only` | read & describe; ZERO mutations allowed |
| `batched` | `batched-multi-hunk` | 3 fixes in ONE apply_diff body |
| `convention` | `match-style` | new code must match existing snake_case one-liner style |
| `safety` | `refuse-destructive` | ask-mode rejects `delete_path`; agent must back off |
| `test-driven` | `test-driven-fix` | `run_shell` runs tests → observe failure → fix → re-run |

Each scenario declares quality dimensions in its `expect` block:

* `successPath` + `fnName` + `cases`: behavioural correctness — the
  edited file is loaded and the named export tested.
* `fileContains` / `fileEquals`: regex or string assertions on the
  post-agent file state.
* `fileUnchanged`: scope discipline — these files MUST NOT have
  been touched.
* `mustUseTools` / `mustNotUseTools`: enforce method (e.g. plan mode
  must not call `apply_diff`).
* `mutationsAllowed`: hard cap on mutating tool calls.
* `turnsBudget`: soft cap that yields a warning when exceeded.
* `finalContains`: regex/string assertions on the `<final>` block
  content (catches plan-mode plans that look right but don't name
  the right entities).
* `clarifyOrAcknowledgement`: scenarios where either `<clarify>` or
  a `<final>` that explicitly acknowledges the issue is acceptable.
* `clarifyRequired`: scenarios where the only acceptable exit is
  `<clarify>`.

The harness's tool runtime mirrors production's `tool_result` shape
including:

* the post-mutation directive ("your next turn must be `<final>`"),
* the read-before-retry hint after a failed `apply_diff`,
* the plan-mode rejection redirect ("emit `<plan>`/`<final>` only"),
* identical-call and 2-cycle/3-cycle loop detection (terminate
  rather than burning turns on a spinning agent),
* sanitisation of hallucinated `<tool_result>` / `<verifier>`
  blocks (so a model that emits a fake "I read it" → fake final
  gets caught and re-run with the real tool result).

## When a scenario fails

The summary prints which scenario failed and the verdict (`why`).
Flaky scenarios — ones that passed at least once AND failed at least
once across rounds — get listed separately so you can tell sampling
variance from a stable defect.

When you need to debug a specific failure, run the surface alone:

```sh
node scripts/quality/evalAgent.mjs
```

The agent eval prints the full per-turn trace on failure (response
heads, tool calls, results), which makes it easy to see where the
model went wrong vs. where the harness mis-scored.

## Quality bar

* All four surfaces hit 100% per-round at temperature 0.2 with
  `qwen2.5-coder:7b-instruct`.
* Across a 5-round stability run: **140/140 cumulative passes**
  (25 FIM, 15 Chat, 15 Inline, 85 Agent), **0 flaky scenarios**,
  **0 warnings**, ~375s wall-clock.
* Agent coverage spans 17 categories (see table above) — bug fixes,
  multi-file refactors, no-op detection, plan mode, ask-mode safety
  gates, test-driven loops, Python, large files, scope discipline,
  pattern adherence, and recovery from missing/wrong paths.

## Stay-in-sync invariants

If you change any of these, update the corresponding harness file:

* `src/lib/harnessCore.ts` is the executable contract for mode
  permissions, Agent phase gates, failure taxonomy, transcript grading,
  critic verdicts, and experiment-card acceptance. Prompt changes should
  not bypass these gates.
* `src/store/chat.ts` :: `chatSystemPrompt` → `evalChat.mjs::chatSystem`
* `src/lib/diff.ts` :: `parseSearchReplace` → `scripts/quality/lib.mjs::parseSearchReplace`
* `src-tauri/prompts/agent_system.txt` is read directly — no copy.
* `src-tauri/src/commands/agent.rs` :: `run_apply_diff` → `evalAgent.mjs::applyDiffBody`
* `src-tauri/src/commands/agent.rs` post-mutation directive →
  `evalAgent.mjs::driveAgent` post-tool feedback.
* `src-tauri/src/commands/agent.rs` :: `sanitize_model_output` →
  `evalAgent.mjs::sanitizeModelOutput`.
* `src-tauri/src/commands/agent.rs` :: `detect_cycle` → harness
  `detectCycle` inside `evalAgent.mjs::driveAgent`.
* `src-tauri/src/commands/agent.rs` :: `run_grep` (regex-with-literal-
  fallback) → harness `runTool` grep branch in `evalAgent.mjs`.

## State-machine harness contract

Pointer's local-model runtime is a constrained IDE system, not a
freeform chatbot. The core contract lives in `src/lib/harnessCore.ts`
and names the components every surface should converge on:

* `AgentOrchestrator`, `ContextBuilder`, `ToolRouter`,
  `PermissionEngine`, `PatchManager`, `Verifier`, `Critic`, and
  `Judge`.
* `ScenarioRunner`, `TranscriptRecorder`, `TranscriptGrader`,
  `RepoCurator`, `TaskGenerator`, `FailureTaxonomy`, and
  `RegressionRunner`.

The first rule is deterministic enforcement: Ask/Plan are read-only,
Commit Message can only see git diffs/status, Agent cannot edit before an
evidence packet plus checkpoint, Repair can only touch files already
touched in the current attempt, and dangerous shell commands are blocked
at the permission layer. Every harness change should include an
experiment card and must improve grades without introducing a new
critical failure tag.

`Judge` is the tight Y/N validation layer for model outputs that need
extra confidence. It runs three isolated judges, and each judge votes
twice: once on the final outcome, and once on due diligence using the
agent path that led there (reads, searches, directory listings,
diagnostics, command checks, or other trace events). Each vote must
return exactly `Y` or `N`; invalid text triggers a stricter retry prompt,
and Pointer only records `invalid` after the retry budget is exhausted.
The default pass threshold is 4 yes votes out of 6, with invalid votes
blocking validation.

`StageJudge` wraps that same voting layer around a scheduled harness
stage. A stage can only return `complete`, `retry`, or `blocked`; failed
validation replays the exact agent prompt that produced the failed
output, preserving that prompt's context-clear flag. After three failed
validations for the same prompt, the stage backtracks to the previous
prompt in the prompt stack and retries from there. If the first prompt in
the stack exhausts its retry budget, the stage blocks so the UI and
transcript can show which scheduled task did not complete.
`ScenarioRunner.runScheduledStages` uses this gate for ordered stage
packs, stopping at the first incomplete stage so later work cannot start
on top of unvalidated context.

`DecisionCouncilRuntime`, `Navigator`, `TodoLedger`, and
`StrictLayerRuntime` are the full composable runtime for weaker local
models. Model agents do not directly promote their own decisions. A
micro-agent writes pending memory, a judge council approves or rejects
that exact memory, and only approved memory can feed later layers. After
any layer passes, the navigator proposes the next step (`continue`,
`retry`, `backtrack`, `done`, or `blocked`), and that navigation decision
is itself judged before Pointer advances. The todo ledger stores
checkbox-style task state as durable harness memory, so a todo checker
can mark work complete only by writing an auditable `todo` memory update.

The shared harness is composable rather than feature-specific. Core
agent archetypes include cartographers, navigators, todo managers,
folder/file/symbol scouts, context retrievers and pruners, dependency
mappers, risk assessors, verification planners, command planners, patch
planners, safety guards, researchers, summarizers, consolidators,
evaluators, action proposers, action takers, judges, critics, verifiers,
drafters, and memory curators. Each feature gets a dedicated blueprint
made from those archetypes. The blueprint declares allowed tools, memory
inputs/outputs, whether a layer may only propose or may take an action,
and which judge gate must approve the layer before its output becomes
usable.

`MemoryGraph` stores durable memories by lane, kind, stage, archetype,
parents, tags, and approval status. This lets Pointer keep parallel lanes
of thought, trace every summary back to its prompt/tool result, and
materialize only approved memories for later layers. Model agents propose
or summarize; typed code gathers files, diffs, diagnostics, and command
outputs; judge councils decide what is promoted into memory.

The git commit harness is specialized in `src/lib/gitCommitHarness.ts`.
It has no action taker layers: it can propose context, gather read-only
git/file evidence, summarize chunks, evaluate sufficiency, propose commit
splits, and draft a message, but it cannot edit, stage, commit, reset, or
discard files. Per-item judge councils approve individual scout targets,
candidate files, and chunk summaries before those memories feed the next
layer.

### Terminal workbench (`pointerTerminal.mjs`)

Runs a REPL that mimics the unified Assistant UI from a terminal so we
can test like a real user without waiting on GUI automation. It loads a
real repo into the same in-memory VFS used by `evalAgent.mjs`, resolves
implicit file mentions, attaches the active editor file to Ask mode,
routes Plan/Agent through the production agent system prompt, and prompts
for approvals when running `agent-ask`.

### Commit pipeline probe (`gitCommitPipelineProbe.mjs`)

Runs the same staged-diff commit generation pipeline outside the UI and
prints every stage:

* per-file diff chunks,
* raw chunk model output,
* normalized chunk summaries,
* raw file consolidation,
* normalized file summaries,
* raw consolidated summary,
* normalized consolidated summary,
* raw final commit message,
* normalized final commit message.

The probe imports `src/lib/gitWorkflow.ts` through Vite, so it exercises
the production normalizers and prompts rather than a copied script. It
can call a real Ollama model with `--model <name>` or run `--mock`,
which intentionally emits bad strings like template literals, path
fragments, and theme-only commit subjects. Use `--fail-on-warnings` in
CI-style loops to make leaks fail the command. Add `--judge` to run the
six-vote Judge layer over both final commit-message quality and pipeline
due diligence. Add `--trace-harness` to print memory stages, including
todo updates, judged navigator decisions, chunk memories, file
summaries, drafts, red-team decisions, and final verdict memory.

Useful commands inside the REPL:

```sh
/mode ask|chat|plan|agent|agent-ask
/repo /Users/sameer/express
/open lib/application.js
/ref lib/request.js
/send Tell me about application.js
/execute
/diff
/suite smoke
```

For scripted runs:

```sh
node scripts/quality/pointerTerminal.mjs --suite=smoke
node scripts/quality/pointerTerminal.mjs --suite=real
node scripts/quality/pointerTerminal.mjs --repo=/Users/sameer/tauri-markdown --mode=plan --prompt="Plan a fix for the drag overlay sticking after an unsupported drop"
```

The suite can also be exported as neutral JSON/JSONL so another coding
agent harness, such as opencode or a unified CLI runner, can replay the
same real-developer scenarios and compare outputs:

```sh
node scripts/quality/pointerTerminal.mjs --suite=real --export=jsonl
node scripts/quality/pointerTerminal.mjs --suite=plan --export=json
```
