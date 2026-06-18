import { useState } from "react";
import { Button, Input, Label } from "../components/ui";
import { useT } from "../lib/i18n";

async function postRaw(path: string, body: any) {
  const r = await fetch(`/api${path}`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.error || `Помилка ${r.status}`);
  return data;
}

export default function Login() {
  const t = useT();
  const [stage, setStage] = useState<"login" | "code">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setLoading(true);
    try {
      const r = await postRaw("/auth/login", { username, password });
      if (r?.twoFactor) { setPendingId(r.pendingId); setStage("code"); setCode(""); }
      else location.href = "/";
    } catch (e: any) { setErr(e.message || t("Помилка входу")); }
    finally { setLoading(false); }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setLoading(true);
    try {
      await postRaw("/auth/verify-2fa", { pendingId, code });
      location.href = "/";
    } catch (e: any) { setErr(e.message || t("Невірний код")); setLoading(false); }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-red-50 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-7 shadow-lg shadow-slate-200/50">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/logo.png" alt="Euro Support" className="mb-3 h-16 w-16 object-contain" />
          <h1 className="text-lg font-bold tracking-tight text-slate-800">Euro Support</h1>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{t("Панель графіків")}</p>
        </div>

        {stage === "login" ? (
          <form onSubmit={submitLogin} className="space-y-4">
            <div>
              <Label>{t("Логін")}</Label>
              <Input value={username} onChange={e => setUsername(e.target.value)} autoFocus autoComplete="username" />
            </div>
            <div>
              <Label>{t("Пароль")}</Label>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
            </div>
            {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{err}</div>}
            <Button type="submit" loading={loading} className="w-full">{t("Увійти")}</Button>
            <p className="text-center text-xs text-slate-400">{t("Доступ створює власник у розділі «Налаштування → Користувачі».")}</p>
          </form>
        ) : (
          <form onSubmit={submitCode} className="space-y-4">
            <div className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-700">
              {t("🔐 Ми надіслали 6-значний код у ваш Telegram. Введіть його нижче.")}
            </div>
            <div>
              <Label>{t("Код підтвердження")}</Label>
              <Input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                autoFocus inputMode="numeric" placeholder="______" className="text-center text-lg tracking-[0.5em]" />
            </div>
            {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{err}</div>}
            <Button type="submit" loading={loading} disabled={code.length < 6} className="w-full">{t("Підтвердити")}</Button>
            <button type="button" onClick={() => { setStage("login"); setErr(""); setPassword(""); }}
              className="w-full text-center text-xs text-slate-400 hover:text-slate-600">{t("← Назад до входу")}</button>
          </form>
        )}
      </div>
    </div>
  );
}
