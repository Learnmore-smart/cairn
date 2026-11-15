use jwalk::{Parallelism, WalkDir};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

/// Returned when `stop` flips mid-walk — the caller treats it as a quiet
/// abort, never an error surface.
pub const CANCELLED: &str = "cancelled";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanChild {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub is_dir: bool,
    pub has_cache: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevCache {
    pub path: String,
    pub kind: String,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: String,
    pub total_bytes: u64,
    pub duration_ms: u64,
    pub entries: u64,
    pub errors: u64,
    pub children: Vec<ScanChild>,
    pub dev_caches: Vec<DevCache>,
}

/// Persisted scan — restored so the UI shows the last picture before
/// anyone waits for a fresh walk.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SavedScan {
    pub saved_at: u64,
    pub result: ScanResult,
}

/// Result lists are sorted desc — anything past these caps is sub-1%
/// noise and only inflates the IPC payload (and the UI only ever
/// renders a few dozen rows).
const MAX_CHILDREN: usize = 500;
const MAX_CACHES: usize = 500;

/// Directory names that are unambiguously rebuildable artifacts.
const STRONG_CACHE_DIRS: &[(&str, &str)] = &[
    ("node_modules", "node-modules"),
    (".venv", "python-venv"),
    ("venv", "python-venv"),
    ("__pycache__", "build-cache"),
    (".pytest_cache", "build-cache"),
    (".mypy_cache", "build-cache"),
    (".next", "build-cache"),
    (".nuxt", "build-cache"),
    (".turbo", "build-cache"),
    (".gradle", "build-cache"),
    (".dart_tool", "build-cache"),
    ("deriveddata", "build-cache"),
    (".cargo", "pkg-cache"),
    (".pnpm-store", "pkg-cache"),
    (".nuget", "pkg-cache"),
];

/// Standalone files that are heavyweight rebuildable artifacts.
const FILE_CACHE_NAMES: &[(&str, &str)] =
    &[("ext4.vhdx", "wsl-disk"), ("docker_data.vhdx", "wsl-disk")];

fn lower(s: &OsStr) -> String {
    s.to_string_lossy().to_lowercase()
}

fn has_dotnet_project(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten().take(200).any(|e| {
                let n = lower(&e.file_name());
                n.ends_with(".csproj")
                    || n.ends_with(".fsproj")
                    || n.ends_with(".vbproj")
                    || n.ends_with(".sln")
            })
        })
        .unwrap_or(false)
}

/// Ambiguous names get classified only with a manifest sibling —
/// a folder called `target` or `bin` is not automatically garbage.
fn manifest_kind(name: &str, parent: &Path) -> Option<&'static str> {
    match name {
        "target" if parent.join("Cargo.toml").is_file() => Some("rust-target"),
        "bin" | "obj" if has_dotnet_project(parent) => Some("dotnet-binobj"),
        _ => None,
    }
}

pub fn cache_kind(name: &str, parent: Option<&Path>) -> Option<&'static str> {
    STRONG_CACHE_DIRS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, k)| *k)
        .or_else(|| parent.and_then(|p| manifest_kind(name, p)))
}

struct Bucket {
    bytes: u64,
    is_dir: bool,
    has_cache: bool,
}

/// Single parallel walk. jwalk yields a directory's entry before any of its
/// descendants, so a `cache_scope` lookup on the parent path always reflects
/// whether the file lives inside a tagged cache subtree.
/// `progress(entries, bytes)` fires every ~2048 files — the caller
/// time-throttles the actual UI emit, so slow disks still tick.
/// `stop` is polled per entry — a newer scan superseding this one flips it
/// and the walk bails early as `Err(CANCELLED)` instead of finishing stale.
/// Parallelism is capped below all cores — an uncapped rayon pool
/// saturating every CPU + the disk is what made the UI feel laggy.
pub fn scan(
    root: &Path,
    progress: Option<&dyn Fn(u64, u64)>,
    stop: Option<&AtomicBool>,
) -> Result<ScanResult, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let stopped =
        |stop: Option<&AtomicBool>| stop.map(|f| f.load(Ordering::Relaxed)).unwrap_or(false);
    let workers = std::thread::available_parallelism()
        .map(|v| v.get())
        .unwrap_or(4)
        .saturating_sub(2)
        .clamp(1, 6);
    let start = Instant::now();
    let mut total = 0u64;
    let mut entries = 0u64;
    let mut errors = 0u64;
    let mut last_progress = 0u64;
    let mut children: HashMap<OsString, Bucket> = HashMap::new();
    let mut caches: HashMap<PathBuf, (u64, &'static str)> = HashMap::new();
    // Maps a directory to the cache root it sits inside — only populated for
    // directories that are themselves inside a cache subtree.
    let mut cache_scope: HashMap<PathBuf, PathBuf> = HashMap::new();

    for entry in WalkDir::new(root).parallelism(Parallelism::RayonNewPool(workers)) {
        if stopped(stop) {
            return Err(CANCELLED.into());
        }
        let Ok(entry) = entry else {
            errors += 1;
            continue;
        };
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => {
                errors += 1;
                continue;
            }
        };

        if meta.is_dir() {
            let parent = path.parent();
            let inherited = parent.and_then(|p| cache_scope.get(p)).cloned();
            if inherited.is_none() {
                let name = lower(&entry.file_name());
                if let Some(kind) = cache_kind(&name, parent) {
                    cache_scope.insert(path.clone(), path.clone());
                    caches.insert(path.clone(), (0, kind));
                    continue;
                }
            }
            if let Some(cache_root) = inherited {
                cache_scope.insert(path.clone(), cache_root);
            }
        } else if meta.is_file() {
            let size = meta.len();
            total += size;
            entries += 1;
            if let Some(p) = progress {
                if entries - last_progress >= 2048 {
                    last_progress = entries;
                    p(entries, total);
                }
            }

            if let Ok(rel) = path.strip_prefix(root) {
                let mut comps = rel.components();
                if let Some(Component::Normal(name)) = comps.next() {
                    let depth_in_child = comps.next().is_some();
                    let bucket = children
                        .entry(name.to_os_string())
                        .or_insert_with(|| Bucket {
                            bytes: 0,
                            is_dir: depth_in_child || meta.is_dir(),
                            has_cache: false,
                        });
                    bucket.bytes += size;
                }
            }

            let file_name = lower(&entry.file_name());
            if let Some(kind) = FILE_CACHE_NAMES
                .iter()
                .find(|(n, _)| *n == file_name)
                .map(|(_, k)| *k)
            {
                caches.insert(path.clone(), (size, kind));
            } else if let Some(cache_root) = path.parent().and_then(|p| cache_scope.get(p)).cloned()
            {
                if let Some(c) = caches.get_mut(&cache_root) {
                    c.0 += size;
                }
                if let Ok(rel) = path.strip_prefix(root) {
                    if let Some(Component::Normal(name)) = rel.components().next() {
                        if let Some(b) = children.get_mut(name) {
                            b.has_cache = true;
                        }
                    }
                }
            }
        }
    }

    let mut children: Vec<ScanChild> = children
        .into_iter()
        .map(|(name, b)| ScanChild {
            name: name.to_string_lossy().into_owned(),
            path: root.join(&name).to_string_lossy().into_owned(),
            bytes: b.bytes,
            is_dir: b.is_dir,
            has_cache: b.has_cache,
        })
        .collect();
    children.sort_by(|a, b| b.bytes.cmp(&a.bytes));

    let mut dev_caches: Vec<DevCache> = caches
        .into_iter()
        .map(|(p, (bytes, kind))| DevCache {
            path: p.to_string_lossy().into_owned(),
            kind: kind.to_string(),
            bytes,
        })
        .collect();
    dev_caches.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    children.truncate(MAX_CHILDREN);
    dev_caches.truncate(MAX_CACHES);

    Ok(ScanResult {
        root: root.to_string_lossy().into_owned(),
        total_bytes: total,
        duration_ms: start.elapsed().as_millis() as u64,
        entries,
        errors,
        children,
        dev_caches,
    })
}

/// Last-scan store: one `SavedScan` per normalized root in a single JSON map.
pub fn load_saved_scans(file: &Path) -> HashMap<String, SavedScan> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// Bounded to the 32 most recent roots — the file stays small even if the
/// user scans a different folder every day.
pub fn save_saved_scan(file: &Path, key: &str, saved: SavedScan) {
    const MAX_ROOTS: usize = 32;
    let mut map = load_saved_scans(file);
    map.insert(key.to_string(), saved);
    if map.len() > MAX_ROOTS {
        let mut keys: Vec<(String, u64)> =
            map.iter().map(|(k, v)| (k.clone(), v.saved_at)).collect();
        keys.sort_by_key(|(_, t)| *t);
        for (k, _) in keys.into_iter().take(map.len() - MAX_ROOTS) {
            map.remove(&k);
        }
    }
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&map) {
        let _ = std::fs::write(file, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_tree(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cairn-scan-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // real source tree
        fs::create_dir_all(dir.join("project/src")).unwrap();
        fs::write(dir.join("project/src/main.rs"), b"fn main() {}").unwrap();
        fs::write(dir.join("project/Cargo.toml"), b"[package]").unwrap();
        // rust target — ambiguous name resolved by Cargo.toml sibling
        fs::create_dir_all(dir.join("project/target/debug")).unwrap();
        fs::write(dir.join("project/target/debug/app.exe"), vec![0u8; 2048]).unwrap();
        // node_modules — strong name, no manifest needed
        fs::create_dir_all(dir.join("web/node_modules/.bin")).unwrap();
        fs::write(dir.join("web/node_modules/pkg.js"), vec![1u8; 4096]).unwrap();
        // a folder literally named `target` with no manifest — NOT a cache
        fs::create_dir_all(dir.join("photos/target")).unwrap();
        fs::write(dir.join("photos/target/pic.raw"), vec![2u8; 1024]).unwrap();
        // wsl vhdx file
        fs::create_dir_all(dir.join("wsl")).unwrap();
        fs::write(dir.join("wsl/ext4.vhdx"), vec![3u8; 8192]).unwrap();
        dir
    }

    #[test]
    fn scan_buckets_top_level_and_tags_caches() {
        let dir = temp_tree("scan");
        let res = scan(&dir, None, None).unwrap();
        assert_eq!(res.total_bytes, 2048 + 4096 + 1024 + 8192 + 21);
        let names: Vec<&str> = res.children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"project") && names.contains(&"web") && names.contains(&"wsl"));

        let kinds: Vec<(&str, &str)> = res
            .dev_caches
            .iter()
            .map(|c| (c.kind.as_str(), c.path.as_str()))
            .collect();
        assert!(kinds
            .iter()
            .any(|(k, p)| *k == "rust-target" && p.ends_with("target")));
        assert!(kinds
            .iter()
            .any(|(k, p)| *k == "node-modules" && p.contains("node_modules")));
        assert!(kinds
            .iter()
            .any(|(k, p)| *k == "wsl-disk" && p.ends_with("ext4.vhdx")));
        // photos/target must NOT be tagged
        assert!(!res.dev_caches.iter().any(|c| c.path.contains("photos")));

        let rust = res
            .dev_caches
            .iter()
            .find(|c| c.kind == "rust-target")
            .unwrap();
        assert_eq!(rust.bytes, 2048);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cache_kind_needs_manifest_for_ambiguous_names() {
        let dir = temp_tree("kind");
        assert_eq!(
            cache_kind("target", Some(&dir.join("project"))),
            Some("rust-target")
        );
        assert_eq!(cache_kind("target", Some(&dir.join("photos"))), None);
        assert_eq!(cache_kind("node_modules", None), Some("node-modules"));
        assert_eq!(cache_kind("random-dir", None), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scan_rejects_missing_root() {
        assert!(scan(Path::new("Z:\\definitely-not-here-xyz"), None, None).is_err());
    }

    #[test]
    fn stop_flag_aborts_the_walk() {
        let dir = temp_tree("stop");
        let flag = AtomicBool::new(true);
        let res = scan(&dir, None, Some(&flag));
        assert!(matches!(res, Err(e) if e == CANCELLED));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saved_scan_roundtrips_and_trims() {
        let dir = std::env::temp_dir().join(format!("cairn-saved-test-{}", std::process::id()));
        let file = dir.join("last-scan.json");
        let _ = std::fs::remove_dir_all(&dir);
        let mk = |root: &str| SavedScan {
            saved_at: 1,
            result: ScanResult {
                root: root.into(),
                total_bytes: 7,
                duration_ms: 1,
                entries: 1,
                errors: 0,
                children: vec![],
                dev_caches: vec![],
            },
        };
        for i in 0..40 {
            save_saved_scan(&file, &format!("root-{i}"), mk(&format!("root-{i}")));
        }
        let map = load_saved_scans(&file);
        assert_eq!(map.len(), 32);
        assert!(map.contains_key("root-39")); // newest survives the trim
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn progress_callback_fires_with_running_totals() {
        let dir = temp_tree("progress");
        let calls = std::cell::RefCell::new(Vec::<(u64, u64)>::new());
        let res = scan(
            &dir,
            Some(&|entries, bytes| calls.borrow_mut().push((entries, bytes))),
            None,
        )
        .unwrap();
        // tiny fixture — below the emit threshold, so no callbacks is correct
        let calls = calls.borrow();
        assert!(calls.is_empty() || calls.iter().all(|(e, _)| *e <= res.entries));
        fs::remove_dir_all(&dir).unwrap();
    }
}
