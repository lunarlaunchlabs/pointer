//! Language-aware format-on-save.
//!
//! Rather than bundle every formatter (impractical: 100MB+ for the
//! common set), we shell out to whatever is already on the user's
//! PATH. Each formatter is identified by extension and runs as a
//! pipe: stdin in, formatted source out, never touching the file
//! on disk. The frontend writes the result back through the
//! existing `write_text_file` command so dirty/clean state stays
//! consistent.
//!
//! Languages currently supported (when the binary is on PATH):
//!   • JS/TS/TSX/CSS/JSON/HTML/Markdown: prettier
//!   • Rust: rustfmt
//!   • Go: gofmt
//!   • Python: black (preferred), ruff format (fallback)
//!   • Shell: shfmt
//!   • Lua: stylua
//!   • Ruby: rufo
//!   • YAML: prettier (treats it natively)
//!   • TOML: taplo fmt -
//!
//! Anything not in the table returns `formatted: false` with no
//! error — the caller falls back to the cheap "trim trailing
//! whitespace" pass we already ship.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
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
    // Resolve which formatter to use from the extension. Returns
    // None for files we don't know — the frontend then keeps the
    // minimal whitespace pass.
    let ext = Path::new(&path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let candidates: Vec<FormatterCmd> = match ext.as_str() {
        // Prettier handles a huge chunk of the JS/Web/Data ecosystem.
        "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "css" | "scss" | "less" | "json"
        | "jsonc" | "html" | "htm" | "md" | "mdx" | "yaml" | "yml" | "vue" | "svelte" => {
            vec![
                FormatterCmd::new(
                    "prettier",
                    &["--stdin-filepath", &path],
                ),
            ]
        }
        "rs" => vec![FormatterCmd::new("rustfmt", &["--emit", "stdout", "--edition", "2021"])],
        "go" => vec![FormatterCmd::new("gofmt", &[])],
        "py" => vec![
            FormatterCmd::new("black", &["--quiet", "-"]),
            FormatterCmd::new("ruff", &["format", "-"]),
        ],
        "sh" | "bash" | "zsh" => vec![FormatterCmd::new("shfmt", &["-i", "2"])],
        "lua" => vec![FormatterCmd::new("stylua", &["-"])],
        "rb" => vec![FormatterCmd::new("rufo", &["-x"])],
        "toml" => vec![FormatterCmd::new("taplo", &["fmt", "-"])],
        _ => return Ok(FormatResult::skipped()),
    };

    let mut last_err: Option<String> = None;
    for cmd in &candidates {
        match run_formatter(cmd, &content) {
            Ok(Some(out)) => {
                return Ok(FormatResult {
                    content: out,
                    formatted: true,
                    formatter: cmd.bin.to_string(),
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
}

impl FormatterCmd {
    fn new(bin: &'static str, args: &[&str]) -> Self {
        Self {
            bin,
            args: args.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// Run a formatter, piping `content` to stdin and reading the
/// formatted source from stdout. Returns:
///   • Ok(Some(out))  — formatter ran successfully
///   • Ok(None)       — binary not on PATH (try next candidate)
///   • Err(message)   — binary ran but exited non-zero
fn run_formatter(cmd: &FormatterCmd, content: &str) -> Result<Option<String>, String> {
    let mut child = match Command::new(cmd.bin)
        .args(&cmd.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Prepend common shell PATH entries so GUI app launches
        // can still find user-installed formatters (Homebrew,
        // pyenv, etc.). Tauri inherits the launch environment
        // which on macOS doesn't include /opt/homebrew/bin from a
        // double-clicked .app.
        .env(
            "PATH",
            augmented_path(),
        )
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

/// Build a PATH that includes the common locations user-installed
/// formatters live in. Avoids the "Homebrew formatter not found
/// because Tauri launched from Finder" footgun on macOS.
fn augmented_path() -> String {
    let mut paths: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|s| s.to_string())
        .collect();
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
    paths.join(":")
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
