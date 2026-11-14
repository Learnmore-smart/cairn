import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  onScanProgress,
  type DiskInfo,
  type ScanChild,
  type ScanProgress,
  type ScanResult,
} from "../api";
import { AppSelect } from "../components/AppSelect";
import { formatAgo, formatBytes, formatDurationMs, formatPercent } from "../format";
import { IconBack, IconChevron, IconFile, IconFolder, IconScan } from "../icons";
import { layoutTreemap } from "../treemap";

const KIND_LABEL: Record<string, string> = {
  "node-modules": "node_modules",
  "rust-target": "target/",
  "dotnet-binobj": "bin|obj",
  "python-venv": "venv",
  "build-cache": "build cache",
  "pkg-cache": "pkg cache",
  "wsl-disk": "wsl/disk image",
};

const TREEMAP_TOP = 18;
const PALETTE = [
  "#e0a44a",
  "#3FA7B8",
  "#8B5CF6",
  "#5B8DEF",
  "#E05555",
  "#4C9F70",
  "#B86BD8",
  "#EE9A35",
];

function Treemap({
  children,
  onDrill,
}: {
  children: ScanChild[];
  onDrill: (c: ScanChild) => void;
}) {
  const { rects, rest, restBytes, byId } = useMemo(() => {
    const top = children.slice(0, TREEMAP_TOP);
    const rest = children.slice(TREEMAP_TOP);
    const restBytes = rest.reduce((s, c) => s + c.bytes, 0);
    const items = top.map((c) => ({ id: c.path, size: c.bytes }));
    if (restBytes > 0) items.push({ id: "__other__", size: restBytes });
    return {
      rects: layoutTreemap(items, 1000, 420),
      rest,
      restBytes,
      byId: new Map(top.map((c) => [c.path, c])),
    };
  }, [children]);

  return (
    <svg
      viewBox="0 0 1000 420"
      className="block h-auto w-full"
      role="img"
      aria-label="Size treemap"
    >
      {rects.map((r, i) => {
        const c = byId.get(r.id);
        const fill = c
          ? c.hasCache
            ? "var(--color-cache)"
            : PALETTE[i % PALETTE.length]
          : "var(--color-mut)";
        const label = r.w > 92 && r.h > 30 ? (c ? c.name : `${rest.length} smaller items`) : null;
        const sub = r.w > 92 && r.h > 46 ? formatBytes(c ? c.bytes : restBytes) : null;
        return (
          <g
            key={r.id}
            className={c?.isDir ? "cursor-pointer" : undefined}
            onClick={c?.isDir ? () => onDrill(c) : undefined}
          >
            <title>
              {c
                ? `${c.path} — ${formatBytes(c.bytes)}${c.isDir ? " (click to drill in)" : ""}`
                : `${rest.length} smaller items — ${formatBytes(restBytes)}`}
            </title>
            <rect
              x={r.x + 1}
              y={r.y + 1}
              width={Math.max(0, r.w - 2)}
              height={Math.max(0, r.h - 2)}
              rx={4}
              fill={fill}
              fillOpacity={c ? 0.42 : 0.25}
              stroke="var(--color-ink)"
              strokeWidth={1}
              className={c?.isDir ? "u-tmap-rect" : undefined}
            />
            {label ? (
              <text x={r.x + 8} y={r.y + 18} className="fill-fg" fontSize={12} fontWeight={600}>
                {label.length > Math.floor(r.w / 7.2)
                  ? `${label.slice(0, Math.floor(r.w / 7.2))}…`
                  : label}
              </text>
            ) : null}
            {sub ? (
              <text x={r.x + 8} y={r.y + 34} className="fill-mut" fontSize={11}>
                {sub}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function DiskTab({ disks }: { disks: DiskInfo[] }) {
  const [root, setRoot] = useState("");
  const [crumbs, setCrumbs] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlisten = useRef<(() => void) | null>(null);
  const sessionCache = useRef(new Map<string, ScanResult>());
  const scanRootRef = useRef("");
  const runRef = useRef<(target: string) => void>(() => {});
  const scanningRef = useRef(false);

  useEffect(
    () => () => {
      unlisten.current?.();
    },
    [],
  );

  const driveRoot = root || disks.find((d) => d.mount === "D:\\")?.mount || disks[0]?.mount || "";
  const scanRoot = crumbs.length > 0 ? crumbs[crumbs.length - 1]! : driveRoot;
  scanRootRef.current = scanRoot;
  const maxChild = useMemo(
    () => result?.children.reduce((m, c) => Math.max(m, c.bytes), 1) ?? 1,
    [result],
  );

  // Restore the last picture for this root — session memory first,
  // then the persisted `cairn-last-scan.json` — before any re-walk.
  // A drilled crumb that was never walked scans itself so the trail
  // always lands somewhere real; the drive root itself stays manual.
  useEffect(() => {
    if (!scanRoot) return;
    const hit = sessionCache.current.get(scanRoot);
    if (hit) {
      setResult(hit);
      setSavedAt(null);
      return;
    }
    let dead = false;
    setResult(null);
    setSavedAt(null);
    void api
      .scanLast(scanRoot)
      .then((s) => {
        if (dead) return;
        if (s && s.result.root === scanRoot) {
          setResult(s.result);
          setSavedAt(s.savedAt);
        } else if (crumbs.length > 0 && !scanningRef.current) {
          runRef.current(scanRoot);
        }
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [scanRoot, crumbs.length]);

  const run = (target: string) => {
    if (!target || scanning) return;
    setScanning(true);
    scanningRef.current = true;
    setError(null);
    setProgress(null);
    void onScanProgress(setProgress).then((f) => {
      unlisten.current?.();
      unlisten.current = f;
    });
    api
      .scanDirectory(target)
      .then((res) => {
        sessionCache.current.set(res.root, res);
        if (res.root === scanRootRef.current) {
          setResult(res);
          setSavedAt(null);
        }
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        setScanning(false);
        scanningRef.current = false;
        setProgress(null);
      });
  };
  runRef.current = run;

  const drill = (c: ScanChild) => {
    if (!c.isDir) return;
    // Rebuild the full ancestor chain so the breadcrumb trail is accurate
    // even when jumping straight into a deep dev-cache path.
    const parts = c.path.split("\\").filter(Boolean);
    const chain = parts.slice(1).map((_, i) => parts.slice(0, i + 2).join("\\"));
    setCrumbs(chain);
    run(c.path);
  };

  const pop = () => {
    // No rescan — the effect restores the parent's picture instantly.
    setCrumbs((prev) => prev.slice(0, -1));
  };

  const goTo = (depth: number) => {
    // depth -1 = drive root, otherwise keep the first `depth + 1` crumbs.
    setCrumbs((prev) => prev.slice(0, depth + 1));
  };

  const seg = (path: string) => path.split("\\").filter(Boolean).pop() ?? path;

  return (
    <div className="space-y-6 p-6">
      <section className="flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-panel p-4">
        <nav
          aria-label="Location"
          className="flex min-w-0 basis-full items-center gap-0.5 text-[13px]"
        >
          <button
            onClick={pop}
            disabled={crumbs.length === 0}
            title="Back one level"
            aria-label="Back one level"
            className="mr-1 rounded-md p-1.5 text-mut transition-colors hover:bg-raise hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-mut"
          >
            <IconBack size={15} />
          </button>
          {crumbs.length === 0 ? (
            <span aria-current="location" className="rounded-md px-2 py-1 font-semibold text-fg">
              {driveRoot}
            </span>
          ) : (
            <button
              onClick={() => goTo(-1)}
              className="rounded-md px-2 py-1 font-medium text-mut transition-colors hover:bg-raise hover:text-fg"
            >
              {driveRoot}
            </button>
          )}
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={c} className="flex min-w-0 items-center">
                <IconChevron size={13} className="mx-0.5 shrink-0 text-mut/40" />
                {last ? (
                  <span
                    aria-current="location"
                    className="truncate rounded-md px-2 py-1 font-semibold text-fg"
                  >
                    {seg(c)}
                  </span>
                ) : (
                  <button
                    onClick={() => goTo(i)}
                    className="truncate rounded-md px-2 py-1 font-medium text-mut transition-colors hover:bg-raise hover:text-fg"
                  >
                    {seg(c)}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
        <label className="flex flex-col gap-1 text-[12px] text-mut">
          Scan target
          <AppSelect
            value={driveRoot}
            options={disks.map((d) => ({
              value: d.mount,
              label: d.mount,
              hint: `${formatBytes(d.availBytes)} free`,
            }))}
            onChange={(v) => {
              setRoot(v);
              setCrumbs([]);
            }}
            ariaLabel="Scan target"
          />
        </label>
        <button
          onClick={() => run(scanRoot)}
          disabled={scanning || !scanRoot}
          className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-[13px] font-semibold text-ink transition-opacity disabled:opacity-40"
        >
          <IconScan size={14} />
          {scanning ? "Scanning…" : "Scan"}
        </button>
        {scanning ? (
          <span className="text-[12px] text-mut">
            {progress
              ? `${progress.entries.toLocaleString()} files · ${formatBytes(progress.bytes)} read…`
              : "walking directory tree…"}
          </span>
        ) : result ? (
          <>
            <span className="text-[12px] text-mut">
              {formatBytes(result.totalBytes)} across {result.entries.toLocaleString()} files in{" "}
              {formatDurationMs(result.durationMs)}
              {result.errors > 0 ? ` · ${result.errors} unreadable` : ""}
            </span>
            {savedAt !== null ? (
              <span
                className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] text-accent"
                title="Restored from the last saved scan — hit Scan for a fresh walk"
              >
                saved {formatAgo(savedAt, Date.now())}
              </span>
            ) : null}
          </>
        ) : null}
        {error ? <span className="text-[12px] text-bad">{error}</span> : null}
        {scanning ? (
          <div
            className="h-1 w-full basis-full overflow-hidden rounded-full bg-raise"
            role="progressbar"
            aria-label="Scanning"
          >
            <div className="u-indeterminate h-full w-2/5 rounded-full bg-accent" />
          </div>
        ) : null}
      </section>

      {result ? (
        <>
          <section className="rounded-xl border border-edge bg-panel">
            <h2 className="border-b border-edge px-4 py-3 text-[13px] font-semibold text-mut">
              TREEMAP <span className="font-normal text-mut/70">— click a folder to drill in</span>
            </h2>
            <div className="p-3">
              <Treemap children={result.children} onDrill={drill} />
            </div>
          </section>

          <section className="rounded-xl border border-edge bg-panel">
            <h2 className="border-b border-edge px-4 py-3 text-[13px] font-semibold text-mut">
              TOP LEVEL
            </h2>
            <ul className="px-4 py-3">
              {result.children.slice(0, 30).map((c) => (
                <li key={c.path} className="flex items-center gap-3 py-1">
                  <button
                    className={`flex w-56 items-center gap-1.5 truncate text-left font-mono text-[12.5px] ${c.isDir ? "text-fg hover:text-accent" : "text-mut"}`}
                    title={c.isDir ? `${c.path} — click to drill in` : c.path}
                    onClick={() => c.isDir && drill(c)}
                  >
                    {c.isDir ? (
                      <IconFolder size={13} className="shrink-0 text-accent/80" />
                    ) : (
                      <IconFile size={13} className="shrink-0 text-mut/60" />
                    )}
                    <span className="truncate">{c.name}</span>
                  </button>
                  <div className="h-4 flex-1 overflow-hidden rounded bg-raise">
                    <div
                      className={`h-full rounded ${c.hasCache ? "bg-cache/70" : "bg-accent/80"}`}
                      style={{ width: `${(c.bytes / maxChild) * 100}%` }}
                    />
                  </div>
                  <span className="w-20 text-right text-[12.5px] font-medium tabular-nums">
                    {formatBytes(c.bytes)}
                  </span>
                  <span className="w-14 text-right text-[11px] tabular-nums text-mut">
                    {formatPercent(c.bytes, result.totalBytes)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-edge bg-panel">
            <h2 className="border-b border-edge px-4 py-3 text-[13px] font-semibold text-mut">
              DEV BLOAT — rebuildable caches{" "}
              <span className="font-normal text-cache">
                {formatBytes(result.devCaches.reduce((s, c) => s + c.bytes, 0))} reclaimable
              </span>
            </h2>
            {result.devCaches.length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-mut">No dev caches found under this root.</p>
            ) : (
              <ul className="divide-y divide-edge/60 px-4">
                {result.devCaches.slice(0, 50).map((c) => {
                  const isFile = c.kind === "wsl-disk"; // disk images are files, not drillable
                  return (
                    <li key={c.path} className="flex items-center gap-3 py-1.5">
                      <span className="rounded bg-cache/15 px-1.5 py-0.5 text-[10.5px] font-medium text-cache">
                        {KIND_LABEL[c.kind] ?? c.kind}
                      </span>
                      {isFile ? (
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg/85"
                          title={c.path}
                        >
                          {c.path}
                        </span>
                      ) : (
                        <button
                          className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-fg/85 hover:text-accent"
                          title={`${c.path} — click to scan inside`}
                          onClick={() =>
                            drill({
                              name: c.path,
                              path: c.path,
                              bytes: c.bytes,
                              isDir: true,
                              hasCache: true,
                            })
                          }
                        >
                          {c.path}
                        </button>
                      )}
                      <span className="text-[12.5px] font-medium tabular-nums">
                        {formatBytes(c.bytes)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      ) : (
        <p className="px-1 text-[13px] text-mut">
          Pick a drive and scan — rebuildable dev caches are tagged separately from real assets.
        </p>
      )}
    </div>
  );
}
