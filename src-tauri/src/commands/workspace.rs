//! Workspace brief — a compact text snapshot the chat & agent prompts
//! prepend so the model knows what project it's looking at without
//! needing to grep around first.
//!
//! Why this exists
//! ===============
//! Before this, both chat and the agent only saw the absolute workspace
//! path and the user's @-mentions. Asking "tell me about this repo"
//! produced nonsense; the agent would also start fresh with no idea
//! whether it was looking at a Rust crate, a Vite app, or a Python
//! package, and would waste turns probing.
//!
//! The brief is a deliberately *tight* block — ~1.5 KB at most — that
//! describes the project at the workspace ROOT level: top-level
//! entries, any manifests we recognise (package.json / Cargo.toml /
//! pyproject.toml / go.mod / Gemfile), the README's first ~20 lines,
//! and the git remote if any. We snapshot the project the user OPENED
//! in the IDE — we never describe Pointer itself.
//!
//! Deeper navigation stays the agent's job: the brief is "table of
//! contents", and `<list_dir>` / `<read_file>` / `<glob>` / `<grep>`
//! are how the agent fills in the rest. We intentionally don't try to
//! summarise nested packages, monorepo layout, or per-file content
//! here — that's what tools are for.

use crate::error::AppResult;
use crate::state::AppState;
use ignore::WalkBuilder;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

/// Hard cap on the brief's total size. Sized so the brief stays under
/// ~400 tokens for any model: cheap to ship every turn but big enough
/// to carry README + manifest highlights for a typical project. Above
/// this we truncate the trailing slot rather than dropping the cheap
/// orientation bits at the top.
const MAX_BRIEF_BYTES: usize = 1500;
/// How many README lines we sample. Most READMEs front-load the
/// elevator pitch; 20 lines is enough to capture that without paying
/// for the full Contributing / License boilerplate.
const README_MAX_LINES: usize = 20;
/// Per-slot cap so a single field can't crowd out everything else.
/// e.g. a 50 KB README would otherwise eat the whole budget before the
/// manifests get a chance to land.
const README_MAX_BYTES: usize = 1200;
/// Top-level entry cap. Mirrors what the file tree shows on first
/// open; more than this and the listing stops being scannable.
const TOPLEVEL_LIMIT: usize = 15;
/// Directories we ALWAYS hide from the top-level listing because they
/// are universal build/IDE noise and tell the model nothing about the
/// project. `.gitignore` will hide most of them anyway via the
/// `ignore` walker, but listing them here too means the brief stays
/// clean even on projects whose .gitignore is missing or stale.
const NOISE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    "dist",
    "build",
    ".next",
    ".cache",
    "venv",
    ".venv",
    "__pycache__",
    ".turbo",
    ".vite",
    ".pytest_cache",
    "coverage",
];

#[derive(Serialize)]
pub struct WorkspaceBrief {
    pub text: String,
    pub bytes: u32,
    pub generated_at: i64,
}

#[tauri::command]
pub async fn workspace_brief(
    state: State<'_, AppState>,
    root: Option<String>,
) -> AppResult<WorkspaceBrief> {
    // Prefer the explicit arg (FE knows its current root and may pass
    // it ahead of `state.workspace` being set) but fall back to the
    // shared workspace if the FE doesn't pass one. We don't error on
    // an empty workspace — return a stub brief so callers don't have
    // to handle a missing-workspace case differently from a normal
    // empty result.
    let workspace = root
        .map(PathBuf::from)
        .or_else(|| state.workspace.lock().clone());
    let Some(workspace) = workspace else {
        return Ok(WorkspaceBrief {
            text: String::new(),
            bytes: 0,
            generated_at: unix_now(),
        });
    };
    let text = generate_brief(&workspace);
    Ok(WorkspaceBrief {
        bytes: text.len() as u32,
        text,
        generated_at: unix_now(),
    })
}

/// Build the brief for a given workspace. Pure side-effect-free helper
/// so the agent's `render_user_brief` (which doesn't have access to
/// `State<AppState>`) can call it directly.
///
/// Failures of any individual slot (missing README, unreadable
/// manifest, git not installed, etc.) are silently dropped — a partial
/// brief is more useful than no brief, and we never want a malformed
/// file in the user's workspace to break their chat.
pub fn generate_brief(workspace: &Path) -> String {
    let mut out = String::new();
    out.push_str("# Workspace\n");
    let name = workspace
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| workspace.display().to_string());
    out.push_str(&format!("Name: {name}\n"));
    out.push_str(&format!("Root: {}\n", workspace.display()));
    if let Some(remote) = git_remote(workspace) {
        out.push_str(&format!("Git remote: {remote}\n"));
    }

    // Top-level entries. We respect .gitignore via the `ignore` walker
    // so vendored/build dirs don't show up even if NOISE_DIRS misses
    // them. Directories first, then files; alphabetical within each.
    let entries = top_level_entries(workspace);
    if !entries.is_empty() {
        let shown: Vec<&(String, bool)> = entries.iter().take(TOPLEVEL_LIMIT).collect();
        let suffix = if entries.len() > TOPLEVEL_LIMIT {
            format!("  (+{} more)", entries.len() - TOPLEVEL_LIMIT)
        } else {
            String::new()
        };
        out.push_str(&format!(
            "\n## Top-level ({} shown of {})\n",
            shown.len(),
            entries.len()
        ));
        let formatted: Vec<String> = shown
            .iter()
            .map(|(n, is_dir)| if *is_dir { format!("{n}/") } else { n.clone() })
            .collect();
        out.push_str(&formatted.join("  "));
        if !suffix.is_empty() {
            out.push_str(&suffix);
        }
        out.push('\n');
    }

    // Manifest highlights. Each manifest gets a tiny structured
    // summary; missing manifests are silently skipped. We hand-roll
    // the field extraction rather than pulling in serde models for
    // every ecosystem — the brief only needs name/description/scripts/
    // first-N-deps to give the model a feel for the project.
    let mut manifests = String::new();
    if let Some(s) = summarize_package_json(workspace) {
        manifests.push_str(&s);
    }
    if let Some(s) = summarize_cargo_toml(workspace) {
        manifests.push_str(&s);
    }
    if let Some(s) = summarize_pyproject_toml(workspace) {
        manifests.push_str(&s);
    }
    if let Some(s) = summarize_go_mod(workspace) {
        manifests.push_str(&s);
    }
    if let Some(s) = summarize_gemfile(workspace) {
        manifests.push_str(&s);
    }
    if !manifests.is_empty() {
        out.push_str("\n## Project\n");
        out.push_str(&manifests);
    }

    if let Some(readme) = find_and_read_readme(workspace) {
        out.push_str(&format!("\n## README (first {} lines)\n", README_MAX_LINES));
        out.push_str(&readme);
        if !readme.ends_with('\n') {
            out.push('\n');
        }
    }

    // Final cap: truncate from the END so the orientation bits at the
    // top (workspace name, top-level listing, manifests) survive even
    // when the README pushes us over budget.
    if out.len() > MAX_BRIEF_BYTES {
        out.truncate(MAX_BRIEF_BYTES.saturating_sub(16));
        out.push_str("\n[truncated]\n");
    }
    out
}

/// One-level directory listing, filtered through the `ignore` walker
/// (so .gitignore + NOISE_DIRS get hidden) and sorted dirs-first.
fn top_level_entries(workspace: &Path) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = Vec::new();
    let walker = WalkBuilder::new(workspace)
        .max_depth(Some(1))
        .git_ignore(true)
        .ignore(true)
        .hidden(false)
        .build();
    for dent in walker.flatten() {
        if dent.path() == workspace {
            continue;
        }
        let name = match dent.path().file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if NOISE_DIRS.contains(&name.as_str()) {
            continue;
        }
        let is_dir = dent.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        out.push((name, is_dir));
    }
    out.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
    });
    out
}

/// Locate a README file case-insensitively across common extensions
/// (`.md`, `.rst`, `.txt`, none). We sample the first N lines capped at
/// README_MAX_BYTES — long licenses / contributing sections aren't
/// what the model needs to know about the project on turn 1.
fn find_and_read_readme(workspace: &Path) -> Option<String> {
    let candidates: Vec<PathBuf> = std::fs::read_dir(workspace)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name();
            let lower = name.to_string_lossy().to_lowercase();
            let stem = lower
                .rsplit_once('.')
                .map(|(s, _)| s.to_string())
                .unwrap_or_else(|| lower.clone());
            let ext = lower.rsplit_once('.').map(|(_, e)| e.to_string());
            let is_readme = stem == "readme"
                && matches!(
                    ext.as_deref(),
                    Some("md") | Some("rst") | Some("txt") | None
                );
            if is_readme {
                Some(e.path())
            } else {
                None
            }
        })
        .collect();
    let pick = candidates.into_iter().min_by_key(|p| {
        p.extension()
            .map(|e| e.to_string_lossy().len())
            .unwrap_or(0)
    })?;
    let raw = std::fs::read_to_string(&pick).ok()?;
    let mut acc = String::new();
    for line in raw.lines().take(README_MAX_LINES) {
        if acc.len() + line.len() + 1 > README_MAX_BYTES {
            acc.push_str("[truncated]\n");
            break;
        }
        acc.push_str(line);
        acc.push('\n');
    }
    Some(acc)
}

fn summarize_package_json(workspace: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(workspace.join("package.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let mut out = String::from("package.json\n");
    if let Some(s) = v.get("name").and_then(|v| v.as_str()) {
        out.push_str(&format!("  name: {s:?}\n"));
    }
    if let Some(s) = v.get("description").and_then(|v| v.as_str()) {
        out.push_str(&format!("  description: {:?}\n", trunc(s, 140)));
    }
    if let Some(s) = v.get("type").and_then(|v| v.as_str()) {
        // ESM vs CommonJS matters for the import-style heuristic the
        // chat prompt already uses; surface it explicitly.
        out.push_str(&format!("  type: {s:?}\n"));
    }
    if let Some(scripts) = v.get("scripts").and_then(|v| v.as_object()) {
        let names: Vec<&String> = scripts.keys().take(8).collect();
        if !names.is_empty() {
            let list = names
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            out.push_str(&format!("  scripts: {list}\n"));
        }
    }
    let mut deps = vec![];
    if let Some(d) = v.get("dependencies").and_then(|v| v.as_object()) {
        deps.extend(d.keys().take(8).map(|s| s.as_str().to_string()));
    }
    if let Some(d) = v.get("devDependencies").and_then(|v| v.as_object()) {
        for k in d.keys() {
            if deps.len() >= 12 {
                break;
            }
            if !deps.contains(&k.to_string()) {
                deps.push(k.to_string());
            }
        }
    }
    if !deps.is_empty() {
        out.push_str(&format!("  deps: {}\n", deps.join(", ")));
    }
    Some(out)
}

fn summarize_cargo_toml(workspace: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(workspace.join("Cargo.toml")).ok()?;
    // Hand-rolled key extraction — we don't pull in `toml` just for
    // this since the manifest layout is well-known and we only need a
    // handful of fields. `[package]` block, then `name`/`description`
    // until a blank line or the next section header.
    let mut out = String::from("Cargo.toml\n");
    let mut in_pkg = false;
    for line in raw.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_pkg = l == "[package]";
            continue;
        }
        if !in_pkg {
            continue;
        }
        if let Some((k, v)) = l.split_once('=') {
            let k = k.trim();
            let v = v.trim();
            if matches!(k, "name" | "description" | "version" | "edition") {
                out.push_str(&format!("  {k}: {}\n", trunc(v.trim_matches('"'), 140)));
            }
        }
    }
    // Workspaces & top-level deps section names give a feel for the
    // crate's surface area without us parsing every dep.
    if raw.contains("[workspace]") {
        out.push_str("  workspace: yes\n");
    }
    Some(out)
}

fn summarize_pyproject_toml(workspace: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(workspace.join("pyproject.toml")).ok()?;
    let mut out = String::from("pyproject.toml\n");
    let mut in_project = false;
    for line in raw.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            // [project], [tool.poetry], [tool.setuptools] all surface
            // name + description for Python projects. We only sip
            // from [project] and [tool.poetry] to keep it simple.
            in_project = l == "[project]" || l == "[tool.poetry]";
            continue;
        }
        if !in_project {
            continue;
        }
        if let Some((k, v)) = l.split_once('=') {
            let k = k.trim();
            if matches!(k, "name" | "description" | "version") {
                let v = v.trim().trim_matches('"').trim_matches('\'');
                out.push_str(&format!("  {k}: {}\n", trunc(v, 140)));
            }
        }
    }
    Some(out)
}

fn summarize_go_mod(workspace: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(workspace.join("go.mod")).ok()?;
    let mut out = String::from("go.mod\n");
    for line in raw.lines().take(8) {
        let l = line.trim();
        if l.starts_with("module ") || l.starts_with("go ") {
            out.push_str(&format!("  {l}\n"));
        }
    }
    Some(out)
}

fn summarize_gemfile(workspace: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(workspace.join("Gemfile")).ok()?;
    let mut out = String::from("Gemfile\n");
    let mut gems: Vec<String> = vec![];
    for line in raw.lines() {
        let l = line.trim();
        if l.starts_with("source ") {
            out.push_str(&format!("  {}\n", trunc(l, 140)));
        }
        if l.starts_with("ruby ") {
            out.push_str(&format!("  {l}\n"));
        }
        if l.starts_with("gem ") && gems.len() < 10 {
            // Just the gem name, not the version constraint.
            let name = l
                .trim_start_matches("gem ")
                .trim_start_matches('\'')
                .trim_start_matches('"');
            let name = name.split(['\'', '"']).next().unwrap_or("");
            if !name.is_empty() {
                gems.push(name.to_string());
            }
        }
    }
    if !gems.is_empty() {
        out.push_str(&format!("  gems: {}\n", gems.join(", ")));
    }
    Some(out)
}

/// Best-effort `git remote get-url origin`. Capped at 2 seconds so a
/// missing git binary or a slow network mount doesn't stall every
/// chat request. The result is `Some(url)` only on a successful
/// exit; we never surface git's own error text.
fn git_remote(workspace: &Path) -> Option<String> {
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::Duration;

    let workspace = workspace.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    thread::spawn(move || {
        let out = Command::new("git")
            .arg("-C")
            .arg(&workspace)
            .arg("config")
            .arg("--get")
            .arg("remote.origin.url")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .output();
        let url = out
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
            .filter(|s| !s.is_empty());
        let _ = tx.send(url);
    });
    rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

fn trunc(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn generate_brief_handles_empty_workspace() {
        let dir = tempdir().unwrap();
        let brief = generate_brief(dir.path());
        // Always emits the header even for an empty dir so callers
        // can rely on a non-empty result when the workspace exists.
        assert!(brief.contains("# Workspace"));
        assert!(brief.contains("Name:"));
        assert!(brief.contains("Root:"));
    }

    #[test]
    fn generate_brief_summarises_package_json() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{
              "name": "demo-app",
              "description": "A small demo",
              "type": "module",
              "scripts": { "dev": "vite", "build": "vite build" },
              "dependencies": { "react": "^18", "zustand": "^4" }
            }"#,
        )
        .unwrap();
        let brief = generate_brief(dir.path());
        assert!(brief.contains("package.json"));
        assert!(brief.contains("demo-app"));
        assert!(brief.contains("A small demo"));
        assert!(brief.contains("type: \"module\""));
        // serde_json sorts object keys, so "build" comes before "dev".
        // We don't pin the exact order — just both scripts surface.
        assert!(brief.contains("scripts:"));
        assert!(brief.contains("dev"));
        assert!(brief.contains("build"));
        assert!(brief.contains("react"));
        assert!(brief.contains("zustand"));
    }

    #[test]
    fn generate_brief_summarises_cargo_toml() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("Cargo.toml"),
            r#"[package]
name = "demo-crate"
description = "A demo Rust crate"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = "1"
"#,
        )
        .unwrap();
        let brief = generate_brief(dir.path());
        assert!(brief.contains("Cargo.toml"));
        assert!(brief.contains("demo-crate"));
        assert!(brief.contains("A demo Rust crate"));
        assert!(brief.contains("edition: 2021"));
    }

    #[test]
    fn generate_brief_picks_readme_first_lines() {
        let dir = tempdir().unwrap();
        let mut body = String::new();
        body.push_str("Demo Project\n");
        body.push_str("============\n");
        body.push_str("First real line.\n");
        for _ in 0..200 {
            body.push_str("filler line that should be cut off\n");
        }
        fs::write(dir.path().join("README.md"), body).unwrap();
        let brief = generate_brief(dir.path());
        assert!(brief.contains("## README"));
        assert!(brief.contains("Demo Project"));
        assert!(brief.contains("First real line."));
        // Bytes cap should prevent the README from blowing past
        // the brief budget.
        assert!(brief.len() <= MAX_BRIEF_BYTES);
    }

    #[test]
    fn generate_brief_hides_noise_dirs_from_top_level() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules")).unwrap();
        fs::create_dir_all(dir.path().join("target")).unwrap();
        fs::write(dir.path().join("README.md"), b"hi").unwrap();
        let brief = generate_brief(dir.path());
        // src/ + README.md visible; node_modules + target hidden.
        assert!(brief.contains("src/"));
        assert!(brief.contains("README.md"));
        assert!(!brief.contains("node_modules"));
        assert!(!brief.contains("target"));
    }

    #[test]
    fn generate_brief_describes_workspace_name_from_directory() {
        // The brief describes the OPENED project, not Pointer
        // itself — regression test for the case where it might
        // accidentally describe the embedding crate.
        let parent = tempdir().unwrap();
        let proj = parent.path().join("my-cool-project");
        fs::create_dir_all(&proj).unwrap();
        let brief = generate_brief(&proj);
        assert!(brief.contains("Name: my-cool-project"));
        assert!(brief.contains(proj.display().to_string().as_str()));
    }

    #[test]
    fn generate_brief_total_size_is_bounded() {
        let dir = tempdir().unwrap();
        // Pile every slot to the max: README, package.json, Cargo.toml,
        // pyproject.toml, plus a long top-level listing.
        let big_readme: String = (0..2000).map(|i| format!("readme line {i}\n")).collect();
        fs::write(dir.path().join("README.md"), big_readme).unwrap();
        let mut pkg = String::from("{\"name\":\"x\",\"dependencies\":{");
        for i in 0..200 {
            pkg.push_str(&format!("\"dep{i}\":\"^1\","));
        }
        pkg.push_str("\"final\":\"1\"}}");
        fs::write(dir.path().join("package.json"), pkg).unwrap();
        for i in 0..40 {
            fs::create_dir_all(dir.path().join(format!("dir{i:02}"))).unwrap();
        }
        let brief = generate_brief(dir.path());
        assert!(
            brief.len() <= MAX_BRIEF_BYTES,
            "brief was {} bytes, cap is {}",
            brief.len(),
            MAX_BRIEF_BYTES,
        );
    }
}
