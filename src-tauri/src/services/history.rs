//! Structured action ledger — per-session record of "what happened"
//! that's tight enough to live in every model turn without burning
//! through the 32K context budget local models ship with.
//!
//! Background. The agent loop's old `<earlier_activity>` block (in
//! `commands::agent::summarise_pruned_turns`) collapsed every pruned
//! turn into one line — but it kicked in ONLY when the transcript
//! crossed 48K chars, threw away file mutation details, and was
//! built fresh each step from whatever happened to still be in the
//! transcript. Result: a follow-up turn often started with the
//! model thinking "what file did I just write?" — leading to redo
//! loops (re-reading a file we wrote two turns ago, re-running a
//! grep we already ran, even re-creating a file the model claimed
//! it would create).
//!
//! The ledger fixes that with three properties the pruner cannot:
//!
//!   1. **Built incrementally** from real tool results, not parsed
//!      out of decayed transcript content. Mutations are recorded
//!      the moment they happen, with the workspace-relative path
//!      and the size of the change.
//!   2. **Survives pruning.** The pruner can drop a stale read of
//!      `src/foo.ts` because the ledger still says "you wrote
//!      `src/foo.ts` (43 lines, 2 hunks) in turn 4".
//!   3. **Framed as fact, not prescription.** The block we render
//!      into the transcript explicitly tells the model "history is
//!      what happened; re-do something only if the new request
//!      requires it." Without that framing local models read a list
//!      of past actions as instructions ("I already did X, skip
//!      it") and refuse legitimate iteration ("now also rename a
//!      function in X").
//!
//! The ledger is **per-session** and is persisted alongside the
//! transcript. It is **not** shared across sessions.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// One factual entry in the action ledger. `turn` is monotonic
/// within the session; `kind` carries the per-kind payload the
/// renderer needs to produce a one-line description for the model.
///
/// `Serialize`/`Deserialize` so the ledger round-trips through the
/// FE store alongside the transcript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LedgerEntry {
    /// 1-based turn counter within the session. Multiple entries
    /// can share a turn (e.g. a tool call plus a follow-up answer).
    pub turn: u32,
    /// Unix-epoch milliseconds — kept so the renderer can sort
    /// stably even if `turn` wraps around in a very long session.
    pub timestamp_ms: i64,
    /// Mode the entry was recorded in, serialized lowercase to
    /// match the FE's `AssistantMode` enum directly. Surfaced in
    /// the rendered block so the model can tell "this happened in
    /// Ask mode (conversational only)" from "this happened in
    /// Agent mode (mutating)".
    pub mode: String,
    pub kind: LedgerKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LedgerKind {
    /// A file was created or overwritten via `write_file`/`edit_file`.
    Wrote {
        path: String,
        bytes: usize,
        /// 1 for `write_file` (whole-file), N for `apply_diff`/`edit_file`.
        hunks: usize,
    },
    /// A file or directory was deleted via `delete_path`.
    Deleted { path: String },
    /// A path was moved/renamed via `rename_path`.
    Renamed { from: String, to: String },
    /// A symbol-level rename touched one or more files.
    SymbolRenamed {
        old: String,
        new: String,
        files: Vec<String>,
        references_replaced: usize,
    },
    /// A shell command was run. `command_summary` is the first
    /// non-empty line of the command, truncated; we never store
    /// the full command body in the ledger because chatty install
    /// scripts (`npm install`, `cargo build`) easily blow the
    /// ~200-char budget per entry.
    RanShell {
        command_summary: String,
        exit_code: i32,
    },
    /// A read-only inspection happened. Useful for cross-turn
    /// dedup (so we can tell the model "you already read
    /// `src/foo.ts` two turns ago; current content is in
    /// `<previous_work>`"). Collapsed by the renderer into a
    /// single line per turn.
    Read { paths: Vec<String> },
    /// Search-class lookups (grep/glob/search_codebase/discover).
    /// Also for dedup; the renderer collapses them.
    Searched { queries: Vec<String> },
    /// A turn that produced no tool calls — just an answer. Used
    /// for Ask mode (every turn is `AnsweredOnly`) and for the
    /// rare Agent turn that emits only `<final>`.
    AnsweredOnly { summary: String },
}

/// In-memory per-session ledger. Pure data + a few small helpers;
/// no IO. The store on the FE side mirrors this shape.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ActionLedger {
    pub entries: Vec<LedgerEntry>,
}

impl ActionLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, entry: LedgerEntry) {
        self.entries.push(entry);
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Distinct workspace-relative paths the agent has WRITTEN to
    /// at least once in this session. Used by the fresh-read
    /// injector — when the new user message references one of
    /// these paths, we attach the current bytes so the model can
    /// iterate without re-reading from stale memory.
    pub fn written_paths(&self) -> HashSet<String> {
        let mut out = HashSet::new();
        for e in &self.entries {
            match &e.kind {
                LedgerKind::Wrote { path, .. } | LedgerKind::Deleted { path } => {
                    out.insert(path.clone());
                }
                LedgerKind::Renamed { to, .. } => {
                    out.insert(to.clone());
                }
                LedgerKind::SymbolRenamed { files, .. } => {
                    for f in files {
                        out.insert(f.clone());
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// Distinct workspace-relative paths the agent has READ at
    /// least once. Used by the cross-turn dedup hinter.
    pub fn read_paths(&self) -> HashSet<String> {
        let mut out = HashSet::new();
        for e in &self.entries {
            if let LedgerKind::Read { paths } = &e.kind {
                for p in paths {
                    out.insert(p.clone());
                }
            }
        }
        out
    }

    /// Distinct search queries already executed.
    pub fn search_queries(&self) -> HashSet<String> {
        let mut out = HashSet::new();
        for e in &self.entries {
            if let LedgerKind::Searched { queries } = &e.kind {
                for q in queries {
                    out.insert(q.clone());
                }
            }
        }
        out
    }
}

/// Render the ledger as a `<previous_work>` block suitable for
/// injection into the latest user message. We collapse consecutive
/// `Read`/`Searched` entries from the same turn into one line each
/// so chatty exploration turns don't dominate the block.
///
/// The framing block — `<previous_work_note>` — explicitly tells
/// the model history is factual, not prescriptive. This is the key
/// difference from the old `<earlier_activity>` block: without that
/// framing, local models read past actions as "I already did this,
/// stop" and refuse legitimate follow-up iteration.
pub fn render_previous_work(ledger: &ActionLedger) -> Option<String> {
    if ledger.is_empty() {
        return None;
    }

    // Group entries by `turn` so we can collapse multiple
    // Read/Searched entries from the same turn into one line each
    // (with deduped path lists).
    let mut by_turn: HashMap<u32, Vec<&LedgerEntry>> = HashMap::new();
    let mut turn_order: Vec<u32> = vec![];
    for e in &ledger.entries {
        if !by_turn.contains_key(&e.turn) {
            turn_order.push(e.turn);
        }
        by_turn.entry(e.turn).or_default().push(e);
    }

    let modes: HashSet<&str> = ledger.entries.iter().map(|e| e.mode.as_str()).collect();
    let modes_attr = {
        let mut v: Vec<&&str> = modes.iter().collect();
        v.sort();
        v.iter().map(|s| **s).collect::<Vec<_>>().join(",")
    };

    let mut body = String::new();
    let mut total_turns = 0u32;
    for turn in turn_order {
        let entries = by_turn.get(&turn).unwrap();
        total_turns = total_turns.max(turn);
        // Collapse Read/Searched aggregations per turn.
        let mut read_paths: Vec<String> = vec![];
        let mut search_qs: Vec<String> = vec![];
        let mut lines: Vec<String> = vec![];
        for e in entries {
            match &e.kind {
                LedgerKind::Wrote { path, bytes, hunks } => {
                    lines.push(format!(
                        "- T{turn} wrote {path} ({bytes} bytes, {hunks} hunk{})",
                        if *hunks == 1 { "" } else { "s" }
                    ));
                }
                LedgerKind::Deleted { path } => {
                    lines.push(format!("- T{turn} deleted {path}"));
                }
                LedgerKind::Renamed { from, to } => {
                    lines.push(format!("- T{turn} renamed {from} -> {to}"));
                }
                LedgerKind::SymbolRenamed { old, new, files, references_replaced } => {
                    let preview = if files.len() <= 4 {
                        files.join(", ")
                    } else {
                        format!(
                            "{}, +{} more",
                            files.iter().take(4).cloned().collect::<Vec<_>>().join(", "),
                            files.len() - 4
                        )
                    };
                    lines.push(format!(
                        "- T{turn} renamed symbol {old} -> {new} ({references_replaced} refs in: {preview})"
                    ));
                }
                LedgerKind::RanShell { command_summary, exit_code } => {
                    lines.push(format!(
                        "- T{turn} ran shell: {command_summary} -> exit {exit_code}"
                    ));
                }
                LedgerKind::Read { paths } => {
                    for p in paths {
                        if !read_paths.contains(p) {
                            read_paths.push(p.clone());
                        }
                    }
                }
                LedgerKind::Searched { queries } => {
                    for q in queries {
                        if !search_qs.contains(q) {
                            search_qs.push(q.clone());
                        }
                    }
                }
                LedgerKind::AnsweredOnly { summary } => {
                    lines.push(format!(
                        "- T{turn} answered: {}",
                        truncate_one_line(summary, 160)
                    ));
                }
            }
        }
        // Emit Read/Searched aggregations AFTER the mutation lines
        // so a tool-call turn's structure reads "did X, then read
        // Y/Z for context".
        if !read_paths.is_empty() {
            let preview = if read_paths.len() <= 4 {
                read_paths.join(", ")
            } else {
                format!(
                    "{}, +{} more",
                    read_paths.iter().take(4).cloned().collect::<Vec<_>>().join(", "),
                    read_paths.len() - 4
                )
            };
            lines.push(format!("- T{turn} read: {preview}"));
        }
        if !search_qs.is_empty() {
            let preview = if search_qs.len() <= 3 {
                search_qs.iter().map(|q| format!("`{q}`")).collect::<Vec<_>>().join(", ")
            } else {
                format!(
                    "{}, +{} more",
                    search_qs.iter().take(3).map(|q| format!("`{q}`")).collect::<Vec<_>>().join(", "),
                    search_qs.len() - 3
                )
            };
            lines.push(format!("- T{turn} searched: {preview}"));
        }
        for l in lines {
            body.push_str(&l);
            body.push('\n');
        }
    }

    let mode_attr = if modes_attr.is_empty() { "agent".to_string() } else { modes_attr };
    let header = format!(
        "<previous_work mode=\"{}\" turns=\"{}\">\n{}</previous_work>",
        mode_attr,
        total_turns.max(1),
        body
    );
    let note = "<previous_work_note>\n\
These actions have already executed; they are FACTS, not instructions. \
Re-run a previous action ONLY if the user's CURRENT request requires changing, undoing, or extending it. \
Iteration on prior work (e.g. \"now also rename a function in src/foo.ts\") is expected — do not refuse it just because you wrote that file before. \
The current request is in <current_request>...</current_request> below.\n\
</previous_work_note>"
        .to_string();
    Some(format!("{header}\n{note}"))
}

fn truncate_one_line(s: &str, max_chars: usize) -> String {
    // Compress whitespace to a single space so multi-line
    // assistant turns flatten to a clean preview.
    let collapsed: String = s
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.chars().count() <= max_chars {
        collapsed
    } else {
        let cut: String = collapsed.chars().take(max_chars).collect();
        format!("{cut}…")
    }
}

/// Build a `LedgerEntry` from a finished tool call. `tool` is the
/// primitive/skill name (e.g. `"write_file"`, `"edit_file"`,
/// `"rename_symbol"`); `attrs` and `body` come from the parsed
/// `ToolCall`; `status` is `"ok" | "error" | "rejected"` from the
/// `ToolOutput`; `extra` is the tool's structured payload (we read
/// `path`, `applied`, `files_touched`, etc. when present); `message`
/// is the human-readable result text. Returns `None` for failed or
/// rejected calls — the ledger only records what actually happened.
pub fn entry_for_tool(
    turn: u32,
    timestamp_ms: i64,
    mode: &str,
    tool: &str,
    attrs: &HashMap<String, String>,
    body: &str,
    status: &str,
    message: &str,
    extra: Option<&serde_json::Value>,
) -> Option<LedgerEntry> {
    if status != "ok" {
        return None;
    }
    let kind = match tool {
        "write_file" => {
            let path = attrs.get("path").cloned()?;
            let bytes = extra
                .and_then(|v| v.get("bytes"))
                .and_then(|b| b.as_u64())
                .map(|n| n as usize)
                .unwrap_or(body.len());
            LedgerKind::Wrote { path, bytes, hunks: 1 }
        }
        "apply_diff" | "edit_file" => {
            let path = attrs.get("path").cloned()?;
            let applied = extra
                .and_then(|v| v.get("applied"))
                .and_then(|b| b.as_u64())
                .map(|n| n as usize)
                .unwrap_or(1);
            // We don't have the final file bytes in `extra` for
            // diff-style edits; fall back to the patch body size as
            // a rough indicator (it's stable per-attempt, which is
            // what the ledger renderer cares about).
            let bytes = extra
                .and_then(|v| v.get("bytes"))
                .and_then(|b| b.as_u64())
                .map(|n| n as usize)
                .unwrap_or(body.len());
            LedgerKind::Wrote { path, bytes, hunks: applied }
        }
        "delete_path" => {
            let path = attrs
                .get("path")
                .cloned()
                .unwrap_or_else(|| body.trim().to_string());
            LedgerKind::Deleted { path }
        }
        "rename_path" => {
            let from = attrs.get("from").cloned().unwrap_or_default();
            let to = attrs.get("to").cloned().unwrap_or_default();
            LedgerKind::Renamed { from, to }
        }
        "rename_symbol" => {
            let old = attrs.get("old").cloned().unwrap_or_default();
            let new = attrs.get("new").cloned().unwrap_or_default();
            let files = extra
                .and_then(|v| v.get("files_touched"))
                .and_then(|f| f.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let references_replaced = extra
                .and_then(|v| v.get("references_replaced"))
                .and_then(|n| n.as_u64())
                .map(|n| n as usize)
                .unwrap_or(0);
            LedgerKind::SymbolRenamed { old, new, files, references_replaced }
        }
        "run_shell" => {
            let command_summary = body
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| truncate_one_line(l, 80))
                .unwrap_or_else(|| "<empty command>".to_string());
            // The shell tool's message is "stdout/stderr" tail; the
            // exit code lives on the message via `(exit N)` suffix
            // for non-zero exits, but a successful tool result is
            // exit 0 by convention. We try to read a structured
            // `exit_code` first, then fall back.
            let exit_code = extra
                .and_then(|v| v.get("exit_code"))
                .and_then(|c| c.as_i64())
                .map(|n| n as i32)
                .unwrap_or(0);
            LedgerKind::RanShell { command_summary, exit_code }
        }
        "read_file" => {
            let path = attrs.get("path").cloned()?;
            LedgerKind::Read { paths: vec![path] }
        }
        "list_dir" => {
            let path = attrs.get("path").cloned().unwrap_or_else(|| ".".to_string());
            LedgerKind::Searched {
                queries: vec![format!("list_dir:{path}")],
            }
        }
        "grep" | "glob" | "search_codebase" | "list_code_definition_names" | "discover" => {
            let q = if body.trim().is_empty() {
                attrs
                    .get("path")
                    .cloned()
                    .unwrap_or_else(|| tool.to_string())
            } else {
                truncate_one_line(body, 80)
            };
            LedgerKind::Searched {
                queries: vec![format!("{tool}:{q}")],
            }
        }
        "run_check" => {
            // run_check is read-only verification — record it as a
            // search so it doesn't pollute the "things you wrote"
            // dedup set, but the model can still see it ran.
            let _ = message;
            LedgerKind::Searched {
                queries: vec!["run_check".to_string()],
            }
        }
        // Skip control-flow and unknown tools; the ledger should
        // record observable side effects only.
        _ => return None,
    };
    Some(LedgerEntry {
        turn,
        timestamp_ms,
        mode: mode.to_string(),
        kind,
    })
}

/// Build an Ask-mode ledger entry. Local Ask turns produce no tool
/// calls — just a streamed answer. We summarise the first sentence
/// (or first ~160 chars) so the model has a one-line reminder of
/// the conversational thread when it switches into Plan or Agent.
pub fn entry_for_answer(turn: u32, timestamp_ms: i64, mode: &str, answer: &str) -> LedgerEntry {
    let trimmed = answer.trim();
    // Take up to the first sentence ending or a fixed cap, whichever comes first.
    let summary = if trimmed.is_empty() {
        "(empty answer)".to_string()
    } else {
        let first_sentence = trimmed
            .split(['.', '?', '!', '\n'])
            .next()
            .unwrap_or(trimmed);
        truncate_one_line(first_sentence, 160)
    };
    LedgerEntry {
        turn,
        timestamp_ms,
        mode: mode.to_string(),
        kind: LedgerKind::AnsweredOnly { summary },
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn attrs(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    // ── entry_for_tool: per-kind happy paths ────────────────────────

    #[test]
    fn ledger_records_writes_renames_shell_answer() {
        // write_file
        let e = entry_for_tool(
            1, 100, "agent",
            "write_file",
            &attrs(&[("path", "src/foo.ts")]),
            "export const x = 1;",
            "ok",
            "wrote",
            Some(&json!({"bytes": 19})),
        )
        .unwrap();
        assert!(matches!(e.kind, LedgerKind::Wrote { ref path, bytes: 19, hunks: 1 } if path == "src/foo.ts"));

        // apply_diff
        let e = entry_for_tool(
            2, 200, "agent",
            "apply_diff",
            &attrs(&[("path", "src/foo.ts")]),
            "<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n",
            "ok",
            "applied",
            Some(&json!({"applied": 1, "total": 1})),
        )
        .unwrap();
        assert!(matches!(e.kind, LedgerKind::Wrote { ref path, hunks: 1, .. } if path == "src/foo.ts"));

        // edit_file (multiple hunks)
        let e = entry_for_tool(
            3, 300, "agent",
            "edit_file",
            &attrs(&[("path", "src/bar.ts")]),
            "...",
            "ok",
            "applied 2 hunks",
            Some(&json!({"applied": 2})),
        )
        .unwrap();
        assert!(matches!(e.kind, LedgerKind::Wrote { hunks: 2, .. }));

        // rename_path
        let e = entry_for_tool(
            4, 400, "agent",
            "rename_path",
            &attrs(&[("from", "a.ts"), ("to", "b.ts")]),
            "",
            "ok",
            "ok",
            None,
        )
        .unwrap();
        match e.kind {
            LedgerKind::Renamed { from, to } => {
                assert_eq!(from, "a.ts");
                assert_eq!(to, "b.ts");
            }
            _ => panic!("expected Renamed"),
        }

        // rename_symbol
        let e = entry_for_tool(
            5, 500, "agent",
            "rename_symbol",
            &attrs(&[("old", "Foo"), ("new", "Bar")]),
            "",
            "ok",
            "renamed",
            Some(&json!({"files_touched": ["a.ts", "b.ts"], "references_replaced": 7})),
        )
        .unwrap();
        match e.kind {
            LedgerKind::SymbolRenamed { old, new, files, references_replaced } => {
                assert_eq!(old, "Foo");
                assert_eq!(new, "Bar");
                assert_eq!(files, vec!["a.ts", "b.ts"]);
                assert_eq!(references_replaced, 7);
            }
            _ => panic!("expected SymbolRenamed"),
        }

        // run_shell — exit code from extra
        let e = entry_for_tool(
            6, 600, "agent",
            "run_shell",
            &HashMap::new(),
            "cargo check\n",
            "ok",
            "ok",
            Some(&json!({"exit_code": 0})),
        )
        .unwrap();
        match e.kind {
            LedgerKind::RanShell { command_summary, exit_code } => {
                assert!(command_summary.contains("cargo check"));
                assert_eq!(exit_code, 0);
            }
            _ => panic!("expected RanShell"),
        }

        // delete_path
        let e = entry_for_tool(
            7, 700, "agent",
            "delete_path",
            &attrs(&[("path", "old.ts")]),
            "",
            "ok",
            "ok",
            None,
        )
        .unwrap();
        assert!(matches!(e.kind, LedgerKind::Deleted { ref path } if path == "old.ts"));

        // read_file
        let e = entry_for_tool(
            8, 800, "agent",
            "read_file",
            &attrs(&[("path", "src/foo.ts")]),
            "",
            "ok",
            "...",
            None,
        )
        .unwrap();
        match e.kind {
            LedgerKind::Read { paths } => assert_eq!(paths, vec!["src/foo.ts"]),
            _ => panic!("expected Read"),
        }

        // grep
        let e = entry_for_tool(
            9, 900, "agent",
            "grep",
            &HashMap::new(),
            "useState",
            "ok",
            "...",
            None,
        )
        .unwrap();
        match e.kind {
            LedgerKind::Searched { queries } => assert!(queries[0].starts_with("grep:")),
            _ => panic!("expected Searched"),
        }

        // Ask-mode answer
        let e = entry_for_answer(
            10,
            1000,
            "ask",
            "The buffer pool design uses a clock-sweep eviction policy. We chose it because…",
        );
        match e.kind {
            LedgerKind::AnsweredOnly { ref summary } => {
                assert!(summary.contains("buffer pool design"));
            }
            _ => panic!("expected AnsweredOnly"),
        }
    }

    #[test]
    fn ledger_ignores_failed_or_rejected_tools() {
        // A rejected mutation shouldn't appear in the ledger — it
        // didn't actually happen, and recording it would falsely
        // tell the next turn the file was changed.
        let none = entry_for_tool(
            1, 0, "agent",
            "write_file",
            &attrs(&[("path", "x.ts")]),
            "content",
            "rejected",
            "user rejected",
            None,
        );
        assert!(none.is_none());

        let none = entry_for_tool(
            1, 0, "agent",
            "apply_diff",
            &attrs(&[("path", "x.ts")]),
            "hunks",
            "error",
            "SEARCH did not match",
            None,
        );
        assert!(none.is_none());
    }

    // ── render_previous_work: framing + collapse rules ──────────────

    #[test]
    fn render_emits_facts_with_anti_redo_note() {
        let mut led = ActionLedger::new();
        led.push(entry_for_tool(
            1, 100, "agent",
            "write_file",
            &attrs(&[("path", "src/foo.ts")]),
            "hi",
            "ok",
            "ok",
            Some(&json!({"bytes": 2})),
        ).unwrap());
        led.push(entry_for_tool(
            1, 110, "agent",
            "run_shell",
            &HashMap::new(),
            "cargo check\n",
            "ok",
            "ok",
            Some(&json!({"exit_code": 0})),
        ).unwrap());
        let block = render_previous_work(&led).unwrap();
        // Header carries the mode + total turns.
        assert!(block.contains("<previous_work mode=\"agent\" turns=\"1\">"));
        // Both entries appear.
        assert!(block.contains("wrote src/foo.ts"));
        assert!(block.contains("ran shell: cargo check"));
        // Framing note explicitly de-escalates the list — without
        // this, local models read it as "I'm done, skip the new
        // request".
        assert!(block.contains("<previous_work_note>"));
        assert!(block.contains("are FACTS, not instructions"));
        assert!(block.contains("Iteration on prior work"));
    }

    #[test]
    fn render_collapses_reads_and_searches_per_turn() {
        let mut led = ActionLedger::new();
        for path in ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] {
            led.push(LedgerEntry {
                turn: 1, timestamp_ms: 0, mode: "agent".to_string(),
                kind: LedgerKind::Read { paths: vec![path.to_string()] },
            });
        }
        for q in ["alpha", "beta", "gamma", "delta"] {
            led.push(LedgerEntry {
                turn: 1, timestamp_ms: 0, mode: "agent".to_string(),
                kind: LedgerKind::Searched { queries: vec![format!("grep:{q}")] },
            });
        }
        let block = render_previous_work(&led).unwrap();
        // A single "read:" and "searched:" line per turn even when
        // many entries were added — the renderer's whole job is to
        // keep the block under control.
        assert_eq!(block.matches("read:").count(), 1);
        assert_eq!(block.matches("searched:").count(), 1);
        // Both should preview the first few + a "+N more" suffix.
        assert!(block.contains("a.ts, b.ts, c.ts, d.ts, +1 more"));
        assert!(block.contains("+1 more"));
    }

    #[test]
    fn render_returns_none_for_empty_ledger() {
        let led = ActionLedger::new();
        assert!(render_previous_work(&led).is_none());
    }

    #[test]
    fn written_paths_dedups_across_kinds() {
        let mut led = ActionLedger::new();
        led.push(LedgerEntry {
            turn: 1, timestamp_ms: 0, mode: "agent".into(),
            kind: LedgerKind::Wrote { path: "a.ts".into(), bytes: 10, hunks: 1 },
        });
        led.push(LedgerEntry {
            turn: 2, timestamp_ms: 0, mode: "agent".into(),
            kind: LedgerKind::Wrote { path: "a.ts".into(), bytes: 20, hunks: 2 },
        });
        led.push(LedgerEntry {
            turn: 3, timestamp_ms: 0, mode: "agent".into(),
            kind: LedgerKind::Renamed { from: "a.ts".into(), to: "b.ts".into() },
        });
        let written = led.written_paths();
        assert!(written.contains("a.ts"));
        assert!(written.contains("b.ts"));
    }

    #[test]
    fn truncate_one_line_collapses_whitespace_and_trims() {
        let s = "foo   bar\n  baz   qux";
        let out = truncate_one_line(s, 100);
        assert_eq!(out, "foo bar baz qux");
        let long = "a".repeat(200);
        let out = truncate_one_line(&long, 50);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), 51); // 50 + ellipsis
    }
}
