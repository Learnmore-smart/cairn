use serde::Serialize;
use std::{collections::HashMap, ffi::OsString, net::IpAddr, path::Path, process::Command};
use sysinfo::System;

const MAX_ROWS: usize = 100;
const MAX_COMMAND_CHARS: usize = 240;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalhostProcess {
    pub pid: u32,
    pub name: String,
    pub memory_bytes: u64,
    pub cpu_pct: f32,
    pub ports: Vec<u16>,
    pub summary: String,
    pub cwd: Option<String>,
    pub is_node: bool,
    pub critical: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TcpListener {
    pid: u32,
    host: String,
    port: u16,
}

/// Socket-table collection is independent of the sysinfo lock; callers gather
/// this first so the short process-metadata lock never spans two netstat runs.
pub(crate) fn listener_ports() -> HashMap<u32, Vec<u16>> {
    ports_by_pid(socket_listeners())
}

/// Individual localhost/Node process rows. This intentionally does not
/// refresh `sys`: the main snapshot poll owns refresh cadence, and an extra
/// refresh here would reset sysinfo's CPU deltas.
pub(crate) fn processes(sys: &System, listeners: &HashMap<u32, Vec<u16>>) -> Vec<LocalhostProcess> {
    let cpus = sys.cpus().len().max(1) as f32;
    let self_pid = std::process::id();
    let mut rows = Vec::new();
    for (pid, proc_) in sys.processes() {
        let pid = pid.as_u32();
        let name = proc_.name().to_string_lossy().into_owned();
        let lower_name = name.to_lowercase();
        let is_node = is_node_process(&lower_name, proc_.exe());
        let ports = listeners.get(&pid).cloned().unwrap_or_default();
        if ports.is_empty() && !is_node {
            continue;
        }
        rows.push(LocalhostProcess {
            pid,
            name,
            memory_bytes: proc_.memory(),
            cpu_pct: (proc_.cpu_usage() / cpus).clamp(0.0, 100.0),
            ports,
            summary: command_summary(proc_.cmd(), &lower_name),
            cwd: proc_.cwd().map(|p| p.to_string_lossy().into_owned()),
            is_node,
            critical: pid == self_pid || crate::monitor::is_critical_name(&lower_name),
        });
    }
    rows.sort_by(|a, b| {
        a.critical
            .cmp(&b.critical)
            .then(a.ports.is_empty().cmp(&b.ports.is_empty()))
            .then(
                a.ports
                    .first()
                    .unwrap_or(&u16::MAX)
                    .cmp(b.ports.first().unwrap_or(&u16::MAX)),
            )
            .then(b.memory_bytes.cmp(&a.memory_bytes))
            .then(a.pid.cmp(&b.pid))
    });
    rows.truncate(MAX_ROWS);
    rows
}

fn is_node_process(lower_name: &str, exe: Option<&Path>) -> bool {
    fn node_name(name: &str) -> bool {
        matches!(name, "node" | "node.exe" | "nodejs" | "nodejs.exe")
    }
    if node_name(lower_name) {
        return true;
    }
    exe.and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_lowercase())
        .is_some_and(|n| node_name(&n))
}

fn command_summary(cmd: &[OsString], fallback: &str) -> String {
    let mut text = cmd
        .iter()
        .skip(1)
        .filter_map(|arg| script_file_name(&arg.to_string_lossy()))
        .next()
        .unwrap_or_else(|| fallback.to_string());
    if text.chars().count() > MAX_COMMAND_CHARS {
        text = text.chars().take(MAX_COMMAND_CHARS - 1).collect();
        text.push('…');
    }
    text
}

/// A display-safe hint about what a process is running. Only path/script
/// basenames are eligible: flags, URLs, positional payloads and anything
/// credential-shaped never cross into the UI.
fn script_file_name(arg: &str) -> Option<String> {
    let arg = arg.trim().trim_matches('"');
    if arg.is_empty() || arg.starts_with('-') || arg.contains("://") {
        return None;
    }
    let lower = arg.to_lowercase();
    if [
        "authorization",
        "bearer",
        "token",
        "secret",
        "password",
        "apikey",
        "api_key",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return None;
    }
    let path_like = arg.contains('/') || arg.contains('\\');
    let script_like = [".js", ".mjs", ".cjs", ".ts", ".exe", ".cmd", ".ps1"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    if !path_like && !script_like {
        return None;
    }
    let file = arg
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or_default()
        .trim();
    if file.is_empty() || file == "." || file == ".." {
        None
    } else {
        Some(file.to_string())
    }
}

fn ports_by_pid(listeners: Vec<TcpListener>) -> HashMap<u32, Vec<u16>> {
    let mut map: HashMap<u32, Vec<u16>> = HashMap::new();
    for listener in listeners {
        if localhost_reachable(&listener.host) {
            map.entry(listener.pid).or_default().push(listener.port);
        }
    }
    for ports in map.values_mut() {
        ports.sort_unstable();
        ports.dedup();
    }
    map
}

fn socket_listeners() -> Vec<TcpListener> {
    platform_socket_listeners()
}

#[cfg(windows)]
fn platform_socket_listeners() -> Vec<TcpListener> {
    let mut listeners = Vec::new();
    // Windows treats IPv4 and IPv6 TCP as separate protocol tables.
    for protocol in ["tcp", "tcpv6"] {
        let output = crate::util::hidden(&mut Command::new("netstat"))
            .args(["-ano", "-p", protocol])
            .output();
        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            listeners.extend(parse_windows_netstat_listeners(&stdout));
        }
    }
    listeners
}

#[cfg(not(windows))]
fn platform_socket_listeners() -> Vec<TcpListener> {
    if let Ok(output) = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let listeners = parse_lsof_listeners(&stdout);
        if !listeners.is_empty() {
            return listeners;
        }
    }
    if let Ok(output) = Command::new("ss").args(["-ltnp"]).output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        return parse_ss_listeners(&stdout);
    }
    Vec::new()
}

fn split_host_port(addr: &str) -> Option<(String, u16)> {
    let addr = addr.trim();
    if addr.is_empty() {
        return None;
    }
    if let Some(rest) = addr.strip_prefix('[') {
        let end = rest.find(']')?;
        let host = &rest[..end];
        let port = rest.get(end + 1..)?.strip_prefix(':')?.parse().ok()?;
        return Some((host.to_string(), port));
    }
    let (host, port) = addr.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    port.parse().ok().map(|port| (host.to_string(), port))
}

fn localhost_reachable(host: &str) -> bool {
    let host = host
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .split('%')
        .next()
        .unwrap_or_default();
    if host.eq_ignore_ascii_case("localhost") || host == "*" {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|ip| ip.is_loopback() || ip.is_unspecified())
        .unwrap_or(false)
}

fn parse_windows_netstat_listeners(output: &str) -> Vec<TcpListener> {
    output
        .lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 5
                || !cols[0].eq_ignore_ascii_case("tcp")
                || !cols[3].eq_ignore_ascii_case("listening")
            {
                return None;
            }
            let (host, port) = split_host_port(cols[1])?;
            let pid = cols[4].parse().ok()?;
            Some(TcpListener { pid, host, port })
        })
        .collect()
}

#[cfg(any(not(windows), test))]
fn parse_lsof_listeners(output: &str) -> Vec<TcpListener> {
    output
        .lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 3 || cols.last() != Some(&"(LISTEN)") {
                return None;
            }
            let pid = cols[1].parse().ok()?;
            let (host, port) = split_host_port(cols[cols.len() - 2])?;
            Some(TcpListener { pid, host, port })
        })
        .collect()
}

#[cfg(not(windows))]
fn parse_ss_listeners(output: &str) -> Vec<TcpListener> {
    output
        .lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 4 || !cols[0].eq_ignore_ascii_case("listen") {
                return None;
            }
            let (host, port) = split_host_port(cols[3])?;
            let pid_start = line.find("pid=")? + 4;
            let pid: u32 = line[pid_start..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .ok()?;
            Some(TcpListener { pid, host, port })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn parses_windows_ipv4_listener() {
        let out = "\
  TCP    127.0.0.1:3000       0.0.0.0:0              LISTENING       12345\n";
        assert_eq!(
            parse_windows_netstat_listeners(out),
            vec![TcpListener {
                pid: 12345,
                host: "127.0.0.1".into(),
                port: 3000,
            }]
        );
    }

    #[test]
    fn parses_windows_ipv6_listener() {
        let out = "  TCP    [::1]:5173          [::]:0                 LISTENING       987\n";
        assert_eq!(
            parse_windows_netstat_listeners(out),
            vec![TcpListener {
                pid: 987,
                host: "::1".into(),
                port: 5173,
            }]
        );
    }

    #[test]
    fn ignores_non_listeners_and_malformed_rows() {
        let out = "\
  TCP    127.0.0.1:3000       127.0.0.1:55555        ESTABLISHED     12345\n\
  not a socket row\n";
        assert_eq!(parse_windows_netstat_listeners(out), Vec::new());
    }

    #[test]
    fn parses_lsof_listener_rows() {
        let out = "\
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n\
node    12345 noah   20u  IPv4  12345      0t0  TCP 127.0.0.1:3000 (LISTEN)\n\
node    12345 noah   21u  IPv6  12346      0t0  TCP [::1]:3000 (LISTEN)\n";
        assert_eq!(
            parse_lsof_listeners(out),
            vec![
                TcpListener {
                    pid: 12345,
                    host: "127.0.0.1".into(),
                    port: 3000,
                },
                TcpListener {
                    pid: 12345,
                    host: "::1".into(),
                    port: 3000,
                },
            ]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn parses_ss_listener_rows() {
        let out = "\
State      Recv-Q     Send-Q         Local Address:Port          Peer Address:Port     Process\n\
LISTEN     0          511            127.0.0.1:3000              0.0.0.0:*            users:((\"node\",pid=12345,fd=20))\n";
        assert_eq!(
            parse_ss_listeners(out),
            vec![TcpListener {
                pid: 12345,
                host: "127.0.0.1".into(),
                port: 3000,
            }]
        );
    }

    #[test]
    fn classifies_loopback_and_wildcard_hosts_as_localhost_reachable() {
        for host in [
            "127.0.0.1",
            "127.20.1.4",
            "::1",
            "0.0.0.0",
            "::",
            "*",
            "localhost",
        ] {
            assert!(localhost_reachable(host), "{host} should count");
        }
        for host in ["10.0.0.4", "192.168.1.20", "2001:4860:4860::8888"] {
            assert!(!localhost_reachable(host), "{host} should not count");
        }
    }

    #[test]
    fn splits_bracketed_and_plain_host_port_pairs() {
        assert_eq!(
            split_host_port("127.0.0.1:3000"),
            Some(("127.0.0.1".into(), 3000))
        );
        assert_eq!(split_host_port("[::1]:5173"), Some(("::1".into(), 5173)));
        assert_eq!(split_host_port("*:8080"), Some(("*".into(), 8080)));
        assert_eq!(split_host_port("missing-port"), None);
    }

    #[test]
    fn groups_only_localhost_reachable_ports_by_pid() {
        let grouped = ports_by_pid(vec![
            TcpListener {
                pid: 10,
                host: "127.0.0.1".into(),
                port: 3000,
            },
            TcpListener {
                pid: 10,
                host: "::1".into(),
                port: 3000,
            },
            TcpListener {
                pid: 10,
                host: "0.0.0.0".into(),
                port: 5173,
            },
            TcpListener {
                pid: 10,
                host: "192.168.1.5".into(),
                port: 9999,
            },
        ]);
        assert_eq!(
            grouped,
            HashMap::from([(10, vec![3000, 5173])]),
            "loopback aliases dedupe and LAN-only binds are excluded"
        );
    }

    #[test]
    fn detects_node_names_from_process_or_executable() {
        assert!(is_node_process("node.exe", None));
        assert!(is_node_process("nodejs", None));
        assert!(is_node_process(
            "wrapper",
            Some(Path::new("C:\\Program Files\\nodejs\\node.exe"))
        ));
        assert!(!is_node_process("code.exe", None));
    }

    #[test]
    fn command_summary_keeps_only_the_script_name() {
        let cmd = vec![
            OsString::from("C:\\Program Files\\nodejs\\node.exe"),
            OsString::from("C:\\Users\\me\\tool\\dist\\proxy.js"),
            OsString::from("https://example.test/mcp"),
            OsString::from("--header"),
            OsString::from("Authorization:Bearer secret-value"),
        ];
        assert_eq!(command_summary(&cmd, "node.exe"), "proxy.js");
    }

    #[test]
    fn command_summary_never_echoes_secret_or_flag_payloads() {
        let cmd = vec![
            OsString::from("node"),
            OsString::from("--secret"),
            OsString::from("top-secret"),
        ];
        assert_eq!(command_summary(&cmd, "node.exe"), "node.exe");

        let cmd = vec![
            OsString::from("node"),
            OsString::from("https://example.test/callback?token=top-secret"),
        ];
        assert_eq!(command_summary(&cmd, "node.exe"), "node.exe");
    }
}
