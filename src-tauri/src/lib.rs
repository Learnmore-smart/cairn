mod disk_scan;
mod monitor;
#[cfg(feature = "pro")]
mod pro;
mod vault;

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
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
}

#[tauri::command]
fn app_caps() -> AppCaps {
    AppCaps {
        pro: PRO,
        vault_limit: if PRO { None } else { Some(FREE_VAULT_LIMIT) },
    }
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

pub struct AppState {
    sys: Mutex<System>,
    vault: Mutex<VaultShared>,
    /// App data dir — home of vault/scan-history JSON files.
    data_dir: Mutex<Option<PathBuf>>,
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    entries: u64,
    bytes: u64,
}

#[tauri::command]
async fn scan_directory(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<disk_scan::ScanResult, String> {
    // Time-throttled emit — the walk ticks per-2048 files, the UI hears
    // at most ~8 fps of updates either way.
    let last = Mutex::new(Instant::now());
    let emit = move |entries: u64, bytes: u64| {
        let mut g = last.lock().unwrap();
        if g.elapsed().as_millis() >= 120 {
            *g = Instant::now();
            let _ = app.emit("cairn://scan-progress", ScanProgress { entries, bytes });
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        disk_scan::scan(Path::new(&path), Some(&emit))
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Ok(res) = &result {
        if let Some(dir) = state.data_dir.lock().unwrap().clone() {
            disk_scan::save_saved_scan(
                &dir.join(SCAN_FILE),
                &norm(Path::new(&res.root)),
                disk_scan::SavedScan {
                    saved_at: now_secs(),
                    result: res.clone(),
                },
            );
        }
    }
    result
}

#[tauri::command]
fn scan_last(state: State<AppState>, root: String) -> Option<disk_scan::SavedScan> {
    let dir = state.data_dir.lock().unwrap().clone()?;
    disk_scan::load_saved_scans(&dir.join(SCAN_FILE))
        .get(&norm(Path::new(&root)))
        .cloned()
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
        if !PRO && s.entries.len() >= FREE_VAULT_LIMIT {
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
    if let Some(m) = minutes {
        pro::commands::schedule_relock(&app, &mut s, key, p.clone(), m);
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
    std::process::Command::new("explorer")
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
            None,
        ))
        .manage(AppState {
            sys: Mutex::new(System::new_all()),
            vault: Mutex::new(VaultShared {
                entries: Vec::new(),
                persist: None,
                relock: HashMap::new(),
                user: vault::current_user(),
            }),
            data_dir: Mutex::new(None),
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
                    scan_directory,
                    scan_last,
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
                    scan_directory,
                    scan_last,
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
                pro::commands::rearm(app.handle(), &dir);
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
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Cairn");
}
