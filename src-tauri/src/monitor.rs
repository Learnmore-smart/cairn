use serde::Serialize;
use std::collections::HashMap;
use sysinfo::{Disks, Pid, ProcessesToUpdate, System};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub name: String,
    pub mount: String,
    pub fs: String,
    pub total_bytes: u64,
    pub avail_bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcGroup {
    pub name: String,
    pub count: u32,
    pub memory_bytes: u64,
    /// CPU% normalized to 0–100 across all logical cores (delta between polls).
    pub cpu_pct: f32,
    pub pids: Vec<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub total_memory: u64,
    pub used_memory: u64,
    pub avail_memory: u64,
    pub total_swap: u64,
    pub used_swap: u64,
    pub uptime_secs: u64,
    pub disks: Vec<DiskInfo>,
    pub processes: Vec<ProcGroup>,
}

const MAX_PROC_GROUPS: usize = 200;

pub fn snapshot(sys: &mut System) -> SystemSnapshot {
    sys.refresh_memory();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let disks = Disks::new_with_refreshed_list();
    let disk_info = disks
        .iter()
        .map(|d| DiskInfo {
            name: d.name().to_string_lossy().into_owned(),
            mount: d.mount_point().to_string_lossy().into_owned(),
            fs: d.file_system().to_string_lossy().into_owned(),
            total_bytes: d.total_space(),
            avail_bytes: d.available_space(),
        })
        .collect();

    let cpus = sys.cpus().len().max(1) as f32;
    let mut groups: HashMap<String, ProcGroup> = HashMap::new();
    for (pid, proc_) in sys.processes() {
        let name = proc_.name().to_string_lossy().to_lowercase();
        let g = groups.entry(name.clone()).or_insert(ProcGroup {
            name,
            count: 0,
            memory_bytes: 0,
            cpu_pct: 0.0,
            pids: Vec::new(),
        });
        g.count += 1;
        g.memory_bytes += proc_.memory();
        g.cpu_pct += proc_.cpu_usage();
        g.pids.push(pid.as_u32());
    }
    for g in groups.values_mut() {
        g.cpu_pct = (g.cpu_pct / cpus).clamp(0.0, 100.0);
    }
    let mut processes: Vec<ProcGroup> = groups.into_values().collect();
    processes.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));
    processes.truncate(MAX_PROC_GROUPS);

    SystemSnapshot {
        total_memory: sys.total_memory(),
        used_memory: sys.used_memory(),
        avail_memory: sys.available_memory(),
        total_swap: sys.total_swap(),
        used_swap: sys.used_swap(),
        uptime_secs: System::uptime(),
        disks: disk_info,
        processes,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillOutcome {
    pub killed: u32,
    /// Skipped because the process is on the system-critical denylist (or us).
    pub refused: u32,
}

/// Processes whose death bluescreens or destabilizes Windows — never offered
/// to the kill path, no matter what the UI sends.
const CRITICAL: &[&str] = &[
    "system",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "lsass.exe",
    "lsm.exe",
    "services.exe",
    "svchost.exe",
    "secure system",
    "memory compression",
    "system idle process",
    "dwm.exe",
    "sihost.exe",
    "msmpeng.exe",
    "nissrv.exe",
    "spoolsv.exe",
    "logonui.exe",
    "fontdrvhost.exe",
    "wlms.exe",
    "audiodg.exe",
];

/// Kills every pid given, except our own process and anything on the
/// system-critical denylist. Returns what happened to each batch.
pub fn kill_pids(sys: &mut System, pids: &[u32]) -> KillOutcome {
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let self_pid = std::process::id();
    let mut out = KillOutcome {
        killed: 0,
        refused: 0,
    };
    for &pid in pids {
        if pid == self_pid || pid == 0 {
            out.refused += 1;
            continue;
        }
        match sys.process(Pid::from_u32(pid)) {
            Some(proc_) => {
                let name = proc_.name().to_string_lossy().to_lowercase();
                if CRITICAL.iter().any(|c| *c == name) {
                    out.refused += 1;
                } else if proc_.kill() {
                    out.killed += 1;
                }
            }
            None => {}
        }
    }
    out
}
