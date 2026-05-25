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
