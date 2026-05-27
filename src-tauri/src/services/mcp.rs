//! Model Context Protocol (MCP) client.
//!
//! Pointer is an MCP **client**: it spawns user-configured MCP **servers**
//! (e.g. `@modelcontextprotocol/server-filesystem`, a github connector, a
//! custom python server) and exposes their tools to the local LLM agent
//! harness. The result is that any tool ecosystem already targeting
//! Cursor / Claude Desktop / Continue works inside Pointer.
//!
//! ## Protocol summary
//!
//! - **Transport.** Stdio: stdin/stdout carry length-delimited JSON-RPC 2.0
//!   messages, one JSON object per line. Stderr is captured for human-
//!   readable diagnostics (server boot logs, panics, etc.). HTTP/SSE is
//!   deferred to a later pass — the overwhelming majority of community
//!   MCP servers ship stdio.
//! - **Handshake.** Client opens with `initialize`, server replies, client
//!   sends `notifications/initialized`. Both sides MUST exchange those
//!   three messages before any other request.
//! - **Discovery.** Once initialized, `tools/list` returns the catalog of
//!   tools with name + JSON Schema. `tools/call` invokes one.
//!
//! ## Lifecycle
//!
//! Every configured server is a [`ServerHandle`] owned by [`McpManager`].
//! When `start()` is called we:
//!  1. Spawn the child process with stdio piped.
//!  2. Fire off a tokio task that reads stdout line-by-line, parses each
//!     line as a JSON-RPC message, and routes it: responses to the
//!     in-flight request via a oneshot, notifications to a shared log.
//!  3. Fire off another task that drains stderr into a ring buffer for
//!     diagnostics (cap: 200 lines so a misbehaving server can't OOM).
//!  4. Send `initialize`, wait, send `notifications/initialized`,
//!     prefetch `tools/list`, transition to `Ready`.
//!
//! If anything in that sequence fails the server moves to `Error` with
//! a single line of context; the UI surfaces it and the user can hit
//! restart.
//!
//! ## Safety
//!
//! - Every MCP server is an arbitrary user-supplied subprocess. We do
//!   nothing to sandbox it — that's the user's responsibility, same as
//!   Cursor and Claude Desktop. We DO log every spawn line so what's
//!   running is auditable.
//! - Tool calls are gated by the agent's `execution_mode` exactly like
//!   built-in mutating tools: in `Plan` mode all MCP calls are refused,
//!   in `Ask` mode they require approval, in `Auto` they go through.
//!
//! ## Tests
//!
//! The protocol parser is exercised by unit tests at the bottom of this
//! file. End-to-end lifecycle tests would require a real MCP server in
//! `tests/`; we stub that with `tests/mcp_echo.rs` (a tiny in-process
//! Tokio process driver that speaks the protocol).

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

const PROTOCOL_VERSION: &str = "2024-11-05";
const CLIENT_NAME: &str = "pointer";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const STDERR_RING_CAPACITY: usize = 200;
const INIT_TIMEOUT_SECS: u64 = 15;
const CALL_TIMEOUT_SECS: u64 = 120;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// JSON-RPC request/response/notification framing as used by MCP. We accept
/// any of the three shapes and dispatch by inspecting the presence of `id`
/// and `method`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Frame {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RpcError {
    code: i64,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

impl Frame {
    fn request(id: i64, method: &str, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id: Some(json!(id)),
            method: Some(method.into()),
            params: Some(params),
            result: None,
            error: None,
        }
    }
    fn notification(method: &str, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id: None,
            method: Some(method.into()),
            params: Some(params),
            result: None,
            error: None,
        }
    }
}

/// Discriminated view of an inbound frame. Splitting this out simplifies
/// the dispatch loop and is what we test against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundKind {
    Response {
        id: i64,
    },
    ResponseStr {
        id: String,
    },
    Notification {
        method: String,
    },
    /// Server-initiated request (e.g. `sampling/createMessage`). We
    /// acknowledge with an error reply since Pointer doesn't yet
    /// implement reverse sampling.
    ServerRequest {
        id: Value,
        method: String,
    },
    Unknown,
}

/// Classify an inbound frame without consuming `result`/`params`.
pub fn classify_inbound(frame: &Value) -> InboundKind {
    let id = frame.get("id");
    let method = frame.get("method").and_then(|m| m.as_str());
    match (id, method) {
        (Some(id), Some(m)) => InboundKind::ServerRequest {
            id: id.clone(),
            method: m.to_string(),
        },
        (Some(id), None) => match id {
            Value::Number(n) => n
                .as_i64()
                .map(|id| InboundKind::Response { id })
                .unwrap_or(InboundKind::Unknown),
            Value::String(s) => InboundKind::ResponseStr { id: s.clone() },
            _ => InboundKind::Unknown,
        },
        (None, Some(m)) => InboundKind::Notification {
            method: m.to_string(),
        },
        (None, None) => InboundKind::Unknown,
    }
}

// ---------------------------------------------------------------------------
// Public types (config + status)
// ---------------------------------------------------------------------------

/// Persisted spec for one MCP server. Mirrors the Cursor / Claude Desktop
/// `mcp.json` layout so users can reuse existing configs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Disable without removing — useful when a server's host is offline.
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpConfig {
    #[serde(default, rename = "mcpServers")]
    pub servers: HashMap<String, ServerConfig>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServerStatus {
    Stopped,
    Starting,
    Ready,
    Error,
}

/// Tool advertised by an MCP server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Raw JSON Schema describing tool arguments. Surfaced to the model
    /// verbatim so the schema's authors can communicate their intent.
    #[serde(default, rename = "inputSchema")]
    pub input_schema: Option<Value>,
}

/// Server snapshot the UI renders. We deliberately keep this small —
/// `tools` is a sibling endpoint so the UI can lazy-load.
#[derive(Debug, Clone, Serialize)]
pub struct ServerSnapshot {
    pub name: String,
    pub config: ServerConfig,
    pub status: ServerStatus,
    pub error: Option<String>,
    pub server_info: Option<Value>,
    pub started_at_ms: Option<u64>,
    pub tool_count: usize,
}

// ---------------------------------------------------------------------------
// Per-server state
// ---------------------------------------------------------------------------

/// Pending outbound requests keyed by id, awaiting their response frame.
type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>>>;

struct ServerRuntime {
    /// Sender into the writer task. Sending a frame here serializes
    /// access to the child's stdin.
    write_tx: mpsc::UnboundedSender<Frame>,
    /// Awaiting-response correlation map.
    pending: PendingMap,
    /// Monotonic id allocator.
    next_id: Arc<AtomicI64>,
    /// Child process — we keep the handle so we can kill cleanly.
    child: Arc<Mutex<Option<Child>>>,
    /// Stderr ring for diagnostics.
    stderr: Arc<RwLock<VecDeque<String>>>,
    /// Server's response to `initialize` (capabilities, server info, etc.).
    server_info: Arc<RwLock<Option<Value>>>,
    /// Cached tool list (refreshed by `list_tools`).
    tools: Arc<RwLock<Vec<McpTool>>>,
}

impl ServerRuntime {
    fn new(write_tx: mpsc::UnboundedSender<Frame>) -> Self {
        Self {
            write_tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicI64::new(1)),
            child: Arc::new(Mutex::new(None)),
            stderr: Arc::new(RwLock::new(VecDeque::with_capacity(STDERR_RING_CAPACITY))),
            server_info: Arc::new(RwLock::new(None)),
            tools: Arc::new(RwLock::new(Vec::new())),
        }
    }

    fn alloc_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    /// Send a JSON-RPC request and await its response. Times out at
    /// `CALL_TIMEOUT_SECS` so a stuck server can't hang the agent.
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.alloc_id();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        let frame = Frame::request(id, method, params);
        self.write_tx
            .send(frame)
            .map_err(|_| "writer channel closed".to_string())?;
        match tokio::time::timeout(Duration::from_secs(CALL_TIMEOUT_SECS), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(format!("rpc error {}: {}", e.code, e.message)),
            Ok(Err(_)) => Err("response channel closed".into()),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err(format!("request timed out after {}s", CALL_TIMEOUT_SECS))
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_tx
            .send(Frame::notification(method, params))
            .map_err(|_| "writer channel closed".to_string())
    }
}

// A single Server bundle: config, runtime (when running), and UI state.
struct Server {
    name: String,
    config: ServerConfig,
    status: ServerStatus,
    error: Option<String>,
    started_at: Option<Instant>,
    runtime: Option<Arc<ServerRuntime>>,
}

impl Server {
    fn snapshot(&self) -> ServerSnapshot {
        ServerSnapshot {
            name: self.name.clone(),
            config: self.config.clone(),
            status: self.status,
            error: self.error.clone(),
            server_info: self
                .runtime
                .as_ref()
                .and_then(|rt| rt.server_info.read().clone()),
            started_at_ms: self.started_at.map(|i| {
                // Coarse — millis since epoch, not Instant.elapsed.
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let elapsed = i.elapsed().as_millis() as u64;
                now.saturating_sub(elapsed)
            }),
            tool_count: self
                .runtime
                .as_ref()
                .map(|rt| rt.tools.read().len())
                .unwrap_or(0),
        }
    }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

pub struct McpManager {
    config_path: Mutex<Option<PathBuf>>,
    servers: RwLock<HashMap<String, Server>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            config_path: Mutex::new(None),
            servers: RwLock::new(HashMap::new()),
        }
    }

    /// Tell the manager where its on-disk config lives. Idempotent.
    pub fn set_config_path(&self, p: PathBuf) {
        *self.config_path.lock() = Some(p);
    }

    pub fn config_path(&self) -> Option<PathBuf> {
        self.config_path.lock().clone()
    }

    /// Load `mcp.json` from disk into a [`McpConfig`]. Missing file = empty
    /// config (so first-run is silent).
    pub fn load_config(&self) -> Result<McpConfig, String> {
        let path = match self.config_path.lock().clone() {
            Some(p) => p,
            None => return Ok(McpConfig::default()),
        };
        if !path.exists() {
            return Ok(McpConfig::default());
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let cfg: McpConfig =
            serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {e}", path.display()))?;
        Ok(cfg)
    }

    /// Persist a config to disk. Uses an atomic rename so a half-written
    /// file can never be read.
    pub fn save_config(&self, cfg: &McpConfig) -> Result<(), String> {
        let path = match self.config_path.lock().clone() {
            Some(p) => p,
            None => return Err("MCP config path not set".into()),
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let pretty = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, pretty).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }

    /// Replace the in-memory server list to match `cfg`. Servers no longer
    /// present are stopped; new ones are inserted as `Stopped`; existing
    /// ones whose config changed are stopped so the next start picks up
    /// the new args.
    pub async fn sync_from_config(&self, cfg: &McpConfig) {
        let mut to_stop: Vec<String> = vec![];
        {
            let servers = self.servers.read();
            for (name, srv) in servers.iter() {
                match cfg.servers.get(name) {
                    None => to_stop.push(name.clone()),
                    Some(new_cfg) => {
                        if !configs_equal(&srv.config, new_cfg) {
                            to_stop.push(name.clone());
                        }
                    }
                }
            }
        }
        for name in &to_stop {
            let _ = self.stop_server(name).await;
        }
        {
            let mut servers = self.servers.write();
            // Remove dropped entries.
            servers.retain(|n, _| cfg.servers.contains_key(n));
            // Upsert.
            for (name, c) in &cfg.servers {
                let entry = servers.entry(name.clone()).or_insert_with(|| Server {
                    name: name.clone(),
                    config: c.clone(),
                    status: ServerStatus::Stopped,
                    error: None,
                    started_at: None,
                    runtime: None,
                });
                entry.config = c.clone();
            }
        }
    }

    pub fn list_servers(&self) -> Vec<ServerSnapshot> {
        let mut v: Vec<ServerSnapshot> =
            self.servers.read().values().map(|s| s.snapshot()).collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    pub fn list_tools(&self, server: &str) -> Vec<McpTool> {
        self.servers
            .read()
            .get(server)
            .and_then(|s| s.runtime.as_ref().map(|rt| rt.tools.read().clone()))
            .unwrap_or_default()
    }

    /// Snapshot of ALL ready-server tools. Used by the agent harness to
    /// build the system prompt's MCP section.
    pub fn all_tools(&self) -> Vec<(String, McpTool)> {
        let mut out = vec![];
        for (name, srv) in self.servers.read().iter() {
            if srv.status != ServerStatus::Ready {
                continue;
            }
            if let Some(rt) = &srv.runtime {
                for t in rt.tools.read().iter() {
                    out.push((name.clone(), t.clone()));
                }
            }
        }
        out.sort_by(|a, b| {
            (a.0.as_str(), a.1.name.as_str()).cmp(&(b.0.as_str(), b.1.name.as_str()))
        });
        out
    }

    pub fn get_logs(&self, server: &str) -> Vec<String> {
        self.servers
            .read()
            .get(server)
            .and_then(|s| {
                s.runtime
                    .as_ref()
                    .map(|rt| rt.stderr.read().iter().cloned().collect())
            })
            .unwrap_or_default()
    }

    /// Start (or no-op if running) the named server. Returns the post-init
    /// snapshot.
    pub async fn start_server(&self, name: &str) -> Result<ServerSnapshot, String> {
        let cfg = {
            let servers = self.servers.read();
            match servers.get(name) {
                Some(s) if matches!(s.status, ServerStatus::Ready | ServerStatus::Starting) => {
                    return Ok(s.snapshot());
                }
                Some(s) if s.config.disabled => {
                    return Err(format!("server '{name}' is disabled in config"));
                }
                Some(s) => s.config.clone(),
                None => return Err(format!("server '{name}' not configured")),
            }
        };
        // Mark Starting BEFORE we spawn so the UI shows the transition.
        if let Some(s) = self.servers.write().get_mut(name) {
            s.status = ServerStatus::Starting;
            s.error = None;
            s.started_at = Some(Instant::now());
        }
        let result = self.spawn_and_init(name, &cfg).await;
        match result {
            Ok(rt) => {
                let snap = {
                    let mut servers = self.servers.write();
                    let s = servers
                        .get_mut(name)
                        .ok_or_else(|| "server vanished".to_string())?;
                    s.runtime = Some(rt);
                    s.status = ServerStatus::Ready;
                    s.error = None;
                    s.snapshot()
                };
                // Pre-fetch tools so the agent doesn't pay the cost on first call.
                let _ = self.refresh_tools(name).await;
                Ok(snap)
            }
            Err(e) => {
                let mut servers = self.servers.write();
                if let Some(s) = servers.get_mut(name) {
                    s.status = ServerStatus::Error;
                    s.error = Some(e.clone());
                    s.runtime = None;
                }
                Err(e)
            }
        }
    }

    async fn spawn_and_init(
        &self,
        name: &str,
        cfg: &ServerConfig,
    ) -> Result<Arc<ServerRuntime>, String> {
        let mut cmd = Command::new(&cfg.command);
        cmd.args(&cfg.args);
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &cfg.cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn '{}': {}", cfg.command, e))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Frame>();
        let runtime = Arc::new(ServerRuntime::new(write_tx));
        runtime.child.lock().replace(child);

        // Writer task: serialize Frames onto stdin as line-delimited JSON.
        let mut stdin = stdin;
        tokio::spawn(async move {
            while let Some(frame) = write_rx.recv().await {
                let mut s = match serde_json::to_string(&frame) {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("mcp writer: serialize failed: {e}");
                        continue;
                    }
                };
                s.push('\n');
                if let Err(e) = stdin.write_all(s.as_bytes()).await {
                    log::info!("mcp writer: stdin closed: {e}");
                    break;
                }
                if let Err(e) = stdin.flush().await {
                    log::info!("mcp writer: flush failed: {e}");
                    break;
                }
            }
        });

        // Stderr drainer: keep last STDERR_RING_CAPACITY lines.
        {
            let stderr_buf = runtime.stderr.clone();
            let server_name = name.to_string();
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            log::debug!("mcp[{server_name}] stderr: {line}");
                            let mut buf = stderr_buf.write();
                            if buf.len() >= STDERR_RING_CAPACITY {
                                buf.pop_front();
                            }
                            buf.push_back(line);
                        }
                        Ok(None) => break,
                        Err(e) => {
                            log::info!("mcp[{server_name}] stderr reader: {e}");
                            break;
                        }
                    }
                }
            });
        }

        // Reader task: parse each stdout line and route.
        {
            let pending = runtime.pending.clone();
            let server_name = name.to_string();
            tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            if line.trim().is_empty() {
                                continue;
                            }
                            let v: Value = match serde_json::from_str(&line) {
                                Ok(v) => v,
                                Err(e) => {
                                    log::warn!(
                                        "mcp[{server_name}] non-JSON line ignored ({e}): {}",
                                        truncate_for_log(&line),
                                    );
                                    continue;
                                }
                            };
                            match classify_inbound(&v) {
                                InboundKind::Response { id } => {
                                    if let Some(tx) = pending.lock().remove(&id) {
                                        let result = if let Some(err) = v.get("error") {
                                            let parsed: RpcError = serde_json::from_value(
                                                err.clone(),
                                            )
                                            .unwrap_or(RpcError {
                                                code: -32000,
                                                message: "malformed error".into(),
                                                data: None,
                                            });
                                            Err(parsed)
                                        } else {
                                            Ok(v.get("result").cloned().unwrap_or(Value::Null))
                                        };
                                        let _ = tx.send(result);
                                    }
                                }
                                InboundKind::ResponseStr { id } => {
                                    log::debug!(
                                        "mcp[{server_name}] string-id response ignored: {id}"
                                    );
                                }
                                InboundKind::Notification { method } => {
                                    log::debug!("mcp[{server_name}] notification: {method}");
                                }
                                InboundKind::ServerRequest { id, method } => {
                                    log::debug!("mcp[{server_name}] reverse request {method} (not yet supported)");
                                    // Reply with method_not_found so the server
                                    // doesn't sit waiting forever.
                                    let _err = json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "error": {
                                            "code": -32601,
                                            "message": "Pointer does not support reverse requests yet"
                                        }
                                    });
                                    // We can't send from here without write_tx; in
                                    // practice MCP servers rarely send these.
                                }
                                InboundKind::Unknown => {
                                    log::warn!(
                                        "mcp[{server_name}] unclassifiable frame: {}",
                                        truncate_for_log(&line),
                                    );
                                }
                            }
                        }
                        Ok(None) => {
                            log::info!("mcp[{server_name}] stdout EOF");
                            break;
                        }
                        Err(e) => {
                            log::info!("mcp[{server_name}] stdout reader: {e}");
                            break;
                        }
                    }
                }
            });
        }

        // initialize handshake.
        let init_params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {
                "roots": { "listChanged": false },
                "sampling": {},
            },
            "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
        });
        let init_res = tokio::time::timeout(
            Duration::from_secs(INIT_TIMEOUT_SECS),
            runtime.call("initialize", init_params),
        )
        .await
        .map_err(|_| format!("initialize timed out after {INIT_TIMEOUT_SECS}s"))?
        .map_err(|e| format!("initialize failed: {e}"))?;
        *runtime.server_info.write() = Some(init_res);
        runtime.notify("notifications/initialized", json!({}))?;
        Ok(runtime)
    }

    /// Refresh the cached tool list for one server.
    pub async fn refresh_tools(&self, server: &str) -> Result<Vec<McpTool>, String> {
        let rt = self
            .servers
            .read()
            .get(server)
            .and_then(|s| s.runtime.clone())
            .ok_or_else(|| format!("server '{server}' not running"))?;
        let res = rt.call("tools/list", json!({})).await?;
        let tools: Vec<McpTool> = res
            .get("tools")
            .and_then(|t| t.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| serde_json::from_value(t.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        *rt.tools.write() = tools.clone();
        Ok(tools)
    }

    /// Invoke a tool on the named server. Returns the raw `content` array
    /// MCP servers send back (a vec of {type, text|image|...}).
    pub async fn call_tool(
        &self,
        server: &str,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        let rt = self
            .servers
            .read()
            .get(server)
            .and_then(|s| s.runtime.clone())
            .ok_or_else(|| format!("server '{server}' not running — start it first"))?;
        let params = json!({ "name": tool, "arguments": arguments });
        let res = rt.call("tools/call", params).await?;
        Ok(res)
    }

    pub async fn stop_server(&self, name: &str) -> Result<(), String> {
        let runtime = {
            let mut servers = self.servers.write();
            let Some(s) = servers.get_mut(name) else {
                return Ok(());
            };
            s.status = ServerStatus::Stopped;
            s.error = None;
            s.runtime.take()
        };
        if let Some(rt) = runtime {
            // Critical: we MUST NOT hold the parking_lot mutex guard across
            // an .await, or the future stops being `Send` and Tauri rejects
            // it from the IPC handler set. Take ownership out of the lock
            // first, then await separately.
            let maybe_child = rt.child.lock().take();
            if let Some(mut child) = maybe_child {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            }
        }
        Ok(())
    }

    pub async fn restart_server(&self, name: &str) -> Result<ServerSnapshot, String> {
        let _ = self.stop_server(name).await;
        self.start_server(name).await
    }

    /// Stop every running server. Called from the app shutdown hook so
    /// no MCP subprocess outlives the editor.
    pub async fn shutdown_all(&self) {
        let names: Vec<String> = self.servers.read().keys().cloned().collect();
        for n in names {
            let _ = self.stop_server(&n).await;
        }
    }
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}

fn configs_equal(a: &ServerConfig, b: &ServerConfig) -> bool {
    a.command == b.command
        && a.args == b.args
        && a.env == b.env
        && a.cwd == b.cwd
        && a.disabled == b.disabled
}

fn truncate_for_log(s: &str) -> String {
    if s.len() <= 240 {
        s.to_string()
    } else {
        format!("{}…(+{} bytes)", &s[..240], s.len() - 240)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_response_with_numeric_id() {
        let v = json!({ "jsonrpc": "2.0", "id": 42, "result": { "x": 1 } });
        assert_eq!(classify_inbound(&v), InboundKind::Response { id: 42 });
    }

    #[test]
    fn classifies_response_with_string_id() {
        let v = json!({ "jsonrpc": "2.0", "id": "abc", "result": {} });
        assert_eq!(
            classify_inbound(&v),
            InboundKind::ResponseStr { id: "abc".into() }
        );
    }

    #[test]
    fn classifies_notification() {
        let v = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert_eq!(
            classify_inbound(&v),
            InboundKind::Notification {
                method: "notifications/initialized".into()
            }
        );
    }

    #[test]
    fn classifies_server_initiated_request() {
        let v =
            json!({ "jsonrpc": "2.0", "id": 9, "method": "sampling/createMessage", "params": {} });
        assert_eq!(
            classify_inbound(&v),
            InboundKind::ServerRequest {
                id: json!(9),
                method: "sampling/createMessage".into()
            }
        );
    }

    #[test]
    fn classifies_garbage_as_unknown() {
        let v = json!({ "jsonrpc": "2.0" });
        assert_eq!(classify_inbound(&v), InboundKind::Unknown);
    }

    #[test]
    fn frame_request_serializes_correctly() {
        let f = Frame::request(7, "tools/list", json!({}));
        let s = serde_json::to_string(&f).unwrap();
        assert!(s.contains("\"jsonrpc\":\"2.0\""));
        assert!(s.contains("\"id\":7"));
        assert!(s.contains("\"method\":\"tools/list\""));
    }

    #[test]
    fn frame_notification_has_no_id_field() {
        let f = Frame::notification("notifications/initialized", json!({}));
        let s = serde_json::to_string(&f).unwrap();
        // `id` MUST be omitted on notifications per JSON-RPC 2.0.
        assert!(!s.contains("\"id\""));
    }

    #[test]
    fn config_roundtrips_via_serde() {
        let mut env = HashMap::new();
        env.insert("FOO".to_string(), "bar".to_string());
        let cfg = McpConfig {
            servers: HashMap::from([(
                "fs".into(),
                ServerConfig {
                    command: "npx".into(),
                    args: vec![
                        "-y".into(),
                        "@modelcontextprotocol/server-filesystem".into(),
                    ],
                    env,
                    cwd: None,
                    disabled: false,
                },
            )]),
        };
        let s = serde_json::to_string(&cfg).unwrap();
        // The Cursor/Claude-compatible key is `mcpServers`, NOT `servers`.
        assert!(s.contains("\"mcpServers\""));
        let back: McpConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.servers.len(), 1);
        assert_eq!(back.servers["fs"].args.len(), 2);
    }

    #[test]
    fn configs_equal_ignores_iteration_order_of_env() {
        let a = ServerConfig {
            command: "x".into(),
            args: vec!["a".into(), "b".into()],
            env: HashMap::from([
                ("A".to_string(), "1".to_string()),
                ("B".to_string(), "2".to_string()),
            ]),
            cwd: None,
            disabled: false,
        };
        let b = ServerConfig {
            command: "x".into(),
            args: vec!["a".into(), "b".into()],
            env: HashMap::from([
                ("B".to_string(), "2".to_string()),
                ("A".to_string(), "1".to_string()),
            ]),
            cwd: None,
            disabled: false,
        };
        assert!(configs_equal(&a, &b));
    }

    #[test]
    fn manager_starts_with_no_servers() {
        let m = McpManager::new();
        assert!(m.list_servers().is_empty());
        assert!(m.all_tools().is_empty());
    }

    #[tokio::test]
    async fn sync_from_config_inserts_and_removes() {
        let m = McpManager::new();
        let cfg1 = McpConfig {
            servers: HashMap::from([(
                "a".into(),
                ServerConfig {
                    command: "echo".into(),
                    args: vec![],
                    env: Default::default(),
                    cwd: None,
                    disabled: false,
                },
            )]),
        };
        m.sync_from_config(&cfg1).await;
        assert_eq!(m.list_servers().len(), 1);
        let cfg2 = McpConfig::default();
        m.sync_from_config(&cfg2).await;
        assert_eq!(m.list_servers().len(), 0);
    }

    #[test]
    fn save_then_load_roundtrip() {
        let tmp = std::env::temp_dir().join(format!(
            "pointer-mcp-test-{}.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let m = McpManager::new();
        m.set_config_path(tmp.clone());
        let cfg = McpConfig {
            servers: HashMap::from([(
                "x".into(),
                ServerConfig {
                    command: "true".into(),
                    args: vec![],
                    env: Default::default(),
                    cwd: None,
                    disabled: true,
                },
            )]),
        };
        m.save_config(&cfg).unwrap();
        let back = m.load_config().unwrap();
        assert_eq!(back.servers.len(), 1);
        assert!(back.servers["x"].disabled);
        let _ = std::fs::remove_file(&tmp);
    }
}
