mod disk_scan;
mod localhost;
mod monitor;
#[cfg(feature = "pro")]
mod pro;
mod util;
mod vault;

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Disks, System};
use tauri::{
    async_runtime::JoinHandle,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

const MAIN_WINDOW: &str = "main";
const MAIN_TRAY: &str = "main";
/// Launch arg the autostart Run entry carries — boots to the tray without
/// popping the window.
const AUTOSTART_ARG: &str = "--minimized";
const VAULT_FILE: &str = "cairn-vault.json";
const SCAN_FILE: &str = "cairn-last-scan.json";
/// Open-core split — compile-time edition flag (`--features pro`).
const PRO: bool = cfg!(feature = "pro");
const FREE_VAULT_LIMIT: usize = 2;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppCaps {
    pro: bool,
    vault_limit: Option<usize>,
    /// `std::env::consts::OS` — the UI hides Windows-only surfaces (NTFS
    /// ACL vault) on other platforms instead of letting them fail.
    platform: &'static str,
}

#[tauri::command]
fn app_caps(state: State<AppState>) -> AppCaps {
    AppCaps {
        pro: PRO,
        vault_limit: if licensed(&state) {
            None
        } else {
            Some(FREE_VAULT_LIMIT)
        },
        platform: std::env::consts::OS,
    }
}

/// True when the process was launched by the login autostart entry —
/// the window stays hidden and Cairn lives in the tray until summoned.
fn launched_hidden(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|a| a == AUTOSTART_ARG)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Windows path comparison — case-insensitive, slash-agnostic.
fn norm(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn human_gb(bytes: u64) -> String {
    let gb = bytes as f64 / 1_073_741_824.0;
    if gb >= 100.0 {
        format!("{gb:.0}GB")
    } else {
        format!("{gb:.1}GB")
    }
}

struct VaultShared {
    entries: Vec<vault::VaultEntry>,
    persist: Option<PathBuf>,
    /// Pending auto-relock tasks, keyed by normalized path.
    relock: HashMap<String, JoinHandle<()>>,
    user: String,
}

struct RunningScan {
    /// `norm()` key of the root being walked.
    key: String,
    /// Display path — echoed in events so the UI can filter by view.
    root: String,
    /// A newer scan flips this; the walk bails early instead of finishing stale.
    cancel: Arc<AtomicBool>,
    /// Latest progress tick the UI can re-attach to.
    progress: Option<ScanProgress>,
}

/// Session scans kept so a remounted tab paints instantly — bounded to the
/// same ballpark as the persisted store.
const MAX_SESSION_SCANS: usize = 48;

#[derive(Default)]
struct ScanShared {
    /// At most one walk runs at a time; a new root supersedes it.
    running: Option<RunningScan>,
    /// Finished scans by normalized root — survives tab switches without
    /// re-walking or touching the disk.
    results: HashMap<String, disk_scan::ScanResult>,
    /// Insertion order for the bounded `results` map.
    order: VecDeque<String>,
}

impl ScanShared {
    fn remember(&mut self, key: String, res: disk_scan::ScanResult) {
        if !self.results.contains_key(&key) {
            self.order.push_back(key.clone());
        }
        self.results.insert(key, res);
        while self.order.len() > MAX_SESSION_SCANS {
            if let Some(old) = self.order.pop_front() {
                self.results.remove(&old);
            }
        }
    }
}

pub struct AppState {
    sys: Mutex<System>,
    vault: Mutex<VaultShared>,
    scan: Mutex<ScanShared>,
    /// App data dir — home of vault/scan-history JSON files.
    data_dir: Mutex<Option<PathBuf>>,
    /// Flipped by `license_activate` — Pro builds gate paid features on it.
    #[cfg(feature = "pro")]
    pub pro_active: std::sync::atomic::AtomicBool,
}

/// True when paid features are usable: free builds never, Pro builds only
/// after a verified license key has been activated.
fn licensed(state: &AppState) -> bool {
    #[cfg(feature = "pro")]
    return state.pro_active.load(std::sync::atomic::Ordering::SeqCst);
    #[cfg(not(feature = "pro"))]
    {
        let _ = state;
        return false;
    }
}

#[derive(Serialize, Deserialize)]
struct VaultFileEntry {
    path: String,
}

fn save_vault(shared: &VaultShared) {
    let Some(file) = &shared.persist else { return };
    let entries: Vec<VaultFileEntry> = shared
        .entries
        .iter()
        .map(|e| VaultFileEntry {
            path: e.path.clone(),
        })
        .collect();
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&entries) {
        let _ = std::fs::write(file, json);
    }
}

fn find_entry<'a>(
    shared: &'a mut VaultShared,
    key: &str,
) -> Result<&'a mut vault::VaultEntry, String> {
    shared
        .entries
        .iter_mut()
        .find(|e| norm(Path::new(&e.path)) == key)
        .ok_or_else(|| "folder is not in the vault".to_string())
}

// ---------- commands ----------

#[tauri::command]
fn system_snapshot(state: State<AppState>) -> monitor::SystemSnapshot {
    monitor::snapshot(&mut state.sys.lock().unwrap())
}

#[tauri::command]
fn kill_processes(state: State<AppState>, pids: Vec<u32>) -> monitor::KillOutcome {
    monitor::kill_pids(&mut state.sys.lock().unwrap(), &pids)
}

#[tauri::command]
fn localhost_processes(state: State<AppState>) -> Vec<localhost::LocalhostProcess> {
    let listeners = localhost::listener_ports();
    localhost::processes(&state.sys.lock().unwrap(), &listeners)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    root: String,
    entries: u64,
    bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanDone {
    root: String,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    result: Option<disk_scan::ScanResult>,
}

/// What the Disk tab needs to paint for one root — phase plus the live
/// running root so a background scan stays visible from any view.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanStatusView {
    phase: &'static str,
    progress: Option<ScanProgress>,
    result: Option<disk_scan::ScanResult>,
    saved_at: Option<u64>,
    running_root: Option<String>,
}

/// Launch (or replace) the single background walk. Scans live in the
/// backend — a hidden window or an unmounted tab can never lose them;
/// the UI re-attaches through `scan_status` and the `cairn://` events.
fn spawn_scan(app: &AppHandle, root: PathBuf) {
    let key = norm(&root);
    let root_str = root.to_string_lossy().into_owned();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let st = app.state::<AppState>();
        let mut s = st.scan.lock().unwrap();
        if let Some(r) = &s.running {
            r.cancel.store(true, Ordering::SeqCst);
        }
        s.running = Some(RunningScan {
            key: key.clone(),
            root: root_str.clone(),
            cancel: cancel.clone(),
            progress: None,
        });
    }

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let app3 = app2.clone();
        let root_ev = root_str.clone();
        let key_ev = key.clone();
        // Time-throttled emit — the walk ticks per-2048 files, the UI
        // hears at most ~8 fps of updates either way.
        let last = Mutex::new(Instant::now());
        let emit = move |entries: u64, bytes: u64| {
            let mut g = last.lock().unwrap();
            if g.elapsed().as_millis() < 120 {
                return;
            }
            *g = Instant::now();
            let payload = ScanProgress {
                root: root_ev.clone(),
                entries,
                bytes,
            };
            if let Some(r) = app3
                .state::<AppState>()
                .scan
                .lock()
                .unwrap()
                .running
                .as_mut()
            {
                if r.key == key_ev {
                    r.progress = Some(payload.clone());
                }
            }
            let _ = app3.emit("cairn://scan-progress", payload);
        };
        let walked = tauri::async_runtime::spawn_blocking(move || {
            disk_scan::scan(&root, Some(&emit), Some(cancel.as_ref()))
        })
        .await;

        let st = app2.state::<AppState>();
        let done = match walked {
            Ok(Ok(res)) => {
                {
                    let mut s = st.scan.lock().unwrap();
                    s.remember(norm(Path::new(&res.root)), res.clone());
                    if s.running.as_ref().is_some_and(|r| r.key == key) {
                        s.running = None;
                    }
                }
                if let Some(dir) = st.data_dir.lock().unwrap().clone() {
                    disk_scan::save_saved_scan(
                        &dir.join(SCAN_FILE),
                        &norm(Path::new(&res.root)),
                        disk_scan::SavedScan {
                            saved_at: now_secs(),
                            result: res.clone(),
                        },
                    );
                }
                ScanDone {
                    root: res.root.clone(),
                    ok: true,
                    cancelled: false,
                    error: None,
                    result: Some(res),
                }
            }
            Ok(Err(e)) => {
                let cancelled = e == disk_scan::CANCELLED;
                {
                    let mut s = st.scan.lock().unwrap();
                    if s.running.as_ref().is_some_and(|r| r.key == key) {
                        s.running = None;
                    }
                }
                ScanDone {
                    root: root_str.clone(),
                    ok: false,
                    cancelled,
                    error: if cancelled { None } else { Some(e) },
                    result: None,
                }
            }
            Err(e) => {
                {
                    let mut s = st.scan.lock().unwrap();
                    if s.running.as_ref().is_some_and(|r| r.key == key) {
                        s.running = None;
                    }
                }
                ScanDone {
                    root: root_str.clone(),
                    ok: false,
                    cancelled: false,
                    error: Some(e.to_string()),
                    result: None,
                }
            }
        };
        let _ = app2.emit("cairn://scan-done", done);
    });
}

fn scan_status_for(state: &AppState, key: &str) -> ScanStatusView {
    let (running_root, scanning, progress, session) = {
        let s = state.scan.lock().unwrap();
        (
            s.running.as_ref().map(|r| r.root.clone()),
            s.running.as_ref().is_some_and(|r| r.key == key),
            s.running
                .as_ref()
                .filter(|r| r.key == key)
                .and_then(|r| r.progress.clone()),
            s.results.get(key).cloned(),
        )
    };
    if scanning {
        return ScanStatusView {
            phase: "scanning",
            progress,
            result: None,
            saved_at: None,
            running_root,
        };
    }
    if let Some(result) = session {
        return ScanStatusView {
            phase: "done",
            progress: None,
            result: Some(result),
            saved_at: None,
            running_root,
        };
    }
    if let Some(dir) = state.data_dir.lock().unwrap().clone() {
        if let Some(saved) = disk_scan::load_saved_scans(&dir.join(SCAN_FILE)).get(key) {
            return ScanStatusView {
                phase: "done",
                progress: None,
                result: Some(saved.result.clone()),
                saved_at: Some(saved.saved_at),
                running_root,
            };
        }
    }
    ScanStatusView {
        phase: "idle",
        progress: None,
        result: None,
        saved_at: None,
        running_root,
    }
}

/// The root the background auto-scan walks at launch: the drive the user
/// scanned most recently, else D:\, else the biggest fixed disk. Manual
/// picks always supersede it.
fn pick_default_scan_root(state: &AppState) -> Option<PathBuf> {
    if let Some(dir) = state.data_dir.lock().unwrap().clone() {
        let best = disk_scan::load_saved_scans(&dir.join(SCAN_FILE))
            .into_values()
            .filter_map(|s| {
                let p = PathBuf::from(&s.result.root);
                p.is_dir().then_some((s.saved_at, p))
            })
            .max_by_key(|(t, _)| *t);
        if let Some((_, p)) = best {
            return Some(p);
        }
    }
    let disks = Disks::new_with_refreshed_list();
    disks
        .iter()
        .find(|d| norm(d.mount_point()) == "d:")
        .or_else(|| {
            // Biggest fixed disk wins; mount-path length breaks ties so
            // macOS prefers the data volume over the read-only system one.
            disks
                .iter()
                .filter(|d| !d.is_removable())
                .max_by_key(|d| (d.total_space(), d.mount_point().to_string_lossy().len()))
        })
        .or_else(|| disks.iter().next())
        .map(|d| d.mount_point().to_path_buf())
}

#[tauri::command]
fn scan_home(state: State<AppState>) -> Option<String> {
    pick_default_scan_root(&state).map(|p| p.to_string_lossy().into_owned())
}

/// Start (or attach to) the background walk for `path`. A different root
/// already running is superseded — the latest view always wins.
#[tauri::command]
fn scan_start(app: AppHandle, state: State<AppState>, path: String) -> ScanStatusView {
    let root = PathBuf::from(&path);
    let key = norm(&root);
    let already = state
        .scan
        .lock()
        .unwrap()
        .running
        .as_ref()
        .is_some_and(|r| r.key == key);
    if !already && root.is_dir() {
        spawn_scan(&app, root);
    }
    scan_status_for(&state, &key)
}

#[tauri::command]
fn scan_status(state: State<AppState>, root: String) -> ScanStatusView {
    scan_status_for(&state, &norm(Path::new(&root)))
}

#[tauri::command]
fn vault_list(state: State<AppState>) -> Vec<vault::VaultEntry> {
    let mut s = state.vault.lock().unwrap();
    let user = s.user.clone();
    for e in &mut s.entries {
        if e.unlock_at.is_none() {
            e.locked = vault::is_locked(Path::new(&e.path), &user);
        }
    }
    s.entries.clone()
}

#[tauri::command]
fn vault_add(state: State<AppState>, path: String) -> Result<Vec<vault::VaultEntry>, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("{path} is not a directory"));
    }
    let mut s = state.vault.lock().unwrap();
    let key = norm(&p);
    if !s.entries.iter().any(|e| norm(Path::new(&e.path)) == key) {
        if !licensed(&state) && s.entries.len() >= FREE_VAULT_LIMIT {
            return Err(format!(
                "Free Cairn protects up to {FREE_VAULT_LIMIT} folders — Cairn Pro removes the limit"
            ));
        }
        let locked = vault::is_locked(&p, &s.user);
        s.entries.push(vault::VaultEntry {
            path: p.to_string_lossy().into_owned(),
            locked,
            unlock_at: None,
        });
        save_vault(&s);
    }
    Ok(s.entries.clone())
}

#[tauri::command]
fn vault_remove(state: State<AppState>, path: String) -> Vec<vault::VaultEntry> {
    let mut s = state.vault.lock().unwrap();
    let key = norm(Path::new(&path));
    s.entries.retain(|e| norm(Path::new(&e.path)) != key);
    if let Some(h) = s.relock.remove(&key) {
        h.abort();
    }
    save_vault(&s);
    s.entries.clone()
}

#[tauri::command]
fn vault_lock(state: State<AppState>, path: String) -> Result<vault::VaultEntry, String> {
    let p = PathBuf::from(&path);
    let mut s = state.vault.lock().unwrap();
    vault::lock(&p, &s.user)?;
    let key = norm(&p);
    if let Some(h) = s.relock.remove(&key) {
        h.abort();
    }
    let e = find_entry(&mut s, &key)?;
    e.locked = true;
    e.unlock_at = None;
    Ok(e.clone())
}

/// Slam every vault folder shut — the panic button.
#[tauri::command]
fn vault_lock_all(state: State<AppState>) -> Vec<vault::VaultEntry> {
    let mut s = state.vault.lock().unwrap();
    for h in s.relock.drain().map(|(_, h)| h) {
        h.abort();
    }
    let user = s.user.clone();
    for e in s.entries.iter_mut() {
        if vault::lock(Path::new(&e.path), &user).is_ok() {
            e.locked = true;
            e.unlock_at = None;
        }
    }
    s.entries.clone()
}

#[tauri::command]
fn vault_open(path: String) -> Result<(), String> {
    vault::open_in_explorer(&PathBuf::from(&path))
}

#[tauri::command]
fn vault_unlock(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    minutes: Option<u64>,
) -> Result<vault::VaultEntry, String> {
    // Free tier unlocks indefinitely — the timed auto-relock is Pro.
    let minutes = if PRO {
        Some(minutes.unwrap_or(5).clamp(1, 120))
    } else {
        None
    };
    let p = PathBuf::from(&path);
    let mut s = state.vault.lock().unwrap();
    vault::unlock(&p, &s.user)?;
    let key = norm(&p);
    if let Some(h) = s.relock.remove(&key) {
        h.abort();
    }
    let entry = {
        let e = find_entry(&mut s, &key)?;
        e.locked = false;
        e.unlock_at = minutes.map(|m| now_secs() + m * 60);
        e.clone()
    };

    let _ = &app; // the handle is only needed by the Pro relock timer
    #[cfg(feature = "pro")]
    {
        if minutes.is_some() && !licensed(&state) {
            return Err("Cairn Pro license required — activate Pro in the Vault tab".into());
        }
        if let Some(m) = minutes {
            pro::commands::schedule_relock(&app, &mut s, key, p.clone(), m);
        }
    }
    Ok(entry)
}

// ---------- autostart ----------

/// Opens an http(s) URL in the default browser (upgrade CTAs).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    crate::util::hidden(&mut std::process::Command::new(crate::util::opener()))
        .arg(&url)
        .spawn()
        .map_err(|e| format!("failed to open browser: {e}"))?;
    Ok(())
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let mgr = app.autolaunch();
    if enabled { mgr.enable() } else { mgr.disable() }.map_err(|e| e.to_string())?;
    mgr.is_enabled().map_err(|e| e.to_string())
}

// ---------- app ----------

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            sys: Mutex::new(System::new_all()),
            vault: Mutex::new(VaultShared {
                entries: Vec::new(),
                persist: None,
                relock: HashMap::new(),
                user: vault::current_user(),
            }),
            scan: Mutex::new(ScanShared::default()),
            data_dir: Mutex::new(None),
            #[cfg(feature = "pro")]
            pro_active: std::sync::atomic::AtomicBool::new(false),
        });
    // Pro managed state (watchdog runtime) only exists in Pro builds —
    // free builds never register it.
    #[cfg(feature = "pro")]
    let builder = builder.manage(pro::commands::ProState::default());
    builder
        .invoke_handler({
            #[cfg(feature = "pro")]
            {
                tauri::generate_handler![
                    system_snapshot,
                    kill_processes,
                    localhost_processes,
                    scan_start,
                    scan_status,
                    scan_home,
                    vault_list,
                    vault_add,
                    vault_remove,
                    vault_lock,
                    vault_lock_all,
                    vault_open,
                    vault_unlock,
                    pro::commands::watchdog_start,
                    pro::commands::watchdog_stop,
                    pro::commands::watchdog_status,
                    pro::commands::watchdog_unwatch,
                    pro::commands::backup_check,
                    pro::commands::backup_remotes,
                    pro::commands::backup_run,
                    pro::commands::backup_history,
                    pro::commands::backup_checkpoint_status,
                    pro::commands::backup_checkpoint_stage,
                    pro::commands::backup_checkpoint_finish,
                    pro::commands::backup_checkpoint_compare,
                    pro::commands::backup_checkpoint_schedule,
                    pro::commands::backup_checkpoint_configure,
                    pro::commands::license_status,
                    pro::commands::license_activate,
                    autostart_enabled,
                    autostart_set,
                    app_caps,
                    open_url,
                ]
            }
            #[cfg(not(feature = "pro"))]
            {
                tauri::generate_handler![
                    system_snapshot,
                    kill_processes,
                    localhost_processes,
                    scan_start,
                    scan_status,
                    scan_home,
                    vault_list,
                    vault_add,
                    vault_remove,
                    vault_lock,
                    vault_lock_all,
                    vault_open,
                    vault_unlock,
                    autostart_enabled,
                    autostart_set,
                    app_caps,
                    open_url,
                ]
            }
        })
        .setup(|app| {
            // Refresh a stale login entry so the Run command carries
            // AUTOSTART_ARG — installs enabled before the flag existed
            // would otherwise keep popping the window at every sign-in.
            {
                let mgr = app.autolaunch();
                if mgr.is_enabled().unwrap_or(false) {
                    let _ = mgr.enable();
                }
            }
            if let Ok(dir) = app.path().app_data_dir() {
                let st = app.state::<AppState>();
                *st.data_dir.lock().unwrap() = Some(dir.clone());

                // Restore vault entries; the ACLs themselves never left the folders.
                let file = dir.join(VAULT_FILE);
                {
                    let mut s = st.vault.lock().unwrap();
                    s.persist = Some(file.clone());
                    if let Ok(json) = std::fs::read_to_string(&file) {
                        if let Ok(list) = serde_json::from_str::<Vec<VaultFileEntry>>(&json) {
                            for item in list {
                                let p = PathBuf::from(&item.path);
                                let known = s.entries.iter().any(|e| e.path == item.path);
                                if p.is_dir() && !known {
                                    let locked = vault::is_locked(&p, &s.user);
                                    s.entries.push(vault::VaultEntry {
                                        path: item.path,
                                        locked,
                                        unlock_at: None,
                                    });
                                }
                            }
                        }
                    }
                }

                // A running watchdog stays armed across restarts (Pro).
                #[cfg(feature = "pro")]
                {
                    pro::commands::rearm(app.handle(), &dir);
                    pro::commands::start_checkpoint_scheduler(app.handle(), &dir);
                }

                // Background disk picture at launch — the drive the user
                // last scanned (or the best-guess data drive) starts
                // walking now; the Disk tab attaches to it on open.
                let st = app.state::<AppState>();
                if let Some(root) = pick_default_scan_root(&st) {
                    spawn_scan(&app.handle(), root);
                }
            }

            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "show", "Show Cairn", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::with_id(MAIN_TRAY)
                .menu(&menu)
                .tooltip("Cairn")
                .icon(app.default_window_icon().expect("window icon").clone())
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(w) = tray.app_handle().get_webview_window(MAIN_WINDOW) {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Tray heartbeat: RAM every 5s, disk free refreshed every ~30s.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut sys = System::new();
                let mut disks = Disks::new_with_refreshed_list();
                let mut tick = 0u32;
                loop {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    sys.refresh_memory();
                    if tick % 6 == 0 {
                        disks = Disks::new_with_refreshed_list();
                    }
                    tick = tick.wrapping_add(1);
                    let pct = if sys.total_memory() > 0 {
                        sys.used_memory() * 100 / sys.total_memory()
                    } else {
                        0
                    };
                    let mut tip = format!("Cairn — RAM {pct}%");
                    for d in disks.iter().take(3) {
                        tip.push_str(&format!(
                            " · {} {}",
                            d.mount_point().to_string_lossy(),
                            human_gb(d.available_space())
                        ));
                    }
                    if let Some(tray) = handle.tray_by_id(MAIN_TRAY) {
                        let _ = tray.set_tooltip(Some(&tip));
                    }
                }
            });

            // Closing the window tucks Cairn into the tray; Quit exits.
            if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                let w2 = w.clone();
                w.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w2.hide();
                    }
                });
                // The window is created hidden (config `visible: false`):
                // login autostart leaves it tucked in the tray, every
                // other launch shows it.
                if !launched_hidden(std::env::args()) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Cairn");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_only_with_autostart_arg() {
        assert!(launched_hidden(
            ["cairn.exe".into(), AUTOSTART_ARG.into()].into_iter()
        ));
        assert!(!launched_hidden(["cairn.exe".into()].into_iter()));
        assert!(!launched_hidden(
            ["cairn.exe".into(), "--other".into()].into_iter()
        ));
    }
}
