//! System & process load snapshots for the in-app monitor.
//!
//! We surface three buckets of processes:
//! - the Pointer app itself (the parent webview + its renderers)
//! - the Ollama daemon (and its model runners), whether we spawned it or not
//! - any other long-running child Pointer manages later (indexer workers, etc.)

use crate::error::AppResult;
use crate::state::AppState;
use parking_lot::Mutex;
use serde::Serialize;
use std::time::Instant;
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
use tauri::State;

static SYS: once_cell::sync::Lazy<Mutex<System>> = once_cell::sync::Lazy::new(|| {
    Mutex::new(System::new_with_specifics(
        RefreshKind::everything()
            .with_memory(sysinfo::MemoryRefreshKind::everything())
            .with_cpu(sysinfo::CpuRefreshKind::everything())
            .with_processes(ProcessRefreshKind::everything()),
    ))
});

static LAST_REFRESH: once_cell::sync::Lazy<Mutex<Option<Instant>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

#[derive(Serialize, Clone)]
pub struct ProcInfo {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub cmd: String,
    /// One of: "pointer" | "ollama" | "ollama_runner" | "renderer" | "other"
    pub kind: String,
    pub cpu_percent: f32,
    pub mem_bytes: u64,
    /// `true` iff this process was spawned by Pointer (we own its lifecycle).
    pub owned_by_pointer: bool,
}

#[derive(Serialize, Clone)]
pub struct SystemSnapshot {
    pub cpu_percent: f32,
    pub cpu_count: u32,
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub uptime_secs: u64,
    pub host_name: Option<String>,
    pub os_name: Option<String>,
    pub processes: Vec<ProcInfo>,
    /// Roll-up of all processes Pointer cares about (own + Ollama + children).
    pub pointer_cpu_percent: f32,
    pub pointer_mem_bytes: u64,
}

#[tauri::command]
pub async fn system_snapshot(state: State<'_, AppState>) -> AppResult<SystemSnapshot> {
    let owned_pid = state.ollama_child.lock().as_ref().map(|c| c.id());
    let self_pid = std::process::id();

    let snap = tokio::task::spawn_blocking(move || take_snapshot(self_pid, owned_pid))
        .await
        .map_err(|e| crate::error::AppError::Msg(format!("snapshot join: {e}")))?;
    Ok(snap)
}

fn take_snapshot(self_pid: u32, owned_ollama_pid: Option<u32>) -> SystemSnapshot {
    let mut sys = SYS.lock();
    // sysinfo CPU% is computed against the prior sample; we keep a singleton
    // refreshed so consecutive snapshots give meaningful numbers. First call
    // tends to read ~0% — the UI polls so it self-corrects.
    sys.refresh_cpu_all();
    sys.refresh_memory();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    *LAST_REFRESH.lock() = Some(Instant::now());

    let cpu_percent = sys.global_cpu_usage();
    let cpu_count = sys.cpus().len() as u32;
    let mem_total = sys.total_memory();
    let mem_used = sys.used_memory();
    let swap_total = sys.total_swap();
    let swap_used = sys.used_swap();
    let uptime_secs = System::uptime();
    let host_name = System::host_name();
    let os_name = System::name();

    let pointer_descendants = collect_descendants(&sys, self_pid);

    let mut out: Vec<ProcInfo> = Vec::new();
    let mut pointer_cpu: f32 = 0.0;
    let mut pointer_mem: u64 = 0;
    let cpu_norm = if cpu_count > 0 { cpu_count as f32 } else { 1.0 };

    for (pid, proc) in sys.processes() {
        let pid_u = pid.as_u32();
        let name = proc.name().to_string_lossy().to_string();
        let cmd_joined = proc
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(" ");
        let parent_pid = proc.parent().map(|p| p.as_u32());

        let lower_name = name.to_lowercase();
        let lower_cmd = cmd_joined.to_lowercase();
        let is_pointer_self = pid_u == self_pid;
        let is_descendant = pointer_descendants.contains(&pid_u);
        let owned_ollama = owned_ollama_pid == Some(pid_u);
        let is_ollama_runner =
            lower_name.contains("ollama") && (lower_cmd.contains("runner") || lower_cmd.contains("llama-server"));
        let is_ollama = lower_name == "ollama" || lower_name.starts_with("ollama");

        let kind = if is_pointer_self {
            "pointer"
        } else if is_descendant && (lower_name.contains("pointer") || is_pointer_renderer(&lower_name, &lower_cmd)) {
            "renderer"
        } else if owned_ollama || is_ollama {
            "ollama"
        } else if is_ollama_runner {
            "ollama_runner"
        } else if is_descendant {
            "other"
        } else {
            continue; // not interesting to the UI
        };

        let cpu = proc.cpu_usage() / cpu_norm;
        let mem = proc.memory();
        let info = ProcInfo {
            pid: pid_u,
            parent_pid,
            name,
            cmd: truncate(&cmd_joined, 200),
            kind: kind.to_string(),
            cpu_percent: cpu,
            mem_bytes: mem,
            owned_by_pointer: owned_ollama || is_descendant || is_pointer_self,
        };
        pointer_cpu += cpu;
        pointer_mem += mem;
        out.push(info);
    }

    out.sort_by(|a, b| {
        // Pointer first, then Ollama, then runners, then everything else;
        // within each bucket sort by CPU desc.
        let order = |k: &str| match k {
            "pointer" => 0,
            "renderer" => 1,
            "ollama" => 2,
            "ollama_runner" => 3,
            _ => 4,
        };
        let oa = order(&a.kind);
        let ob = order(&b.kind);
        oa.cmp(&ob).then_with(|| {
            b.cpu_percent
                .partial_cmp(&a.cpu_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });

    SystemSnapshot {
        cpu_percent,
        cpu_count,
        mem_total,
        mem_used,
        swap_total,
        swap_used,
        uptime_secs,
        host_name,
        os_name,
        processes: out,
        pointer_cpu_percent: pointer_cpu,
        pointer_mem_bytes: pointer_mem,
    }
}

fn is_pointer_renderer(name: &str, cmd: &str) -> bool {
    name.contains("webview")
        || name.contains("webkit")
        || cmd.contains("WebKit")
        || cmd.contains("webview")
}

fn collect_descendants(sys: &System, root: u32) -> std::collections::HashSet<u32> {
    let mut by_parent: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for (pid, proc) in sys.processes() {
        if let Some(parent) = proc.parent() {
            by_parent.entry(parent.as_u32()).or_default().push(pid.as_u32());
        }
    }
    let mut out = std::collections::HashSet::new();
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if !out.insert(p) {
            continue;
        }
        if let Some(children) = by_parent.get(&p) {
            for c in children {
                stack.push(*c);
            }
        }
    }
    out
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

/// One-shot hardware summary used by the AI panel to colour-code model
/// recommendations against what the machine can actually run, and by the
/// System Monitor to show a header. We're deliberately conservative — we
/// only report what we can detect with pure-Rust crates and the host OS.
#[derive(Serialize, Clone)]
pub struct HardwareProfile {
    pub cpu_count: u32,
    pub cpu_name: Option<String>,
    pub cpu_brand: Option<String>,
    pub total_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub swap_total: u64,
    /// Best-effort GPU label. Empty string when we can't detect one — the UI
    /// uses that to render "CPU-only" rather than guess.
    pub gpu_label: Option<String>,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub host_name: Option<String>,
    pub arch: String,
}

#[tauri::command]
pub async fn hardware_profile() -> AppResult<HardwareProfile> {
    let snap = tokio::task::spawn_blocking(detect_hardware)
        .await
        .map_err(|e| crate::error::AppError::Msg(format!("hardware join: {e}")))?;
    Ok(snap)
}

fn detect_hardware() -> HardwareProfile {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();
    let cpus = sys.cpus();
    let cpu_count = cpus.len() as u32;
    let cpu_name = cpus.first().map(|c| c.name().to_string());
    let cpu_brand = cpus.first().map(|c| c.brand().to_string());
    let total_ram_bytes = sys.total_memory();
    let available_ram_bytes = sys.available_memory();
    let swap_total = sys.total_swap();
    let host_name = System::host_name();
    let os_name = System::name();
    let os_version = System::os_version();
    let arch = std::env::consts::ARCH.to_string();
    let gpu_label = detect_gpu();

    HardwareProfile {
        cpu_count,
        cpu_name,
        cpu_brand,
        total_ram_bytes,
        available_ram_bytes,
        swap_total,
        gpu_label,
        os_name,
        os_version,
        host_name,
        arch,
    }
}

/// Best-effort GPU detection. We don't depend on platform-specific GPU
/// crates because they're heavy and brittle — instead we shell out to the
/// OS's own tools when available. The result is purely informational.
fn detect_gpu() -> Option<String> {
    #[cfg(target_os = "macos")]
    return detect_gpu_macos();
    #[cfg(target_os = "linux")]
    return detect_gpu_linux();
    #[cfg(target_os = "windows")]
    return detect_gpu_windows();
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    None
}

#[cfg(target_os = "macos")]
fn detect_gpu_macos() -> Option<String> {
    use std::process::Command;
    // `system_profiler SPDisplaysDataType` is the canonical macOS source for
    // GPU identity. Slow on first call; we accept that — the AI panel only
    // runs it once at mount.
    let out = Command::new("/usr/sbin/system_profiler")
        .args(["-detailLevel", "mini", "SPDisplaysDataType"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        if let Some(rest) = line.trim().strip_prefix("Chipset Model:") {
            let label = rest.trim().to_string();
            if !label.is_empty() {
                return Some(label);
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn detect_gpu_linux() -> Option<String> {
    use std::process::Command;
    let out = Command::new("/usr/bin/lspci").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        if line.contains("VGA compatible controller")
            || line.contains("3D controller")
            || line.contains("Display controller")
        {
            if let Some((_, rest)) = line.split_once(':') {
                return Some(rest.trim().to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn detect_gpu_windows() -> Option<String> {
    use std::process::Command;
    let out = Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "Name"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines().skip(1) {
        let t = line.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

/// Best-effort kill: only works for processes Pointer started (the Ollama child
/// or its descendants). We refuse to nuke arbitrary PIDs.
#[tauri::command]
pub async fn kill_owned_process(
    state: State<'_, AppState>,
    pid: u32,
) -> AppResult<bool> {
    let owned_pid = state.ollama_child.lock().as_ref().map(|c| c.id());
    if owned_pid == Some(pid) {
        state.shutdown_ollama();
        return Ok(true);
    }
    // For descendants of Pointer, SIGTERM directly.
    let self_pid = std::process::id();
    let sys = SYS.lock();
    let descendants = collect_descendants(&sys, self_pid);
    drop(sys);
    if descendants.contains(&pid) {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        return Ok(true);
    }
    Ok(false)
}

#[allow(dead_code)]
pub fn _unused() {}
