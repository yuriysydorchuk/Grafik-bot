// Публічна сторінка завантаження запитаного документа (/docs/:token) — лінк з бота після
// автозапиту або запиту офісу. Без сесії, токен у URL — єдина авторизація (як /passport-scan).
// Список того, що просимо (з датами і статусом), камера/файл на кожен пункт, підтвердження.
import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Card, Button, Spinner } from "../components/ui";
import { upload } from "../lib/api";

type Lang = "uk" | "en" | "es" | "ru" | "pl";
const STR: Record<string, Record<Lang, string>> = {
  loading: { uk: "Завантаження…", en: "Loading…", es: "Cargando…", ru: "Загрузка…", pl: "Ładowanie…" },
  invalid: { uk: "Лінк недійсний або прострочений. Зверніться до офісу за новим.", en: "The link is invalid or expired. Ask the office for a new one.", es: "El enlace no es válido o ha caducado. Pide uno nuevo a la oficina.", ru: "Ссылка недействительна или устарела. Обратитесь в офис за новой.", pl: "Link jest nieprawidłowy lub wygasł. Poproś biuro o nowy." },
  title: { uk: "Документи для офісу", en: "Documents for the office", es: "Documentos para la oficina", ru: "Документы для офиса", pl: "Dokumenty dla biura" },
  hello: { uk: "Вітаємо, {name}! Будь ласка, сфотографуйте або завантажте документи нижче.", en: "Hello, {name}! Please take a photo of or upload the documents below.", es: "¡Hola, {name}! Por favor, haz una foto o sube los documentos de abajo.", ru: "Здравствуйте, {name}! Пожалуйста, сфотографируйте или загрузите документы ниже.", pl: "Witaj, {name}! Zrób zdjęcie lub prześlij poniższe dokumenty." },
  validUntil: { uk: "чинний до", en: "valid until", es: "válido hasta", ru: "действителен до", pl: "ważny do" },
  expired: { uk: "прострочений", en: "expired", es: "caducado", ru: "просрочен", pl: "przeterminowany" },
  pending: { uk: "✅ Отримано — офіс перевіряє", en: "✅ Received — the office is checking", es: "✅ Recibido — la oficina lo revisa", ru: "✅ Получено — офис проверяет", pl: "✅ Odebrano — biuro sprawdza" },
  rejected: { uk: "❌ Попередній файл відхилено: {note}. Надішліть, будь ласка, ще раз.", en: "❌ The previous file was rejected: {note}. Please send it again.", es: "❌ El archivo anterior fue rechazado: {note}. Envíalo de nuevo, por favor.", ru: "❌ Предыдущий файл отклонён: {note}. Пожалуйста, отправьте ещё раз.", pl: "❌ Poprzedni plik został odrzucony: {note}. Prześlij go ponownie." },
  takePhoto: { uk: "📷 Зробити фото", en: "📷 Take a photo", es: "📷 Hacer una foto", ru: "📷 Сделать фото", pl: "📷 Zrób zdjęcie" },
  chooseFile: { uk: "📎 Вибрати файл / PDF", en: "📎 Choose a file / PDF", es: "📎 Elegir archivo / PDF", ru: "📎 Выбрать файл / PDF", pl: "📎 Wybierz plik / PDF" },
  uploading: { uk: "Надсилаю…", en: "Uploading…", es: "Subiendo…", ru: "Отправляю…", pl: "Wysyłanie…" },
  done: { uk: "Дякуємо! Файл отримано — офіс перевірить його і за потреби напише вам у бот.", en: "Thank you! The file has been received — the office will check it and message you in the bot if needed.", es: "¡Gracias! Hemos recibido el archivo — la oficina lo revisará y te escribirá en el bot si hace falta.", ru: "Спасибо! Файл получен — офис проверит его и при необходимости напишет вам в бот.", pl: "Dziękujemy! Plik został odebrany — biuro go sprawdzi i w razie potrzeby napisze w bocie." },
  more: { uk: "Ще один файл цього ж документа", en: "One more file for the same document", es: "Otro archivo del mismo documento", ru: "Ещё один файл этого же документа", pl: "Jeszcze jeden plik tego dokumentu" },
  hint: { uk: "Чітке фото при доброму освітленні, весь документ у кадрі. Дві сторони — двома фото.", en: "A clear photo in good light with the whole document in the frame. Two sides — two photos.", es: "Foto nítida con buena luz y todo el documento en el encuadre. Dos caras — dos fotos.", ru: "Чёткое фото при хорошем освещении, весь документ в кадре. Две стороны — два фото.", pl: "Wyraźne zdjęcie w dobrym świetle, cały dokument w kadrze. Dwie strony — dwa zdjęcia." },
  failed: { uk: "Не вдалося надіслати. Спробуйте інший файл або пізніше.", en: "Upload failed. Try another file or later.", es: "No se pudo enviar. Prueba con otro archivo o más tarde.", ru: "Не удалось отправить. Попробуйте другой файл или позже.", pl: "Nie udało się wysłać. Spróbuj inny plik lub później." },
};
type Item = { docTypeId: number; name: string; expiresAt: string | null; status: string; requestedAt: string | null; uploadedAt: string | null; reviewNote: string | null };
type Info = { workerName: string; language: Lang; focusTypeId: number | null; items: Item[] };
const fmt = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "");

export default function DocUpload() {
  const [, params] = useRoute("/docs/:token");
  const token = params?.token ?? "";
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "invalid">("loading");
  const [busy, setBusy] = useState<number | null>(null);
  const [doneFor, setDoneFor] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const lang: Lang = info?.language ?? "uk";
  const s = (k: string, p?: Record<string, string>) => { let v = STR[k]?.[lang] ?? STR[k]?.uk ?? k; for (const [a, b] of Object.entries(p ?? {})) v = v.replace(`{${a}}`, b); return v; };
  const load = async () => {
    try { const r = await fetch(`/api/docs/${token}`); if (!r.ok) throw new Error(); setInfo(await r.json()); setState("ok"); }
    catch { setState("invalid"); }
  };
  useEffect(() => { void load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async (docTypeId: number, file: File) => {
    setBusy(docTypeId); setError(null);
    try {
      const fd = new FormData(); fd.append("docTypeId", String(docTypeId)); fd.append("file", file);
      await upload(`/docs/${token}/upload`, fd);
      setDoneFor(prev => new Set(prev).add(docTypeId));
      await load();
    } catch { setError(s("failed")); }
    finally { setBusy(null); }
  };
  if (state === "loading") return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
  if (state === "invalid" || !info) return <div className="mx-auto max-w-md p-6"><Card className="p-6 text-center text-slate-600">{s("invalid")}</Card></div>;
  return (
    <div className="mx-auto max-w-md space-y-3 p-4">
      <div>
        <h1 className="text-xl font-bold text-slate-900">{s("title")}</h1>
        <p className="text-sm text-slate-600">{s("hello", { name: info.workerName.split(" ")[0] ?? info.workerName })}</p>
      </div>
      {info.items.map(it => {
        const uploaded = it.status === "pending" || doneFor.has(it.docTypeId);
        const expired = !!it.expiresAt && it.expiresAt < new Date().toLocaleDateString("sv-SE");
        return (
          <Card key={it.docTypeId} className={`space-y-2 p-4 ${it.docTypeId === info.focusTypeId ? "border-red-300" : ""}`}>
            <div className="text-base font-semibold text-slate-800">{it.name}</div>
            {it.expiresAt && <div className={`text-xs ${expired ? "text-rose-600" : "text-slate-500"}`}>{expired ? s("expired") : s("validUntil")} {fmt(it.expiresAt)}</div>}
            {it.reviewNote && !uploaded && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{s("rejected", { note: it.reviewNote })}</div>}
            {uploaded ? (
              <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{doneFor.has(it.docTypeId) ? s("done") : s("pending")}</div>
            ) : <p className="text-xs text-slate-500">{s("hint")}</p>}
            <div className="flex flex-wrap gap-2">
              <label className="flex-1">
                <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy != null} onChange={e => { const f = e.target.files?.[0]; if (f) void send(it.docTypeId, f); e.target.value = ""; }} />
                <span className={`block w-full cursor-pointer rounded-lg bg-red-600 px-3 py-2.5 text-center text-sm font-semibold text-white ${busy != null ? "opacity-60" : "hover:bg-red-700"}`}>{busy === it.docTypeId ? s("uploading") : uploaded ? s("more") : s("takePhoto")}</span>
              </label>
              <label>
                <input type="file" accept="image/*,application/pdf" className="hidden" disabled={busy != null} onChange={e => { const f = e.target.files?.[0]; if (f) void send(it.docTypeId, f); e.target.value = ""; }} />
                <span className="block cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-center text-sm text-slate-700 hover:bg-slate-50">{s("chooseFile")}</span>
              </label>
            </div>
          </Card>
        );
      })}
      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <Button variant="ghost" className="hidden" />
    </div>
  );
}
