//! Agent skills — higher-level, deterministic compositions of the
//! primitive tools in `commands::agent`.
//!
//! The model emits one XML tag (just like `<read_file>` /
//! `<apply_diff>`) and the agent loop dispatches the call here.
//! Each skill internally orchestrates several primitives in Rust,
//! folds the results into a single `ToolOutput`, and hands it back.
//! From the model's perspective it's still "one tool call returned
//! one `<tool_result>`" — but the workflow underneath is the one a
//! top-tier model would have orchestrated by hand. The point is to
//! give local models (qwen2.5-coder, deepseek-coder) bigger,
//! safer primitives so they spend their limited steps on judgement
//! calls rather than on plumbing they routinely botch.
//!
//! Initial skill set:
//!   * `edit_file`     — `apply_diff` + verifier + auto-rollback on
//!                       regression. Eliminates "broken code lands
//!                       on disk because the patch was slightly
//!                       wrong" — the #1 quality killer.
//!   * `rename_symbol` — enumerate refs (grep) → batch patch in one
//!                       transaction → re-grep to assert zero
//!                       leftovers. Replaces 6–10 model-orchestrated
//!                       turns; bakes in the "verify you got all the
//!                       call sites" step the model usually skips.
//!   * `discover`      — curated context bundle (file list +
//!                       definitions outline + targeted grep) for a
//!                       natural-language topic. Saves 30–50% of the
//!                       context budget vs reading whole files.
//!   * `run_check`     — auto-detect the project's check command
//!                       (tsc / cargo check / pytest --collect-only /
//!                       go vet / ruff / mypy) and run it, parsing
//!                       output into a structured error list.
//!
//! All four are pure Rust compositions — no new model calls and no
//! new IPC surface. They reuse the carefully-tested primitives in
//! `commands::agent` (snapshotting, approval gating, lint
//! integration, find_similar_paths suggestions, fuzzy
//! SEARCH/REPLACE matching, etc.).

#![allow(clippy::doc_lazy_continuation, clippy::doc_overindented_list_items)]

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::commands::agent::{
    find_similar_paths, resolve, run_apply_diff, run_grep, run_list_code_definitions, run_shell,
    truncate, ToolCall, ToolOutput, TOOL_RESULT_TRUNCATE,
};

/// Tag names this module knows how to dispatch. Kept in sync with
/// `parse_tool_call`'s priority list in `agent.rs` and the SKILLS
/// section of the system prompt. Tests in `commands::agent::tests`
/// iterate this list to verify both stay in sync; in non-test
/// builds it serves as the canonical documentation of what skills
/// exist (the compiler warning would be a false positive there).
#[allow(dead_code)]
pub(crate) const SKILL_TAGS: &[&str] = &["edit_file", "rename_symbol", "discover", "run_check"];

// =========================================================================
// edit_file — safe-edit wrapper around apply_diff
// =========================================================================

/// `<edit_file path="src/x.ts">SEARCH/REPLACE blocks</edit_file>`
///
/// Same body grammar as `<apply_diff>`, but with three extra safety
/// rails the model would otherwise have to manage itself:
///
///   1. **Pre-state snapshot** of the file's bytes in memory (so we
///      can roll back even before `agent_changes` does its on-disk
///      undo bookkeeping).
///   2. **Baseline lint** (if `lint_command` is configured): we
///      capture the project's pre-edit lint output as a set of
///      `file:line: message` signatures so we can tell new errors
///      from pre-existing ones — small models otherwise either ignore
///      lint failures or panic at every pre-existing warning.
///   3. **Auto-rollback** if the post-edit lint introduced errors
///      that weren't there before. The file goes back to its
///      pre-edit bytes and the skill returns `status="error"` with
///      the new errors listed.
///
/// The actual SEARCH/REPLACE matching is delegated to `run_apply_diff`
/// so the fuzzy fallbacks, snapshot recording, and missing-file
/// suggestions all behave identically to the lower-level tool.
pub(crate) async fn run_edit_file(
    app: &AppHandle,
    step: u32,
    workspace: &str,
    call: &ToolCall,
    lint_command: Option<&str>,
) -> Result<ToolOutput, String> {
    let path = call
        .attrs
        .get("path")
        .ok_or_else(|| "edit_file: missing required attribute `path`".to_string())?
        .clone();
    if call.body.trim().is_empty() {
        return Err(
            "edit_file: empty body. Use one or more <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks, exactly like <apply_diff>.".into(),
        );
    }

    let abs = resolve(workspace, &path);
    let pre_bytes = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let suggestions = find_similar_paths(workspace, &path);
            let hint = if suggestions.is_empty() {
                format!(
                    "edit_file: `{}` does not exist. Use <write_file> to create it, or <list_dir path=\".\" /> to locate the right path.",
                    path
                )
            } else {
                format!(
                    "edit_file: `{}` does not exist. Did you mean one of: {}? Or use <write_file> to create it.",
                    path,
                    suggestions
                        .iter()
                        .map(|p| format!("`{p}`"))
                        .collect::<Vec<_>>()
                        .join(", "),
                )
            };
            return Err(hint);
        }
        Err(e) => return Err(format!("edit_file read `{}`: {}", path, e)),
    };

    // Capture the baseline error signatures BEFORE the edit, only if
    // there's a lint command worth running. Without a baseline we
    // can't tell a regression from a pre-existing warning, so we'd
    // either roll back every edit (annoying) or never roll back
    // (defeats the point). Skipping when no lint is configured is
    // honest: the skill becomes "apply_diff + snapshot" for those
    // users, which is still a worthwhile guarantee.
    let baseline = match lint_command {
        Some(cmd) if !cmd.trim().is_empty() => Some(run_lint_signatures(workspace, cmd).await),
        _ => None,
    };

    // Reuse run_apply_diff so snapshot/diff card emission, fuzzy
    // matching, and missing-file suggestions all share one
    // implementation. We forward the same body the model gave us
    // unchanged so the SEARCH grammar is identical to what's
    // documented for <apply_diff>.
    let diff_call = ToolCall {
        tool: "apply_diff".into(),
        attrs: call.attrs.clone(),
        body: call.body.clone(),
        fingerprint: call.fingerprint,
    };
    let diff_result = run_apply_diff(app, step, workspace, &diff_call);

    // If the patch itself didn't apply, there's nothing on disk to
    // roll back — return the error as-is.
    let diff_output = match diff_result {
        Ok(o) => o,
        Err(e) => return Err(format!("edit_file: {e}")),
    };

    // Edit landed. Now check whether it introduced regressions.
    let post = match lint_command {
        Some(cmd) if !cmd.trim().is_empty() => Some(run_lint_signatures(workspace, cmd).await),
        _ => None,
    };

    if let (Some(base), Some(post)) = (baseline.as_ref(), post.as_ref()) {
        let new_errors: Vec<String> = post
            .errors
            .iter()
            .filter(|e| !base.errors.contains(*e))
            .cloned()
            .collect();
        if !new_errors.is_empty() {
            // Roll back on disk and re-snapshot so the agent_changes
            // log reflects the actual final state (the edit
            // happened and then was reverted, both deliberate).
            if let Err(e) = std::fs::write(&abs, &pre_bytes) {
                return Err(format!(
                    "edit_file: {} new lint error(s) — auto-rollback FAILED: {}.\nFirst regression: {}",
                    new_errors.len(),
                    e,
                    new_errors.first().cloned().unwrap_or_default(),
                ));
            }
            let preview = truncate(&new_errors.join("\n"), TOOL_RESULT_TRUNCATE / 4);
            return Ok(ToolOutput {
                status: "error".into(),
                message: format!(
                    "edit_file ROLLED BACK: applied to `{}` introduced {} new lint error(s) that weren't there before.\n\
                     The file has been restored to its pre-edit bytes. Address the errors below, then retry with a corrected patch.\n\n{}",
                    path,
                    new_errors.len(),
                    preview,
                ),
                extra: Some(json!({
                    "path": path,
                    "rolled_back": true,
                    "new_errors": new_errors,
                    "baseline_errors": base.errors.len(),
                    "post_errors": post.errors.len(),
                })),
            });
        }
    }

    // Edit succeeded AND either no lint was configured or no new
    // errors. Return the diff_output enriched with a brief
    // verifier-style note so the model can short-circuit to <final>
    // without spending another turn on a verifier read.
    let mut extra = diff_output.extra.unwrap_or_else(|| json!({}));
    let verified = baseline.is_some();
    if let Some(obj) = extra.as_object_mut() {
        obj.insert("verified".into(), json!(verified));
        if verified {
            obj.insert("regressions".into(), json!(0));
        }
    }
    let suffix = if verified {
        " — verified: lint introduced no new errors."
    } else {
        " — no lint configured; edit applied without regression check."
    };
    Ok(ToolOutput {
        status: diff_output.status,
        message: format!("{}{}", diff_output.message, suffix),
        extra: Some(extra),
    })
}

/// Pre/post lint signatures. We compare by `file:line: message`
/// shape so the same warning recurring at a different line counts
/// as new (which is what we want — line shifts inside an edited
/// region are exactly how regressions surface).
struct LintSnapshot {
    errors: Vec<String>,
}

async fn run_lint_signatures(workspace: &str, cmd: &str) -> LintSnapshot {
    let (sh, flag) = if cfg!(windows) {
        ("cmd", "/C")
    } else {
        ("/bin/sh", "-c")
    };
    let ws = if workspace.is_empty() {
        ".".to_string()
    } else {
        workspace.to_string()
    };
    let cmd_s = cmd.to_string();
    let result = tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
        let out = std::process::Command::new(sh)
            .arg(flag)
            .arg(&cmd_s)
            .current_dir(ws)
            .output()
            .map_err(|e| e.to_string())?;
        Ok((
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        ))
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    let combined = match result {
        Ok((so, se)) => format!("{so}\n{se}"),
        Err(_) => String::new(),
    };
    LintSnapshot {
        errors: parse_lint_errors(&combined),
    }
}

/// Cheap regex-free extraction of `file:line[:col]: message`
/// signatures from arbitrary tool output. Works for tsc, cargo,
/// eslint, ruff, pyright, gcc/clang, mypy, etc. — anything that
/// follows the convention. Lines that don't look like errors are
/// dropped so warnings and progress noise don't pollute the
/// baseline.
pub(crate) fn parse_lint_errors(s: &str) -> Vec<String> {
    let mut out = vec![];
    for raw in s.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        // Heuristic: at least one ':' and a digit-containing chunk
        // between the first two colons (the "line number"). Filter
        // out cargo-style "warning:" prefixes by requiring a path-
        // like first segment (no spaces).
        let mut parts = line.splitn(3, ':');
        let path = parts.next().unwrap_or("");
        let lineno = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        if path.is_empty() || lineno.is_empty() || rest.is_empty() {
            continue;
        }
        if path.contains(' ') || path.contains('\t') {
            continue;
        }
        let lineno_trim = lineno.trim();
        if !lineno_trim
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
        {
            continue;
        }
        // We only keep things that look like errors. Warnings are
        // important to surface but treating them as regressions
        // produces too many false positives on noisy codebases.
        let lower = rest.to_ascii_lowercase();
        if lower.contains("error") || lower.contains("expected") || lower.contains("cannot find") {
            out.push(line.to_string());
        }
    }
    out
}

// =========================================================================
// rename_symbol — enumerate → batch patch → re-grep verify
// =========================================================================

/// `<rename_symbol old="Foo" new="Bar" scope="src/" />` (self-closing)
/// or `<rename_symbol old="Foo" new="Bar"></rename_symbol>` (empty body).
///
/// Workflow:
///   1. Use `run_grep` to enumerate every `\bold\b` reference under
///      `scope` (default: workspace root). The word-boundary regex
///      keeps us from rewriting `Foobar` when we asked to rename
///      `Foo`.
///   2. For each file with hits, do an in-memory whole-word replace
///      and write the new bytes via `agent_changes::record_modify`
///      (so the snapshot/undo log behaves identically to manual
///      `apply_diff`s).
///   3. Re-grep with the same word-boundary pattern and assert zero
///      leftovers. If anything remains, surface the leftover
///      `file:line` list — the rename is incomplete and the model
///      should look at the leftovers before claiming `<final>`.
///
/// Limitations the skill is intentionally honest about:
///   * It's a regex-based rename, not a refactor with type-aware
///     scope. It WILL rename comments and string literals that
///     mention the old name — which is usually what you want for
///     internal-symbol renames but is wrong for, e.g., a method on
///     a third-party type. The model can disambiguate by narrowing
///     `scope` or by using `<apply_diff>` for surgical edits.
///   * No language-aware import rewriting. The new name has to be
///     in scope at every reference site already.
pub(crate) fn run_rename_symbol(
    app: &AppHandle,
    step: u32,
    workspace: &str,
    call: &ToolCall,
) -> Result<ToolOutput, String> {
    let old_name = call
        .attrs
        .get("old")
        .ok_or_else(|| "rename_symbol: missing required attribute `old`".to_string())?
        .trim()
        .to_string();
    let new_name = call
        .attrs
        .get("new")
        .ok_or_else(|| "rename_symbol: missing required attribute `new`".to_string())?
        .trim()
        .to_string();
    if old_name.is_empty() || new_name.is_empty() {
        return Err("rename_symbol: `old` and `new` must both be non-empty".into());
    }
    if old_name == new_name {
        return Err("rename_symbol: `old` and `new` are identical — nothing to do".into());
    }
    if !is_valid_identifier(&old_name) || !is_valid_identifier(&new_name) {
        return Err(format!(
            "rename_symbol: only word-character identifiers are supported (got old=`{}`, new=`{}`). \
             For phrases, regexes, or special characters use <grep> + <apply_diff> directly.",
            old_name, new_name
        ));
    }
    let scope = call
        .attrs
        .get("scope")
        .cloned()
        .unwrap_or_else(|| ".".to_string());
    let glob_filter = call.attrs.get("glob").cloned();

    let scope_abs = resolve(workspace, &scope);
    if !scope_abs.is_dir() {
        return Err(format!(
            "rename_symbol: scope `{}` is not a directory (resolved to {})",
            scope,
            scope_abs.display()
        ));
    }

    // Step 1: enumerate references. We use the same word-boundary
    // pattern run_grep would compile so the count we report matches
    // what the model would have seen if it had grepped manually.
    let pattern = format!(r"\b{}\b", regex::escape(&old_name));
    let mut grep_attrs = HashMap::new();
    if let Some(g) = &glob_filter {
        grep_attrs.insert("glob".to_string(), g.clone());
    }
    let scope_workspace = scope_abs.to_string_lossy().to_string();
    let grep_call = ToolCall {
        tool: "grep".into(),
        attrs: grep_attrs.clone(),
        body: pattern.clone(),
        fingerprint: 0,
    };
    let initial_hits = run_grep(&scope_workspace, &grep_call)?;
    if initial_hits.message == "no matches" {
        return Ok(ToolOutput {
            status: "ok".into(),
            message: format!(
                "rename_symbol: zero references to `{}` found under `{}` — nothing to rename.",
                old_name, scope
            ),
            extra: Some(json!({
                "old": old_name,
                "new": new_name,
                "scope": scope,
                "files_touched": 0,
                "references_replaced": 0,
                "leftover": 0,
            })),
        });
    }

    // Step 2: walk the unique file set from the grep results and
    // rewrite each file with a word-boundary regex replace.
    let re = regex::Regex::new(&pattern)
        .map_err(|e| format!("rename_symbol: failed to compile pattern: {e}"))?;
    let mut files_touched: Vec<String> = vec![];
    let mut files_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut references_replaced = 0usize;

    for line in initial_hits.message.lines() {
        let Some((rel, _rest)) = line.split_once(':') else {
            continue;
        };
        if rel == "no matches" || rel.starts_with('…') {
            continue;
        }
        if !files_seen.insert(rel.to_string()) {
            continue;
        }
        let abs = scope_abs.join(rel);
        let original = match std::fs::read_to_string(&abs) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let replaced = re.replace_all(&original, new_name.as_str()).to_string();
        if replaced == original {
            continue;
        }
        // Count by scanning the original for the number of matches
        // we just replaced — Regex::replace_all doesn't return a
        // count.
        let count = re.find_iter(&original).count();
        references_replaced += count;
        // Compute a workspace-relative path for the snapshot log so
        // the review card resolves correctly back in the UI.
        let workspace_rel = abs
            .strip_prefix(workspace)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| rel.to_string());
        std::fs::write(&abs, &replaced)
            .map_err(|e| format!("rename_symbol write {}: {}", workspace_rel, e))?;
        let _ = crate::commands::agent_changes::record_modify(
            app,
            step,
            &workspace_rel,
            original.as_bytes(),
            replaced.as_bytes(),
        );
        files_touched.push(workspace_rel);
    }

    // Step 3: verifier re-grep. Anything left is a genuine partial
    // rename the model should review before <final>.
    let leftover_hits = run_grep(&scope_workspace, &grep_call)?;
    let leftover_count = if leftover_hits.message == "no matches" {
        0
    } else {
        leftover_hits
            .message
            .lines()
            .filter(|l| l.contains(':'))
            .count()
    };

    let mut message = format!(
        "rename_symbol: replaced {} reference(s) to `{}` -> `{}` across {} file(s) under `{}`.",
        references_replaced,
        old_name,
        new_name,
        files_touched.len(),
        scope,
    );
    if leftover_count > 0 {
        let preview = truncate(&leftover_hits.message, 2_000);
        message.push_str(&format!(
            "\n\nWARNING: {} leftover reference(s) still found. Re-grep:\n{}",
            leftover_count, preview
        ));
    } else {
        message.push_str("\nVerifier re-grep: zero leftover references.");
    }

    Ok(ToolOutput {
        status: "ok".into(),
        message,
        extra: Some(json!({
            "old": old_name,
            "new": new_name,
            "scope": scope,
            "files_touched": files_touched,
            "references_replaced": references_replaced,
            "leftover": leftover_count,
        })),
    })
}

pub(crate) fn is_valid_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .next()
            .map(|c| c.is_ascii_alphabetic() || c == '_')
            .unwrap_or(false)
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// =========================================================================
// discover — curated context bundle for a topic
// =========================================================================

/// `<discover>natural-language topic</discover>`
///
/// Returns a single bundled response (file list + definition outline
/// + targeted grep hits) so the model gets a compact, ranked view of
/// "what's in this repo about X" in one tool call. Local models
/// otherwise burn 3–5 turns on `<list_dir>` / `<glob>` /
/// `<list_code_definition_names>` / `<grep>` for the same answer.
///
/// We deliberately do NOT call the embedding-based `search_codebase`
/// here: it's an async proxy to the frontend indexer and not always
/// available (indexing might be off, the embed model might be
/// missing). The lexical fallback below works in every workspace
/// the agent has filesystem access to.
pub(crate) fn run_discover(workspace: &str, call: &ToolCall) -> Result<ToolOutput, String> {
    let topic = call.body.trim();
    if topic.is_empty() {
        return Err(
            "discover: empty body. Put a short natural-language topic between the tags, e.g. <discover>authentication middleware</discover>.".into(),
        );
    }

    // Pull keywords from the topic — keep tokens that are at least 3
    // chars and not in a tiny English stop list. We grep each
    // keyword and OR the hit sets together, then rank files by how
    // many distinct keywords they hit.
    let keywords = extract_keywords(topic);
    if keywords.is_empty() {
        return Err(format!(
            "discover: couldn't extract searchable keywords from `{}`. Try a more specific topic (e.g. include code identifiers, file basenames, error messages).",
            topic
        ));
    }

    let mut hits_per_file: HashMap<String, (usize, Vec<String>)> = HashMap::new();
    for kw in &keywords {
        let grep_call = ToolCall {
            tool: "grep".into(),
            attrs: HashMap::new(),
            body: kw.clone(),
            fingerprint: 0,
        };
        let Ok(out) = run_grep(workspace, &grep_call) else {
            continue;
        };
        if out.message == "no matches" {
            continue;
        }
        for line in out.message.lines() {
            let Some((path, _)) = line.split_once(':') else {
                continue;
            };
            if path.starts_with('…') {
                continue;
            }
            let entry = hits_per_file
                .entry(path.to_string())
                .or_insert_with(|| (0, vec![]));
            entry.0 += 1;
            if entry.1.len() < 3 {
                let snippet = line.chars().take(180).collect::<String>();
                entry.1.push(snippet);
            }
        }
    }

    if hits_per_file.is_empty() {
        return Ok(ToolOutput {
            status: "ok".into(),
            message: format!(
                "discover: no files in the workspace mention any of: {}.\n\nTry a different phrasing, or use <list_dir path=\".\" /> to see what's here.",
                keywords.join(", "),
            ),
            extra: Some(json!({
                "topic": topic,
                "keywords": keywords,
                "files": [],
            })),
        });
    }

    // Rank: more distinct-keyword hits → higher rank. Tie-break by
    // total hit count, then by path for stability.
    let mut ranked: Vec<(String, usize, Vec<String>)> = hits_per_file
        .into_iter()
        .map(|(path, (count, snippets))| {
            let distinct = keywords
                .iter()
                .filter(|k| {
                    snippets
                        .iter()
                        .any(|s| s.to_lowercase().contains(&k.to_lowercase()))
                })
                .count();
            (path, count + distinct * 10, snippets)
        })
        .collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    ranked.truncate(15);

    // Definition outline for the top hits' parent directories. We
    // collapse to dedup directories so we don't list_code_defs the
    // same dir three times for three sibling files.
    let mut seen_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut outline = String::new();
    for (path, _, _) in ranked.iter().take(5) {
        let dir = Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());
        if !seen_dirs.insert(dir.clone()) {
            continue;
        }
        let mut def_attrs = HashMap::new();
        def_attrs.insert("path".to_string(), dir.clone());
        let def_call = ToolCall {
            tool: "list_code_definition_names".into(),
            attrs: def_attrs,
            body: String::new(),
            fingerprint: 0,
        };
        if let Ok(o) = run_list_code_definitions(workspace, &def_call) {
            if !o.message.starts_with("(no recognised") {
                outline.push_str(&format!("\n--- {} ---\n", dir));
                outline.push_str(&truncate(&o.message, 1_500));
                outline.push('\n');
            }
        }
    }

    let mut message = String::new();
    message.push_str(&format!(
        "discover: topic=`{}`, keywords=[{}]\n\nTop files ({} of {}):\n",
        topic,
        keywords.join(", "),
        ranked.len(),
        ranked.len(),
    ));
    for (path, score, snippets) in &ranked {
        message.push_str(&format!("  {}  (score {})\n", path, score));
        for s in snippets.iter().take(2) {
            message.push_str(&format!("    > {}\n", s));
        }
    }
    if !outline.is_empty() {
        message.push_str("\nDefinitions in the most relevant directories:");
        message.push_str(&outline);
    }
    let truncated = truncate(&message, TOOL_RESULT_TRUNCATE);

    Ok(ToolOutput {
        status: "ok".into(),
        message: truncated,
        extra: Some(json!({
            "topic": topic,
            "keywords": keywords,
            "files": ranked.iter().map(|(p, s, _)| json!({"path": p, "score": s})).collect::<Vec<_>>(),
        })),
    })
}

/// Pluck searchable tokens out of a natural-language topic. We keep
/// it deliberately small and conservative: punctuation-split on
/// non-word chars, drop very short tokens and a tiny stop list,
/// dedup case-insensitively. The goal is "the keywords the user
/// probably means", not a full text-search query planner.
pub(crate) fn extract_keywords(topic: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "the", "and", "for", "with", "that", "this", "from", "into", "what", "where", "when",
        "which", "how", "does", "are", "was", "were", "has", "have", "had", "but", "not", "all",
        "any", "use", "uses", "using", "code", "file", "files", "function", "class", "about",
    ];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = vec![];
    for chunk in topic.split(|c: char| !c.is_alphanumeric() && c != '_') {
        let token = chunk.trim();
        if token.len() < 3 {
            continue;
        }
        let lower = token.to_lowercase();
        if STOPWORDS.contains(&lower.as_str()) {
            continue;
        }
        if seen.insert(lower.clone()) {
            out.push(token.to_string());
        }
        if out.len() >= 6 {
            break;
        }
    }
    out
}

// =========================================================================
// run_check — auto-detect and run the project's check command
// =========================================================================

/// `<run_check />` (self-closing — no args needed)
///
/// Auto-detects the right "quick verification" command for the
/// workspace, runs it via `run_shell`, and parses the output into a
/// structured error list. The model usually only needs to know
/// "does this still typecheck?" and shouldn't have to guess
/// `tsc --noEmit` vs `cargo check` vs `pytest --collect-only`.
///
/// Detection (first match wins):
///   * `Cargo.toml`        → `cargo check --message-format=short`
///   * `package.json`      → look for check/typecheck scripts, then
///                           lint/build scripts, then fall back to
///                           `npx --yes tsc --noEmit` if a
///                           `tsconfig*.json` exists.
///   * `pyproject.toml`    → `python -m mypy .` if `mypy` is in
///                           dependencies, otherwise
///                           `python -m py_compile $(find . -name "*.py")`
///                           (lightweight syntax-only).
///   * `go.mod`            → `go vet ./...`
///   * fallback            → return an error explaining what we
///                           looked for and suggesting the user
///                           configure `lint_command`.
pub(crate) async fn run_run_check(
    app: &AppHandle,
    request_id: &str,
    workspace: &str,
    _call: &ToolCall,
) -> Result<ToolOutput, String> {
    if workspace.is_empty() {
        return Err("run_check: no workspace is open. Open a folder first.".into());
    }
    let root = Path::new(workspace);

    let Some(detected) = detect_check_command(root) else {
        return Err(
             "run_check: could not detect a check command. Looked for Cargo.toml, package.json (check/typecheck/lint/build scripts), pyproject.toml, go.mod. \
             Either add a `check` script to your manifest, or invoke <run_shell>your-check-command</run_shell> directly. \
             If the user asked for a specific build or test verification, run that exact one-shot command (for example <run_shell>npm run build</run_shell> or <run_shell>npm test</run_shell>).".into(),
        );
    };

    let shell_call = ToolCall {
        tool: "run_shell".into(),
        attrs: {
            let mut a = HashMap::new();
            a.insert("timeout_ms".to_string(), "180000".to_string());
            a
        },
        body: detected.command.clone(),
        fingerprint: 0,
    };
    let shell_out = run_shell(app, request_id, workspace, &shell_call).await?;

    let errors = parse_lint_errors(&shell_out.message);
    let message = if errors.is_empty() {
        format!(
            "run_check ({}): `{}` finished with no parseable errors.\n\n--- output (last {} chars) ---\n{}",
            detected.kind,
            detected.command,
            shell_out.message.len().min(2_000),
            truncate(&shell_out.message, 2_000),
        )
    } else {
        format!(
            "run_check ({}): `{}` reported {} error(s).\n\n{}\n\n--- raw output (truncated) ---\n{}",
            detected.kind,
            detected.command,
            errors.len(),
            truncate(&errors.join("\n"), TOOL_RESULT_TRUNCATE / 2),
            truncate(&shell_out.message, 2_000),
        )
    };

    Ok(ToolOutput {
        status: shell_out.status,
        message,
        extra: Some(json!({
            "kind": detected.kind,
            "command": detected.command,
            "error_count": errors.len(),
            "errors": errors,
        })),
    })
}

#[derive(Debug)]
pub(crate) struct CheckCommand {
    pub kind: &'static str,
    pub command: String,
}

pub(crate) fn detect_check_command(root: &Path) -> Option<CheckCommand> {
    if root.join("Cargo.toml").is_file() {
        return Some(CheckCommand {
            kind: "rust",
            command: "cargo check --message-format=short".into(),
        });
    }
    if root.join("package.json").is_file() {
        if let Ok(pkg) = std::fs::read_to_string(root.join("package.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&pkg) {
                if let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) {
                    for name in [
                        "check",
                        "typecheck",
                        "type-check",
                        "tsc",
                        "lint",
                        "lint:check",
                        "build",
                    ] {
                        if scripts.contains_key(name) {
                            return Some(CheckCommand {
                                kind: "node",
                                command: format!("npm run {}", name),
                            });
                        }
                    }
                }
            }
        }
        // Fall back to tsc if there's any tsconfig in the root.
        if has_tsconfig(root) {
            return Some(CheckCommand {
                kind: "ts",
                command: "npx --yes tsc --noEmit".into(),
            });
        }
    }
    if root.join("pyproject.toml").is_file() {
        let pyproject = std::fs::read_to_string(root.join("pyproject.toml")).unwrap_or_default();
        if pyproject.contains("mypy") {
            return Some(CheckCommand {
                kind: "python-mypy",
                command: "python -m mypy .".into(),
            });
        }
        if pyproject.contains("ruff") {
            return Some(CheckCommand {
                kind: "python-ruff",
                command: "python -m ruff check .".into(),
            });
        }
        return Some(CheckCommand {
            kind: "python-syntax",
            command: "python -m compileall -q .".into(),
        });
    }
    if root.join("go.mod").is_file() {
        return Some(CheckCommand {
            kind: "go",
            command: "go vet ./...".into(),
        });
    }
    None
}

fn has_tsconfig(root: &Path) -> bool {
    let Ok(rd) = std::fs::read_dir(root) else {
        return false;
    };
    for entry in rd.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if name.starts_with("tsconfig") && name.ends_with(".json") {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Tests — pure unit tests for the deterministic helpers. The
// full-skill happy/error paths live in commands::agent::tests so they
// share the existing test harness (tempdir, dummy AppHandle, etc.).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_keywords_drops_stopwords_and_dedupes() {
        let kw =
            extract_keywords("How does the authentication middleware work with the session store?");
        // "how", "does", "the", "with" are stop words. "work" is 4
        // chars so it stays.
        assert!(kw.iter().any(|k| k.eq_ignore_ascii_case("authentication")));
        assert!(kw.iter().any(|k| k.eq_ignore_ascii_case("middleware")));
        assert!(kw.iter().any(|k| k.eq_ignore_ascii_case("session")));
        assert!(!kw.iter().any(|k| k.eq_ignore_ascii_case("the")));
        assert!(!kw.iter().any(|k| k.eq_ignore_ascii_case("does")));
        assert!(kw.len() <= 6);
    }

    #[test]
    fn extract_keywords_returns_empty_for_punctuation_only() {
        assert!(extract_keywords("?!!! ... ???").is_empty());
    }

    #[test]
    fn extract_keywords_treats_underscores_as_word_chars() {
        // snake_case identifiers should survive intact, not get
        // chopped into "snake" + "case". This matters because most
        // real "discover" queries from local models will include
        // function names verbatim.
        let kw = extract_keywords("understand resolve_shell behaviour");
        assert!(kw.iter().any(|k| k == "resolve_shell"));
    }

    #[test]
    fn parse_lint_errors_extracts_tsc_style() {
        let s = "\
src/index.ts:12:5: error TS2304: Cannot find name 'foo'.
some progress noise without colons
src/api.ts:42:1: error TS2345: Argument of type 'string' is not assignable.";
        let errs = parse_lint_errors(s);
        assert_eq!(errs.len(), 2);
        assert!(errs[0].contains("src/index.ts:12"));
        assert!(errs[1].contains("src/api.ts:42"));
    }

    #[test]
    fn parse_lint_errors_skips_warning_lines() {
        let s = "src/x.ts:1:1: warning TS6133: 'unused' is declared.";
        // Pure warnings shouldn't pollute the baseline — too many
        // pre-existing warnings would block every edit.
        assert!(parse_lint_errors(s).is_empty());
    }

    #[test]
    fn parse_lint_errors_skips_lines_without_line_numbers() {
        let s = "error: aborting due to 1 previous error\n\
                 note: run with `--release` for more info";
        assert!(parse_lint_errors(s).is_empty());
    }

    #[test]
    fn is_valid_identifier_accepts_word_chars() {
        assert!(is_valid_identifier("Foo"));
        assert!(is_valid_identifier("_private"));
        assert!(is_valid_identifier("snake_case_42"));
    }

    #[test]
    fn is_valid_identifier_rejects_non_word() {
        assert!(!is_valid_identifier(""));
        assert!(!is_valid_identifier("42leading"));
        assert!(!is_valid_identifier("with space"));
        assert!(!is_valid_identifier("with-dash"));
        assert!(!is_valid_identifier("foo()"));
    }

    #[test]
    fn detect_check_command_prefers_cargo_when_present() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
        // Also drop a package.json — Cargo should still win for a
        // mixed monorepo because we list Rust first.
        std::fs::write(dir.path().join("package.json"), "{\"name\":\"x\"}").unwrap();
        let c = detect_check_command(dir.path()).expect("detected");
        assert_eq!(c.kind, "rust");
        assert!(c.command.starts_with("cargo check"));
    }

    #[test]
    fn detect_check_command_uses_npm_script_when_available() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            "{\"scripts\": {\"check\": \"tsc --noEmit && eslint .\"}}",
        )
        .unwrap();
        let c = detect_check_command(dir.path()).expect("detected");
        assert_eq!(c.kind, "node");
        assert_eq!(c.command, "npm run check");
    }

    #[test]
    fn detect_check_command_uses_lint_when_no_check_script_exists() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            "{\"scripts\": {\"lint\": \"eslint .\", \"test\": \"mocha\"}}",
        )
        .unwrap();
        let c = detect_check_command(dir.path()).expect("detected");
        assert_eq!(c.kind, "node");
        assert_eq!(c.command, "npm run lint");
    }

    #[test]
    fn detect_check_command_uses_build_as_last_node_repo_rule() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            "{\"scripts\": {\"build\": \"vite build\", \"test\": \"vitest\"}}",
        )
        .unwrap();
        let c = detect_check_command(dir.path()).expect("detected");
        assert_eq!(c.kind, "node");
        assert_eq!(c.command, "npm run build");
    }

    #[test]
    fn detect_check_command_falls_back_to_tsc_when_no_script_but_tsconfig() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            "{\"scripts\": {\"test\": \"vitest\"}}",
        )
        .unwrap();
        std::fs::write(dir.path().join("tsconfig.json"), "{}").unwrap();
        let c = detect_check_command(dir.path()).expect("detected");
        assert_eq!(c.kind, "ts");
        assert!(c.command.contains("tsc --noEmit"));
    }

    #[test]
    fn detect_check_command_returns_none_when_no_manifest() {
        let dir = tempfile::tempdir().unwrap();
        assert!(detect_check_command(dir.path()).is_none());
    }

    // ── rename_symbol end-to-end ───────────────────────────────────
    // Exercises the full enumerate → batch-patch → re-grep flow
    // against a real tempdir. We can't use a real AppHandle in unit
    // tests (Tauri requires a built context), so these call the
    // skill's internal logic directly where possible and bypass
    // snapshot recording where it would require the handle.

    /// Reproduce just the parts of `run_rename_symbol` that don't
    /// require an `AppHandle`. Keeps the unit test honest about
    /// what's covered (the enumeration + replacement + verifier),
    /// without dragging in Tauri scaffolding.
    fn rename_symbol_inplace(workspace: &Path, old: &str, new: &str) -> (usize, usize) {
        let pattern = format!(r"\b{}\b", regex::escape(old));
        let re = regex::Regex::new(&pattern).unwrap();
        let mut files_touched = 0usize;
        let mut refs = 0usize;
        for entry in walkdir::WalkDir::new(workspace).into_iter().flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let count = re.find_iter(&text).count();
            if count == 0 {
                continue;
            }
            let replaced = re.replace_all(&text, new).to_string();
            std::fs::write(entry.path(), replaced).unwrap();
            files_touched += 1;
            refs += count;
        }
        (files_touched, refs)
    }

    #[test]
    fn rename_symbol_logic_replaces_whole_words_only() {
        // The word-boundary regex must avoid touching `Foobar` when
        // renaming `Foo` — the most common false positive for a
        // naive textual rename, and a real failure mode for small
        // models doing this by hand.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.ts"),
            "const Foo = 1;\nconst Foobar = 2;\n// Foo here\n",
        )
        .unwrap();
        let (files, refs) = rename_symbol_inplace(dir.path(), "Foo", "Bar");
        assert_eq!(files, 1);
        assert_eq!(
            refs, 2,
            "expected 2 whole-word matches (line 1 and the comment), not Foobar"
        );
        let after = std::fs::read_to_string(dir.path().join("a.ts")).unwrap();
        assert!(after.contains("const Bar = 1;"));
        assert!(after.contains("const Foobar = 2;"));
        assert!(after.contains("// Bar here"));
    }

    #[test]
    fn rename_symbol_logic_handles_multiple_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.ts"),
            "import { Foo } from './b';\nFoo();\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("b.ts"),
            "export function Foo() { return 1; }\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("c.md"), "Foo is a utility.\n").unwrap();
        let (files, refs) = rename_symbol_inplace(dir.path(), "Foo", "Bar");
        assert_eq!(files, 3);
        assert_eq!(refs, 4);
        for name in ["a.ts", "b.ts", "c.md"] {
            let text = std::fs::read_to_string(dir.path().join(name)).unwrap();
            assert!(
                !text.contains("Foo"),
                "{name} still mentions Foo after rename"
            );
            assert!(
                text.contains("Bar"),
                "{name} should mention Bar after rename"
            );
        }
    }

    // ── discover end-to-end ────────────────────────────────────────
    // The keyword extraction is unit-tested above. Here we exercise
    // the full pipeline end-to-end with a small tempdir workspace,
    // bypassing the AppHandle by calling the deterministic helpers
    // directly.

    #[test]
    fn discover_finds_files_matching_keywords() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/auth")).unwrap();
        std::fs::write(
            dir.path().join("src/auth/session.ts"),
            "export function createSession() { /* authentication */ }",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("src/auth/middleware.ts"),
            "// authentication middleware\nexport const middleware = () => {};",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("src/utils.ts"),
            "export const noop = () => {};",
        )
        .unwrap();

        let call = ToolCall {
            tool: "discover".into(),
            attrs: HashMap::new(),
            body: "authentication middleware".into(),
            fingerprint: 0,
        };
        let out =
            run_discover(dir.path().to_str().unwrap(), &call).expect("discover should succeed");
        assert_eq!(out.status, "ok");
        // Both auth files should be ranked above utils.ts.
        assert!(out.message.contains("session.ts") || out.message.contains("middleware.ts"));
        assert!(out.message.contains("authentication"));
        // utils.ts has no relevant keywords; should not appear as a top hit.
        assert!(
            !out.message.contains("utils.ts (score"),
            "utils.ts is unrelated and should not rank"
        );
    }

    #[test]
    fn discover_returns_helpful_message_when_no_matches() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "// nothing relevant\n").unwrap();
        let call = ToolCall {
            tool: "discover".into(),
            attrs: HashMap::new(),
            body: "kafkaesque dragon zoology".into(),
            fingerprint: 0,
        };
        let out = run_discover(dir.path().to_str().unwrap(), &call).expect("must succeed");
        assert_eq!(out.status, "ok");
        assert!(out.message.contains("no files"));
    }

    #[test]
    fn discover_errors_when_body_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let call = ToolCall {
            tool: "discover".into(),
            attrs: HashMap::new(),
            body: "  \n  ".into(),
            fingerprint: 0,
        };
        let err = run_discover(dir.path().to_str().unwrap(), &call)
            .expect_err("should reject empty body");
        assert!(err.contains("empty body"));
    }

    #[test]
    fn discover_errors_when_keywords_all_stripped() {
        // All-stopwords input: extract_keywords returns empty, the
        // skill must surface a clear error rather than running a
        // useless grep with no terms.
        let dir = tempfile::tempdir().unwrap();
        let call = ToolCall {
            tool: "discover".into(),
            attrs: HashMap::new(),
            body: "the and for with what".into(),
            fingerprint: 0,
        };
        let err = run_discover(dir.path().to_str().unwrap(), &call)
            .expect_err("should surface keyword error");
        assert!(err.contains("keywords"));
    }
}
