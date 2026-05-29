//! Read-only git status — branch, ahead/behind, dirty-file map.
//!
//! We shell out to the `git` binary instead of linking `git2` for two
//! reasons:
//!
//! 1. **Build portability** — `git2` pulls libgit2 via `openssl-sys` on
//!    some platforms, which is a long-standing source of cross-compile
//!    headaches.
//! 2. **Behavioural parity** — `git status --porcelain=v2` returns the
//!    *exact* set of statuses the user would see in their terminal,
//!    including their `.gitignore`/`.gitattributes` and any
//!    `core.autocrlf` quirks. Re-implementing that with libgit2 is
//!    surprisingly hard to get pixel-perfect.
//!
//! Performance: `git status` on the linux kernel checkout runs in ~200ms
//! cold and ~40ms warm. For typical project sizes we expect <50ms. We let
//! the frontend debounce + cache the result rather than doing it here.

use once_cell::sync::Lazy;
use portable_pty::{CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static GIT_CREDENTIAL_PROMPTS: Lazy<Mutex<HashMap<String, mpsc::Sender<Option<String>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_GIT_PROMPT_ID: AtomicU64 = AtomicU64::new(1);

/// One status letter per file. Mirrors `git status --porcelain` semantics
/// distilled to the categories the UI cares about. We *don't* try to
/// distinguish index vs worktree state for the FileTree decoration —
/// trying to combine `MM` (staged + worktree-modified) into a single dot
/// led to confusing dots in early prototypes. Instead we collapse to a
/// single "this file has changes" bucket and rely on the side panel for
/// detail.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitFileStatus {
    /// Untracked — file isn't in the index yet.
    Untracked,
    /// Modified in either index or worktree.
    Modified,
    /// Newly added to the index.
    Added,
    /// Deleted from worktree (may still be tracked).
    Deleted,
    /// Renamed (from -> to).
    Renamed,
    /// Has merge conflicts.
    Conflicted,
    /// Ignored by .gitignore. We surface this only if we ever extend
    /// `--ignored=traditional`; today we omit ignored files entirely.
    Ignored,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileEntry {
    pub path: String,
    pub status: GitFileStatus,
    /// True when the file has staged changes (X column non-blank).
    pub staged: bool,
    /// True when the file has unstaged worktree changes (Y column
    /// non-blank). A single path can be both staged AND unstaged
    /// when the user partially staged then kept editing.
    pub unstaged: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GitStatus {
    /// `true` when the workspace is a git repo (or inside one).
    pub is_repo: bool,
    /// Current branch name, e.g. "main". `None` on detached HEAD.
    pub branch: Option<String>,
    /// Commits ahead of upstream (None when there's no upstream).
    pub ahead: Option<u32>,
    /// Commits behind upstream.
    pub behind: Option<u32>,
    /// Map from *workspace-relative* path → collapsed status. Kept
    /// for backwards compatibility with the FileTree decorator.
    pub files: HashMap<String, GitFileStatus>,
    /// Per-file detail for the SCM panel — staged + unstaged buckets,
    /// rename info, conflict markers. Ordered so the UI can render
    /// without a re-sort.
    pub entries: Vec<GitFileEntry>,
    /// Total dirty file count — saves the frontend from re-summing.
    pub dirty_count: u32,
    /// Active repository operation, if any. Rebase/merge state lives
    /// in `.git`, so we compute it beside status rather than asking the
    /// frontend to scrape command output.
    pub operation: Option<GitOperationState>,
    /// Truthy when we couldn't run git at all (binary missing, etc.).
    /// The UI uses this to silently degrade instead of showing scary
    /// errors on machines without git.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitOperationKind {
    Rebase,
    Merge,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitOperationState {
    pub kind: GitOperationKind,
    pub title: String,
    pub head: Option<String>,
    pub target: Option<String>,
    pub current: Option<u32>,
    pub total: Option<u32>,
    pub conflicts: Vec<String>,
}

/// Return git status for `workspace`. Always returns a value — failure
/// modes are encoded inline in the struct (e.g. `is_repo: false`) so the
/// frontend doesn't need a try/catch wrapper on every poll.
#[tauri::command]
pub async fn git_status_for_workspace(workspace: String) -> Result<GitStatus, String> {
    let root = workspace.clone();
    // Move the work to a blocking thread — we shell out to a child
    // process and `tokio::process::Command` is overkill for a 50ms call.
    tokio::task::spawn_blocking(move || compute_status(&root))
        .await
        .map_err(|e| e.to_string())
}

fn compute_status(workspace: &str) -> GitStatus {
    let path = Path::new(workspace);
    if !path.exists() {
        return GitStatus::default();
    }

    // 1. Confirm we're inside a repo at all. `rev-parse --show-toplevel`
    //    is the canonical fast probe; if it exits non-zero we know git
    //    treats this folder as "not a repo" and we bail.
    let toplevel = match git_run(workspace, &["rev-parse", "--show-toplevel"]) {
        Ok(s) => s.trim().to_string(),
        Err(e) => {
            // Distinguish "git missing" from "not a repo" — the former is
            // a system condition we want to surface in logs, the latter is
            // routine.
            if e.contains("ENOENT") || e.to_lowercase().contains("not found") {
                return GitStatus {
                    error: Some("git binary not found in PATH".into()),
                    ..Default::default()
                };
            }
            return GitStatus::default();
        }
    };

    let mut status = GitStatus {
        is_repo: true,
        ..Default::default()
    };

    // 2. Branch + ahead/behind. `--branch -b` adds a header line. We also
    //    request porcelain=v2 because it includes machine-friendly fields
    //    like `oid`, rename arrows, etc.
    let porcelain = match git_run(
        workspace,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
            "-z",
        ],
    ) {
        Ok(s) => s,
        Err(e) => {
            status.error = Some(e);
            return status;
        }
    };

    // Records are NUL-separated because we passed `-z`. Renames use a
    // *second* NUL for the source name (i.e. `R rename` is followed by two
    // NUL-delimited filenames). We walk fields manually to avoid pulling
    // in a parser library.
    let bytes = porcelain.as_bytes();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let end = bytes[cursor..]
            .iter()
            .position(|&b| b == 0)
            .map(|i| cursor + i)
            .unwrap_or(bytes.len());
        let line = std::str::from_utf8(&bytes[cursor..end]).unwrap_or("");
        cursor = end + 1;
        if line.is_empty() {
            continue;
        }
        parse_porcelain_line(line, &mut status, &toplevel, workspace);
        // Rename records emit an additional path; the v2 format puts
        // the source path after `\t` already, so we don't need to peek
        // for an extra NUL block here.
    }

    status.operation = detect_operation(workspace, &status);
    status.dirty_count = status.files.len() as u32;
    status
}

/// Parse one porcelain=v2 record. The format is documented at
/// <https://git-scm.com/docs/git-status#_porcelain_format_version_2>.
fn parse_porcelain_line(line: &str, status: &mut GitStatus, toplevel: &str, workspace: &str) {
    let first = line.chars().next().unwrap_or(' ');
    match first {
        '#' => {
            // Branch header: "# branch.head main", "# branch.ab +1 -2".
            if let Some(rest) = line.strip_prefix("# branch.head ") {
                let trimmed = rest.trim();
                if trimmed != "(detached)" {
                    status.branch = Some(trimmed.to_string());
                }
            } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
                // `+N -M` -> ahead N, behind M.
                let mut parts = rest.split_whitespace();
                if let Some(a) = parts.next() {
                    if let Ok(n) = a.trim_start_matches('+').parse::<u32>() {
                        status.ahead = Some(n);
                    }
                }
                if let Some(b) = parts.next() {
                    if let Ok(n) = b.trim_start_matches('-').parse::<u32>() {
                        status.behind = Some(n);
                    }
                }
            }
        }
        '1' => {
            // Ordinary change: "1 XY <sub> <m> <m> <m> <h> <h> <path>"
            // We just need XY and the path. Split from the left only up
            // to the documented fields so paths containing spaces stay
            // intact in the final field.
            if let Some(rest) = line.get(2..) {
                let mut parts = rest.splitn(8, ' ');
                let xy = parts.next().unwrap_or("");
                let path = parts.nth(6).unwrap_or("");
                if !path.is_empty() {
                    insert_status(status, xy, path, toplevel, workspace);
                }
            }
        }
        '2' => {
            // Renamed/copied: "2 XY <sub> ... <path>\t<orig>"
            if let Some(rest) = line.get(2..) {
                let mut parts = rest.splitn(9, ' ');
                let xy = parts.next().unwrap_or("");
                // Skip through "<X><score>"; the final field is the path
                // tuple separated by TAB. The bounded split preserves spaces.
                let path_tuple = parts.nth(7).unwrap_or("");
                let new_path = path_tuple.split('\t').next().unwrap_or("");
                if !new_path.is_empty() {
                    let path = relative_to_workspace(new_path, toplevel, workspace);
                    let x = xy.chars().next().unwrap_or('.');
                    let y = xy.chars().nth(1).unwrap_or('.');
                    status.files.insert(path.clone(), GitFileStatus::Renamed);
                    status.entries.push(GitFileEntry {
                        path,
                        status: GitFileStatus::Renamed,
                        staged: x != '.' && x != ' ',
                        unstaged: y != '.' && y != ' ',
                    });
                }
            }
        }
        'u' => {
            // Unmerged (conflicted).
            if let Some(rest) = line.get(2..) {
                let parts: Vec<&str> = rest.split(' ').collect();
                if let Some(p) = parts.last() {
                    let path = relative_to_workspace(p, toplevel, workspace);
                    status.files.insert(path.clone(), GitFileStatus::Conflicted);
                    status.entries.push(GitFileEntry {
                        path,
                        status: GitFileStatus::Conflicted,
                        staged: false,
                        unstaged: true,
                    });
                }
            }
        }
        '?' => {
            if let Some(p) = line.strip_prefix("? ") {
                let path = relative_to_workspace(p, toplevel, workspace);
                status.files.insert(path.clone(), GitFileStatus::Untracked);
                status.entries.push(GitFileEntry {
                    path,
                    status: GitFileStatus::Untracked,
                    staged: false,
                    unstaged: true,
                });
            }
        }
        '!' => {
            if let Some(p) = line.strip_prefix("! ") {
                let path = relative_to_workspace(p, toplevel, workspace);
                status.files.insert(path, GitFileStatus::Ignored);
            }
        }
        _ => {}
    }
}

fn insert_status(status: &mut GitStatus, xy: &str, path: &str, toplevel: &str, workspace: &str) {
    // XY: first char = staged, second char = worktree.
    let x = xy.chars().next().unwrap_or('.');
    let y = xy.chars().nth(1).unwrap_or('.');
    let kind = match (x, y) {
        ('A', _) | (_, 'A') => GitFileStatus::Added,
        ('D', _) | (_, 'D') => GitFileStatus::Deleted,
        _ => GitFileStatus::Modified,
    };
    let path = relative_to_workspace(path, toplevel, workspace);
    status.files.insert(path.clone(), kind);
    status.entries.push(GitFileEntry {
        path,
        status: kind,
        staged: x != '.' && x != ' ',
        unstaged: y != '.' && y != ' ',
    });
}

/// Git reports paths relative to the *repo top-level*. The frontend treats
/// the workspace as the root; if the user opened a sub-directory of a
/// larger repo we need to skip the prefix so paths line up with the
/// FileTree.
fn relative_to_workspace(repo_path: &str, toplevel: &str, workspace: &str) -> String {
    // Normalise separators on Windows: git always emits forward slashes,
    // but Path joins use the OS sep. We keep the join output and only
    // convert separators at the very end.
    let abs = Path::new(toplevel).join(repo_path);
    match abs.strip_prefix(workspace) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => repo_path.to_string(),
    }
}

fn detect_operation(workspace: &str, status: &GitStatus) -> Option<GitOperationState> {
    let conflicts: Vec<String> = status
        .entries
        .iter()
        .filter(|entry| entry.status == GitFileStatus::Conflicted)
        .map(|entry| entry.path.clone())
        .collect();

    if let Some(path) = git_path(workspace, "rebase-merge").filter(|p| p.is_dir()) {
        return Some(read_rebase_state(&path, conflicts));
    }
    if let Some(path) = git_path(workspace, "rebase-apply").filter(|p| p.is_dir()) {
        return Some(read_rebase_state(&path, conflicts));
    }
    if let Some(path) = git_path(workspace, "MERGE_HEAD").filter(|p| p.exists()) {
        let target = read_first_line(&path).map(short_hash);
        let head = git_run(workspace, &["branch", "--show-current"])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        return Some(GitOperationState {
            kind: GitOperationKind::Merge,
            title: target
                .as_ref()
                .map(|t| format!("Merging {t}"))
                .unwrap_or_else(|| "Merge in progress".into()),
            head,
            target,
            current: None,
            total: None,
            conflicts,
        });
    }
    if let Some(path) = git_path(workspace, "CHERRY_PICK_HEAD").filter(|p| p.exists()) {
        let target = read_first_line(&path).map(short_hash);
        return Some(GitOperationState {
            kind: GitOperationKind::CherryPick,
            title: target
                .as_ref()
                .map(|t| format!("Cherry-picking {t}"))
                .unwrap_or_else(|| "Cherry-pick in progress".into()),
            head: None,
            target,
            current: None,
            total: None,
            conflicts,
        });
    }
    if let Some(path) = git_path(workspace, "REVERT_HEAD").filter(|p| p.exists()) {
        let target = read_first_line(&path).map(short_hash);
        return Some(GitOperationState {
            kind: GitOperationKind::Revert,
            title: target
                .as_ref()
                .map(|t| format!("Reverting {t}"))
                .unwrap_or_else(|| "Revert in progress".into()),
            head: None,
            target,
            current: None,
            total: None,
            conflicts,
        });
    }

    None
}

fn read_rebase_state(path: &Path, conflicts: Vec<String>) -> GitOperationState {
    let current = read_first_line(&path.join("msgnum")).and_then(|s| s.parse::<u32>().ok());
    let total = read_first_line(&path.join("end")).and_then(|s| s.parse::<u32>().ok());
    let head = read_first_line(&path.join("head-name")).map(clean_ref_name);
    let target = read_first_line(&path.join("onto")).map(short_hash);
    let progress = match (current, total) {
        (Some(c), Some(t)) => format!("Rebase {c} of {t}"),
        _ => "Rebase in progress".into(),
    };
    GitOperationState {
        kind: GitOperationKind::Rebase,
        title: progress,
        head,
        target,
        current,
        total,
        conflicts,
    }
}

fn git_path(workspace: &str, name: &str) -> Option<PathBuf> {
    let out = git_run(workspace, &["rev-parse", "--git-path", name]).ok()?;
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        Some(path)
    } else {
        Some(Path::new(workspace).join(path))
    }
}

fn read_first_line(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| s.lines().next().map(|line| line.trim().to_string()))
        .filter(|s| !s.is_empty())
}

fn clean_ref_name(s: String) -> String {
    s.trim()
        .strip_prefix("refs/heads/")
        .unwrap_or_else(|| s.trim())
        .to_string()
}

fn short_hash(s: String) -> String {
    let trimmed = s.trim();
    if trimmed.len() > 12 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        trimmed.chars().take(12).collect()
    } else {
        trimmed.to_string()
    }
}

fn git_run(workspace: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(workspace)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(args)
        .output()
        .map_err(|e| format!("{e}"))?;
    if !out.status.success() {
        // Most commands exit 128 with "not a git repository" — bubble it
        // up unchanged so the caller can match on it.
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// ──────────────────────────────────────────────────────────────────
// Write-side git commands — staging, commits, branch ops, sync.
// ──────────────────────────────────────────────────────────────────
//
// Each command shells out to `git` directly and returns the
// resulting stdout/stderr to the frontend so users can see what
// happened. We deliberately don't wrap these in fancy error types;
// the SCM panel renders the raw output in a tiny console pane
// because git's own messages are usually the most useful diagnostic
// (especially for merge / rebase failures).

#[tauri::command]
pub async fn git_stage(workspace: String, paths: Vec<String>) -> Result<String, String> {
    if paths.is_empty() {
        return git_blocking(workspace, vec!["add".into(), "-A".into()]).await;
    }
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths);
    git_blocking(workspace, args).await
}

#[tauri::command]
pub async fn git_unstage(workspace: String, paths: Vec<String>) -> Result<String, String> {
    if paths.is_empty() {
        return git_blocking(workspace, vec!["reset".into(), "HEAD".into()]).await;
    }
    let mut args = vec!["reset".to_string(), "HEAD".to_string(), "--".to_string()];
    args.extend(paths);
    git_blocking(workspace, args).await
}

#[tauri::command]
pub async fn git_discard(workspace: String, paths: Vec<String>) -> Result<String, String> {
    // Discard worktree changes. For untracked files this is a hard
    // delete — the SCM panel confirms first.
    if paths.is_empty() {
        return Err("no paths to discard".into());
    }
    let mut args = vec!["checkout".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    let _ = git_blocking(workspace.clone(), args).await?;
    // Some of those paths might be untracked — `checkout` won't
    // touch them. Run `clean -f` on the remaining ones.
    let mut clean_args = vec!["clean".to_string(), "-f".to_string(), "--".to_string()];
    clean_args.extend(paths);
    git_blocking(workspace, clean_args).await
}

#[tauri::command]
pub async fn git_commit(workspace: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message can't be empty".into());
    }
    git_blocking(workspace, vec!["commit".into(), "-m".into(), message]).await
}

#[tauri::command]
pub async fn git_push(app: AppHandle, workspace: String) -> Result<String, String> {
    git_blocking_interactive(app, workspace, vec!["push".into()]).await
}

#[tauri::command]
pub async fn git_pull(app: AppHandle, workspace: String) -> Result<String, String> {
    git_blocking_interactive(app, workspace, vec!["pull".into(), "--ff-only".into()]).await
}

#[tauri::command]
pub async fn git_fetch(app: AppHandle, workspace: String) -> Result<String, String> {
    git_blocking_interactive(app, workspace, vec!["fetch".into()]).await
}

#[tauri::command]
pub async fn git_credential_respond(id: String, response: Option<String>) -> Result<(), String> {
    let sender = GIT_CREDENTIAL_PROMPTS
        .lock()
        .map_err(|_| "credential prompt registry poisoned".to_string())?
        .remove(&id)
        .ok_or_else(|| "Git credential prompt expired".to_string())?;
    sender
        .send(response)
        .map_err(|_| "Git credential prompt is no longer waiting".to_string())
}

#[tauri::command]
pub async fn git_branches(workspace: String) -> Result<Vec<GitBranch>, String> {
    let out = tokio::task::spawn_blocking(move || {
        // %(HEAD) is "*" for the current branch. We keep the full ref
        // name too so the UI can distinguish local branches from
        // remotes while still showing the short label.
        git_run(
            &workspace,
            &[
                "branch",
                "--list",
                "--all",
                "--sort=-committerdate",
                "--format=%(HEAD)\x1f%(refname:short)\x1f%(refname)\x1f%(committerdate:relative)\x1f%(upstream:short)",
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut branches = Vec::new();
    for line in out.lines() {
        let mut parts = line.split('\x1f');
        let head = parts.next().unwrap_or("").trim();
        let name = parts.next().unwrap_or("").trim().to_string();
        let full_ref = parts.next().unwrap_or("").trim().to_string();
        let last_commit = parts.next().unwrap_or("").trim().to_string();
        let upstream = parts.next().unwrap_or("").trim().to_string();
        if name.is_empty() || name.ends_with("/HEAD") {
            continue;
        }
        let remote = full_ref.starts_with("refs/remotes/");
        branches.push(GitBranch {
            name,
            current: head == "*",
            remote,
            last_commit,
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream)
            },
        });
    }
    Ok(branches)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub last_commit: String,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitCredentialPrompt {
    pub id: String,
    pub prompt: String,
    pub secret: bool,
}

#[tauri::command]
pub async fn git_checkout(workspace: String, branch: String) -> Result<String, String> {
    git_blocking(workspace, vec!["checkout".into(), branch]).await
}

#[tauri::command]
pub async fn git_create_branch(workspace: String, branch: String) -> Result<String, String> {
    git_blocking(workspace, vec!["checkout".into(), "-b".into(), branch]).await
}

#[tauri::command]
pub async fn git_create_branch_from(
    workspace: String,
    branch: String,
    base: String,
    checkout: Option<bool>,
) -> Result<String, String> {
    if branch.trim().is_empty() {
        return Err("branch name can't be empty".into());
    }
    if base.trim().is_empty() {
        return Err("base branch can't be empty".into());
    }
    if checkout.unwrap_or(true) {
        git_blocking(
            workspace,
            vec![
                "checkout".into(),
                "-b".into(),
                branch.trim().into(),
                base.trim().into(),
            ],
        )
        .await
    } else {
        git_blocking(
            workspace,
            vec!["branch".into(), branch.trim().into(), base.trim().into()],
        )
        .await
    }
}

#[tauri::command]
pub async fn git_merge(workspace: String, target: String) -> Result<String, String> {
    if target.trim().is_empty() {
        return Err("merge target can't be empty".into());
    }
    git_blocking(workspace, vec!["merge".into(), target.trim().into()]).await
}

#[tauri::command]
pub async fn git_merge_continue(workspace: String) -> Result<String, String> {
    git_blocking(
        workspace,
        vec![
            "-c".into(),
            "core.editor=true".into(),
            "merge".into(),
            "--continue".into(),
        ],
    )
    .await
}

#[tauri::command]
pub async fn git_merge_abort(workspace: String) -> Result<String, String> {
    git_blocking(workspace, vec!["merge".into(), "--abort".into()]).await
}

#[tauri::command]
pub async fn git_rebase(workspace: String, target: String) -> Result<String, String> {
    if target.trim().is_empty() {
        return Err("rebase target can't be empty".into());
    }
    git_blocking(workspace, vec!["rebase".into(), target.trim().into()]).await
}

#[tauri::command]
pub async fn git_rebase_continue(workspace: String) -> Result<String, String> {
    git_blocking(
        workspace,
        vec![
            "-c".into(),
            "core.editor=true".into(),
            "rebase".into(),
            "--continue".into(),
        ],
    )
    .await
}

#[tauri::command]
pub async fn git_rebase_abort(workspace: String) -> Result<String, String> {
    git_blocking(workspace, vec!["rebase".into(), "--abort".into()]).await
}

#[tauri::command]
pub async fn git_diff(workspace: String, path: String, staged: bool) -> Result<String, String> {
    let mut args = vec!["diff".to_string(), "--no-color".to_string()];
    if staged {
        args.push("--cached".to_string());
    }
    args.push("--".to_string());
    args.push(path);
    git_blocking_readonly(workspace, args).await
}

/// Return the full contents of `path` as it exists at HEAD (the last
/// committed version) or in the index (staged). This is what the
/// side-by-side diff editor reads on the left side: a Monaco
/// `DiffEditor` then diffs it against the working-tree buffer the
/// user is editing on the right.
///
/// Returns an empty string for files that didn't exist in the requested
/// source — callers can treat that as "everything is added" without
/// needing a separate error code.
#[tauri::command]
pub async fn git_show_file(
    workspace: String,
    path: String,
    source: String,
) -> Result<String, String> {
    let spec = match source.as_str() {
        "head" => format!("HEAD:{}", path),
        "staged" | "index" => format!(":{}", path),
        other => return Err(format!("Unknown git source: {other}")),
    };
    let workspace_clone = workspace.clone();
    let res = tokio::task::spawn_blocking(move || {
        let out = Command::new("git")
            .current_dir(&workspace_clone)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .args(["show", &spec])
            .output()
            .map_err(|e| format!("{e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            // `path does not exist` is normal for new files — return an
            // empty string so the diff renders as an all-additions
            // diff rather than spamming the panel with an error.
            if err.contains("does not exist")
                || err.contains("exists on disk, but not in")
                || err.contains("path does not exist in")
                || err.contains("did not match any file")
            {
                Ok::<String, String>(String::new())
            } else {
                Err(err.trim().to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    res
}

/// One git blame entry per source line. Returned by `git_blame_file`
/// and consumed by the inline blame decoration. We keep the payload
/// small (short hash, author, summary, relative date) because Monaco
/// renders one of these per visible line and a per-line allocation
/// adds up fast in big files.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBlameLine {
    /// Full 40-char commit hash. Useful as a key for "show commit".
    pub hash: String,
    /// 8-char abbreviated hash for the gutter readout.
    pub short_hash: String,
    pub author: String,
    /// Relative date string ("3 weeks ago"). git formats this for us
    /// so we don't need to localise.
    pub date: String,
    /// First line of the commit message.
    pub summary: String,
    /// True if this line was added in the *first* commit of the
    /// blame — useful for hiding the "by …" annotation when the
    /// line is part of the initial import and the info is noise.
    pub boundary: bool,
}

/// Run `git blame --porcelain` and parse one entry per source line.
/// The porcelain format groups commits by header block, so we keep
/// a small commit cache to avoid allocating per-line strings for the
/// (very common) case of long runs of lines from the same commit.
///
/// Returns an empty vec for files that aren't tracked or have no
/// blame info (e.g. brand-new files) — callers treat that as "no
/// blame to show" without erroring.
#[tauri::command]
pub async fn git_blame_file(workspace: String, path: String) -> Result<Vec<GitBlameLine>, String> {
    let workspace_clone = workspace.clone();
    let path_clone = path.clone();
    tokio::task::spawn_blocking(move || {
        let out = Command::new("git")
            .current_dir(&workspace_clone)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .args(["blame", "--porcelain", "--", &path_clone])
            .output()
            .map_err(|e| format!("{e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            // Not tracked / no blame info: surface as empty rather
            // than a hard error so the UI degrades silently.
            if err.contains("no such path")
                || err.contains("is outside repository")
                || err.contains("does not exist")
                || err.contains("no commits yet")
            {
                return Ok::<Vec<GitBlameLine>, String>(Vec::new());
            }
            return Err(err.trim().to_string());
        }
        parse_blame_porcelain(&String::from_utf8_lossy(&out.stdout)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Default, Clone)]
struct BlameCommit {
    short_hash: String,
    author: String,
    date: String,
    summary: String,
    boundary: bool,
}

/// Parse the line-oriented `git blame --porcelain` output. The format
/// is:
///
/// ```text
/// <hash> <origLine> <finalLine> <numLines>
/// author <name>
/// author-time <epoch>
/// committer-time <epoch>
/// summary <subject>
/// boundary                  (optional)
/// previous <hash> <path>    (optional)
/// filename <path>
/// \t<source line>
/// ```
///
/// Subsequent groups for the same commit hash omit the metadata and
/// only emit `<hash> origLine finalLine` + filename + content. We
/// cache the most recently seen commit so we can fill those entries.
fn parse_blame_porcelain(input: &str) -> Result<Vec<GitBlameLine>, String> {
    let mut commits: HashMap<String, BlameCommit> = HashMap::new();
    let mut out: Vec<GitBlameLine> = Vec::new();
    let mut iter = input.lines().peekable();
    while let Some(line) = iter.next() {
        // Header line: <hash> <origLine> <finalLine> [numLines]
        if line.is_empty() {
            continue;
        }
        let header_parts: Vec<&str> = line.split_whitespace().collect();
        if header_parts.len() < 3 {
            // Stray line — bail rather than emit corrupt entries.
            continue;
        }
        let hash = header_parts[0].to_string();
        let mut commit = commits.get(&hash).cloned().unwrap_or_default();
        let mut have_metadata = false;
        // Consume header lines until we hit the tab-prefixed source line.
        while let Some(peek) = iter.peek() {
            if peek.starts_with('\t') {
                break;
            }
            have_metadata = true;
            let header = iter.next().unwrap();
            if let Some(rest) = header.strip_prefix("author ") {
                commit.author = rest.to_string();
            } else if let Some(rest) = header.strip_prefix("author-time ") {
                // Porcelain always emits author-time as an epoch
                // integer; we convert it to a relative string the
                // UI can show next to the line ("3 days ago").
                if let Ok(secs) = rest.parse::<i64>() {
                    commit.date = relative_from_epoch(secs);
                }
            } else if let Some(rest) = header.strip_prefix("summary ") {
                commit.summary = rest.to_string();
            } else if header == "boundary" {
                commit.boundary = true;
            }
            // We ignore previous/filename/committer/* — not used by UI.
        }
        if commit.short_hash.is_empty() {
            commit.short_hash = hash.chars().take(8).collect();
        }
        if have_metadata {
            commits.insert(hash.clone(), commit.clone());
        }
        // Consume the source line itself (we don't keep it; Monaco
        // already has the buffer).
        if let Some(_src) = iter.next() {
            out.push(GitBlameLine {
                hash: hash.clone(),
                short_hash: commit.short_hash.clone(),
                author: commit.author.clone(),
                date: commit.date.clone(),
                summary: commit.summary.clone(),
                boundary: commit.boundary,
            });
        }
    }
    Ok(out)
}

/// Convert an epoch-seconds timestamp into a coarse "X ago" string.
/// Resolution drops off the further back you go because nobody
/// cares whether something happened 3y vs 3y2mo ago.
fn relative_from_epoch(secs: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let diff = (now - secs).max(0);
    if diff < 60 {
        "just now".into()
    } else if diff < 3600 {
        format!("{}m ago", diff / 60)
    } else if diff < 86_400 {
        format!("{}h ago", diff / 3600)
    } else if diff < 86_400 * 14 {
        format!("{}d ago", diff / 86_400)
    } else if diff < 86_400 * 60 {
        format!("{}wk ago", diff / (86_400 * 7))
    } else if diff < 86_400 * 365 {
        format!("{}mo ago", diff / (86_400 * 30))
    } else {
        format!("{}y ago", diff / (86_400 * 365))
    }
}

#[tauri::command]
pub async fn git_log(workspace: String, limit: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 1000).to_string();
    let out = tokio::task::spawn_blocking(move || {
        // 0x1f field sep, %x00 record sep keeps multi-line commit
        // bodies safe inside %s%n%b.
        git_run(
            &workspace,
            &[
                "log",
                "-n",
                &limit,
                "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s",
                "--date=relative",
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut entries = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 6 {
            continue;
        }
        entries.push(GitLogEntry {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            author: parts[2].to_string(),
            email: parts[3].to_string(),
            relative_date: parts[4].to_string(),
            subject: parts[5].to_string(),
        });
    }
    Ok(entries)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub relative_date: String,
    pub subject: String,
}

/// Run an arbitrary git command on a blocking thread and return
/// both stdout and stderr (joined) so the SCM panel can render a
/// meaningful response — e.g. push errors include rejection
/// details on stderr and we don't want to swallow them.
async fn git_blocking_interactive(
    app: AppHandle,
    workspace: String,
    args: Vec<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git_pty_collect(app, workspace, args))
        .await
        .map_err(|e| e.to_string())?
}

fn run_git_pty_collect(
    app: AppHandle,
    workspace: String,
    args: Vec<String>,
) -> Result<String, String> {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new("git");
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.cwd(&workspace);
    cmd.env("GIT_TERMINAL_PROMPT", "1");
    cmd.env("GIT_OPTIONAL_LOCKS", "1");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn git {:?}: {e}", args))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone git pty reader: {e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take git pty writer: {e}"))?;

    let mut output = String::new();
    let mut recent = String::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                log::warn!("git {:?} pty read error: {}", args, e);
                break;
            }
        };
        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
        output.push_str(&chunk);
        recent.push_str(&chunk);
        if recent.len() > 4_000 {
            let keep_from = recent.len().saturating_sub(2_000);
            recent = recent[keep_from..].to_string();
        }

        if let Some(prompt) = detect_git_prompt(&recent) {
            let response = request_git_credential(&app, prompt)?;
            match response {
                Some(value) => {
                    writer
                        .write_all(value.as_bytes())
                        .and_then(|_| writer.write_all(b"\n"))
                        .and_then(|_| writer.flush())
                        .map_err(|e| format!("write git credential response: {e}"))?;
                    recent.clear();
                }
                None => {
                    let _ = child.kill();
                    return Err("Git authentication cancelled".into());
                }
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("wait for git {:?}: {e}", args))?;
    let clean = strip_ansi(&output).trim().to_string();
    if status.success() {
        Ok(clean)
    } else if clean.is_empty() {
        Err(format!(
            "git {:?} exited with {:?}",
            args,
            status.exit_code()
        ))
    } else {
        Err(clean)
    }
}

fn request_git_credential(
    app: &AppHandle,
    prompt: GitCredentialPromptCandidate,
) -> Result<Option<String>, String> {
    let id = format!(
        "git-credential-{}",
        NEXT_GIT_PROMPT_ID.fetch_add(1, Ordering::Relaxed)
    );
    let (tx, rx) = mpsc::channel();
    GIT_CREDENTIAL_PROMPTS
        .lock()
        .map_err(|_| "credential prompt registry poisoned".to_string())?
        .insert(id.clone(), tx);

    let payload = GitCredentialPrompt {
        id: id.clone(),
        prompt: prompt.prompt,
        secret: prompt.secret,
    };
    if let Err(e) = app.emit("git:credential-prompt", payload) {
        let _ = GIT_CREDENTIAL_PROMPTS
            .lock()
            .map(|mut prompts| prompts.remove(&id));
        return Err(format!("open Git credential prompt: {e}"));
    }

    let response = rx
        .recv_timeout(Duration::from_secs(300))
        .map_err(|_| "Git authentication timed out".to_string())?;
    let _ = GIT_CREDENTIAL_PROMPTS
        .lock()
        .map(|mut prompts| prompts.remove(&id));
    Ok(response)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitCredentialPromptCandidate {
    prompt: String,
    secret: bool,
}

fn detect_git_prompt(text: &str) -> Option<GitCredentialPromptCandidate> {
    let clean = strip_ansi(text).replace('\r', "\n");
    let lower = clean.to_lowercase();
    let promptish = lower.contains("enter passphrase for key")
        || lower.contains("passphrase for key")
        || lower.contains("password for ")
        || lower.contains("username for ")
        || lower.contains("are you sure you want to continue connecting");
    if !promptish {
        return None;
    }
    let prompt = clean
        .lines()
        .rev()
        .find(|line| {
            let l = line.to_lowercase();
            l.contains("passphrase")
                || l.contains("password for ")
                || l.contains("username for ")
                || l.contains("continue connecting")
        })
        .unwrap_or(clean.trim())
        .trim()
        .trim_end_matches(':')
        .to_string();
    if prompt.is_empty() {
        return None;
    }
    let lower_prompt = prompt.to_lowercase();
    let secret =
        !lower_prompt.contains("username for ") && !lower_prompt.contains("continue connecting");
    Some(GitCredentialPromptCandidate { prompt, secret })
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
                continue;
            }
        }
        out.push(c);
    }
    out
}

async fn git_blocking(workspace: String, args: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut last_err = String::new();
        for attempt in 0..8 {
            match run_git_collect(&workspace, &args, true) {
                Ok(out) => return Ok(out),
                Err(err) if is_git_lock_error(&err) => {
                    if attempt >= 7 {
                        return Err(lock_error_message(&err));
                    }
                    last_err = err;
                    thread::sleep(Duration::from_millis(120 + attempt as u64 * 80));
                }
                Err(err) => return Err(err),
            }
        }
        Err(lock_error_message(&last_err))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read-only Git calls must never contend with user writes. `git status`
/// can otherwise refresh the index and briefly create `.git/index.lock`,
/// which is exactly the kind of invisible IDE interference that makes
/// command-line `git add` feel haunted.
async fn git_blocking_readonly(workspace: String, args: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git_collect(&workspace, &args, false))
        .await
        .map_err(|e| e.to_string())?
}

fn run_git_collect(
    workspace: &str,
    args: &[String],
    allow_optional_locks: bool,
) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(workspace).args(args);
    if !allow_optional_locks {
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
    }
    let out = cmd.output().map_err(|e| format!("{e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if out.status.success() {
        let mut combined = stdout;
        if !stderr.is_empty() {
            if !combined.is_empty() {
                combined.push('\n');
            }
            combined.push_str(&stderr);
        }
        Ok(combined)
    } else {
        let mut msg = stderr.trim().to_string();
        if msg.is_empty() {
            msg = stdout.trim().to_string();
        }
        if msg.is_empty() {
            msg = format!("git {:?} exited with {}", args, out.status);
        }
        Err(msg)
    }
}

fn is_git_lock_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("index.lock")
        || (lower.contains("unable to create") && lower.contains(".lock"))
        || lower.contains("another git process seems to be running")
}

fn lock_error_message(message: &str) -> String {
    if message.trim().is_empty() {
        "Another Git operation is still holding the repository lock. Try again once it finishes."
            .into()
    } else {
        format!(
            "{message}\n\nPointer retried because Git reported a lock. If no Git command is running, remove the stale .git/index.lock file and try again."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2_staged_ordinary_entries() {
        let mut status = GitStatus {
            is_repo: true,
            ..Default::default()
        };

        parse_porcelain_line(
            "1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 db417a291329c14cf46aad741635fab0ce616933 e2e/debug-and-context.spec.ts",
            &mut status,
            "/repo",
            "/repo",
        );
        parse_porcelain_line(
            "1 M. N... 100644 100644 100644 2156d8d6fe74a74b985475d8a5dcf5ce10ffc128 f4b610d82594685f8800abf294c1eb3f17353977 src/file with spaces.ts",
            &mut status,
            "/repo",
            "/repo",
        );

        assert_eq!(status.entries.len(), 2);
        assert_eq!(status.entries[0].path, "e2e/debug-and-context.spec.ts");
        assert_eq!(status.entries[0].status, GitFileStatus::Added);
        assert!(status.entries[0].staged);
        assert!(!status.entries[0].unstaged);

        assert_eq!(status.entries[1].path, "src/file with spaces.ts");
        assert_eq!(status.entries[1].status, GitFileStatus::Modified);
        assert!(status.entries[1].staged);
        assert!(!status.entries[1].unstaged);
    }

    #[test]
    fn parses_porcelain_v2_renamed_entries() {
        let mut status = GitStatus {
            is_repo: true,
            ..Default::default()
        };

        parse_porcelain_line(
            "2 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 src/new name.ts\tsrc/old name.ts",
            &mut status,
            "/repo",
            "/repo",
        );

        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].path, "src/new name.ts");
        assert_eq!(status.entries[0].status, GitFileStatus::Renamed);
        assert!(status.entries[0].staged);
        assert!(!status.entries[0].unstaged);
    }

    #[test]
    fn recognizes_git_lock_failures_for_retry() {
        assert!(is_git_lock_error(
            "fatal: Unable to create '/repo/.git/index.lock': File exists."
        ));
        assert!(is_git_lock_error(
            "Another git process seems to be running in this repository"
        ));
        assert!(!is_git_lock_error("fatal: not a git repository"));
    }

    #[test]
    fn lock_retry_message_explains_stale_lock_recovery() {
        let msg =
            lock_error_message("fatal: Unable to create '/repo/.git/index.lock': File exists.");
        assert!(msg.contains("Pointer retried"));
        assert!(msg.contains(".git/index.lock"));
    }

    #[test]
    fn detects_git_passphrase_prompt_as_secret() {
        let prompt = detect_git_prompt("Enter passphrase for key '/Users/me/.ssh/id_ed25519': ")
            .expect("prompt");
        assert!(prompt.secret);
        assert!(prompt.prompt.contains("id_ed25519"));
    }

    #[test]
    fn detects_git_username_prompt_as_visible_input() {
        let prompt = detect_git_prompt("Username for 'https://github.com': ").expect("prompt");
        assert!(!prompt.secret);
        assert!(prompt.prompt.contains("github.com"));
    }

    #[test]
    fn parses_porcelain_blame_with_repeated_commits() {
        let input = "\
abc123abc123abc123abc123abc123abc123abc1 1 1 2\n\
author Alice\n\
author-mail <alice@example.com>\n\
author-time 1700000000\n\
author-tz +0000\n\
committer Alice\n\
committer-mail <alice@example.com>\n\
committer-time 1700000000\n\
committer-tz +0000\n\
summary first commit\n\
boundary\n\
filename src/lib.rs\n\
\tfn one() {}\n\
abc123abc123abc123abc123abc123abc123abc1 2 2\n\
filename src/lib.rs\n\
\tfn two() {}\n\
def456def456def456def456def456def456def4 3 3 1\n\
author Bob\n\
author-mail <bob@example.com>\n\
author-time 1700100000\n\
summary fix bug\n\
filename src/lib.rs\n\
\tfn three() {}\n";
        let lines = parse_blame_porcelain(input).expect("parse");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].author, "Alice");
        assert_eq!(lines[0].short_hash, "abc123ab");
        assert_eq!(lines[0].summary, "first commit");
        assert!(lines[0].boundary);
        assert_eq!(lines[1].author, "Alice", "second line reuses cached commit");
        assert!(lines[1].boundary);
        assert_eq!(lines[2].author, "Bob");
        assert_eq!(lines[2].summary, "fix bug");
        assert!(!lines[2].boundary);
    }

    #[test]
    fn relative_from_epoch_handles_recent_and_old() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert_eq!(relative_from_epoch(now), "just now");
        assert!(relative_from_epoch(now - 120).contains("m ago"));
        assert!(relative_from_epoch(now - 60 * 60 * 5).contains("h ago"));
        assert!(relative_from_epoch(now - 86_400 * 3).contains("d ago"));
        assert!(relative_from_epoch(now - 86_400 * 200).contains("mo ago"));
        assert!(relative_from_epoch(now - 86_400 * 700).contains("y ago"));
    }

    #[test]
    fn detects_rebase_operation_from_git_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let init = Command::new("git")
            .current_dir(dir.path())
            .args(["init"])
            .status()
            .expect("git init");
        assert!(init.success());

        let git_dir = dir.path().join(".git").join("rebase-merge");
        fs::create_dir_all(&git_dir).expect("rebase dir");
        fs::write(git_dir.join("msgnum"), "2\n").expect("msgnum");
        fs::write(git_dir.join("end"), "5\n").expect("end");
        fs::write(git_dir.join("head-name"), "refs/heads/feature\n").expect("head");
        fs::write(git_dir.join("onto"), "abc123abc123abc123\n").expect("onto");

        let status = GitStatus {
            is_repo: true,
            entries: vec![GitFileEntry {
                path: "src/lib.rs".into(),
                status: GitFileStatus::Conflicted,
                staged: false,
                unstaged: true,
            }],
            ..Default::default()
        };
        let op =
            detect_operation(dir.path().to_string_lossy().as_ref(), &status).expect("operation");
        assert_eq!(op.kind, GitOperationKind::Rebase);
        assert_eq!(op.current, Some(2));
        assert_eq!(op.total, Some(5));
        assert_eq!(op.head.as_deref(), Some("feature"));
        assert_eq!(op.target.as_deref(), Some("abc123abc123"));
        assert_eq!(op.conflicts, vec!["src/lib.rs"]);
    }

    #[tokio::test]
    async fn creates_branch_from_base_inside_temp_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_string_lossy().to_string();
        run_git_for_test(dir.path(), &["init", "-b", "main"]);
        fs::write(dir.path().join("README.md"), "hello\n").expect("readme");
        run_git_for_test(dir.path(), &["add", "README.md"]);
        run_git_for_test(
            dir.path(),
            &[
                "-c",
                "user.name=Pointer Test",
                "-c",
                "user.email=pointer@example.test",
                "commit",
                "-m",
                "initial",
            ],
        );

        let out = git_create_branch_from(
            root.clone(),
            "feature/git-workflow".into(),
            "main".into(),
            Some(true),
        )
        .await
        .expect("create branch");
        assert!(out.contains("feature/git-workflow") || out.is_empty());
        let branch = git_run(&root, &["branch", "--show-current"]).expect("branch");
        assert_eq!(branch.trim(), "feature/git-workflow");
    }

    fn run_git_for_test(path: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(path)
            .args(args)
            .status()
            .expect("git command");
        assert!(status.success(), "git {:?} failed", args);
    }
}
