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

export interface LocalhostProcess {
  pid: number;
  name: string;
  memoryBytes: number;
  cpuPct: number;
  ports: number[];
  /** Display-safe script/workload hint — never a raw command line. */
  summary: string;
  cwd: string | null;
  isNode: boolean;
  critical: boolean;
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
  /** Root being walked — the UI filters events to its current view. */
  root: string;
  entries: number;
  bytes: number;
}

/** What the Disk tab needs to paint for one root — backend-owned so a
 * hidden window or remounted tab re-attaches instead of restarting. */
export interface ScanStatus {
  phase: "idle" | "scanning" | "done";
  progress: ScanProgress | null;
  result: ScanResult | null;
  /** Epoch secs — set only when `result` came from the persisted store. */
  savedAt: number | null;
  /** The root currently walking, if any (may differ from the queried one). */
  runningRoot: string | null;
}

/** `cairn://scan-done` payload — a finished walk lands its result here so
 * the UI never depends on an in-flight invoke promise. */
export interface ScanDone {
  root: string;
  ok: boolean;
  cancelled: boolean;
  error: string | null;
  result: ScanResult | null;
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

export interface BackupFolder {
  remote: string;
  id: string;
}

export interface BackupCheckpoint {
  base: string;
  source: string;
  active: BackupFolder;
  pending: {
    remote: string;
    folderId: string | null;
    phase: "uploading" | "ready" | "removing";
  } | null;
  retained: BackupFolder[];
}

export interface BackupFileChanges {
  added: { count: number; examples: string[] };
  changed: { count: number; examples: string[] };
  removed: { count: number; examples: string[] };
}

export type BackupCheckpointAction = "keep" | "removePrevious" | "removeRetained";

export interface CheckpointScheduleSettings {
  source: string;
  remote: string;
  enabled: boolean;
  intervalDays: number;
  maxSaved: number;
}

export interface CheckpointSchedule extends CheckpointScheduleSettings {
  nextAt: number;
  lastCompletedAt: number | null;
  outcome: "waiting" | "completed" | "limit" | "review" | "failed";
  error: string | null;
}

/** Edition capabilities — `pro` flips watchdog/backup/vault limits on. */
export interface AppCaps {
  pro: boolean;
  vaultLimit: number | null;
  /** std::env::consts::OS — "windows" gates the NTFS ACL vault UI. */
  platform: string;
}

/** Verified license identity — `null` means Pro is locked. */
export interface LicenseInfo {
  email: string;
  session: string;
  iat: number;
}

export const api = {
  systemSnapshot: () => invoke<SystemSnapshot>("system_snapshot"),
  killProcesses: (pids: number[]) => invoke<KillOutcome>("kill_processes", { pids }),
  localhostProcesses: () => invoke<LocalhostProcess[]>("localhost_processes"),
  scanStart: (path: string) => invoke<ScanStatus>("scan_start", { path }),
  scanStatus: (root: string) => invoke<ScanStatus>("scan_status", { root }),
  /** The backend's auto-scan root (last-scanned drive else biggest fixed). */
  scanHome: () => invoke<string | null>("scan_home"),
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
  backupCheckpointStatus: (remote: string) =>
    invoke<BackupCheckpoint | null>("backup_checkpoint_status", { remote }),
  backupCheckpointStage: (source: string, remote: string) =>
    invoke<BackupCheckpoint>("backup_checkpoint_stage", { source, remote }),
  backupCheckpointFinish: (remote: string, action: BackupCheckpointAction, target: string) =>
    invoke<BackupCheckpoint>("backup_checkpoint_finish", { remote, action, target }),
  backupCheckpointCompare: (remote: string, previous?: string) =>
    invoke<BackupFileChanges>("backup_checkpoint_compare", { remote, previous }),
  backupCheckpointSchedule: (remote: string) =>
    invoke<CheckpointSchedule | null>("backup_checkpoint_schedule", { remote }),
  backupCheckpointConfigure: (settings: CheckpointScheduleSettings) =>
    invoke<CheckpointSchedule>("backup_checkpoint_configure", { settings }),
  licenseStatus: () => invoke<LicenseInfo | null>("license_status"),
  licenseActivate: (key: string) => invoke<LicenseInfo>("license_activate", { key }),
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

export function onScanDone(cb: (d: ScanDone) => void): Promise<UnlistenFn> {
  return listen<ScanDone>("cairn://scan-done", (event) => cb(event.payload));
}

export function onBackupLine(cb: (line: string) => void): Promise<UnlistenFn> {
  return listen<string>("cairn://backup-line", (event) => cb(event.payload));
}

export function onBackupDone(cb: (ok: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("cairn://backup-done", (event) => cb(event.payload));
}

export function onBackupUpdated(cb: () => void): Promise<UnlistenFn> {
  return listen("cairn://backup-updated", cb);
}
