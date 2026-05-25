use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
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
}

pub struct AppState {
    pub workspace: Arc<Mutex<Option<PathBuf>>>,
    pub cancels: Arc<Mutex<CancelTokens>>,
    pub indexer: Arc<crate::services::indexer::Indexer>,
    /// PID of an Ollama daemon Pointer spawned. We only kill what we started so
    /// a pre-existing system service stays running on app close.
    pub ollama_child: Arc<Mutex<Option<std::process::Child>>>,
    /// MCP client manager — holds every configured server's lifecycle and
    /// tool catalog. Shared by reference so the agent harness can pull a
    /// fresh tool list without grabbing a write lock on AppState.
    pub mcp: Arc<crate::services::mcp::McpManager>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspace: Arc::new(Mutex::new(None)),
            cancels: Arc::new(Mutex::new(CancelTokens::default())),
            indexer: Arc::new(crate::services::indexer::Indexer::new()),
            ollama_child: Arc::new(Mutex::new(None)),
            mcp: Arc::new(crate::services::mcp::McpManager::new()),
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
