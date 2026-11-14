export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit] ?? "B"}`;
}

export function formatPercent(part: number, total: number): string {
  if (total <= 0 || part <= 0) return "0%";
  return `${Math.min(999, Math.round((part / total) * 100))}%`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** unlockAt is epoch seconds; nowMs is Date.now(). */
export function formatCountdown(unlockAt: number | null, nowMs: number): string | null {
  if (unlockAt == null) return null;
  const secs = Math.ceil(unlockAt - nowMs / 1000);
  if (secs <= 0) return "relocking…";
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/** "2h ago" style — epoch secs in, relative label out. */
export function formatAgo(epochSecs: number, nowMs: number): string {
  const secs = Math.max(0, Math.floor(nowMs / 1000 - epochSecs));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}
