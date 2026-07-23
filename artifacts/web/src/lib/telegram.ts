// Telegram Mini App integration. When the panel is opened inside Telegram (web_app button
// in the bot), the launch URL carries `#tgWebAppData=<initData>`. We capture it before any
// routing touches the hash, and ALSO load the official telegram-web-app.js — it extracts
// initData on every platform (including restoring it from its own sessionStorage after a
// webview reload, when the hash is already gone).

// Captured at module load: wouter/redirects may rewrite the URL later.
const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
const fromHash = hashParams.get("tgWebAppData");
// The bot's web_app button also stamps ?tgapp=1 into the URL — a platform-independent
// marker in case a Telegram client does not deliver the hash.
const qsFlag = new URLSearchParams(window.location.search).get("tgapp") === "1";
// Survive reloads inside the webview: the hash disappears, the session flag must not —
// otherwise a pull-to-refresh would drop the user from TG-mode into the full site.
try {
  if (fromHash) sessionStorage.setItem("tgInitData", fromHash);
  if (fromHash || qsFlag) sessionStorage.setItem("tgWebApp", "1");
} catch { /* storage unavailable — hash path still works */ }
const storedFlag = (() => { try { return sessionStorage.getItem("tgWebApp") === "1"; } catch { return false; } })();

export const isTelegramWebApp = !!fromHash || qsFlag || storedFlag;

// Why the last auto-login attempt failed — shown on the login form as a diagnostic.
let lastError: string | null = null;
export function tgLoginError(): string | null { return lastError; }

let scriptPromise: Promise<void> | null = null;
function loadTelegramScript(): Promise<void> {
  if (!scriptPromise) {
    scriptPromise = new Promise<void>(resolve => {
      const s = document.createElement("script");
      s.src = "https://telegram.org/js/telegram-web-app.js";
      s.onload = () => resolve();
      s.onerror = () => resolve(); // offline/blocked — fall back to the hash value
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

// Exchange initData for a normal session cookie. Raw fetch on purpose: the shared api()
// wrapper bounces to /login on 401, which would fight the auto-login attempt.
export async function telegramLogin(): Promise<boolean> {
  await loadTelegramScript();
  const wa = (window as any).Telegram?.WebApp;
  try { wa?.ready(); wa?.expand(); } catch { /* viewport sugar only */ }

  let stored: string | null = null;
  try { stored = sessionStorage.getItem("tgInitData"); } catch { /* ignore */ }
  const initData: string = wa?.initData || fromHash || stored || "";
  if (!initData) {
    lastError = `Telegram не передав initData (платформа: ${hashParams.get("tgWebAppPlatform") ?? "невідома"})`;
    return false;
  }
  try {
    const res = await fetch("/api/auth/telegram-webapp", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Requested-With": "grafik" },
      body: JSON.stringify({ initData }),
    });
    if (res.ok) { lastError = null; return true; }
    let body: any = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    lastError = body?.error ?? `Помилка ${res.status}`;
    return false;
  } catch (e: any) {
    lastError = e?.message ?? "Мережева помилка";
    return false;
  }
}
