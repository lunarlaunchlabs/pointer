use crate::error::{AppError, AppResult};
use crate::state::AppState;
use ignore::WalkBuilder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, State};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    /// Last modified time as a Unix epoch in seconds. `None` when the
    /// platform metadata didn't expose `modified()` (rare). The
    /// frontend formats this into "5m ago", "Mar 12" etc. for the
    /// file tree hover tooltip.
    pub mtime: Option<i64>,
}

fn canonical_within(workspace: &Path, target: &Path) -> AppResult<PathBuf> {
    // Canonicalize the workspace too. `state.workspace` is supposed to
    // hold the canonical form (see `read_workspace_tree` and
    // `watch_workspace`), but doing it here as well means a future
    // caller that forgets and stores a raw path won't reintroduce the
    // "path outside workspace" false-positive — the comparison below
    // is between two canonical paths either way.
    let workspace = dunce_like_canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    let abs = if target.is_absolute() {
        target.to_path_buf()
    } else {
        workspace.join(target)
    };
    let resolved = dunce_like_canonicalize(&abs)?;
    if !resolved.starts_with(&workspace) {
        return Err(AppError::Forbidden(resolved.display().to_string()));
    }
    Ok(resolved)
}

fn dunce_like_canonicalize(p: &Path) -> AppResult<PathBuf> {
    match std::fs::canonicalize(p) {
        Ok(c) => Ok(c),
        Err(_) => Ok(p.to_path_buf()),
    }
}

#[tauri::command]
pub async fn read_workspace_tree(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Vec<FsEntry>> {
    // Intentionally does NOT mutate `state.workspace`. The frontend
    // calls this command for both the workspace root AND every
    // subdirectory it expands in the file tree (toggle / expandTo /
    // refreshDir / buildContext's @folder resolver). Setting
    // `state.workspace` here would silently re-root the backend to a
    // subdirectory on every expand, after which opening a file
    // outside that subdir would trip `canonical_within`'s Forbidden
    // check (e.g. expand `src/`, click `README.md` → "path outside
    // workspace"). `watch_workspace` is the single source of truth
    // for `state.workspace`; `setRoot` on the frontend always calls
    // that before any tree reads.
    let _ = state; // suppress unused warning; kept for future use
    let root = PathBuf::from(&path);
    let root = std::fs::canonicalize(&root).unwrap_or(root);

    let mut out: Vec<FsEntry> = Vec::new();
    let walker = WalkBuilder::new(&root)
        .max_depth(Some(1))
        .git_ignore(true)
        .ignore(true)
        .hidden(false)
        .build();
    for dent in walker.flatten() {
        if dent.path() == root {
            continue;
        }
        let md = dent.metadata().ok();
        let mtime = md
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| {
                // System time can be before the Unix epoch on some
                // filesystems (network shares, faulty clocks). Map
                // those to None rather than crashing on the unwrap.
                t.duration_since(std::time::UNIX_EPOCH).ok()
            })
            .map(|d| d.as_secs() as i64);
        out.push(FsEntry {
            name: dent
                .path()
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            path: dent.path().display().to_string(),
            is_dir: md.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: md.as_ref().map(|m| m.len()),
            mtime,
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[tauri::command]
pub async fn read_text_file(state: State<'_, AppState>, path: String) -> AppResult<String> {
    let ws = state.workspace.lock().clone();
    let p = match ws {
        Some(w) => canonical_within(&w, Path::new(&path))?,
        None => PathBuf::from(&path),
    };
    let bytes = std::fs::read(&p)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
pub async fn write_text_file(
    state: State<'_, AppState>,
    path: String,
    contents: String,
) -> AppResult<()> {
    let ws = state.workspace.lock().clone();
    let p = match ws {
        Some(w) => {
            let abs = if Path::new(&path).is_absolute() {
                PathBuf::from(&path)
            } else {
                w.join(&path)
            };
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if !abs.starts_with(&w) {
                return Err(AppError::Forbidden(abs.display().to_string()));
            }
            abs
        }
        None => PathBuf::from(&path),
    };
    std::fs::write(&p, contents.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub async fn create_file(state: State<'_, AppState>, path: String) -> AppResult<()> {
    write_text_file(state, path, String::new()).await
}

#[tauri::command]
pub async fn create_dir(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let ws = state.workspace.lock().clone();
    let p = match ws {
        Some(w) => {
            let abs = if Path::new(&path).is_absolute() {
                PathBuf::from(&path)
            } else {
                w.join(&path)
            };
            if !abs.starts_with(&w) {
                return Err(AppError::Forbidden(abs.display().to_string()));
            }
            abs
        }
        None => PathBuf::from(&path),
    };
    std::fs::create_dir_all(&p)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_path(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let ws = state.workspace.lock().clone();
    let p = match ws {
        Some(w) => canonical_within(&w, Path::new(&path))?,
        None => PathBuf::from(&path),
    };
    let md = std::fs::metadata(&p)?;
    if md.is_dir() {
        std::fs::remove_dir_all(&p)?;
    } else {
        std::fs::remove_file(&p)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn rename_path(state: State<'_, AppState>, from: String, to: String) -> AppResult<()> {
    let ws = state.workspace.lock().clone();
    let (a, b) = match ws {
        Some(w) => (canonical_within(&w, Path::new(&from))?, {
            let abs = if Path::new(&to).is_absolute() {
                PathBuf::from(&to)
            } else {
                w.join(&to)
            };
            if !abs.starts_with(&w) {
                return Err(AppError::Forbidden(abs.display().to_string()));
            }
            abs
        }),
        None => (PathBuf::from(&from), PathBuf::from(&to)),
    };
    std::fs::rename(a, b)?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileHit {
    pub path: String,
    pub name: String,
}

#[tauri::command]
pub async fn search_files(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> AppResult<Vec<FileHit>> {
    let ws = state.workspace.lock().clone();
    let root = match ws {
        Some(w) => w,
        None => return Ok(vec![]),
    };
    let q = query.to_lowercase();
    let limit = limit.unwrap_or(50);
    let mut hits = Vec::new();

    let walker = WalkBuilder::new(&root)
        .git_ignore(true)
        .ignore(true)
        .hidden(false)
        .build();

    for dent in walker.flatten() {
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = dent.file_name().to_string_lossy().to_string();
        let path_str = dent.path().display().to_string();
        let path_lower = path_str.to_lowercase();
        if q.is_empty() || subsequence_match(&path_lower, &q) {
            hits.push(FileHit {
                path: path_str,
                name,
            });
            if hits.len() >= limit * 4 {
                break;
            }
        }
    }
    hits.sort_by_key(|h| h.path.len());
    hits.truncate(limit);
    Ok(hits)
}

/// Directory-only counterpart of `search_files`. Used by the chat /
/// agent mention picker when the user is in `@folder` mode — the
/// regular file search skips directories, so we'd return zero hits
/// otherwise. Honors `.gitignore` like the file walker.
///
/// The result mirrors `FileHit` for symmetry with `search_files`, but
/// every entry's `path` points at a directory. The frontend uses that
/// to render a `Folder` icon + the canonical `dir/` token.
#[tauri::command]
pub async fn search_directories(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> AppResult<Vec<FileHit>> {
    let ws = state.workspace.lock().clone();
    let root = match ws {
        Some(w) => w,
        None => return Ok(vec![]),
    };
    let q = query.to_lowercase();
    let limit = limit.unwrap_or(50);
    let mut hits = Vec::new();

    let walker = WalkBuilder::new(&root)
        .git_ignore(true)
        .ignore(true)
        .hidden(false)
        .build();

    for dent in walker.flatten() {
        if !dent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        // Skip the workspace root itself — listing the whole workspace
        // wouldn't be useful as an attachment.
        if dent.path() == root {
            continue;
        }
        let name = dent.file_name().to_string_lossy().to_string();
        let path_str = dent.path().display().to_string();
        let path_lower = path_str.to_lowercase();
        if q.is_empty() || subsequence_match(&path_lower, &q) {
            hits.push(FileHit {
                path: path_str,
                name,
            });
            if hits.len() >= limit * 4 {
                break;
            }
        }
    }
    hits.sort_by_key(|h| h.path.len());
    hits.truncate(limit);
    Ok(hits)
}

fn subsequence_match(haystack: &str, needle: &str) -> bool {
    let mut hi = haystack.chars();
    'outer: for nc in needle.chars() {
        for hc in hi.by_ref() {
            if hc == nc {
                continue 'outer;
            }
        }
        return false;
    }
    true
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextHit {
    pub path: String,
    pub line: usize,
    pub text: String,
    /// Byte offset where the match starts within `text` (UTF-8
    /// columns, 0-indexed). -1 when the offset can't be reliably
    /// reported (regex with newline-spanning matches, etc.). The UI
    /// uses this to render an inline highlight and to position the
    /// cursor when jumping to the hit.
    pub col: i32,
    /// Byte length of the match within `text`.
    pub match_len: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SearchOptions {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
}

#[tauri::command]
pub async fn search_text(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    options: Option<SearchOptions>,
) -> AppResult<Vec<TextHit>> {
    let ws = state.workspace.lock().clone();
    let root = match ws {
        Some(w) => w,
        None => return Ok(vec![]),
    };
    if query.is_empty() {
        return Ok(vec![]);
    }
    let opts = options.unwrap_or_default();
    let limit = limit.unwrap_or(200);

    // Compile the matcher once for the whole walk. We support three
    // search flavors: substring (default, case-insensitive), case-
    // sensitive substring, and regex. Whole-word wraps any of the
    // above with \b boundaries when regex is enabled, or post-
    // filters substring hits.
    let mut needle_owned = query.clone();
    if !opts.case_sensitive && !opts.regex {
        needle_owned = needle_owned.to_lowercase();
    }
    let regex = if opts.regex {
        let pattern = if opts.whole_word {
            format!(r"\b(?:{})\b", &query)
        } else {
            query.clone()
        };
        let mut builder = regex::RegexBuilder::new(&pattern);
        builder.case_insensitive(!opts.case_sensitive);
        match builder.build() {
            Ok(r) => Some(r),
            // Surface a clear error so the UI can show "invalid
            // regex" instead of zero results. We turn the regex
            // error into a runtime error which Tauri will propagate.
            Err(e) => {
                return Err(crate::error::AppError::Msg(format!("invalid regex: {e}")));
            }
        }
    } else {
        None
    };

    let mut hits = Vec::new();
    let walker = WalkBuilder::new(&root)
        .git_ignore(true)
        .ignore(true)
        .hidden(false)
        .build();
    'outer: for dent in walker.flatten() {
        if hits.len() >= limit {
            break;
        }
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let p = dent.path();
        let bytes = match std::fs::read(p) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if bytes.iter().take(8000).any(|&b| b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            // Find first match offset + length on the line, honoring
            // case + whole-word + regex options. Empty `col` (=-1)
            // means we matched but couldn't pin a column (multi-line
            // regex etc.). The UI uses col when present to position
            // the cursor on jump-to-hit.
            let mut col: i32 = -1;
            let mut match_len: u32 = 0;
            let mut matched = false;
            if let Some(rx) = &regex {
                if let Some(m) = rx.find(line) {
                    col = m.start() as i32;
                    match_len = (m.end() - m.start()) as u32;
                    matched = true;
                }
            } else {
                let haystack: std::borrow::Cow<str> = if opts.case_sensitive {
                    std::borrow::Cow::Borrowed(line)
                } else {
                    std::borrow::Cow::Owned(line.to_lowercase())
                };
                if let Some(idx) = haystack.find(needle_owned.as_str()) {
                    let ok = if opts.whole_word {
                        is_word_boundary_match(&haystack, idx, idx + needle_owned.len())
                    } else {
                        true
                    };
                    if ok {
                        col = idx as i32;
                        match_len = needle_owned.len() as u32;
                        matched = true;
                    }
                }
            }
            if matched {
                hits.push(TextHit {
                    path: p.display().to_string(),
                    line: i + 1,
                    text: line.trim_end().to_string(),
                    col,
                    match_len,
                });
                if hits.len() >= limit {
                    break 'outer;
                }
            }
        }
    }
    Ok(hits)
}

/// Word boundary test for substring searches when whole-word is
/// requested. A boundary exists when the character just outside
/// the match is not a word character (i.e. [a-zA-Z0-9_]). Avoids
/// pulling in regex just for substring searches.
fn is_word_boundary_match(haystack: &str, start: usize, end: usize) -> bool {
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let before_ok = start == 0
        || !haystack[..start]
            .chars()
            .last()
            .map(is_word)
            .unwrap_or(false);
    let after_ok =
        end >= haystack.len() || !haystack[end..].chars().next().map(is_word).unwrap_or(false);
    before_ok && after_ok
}

/// Workspace-wide replace. Performs the same scan as `search_text`
/// (so the UI count matches what gets replaced) and writes each
/// modified file once. Returns the number of files touched + total
/// replacements. The caller is expected to confirm with the user
/// BEFORE calling this; the operation is not transactional and
/// large repos can take a few seconds.
#[tauri::command]
pub async fn replace_text(
    state: State<'_, AppState>,
    query: String,
    replacement: String,
    options: Option<SearchOptions>,
) -> AppResult<ReplaceResult> {
    let ws = state.workspace.lock().clone();
    let root = match ws {
        Some(w) => w,
        None => return Err(crate::error::AppError::Msg("no workspace open".into())),
    };
    if query.is_empty() {
        return Err(crate::error::AppError::Msg("empty search query".into()));
    }
    let opts = options.unwrap_or_default();
    let regex = if opts.regex {
        let pattern = if opts.whole_word {
            format!(r"\b(?:{})\b", &query)
        } else {
            query.clone()
        };
        match regex::RegexBuilder::new(&pattern)
            .case_insensitive(!opts.case_sensitive)
            .build()
        {
            Ok(r) => Some(r),
            Err(e) => {
                return Err(crate::error::AppError::Msg(format!("invalid regex: {e}")));
            }
        }
    } else {
        None
    };

    let mut files_changed = 0u32;
    let mut replacements = 0u32;
    let walker = WalkBuilder::new(&root)
        .git_ignore(true)
        .ignore(true)
        .hidden(false)
        .build();
    for dent in walker.flatten() {
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let p = dent.path();
        let bytes = match std::fs::read(p) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if bytes.iter().take(8000).any(|&b| b == 0) {
            continue;
        }
        let original = String::from_utf8_lossy(&bytes).into_owned();
        let (new_text, count) = if let Some(rx) = &regex {
            let count = rx.find_iter(&original).count() as u32;
            if count == 0 {
                (None, 0)
            } else {
                let replaced = rx.replace_all(&original, replacement.as_str()).into_owned();
                (Some(replaced), count)
            }
        } else if opts.case_sensitive {
            let mut count = 0u32;
            let mut out = String::with_capacity(original.len());
            let mut rest = original.as_str();
            while let Some(idx) = rest.find(query.as_str()) {
                if opts.whole_word && !is_word_boundary_match(rest, idx, idx + query.len()) {
                    out.push_str(&rest[..idx + 1]);
                    rest = &rest[idx + 1..];
                    continue;
                }
                out.push_str(&rest[..idx]);
                out.push_str(&replacement);
                rest = &rest[idx + query.len()..];
                count += 1;
            }
            out.push_str(rest);
            if count == 0 {
                (None, 0)
            } else {
                (Some(out), count)
            }
        } else {
            // Case-insensitive non-regex replace. We have to walk
            // the lowercased copy but write from the original so
            // surrounding text keeps its case. Slightly more work
            // than the case-sensitive path but still O(n).
            let lower_haystack = original.to_lowercase();
            let lower_needle = query.to_lowercase();
            let mut count = 0u32;
            let mut out = String::with_capacity(original.len());
            let mut i = 0;
            while let Some(idx_rel) = lower_haystack[i..].find(&lower_needle) {
                let idx = i + idx_rel;
                let end = idx + lower_needle.len();
                if opts.whole_word && !is_word_boundary_match(&lower_haystack, idx, end) {
                    out.push_str(&original[i..idx + 1]);
                    i = idx + 1;
                    continue;
                }
                out.push_str(&original[i..idx]);
                out.push_str(&replacement);
                i = end;
                count += 1;
            }
            out.push_str(&original[i..]);
            if count == 0 {
                (None, 0)
            } else {
                (Some(out), count)
            }
        };
        if let Some(new_text) = new_text {
            std::fs::write(p, new_text)?;
            files_changed += 1;
            replacements += count;
        }
    }

    Ok(ReplaceResult {
        files_changed,
        replacements,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReplaceResult {
    pub files_changed: u32,
    pub replacements: u32,
}

#[tauri::command]
pub async fn watch_workspace(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<()> {
    let _ = state.cancels.lock().cancel("watch");
    let mut rx = state.cancels.lock().issue("watch");

    let app_handle = app.clone();
    // `watch_workspace` is the SOLE writer of `state.workspace`.
    // `read_workspace_tree` deliberately doesn't touch it (see the
    // comment there). We canonicalize before storing so the value
    // matches what `canonical_within` produces when it canonicalizes
    // target paths — without that, a workspace whose canonical form
    // differs from the raw path (symlinked folder, anything under
    // /tmp or /var on macOS that canonicalizes to /private/...,
    // a ~/code symlink to a mounted volume, etc.) makes every
    // `read_text_file` fail with `path outside workspace`.
    let path_buf = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let root_for_state = path_buf.clone();
    *state.workspace.lock() = Some(root_for_state);

    std::thread::spawn(move || {
        let (tx, rx_evt) = std::sync::mpsc::channel();
        let mut watcher: RecommendedWatcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                log::error!("watcher init failed: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&path_buf, RecursiveMode::Recursive) {
            log::error!("watch failed: {e}");
            return;
        }

        loop {
            // Check cancel non-blocking
            if rx.try_recv().is_ok() {
                break;
            }
            match rx_evt.recv_timeout(std::time::Duration::from_millis(500)) {
                Ok(Ok(event)) => {
                    let paths: Vec<String> = event
                        .paths
                        .into_iter()
                        .map(|p| p.display().to_string())
                        .collect();
                    let kind = format!("{:?}", event.kind);
                    let _ = app_handle.emit(
                        "fs:change",
                        serde_json::json!({"kind": kind, "paths": paths}),
                    );
                }
                Ok(Err(e)) => log::warn!("watch err: {e}"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        drop(watcher);
    });

    let _ = Arc::new(app);
    Ok(())
}

#[tauri::command]
pub async fn unwatch_workspace(state: State<'_, AppState>) -> AppResult<()> {
    state.cancels.lock().cancel("watch");
    Ok(())
}

/// Reveal a file or directory in the platform's file manager.
///
/// "Reveal" is meaningfully different from "open":
///   - macOS: `open -R <path>` opens Finder and selects the item without
///     launching whatever app is associated with the file extension.
///   - Windows: `explorer.exe /select,<path>` opens File Explorer with the
///     item highlighted.
///   - Linux: try the freedesktop org.freedesktop.FileManager1 D-Bus
///     interface (supported by Nautilus, Nemo, Dolphin, etc.) so we can
///     truly highlight the file; fall back to `xdg-open` on the *parent*
///     directory so we never accidentally launch the file in its default
///     application like the old shellOpen path did.
///
/// We deliberately run synchronously and don't wait for the GUI to load —
/// `open`/`explorer.exe` return immediately after dispatching to the OS.
#[tauri::command]
pub async fn reveal_in_filer(path: String) -> AppResult<()> {
    use std::process::Command;

    let p = PathBuf::from(&path);
    // Resolve symlinks etc. so the file manager doesn't get confused by a
    // path it won't recognise. If canonicalisation fails (e.g. the user
    // deleted the file between right-click and reveal), bail with a clean
    // error instead of silently no-oping.
    let resolved = std::fs::canonicalize(&p).unwrap_or(p);
    if !resolved.exists() {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("{} no longer exists", resolved.display()),
        )));
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&resolved)
            .spawn()
            .map_err(AppError::from)?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        // explorer.exe quirk: the /select, switch must be a single token,
        // no space after the comma. Quoting also matters when paths contain
        // spaces — Command::arg handles that for us.
        Command::new("explorer.exe")
            .arg(format!("/select,{}", resolved.display()))
            .spawn()
            .map_err(AppError::from)?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        // Try the freedesktop D-Bus interface first — most modern file
        // managers register it. If dbus-send isn't installed or no
        // implementer is listening we get a non-zero exit and fall through.
        let uri = format!("file://{}", resolved.display());
        let dbus_ok = Command::new("dbus-send")
            .args([
                "--session",
                "--print-reply",
                "--dest=org.freedesktop.FileManager1",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                &format!("array:string:{}", uri),
                "string:",
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if dbus_ok {
            return Ok(());
        }
        // Fallback: open the *parent* directory. This is strictly worse than
        // a real reveal (we can't highlight the file) but it's still vastly
        // better than launching the file in its associated app, which is
        // what the previous shellOpen-based path was accidentally doing.
        let dir = if resolved.is_dir() {
            resolved.as_path()
        } else {
            resolved.parent().unwrap_or(resolved.as_path())
        };
        Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(AppError::from)?;
        return Ok(());
    }

    // Unrecognised platform — let the caller surface an error rather than
    // silently doing nothing.
    #[allow(unreachable_code)]
    Err(AppError::Forbidden(
        "reveal_in_filer: unsupported platform".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// The root-cause of the "couldn't open file outside workspace"
    /// regression: when the FE expanded a subdirectory in the tree,
    /// `read_workspace_tree` used to set `state.workspace` to that
    /// subdir. From then on, any file at the workspace root or in a
    /// sibling subdir failed `canonical_within`. The regression test
    /// here pins the contract `canonical_within` is supposed to
    /// enforce so a future refactor doesn't quietly re-introduce it.
    #[test]
    fn canonical_within_accepts_file_under_workspace() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let file = root.join("README.md");
        fs::write(&file, b"hello").unwrap();
        let resolved = canonical_within(root, &file).unwrap();
        // canonicalize on macOS resolves /var → /private/var etc.
        // so we compare against the canonical workspace too.
        assert!(resolved.starts_with(dunce_like_canonicalize(root).unwrap()));
    }

    #[test]
    fn canonical_within_accepts_relative_target() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("foo.txt"), b"x").unwrap();
        let resolved = canonical_within(root, Path::new("foo.txt")).unwrap();
        assert!(resolved.ends_with("foo.txt"));
    }

    #[test]
    fn canonical_within_rejects_sibling_directory_target() {
        // This simulates the exact failure mode that motivated
        // dropping `state.workspace` mutation from
        // `read_workspace_tree`: if the workspace is mistakenly
        // pinned to `proj/src` and the user tries to open
        // `proj/README.md`, the path-gate MUST reject — the test
        // here protects the safety property the gate exists for.
        let dir = tempdir().unwrap();
        let proj = dir.path();
        let src = proj.join("src");
        fs::create_dir_all(&src).unwrap();
        let readme = proj.join("README.md");
        fs::write(&readme, b"hi").unwrap();
        match canonical_within(&src, &readme) {
            Err(AppError::Forbidden(_)) => {}
            other => panic!("expected Forbidden, got {other:?}"),
        }
    }

    #[test]
    fn canonical_within_handles_macos_private_var_symlink() {
        // On macOS `/tmp` is a symlink to `/private/tmp`. Without
        // both sides of the comparison being canonicalized, a
        // workspace under `/tmp` would reject every file inside
        // itself ("path outside workspace") because the resolved
        // target starts with `/private/tmp` while the workspace
        // string is just `/tmp`. tempdir() lives under the
        // platform's tmp dir, so this exercises the symlink path
        // on macOS and is a no-op everywhere else.
        let dir = tempdir().unwrap();
        let root = dir.path();
        let file = root.join("note.txt");
        fs::write(&file, b"x").unwrap();
        // Use the RAW (uncanonicalized) workspace path on purpose —
        // mirrors the case `canonical_within` is meant to handle.
        let resolved = canonical_within(root, &file).unwrap();
        let canonical_root = dunce_like_canonicalize(root).unwrap();
        assert!(
            resolved.starts_with(&canonical_root),
            "{resolved:?} not under {canonical_root:?}",
        );
    }
}
