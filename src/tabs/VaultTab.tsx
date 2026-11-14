import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { api, type AppCaps, type VaultEntry } from "../api";
import { Section } from "../components/Section";
import { formatCountdown } from "../format";
import * as pro from "../pro-sections";

const PRO_URL = "https://cairn.supastack.dev";

/** Locked-feature card shown in free builds — the upgrade funnel. */
function ProGate({ title, points }: { title: string; points: string[] }) {
  return (
    <section className="rounded-xl border border-dashed border-accent/40 bg-accent/[0.04]">
      <div className="flex items-center justify-between gap-3 border-b border-accent/20 px-4 py-3">
        <h2 className="text-[13px] font-semibold text-fg">
          {title}{" "}
          <span className="ml-1 rounded bg-accent/15 px-1.5 py-0.5 align-middle text-[10.5px] font-semibold tracking-wide text-accent">
            PRO
          </span>
        </h2>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 p-4">
        <ul className="space-y-1.5 text-[12.5px] leading-relaxed text-mut">
          {points.map((p) => (
            <li key={p}>· {p}</li>
          ))}
        </ul>
        <button
          className="shrink-0 rounded-md bg-accent px-4 py-2 text-[13px] font-semibold text-ink transition-opacity hover:opacity-90"
          onClick={() => void api.openUrl(PRO_URL).catch(() => {})}
        >
          Get Cairn Pro
        </button>
      </div>
    </section>
  );
}

export function VaultTab() {
  const [caps, setCaps] = useState<AppCaps | null>(null);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // While caps load we render as free — never flash Pro UI in a free build.
  // The barrel resolves to real components only when vault-pro/ sources
  // exist (Pro build in the private repo); the OSS export stubs them to null.
  const WatchdogSection = pro.WatchdogSection;
  const BackupSection = pro.BackupSection;
  const showPro = caps?.pro === true;

  const refresh = useCallback(() => {
    api
      .vaultList()
      .then(setEntries)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void api
      .appCaps()
      .then(setCaps)
      .catch(() => {});
    api
      .autostartEnabled()
      .then(setAutostart)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      setNow(Date.now());
      refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const addPath = async () => {
    const p = pathInput.trim();
    if (!p) return;
    setEntries(await api.vaultAdd(p));
    setPathInput("");
  };

  const browse = async () => {
    const picked = await open({ directory: true, title: "Folder to protect" });
    if (typeof picked === "string") setEntries(await api.vaultAdd(picked));
  };

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <Section
        title="ASSET VAULT — deny-delete ACL"
        hint={
          caps?.vaultLimit != null
            ? `Locked folders refuse deletion at the NTFS level — free tier protects up to ${caps.vaultLimit}.`
            : "Locked folders refuse deletion at the NTFS level — for Explorer, scripts, WSL and runaway tools alike."
        }
        action={
          <button
            className="rounded-md border border-bad/50 bg-bad/10 px-3 py-1.5 text-[12.5px] font-semibold text-bad hover:bg-bad/20 disabled:opacity-40"
            disabled={entries.length === 0 || busy === "lockall"}
            onClick={() => void act("lockall", async () => setEntries(await api.vaultLockAll()))}
            title="Lock every vault folder right now"
          >
            Lock all now
          </button>
        }
      >
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-edge bg-raise px-3 py-2 font-mono text-[12.5px] text-fg placeholder:text-mut/60"
            placeholder="D:\path\to\assets"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addPath()}
          />
          <button
            className="rounded-md border border-edge bg-raise px-3 py-2 text-[13px] hover:text-fg"
            onClick={() => void browse()}
          >
            Browse…
          </button>
          <button
            className="rounded-md bg-accent px-4 py-2 text-[13px] font-semibold text-ink disabled:opacity-40"
            disabled={
              !pathInput.trim() || (caps?.vaultLimit != null && entries.length >= caps.vaultLimit)
            }
            title={
              caps?.vaultLimit != null && entries.length >= caps.vaultLimit
                ? `Free tier protects ${caps.vaultLimit} folders — Cairn Pro removes the limit`
                : undefined
            }
            onClick={() => void addPath()}
          >
            Protect
          </button>
        </div>
        {caps?.vaultLimit != null ? (
          <p className="mt-1.5 text-[11.5px] text-mut/80">
            {entries.length}/{caps.vaultLimit} folders used{" "}
            {entries.length >= caps.vaultLimit ? (
              <>
                —{" "}
                <button
                  className="text-accent hover:underline"
                  onClick={() => void api.openUrl(PRO_URL).catch(() => {})}
                >
                  Pro removes the limit
                </button>
              </>
            ) : null}
          </p>
        ) : null}

        <ul className="mt-3 space-y-2">
          {entries.length === 0 ? (
            <li className="text-[13px] text-mut">No protected folders yet.</li>
          ) : (
            entries.map((e) => {
              const countdown = formatCountdown(e.unlockAt, now);
              return (
                <li
                  key={e.path}
                  className="flex items-center gap-3 rounded-lg border border-edge bg-raise/60 px-3 py-2"
                >
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums ${
                      e.locked ? "bg-good/15 text-good" : "bg-accent/15 text-accent"
                    }`}
                  >
                    {e.locked ? "LOCKED" : countdown ? `OPEN ${countdown}` : "UNLOCKED"}
                  </span>
                  <button
                    className="min-w-0 flex-1 truncate text-left font-mono text-[12px] hover:text-accent"
                    title={`${e.path} — open in Explorer`}
                    onClick={() => void api.vaultOpen(e.path).catch(() => {})}
                  >
                    {e.path}
                  </button>
                  {e.locked ? (
                    <button
                      className="rounded px-2 py-1 text-[12px] text-mut hover:bg-edge hover:text-fg disabled:opacity-40"
                      disabled={busy === e.path}
                      onClick={() => void act(e.path, () => api.vaultUnlock(e.path, 5))}
                    >
                      {showPro ? "Unlock 5 min" : "Unlock"}
                    </button>
                  ) : (
                    <button
                      className="rounded px-2 py-1 text-[12px] text-mut hover:bg-edge hover:text-fg disabled:opacity-40"
                      disabled={busy === e.path}
                      onClick={() => void act(e.path, () => api.vaultLock(e.path))}
                    >
                      Lock now
                    </button>
                  )}
                  <button
                    className="rounded px-2 py-1 text-[12px] text-mut hover:bg-bad/20 hover:text-bad disabled:opacity-40"
                    disabled={busy === e.path}
                    onClick={() =>
                      void act(e.path, async () => {
                        if (e.locked) await api.vaultUnlock(e.path, 5);
                        setEntries(await api.vaultRemove(e.path));
                      })
                    }
                    title="Remove from vault (unlocks first if locked)"
                  >
                    Remove
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </Section>

      {showPro && WatchdogSection ? (
        <WatchdogSection />
      ) : (
        <ProGate
          title="DELETE WATCHDOG — kill switch"
          points={[
            "Trips when a watched root loses 20+ files inside 3 seconds.",
            "Posts a system alert, re-locks every vault folder instantly.",
            "Suspends the runaway script before it can finish emptying the drive.",
          ]}
        />
      )}

      {showPro && BackupSection ? (
        <BackupSection />
      ) : (
        <ProGate
          title="CLOUD BACKUP — BYOC one-way"
          points={[
            "Copy-only sync to your own Google Drive / OneDrive / S3 / R2 / USB drive.",
            "Never mirrors deletions to the cloud — replaced files archive under a dated folder.",
            "Bring Your Own Cloud: your storage, your account, zero servers on our side.",
          ]}
        />
      )}

      <Section title="SYSTEM" hint="Watchdog and vault re-locks only run while Cairn is running.">
        <label className="flex cursor-pointer items-center gap-3 text-[13px]">
          <input
            type="checkbox"
            className="accent-accent h-4 w-4"
            checked={autostart ?? false}
            disabled={autostart === null || busy === "as"}
            onChange={(e) =>
              void act("as", async () => setAutostart(await api.autostartSet(e.target.checked)))
            }
          />
          Launch Cairn when I sign in to Windows
        </label>
      </Section>
    </div>
  );
}
