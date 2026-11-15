import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";
import { AppSelect } from "../components/AppSelect";
import { Section } from "../components/Section";
import { getLang, LANGS, setLang, t, type Lang } from "../i18n";
import { getThemePref, setTheme, type ThemePref } from "../theme";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "downloading" }
  | { kind: "restart" }
  | { kind: "error" };

export function SettingsTab({ onLang }: { onLang: () => void }) {
  const [theme, setThemeState] = useState<ThemePref>(() => getThemePref());
  const [lang, setLangState] = useState<Lang>(() => getLang());
  const [version, setVersion] = useState("…");
  const [upd, setUpd] = useState<UpdateState>({ kind: "idle" });

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion("?"));
    // Quiet background check on open — the button forces a loud one.
    void runCheck(true);
  }, []);

  const runCheck = async (quiet = false) => {
    if (!quiet) setUpd({ kind: "checking" });
    try {
      const update = await check();
      if (!update) {
        setUpd({ kind: "uptodate" });
        return;
      }
      setUpd({ kind: "downloading" });
      await update.downloadAndInstall();
      setUpd({ kind: "restart" });
    } catch {
      if (!quiet) setUpd({ kind: "error" });
    }
  };

  return (
    <div className="max-w-2xl space-y-6 p-6">
      <Section title={t("settings.appearance")}>
        <label className="flex items-center justify-between gap-4 text-[13px]">
          <span>{t("settings.theme")}</span>
          <AppSelect
            value={theme}
            options={[
              { value: "system", label: t("settings.theme.system") },
              { value: "dark", label: t("settings.theme.dark") },
              { value: "light", label: t("settings.theme.light") },
            ]}
            onChange={(v) => {
              const pref = v as ThemePref;
              setTheme(pref);
              setThemeState(pref);
            }}
            ariaLabel={t("settings.theme")}
            minWidth={180}
          />
        </label>
      </Section>

      <Section title={t("settings.language")}>
        <label className="flex items-center justify-between gap-4 text-[13px]">
          <span>{t("settings.language.label")}</span>
          <AppSelect
            value={lang}
            options={LANGS.map((l) => ({ value: l.id, label: l.label }))}
            onChange={(v) => {
              const l = v as Lang;
              setLang(l);
              setLangState(l);
              onLang();
            }}
            ariaLabel={t("settings.language.label")}
            minWidth={180}
          />
        </label>
      </Section>

      <Section title={t("settings.updates")}>
        <div className="flex items-center justify-between gap-4 text-[13px]">
          <span>
            {t("settings.version")}{" "}
            <span className="font-mono text-[12.5px] text-mut">v{version}</span>
          </span>
          {upd.kind === "restart" ? (
            <button
              className="rounded-md bg-accent px-4 py-2 text-[13px] font-semibold text-ink transition-opacity hover:opacity-90"
              onClick={() => void relaunch()}
            >
              {t("settings.restart")}
            </button>
          ) : (
            <button
              className="rounded-md border border-edge bg-raise px-4 py-2 text-[13px] font-semibold text-fg hover:bg-edge disabled:opacity-40"
              disabled={upd.kind === "checking" || upd.kind === "downloading"}
              onClick={() => void runCheck()}
            >
              {upd.kind === "checking" || upd.kind === "downloading"
                ? t("settings.checking")
                : t("settings.check")}
            </button>
          )}
        </div>
        {upd.kind === "uptodate" ? (
          <p className="mt-2 text-[12px] text-good">{t("settings.uptodate")}</p>
        ) : upd.kind === "downloading" ? (
          <p className="mt-2 text-[12px] text-mut">{t("settings.downloading")}</p>
        ) : upd.kind === "error" ? (
          <p className="mt-2 text-[12px] text-bad">{t("settings.updateError")}</p>
        ) : null}
      </Section>

      <Section title={t("settings.about")}>
        <p className="text-[12.5px] leading-relaxed text-mut">{t("settings.aboutText")}</p>
      </Section>
    </div>
  );
}
