import { useCallback, useEffect, useState } from "react";
import { api, onDeleteBurst, type DeleteBurst, type SystemSnapshot } from "./api";
import { formatBytes, formatPercent } from "./format";
import { getTheme, setTheme, type Theme } from "./theme";
import { DiskTab } from "./tabs/DiskTab";
import { RadarTab } from "./tabs/RadarTab";
import { VaultTab } from "./tabs/VaultTab";

type Tab = "radar" | "disk" | "vault";

const TABS: { id: Tab; label: string }[] = [
  { id: "radar", label: "Memory & Processes" },
  { id: "disk", label: "Disk & Dev Bloat" },
  { id: "vault", label: "Vault & Backup" },
];

const HISTORY_LEN = 60; // ~4 min at the 4 s poll

function CairnMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 48 48" aria-hidden className="shrink-0">
      <rect
        x="1.5"
        y="1.5"
        width="45"
        height="45"
        rx="11"
        fill="#F2F5FA"
        stroke="#0d1420"
        strokeOpacity="0.14"
      />
      <rect x="14" y="8.5" width="20" height="8.5" rx="4" fill="#f4a940" />
      <rect x="10.5" y="18" width="27" height="8.5" rx="4" fill="#5480ee" />
      <rect x="7" y="27.5" width="34" height="10" rx="4.5" fill="#2ec98b" />
    </svg>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("radar");
  const [snap, setSnap] = useState<SystemSnapshot | null>(null);
  const [burst, setBurst] = useState<DeleteBurst | null>(null);
  const [history, setHistory] = useState<{ ram: number[]; swap: number[] }>({
    ram: [],
    swap: [],
  });
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  useEffect(() => {
    let dead = false;
    const tick = () => {
      void api
        .systemSnapshot()
        .then((s) => {
          if (dead) return;
          setSnap(s);
          setHistory((h) => ({
            ram: [...h.ram, (s.usedMemory / Math.max(1, s.totalMemory)) * 100].slice(-HISTORY_LEN),
            swap: [...h.swap, (s.usedSwap / Math.max(1, s.totalSwap)) * 100].slice(-HISTORY_LEN),
          }));
        })
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const unlisten = onDeleteBurst(setBurst);
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!burst) return;
    const t = setTimeout(() => setBurst(null), 30_000);
    return () => clearTimeout(t);
  }, [burst]);

  const onKill = useCallback(async (pids: number[]) => {
    const out = await api.killProcesses(pids);
    try {
      setSnap(await api.systemSnapshot());
    } catch {
      // snapshot refresh is best-effort; the kill outcome is already known
    }
    return out;
  }, []);

  const ramPct = snap ? formatPercent(snap.usedMemory, snap.totalMemory) : "—";
  const mainDisk = snap?.disks.find((d) => d.mount === "D:\\") ?? snap?.disks[0];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge bg-panel px-5 py-3">
        <CairnMark />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-tight">Cairn</div>
          <div className="text-[11px] text-mut">memory · disk · asset vault</div>
        </div>
        <nav className="ml-6 flex gap-1" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              data-tab={t.id}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                const i = TABS.findIndex((x) => x.id === tab);
                const next =
                  TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
                setTab(next.id);
                e.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)
                  ?.focus();
              }}
              className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                tab === t.id
                  ? "bg-raise text-fg shadow-[inset_0_0_0_1px_var(--color-edge)]"
                  : "text-mut hover:text-fg"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-[12px] text-mut">
          <span>
            RAM <span className="font-semibold tabular-nums text-fg">{ramPct}</span>
          </span>
          {mainDisk ? (
            <span>
              {mainDisk.mount}{" "}
              <span className="font-semibold tabular-nums text-fg">
                {formatBytes(mainDisk.availBytes)}
              </span>{" "}
              free
            </span>
          ) : null}
          <button
            className="rounded-md border border-edge bg-raise p-1.5 text-mut transition-colors hover:text-fg"
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label="Toggle theme"
            onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              setTheme(next);
              setThemeState(next);
            }}
          >
            {theme === "dark" ? (
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
                <circle cx="8" cy="8" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M8 1.2v1.8M8 13v1.8M1.2 8H3M13 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M3.2 12.8l1.3-1.3M11.5 4.5l1.3-1.3"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
                <path
                  d="M13.5 9.8A6 6 0 0 1 6.2 2.5a6 6 0 1 0 7.3 7.3Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>
      </header>

      {burst ? (
        <div className="u-banner-in flex items-center gap-3 border-b border-bad/40 bg-bad/15 px-5 py-2.5 text-[13px]">
          <span className="font-semibold text-bad">Delete burst detected</span>
          <span className="text-fg/80">
            {burst.count} files removed inside {burst.windowSecs}s — vault folders were re-locked.
          </span>
          <button className="ml-auto text-mut hover:text-fg" onClick={() => setBurst(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="u-tab-in" key={tab}>
          {tab === "radar" ? <RadarTab snap={snap} history={history} onKill={onKill} /> : null}
          {tab === "disk" ? <DiskTab disks={snap?.disks ?? []} /> : null}
          {tab === "vault" ? <VaultTab /> : null}
        </div>
      </main>
    </div>
  );
}
