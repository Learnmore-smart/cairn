import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { api, type AppCaps, type VaultEntry } from "../api";
import { Section } from "../components/Section";
import { formatCountdown } from "../format";
import { t } from "../i18n";
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
          {t("progate.getPro")}
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
    const picked = await open({ directory: true, title: t("vault.browseTitle") });
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
        title={t("vault.title")}
        hint={
          caps?.vaultLimit != null
            ? t("vault.limitHint", { n: caps.vaultLimit })
            : t("vault.hint")
        }
        action={
          <button
            className="rounded-md border border-bad/50 bg-bad/10 px-3 py-1.5 text-[12.5px] font-semibold text-bad hover:bg-bad/20 disabled:opacity-40"
            disabled={entries.length === 0 || busy === "lockall"}
            onClick={() => void act("lockall", async () => setEntries(await api.vaultLockAll()))}
            title={t("vault.lockAllTitle")}
          >
            {t("vault.lockAll")}
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
            {t("vault.browse")}
          </button>
          <button
            className="rounded-md bg-accent px-4 py-2 text-[13px] font-semibold text-ink disabled:opacity-40"
            disabled={
              !pathInput.trim() || (caps?.vaultLimit != null && entries.length >= caps.vaultLimit)
            }
            title={
              caps?.vaultLimit != null && entries.length >= caps.vaultLimit
                ? t("vault.limitTooltip", { n: caps.vaultLimit })
                : undefined
            }
            onClick={() => void addPath()}
          >
            {t("vault.protect")}
          </button>
        </div>
        {caps?.vaultLimit != null ? (
          <p className="mt-1.5 text-[11.5px] text-mut/80">
            {t("vault.used", { a: entries.length, n: caps.vaultLimit })}{" "}
            {entries.length >= caps.vaultLimit ? (
              <>
                ·{" "}
                <button
                  className="text-accent hover:underline"
                  onClick={() => void api.openUrl(PRO_URL).catch(() => {})}
                >
                  {t("vault.upgradeLink")}
                </button>
              </>
            ) : null}
          </p>
        ) : null}

        <ul className="mt-3 space-y-2">
          {entries.length === 0 ? (
            <li className="text-[13px] text-mut">{t("vault.empty")}</li>
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
                    {e.locked
                      ? t("vault.locked")
                      : countdown
                        ? t("vault.openCountdown", { n: countdown })
                        : t("vault.unlocked")}
                  </span>
                  <button
                    className="min-w-0 flex-1 truncate text-left font-mono text-[12px] hover:text-accent"
                    title={t("vault.openExplorer", { path: e.path })}
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
                      {showPro ? t("vault.unlock5") : t("vault.unlock")}
                    </button>
                  ) : (
                    <button
                      className="rounded px-2 py-1 text-[12px] text-mut hover:bg-edge hover:text-fg disabled:opacity-40"
                      disabled={busy === e.path}
                      onClick={() => void act(e.path, () => api.vaultLock(e.path))}
                    >
                      {t("vault.lockNow")}
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
                    title={t("vault.removeTitle")}
                  >
                    {t("vault.remove")}
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
          title={t("vault.watchdogProTitle")}
          points={[t("vault.watchdogProP1"), t("vault.watchdogProP2"), t("vault.watchdogProP3")]}
        />
      )}

      {showPro && BackupSection ? (
        <BackupSection />
      ) : (
        <ProGate
          title={t("vault.backupProTitle")}
          points={[t("vault.backupProP1"), t("vault.backupProP2"), t("vault.backupProP3")]}
        />
      )}

      <Section title={t("vault.system")} hint={t("vault.systemHint")}>
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
          {t("vault.autostart")}
        </label>
      </Section>
    </div>
  );
}
