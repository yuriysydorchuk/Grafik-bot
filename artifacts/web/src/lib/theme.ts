// Theme (light/dark/system) store. The resolved theme is applied as the `dark`
// class on <html>; index.html has a tiny inline script that does the same before
// first paint, so there is no light flash. Kept as a module-level singleton (not
// React context) — the class lives on the document anyway.
import { useSyncExternalStore } from "react";

export type ThemePref = "light" | "dark" | "system";

const KEY = "theme";
const listeners = new Set<() => void>();
const mq = window.matchMedia("(prefers-color-scheme: dark)");

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* storage unavailable */ }
  return "system";
}
let pref: ThemePref = readPref();

// Inside the Telegram Mini App webview localStorage does not survive, so "system"
// follows Telegram's own colorScheme when the official script has loaded.
function tgScheme(): "light" | "dark" | null {
  const s = (window as any).Telegram?.WebApp?.colorScheme;
  return s === "dark" || s === "light" ? s : null;
}

export function resolvedDark(): boolean {
  if (pref !== "system") return pref === "dark";
  return tgScheme() ? tgScheme() === "dark" : mq.matches;
}

function apply() {
  document.documentElement.classList.toggle("dark", resolvedDark());
  listeners.forEach(fn => fn());
}

mq.addEventListener("change", () => { if (pref === "system") apply(); });
// The TG script loads async (telegram.ts) — by window load it is there or never.
window.addEventListener("load", () => {
  try { (window as any).Telegram?.WebApp?.onEvent?.("themeChanged", () => { if (pref === "system") apply(); }); } catch { /* ignore */ }
  if (pref === "system") apply();
});

export function setThemePref(p: ThemePref) {
  pref = p;
  try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
  apply();
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function useTheme() {
  const prefSnap = useSyncExternalStore(subscribe, () => pref);
  const dark = useSyncExternalStore(subscribe, resolvedDark);
  return { pref: prefSnap, dark, setPref: setThemePref };
}

// Recharts takes plain color strings (SVG attrs can't resolve CSS vars), so chart
// chrome — grid/axes/tooltip — is resolved here per theme. Series colors stay put.
export function useChartTheme() {
  const { dark } = useTheme();
  return dark
    ? {
      grid: "#2b3448",
      tick: "#a2abbf",
      tickMuted: "#8e97ac",
      tooltip: { borderRadius: 12, border: "1px solid #333d53", backgroundColor: "#1b2130", color: "#e6eaf3", fontSize: 13 },
    }
    : {
      grid: "#eef2f7",
      tick: "#64748b",
      tickMuted: "#94a3b8",
      tooltip: { borderRadius: 12, border: "1px solid #e2e8f0", backgroundColor: "#fff", fontSize: 13 },
    };
}

apply();
