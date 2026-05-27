//! End-to-end MCP integration test.
//!
//! Drives a real subprocess that speaks JSON-RPC over stdio and confirms
//! the manager performs the full initialize → tools/list → tools/call →
//! shutdown lifecycle.
//!
//! The subprocess is a python3 one-liner because:
//!  - python3 is preinstalled on every supported developer OS (macOS,
//!    Ubuntu, Windows 11 ships it via the Microsoft Store; CI runners
//!    always have it).
//!  - Embedding the server inline keeps the test hermetic — no second
//!    crate to maintain, no flakey downloads.
//!
//! When python3 is genuinely absent the test downgrades to a no-op skip
//! with a clearly-printed reason. That keeps Linux distros without
//! python from breaking the build while still surfacing a missing
//! prerequisite to anyone reading the output.

use pointer_lib::services::mcp::{McpConfig, McpManager, ServerConfig, ServerStatus};
use serde_json::json;
use std::collections::HashMap;

/// Find a working python interpreter, or return None if neither python3
/// nor python is on PATH. We test the binary actually runs by asking for
/// its `--version` — distros sometimes ship a `python` symlink that
/// errors when invoked (e.g. Ubuntu deprecation shims).
fn python_path() -> Option<String> {
    for cmd in &["python3", "python"] {
        if std::process::Command::new(cmd)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return Some((*cmd).to_string());
        }
    }
    None
}

/// Minimal MCP server: implements initialize / tools/list / tools/call
/// for a single `echo` tool. The transport is line-delimited JSON.
const MOCK_SERVER: &str = r#"
import sys, json

def write(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def read():
    line = sys.stdin.readline()
    if not line: return None
    return json.loads(line)

def main():
    while True:
        msg = read()
        if msg is None: break
        m = msg.get("method", "")
        if m == "initialize":
            write({
                "jsonrpc": "2.0",
                "id": msg["id"],
                "result": {
                    "protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "mock-echo", "version": "0.0.1"},
                },
            })
        elif m == "tools/list":
            write({
                "jsonrpc": "2.0",
                "id": msg["id"],
                "result": {
                    "tools": [{
                        "name": "echo",
                        "description": "Echo the input back as text",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"text": {"type": "string"}},
                            "required": ["text"],
                        },
                    }],
                },
            })
        elif m == "tools/call":
            args = msg.get("params", {}).get("arguments", {})
            tool = msg.get("params", {}).get("name", "")
            if tool != "echo":
                write({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32602, "message": "unknown tool"}})
                continue
            text = args.get("text", "")
            write({
                "jsonrpc": "2.0",
                "id": msg["id"],
                "result": {"content": [{"type": "text", "text": "echoed: " + text}], "isError": False},
            })
        elif m.startswith("notifications/"):
            # notifications/initialized etc. — no reply required.
            pass
        else:
            mid = msg.get("id")
            if mid is not None:
                write({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown method"}})

main()
"#;

fn echo_server_config(python: &str) -> ServerConfig {
    ServerConfig {
        command: python.to_string(),
        args: vec!["-c".into(), MOCK_SERVER.to_string()],
        env: HashMap::new(),
        cwd: None,
        disabled: false,
    }
}

fn config_with_echo(python: &str) -> McpConfig {
    let mut servers = HashMap::new();
    servers.insert("echo".into(), echo_server_config(python));
    McpConfig { servers }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lifecycle_initialize_list_call_stop() {
    let Some(python) = python_path() else {
        eprintln!("skipping mcp lifecycle test: python3 not available on PATH");
        return;
    };

    let m = McpManager::new();
    m.sync_from_config(&config_with_echo(&python)).await;

    let snap = m.start_server("echo").await.expect("start_server");
    assert_eq!(
        snap.status,
        ServerStatus::Ready,
        "expected ready, got {:?}",
        snap
    );
    assert!(
        snap.server_info.is_some(),
        "initialize must populate server_info"
    );

    let tools = m.list_tools("echo");
    assert_eq!(tools.len(), 1, "expected exactly one tool, got {tools:?}");
    assert_eq!(tools[0].name, "echo");
    assert!(
        tools[0]
            .description
            .as_deref()
            .unwrap_or("")
            .contains("Echo"),
        "description should be propagated"
    );
    assert!(
        tools[0].input_schema.is_some(),
        "input_schema should be populated"
    );

    let result = m
        .call_tool("echo", "echo", json!({"text": "hello"}))
        .await
        .expect("call_tool");
    let text = result
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|p| p.get("text"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    assert_eq!(text, "echoed: hello");

    m.stop_server("echo").await.expect("stop_server");
    // After stop, snapshot should show Stopped.
    let snap_after = m
        .list_servers()
        .into_iter()
        .find(|s| s.name == "echo")
        .expect("echo server should still be in the map");
    assert_eq!(snap_after.status, ServerStatus::Stopped);
    assert_eq!(snap_after.tool_count, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn all_tools_returns_ready_server_tools_only() {
    let Some(python) = python_path() else {
        eprintln!("skipping mcp all_tools test: python3 not available on PATH");
        return;
    };
    let m = McpManager::new();
    m.sync_from_config(&config_with_echo(&python)).await;
    // Pre-start: no tools (server not Ready).
    assert!(m.all_tools().is_empty());
    m.start_server("echo").await.unwrap();
    let tools = m.all_tools();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].0, "echo");
    assert_eq!(tools[0].1.name, "echo");
    m.stop_server("echo").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_tool_surfaces_rpc_error() {
    let Some(python) = python_path() else {
        eprintln!("skipping mcp unknown_tool test: python3 not available on PATH");
        return;
    };
    let m = McpManager::new();
    m.sync_from_config(&config_with_echo(&python)).await;
    m.start_server("echo").await.unwrap();
    let err = m
        .call_tool("echo", "does_not_exist", json!({}))
        .await
        .expect_err("should fail");
    assert!(err.contains("unknown tool"), "got: {err}");
    m.stop_server("echo").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_brings_server_back_to_ready() {
    let Some(python) = python_path() else {
        eprintln!("skipping mcp restart test: python3 not available on PATH");
        return;
    };
    let m = McpManager::new();
    m.sync_from_config(&config_with_echo(&python)).await;
    let snap = m.start_server("echo").await.unwrap();
    assert_eq!(snap.status, ServerStatus::Ready);
    let snap2 = m.restart_server("echo").await.unwrap();
    assert_eq!(snap2.status, ServerStatus::Ready);
    m.stop_server("echo").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_unknown_server_returns_error() {
    let m = McpManager::new();
    let err = m.start_server("does-not-exist").await.unwrap_err();
    assert!(err.contains("not configured"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabled_server_refuses_to_start() {
    let m = McpManager::new();
    let mut cfg = McpConfig::default();
    cfg.servers.insert(
        "x".into(),
        ServerConfig {
            command: "true".into(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            disabled: true,
        },
    );
    m.sync_from_config(&cfg).await;
    let err = m.start_server("x").await.unwrap_err();
    assert!(err.contains("disabled"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nonexistent_command_yields_error_status() {
    let m = McpManager::new();
    let mut cfg = McpConfig::default();
    cfg.servers.insert(
        "ghost".into(),
        ServerConfig {
            command: "this-command-cannot-possibly-exist-xyz123".into(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            disabled: false,
        },
    );
    m.sync_from_config(&cfg).await;
    let res = m.start_server("ghost").await;
    assert!(res.is_err(), "spawning a missing binary should fail");
    let snap = m
        .list_servers()
        .into_iter()
        .find(|s| s.name == "ghost")
        .unwrap();
    assert_eq!(snap.status, ServerStatus::Error);
    assert!(snap.error.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_all_stops_running_servers() {
    let Some(python) = python_path() else {
        eprintln!("skipping mcp shutdown_all test: python3 not available on PATH");
        return;
    };
    let m = McpManager::new();
    m.sync_from_config(&config_with_echo(&python)).await;
    m.start_server("echo").await.unwrap();
    assert!(m
        .list_servers()
        .iter()
        .any(|s| s.status == ServerStatus::Ready));
    m.shutdown_all().await;
    let stopped = m
        .list_servers()
        .iter()
        .all(|s| s.status == ServerStatus::Stopped);
    assert!(stopped, "every server should be stopped after shutdown_all");
}
