import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type KillOutcome, type LocalhostProcess, type SystemSnapshot } from "../api";
import { areaPath, linePath, sparkPoints } from "../chart";
import { formatBytes, formatPercent } from "../format";
import { t } from "../i18n";

function Meter({ pct, tone }: { pct: number; tone: "accent" | "bad" | "cache" }) {
  const color = tone === "bad" ? "bg-bad" : tone === "cache" ? "bg-cache" : "bg-accent";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-raise">
      <div
        className={`h-full rounded-full ${color} transition-[width] duration-700`}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

function uptimeHuman(secs: number): string {
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const CHART_W = 640;
const CHART_H = 96;

/** Live RAM (amber area) + swap (blue line) history — ~4 min window. */
function HistoryChart({ ram, swap }: { ram: number[]; swap: number[] }) {
  const { ramArea, ramLine, swapLine } = useMemo(() => {
    const r = sparkPoints(ram, CHART_W, CHART_H);
    const s = sparkPoints(swap, CHART_W, CHART_H);
    return {
      ramArea: areaPath(r, CHART_H),
      ramLine: linePath(r),
      swapLine: linePath(s),
    };
  }, [ram, swap]);

  if (ram.length < 2) return null;
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      className="mt-3 block h-24 w-full"
      role="img"
      aria-label={t("radar.chartAria")}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="ramFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.38" />
          <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* gridlines at 25/50/75% */}
      {[25, 50, 75].map((t) => (
        <line
          key={t}
          x1="0"
          x2={CHART_W}
          y1={(t / 100) * (CHART_H - 4) + 2}
          y2={(t / 100) * (CHART_H - 4) + 2}
          stroke="var(--color-edge)"
          strokeWidth="1"
          strokeDasharray="2 6"
        />
      ))}
      <path d={ramArea} fill="url(#ramFill)" />
      <path d={ramLine} fill="none" stroke="var(--color-accent)" strokeWidth="1.8" />
      <path
        d={swapLine}
        fill="none"
        stroke="var(--color-cache)"
        strokeWidth="1.4"
        strokeDasharray="4 3"
        opacity="0.85"
      />
    </svg>
  );
}

function useTransientNote() {
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const showNote = useCallback((message: string) => {
    clearTimeout(timer.current);
    setNote(message);
    timer.current = setTimeout(() => setNote(null), 6000);
  }, []);

  return [note, showNote] as const;
}

function LocalhostPanel({ kill }: { kill: (pids: number[]) => Promise<string> }) {
  const [rows, setRows] = useState<LocalhostProcess[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [endingPids, setEndingPids] = useState<number[]>([]);
  const [note, showNote] = useTransientNote();

  const refresh = useCallback(async () => {
    try {
      setRows(await api.localhostProcesses());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  const endOne = (proc: LocalhostProcess) => {
    if (proc.critical || endingPids.includes(proc.pid)) return;
    setEndingPids((pids) => [...pids, proc.pid]);
    void kill([proc.pid])
      .then(showNote)
      .finally(() => {
        setEndingPids((pids) => pids.filter((pid) => pid !== proc.pid));
        void refresh();
      });
  };

  return (
    <section className="rounded-xl border border-edge bg-panel">
      <div className="flex items-baseline justify-between gap-4 border-b border-edge px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-mut">{t("radar.localhostHeader")}</h2>
          <p className="mt-0.5 truncate text-[12px] text-mut/80">{t("radar.localhostHint")}</p>
        </div>
        <span className="shrink-0 text-[12px] text-mut">
          {note ? <span className="mr-3 text-accent">{note}</span> : null}
          {rows ? t("radar.localhostCount", { n: rows.length }) : null}
        </span>
      </div>

      {rows === null ? (
        <div className="px-4 py-5 text-[13px] text-mut">
          {loadFailed ? t("radar.localhostError") : t("radar.localhostLoading")}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-5 text-[13px] text-mut">{t("radar.localhostEmpty")}</div>
      ) : (
        <div className="divide-y divide-edge/60">
          {rows.map((p) => {
            const ending = endingPids.includes(p.pid);
            const detail = p.cwd || p.summary;
            const showSummary = p.summary.toLowerCase() !== p.name.toLowerCase();
            return (
              <div key={p.pid} className="flex items-center gap-3 px-4 py-2.5 hover:bg-raise/50">
                <div className="flex w-24 shrink-0 flex-wrap gap-1">
                  {p.ports.length > 0 ? (
                    <>
                      {p.ports.slice(0, 4).map((port) => (
                        <span
                          key={port}
                          className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent tabular-nums"
                        >
                          :{port}
                        </span>
                      ))}
                      {p.ports.length > 4 ? (
                        <span className="px-0.5 text-[11px] text-mut">+{p.ports.length - 4}</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="rounded bg-raise px-1.5 py-0.5 text-[11px] text-mut">
                      {t("radar.noPort")}
                    </span>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-[12.5px]">{p.name}</span>
                    <span className="shrink-0 text-[11px] text-mut tabular-nums">PID {p.pid}</span>
                    {p.isNode ? (
                      <span className="shrink-0 rounded bg-cache/10 px-1.5 py-0.5 text-[10px] font-medium text-cache">
                        {t("radar.nodeBadge")}
                      </span>
                    ) : null}
                    {p.critical ? (
                      <span className="shrink-0 rounded bg-bad/10 px-1.5 py-0.5 text-[10px] font-medium text-bad">
                        {t("radar.systemBadge")}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-mut" title={detail}>
                    {detail}
                  </div>
                  {p.cwd && showSummary ? (
                    <div
                      className="mt-0.5 truncate font-mono text-[10.5px] text-mut/70"
                      title={p.summary}
                    >
                      {p.summary}
                    </div>
                  ) : null}
                </div>

                <div className="hidden w-12 shrink-0 text-right text-[11px] text-mut tabular-nums sm:block">
                  {p.cpuPct > 0.4 ? `${p.cpuPct.toFixed(0)}%` : "--"}
                </div>
                <div className="hidden w-20 shrink-0 text-right font-medium tabular-nums md:block">
                  {formatBytes(p.memoryBytes)}
                </div>
                <button
                  className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${
                    p.critical
                      ? "cursor-not-allowed text-mut/40"
                      : "text-mut hover:bg-bad/20 hover:text-bad disabled:text-mut/40"
                  }`}
                  title={
                    p.critical
                      ? t("radar.systemProcessTitle")
                      : t("radar.killOneTitle", { name: p.name, pid: p.pid })
                  }
                  aria-label={
                    p.critical
                      ? t("radar.systemProcessTitle")
                      : t("radar.killOneTitle", { name: p.name, pid: p.pid })
                  }
                  disabled={p.critical || ending}
                  onClick={() => endOne(p)}
                >
                  {ending ? t("radar.ending") : t("radar.killLower")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function RadarTab({
  snap,
  history,
  onKill,
}: {
  snap: SystemSnapshot | null;
  history: { ram: number[]; swap: number[] };
  onKill: (pids: number[]) => Promise<KillOutcome>;
}) {
  const [note, showNote] = useTransientNote();

  const kill = useCallback(
    async (pids: number[]) => {
      try {
        const out = await onKill(pids);
        return out.refused > 0
          ? t("radar.killedWithRefused", { killed: out.killed, refused: out.refused })
          : t("radar.killed", { killed: out.killed });
      } catch {
        return t("radar.killFailed");
      }
    },
    [onKill],
  );

  const killWithNote = (pids: number[]) => {
    void kill(pids).then(showNote);
  };

  if (!snap) {
    return <div className="p-8 text-mut">{t("radar.reading")}</div>;
  }

  const ramPct = (snap.usedMemory / Math.max(1, snap.totalMemory)) * 100;
  const swapPct = (snap.usedSwap / Math.max(1, snap.totalSwap)) * 100;
  const processes = snap.processes.slice(0, 40);
  const maxProcMem = processes[0]?.memoryBytes ?? 1;

  return (
    <div className="space-y-6 p-6">
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-edge bg-panel p-4 md:col-span-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold text-mut">{t("radar.memory")}</h2>
            <span className="text-[12px] text-mut">
              {t("radar.uptime", { n: uptimeHuman(snap.uptimeSecs) })}
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums tracking-tight">
              {formatPercent(snap.usedMemory, snap.totalMemory)}
            </span>
            <span className="text-[13px] text-mut">
              {t("radar.ofTotal", {
                used: formatBytes(snap.usedMemory),
                total: formatBytes(snap.totalMemory),
              })}
            </span>
          </div>
          <div className="mt-3">
            <Meter pct={ramPct} tone={ramPct > 90 ? "bad" : "accent"} />
          </div>
          <div className="mt-1.5 flex justify-between text-[12px] text-mut">
            <span>{t("radar.available", { n: formatBytes(snap.availMemory) })}</span>
            <span>
              {t("radar.swapLabel", {
                used: formatBytes(snap.usedSwap),
                total: formatBytes(snap.totalSwap),
              })}
            </span>
          </div>
          <div className="mt-2">
            <Meter pct={swapPct} tone="cache" />
          </div>
          <HistoryChart ram={history.ram} swap={history.swap} />
          <div className="mt-1 flex items-center gap-4 text-[10.5px] text-mut">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-3 rounded-full bg-accent" /> {t("radar.ramWindow")}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-3 rounded-full bg-cache" /> {t("radar.swapLegend")}
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-edge bg-panel p-4">
          <h2 className="text-[13px] font-semibold text-mut">{t("radar.drives")}</h2>
          <ul className="mt-3 space-y-3">
            {snap.disks.map((d) => {
              const used = d.totalBytes - d.availBytes;
              const pct = (used / Math.max(1, d.totalBytes)) * 100;
              return (
                <li key={d.mount}>
                  <div className="flex justify-between text-[12px]">
                    <span className="font-medium">
                      {d.mount} <span className="text-mut">{d.name || d.fs}</span>
                    </span>
                    <span className="text-mut tabular-nums">
                      {t("radar.driveFree", { n: formatBytes(d.availBytes) })}
                    </span>
                  </div>
                  <div className="mt-1">
                    <Meter pct={pct} tone={pct > 90 ? "bad" : "cache"} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <LocalhostPanel kill={kill} />

      <section className="rounded-xl border border-edge bg-panel">
        <div className="flex items-baseline justify-between border-b border-edge px-4 py-3">
          <h2 className="text-[13px] font-semibold text-mut">{t("radar.processesHeader")}</h2>
          <span className="text-[12px] text-mut">
            {note ? <span className="mr-3 text-accent">{note}</span> : null}
            {t("radar.groupsCount", { n: snap.processes.length })}
          </span>
        </div>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-mut">
              <th className="px-4 py-2 font-medium">{t("radar.colProcess")}</th>
              <th className="w-16 px-4 py-2 text-right font-medium">{t("radar.colCount")}</th>
              <th className="w-20 px-4 py-2 text-right font-medium">{t("radar.colCpu")}</th>
              <th className="w-28 px-4 py-2 text-right font-medium">{t("radar.colMemory")}</th>
              <th className="w-16 px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {processes.map((p) => (
              <tr key={p.name} className="border-t border-edge/60 hover:bg-raise/50">
                <td className="px-4 py-1.5 font-mono text-[12.5px]">{p.name}</td>
                <td className="px-4 py-1.5 text-right text-mut">×{p.count}</td>
                <td className="px-4 py-1.5 text-right">
                  {p.cpuPct > 0.4 ? (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                        p.cpuPct > 25 ? "bg-bad/15 text-bad" : "bg-accent/10 text-accent"
                      }`}
                    >
                      {p.cpuPct.toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-[11px] text-mut/60">--</span>
                  )}
                </td>
                <td className="px-4 py-1.5 text-right font-medium">
                  <span className="relative inline-block min-w-16 rounded bg-raise/70 px-1.5 py-0.5">
                    <span
                      className="absolute inset-y-0 left-0 rounded bg-accent/15 transition-[width] duration-500"
                      style={{ width: `${(p.memoryBytes / maxProcMem) * 100}%` }}
                    />
                    <span className="relative tabular-nums">{formatBytes(p.memoryBytes)}</span>
                  </span>
                </td>
                <td className="px-4 py-1.5 text-right">
                  <button
                    className="rounded px-2 py-0.5 text-[11px] text-mut hover:bg-bad/20 hover:text-bad"
                    title={t("radar.killTitle", { count: p.count, name: p.name })}
                    aria-label={t("radar.killTitle", { count: p.count, name: p.name })}
                    onClick={() => killWithNote(p.pids)}
                  >
                    {t("radar.killLower")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
