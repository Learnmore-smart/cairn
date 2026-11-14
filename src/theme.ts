export type Theme = "dark" | "light";

const KEY = "cairn-theme";

export function getTheme(): Theme {
  const attr = document.documentElement.dataset["theme"];
  if (attr === "light" || attr === "dark") return attr;
  return "dark";
}

/** Applies + persists. Boot-time application lives in index.html so the
 *  webview never flashes the wrong theme on launch. */
export function setTheme(t: Theme) {
  document.documentElement.dataset["theme"] = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // webview storage is always available; guard is for exotic embeds
  }
}
