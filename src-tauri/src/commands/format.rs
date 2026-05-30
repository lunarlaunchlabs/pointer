//! Repo-aware format-on-save.
//!
//! Pointer does not bundle every formatter. Instead, it shells out to
//! repo-local tools first (`node_modules/.bin`, virtualenvs, vendor bins)
//! and lets those tools discover their own checked-in configuration:
//! `.prettierrc`, `biome.json`, `ruff.toml`, `pyproject.toml`,
//! `.clang-format`, `rustfmt.toml`, `.stylua.toml`, etc.
//!
//! The selection rule is intentionally conservative:
//!   1. If a nearby repo config clearly names a formatter family, try that.
//!   2. Prefer tools that support stdin/stdout so unsaved buffers can format.
//!   3. Fall back to language-standard formatters where safe.
//!   4. Never mutate the file directly; frontend writes the returned content.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Serialize, Deserialize)]
pub struct FormatResult {
    /// New file contents. Empty when `formatted == false`.
    pub content: String,
    /// True when a formatter ran successfully.
    pub formatted: bool,
    /// Name of the formatter that ran (or "" when none).
    pub formatter: String,
    /// Best-effort error text if the formatter exited non-zero.
    pub error: Option<String>,
}

#[tauri::command]
pub async fn format_text(path: String, content: String) -> AppResult<FormatResult> {
    let source_path = Path::new(&path);
    let ext = source_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let candidates = formatter_candidates(source_path, &ext);
    if candidates.is_empty() {
        return Ok(FormatResult::skipped());
    }

    let mut last_err: Option<String> = None;
    for cmd in &candidates {
        match run_formatter(cmd, &content, Path::new(&path)) {
            Ok(Some(out)) => {
                return Ok(FormatResult {
                    content: out,
                    formatted: true,
                    formatter: cmd.label(),
                    error: None,
                });
            }
            Ok(None) => {
                // Binary not found — try the next candidate.
                continue;
            }
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        }
    }

    Ok(FormatResult {
        content: String::new(),
        formatted: false,
        formatter: String::new(),
        error: last_err,
    })
}

#[derive(Debug)]
struct FormatterCmd {
    bin: &'static str,
    args: Vec<String>,
    cwd: Option<PathBuf>,
}

impl FormatterCmd {
    fn new(bin: &'static str, args: &[&str]) -> Self {
        Self {
            bin,
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
        }
    }

    fn in_dir(mut self, cwd: Option<PathBuf>) -> Self {
        self.cwd = cwd;
        self
    }

    fn with_args(bin: &'static str, args: Vec<String>, cwd: Option<PathBuf>) -> Self {
        Self { bin, args, cwd }
    }

    fn label(&self) -> String {
        self.bin.to_string()
    }
}

fn formatter_candidates(source_path: &Path, ext: &str) -> Vec<FormatterCmd> {
    let cwd = formatter_cwd(source_path);
    let path = source_path.display().to_string();
    let mut out = Vec::new();

    if is_webish(ext) {
        if has_config(source_path, &["biome.json", "biome.jsonc"])
            || package_mentions(source_path, &["@biomejs/biome", "biome"])
        {
            out.push(FormatterCmd::with_args(
                "biome",
                vec!["format".into(), "--stdin-file-path".into(), path.clone()],
                cwd.clone(),
            ));
        }
        if has_config(source_path, &["dprint.json", "dprint.jsonc"])
            || package_mentions(source_path, &["dprint"])
        {
            out.push(FormatterCmd::with_args(
                "dprint",
                vec!["fmt".into(), "--stdin".into(), path.clone()],
                cwd.clone(),
            ));
        }
        // Keep Prettier as the broad web/data fallback even when a
        // stricter configured formatter is preferred above. If Biome
        // or dprint isn't installed locally, a repo that still has
        // Prettier available should not lose format-on-save entirely.
        out.push(FormatterCmd::with_args(
            "prettier",
            vec!["--stdin-filepath".into(), path.clone()],
            cwd.clone(),
        ));
        return out;
    }

    match ext {
        "rs" => {
            out.push(FormatterCmd::new("rustfmt", &["--emit", "stdout"]).in_dir(cwd));
        }
        "go" => {
            out.push(FormatterCmd::new("gofmt", &[]).in_dir(cwd));
        }
        "py" | "pyi" => {
            if has_ruff_signal(source_path) {
                out.push(FormatterCmd::with_args(
                    "ruff",
                    vec!["format".into(), "--stdin-filename".into(), path.clone(), "-".into()],
                    cwd.clone(),
                ));
            }
            out.push(FormatterCmd::with_args(
                "black",
                vec!["--quiet".into(), "--stdin-filename".into(), path.clone(), "-".into()],
                cwd.clone(),
            ));
            if !has_ruff_signal(source_path) {
                out.push(FormatterCmd::with_args(
                    "ruff",
                    vec!["format".into(), "--stdin-filename".into(), path.clone(), "-".into()],
                    cwd.clone(),
                ));
            }
            out.push(FormatterCmd::with_args(
                "yapf",
                vec!["--filename".into(), path.clone()],
                cwd.clone(),
            ));
        }
        "sh" | "bash" | "zsh" | "ksh" => {
            out.push(FormatterCmd::with_args(
                "shfmt",
                vec!["--filename".into(), path.clone()],
                cwd.clone(),
            ));
            out.push(FormatterCmd::new("shfmt", &["-i", "2"]).in_dir(cwd));
        }
        "lua" => {
            out.push(FormatterCmd::with_args(
                "stylua",
                vec!["--stdin-filepath".into(), path.clone(), "-".into()],
                cwd.clone(),
            ));
        }
        "rb" => {
            out.push(FormatterCmd::new("rufo", &["-x"]).in_dir(cwd.clone()));
            out.push(FormatterCmd::new("standardrb", &["--fix", "--stdin"]).in_dir(cwd));
        }
        "toml" => {
            out.push(FormatterCmd::new("taplo", &["fmt", "-"]).in_dir(cwd));
        }
        "tf" | "tfvars" => {
            out.push(FormatterCmd::new("terraform", &["fmt", "-"]).in_dir(cwd));
        }
        "nix" => {
            out.push(FormatterCmd::new("nixfmt", &[]).in_dir(cwd.clone()));
            out.push(FormatterCmd::new("alejandra", &["-q"]).in_dir(cwd));
        }
        _ if is_clang_format_family(ext) => {
            out.push(FormatterCmd::with_args(
                "clang-format",
                vec![format!("--assume-filename={path}")],
                cwd,
            ));
        }
        _ => {}
    }

    out
}

/// Run a formatter, piping `content` to stdin and reading the
/// formatted source from stdout. Returns:
///   • Ok(Some(out))  — formatter ran successfully
///   • Ok(None)       — binary not on PATH (try next candidate)
///   • Err(message)   — binary ran but exited non-zero
fn run_formatter(
    cmd: &FormatterCmd,
    content: &str,
    source_path: &Path,
) -> Result<Option<String>, String> {
    let mut child = match Command::new(cmd.bin)
        .args(&cmd.args)
        .current_dir(cmd.cwd.as_deref().unwrap_or_else(|| {
            source_path.parent().unwrap_or_else(|| Path::new("."))
        }))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Prepend common shell PATH entries so GUI app launches
        // can still find user-installed formatters (Homebrew,
        // pyenv, etc.). Tauri inherits the launch environment
        // which on macOS doesn't include /opt/homebrew/bin from a
        // double-clicked .app.
        .env("PATH", augmented_path(source_path))
        .spawn()
    {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("spawn {}: {e}", cmd.bin)),
    };

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| format!("no stdin for {}", cmd.bin))?;
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("write stdin {}: {e}", cmd.bin))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("wait {}: {e}", cmd.bin))?;
    if !output.status.success() {
        return Err(format!(
            "{} exited {}: {}",
            cmd.bin,
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

fn is_webish(ext: &str) -> bool {
    matches!(
        ext,
        "js" | "jsx"
            | "ts"
            | "tsx"
            | "mts"
            | "cts"
            | "mjs"
            | "cjs"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "json"
            | "jsonc"
            | "json5"
            | "html"
            | "htm"
            | "md"
            | "mdx"
            | "yaml"
            | "yml"
            | "vue"
            | "svelte"
            | "astro"
            | "graphql"
            | "gql"
    )
}

fn is_clang_format_family(ext: &str) -> bool {
    matches!(
        ext,
        "c" | "h"
            | "cc"
            | "cpp"
            | "cxx"
            | "hh"
            | "hpp"
            | "hxx"
            | "m"
            | "mm"
            | "java"
            | "proto"
            | "cs"
            | "glsl"
            | "vert"
            | "frag"
            | "metal"
    )
}

fn has_ruff_signal(source_path: &Path) -> bool {
    has_config(source_path, &["ruff.toml", ".ruff.toml"])
        || package_mentions(source_path, &["ruff"])
        || ancestor_files(source_path)
            .into_iter()
            .any(|dir| dir.join("pyproject.toml").read_to_string_lossy().contains("[tool.ruff"))
}

fn has_config(source_path: &Path, names: &[&str]) -> bool {
    ancestor_files(source_path)
        .into_iter()
        .any(|dir| names.iter().any(|name| dir.join(name).is_file()))
}

fn package_mentions(source_path: &Path, packages: &[&str]) -> bool {
    ancestor_files(source_path).into_iter().any(|dir| {
        let package = dir.join("package.json").read_to_string_lossy();
        !package.is_empty()
            && packages
                .iter()
                .any(|name| package.contains(&format!("\"{name}\"")))
    })
}

fn formatter_cwd(source_path: &Path) -> Option<PathBuf> {
    let markers = [
        ".git",
        "package.json",
        "deno.json",
        "deno.jsonc",
        "biome.json",
        "dprint.json",
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "ruff.toml",
        ".clang-format",
        "rustfmt.toml",
        ".stylua.toml",
    ];
    ancestor_files(source_path)
        .into_iter()
        .find(|dir| markers.iter().any(|marker| dir.join(marker).exists()))
        .or_else(|| source_path.parent().map(Path::to_path_buf))
}

fn ancestor_files(source_path: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut dir = if source_path.is_dir() {
        source_path.to_path_buf()
    } else {
        source_path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_path_buf()
    };
    for _ in 0..24 {
        dirs.push(dir.clone());
        if !dir.pop() {
            break;
        }
    }
    dirs
}

trait ReadLossy {
    fn read_to_string_lossy(&self) -> String;
}

impl ReadLossy for PathBuf {
    fn read_to_string_lossy(&self) -> String {
        std::fs::read_to_string(self).unwrap_or_default()
    }
}

/// Build a PATH that includes the common locations user-installed
/// formatters live in. Avoids the "Homebrew formatter not found
/// because Tauri launched from Finder" footgun on macOS.
fn augmented_path(source_path: &Path) -> String {
    let mut paths = project_tool_paths(source_path);
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing).map(|p| p.display().to_string()));
    }
    append_standard_tool_paths(&mut paths);
    std::env::join_paths(paths.iter().map(PathBuf::from))
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|_| paths.join(":"))
}

fn project_tool_paths(source_path: &Path) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    let mut dir = if source_path.is_dir() {
        source_path.to_path_buf()
    } else {
        source_path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_path_buf()
    };
    for _ in 0..12 {
        for sub in ["node_modules/.bin", ".venv/bin", "venv/bin", "vendor/bin"] {
            let p = dir.join(sub);
            if p.is_dir() {
                paths.push(p.display().to_string());
            }
        }
        if !dir.pop() {
            break;
        }
    }
    paths
}

fn append_standard_tool_paths(paths: &mut Vec<String>) {
    let extras = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
    ];
    for e in extras {
        if !paths.iter().any(|p| p == e) {
            paths.push(e.to_string());
        }
    }
    // Also add ~/.cargo/bin and ~/go/bin since people frequently
    // install rustfmt-as-component / gofmt this way.
    if let Ok(home) = std::env::var("HOME") {
        for sub in &[".cargo/bin", "go/bin", ".local/bin", ".pyenv/shims"] {
            let p = format!("{home}/{sub}");
            if !paths.iter().any(|x| x == &p) {
                paths.push(p);
            }
        }
    }
}

impl FormatResult {
    fn skipped() -> Self {
        Self {
            content: String::new(),
            formatted: false,
            formatter: String::new(),
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn augmented_path_prefers_repo_local_node_tools() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("packages/app/src");
        std::fs::create_dir_all(&nested).unwrap();
        let bin = dir.path().join("packages/app/node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = augmented_path(&nested.join("App.tsx"));
        let first = path.split(':').next().unwrap_or_default();
        assert_eq!(first, bin.display().to_string());
    }

    #[test]
    fn augmented_path_finds_parent_virtualenv() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("pkg/sub");
        std::fs::create_dir_all(&nested).unwrap();
        let bin = dir.path().join(".venv/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = augmented_path(&nested.join("module.py"));
        assert!(path.split(':').any(|p| p == bin.display().to_string()));
    }

    #[test]
    fn formatter_candidates_prefer_biome_when_configured() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("biome.json"), "{}").unwrap();
        let file = dir.path().join("src/app.ts");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let candidates = formatter_candidates(&file, "ts");
        assert_eq!(candidates.first().map(|c| c.bin), Some("biome"));
        assert!(candidates.iter().any(|c| c.bin == "prettier"));
    }

    #[test]
    fn formatter_candidates_use_ruff_before_black_when_configured() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ruff.toml"), "line-length = 100").unwrap();
        let file = dir.path().join("pkg/module.py");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let candidates = formatter_candidates(&file, "py");
        assert_eq!(candidates.first().map(|c| c.bin), Some("ruff"));
        assert!(candidates.iter().any(|c| c.bin == "black"));
    }

    #[test]
    fn formatter_candidates_use_clang_format_for_c_family() {
        let file = PathBuf::from("/repo/src/main.cpp");
        let candidates = formatter_candidates(&file, "cpp");
        assert_eq!(candidates.first().map(|c| c.bin), Some("clang-format"));
        assert!(candidates[0]
            .args
            .iter()
            .any(|arg| arg.starts_with("--assume-filename=")));
    }
}
