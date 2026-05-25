//! Integrated terminal backend.
//!
//! Spawns real PTYs (forkpty on Unix, ConPTY on Windows) so curses apps,
//! ANSI escape sequences, and modern shell prompts (oh-my-zsh, starship,
//! powerline) work out of the box. xterm.js on the frontend speaks the
//! same protocol, so this is a thin pipe with three primitives:
//!
//!   1. `terminal_open`   — spawn a shell, return an opaque handle.
//!   2. `terminal_write`  — push bytes into the PTY's master FD.
//!   3. `terminal_resize` — propagate window size changes (SIGWINCH).
//!   4. `terminal_close`  — kill the child and reclaim resources.
//!
//! Output is streamed back to the renderer via Tauri events named
//! `terminal:data:<id>` so each xterm.js instance can subscribe to its
//! own stream. Exit notifications come on `terminal:exit:<id>` with the
//! status code (or `null` if killed).
//!
//! Threading model: each PTY gets a dedicated reader thread that blocks on
//! `read()` until the child writes or closes. We deliberately don't use
//! async here — `portable-pty` exposes blocking handles, and a single OS
//! thread per terminal is the right trade-off (terminals are long-lived
//! and few in number, so the thread cost is negligible).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use once_cell::sync::Lazy;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// One live terminal. Holds onto the master half of the PTY so we can
/// resize, the child process so we can kill it, and the writer end so we
/// can pipe keystrokes from the renderer into the slave's stdin.
///
/// Critical invariant: `writer` is taken from `master` EXACTLY ONCE, at
/// session open time, and lives for the lifetime of the session.
/// portable-pty's `MasterPty::take_writer` is one-shot AND dropping the
/// returned writer sends EOF to the slave end. The original
/// implementation took a fresh writer per keystroke and immediately
/// dropped it — so the very first character the user typed was followed
/// by EOF on the shell's stdin, which interactive zsh/bash interprets
/// as "the current pending line is done, execute it" → `a` is not a
/// command → exit 127. Holding the writer for the session's lifetime
/// fixes that.
///
/// We wrap the writer in `Arc<Mutex<_>>` so `terminal_write` can clone
/// the handle, drop the SESSIONS lock, and only then block on the
/// actual write. Otherwise a slow flush would serialize every other
/// terminal command (resize, close, even other terminals' writes)
/// behind it.
struct Session {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

/// Map of `id -> Session`. The id is a short opaque string the frontend
/// generates so it can mux events back to the right xterm instance.
static SESSIONS: Lazy<Mutex<HashMap<String, Session>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Serialize)]
pub struct OpenResult {
    pub id: String,
    /// The shell binary we resolved. Useful for the UI to label tabs
    /// ("zsh", "powershell", etc.).
    pub shell: String,
}

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<OpenResult, String> {
    if id.is_empty() {
        return Err("terminal id required".into());
    }
    {
        let map = SESSIONS.lock().unwrap();
        if map.contains_key(&id) {
            return Err(format!("terminal '{id}' already open"));
        }
    }

    // Pick the user's shell. We follow common precedence rules: $SHELL on
    // Unix (with fallback to /bin/sh because $SHELL is occasionally unset
    // in tauri's GUI launch context), COMSPEC then powershell on Windows.
    let (shell_path, shell_label) = resolve_shell();

    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell_path);
    // Mark as interactive so .zshrc / .bashrc load prompt + aliases.
    if shell_label.contains("zsh") || shell_label.contains("bash") || shell_label.contains("sh") {
        cmd.arg("-i");
    }
    if let Some(dir) = cwd.as_ref() {
        if !dir.is_empty() {
            cmd.cwd(dir);
        }
    }
    // Propagate a few env vars commonly expected by interactive shells.
    // We *don't* set TERM=xterm-256color globally — portable_pty already
    // does on Unix — but we set COLORTERM so modern tools (eza, lsd) emit
    // truecolor.
    cmd.env("COLORTERM", "truecolor");
    // Hint apps to use the same Pointer-aware editor when they need one.
    cmd.env("EDITOR", "pointer");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;
    // Drop the slave half — the child owns the FD now and dropping ours
    // is what lets us notice EOF when the shell exits.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    // Take the writer ONCE and keep it for the session's lifetime — see
    // the Session docstring for why this is load-bearing.
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    // Stash the session before we spawn the reader thread so the reader
    // can't observe a momentary "session missing" race when the very
    // first bytes arrive.
    {
        let mut map = SESSIONS.lock().unwrap();
        map.insert(
            id.clone(),
            Session {
                master: pair.master,
                child,
                writer: Arc::new(Mutex::new(writer)),
            },
        );
    }

    // Reader thread. Blocks on `read()`, emits the bytes to the renderer,
    // and exits cleanly on EOF / error. We re-emit the exit code by
    // peeking into the session map after the loop terminates.
    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let event_name = format!("terminal:data:{}", id_for_thread);
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — shell closed
                Ok(n) => {
                    // xterm.js accepts raw byte strings, but Tauri events
                    // serialise via JSON which requires UTF-8. We lossily
                    // re-encode here; combined with xterm.js's own UTF-8
                    // parser this is correct in practice (the only loss is
                    // for invalid byte sequences, which shells don't emit).
                    let s = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_for_thread.emit(&event_name, s);
                }
                Err(e) => {
                    log::warn!("terminal {} read error: {}", id_for_thread, e);
                    break;
                }
            }
        }

        // Reap the child. If it's already gone we'll get Ok(None); poll
        // briefly to grab the exit code before signalling the frontend.
        let exit_code: Option<i32> = {
            let mut map = SESSIONS.lock().unwrap();
            if let Some(sess) = map.get_mut(&id_for_thread) {
                // Up to 100ms for the child to publish its exit code.
                let mut code = None;
                for _ in 0..10 {
                    match sess.child.try_wait() {
                        Ok(Some(status)) => {
                            code = status.exit_code().try_into().ok();
                            break;
                        }
                        Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                        Err(_) => break,
                    }
                }
                code
            } else {
                None
            }
        };
        let _ = app_for_thread.emit(
            &format!("terminal:exit:{}", id_for_thread),
            ExitPayload { code: exit_code },
        );
        SESSIONS.lock().unwrap().remove(&id_for_thread);
    });

    Ok(OpenResult {
        id,
        shell: shell_label,
    })
}

#[derive(Debug, Clone, Serialize)]
struct ExitPayload {
    code: Option<i32>,
}

#[tauri::command]
pub async fn terminal_write(id: String, data: String) -> Result<(), String> {
    // Grab the shared writer handle, then drop the SESSIONS lock before
    // doing any I/O so a slow flush can't block resize/close calls.
    let writer = {
        let map = SESSIONS.lock().unwrap();
        let sess = map
            .get(&id)
            .ok_or_else(|| format!("terminal '{id}' not found"))?;
        Arc::clone(&sess.writer)
    };
    let mut w = writer.lock().unwrap();
    w.write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    w.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = SESSIONS.lock().unwrap();
    let sess = map
        .get(&id)
        .ok_or_else(|| format!("terminal '{id}' not found"))?;
    sess.master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_close(id: String) -> Result<(), String> {
    let mut map = SESSIONS.lock().unwrap();
    if let Some(mut sess) = map.remove(&id) {
        // `kill` returns Err if the child has already exited, which is
        // fine — we already removed it from the map.
        let _ = sess.child.kill();
    }
    Ok(())
}

/// Best-effort shell detection. The result is also surfaced to the UI so
/// each tab can label which shell it spawned.
fn resolve_shell() -> (String, String) {
    #[cfg(unix)]
    {
        if let Ok(s) = std::env::var("SHELL") {
            if !s.is_empty() && std::path::Path::new(&s).exists() {
                let label = std::path::Path::new(&s)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| s.clone());
                return (s, label);
            }
        }
        // Sensible fallback. /bin/sh is mandated by POSIX.
        ("/bin/sh".to_string(), "sh".to_string())
    }
    #[cfg(windows)]
    {
        // Prefer the modern pwsh.exe if installed (Windows PowerShell 7+),
        // then powershell.exe, then cmd.exe. ConPTY handles all three.
        if let Ok(s) = std::env::var("COMSPEC") {
            if !s.is_empty() {
                let label = std::path::Path::new(&s)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| s.clone());
                return (s, label);
            }
        }
        (
            "powershell.exe".to_string(),
            "powershell".to_string(),
        )
    }
}
