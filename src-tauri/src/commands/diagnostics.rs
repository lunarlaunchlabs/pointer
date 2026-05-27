use crate::error::{AppError, AppResult};
use crate::services::skills::detect_check_command;
use crate::state::AppState;
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCheckInfo {
    pub kind: String,
    pub command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiagnostic {
    pub uri: String,
    pub name: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub severity: String,
    pub message: String,
    pub source: String,
    pub code: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCheckResult {
    pub detected: Option<ProjectCheckInfo>,
    pub diagnostics: Vec<ProjectDiagnostic>,
    pub raw_output: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

#[tauri::command]
pub async fn project_check_detect(
    state: State<'_, AppState>,
) -> AppResult<Option<ProjectCheckInfo>> {
    let root = current_workspace(&state)?;
    Ok(detect_check_command(&root).map(|c| ProjectCheckInfo {
        kind: c.kind.to_string(),
        command: c.command,
    }))
}

#[tauri::command]
pub async fn project_check_run(state: State<'_, AppState>) -> AppResult<ProjectCheckResult> {
    let root = current_workspace(&state)?;
    let Some(detected) = detect_check_command(&root) else {
        return Ok(ProjectCheckResult {
            detected: None,
            diagnostics: Vec::new(),
            raw_output:
                "No project check detected. Looked for Cargo.toml, package.json check/typecheck/lint/build scripts, tsconfig, pyproject.toml, and go.mod."
                    .into(),
            exit_code: None,
            timed_out: false,
        });
    };
    let info = ProjectCheckInfo {
        kind: detected.kind.to_string(),
        command: detected.command.clone(),
    };

    let outcome = run_shell_check(&root, &detected.command).await?;
    let raw_output = truncate_output(&outcome.output, 24_000);
    let diagnostics = parse_project_diagnostics(&root, &outcome.output);
    Ok(ProjectCheckResult {
        detected: Some(info),
        diagnostics,
        raw_output,
        exit_code: outcome.exit_code,
        timed_out: outcome.timed_out,
    })
}

fn current_workspace(state: &State<'_, AppState>) -> AppResult<PathBuf> {
    state
        .workspace
        .lock()
        .clone()
        .ok_or_else(|| AppError::Msg("No workspace open.".into()))
}

struct ShellOutcome {
    output: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

async fn run_shell_check(root: &Path, command: &str) -> AppResult<ShellOutcome> {
    let mut cmd = shell_command(command);
    cmd.current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("PATH", augmented_path());

    let child = cmd
        .spawn()
        .map_err(|e| AppError::Msg(format!("spawn check `{command}`: {e}")))?;
    match timeout(Duration::from_secs(180), child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            Ok(ShellOutcome {
                output: clean_ansi(&combined),
                exit_code: output.status.code(),
                timed_out: false,
            })
        }
        Ok(Err(e)) => Err(AppError::Msg(format!("run check `{command}`: {e}"))),
        Err(_) => Ok(ShellOutcome {
            output: format!("Project check timed out after 180s: {command}"),
            exit_code: None,
            timed_out: true,
        }),
    }
}

#[cfg(target_os = "windows")]
fn shell_command(command: &str) -> Command {
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").arg(command);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn shell_command(command: &str) -> Command {
    let mut cmd = Command::new("sh");
    cmd.arg("-lc").arg(command);
    cmd
}

fn clean_ansi(s: &str) -> String {
    static ANSI: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());
    ANSI.replace_all(s, "").to_string()
}

fn truncate_output(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[s.len() - max..])
    }
}

fn augmented_path() -> String {
    let mut paths: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    for extra in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
    ] {
        if !paths.iter().any(|p| p == extra) {
            paths.push(extra.to_string());
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        for sub in [".cargo/bin", "go/bin", ".local/bin", ".pyenv/shims"] {
            let p = format!("{home}/{sub}");
            if !paths.iter().any(|x| x == &p) {
                paths.push(p);
            }
        }
    }
    paths.join(":")
}

fn parse_project_diagnostics(root: &Path, output: &str) -> Vec<ProjectDiagnostic> {
    let output = clean_ansi(output);
    let mut out = Vec::new();
    let mut current_file: Option<PathBuf> = None;

    let ts_paren = Regex::new(
        r#"^(.+?)\((\d+),(\d+)\):\s*(?:(error|warning)\s+)?([A-Z]+[0-9]+)?\s*:?\s*(.+)$"#,
    )
    .unwrap();
    let colon3 =
        Regex::new(r#"^(.+?):(\d+):(\d+):\s*(?:(error|warning|note|info)\s*:?\s*)?(.+)$"#).unwrap();
    let colon2 = Regex::new(
        r#"^(.+?):(\d+):\s*(error|warning|note|info)\s*:?\s*(.+?)(?:\s+\[([^\]]+)\])?$"#,
    )
    .unwrap();
    let eslint_row = Regex::new(r#"^\s*(\d+):(\d+)\s+(error|warning)\s+(.+)$"#).unwrap();

    for raw_line in output.lines() {
        let line = raw_line.trim_end();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(c) = ts_paren.captures(trimmed) {
            push_diag(
                root,
                &mut out,
                c.get(1).map(|m| m.as_str()).unwrap_or_default(),
                num(c.get(2)),
                num(c.get(3)),
                c.get(4).map(|m| m.as_str()),
                c.get(6).map(|m| m.as_str()).unwrap_or_default(),
                c.get(5).map(|m| m.as_str()),
            );
            continue;
        }

        if let Some(c) = colon3.captures(trimmed) {
            push_diag(
                root,
                &mut out,
                c.get(1).map(|m| m.as_str()).unwrap_or_default(),
                num(c.get(2)),
                num(c.get(3)),
                c.get(4).map(|m| m.as_str()),
                c.get(5).map(|m| m.as_str()).unwrap_or_default(),
                extract_code(c.get(5).map(|m| m.as_str()).unwrap_or_default()).as_deref(),
            );
            continue;
        }

        if let Some(c) = colon2.captures(trimmed) {
            push_diag(
                root,
                &mut out,
                c.get(1).map(|m| m.as_str()).unwrap_or_default(),
                num(c.get(2)),
                1,
                c.get(3).map(|m| m.as_str()),
                c.get(4).map(|m| m.as_str()).unwrap_or_default(),
                c.get(5).map(|m| m.as_str()),
            );
            continue;
        }

        if let Some(c) = eslint_row.captures(line) {
            if let Some(file) = &current_file {
                let msg = c.get(4).map(|m| m.as_str()).unwrap_or_default();
                push_abs_diag(
                    &mut out,
                    file.clone(),
                    num(c.get(1)),
                    num(c.get(2)),
                    c.get(3).map(|m| m.as_str()),
                    msg,
                    extract_eslint_rule(msg).as_deref(),
                );
            }
            continue;
        }

        if !line.starts_with(char::is_whitespace) && looks_like_report_path(trimmed) {
            current_file = Some(resolve_report_path(root, trimmed));
        }
    }

    dedupe_diagnostics(out)
}

fn push_diag(
    root: &Path,
    out: &mut Vec<ProjectDiagnostic>,
    path: &str,
    line: u32,
    col: u32,
    severity: Option<&str>,
    message: &str,
    code: Option<&str>,
) {
    if !looks_like_report_path(path) {
        return;
    }
    push_abs_diag(
        out,
        resolve_report_path(root, path),
        line,
        col,
        severity,
        message,
        code,
    );
}

fn push_abs_diag(
    out: &mut Vec<ProjectDiagnostic>,
    path: PathBuf,
    line: u32,
    col: u32,
    severity: Option<&str>,
    message: &str,
    code: Option<&str>,
) {
    let message = message.trim();
    if message.is_empty() {
        return;
    }
    let severity = match severity.map(|s| s.to_ascii_lowercase()) {
        Some(s) if s.contains("warn") => "warning",
        Some(s) if s.contains("note") || s.contains("info") => "info",
        _ if message.to_ascii_lowercase().contains("warning") => "warning",
        _ => "error",
    };
    let path_s = path.display().to_string();
    out.push(ProjectDiagnostic {
        uri: format!("file://{path_s}"),
        name: path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path_s.clone()),
        start_line: line.max(1),
        start_col: col.max(1),
        end_line: line.max(1),
        end_col: col.max(1) + 1,
        severity: severity.into(),
        message: message.into(),
        source: "project-check".into(),
        code: code.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
    });
}

fn looks_like_report_path(path: &str) -> bool {
    let p = path.trim().trim_matches('"').trim_matches('\'');
    if p.contains("://") && !p.starts_with("file://") {
        return false;
    }
    let lower = p.to_ascii_lowercase();
    lower.contains('/')
        || lower.contains('\\')
        || [
            ".ts", ".tsx", ".js", ".jsx", ".rs", ".go", ".py", ".rb", ".php", ".java", ".kt",
            ".swift", ".cs", ".fs", ".cpp", ".c", ".h", ".json", ".toml", ".yaml", ".yml", ".css",
            ".scss", ".md", ".mdx", ".vue", ".svelte",
        ]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

fn resolve_report_path(root: &Path, path: &str) -> PathBuf {
    let cleaned = path
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_start_matches("file://")
        .trim_start_matches("./");
    let p = PathBuf::from(cleaned);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}

fn num(m: Option<regex::Match<'_>>) -> u32 {
    m.and_then(|x| x.as_str().parse::<u32>().ok()).unwrap_or(1)
}

fn extract_code(s: &str) -> Option<String> {
    static CODE: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"([A-Z]{2,}\d+|\[[A-Za-z0-9_./-]+\])").unwrap());
    CODE.captures(s).and_then(|c| {
        c.get(1)
            .map(|m| m.as_str().trim_matches(['[', ']']).to_string())
    })
}

fn extract_eslint_rule(s: &str) -> Option<String> {
    s.split_whitespace()
        .last()
        .filter(|tail| tail.contains('/') || tail.contains('-'))
        .map(|s| s.to_string())
}

fn dedupe_diagnostics(items: Vec<ProjectDiagnostic>) -> Vec<ProjectDiagnostic> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for d in items {
        let key = format!(
            "{}:{}:{}:{}:{}",
            d.uri,
            d.start_line,
            d.start_col,
            d.message,
            d.code.clone().unwrap_or_default()
        );
        if seen.insert(key) {
            out.push(d);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typescript_parenthesized_errors() {
        let root = Path::new("/repo");
        let out = parse_project_diagnostics(
            root,
            "src/app.ts(12,7): error TS2322: Type 'string' is not assignable\n",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].uri, "file:///repo/src/app.ts");
        assert_eq!(out[0].start_line, 12);
        assert_eq!(out[0].start_col, 7);
        assert_eq!(out[0].code.as_deref(), Some("TS2322"));
    }

    #[test]
    fn parses_rust_cargo_short_errors() {
        let root = Path::new("/repo");
        let out = parse_project_diagnostics(root, "src/main.rs:8:5: error: expected `;`\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].uri, "file:///repo/src/main.rs");
        assert_eq!(out[0].severity, "error");
    }

    #[test]
    fn parses_eslint_stylish_blocks() {
        let root = Path::new("/repo");
        let out = parse_project_diagnostics(
            root,
            "/repo/src/app.ts\n  3:9  warning  'x' is defined but never used  no-unused-vars\n",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].severity, "warning");
        assert_eq!(out[0].code.as_deref(), Some("no-unused-vars"));
    }

    #[test]
    fn parses_mypy_style_errors() {
        let root = Path::new("/repo");
        let out = parse_project_diagnostics(
            root,
            "pkg/mod.py:42: error: Incompatible return value type [return-value]\n",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].start_line, 42);
        assert_eq!(out[0].code.as_deref(), Some("return-value"));
    }
}
