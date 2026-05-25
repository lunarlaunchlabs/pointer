# Manual smoke — Unified Assistant + Intelligent History

This is the manual verification script for the
"unified-assistant-history" change. It exists as a doc because
the behaviours under test (no redundant tool calls, fresh-read
injection, ledger-driven iteration) depend on actual local-model
output, which we can't reproduce deterministically in a unit
test.

Run through every section before shipping. Anything that fails
the explicit "PASS WHEN" criterion below is a release blocker.

## Setup

1. Start Pointer against a workspace with a non-trivial file
   (`src/foo.ts` is a good target). Pull a small chat-capable
   model (`qwen2.5-coder:7b-instruct` is enough).
2. Open `⌘L` — you should land in the unified Assistant panel
   with the mode picker reading **Ask | Plan | Agent** across
   the top.
3. Verify the dock rail shows ONE Bot icon (not two — the old
   Chat + Agent split is gone).

## Scenario 1 — Iteration on prior write

The bug this replaces: agent rewrites a file it just wrote
because it "forgot" its own previous output.

Steps:

1. Switch the mode picker to **Agent**.
2. Send: `Create src/feature_flags.ts with a single exported
   constant FLAG_V1 = true.`
3. Wait for the run to finish. The "Ledger" trace at the bottom
   of the panel should show
   `T1 wrote src/feature_flags.ts (… bytes, 1 hunk)`.
4. WITHOUT clearing the session, send: `Now also add FLAG_V2 =
   false to src/feature_flags.ts.`

**PASS WHEN:**
- Pointer does NOT call `<read_file path="src/feature_flags.ts">`
  before editing. The current contents are inlined under
  `<fresh_reads>` in the brief (you can confirm by inspecting the
  request payload in DevTools → Network if you want absolute
  certainty).
- The final file on disk contains both `FLAG_V1` and `FLAG_V2`.
- The ledger trace shows TWO `wrote src/feature_flags.ts` lines,
  not "deleted then created" or "rewrote from scratch".

## Scenario 2 — Redo / undo

The bug this prevents: the model treats "undo the last change"
as "do nothing because I already did it".

Steps:

1. Continue the same Agent session.
2. Send: `Undo the previous change — remove FLAG_V2 and keep
   only FLAG_V1.`

**PASS WHEN:**
- The model edits `src/feature_flags.ts` again rather than
  emitting a `<final>` saying "I already did that, nothing to
  do".
- The ledger appends a third `wrote` entry with a smaller byte
  count.
- The final file contains `FLAG_V1` but NOT `FLAG_V2`.

## Scenario 3 — Pure chat in Ask mode

The bug this prevents: the Assistant accidentally enters the
tool loop when the user just wanted an answer.

Steps:

1. Click the **Ask** option in the mode picker.
2. Confirm the session's previous transcript is still visible
   (mode switching must NOT clear history).
3. Send: `What does FLAG_V1 do, conceptually?`

**PASS WHEN:**
- No tool-call cards appear. No `<read_file>`, no
  `<run_shell>`.
- The reply streams as plain prose.
- The ledger appends one `T4 answered: …` entry — confirming
  the Ask path mirrors the `AnsweredOnly` shape the rest of the
  ledger uses.

## Scenario 4 — Plan → Execute promotion

The bug this prevents: promoting a plan to an agent run causes
the agent to start from zero and re-explore the workspace.

Steps:

1. Click **Plan** in the mode picker.
2. Send: `Plan adding a third feature flag FLAG_V3 = false to
   src/feature_flags.ts and exporting it.`
3. Wait for the run to finish. A "Plan ready" card should
   appear above the composer with an `Execute as Agent` button
   and the number of steps detected.
4. Click `Execute as Agent`.

**PASS WHEN:**
- The Assistant flips to Agent mode automatically.
- The new run does NOT issue a `<read_file>` for
  `src/feature_flags.ts` (it's already in the ledger).
- The new run does NOT re-search the workspace for "feature
  flag" usage (the plan turn already captured that).
- The final file gets `FLAG_V3` appended; no duplicates of
  existing flags.

## Scenario 5 — Cross-session migration

The bug this prevents: pre-existing chat / agent sessions
disappear on upgrade.

Steps (only relevant for users with a profile from a prior
release):

1. Before upgrading, note the title of the most recent chat
   session and the most recent agent session.
2. Upgrade to the unified Assistant build.
3. Open the Assistant panel.

**PASS WHEN:**
- The session picker shows BOTH sessions, sorted newest-first.
- The chat-derived session opens in Ask mode and shows the same
  message history.
- The agent-derived session opens in Plan or Agent mode (per
  its original setting), and the ledger trace includes one
  entry per mutating tool call the old agent ran.

## Scenario 6 — Cross-turn dedup hint is advisory, not blocking

The bug this prevents: a "you already read X" hard-block kills
legitimate iteration.

Steps:

1. New Agent session. Send: `Read src/feature_flags.ts and
   tell me what's there.`
2. Wait for completion. Confirm the ledger gained a `read`
   entry.
3. Send: `Read it again — I want to double-check.`

**PASS WHEN:**
- Pointer ACTUALLY re-reads the file (you'll see the
  `<tool_result tool="read_file">` card).
- The result is followed by a small `<dedup_hint>` block
  reminding the model the file was read recently — but the read
  itself succeeds. The hint is advisory.

## What to capture in the bug ticket if any scenario fails

Include:
- The model name + size (`ollama list`).
- The full transcript from the Assistant panel (Settings →
  Export).
- The persistence key `assistant.sessions.v1` from
  `~/Library/Application Support/com.pointer.editor/pointer.json`.
- Whether `previous_work` / `fresh_reads` blocks were present
  in the failing turn's request payload.
