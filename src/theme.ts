export type Theme = "dark" | "light";
export type ThemePref = Theme | "system";

const KEY = "cairn-theme";

export function getTheme(): Theme {
  const attr = document.documentElement.dataset["theme"];
  if (attr === "light" || attr === "dark") return attr;
  return "dark";
}

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* webview storage guard */
  }
  return "system";
}

function systemTheme(): Theme {
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Applies + persists. Boot-time application lives in index.html so the
 *  webview never flashes the wrong theme on launch. */
export function setTheme(t: ThemePref) {
  const resolved = t === "system" ? systemTheme() : t;
  document.documentElement.dataset["theme"] = resolved;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // webview storage is always available; guard is for exotic embeds
  }
}
