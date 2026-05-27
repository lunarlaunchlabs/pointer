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

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

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
    /// Truthy when we couldn't run git at all (binary missing, etc.).
    /// The UI uses this to silently degrade instead of showing scary
    /// errors on machines without git.
    pub error: Option<String>,
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
            // We just need XY and the path (last whitespace-separated token).
            if let Some(rest) = line.get(2..) {
                let mut parts = rest.splitn(9, ' ');
                let xy = parts.next().unwrap_or("");
                let path = parts.nth(7).unwrap_or("");
                if !path.is_empty() {
                    insert_status(status, xy, path, toplevel, workspace);
                }
            }
        }
        '2' => {
            // Renamed/copied: "2 XY <sub> ... <path>\t<orig>"
            if let Some(rest) = line.get(2..) {
                let mut parts = rest.splitn(10, ' ');
                let xy = parts.next().unwrap_or("");
                // Skip 7 fields, the 9th is "<X><score>", the 10th is the
                // path tuple separated by TAB.
                let path_tuple = parts.nth(8).unwrap_or("");
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

fn git_run(workspace: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(workspace)
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
pub async fn git_push(workspace: String) -> Result<String, String> {
    git_blocking(workspace, vec!["push".into()]).await
}

#[tauri::command]
pub async fn git_pull(workspace: String) -> Result<String, String> {
    git_blocking(workspace, vec!["pull".into(), "--ff-only".into()]).await
}

#[tauri::command]
pub async fn git_fetch(workspace: String) -> Result<String, String> {
    git_blocking(workspace, vec!["fetch".into()]).await
}

#[tauri::command]
pub async fn git_branches(workspace: String) -> Result<Vec<GitBranch>, String> {
    let out = tokio::task::spawn_blocking(move || {
        // Format: "%(HEAD) %(refname:short) %(committerdate:relative)"
        // %(HEAD) is "*" for the current branch.
        git_run(
            &workspace,
            &[
                "branch",
                "--list",
                "--all",
                "--sort=-committerdate",
                "--format=%(HEAD)\x1f%(refname:short)\x1f%(committerdate:relative)\x1f%(upstream:short)",
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
        let last_commit = parts.next().unwrap_or("").trim().to_string();
        let upstream = parts.next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        branches.push(GitBranch {
            name,
            current: head == "*",
            remote: false,
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

#[tauri::command]
pub async fn git_checkout(workspace: String, branch: String) -> Result<String, String> {
    git_blocking(workspace, vec!["checkout".into(), branch]).await
}

#[tauri::command]
pub async fn git_create_branch(workspace: String, branch: String) -> Result<String, String> {
    git_blocking(workspace, vec!["checkout".into(), "-b".into(), branch]).await
}

#[tauri::command]
pub async fn git_diff(workspace: String, path: String, staged: bool) -> Result<String, String> {
    let mut args = vec!["diff".to_string(), "--no-color".to_string()];
    if staged {
        args.push("--cached".to_string());
    }
    args.push("--".to_string());
    args.push(path);
    git_blocking(workspace, args).await
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
async fn git_blocking(workspace: String, args: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let out = Command::new("git")
            .current_dir(&workspace)
            .args(&args)
            .output()
            .map_err(|e| format!("{e}"))?;
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
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
