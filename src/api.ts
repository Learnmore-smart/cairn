import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface DiskInfo {
  name: string;
  mount: string;
  fs: string;
  totalBytes: number;
  availBytes: number;
}

export interface ProcGroup {
  name: string;
  count: number;
  memoryBytes: number;
  /** CPU% normalized to 0–100 across all cores. */
  cpuPct: number;
  pids: number[];
}

export interface KillOutcome {
  killed: number;
  /** Skipped — system-critical or our own pid. */
  refused: number;
}

export interface SystemSnapshot {
  totalMemory: number;
  usedMemory: number;
  availMemory: number;
  totalSwap: number;
  usedSwap: number;
  uptimeSecs: number;
  disks: DiskInfo[];
  processes: ProcGroup[];
}

export interface ScanChild {
  name: string;
  path: string;
  bytes: number;
  isDir: boolean;
  hasCache: boolean;
}

export interface DevCache {
  path: string;
  kind: string;
  bytes: number;
}

export interface ScanResult {
  root: string;
  totalBytes: number;
  durationMs: number;
  entries: number;
  errors: number;
  children: ScanChild[];
  devCaches: DevCache[];
}

export interface ScanProgress {
  entries: number;
  bytes: number;
}

/** Persisted scan restored before re-walking — `savedAt` is epoch secs. */
export interface SavedScan {
  savedAt: number;
  result: ScanResult;
}

export interface VaultEntry {
  path: string;
  locked: boolean;
  unlockAt: number | null;
}

export interface WatchdogStatus {
  running: boolean;
  watchedPaths: string[];
  burstCount: number;
  lastBurstAt: number | null;
}

export interface DeleteBurst {
  count: number;
  windowSecs: number;
  at: number;
}

export interface BackupCheck {
  found: boolean;
  version: string | null;
}

export interface BackupResult {
  ok: boolean;
  log: string;
}

export interface BackupRecord {
  at: number;
  source: string;
  remote: string;
  ok: boolean;
  tail: string;
}

/** Edition capabilities — `pro` flips watchdog/backup/vault limits on. */
export interface AppCaps {
  pro: boolean;
  vaultLimit: number | null;
}

export const api = {
  systemSnapshot: () => invoke<SystemSnapshot>("system_snapshot"),
  killProcesses: (pids: number[]) => invoke<KillOutcome>("kill_processes", { pids }),
  scanDirectory: (path: string) => invoke<ScanResult>("scan_directory", { path }),
  scanLast: (root: string) => invoke<SavedScan | null>("scan_last", { root }),
  vaultList: () => invoke<VaultEntry[]>("vault_list"),
  vaultAdd: (path: string) => invoke<VaultEntry[]>("vault_add", { path }),
  vaultRemove: (path: string) => invoke<VaultEntry[]>("vault_remove", { path }),
  vaultLock: (path: string) => invoke<VaultEntry>("vault_lock", { path }),
  vaultLockAll: () => invoke<VaultEntry[]>("vault_lock_all"),
  vaultOpen: (path: string) => invoke<void>("vault_open", { path }),
  vaultUnlock: (path: string, minutes: number) =>
    invoke<VaultEntry>("vault_unlock", { path, minutes }),
  watchdogStart: (paths: string[]) => invoke<WatchdogStatus>("watchdog_start", { paths }),
  watchdogStop: () => invoke<WatchdogStatus>("watchdog_stop"),
  watchdogStatus: () => invoke<WatchdogStatus>("watchdog_status"),
  watchdogUnwatch: (path: string) => invoke<WatchdogStatus>("watchdog_unwatch", { path }),
  backupCheck: () => invoke<BackupCheck>("backup_check"),
  backupRemotes: () => invoke<string[]>("backup_remotes"),
  backupRun: (source: string, remote: string) =>
    invoke<BackupResult>("backup_run", { source, remote }),
  backupHistory: () => invoke<BackupRecord[]>("backup_history"),
  autostartEnabled: () => invoke<boolean>("autostart_enabled"),
  autostartSet: (enabled: boolean) => invoke<boolean>("autostart_set", { enabled }),
  appCaps: () => invoke<AppCaps>("app_caps"),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
};

export function onDeleteBurst(cb: (burst: DeleteBurst) => void): Promise<UnlistenFn> {
  return listen<DeleteBurst>("cairn://delete-burst", (event) => cb(event.payload));
}

export function onScanProgress(cb: (p: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>("cairn://scan-progress", (event) => cb(event.payload));
}

export function onBackupLine(cb: (line: string) => void): Promise<UnlistenFn> {
  return listen<string>("cairn://backup-line", (event) => cb(event.payload));
}

export function onBackupDone(cb: (ok: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("cairn://backup-done", (event) => cb(event.payload));
}
