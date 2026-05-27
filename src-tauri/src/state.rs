use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Default)]
pub struct CancelTokens {
    pub map: HashMap<String, broadcast::Sender<()>>,
}

impl CancelTokens {
    pub fn issue(&mut self, id: &str) -> broadcast::Receiver<()> {
        let (tx, rx) = broadcast::channel::<()>(1);
        self.map.insert(id.to_string(), tx);
        rx
    }
    pub fn cancel(&mut self, id: &str) -> bool {
        if let Some(tx) = self.map.remove(id) {
            let _ = tx.send(());
            true
        } else {
            false
        }
    }
    pub fn clear(&mut self, id: &str) {
        self.map.remove(id);
    }
    pub fn cancel_all(&mut self) -> Vec<String> {
        let entries: Vec<(String, broadcast::Sender<()>)> = self.map.drain().collect();
        for (_, tx) in &entries {
            let _ = tx.send(());
        }
        entries.into_iter().map(|(id, _)| id).collect()
    }
}

pub struct OwnedProcessGuard {
    registry: Arc<Mutex<HashMap<String, u32>>>,
    request_id: String,
}

impl Drop for OwnedProcessGuard {
    fn drop(&mut self) {
        self.registry.lock().remove(&self.request_id);
    }
}

pub struct AppState {
    pub workspace: Arc<Mutex<Option<PathBuf>>>,
    pub cancels: Arc<Mutex<CancelTokens>>,
    pub indexer: Arc<crate::services::indexer::Indexer>,
    /// PID of an Ollama daemon Pointer spawned. We only kill what we started so
    /// a pre-existing system service stays running on app close.
    pub ollama_child: Arc<Mutex<Option<std::process::Child>>>,
    /// PIDs of OpenCode runs Pointer spawned for Ask / Plan / Agent. These are
    /// killed on app shutdown so a closing IDE cannot leave an agent running.
    pub opencode_children: Arc<Mutex<HashMap<String, u32>>>,
    /// MCP client manager — holds every configured server's lifecycle and
    /// tool catalog. Shared by reference so the agent harness can pull a
    /// fresh tool list without grabbing a write lock on AppState.
    pub mcp: Arc<crate::services::mcp::McpManager>,
    /// Language-server manager. Starts repo-local or PATH-resolved LSP
    /// processes lazily and reuses them per workspace/language.
    pub lsp: Arc<crate::services::lsp::LspManager>,
    /// Live Ollama work registry. Enforces per-model exclusivity and feeds
    /// the Model Activity panel.
    pub inference: Arc<crate::services::inference::InferenceManager>,
    shutdown_started: AtomicBool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspace: Arc::new(Mutex::new(None)),
            cancels: Arc::new(Mutex::new(CancelTokens::default())),
            indexer: Arc::new(crate::services::indexer::Indexer::new()),
            ollama_child: Arc::new(Mutex::new(None)),
            opencode_children: Arc::new(Mutex::new(HashMap::new())),
            mcp: Arc::new(crate::services::mcp::McpManager::new()),
            lsp: Arc::new(crate::services::lsp::LspManager::new()),
            inference: Arc::new(crate::services::inference::InferenceManager::new()),
            shutdown_started: AtomicBool::new(false),
        }
    }

    /// Returns true only for the first shutdown caller. Window close and app
    /// exit can both fire during a normal quit; cleanup must be idempotent.
    pub fn begin_shutdown(&self) -> bool {
        !self.shutdown_started.swap(true, Ordering::SeqCst)
    }

    pub fn cancel_all_requests(&self) {
        let ids = self.cancels.lock().cancel_all();
        for id in ids {
            self.inference.mark_cancelling(&id);
        }
    }

    pub fn register_opencode_child(&self, request_id: String, pid: u32) -> OwnedProcessGuard {
        self.opencode_children
            .lock()
            .insert(request_id.clone(), pid);
        OwnedProcessGuard {
            registry: self.opencode_children.clone(),
            request_id,
        }
    }

    /// Terminate every OpenCode process Pointer launched. We track PIDs rather
    /// than relying on Drop because the whole app may be exiting while the
    /// async run task is still alive.
    pub fn shutdown_opencode(&self) {
        let pids: Vec<u32> = self
            .opencode_children
            .lock()
            .drain()
            .map(|(_, pid)| pid)
            .collect();
        for pid in pids {
            terminate_pid(pid, "opencode");
        }
    }

    /// Send SIGTERM (or kill on Windows) to the Ollama daemon we own, then
    /// reap it so we never leak a child on exit. Safe to call multiple times.
    pub fn shutdown_ollama(&self) {
        if let Some(mut child) = self.ollama_child.lock().take() {
            log::info!("shutting down owned Ollama child (pid {})", child.id());
            #[cfg(unix)]
            {
                let pid = child.id() as i32;
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
                // Give it ~2s to drain.
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                while std::time::Instant::now() < deadline {
                    match child.try_wait() {
                        Ok(Some(_)) => return,
                        Ok(None) => std::thread::sleep(std::time::Duration::from_millis(75)),
                        Err(_) => break,
                    }
                }
                let _ = child.kill();
            }
            #[cfg(not(unix))]
            {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

fn terminate_pid(pid: u32, label: &str) {
    log::info!("shutting down owned {label} process (pid {pid})");
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        unsafe {
            // Best effort. If the process already exited this is harmless.
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}
