use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerStatus {
    pub language: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    pub command: Option<String>,
    pub source: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHover {
    pub contents: String,
    pub range: Option<LspRange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocation {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspTextEdit {
    pub range: LspRange,
    pub new_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionItem {
    pub label: String,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub kind: Option<u32>,
    pub insert_text: Option<String>,
    pub insert_text_format: Option<u32>,
    pub filter_text: Option<String>,
    pub sort_text: Option<String>,
    pub preselect: Option<bool>,
    pub range: Option<LspRange>,
    pub additional_text_edits: Vec<LspTextEdit>,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentSymbol {
    pub name: String,
    pub kind: u32,
    pub detail: Option<String>,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub children: Vec<LspDocumentSymbol>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticEvent {
    pub uri: String,
    pub path: String,
    pub diagnostics: Vec<LspDiagnostic>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub range: LspRange,
    pub severity: Option<u32>,
    pub code: Option<String>,
    pub source: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspTextDocumentRequest {
    pub path: String,
    pub language: String,
    pub content: String,
    pub line: u32,
    pub column: u32,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentRequest {
    pub path: String,
    pub language: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionResolveRequest {
    pub path: String,
    pub language: String,
    pub content: String,
    pub item: LspCompletionItem,
}

#[derive(Debug, Clone)]
struct ExternalSpec {
    language: &'static str,
    label: &'static str,
    command: String,
    args: Vec<String>,
    source: String,
    capabilities: Vec<String>,
}

#[derive(Default)]
pub struct LspManager {
    clients: Mutex<HashMap<String, Arc<LspClient>>>,
}

impl LspManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn statuses(&self, root: &Path) -> Vec<LanguageServerStatus> {
        let clients = self.clients.lock().await;
        let mut out = vec![];
        for lang in [
            "javascript",
            "typescript",
            "vue",
            "rust",
            "css",
            "html",
            "xml",
            "json",
            "yaml",
            "toml",
            "shell",
            "dockerfile",
            "makefile",
            "ini",
            "sql",
            "graphql",
            "prisma",
            "python",
            "go",
            "c",
            "cpp",
            "ruby",
            "php",
            "markdown",
            "mdx",
            "astro",
            "svelte",
            "handlebars",
            "erb",
            "ejs",
            "pug",
            "liquid",
            "twig",
            "razor",
            "java",
            "kotlin",
            "scala",
            "groovy",
            "clojure",
            "csharp",
            "fsharp",
            "swift",
            "objective-c",
            "powershell",
            "bat",
            "lua",
            "perl",
            "dart",
            "hcl",
            "bicep",
            "solidity",
            "wgsl",
            "typespec",
            "system-verilog",
            "verilog",
            "proto",
        ] {
            let key = client_key(root, lang);
            let running = clients.contains_key(&key);
            out.push(status_for_language(root, lang, running));
        }
        out
    }

    pub async fn did_open_or_change(
        &self,
        app: AppHandle,
        root: &Path,
        doc: LspDocumentRequest,
    ) -> Result<(), String> {
        let Some(client) = self.ensure_client(app, root, &doc.language).await? else {
            return Ok(());
        };
        client
            .sync_document(&doc.path, &doc.language, &doc.content)
            .await
    }

    pub async fn hover(
        &self,
        app: AppHandle,
        root: &Path,
        req: LspTextDocumentRequest,
    ) -> Result<Option<LspHover>, String> {
        let Some(client) = self.ensure_client(app, root, &req.language).await? else {
            return Ok(None);
        };
        client
            .sync_document(&req.path, &req.language, &req.content)
            .await?;
        let result = client
            .request(
                "textDocument/hover",
                json!({
                    "textDocument": { "uri": file_uri(Path::new(&req.path)) },
                    "position": lsp_position(req.line, req.column),
                }),
            )
            .await?;
        Ok(parse_hover(&result))
    }

    pub async fn definition(
        &self,
        app: AppHandle,
        root: &Path,
        req: LspTextDocumentRequest,
    ) -> Result<Vec<LspLocation>, String> {
        let Some(client) = self.ensure_client(app, root, &req.language).await? else {
            return Ok(vec![]);
        };
        client
            .sync_document(&req.path, &req.language, &req.content)
            .await?;
        let result = client
            .request(
                "textDocument/definition",
                json!({
                    "textDocument": { "uri": file_uri(Path::new(&req.path)) },
                    "position": lsp_position(req.line, req.column),
                }),
            )
            .await?;
        Ok(parse_locations(&result))
    }

    pub async fn completion(
        &self,
        app: AppHandle,
        root: &Path,
        req: LspTextDocumentRequest,
    ) -> Result<Vec<LspCompletionItem>, String> {
        let Some(client) = self.ensure_client(app, root, &req.language).await? else {
            return Ok(vec![]);
        };
        client
            .sync_document(&req.path, &req.language, &req.content)
            .await?;
        let result = client
            .request(
                "textDocument/completion",
                json!({
                    "textDocument": { "uri": file_uri(Path::new(&req.path)) },
                    "position": lsp_position(req.line, req.column),
                    "context": { "triggerKind": 1 },
                }),
            )
            .await?;
        Ok(parse_completion(&result, req.limit.unwrap_or(80)))
    }

    pub async fn completion_resolve(
        &self,
        app: AppHandle,
        root: &Path,
        req: LspCompletionResolveRequest,
    ) -> Result<LspCompletionItem, String> {
        let Some(client) = self.ensure_client(app, root, &req.language).await? else {
            return Ok(req.item);
        };
        client
            .sync_document(&req.path, &req.language, &req.content)
            .await?;
        let original = req.item.clone();
        let result = client
            .request("completionItem/resolve", completion_item_to_lsp(&req.item))
            .await;
        match result {
            Ok(value) => Ok(parse_completion_item(&value).unwrap_or(original)),
            Err(_) => Ok(original),
        }
    }

    pub async fn document_symbols(
        &self,
        app: AppHandle,
        root: &Path,
        req: LspDocumentRequest,
    ) -> Result<Vec<LspDocumentSymbol>, String> {
        let Some(client) = self.ensure_client(app, root, &req.language).await? else {
            return Ok(vec![]);
        };
        client
            .sync_document(&req.path, &req.language, &req.content)
            .await?;
        let result = client
            .request(
                "textDocument/documentSymbol",
                json!({
                    "textDocument": { "uri": file_uri(Path::new(&req.path)) },
                }),
            )
            .await?;
        Ok(parse_document_symbols(&result))
    }

    pub async fn shutdown_all(&self) {
        let clients = self
            .clients
            .lock()
            .await
            .drain()
            .map(|(_, c)| c)
            .collect::<Vec<_>>();
        for client in clients {
            client.shutdown().await;
        }
    }

    async fn ensure_client(
        &self,
        app: AppHandle,
        root: &Path,
        language: &str,
    ) -> Result<Option<Arc<LspClient>>, String> {
        let normal = normalize_language(language);
        let Some(spec) = external_spec_for(root, normal) else {
            return Ok(None);
        };
        let key = client_key(root, spec.language);
        if let Some(existing) = self.clients.lock().await.get(&key).cloned() {
            return Ok(Some(existing));
        }
        let client = LspClient::start(app, root.to_path_buf(), spec.clone()).await?;
        let mut clients = self.clients.lock().await;
        if let Some(existing) = clients.get(&key).cloned() {
            drop(clients);
            client.shutdown().await;
            return Ok(Some(existing));
        }
        clients.insert(key, client.clone());
        Ok(Some(client))
    }
}

struct LspClient {
    root: PathBuf,
    spec: ExternalSpec,
    stdin: Arc<Mutex<ChildStdin>>,
    child: Mutex<Child>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    open_docs: Mutex<HashMap<String, i32>>,
    ts_bridge: Option<Arc<TsServerBridge>>,
    next_id: AtomicU64,
}

struct TsServerBridge {
    label: String,
    stdin: Arc<Mutex<ChildStdin>>,
    child: Mutex<Child>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    open_docs: Mutex<HashMap<String, String>>,
    next_seq: AtomicU64,
}

impl TsServerBridge {
    async fn start(root: &Path) -> Result<Arc<Self>, String> {
        let tsdk = resolve_typescript_sdk(root)
            .ok_or_else(|| "TypeScript SDK not found for Vue language service".to_string())?;
        let tsserver = tsdk.join("tsserver.js");
        if !tsserver.is_file() {
            return Err(format!("tsserver.js not found at {}", tsserver.display()));
        }
        let plugin_probe = typescript_node_modules_dir(&tsdk)
            .ok_or_else(|| format!("cannot infer node_modules from {}", tsdk.display()))?;
        let node = resolve_node_command(root);
        let mut cmd = Command::new(&node);
        cmd.arg(&tsserver)
            .arg("--globalPlugins")
            .arg("@vue/typescript-plugin")
            .arg("--pluginProbeLocations")
            .arg(&plugin_probe)
            .current_dir(root)
            .env("PATH", augmented_path(root))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("start Vue tsserver bridge ({node}): {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Vue tsserver bridge did not expose stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Vue tsserver bridge did not expose stdout".to_string())?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        log::debug!("lsp vue tsserver: {line}");
                    }
                }
            });
        }

        let pending = Arc::new(Mutex::new(HashMap::new()));
        let bridge = Arc::new(Self {
            label: "Vue tsserver bridge".into(),
            stdin: Arc::new(Mutex::new(stdin)),
            child: Mutex::new(child),
            pending: pending.clone(),
            open_docs: Mutex::new(HashMap::new()),
            next_seq: AtomicU64::new(1),
        });
        tokio::spawn(tsserver_read_loop(stdout, pending));
        Ok(bridge)
    }

    async fn sync_document(&self, path: &str, content: &str) -> Result<(), String> {
        let (command, args) = {
            let mut docs = self.open_docs.lock().await;
            match docs.insert(path.to_string(), content.to_string()) {
                Some(previous) => {
                    let end = tsserver_end_position(&previous);
                    (
                        "change",
                        json!({
                            "file": path,
                            "line": 1,
                            "offset": 1,
                            "endLine": end.0,
                            "endOffset": end.1,
                            "insertString": content,
                        }),
                    )
                }
                None => (
                    "open",
                    json!({
                        "file": path,
                        "fileContent": content,
                        "scriptKindName": tsserver_script_kind(path),
                    }),
                ),
            }
        };
        let _ = self.request(command, args, Duration::from_secs(10)).await?;
        Ok(())
    }

    async fn proxy_request(&self, command: &str, args: Value) -> Result<Value, String> {
        self.request(command, args, Duration::from_secs(12)).await
    }

    async fn request(
        &self,
        command: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(seq, tx);
        self.send(json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": args,
        }))
        .await?;
        let response = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => return Err(format!("{} closed request channel", self.label)),
            Err(_) => {
                self.pending.lock().await.remove(&seq);
                return Err(format!("{} timed out on {command}", self.label));
            }
        };
        if response.get("success").and_then(|v| v.as_bool()) == Some(false) {
            return Ok(Value::Null);
        }
        Ok(response.get("body").cloned().unwrap_or(Value::Null))
    }

    async fn send(&self, value: Value) -> Result<(), String> {
        let mut body = value.to_string();
        body.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(body.as_bytes())
            .await
            .map_err(|e| format!("write {} request: {e}", self.label))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush {}: {e}", self.label))
    }

    async fn shutdown(&self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }
}

impl LspClient {
    async fn start(app: AppHandle, root: PathBuf, spec: ExternalSpec) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new(&spec.command);
        cmd.args(&spec.args)
            .current_dir(&root)
            .env("PATH", augmented_path(&root))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("start {}: {e}", spec.label))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("{} did not expose stdin", spec.label))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("{} did not expose stdout", spec.label))?;
        if let Some(stderr) = child.stderr.take() {
            let label = spec.label.to_string();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        log::debug!("lsp {label}: {line}");
                    }
                }
            });
        }

        let pending = Arc::new(Mutex::new(HashMap::new()));
        let stdin = Arc::new(Mutex::new(stdin));
        let ts_bridge = if spec.language == "vue" {
            match TsServerBridge::start(&root).await {
                Ok(bridge) => Some(bridge),
                Err(e) => {
                    log::warn!("lsp {}: Vue tsserver bridge unavailable: {e}", spec.label);
                    None
                }
            }
        } else {
            None
        };
        let client = Arc::new(Self {
            root: root.clone(),
            spec,
            stdin: stdin.clone(),
            child: Mutex::new(child),
            pending: pending.clone(),
            open_docs: Mutex::new(HashMap::new()),
            ts_bridge: ts_bridge.clone(),
            next_id: AtomicU64::new(1),
        });
        tokio::spawn(read_loop(
            app,
            client.spec.label.to_string(),
            root,
            stdin,
            ts_bridge,
            stdout,
            pending,
        ));
        if let Err(e) = client.initialize().await {
            client.shutdown().await;
            return Err(e);
        }
        Ok(client)
    }

    async fn initialize(&self) -> Result<(), String> {
        let root_uri = file_uri(&self.root);
        let result = self
            .request(
                "initialize",
                json!({
                    "processId": null,
                    "rootUri": root_uri,
                    "workspaceFolders": [{
                        "uri": root_uri,
                        "name": self.root.file_name().and_then(|s| s.to_str()).unwrap_or("workspace")
                    }],
                    "capabilities": {
                        "textDocument": {
                            "synchronization": { "didSave": true, "dynamicRegistration": false },
                            "hover": { "contentFormat": ["markdown", "plaintext"] },
                            "definition": { "linkSupport": true },
                            "completion": {
                                "contextSupport": true,
                                "completionItem": {
                                    "snippetSupport": true,
                                    "documentationFormat": ["markdown", "plaintext"],
                                    "deprecatedSupport": true,
                                    "preselectSupport": true,
                                    "insertReplaceSupport": true,
                                    "labelDetailsSupport": true,
                                    "resolveSupport": {
                                        "properties": [
                                            "documentation",
                                            "detail",
                                            "additionalTextEdits",
                                            "sortText",
                                            "filterText",
                                            "insertText",
                                            "textEdit"
                                        ]
                                    }
                                }
                            },
                            "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                            "publishDiagnostics": { "relatedInformation": true }
                        },
                        "workspace": {
                            "workspaceFolders": true,
                            "configuration": true
                        }
                    }
                }),
            )
            .await?;
        if result.is_null() {
            return Err(format!(
                "{} returned empty initialize result",
                self.spec.label
            ));
        }
        self.notify("initialized", json!({})).await?;
        Ok(())
    }

    async fn sync_document(&self, path: &str, language: &str, content: &str) -> Result<(), String> {
        if let Some(bridge) = &self.ts_bridge {
            if let Err(e) = bridge.sync_document(path, content).await {
                log::warn!(
                    "lsp {}: Vue tsserver sync failed for {path}: {e}",
                    self.spec.label
                );
            }
        }
        let uri = file_uri(Path::new(path));
        let language_id = lsp_language_id(Path::new(path), language);
        let notification = {
            let mut docs = self.open_docs.lock().await;
            match docs.get_mut(path) {
                Some(version) => {
                    *version += 1;
                    json!({
                        "textDocument": {
                            "uri": uri,
                            "version": *version,
                        },
                        "contentChanges": [{ "text": content }]
                    })
                }
                None => {
                    docs.insert(path.to_string(), 1);
                    json!({
                        "textDocument": {
                            "uri": uri,
                            "languageId": language_id,
                            "version": 1,
                            "text": content
                        }
                    })
                }
            }
        };
        let method = if notification.get("contentChanges").is_some() {
            "textDocument/didChange"
        } else {
            "textDocument/didOpen"
        };
        self.notify(method, notification).await
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await?;
        let response = match tokio::time::timeout(Duration::from_secs(12), rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => return Err(format!("{} closed request channel", self.spec.label)),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                return Err(format!("{} timed out on {method}", self.spec.label));
            }
        };
        if let Some(err) = response.get("error") {
            return Err(format!("{} {method}: {err}", self.spec.label));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn send(&self, value: Value) -> Result<(), String> {
        write_lsp_message(&self.stdin, &self.spec.label, &value).await
    }

    async fn shutdown(&self) {
        let _ = self.request("shutdown", json!(null)).await;
        let _ = self.notify("exit", json!(null)).await;
        if let Some(bridge) = &self.ts_bridge {
            bridge.shutdown().await;
        }
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }
}

async fn read_loop(
    app: AppHandle,
    label: String,
    root: PathBuf,
    stdin: Arc<Mutex<ChildStdin>>,
    ts_bridge: Option<Arc<TsServerBridge>>,
    stdout: tokio::process::ChildStdout,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
) {
    let mut reader = BufReader::new(stdout);
    let root_uri = file_uri(&root);
    let root_name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .to_string();
    loop {
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            let Ok(n) = reader.read_line(&mut line).await else {
                return;
            };
            if n == 0 {
                return;
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                break;
            }
            if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                content_length = rest.trim().parse::<usize>().ok();
            }
        }
        let Some(len) = content_length else {
            continue;
        };
        let mut buf = vec![0u8; len];
        if reader.read_exact(&mut buf).await.is_err() {
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buf) else {
            log::warn!("lsp {label}: invalid json-rpc payload");
            continue;
        };
        if let Some(id_value) = value.get("id").cloned() {
            if let Some(id) = id_value.as_u64() {
                if let Some(tx) = pending.lock().await.remove(&id) {
                    let _ = tx.send(value);
                    continue;
                }
            }
            if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
                let params = value.get("params").unwrap_or(&Value::Null);
                let result = server_request_result(method, params, &root_uri, &root_name);
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": id_value,
                    "result": result,
                });
                if let Err(e) = write_lsp_message(&stdin, &label, &response).await {
                    log::warn!("lsp {label}: failed responding to {method}: {e}");
                    return;
                }
            }
            continue;
        }
        if value.get("method").and_then(|m| m.as_str()) == Some("textDocument/publishDiagnostics") {
            if let Some(event) =
                parse_diagnostics_event(value.get("params").unwrap_or(&Value::Null))
            {
                let _ = app.emit("lsp:diagnostics", event);
            }
            continue;
        }
        if value.get("method").and_then(|m| m.as_str()) == Some("tsserver/request") {
            if let Some(response) = vue_tsserver_response(
                value.get("params").unwrap_or(&Value::Null),
                &root,
                ts_bridge.clone(),
            )
            .await
            {
                if let Err(e) = write_lsp_message(&stdin, &label, &response).await {
                    log::warn!("lsp {label}: failed responding to Vue tsserver bridge: {e}");
                    return;
                }
            }
        }
    }
}

async fn tsserver_read_loop(
    stdout: tokio::process::ChildStdout,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            let Ok(n) = reader.read_line(&mut line).await else {
                return;
            };
            if n == 0 {
                return;
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                break;
            }
            if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                content_length = rest.trim().parse::<usize>().ok();
            }
        }
        let Some(len) = content_length else {
            continue;
        };
        let mut buf = vec![0u8; len];
        if reader.read_exact(&mut buf).await.is_err() {
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buf) else {
            log::warn!("lsp vue tsserver: invalid protocol payload");
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) != Some("response") {
            continue;
        }
        let Some(seq) = value.get("request_seq").and_then(|v| v.as_u64()) else {
            continue;
        };
        if let Some(tx) = pending.lock().await.remove(&seq) {
            let _ = tx.send(value);
        }
    }
}

async fn write_lsp_message(
    stdin: &Arc<Mutex<ChildStdin>>,
    label: &str,
    value: &Value,
) -> Result<(), String> {
    let body = value.to_string();
    let header = format!("Content-Length: {}\r\n\r\n", body.as_bytes().len());
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(header.as_bytes())
        .await
        .map_err(|e| format!("write {label} header: {e}"))?;
    stdin
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("write {label} body: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("flush {label}: {e}"))
}

fn server_request_result(method: &str, params: &Value, root_uri: &str, root_name: &str) -> Value {
    match method {
        // Language servers routinely ask the client for settings after
        // initialize. Returning one empty config object per requested item is
        // the neutral LSP answer and avoids servers waiting on a response that
        // never arrives.
        "workspace/configuration" => {
            let items = params
                .get("items")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            Value::Array(items.iter().map(configuration_item_result).collect())
        }
        "workspace/workspaceFolders" => json!([{ "uri": root_uri, "name": root_name }]),
        "workspace/applyEdit" => json!({ "applied": false }),
        "client/registerCapability"
        | "client/unregisterCapability"
        | "window/workDoneProgress/create"
        | "window/showMessageRequest" => Value::Null,
        _ => {
            log::debug!("lsp server request {method}: replying with null result");
            Value::Null
        }
    }
}

fn configuration_item_result(item: &Value) -> Value {
    let section = item
        .get("section")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    match section {
        "html.customData" | "css.customData" | "scss.customData" | "less.customData" => {
            Value::Array(vec![])
        }
        "http" => json!({ "proxy": "", "proxyStrictSSL": true }),
        _ => json!({}),
    }
}

async fn vue_tsserver_response(
    params: &Value,
    root: &Path,
    bridge: Option<Arc<TsServerBridge>>,
) -> Option<Value> {
    let (request_id, command, args) = parse_vue_tsserver_request(params)?;
    let result = if let Some(bridge) = bridge {
        match bridge.proxy_request(&command, args.clone()).await {
            Ok(value) => value,
            Err(e) => {
                log::warn!("lsp vue tsserver bridge failed for {command}: {e}");
                vue_tsserver_fallback_result(&command, &args, root)
            }
        }
    } else {
        vue_tsserver_fallback_result(&command, &args, root)
    };
    Some(vue_tsserver_response_value(request_id, result))
}

fn parse_vue_tsserver_request(params: &Value) -> Option<(Value, String, Value)> {
    let outer = params.as_array()?;
    // vscode-jsonrpc's sendNotification(method, tuple) serializes tuple as a
    // single positional argument, so the wire payload is usually
    // [[id, command, args]]. Accept the flat shape too for compatibility.
    let tuple = outer.first().and_then(|v| v.as_array()).unwrap_or(outer);
    let request_id = tuple.first()?.clone();
    let command = tuple
        .get(1)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let args = tuple.get(2).cloned().unwrap_or(Value::Null);
    Some((request_id, command, args))
}

fn vue_tsserver_fallback_result(command: &str, args: &Value, root: &Path) -> Value {
    match command {
        "_vue:projectInfo" => args
            .get("file")
            .and_then(|v| v.as_str())
            .and_then(|file| nearest_project_config(root, Path::new(file)))
            .map(|config| {
                json!({
                    "configFileName": config.display().to_string(),
                    "languageServiceDisabled": false,
                })
            })
            .unwrap_or(Value::Null),
        // The full Volar bridge can proxy these to tsserver. Pointer's LSP
        // client answers neutrally so the Vue server falls back instead of
        // hanging semantic requests when no bridge is present.
        _ => Value::Null,
    }
}

fn vue_tsserver_response_value(request_id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "tsserver/response",
        "params": [[request_id, result]],
    })
}

fn nearest_project_config(root: &Path, file: &Path) -> Option<PathBuf> {
    let root = root.to_path_buf();
    let mut dir = file
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.clone());
    loop {
        for name in ["tsconfig.json", "jsconfig.json"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        if dir == root || !dir.pop() {
            break;
        }
    }
    None
}

fn status_for_language(root: &Path, language: &str, running: bool) -> LanguageServerStatus {
    let normal = normalize_language(language);
    if let Some(spec) = external_spec_for(root, normal) {
        return LanguageServerStatus {
            language: normal.to_string(),
            label: spec.label.to_string(),
            status: if running { "ready" } else { "available" }.into(),
            detail: if running {
                format!("{} is running for this workspace.", spec.label)
            } else {
                format!(
                    "{} is available and will start when a matching file opens.",
                    spec.label
                )
            },
            command: Some(
                format!("{} {}", spec.command, spec.args.join(" "))
                    .trim()
                    .to_string(),
            ),
            source: spec.source,
            capabilities: spec.capabilities,
        };
    }

    match normal {
        "javascript" | "typescript" | "css" | "html" | "json" => LanguageServerStatus {
            language: normal.into(),
            label: "Monaco worker".into(),
            status: "monaco".into(),
            detail: "Using Monaco's built-in worker for syntax, diagnostics, hover, completion, and definitions where supported.".into(),
            command: None,
            source: "bundled".into(),
            capabilities: vec!["syntax".into(), "hover".into(), "completion".into(), "definition".into(), "diagnostics".into()],
        },
        "vue" => LanguageServerStatus {
            language: normal.into(),
            label: "Vue support".into(),
            status: "syntax".into(),
            detail: "Vue syntax, outline, and local component/property completions are built in. vue-language-server adds semantic hover, diagnostics, and definitions when available.".into(),
            command: None,
            source: "built-in".into(),
            capabilities: vec!["syntax".into(), "outline".into(), "completion".into()],
        },
        "plaintext" => LanguageServerStatus {
            language: normal.into(),
            label: "Plain text".into(),
            status: "syntax".into(),
            detail: "Plain text editing is available for this file.".into(),
            command: None,
            source: "built-in".into(),
            capabilities: vec!["syntax".into()],
        },
        _ if syntax_only_language(normal) => LanguageServerStatus {
            language: normal.into(),
            label: "Syntax mode".into(),
            status: "syntax".into(),
            detail: "Syntax highlighting and editor basics are available; no semantic language server is configured for this file type.".into(),
            command: None,
            source: "built-in".into(),
            capabilities: vec!["syntax".into(), "outline".into()],
        },
        _ => LanguageServerStatus {
            language: normal.into(),
            label: "No language server".into(),
            status: "missing".into(),
            detail: "No language server was found in the workspace, Pointer install, or PATH.".into(),
            command: None,
            source: "missing".into(),
            capabilities: vec!["syntax".into()],
        },
    }
}

fn external_spec_for(root: &Path, language: &str) -> Option<ExternalSpec> {
    let normal = normalize_language(language);
    let caps = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let found = |bin: &str| resolve_bin(root, bin);
    match normal {
        "rust" => found("rust-analyzer").map(|(command, source)| ExternalSpec {
            language: "rust",
            label: "rust-analyzer",
            command,
            args: vec![],
            source,
            capabilities: caps(&[
                "hover",
                "definition",
                "completion",
                "diagnostics",
                "symbols",
            ]),
        }),
        "javascript" | "typescript" => {
            found("typescript-language-server").map(|(command, source)| ExternalSpec {
                language: normal,
                label: "typescript-language-server",
                command,
                args: vec!["--stdio".into()],
                source,
                capabilities: caps(&[
                    "hover",
                    "definition",
                    "completion",
                    "diagnostics",
                    "symbols",
                ]),
            })
        }
        "vue" => found("vue-language-server").map(|(command, source)| ExternalSpec {
            language: "vue",
            label: "vue-language-server",
            command,
            args: {
                let mut args = vec!["--stdio".into()];
                if let Some(tsdk) = resolve_typescript_sdk(root) {
                    args.push(format!("--tsdk={}", tsdk.display()));
                }
                args
            },
            source,
            capabilities: caps(&[
                "hover",
                "definition",
                "completion",
                "diagnostics",
                "symbols",
            ]),
        }),
        "css" => found("vscode-css-language-server").map(|(command, source)| ExternalSpec {
            language: "css",
            label: "vscode-css-language-server",
            command,
            args: vec!["--stdio".into()],
            source,
            capabilities: caps(&["hover", "completion", "diagnostics", "symbols"]),
        }),
        "html" => found("vscode-html-language-server").map(|(command, source)| ExternalSpec {
            language: "html",
            label: "vscode-html-language-server",
            command,
            args: vec!["--stdio".into()],
            source,
            capabilities: caps(&["hover", "completion", "diagnostics", "symbols"]),
        }),
        "json" => found("vscode-json-language-server").map(|(command, source)| ExternalSpec {
            language: "json",
            label: "vscode-json-language-server",
            command,
            args: vec!["--stdio".into()],
            source,
            capabilities: caps(&["hover", "completion", "diagnostics", "symbols"]),
        }),
        "yaml" => found("yaml-language-server").map(|(command, source)| ExternalSpec {
            language: "yaml",
            label: "yaml-language-server",
            command,
            args: vec!["--stdio".into()],
            source,
            capabilities: caps(&["hover", "completion", "diagnostics", "symbols"]),
        }),
        "toml" => found("taplo").map(|(command, source)| ExternalSpec {
            language: "toml",
            label: "taplo",
            command,
            args: vec!["lsp".into(), "stdio".into()],
            source,
            capabilities: caps(&["hover", "completion", "diagnostics", "symbols"]),
        }),
        "shell" => found("bash-language-server").map(|(command, source)| ExternalSpec {
            language: "shell",
            label: "bash-language-server",
            command,
            args: vec!["start".into()],
            source,
            capabilities: caps(&[
                "hover",
                "definition",
                "completion",
                "diagnostics",
                "symbols",
            ]),
        }),
        "dockerfile" => found("docker-langserver").map(|(command, source)| ExternalSpec {
            language: "dockerfile",
            label: "docker-langserver",
            command,
            args: vec!["--stdio".into()],
            source,
            capabilities: caps(&["hover", "completion", "diagnostics", "symbols"]),
        }),
        "markdown" => found("marksman").map(|(command, source)| ExternalSpec {
            language: "markdown",
            label: "marksman",
            command,
            args: vec!["server".into()],
            source,
            capabilities: caps(&[
                "hover",
                "definition",
                "completion",
                "diagnostics",
                "symbols",
            ]),
        }),
        "lua" => found("lua-language-server").map(|(command, source)| ExternalSpec {
            language: "lua",
            label: "lua-language-server",
            command,
            args: vec![],
            source,
            capabilities: caps(&[
                "hover",
                "definition",
                "completion",
                "diagnostics",
                "symbols",
            ]),
        }),
        "go" => found("gopls").map(|(command, source)| ExternalSpec {
            language: "go",
            label: "gopls",
            command,
            args: vec![],
            source,
            capabilities: caps(&[
                "hover",
                "definition",
                "completion",
                "diagnostics",
                "symbols",
            ]),
        }),
        "python" => found("pyright-langserver")
            .map(|(command, source)| ExternalSpec {
                language: "python",
                label: "pyright-langserver",
                command,
                args: vec!["--stdio".into()],
                source,
                capabilities: caps(&[
                    "hover",
                    "definition",
                    "completion",
                    "diagnostics",
                    "symbols",
                ]),
            })
            .or_else(|| {
                found("pylsp").map(|(command, source)| ExternalSpec {
                    language: "python",
                    label: "pylsp",
                    command,
                    args: vec![],
                    source,
                    capabilities: caps(&[
                        "hover",
                        "definition",
                        "completion",
                        "diagnostics",
                        "symbols",
                    ]),
                })
            }),
        "c" | "cpp" => found("clangd").map(|(command, source)| ExternalSpec {
            language: normal,
            label: "clangd",
            command,
            args: vec![],
            source,
            capabilities: caps(&[
                "hover",
                "definition",
                "completion",
                "diagnostics",
                "symbols",
            ]),
        }),
        "ruby" => found("solargraph").map(|(command, source)| ExternalSpec {
            language: "ruby",
            label: "solargraph",
            command,
            args: vec!["stdio".into()],
            source,
            capabilities: caps(&[
                "hover",
                "definition",
                "completion",
                "diagnostics",
                "symbols",
            ]),
        }),
        "php" => found("intelephense").map(|(command, source)| ExternalSpec {
            language: "php",
            label: "intelephense",
            command,
            args: vec!["--stdio".into()],
            source,
            capabilities: caps(&[
                "hover",
                "definition",
                "completion",
                "diagnostics",
                "symbols",
            ]),
        }),
        _ => None,
    }
}

fn resolve_bin(root: &Path, bin: &str) -> Option<(String, String)> {
    let mut candidates: Vec<(PathBuf, String)> = vec![];
    let mut dir = Some(root);
    while let Some(d) = dir {
        candidates.push((
            d.join("node_modules").join(".bin").join(bin),
            "workspace".into(),
        ));
        #[cfg(windows)]
        candidates.push((
            d.join("node_modules")
                .join(".bin")
                .join(format!("{bin}.cmd")),
            "workspace".into(),
        ));
        candidates.push((d.join(".venv").join("bin").join(bin), "workspace".into()));
        candidates.push((d.join("venv").join("bin").join(bin), "workspace".into()));
        dir = d.parent();
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push((
            cwd.join("node_modules").join(".bin").join(bin),
            "pointer".into(),
        ));
        #[cfg(windows)]
        candidates.push((
            cwd.join("node_modules")
                .join(".bin")
                .join(format!("{bin}.cmd")),
            "pointer".into(),
        ));
    }
    for (candidate, source) in candidates {
        if candidate.is_file() && binary_is_usable(&candidate, bin) {
            return Some((candidate.display().to_string(), source));
        }
    }
    for path in std::env::split_paths(&augmented_path(root)) {
        let candidate = path.join(bin);
        if candidate.is_file() && binary_is_usable(&candidate, bin) {
            return Some((candidate.display().to_string(), "PATH".into()));
        }
        #[cfg(windows)]
        {
            let candidate = path.join(format!("{bin}.exe"));
            if candidate.is_file() && binary_is_usable(&candidate, bin) {
                return Some((candidate.display().to_string(), "PATH".into()));
            }
        }
    }
    None
}

fn resolve_typescript_sdk(root: &Path) -> Option<PathBuf> {
    let mut dir = Some(root);
    while let Some(d) = dir {
        let candidate = d.join("node_modules").join("typescript").join("lib");
        if candidate.is_dir() {
            return Some(candidate);
        }
        dir = d.parent();
    }
    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join("node_modules").join("typescript").join("lib");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

fn typescript_node_modules_dir(tsdk: &Path) -> Option<PathBuf> {
    let typescript_dir = tsdk.parent()?;
    let node_modules = typescript_dir.parent()?;
    if node_modules.file_name().and_then(|s| s.to_str()) == Some("node_modules") {
        Some(node_modules.to_path_buf())
    } else {
        None
    }
}

fn resolve_node_command(root: &Path) -> String {
    resolve_bin(root, "node")
        .map(|(command, _)| command)
        .unwrap_or_else(|| "node".into())
}

fn tsserver_script_kind(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
    {
        "ts" => "TS",
        "tsx" => "TSX",
        "jsx" => "JSX",
        "json" => "JSON",
        _ => "JS",
    }
}

fn tsserver_end_position(content: &str) -> (usize, usize) {
    let mut line = 1usize;
    let mut offset = 1usize;
    for ch in content.chars() {
        if ch == '\n' {
            line += 1;
            offset = 1;
        } else {
            offset += 1;
        }
    }
    (line, offset)
}

fn binary_is_usable(path: &Path, bin: &str) -> bool {
    // rustup leaves proxy shims in ~/.cargo/bin even when the component
    // is not installed. Spawning that shim looks like success until the
    // LSP initialize request times out, so validate it up front.
    if bin != "rust-analyzer" {
        return true;
    }
    let Ok(output) = std::process::Command::new(path).arg("--version").output() else {
        return false;
    };
    output.status.success()
}

fn augmented_path(root: &Path) -> String {
    let mut paths: Vec<PathBuf> = vec![];
    let mut dir = Some(root);
    while let Some(d) = dir {
        paths.push(d.join("node_modules").join(".bin"));
        paths.push(d.join(".venv").join("bin"));
        paths.push(d.join("venv").join("bin"));
        dir = d.parent();
    }
    if let Ok(cwd) = std::env::current_dir() {
        paths.push(cwd.join("node_modules").join(".bin"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let h = PathBuf::from(home);
        paths.push(h.join(".cargo").join("bin"));
        paths.push(h.join("go").join("bin"));
        paths.push(h.join(".local").join("bin"));
        paths.push(h.join(".pyenv").join("shims"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin"));
    paths.push(PathBuf::from("/usr/local/bin"));
    paths.push(PathBuf::from("/usr/bin"));
    paths.push(PathBuf::from("/bin"));
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    let mut seen = std::collections::HashSet::new();
    let unique = paths
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect::<Vec<_>>();
    std::env::join_paths(unique)
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

fn normalize_language(language: &str) -> &'static str {
    match language {
        "typescript" | "typescriptreact" | "tsx" | "ts" => "typescript",
        "javascript" | "javascriptreact" | "jsx" | "js" => "javascript",
        "vue" => "vue",
        "rust" | "rs" => "rust",
        "css" | "scss" | "less" => "css",
        "html" => "html",
        "astro" => "astro",
        "svelte" => "svelte",
        "erb" => "erb",
        "xml" => "xml",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "shell" | "sh" | "bash" | "zsh" | "fish" => "shell",
        "dockerfile" => "dockerfile",
        "makefile" => "makefile",
        "ini" => "ini",
        "sql" => "sql",
        "graphql" | "gql" => "graphql",
        "prisma" => "prisma",
        "python" | "py" => "python",
        "go" => "go",
        "c" => "c",
        "cpp" | "cxx" | "cc" => "cpp",
        "ruby" | "rb" => "ruby",
        "php" => "php",
        "markdown" | "mdx" => "markdown",
        "handlebars" => "handlebars",
        "ejs" => "ejs",
        "pug" => "pug",
        "liquid" => "liquid",
        "twig" => "twig",
        "razor" => "razor",
        "java" => "java",
        "kotlin" => "kotlin",
        "scala" => "scala",
        "groovy" => "groovy",
        "clojure" => "clojure",
        "csharp" => "csharp",
        "fsharp" => "fsharp",
        "swift" => "swift",
        "objective-c" => "objective-c",
        "powershell" => "powershell",
        "bat" => "bat",
        "lua" => "lua",
        "perl" => "perl",
        "dart" => "dart",
        "hcl" => "hcl",
        "bicep" => "bicep",
        "sol" | "solidity" => "solidity",
        "wgsl" => "wgsl",
        "typespec" => "typespec",
        "systemverilog" | "system-verilog" => "systemverilog",
        "verilog" => "verilog",
        "proto" => "proto",
        "elixir" => "elixir",
        "julia" => "julia",
        "r" => "r",
        "qsharp" => "qsharp",
        _ => "plaintext",
    }
}

fn syntax_only_language(language: &str) -> bool {
    matches!(
        language,
        "xml"
            | "yaml"
            | "toml"
            | "shell"
            | "dockerfile"
            | "makefile"
            | "ini"
            | "sql"
            | "graphql"
            | "prisma"
            | "markdown"
            | "astro"
            | "svelte"
            | "handlebars"
            | "erb"
            | "ejs"
            | "pug"
            | "liquid"
            | "twig"
            | "razor"
            | "java"
            | "kotlin"
            | "scala"
            | "groovy"
            | "clojure"
            | "csharp"
            | "fsharp"
            | "swift"
            | "objective-c"
            | "powershell"
            | "bat"
            | "lua"
            | "perl"
            | "dart"
            | "hcl"
            | "bicep"
            | "solidity"
            | "wgsl"
            | "typespec"
            | "systemverilog"
            | "verilog"
            | "proto"
            | "elixir"
            | "julia"
            | "r"
            | "qsharp"
    )
}

fn lsp_language_id(path: &Path, language: &str) -> String {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    match ext {
        "tsx" => "typescriptreact",
        "jsx" => "javascriptreact",
        "vue" => "vue",
        _ => normalize_language(language),
    }
    .to_string()
}

fn client_key(root: &Path, language: &str) -> String {
    format!("{}::{}", root.display(), normalize_language(language))
}

fn lsp_position(line: u32, column: u32) -> Value {
    json!({
        "line": line.saturating_sub(1),
        "character": column.saturating_sub(1),
    })
}

fn parse_hover(value: &Value) -> Option<LspHover> {
    if value.is_null() {
        return None;
    }
    let contents = value.get("contents").unwrap_or(value);
    let text = hover_contents_to_string(contents);
    if text.trim().is_empty() {
        return None;
    }
    Some(LspHover {
        contents: text,
        range: value.get("range").and_then(parse_range),
    })
}

fn hover_contents_to_string(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.to_string();
    }
    if let Some(obj) = value.as_object() {
        if let Some(v) = obj.get("value").and_then(|v| v.as_str()) {
            return v.to_string();
        }
        if let (Some(lang), Some(v)) = (
            obj.get("language").and_then(|v| v.as_str()),
            obj.get("value").and_then(|v| v.as_str()),
        ) {
            return format!("```{lang}\n{v}\n```");
        }
    }
    if let Some(arr) = value.as_array() {
        return arr
            .iter()
            .map(hover_contents_to_string)
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    String::new()
}

fn parse_locations(value: &Value) -> Vec<LspLocation> {
    if value.is_null() {
        return vec![];
    }
    let arr = value
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![value.clone()]);
    arr.iter()
        .filter_map(|v| {
            let uri = v
                .get("uri")
                .or_else(|| v.get("targetUri"))
                .and_then(|u| u.as_str())?;
            let range = v
                .get("range")
                .or_else(|| v.get("targetSelectionRange"))
                .or_else(|| v.get("targetRange"))
                .and_then(parse_range)?;
            Some(LspLocation {
                path: uri_to_path(uri),
                line: range.start_line,
                column: range.start_column,
                end_line: range.end_line,
                end_column: range.end_column,
            })
        })
        .collect()
}

fn parse_completion(value: &Value, limit: usize) -> Vec<LspCompletionItem> {
    let items = value
        .get("items")
        .and_then(|v| v.as_array())
        .or_else(|| value.as_array());
    let Some(items) = items else {
        return vec![];
    };
    items
        .iter()
        .take(limit)
        .filter_map(parse_completion_item)
        .collect()
}

fn parse_completion_item(item: &Value) -> Option<LspCompletionItem> {
    let label = item.get("label").and_then(|v| v.as_str())?.to_string();
    let documentation = item
        .get("documentation")
        .map(hover_contents_to_string)
        .filter(|s| !s.trim().is_empty());
    let text_edit = item.get("textEdit");
    let insert_text = item
        .get("insertText")
        .and_then(|v| v.as_str())
        .or_else(|| {
            text_edit
                .and_then(|t| t.get("newText"))
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string());
    let range = text_edit
        .and_then(|t| {
            t.get("range")
                .or_else(|| t.get("replace"))
                .or_else(|| t.get("insert"))
        })
        .and_then(parse_range);
    let additional_text_edits = item
        .get("additionalTextEdits")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(parse_text_edit).collect())
        .unwrap_or_default();
    Some(LspCompletionItem {
        label,
        detail: item
            .get("detail")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        documentation,
        kind: item.get("kind").and_then(|v| v.as_u64()).map(|v| v as u32),
        insert_text,
        insert_text_format: item
            .get("insertTextFormat")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        filter_text: item
            .get("filterText")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        sort_text: item
            .get("sortText")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        preselect: item.get("preselect").and_then(|v| v.as_bool()),
        range,
        additional_text_edits,
        data: item.get("data").cloned(),
    })
}

fn parse_text_edit(value: &Value) -> Option<LspTextEdit> {
    Some(LspTextEdit {
        range: parse_range(value.get("range")?)?,
        new_text: value.get("newText")?.as_str()?.to_string(),
    })
}

fn completion_item_to_lsp(item: &LspCompletionItem) -> Value {
    let mut value = json!({ "label": item.label.clone() });
    let obj = value.as_object_mut().expect("json object");
    if let Some(kind) = item.kind {
        obj.insert("kind".into(), json!(kind));
    }
    if let Some(detail) = &item.detail {
        obj.insert("detail".into(), json!(detail));
    }
    if let Some(documentation) = &item.documentation {
        obj.insert(
            "documentation".into(),
            json!({ "kind": "markdown", "value": documentation }),
        );
    }
    if let Some(insert_text) = &item.insert_text {
        obj.insert("insertText".into(), json!(insert_text));
    }
    if let Some(format) = item.insert_text_format {
        obj.insert("insertTextFormat".into(), json!(format));
    }
    if let Some(filter_text) = &item.filter_text {
        obj.insert("filterText".into(), json!(filter_text));
    }
    if let Some(sort_text) = &item.sort_text {
        obj.insert("sortText".into(), json!(sort_text));
    }
    if let Some(preselect) = item.preselect {
        obj.insert("preselect".into(), json!(preselect));
    }
    if let (Some(range), Some(new_text)) = (&item.range, item.insert_text.as_ref()) {
        obj.insert(
            "textEdit".into(),
            json!({
                "range": lsp_range_to_value(range),
                "newText": new_text,
            }),
        );
    }
    if !item.additional_text_edits.is_empty() {
        obj.insert(
            "additionalTextEdits".into(),
            Value::Array(
                item.additional_text_edits
                    .iter()
                    .map(text_edit_to_value)
                    .collect(),
            ),
        );
    }
    if let Some(data) = &item.data {
        obj.insert("data".into(), data.clone());
    }
    value
}

fn text_edit_to_value(edit: &LspTextEdit) -> Value {
    json!({
        "range": lsp_range_to_value(&edit.range),
        "newText": edit.new_text.clone(),
    })
}

fn lsp_range_to_value(range: &LspRange) -> Value {
    json!({
        "start": {
            "line": range.start_line.saturating_sub(1),
            "character": range.start_column.saturating_sub(1),
        },
        "end": {
            "line": range.end_line.saturating_sub(1),
            "character": range.end_column.saturating_sub(1),
        },
    })
}

fn parse_document_symbols(value: &Value) -> Vec<LspDocumentSymbol> {
    let Some(arr) = value.as_array() else {
        return vec![];
    };
    arr.iter().filter_map(parse_document_symbol).collect()
}

fn parse_document_symbol(value: &Value) -> Option<LspDocumentSymbol> {
    let name = value.get("name").and_then(|v| v.as_str())?.to_string();
    let kind = value.get("kind").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
    let range_value = value
        .get("selectionRange")
        .or_else(|| value.get("range"))
        .or_else(|| value.get("location").and_then(|l| l.get("range")))?;
    let range = parse_range(range_value)?;
    let children = value
        .get("children")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(parse_document_symbol).collect())
        .unwrap_or_default();
    Some(LspDocumentSymbol {
        name,
        kind,
        detail: value
            .get("detail")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        line: range.start_line,
        column: range.start_column,
        end_line: range.end_line,
        end_column: range.end_column,
        children,
    })
}

fn parse_diagnostics_event(value: &Value) -> Option<LspDiagnosticEvent> {
    let uri = value.get("uri").and_then(|v| v.as_str())?.to_string();
    let diagnostics = value
        .get("diagnostics")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(parse_diagnostic).collect())
        .unwrap_or_default();
    Some(LspDiagnosticEvent {
        path: uri_to_path(&uri),
        uri,
        diagnostics,
    })
}

fn parse_diagnostic(value: &Value) -> Option<LspDiagnostic> {
    Some(LspDiagnostic {
        range: parse_range(value.get("range")?)?,
        severity: value
            .get("severity")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        code: value.get("code").map(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| v.to_string())
        }),
        source: value
            .get("source")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        message: value
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

fn parse_range(value: &Value) -> Option<LspRange> {
    let start = value.get("start")?;
    let end = value.get("end")?;
    Some(LspRange {
        start_line: start.get("line")?.as_u64()? as u32 + 1,
        start_column: start.get("character")?.as_u64()? as u32 + 1,
        end_line: end.get("line")?.as_u64()? as u32 + 1,
        end_column: end.get("character")?.as_u64()? as u32 + 1,
    })
}

fn file_uri(path: &Path) -> String {
    format!("file://{}", percent_encode_path(&path.to_string_lossy()))
}

fn uri_to_path(uri: &str) -> String {
    let raw = uri.strip_prefix("file://").unwrap_or(uri);
    percent_decode(raw)
}

fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b':' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_common_monaco_language_ids() {
        assert_eq!(normalize_language("typescriptreact"), "typescript");
        assert_eq!(normalize_language("tsx"), "typescript");
        assert_eq!(normalize_language("jsx"), "javascript");
        assert_eq!(normalize_language("scss"), "css");
        assert_eq!(normalize_language("xml"), "xml");
        assert_eq!(normalize_language("mdx"), "markdown");
        assert_eq!(normalize_language("sol"), "solidity");
        assert_eq!(normalize_language("system-verilog"), "systemverilog");
        assert_eq!(normalize_language("yml"), "yaml");
        assert_eq!(normalize_language("bash"), "shell");
        assert_eq!(normalize_language("dockerfile"), "dockerfile");
    }

    #[test]
    fn lsp_language_id_preserves_react_variants() {
        assert_eq!(
            lsp_language_id(Path::new("/repo/App.tsx"), "typescript"),
            "typescriptreact"
        );
        assert_eq!(
            lsp_language_id(Path::new("/repo/App.jsx"), "javascript"),
            "javascriptreact"
        );
    }

    #[test]
    fn parses_hover_markup_content() {
        let value = json!({
            "contents": { "kind": "markdown", "value": "**Router**" },
            "range": {
                "start": { "line": 1, "character": 2 },
                "end": { "line": 1, "character": 8 }
            }
        });
        let hover = parse_hover(&value).unwrap();
        assert_eq!(hover.contents, "**Router**");
        assert_eq!(hover.range.unwrap().start_line, 2);
    }

    #[test]
    fn parses_definition_location_and_location_link() {
        let value = json!([
            {
                "uri": "file:///tmp/a%20b.rs",
                "range": {
                    "start": { "line": 4, "character": 1 },
                    "end": { "line": 4, "character": 9 }
                }
            },
            {
                "targetUri": "file:///tmp/c.rs",
                "targetSelectionRange": {
                    "start": { "line": 9, "character": 3 },
                    "end": { "line": 9, "character": 7 }
                }
            }
        ]);
        let locs = parse_locations(&value);
        assert_eq!(locs[0].path, "/tmp/a b.rs");
        assert_eq!(locs[0].line, 5);
        assert_eq!(locs[1].column, 4);
    }

    #[test]
    fn parses_completion_text_edits_and_resolve_data() {
        let value = json!({
            "items": [
                {
                    "label": "useEffect",
                    "kind": 3,
                    "detail": "React hook",
                    "insertTextFormat": 2,
                    "filterText": "useEffect",
                    "sortText": "11",
                    "preselect": true,
                    "textEdit": {
                        "range": {
                            "start": { "line": 2, "character": 8 },
                            "end": { "line": 2, "character": 11 }
                        },
                        "newText": "useEffect($1)"
                    },
                    "additionalTextEdits": [
                        {
                            "range": {
                                "start": { "line": 0, "character": 0 },
                                "end": { "line": 0, "character": 0 }
                            },
                            "newText": "import { useEffect } from 'react';\n"
                        }
                    ],
                    "data": { "entryNames": [{ "name": "useEffect" }] }
                }
            ]
        });
        let items = parse_completion(&value, 10);
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.insert_text.as_deref(), Some("useEffect($1)"));
        assert_eq!(item.insert_text_format, Some(2));
        assert_eq!(item.range.as_ref().unwrap().start_column, 9);
        assert_eq!(item.additional_text_edits[0].range.start_line, 1);
        assert!(item.data.is_some());

        let raw = completion_item_to_lsp(item);
        assert_eq!(raw["label"], json!("useEffect"));
        assert_eq!(raw["textEdit"]["newText"], json!("useEffect($1)"));
        assert_eq!(
            raw["additionalTextEdits"][0]["newText"],
            json!("import { useEffect } from 'react';\n")
        );
    }

    #[test]
    fn resolves_workspace_local_language_server_binary() {
        let dir = tempfile::tempdir().unwrap();
        let bin_dir = dir.path().join("node_modules/.bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let bin = bin_dir.join("typescript-language-server");
        std::fs::write(&bin, "").unwrap();
        let (path, source) = resolve_bin(dir.path(), "typescript-language-server").unwrap();
        assert_eq!(source, "workspace");
        assert_eq!(Path::new(&path), bin.as_path());
    }

    #[test]
    fn answers_workspace_configuration_requests() {
        let result = server_request_result(
            "workspace/configuration",
            &json!({ "items": [{ "section": "typescript" }, { "section": "html.customData" }] }),
            "file:///repo",
            "repo",
        );
        assert_eq!(result, json!([{}, []]));
    }

    #[test]
    fn reports_xml_as_syntax_without_claiming_html_lsp() {
        let status = status_for_language(Path::new("/repo"), "xml", false);
        assert_eq!(status.language, "xml");
        assert_eq!(status.status, "syntax");
    }

    #[test]
    fn reports_repo_config_languages_as_syntax_modes() {
        let yaml = status_for_language(Path::new("/repo"), "yaml", false);
        assert_eq!(yaml.language, "yaml");
        assert_eq!(yaml.status, "syntax");
        assert!(yaml.capabilities.contains(&"outline".to_string()));

        let dockerfile = status_for_language(Path::new("/repo"), "dockerfile", false);
        assert_eq!(dockerfile.language, "dockerfile");
        assert_eq!(dockerfile.status, "syntax");
    }

    #[test]
    fn answers_vue_tsserver_bridge_without_hanging() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tsconfig.json"), "{}").unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        let file = src.join("App.vue");
        std::fs::write(&file, "<template />").unwrap();
        let (request_id, command, args) = parse_vue_tsserver_request(
            &json!([[7, "_vue:projectInfo", { "file": file.display().to_string() }]]),
        )
        .unwrap();
        let response = vue_tsserver_response_value(
            request_id,
            vue_tsserver_fallback_result(&command, &args, dir.path()),
        );
        assert_eq!(
            response.get("method").and_then(|v| v.as_str()),
            Some("tsserver/response")
        );
        assert_eq!(response["params"][0][0], json!(7));
        assert_eq!(
            response["params"][0][1]["configFileName"],
            json!(dir.path().join("tsconfig.json").display().to_string())
        );
    }

    #[test]
    fn parses_vue_tsserver_bridge_flat_and_nested_payloads() {
        let nested =
            parse_vue_tsserver_request(&json!([[3, "_vue:quickinfo", { "file": "a.vue" }]]))
                .unwrap();
        assert_eq!(nested.0, json!(3));
        assert_eq!(nested.1, "_vue:quickinfo");
        assert_eq!(nested.2["file"], json!("a.vue"));
        let flat = parse_vue_tsserver_request(&json!([4, "_vue:projectInfo", { "file": "b.vue" }]))
            .unwrap();
        assert_eq!(flat.0, json!(4));
        assert_eq!(flat.1, "_vue:projectInfo");
        assert_eq!(flat.2["file"], json!("b.vue"));
    }

    #[test]
    fn tsserver_end_position_uses_one_based_line_offsets() {
        assert_eq!(tsserver_end_position("abc"), (1, 4));
        assert_eq!(tsserver_end_position("abc\nxy"), (2, 3));
        assert_eq!(tsserver_end_position("abc\n"), (2, 1));
    }
}
