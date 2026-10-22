// Публічна сторінка завантаження запитаного документа (/docs/:token) — лінк з бота після
// автозапиту або запиту офісу. Без сесії, токен у URL — єдина авторизація (як /passport-scan).
// Список того, що просимо (з датами і статусом), камера/файл на кожен пункт, підтвердження.
import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Card, Button, Spinner } from "../components/ui";
import { shrinkImageFile } from "../lib/shrinkFile";

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
  chooseFile: { uk: "📎 Вибрати з галереї / PDF (можна кілька)", en: "📎 Choose from gallery / PDF (several allowed)", es: "📎 Elegir de la galería / PDF (se pueden varios)", ru: "📎 Выбрать из галереи / PDF (можно несколько)", pl: "📎 Wybierz z galerii / PDF (można kilka)" },
  uploading: { uk: "Надсилаю…", en: "Uploading…", es: "Subiendo…", ru: "Отправляю…", pl: "Wysyłanie…" },
  done: { uk: "Дякуємо! Файл отримано — офіс перевірить його і за потреби напише вам у бот.", en: "Thank you! The file has been received — the office will check it and message you in the bot if needed.", es: "¡Gracias! Hemos recibido el archivo — la oficina lo revisará y te escribirá en el bot si hace falta.", ru: "Спасибо! Файл получен — офис проверит его и при необходимости напишет вам в бот.", pl: "Dziękujemy! Plik został odebrany — biuro go sprawdzi i w razie potrzeby napisze w bocie." },
  more: { uk: "📷 Додати ще фото до цього документа", en: "📷 Add another photo to this document", es: "📷 Añadir otra foto a este documento", ru: "📷 Добавить ещё фото к этому документу", pl: "📷 Dodaj kolejne zdjęcie do tego dokumentu" },
  hint: { uk: "Чітке фото при доброму освітленні, весь документ у кадрі. Кілька сторінок (дві сторони, штампи, кілька довідок) — фотографуйте по черзі або виберіть кілька фото з галереї: усе збережеться в один документ.", en: "A clear photo in good light with the whole document in the frame. Several pages (two sides, stamps, several certificates) — take them one by one or pick several photos from the gallery: everything is saved as one document.", es: "Foto nítida con buena luz y todo el documento en el encuadre. Varias páginas (dos caras, sellos, varios certificados): hazlas una a una o elige varias fotos de la galería; todo se guarda como un solo documento.", ru: "Чёткое фото при хорошем освещении, весь документ в кадре. Несколько страниц (две стороны, штампы, несколько справок) — фотографируйте по очереди или выберите несколько фото из галереи: всё сохранится в один документ.", pl: "Wyraźne zdjęcie w dobrym świetle, cały dokument w kadrze. Kilka stron (dwie strony, pieczątki, kilka zaświadczeń) — rób zdjęcia po kolei albo wybierz kilka z galerii: wszystko zapisze się jako jeden dokument." },
  sentN: { uk: "Надіслано файлів: {n} — усі в цьому документі", en: "Files sent: {n} — all in this document", es: "Archivos enviados: {n} — todos en este documento", ru: "Отправлено файлов: {n} — все в этом документе", pl: "Wysłano plików: {n} — wszystkie w tym dokumencie" },
  failed: { uk: "Не вдалося надіслати. Спробуйте інший файл або пізніше.", en: "Upload failed. Try another file or later.", es: "No se pudo enviar. Prueba con otro archivo o más tarde.", ru: "Не удалось отправить. Попробуйте другой файл или позже.", pl: "Nie udało się wysłać. Spróbuj inny plik lub później." },
  // дані документа, які вписує сам працівник (document_types.worker_fields) — усі обовʼязкові
  fieldsTitle: { uk: "Впишіть дані з документа:", en: "Enter the details from the document:", es: "Introduce los datos del documento:", ru: "Впишите данные из документа:", pl: "Wpisz dane z dokumentu:" },
  "f.number": { uk: "Номер документа", en: "Document number", es: "Número del documento", ru: "Номер документа", pl: "Numer dokumentu" },
  "f.validFrom": { uk: "Дійсний з", en: "Valid from", es: "Válido desde", ru: "Действителен с", pl: "Ważny od" },
  "f.issuedAt": { uk: "Дата видачі", en: "Date of issue", es: "Fecha de expedición", ru: "Дата выдачи", pl: "Data wydania" },
  "f.expiresAt": { uk: "Дійсний до", en: "Valid until", es: "Válido hasta", ru: "Действителен до", pl: "Ważny do" },
  "f.issuer": { uk: "Ким виданий / заклад", en: "Issued by / institution", es: "Expedido por / institución", ru: "Кем выдан / учреждение", pl: "Wydany przez / instytucja" },
  "e.required": { uk: "Заповніть це поле", en: "This field is required", es: "Este campo es obligatorio", ru: "Заполните это поле", pl: "To pole jest wymagane" },
  "e.format": { uk: "Невірна дата", en: "Invalid date", es: "Fecha no válida", ru: "Неверная дата", pl: "Nieprawidłowa data" },
  "e.past": { uk: "Дата вже минула — документ прострочений", en: "The date has passed — the document has expired", es: "La fecha ya pasó — el documento ha caducado", ru: "Дата уже прошла — документ просрочен", pl: "Data już minęła — dokument jest przeterminowany" },
  "e.order": { uk: "«Дійсний до» має бути пізніше за дату початку", en: "“Valid until” must be after the start date", es: "«Válido hasta» debe ser posterior a la fecha de inicio", ru: "«Действителен до» должно быть позже даты начала", pl: "„Ważny do” musi być późniejsze niż data początkowa" },
  fillFirst: { uk: "Спершу заповніть дані вище", en: "Fill in the details above first", es: "Primero rellena los datos de arriba", ru: "Сначала заполните данные выше", pl: "Najpierw wypełnij dane powyżej" },
};
type FieldKey = "number" | "validFrom" | "issuedAt" | "expiresAt" | "issuer";
type FieldErr = "required" | "format" | "past" | "order";
const DATE_FIELDS = new Set<FieldKey>(["validFrom", "issuedAt", "expiresAt"]);
// та сама перевірка, що на сервері (validateWorkerFields) — щоб підсвітити поле до відправки файла
function checkFields(keys: FieldKey[], vals: Record<string, string>, today: string): Partial<Record<FieldKey, FieldErr>> {
  const errs: Partial<Record<FieldKey, FieldErr>> = {};
  for (const k of keys) {
    const v = (vals[k] ?? "").trim();
    if (!v) { errs[k] = "required"; continue; }
    if (!DATE_FIELDS.has(k)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { errs[k] = "format"; continue; }
    if (k === "expiresAt" && v < today) errs[k] = "past";
  }
  const from = vals.validFrom || vals.issuedAt;
  if (!errs.expiresAt && from && vals.expiresAt && from > vals.expiresAt) errs.expiresAt = "order";
  return errs;
}
type Item = { docTypeId: number; name: string; expiresAt: string | null; status: string; requestedAt: string | null; uploadedAt: string | null; reviewNote: string | null; fields: FieldKey[]; values: Record<string, string> | null };
type Info = { workerName: string; language: Lang; focusTypeId: number | null; items: Item[] };
const fmt = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "");

export default function DocUpload() {
  const [, params] = useRoute("/docs/:token");
  const token = params?.token ?? "";
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "invalid">("loading");
  const [busy, setBusy] = useState<number | null>(null);
  const [doneFor, setDoneFor] = useState<Set<number>>(new Set());
  const [sentCount, setSentCount] = useState<Record<number, number>>({}); // скільки файлів надіслано в цій сесії
  const [error, setError] = useState<string | null>(null);
  // введені дані по типу документа; серверні помилки по полю (коди → локалізовані рядки)
  const [vals, setVals] = useState<Record<number, Record<string, string>>>({});
  const [touched, setTouched] = useState<Record<number, boolean>>({});
  const [srvErrs, setSrvErrs] = useState<Record<number, Partial<Record<FieldKey, FieldErr>>>>({});
  // «сьогодні» — за Варшавою, як на сервері (validateWorkerFields/warsawToday): телефон у Києві о 23:30 не має блокувати чинну дату
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
  const lang: Lang = info?.language ?? "uk";
  const s = (k: string, p?: Record<string, string>) => { let v = STR[k]?.[lang] ?? STR[k]?.uk ?? k; for (const [a, b] of Object.entries(p ?? {})) v = v.replace(`{${a}}`, b); return v; };
  const load = async () => {
    try {
      const r = await fetch(`/api/docs/${token}`); if (!r.ok) throw new Error();
      const data: Info = await r.json(); setInfo(data); setState("ok");
      // передзаповнення щойно надісланого (pending) — лише там, де людина ще нічого не вводила
      setVals(prev => { const n = { ...prev }; for (const it of data.items) if (it.values && !n[it.docTypeId]) n[it.docTypeId] = { ...it.values }; return n; });
    } catch { setState("invalid"); }
  };
  useEffect(() => { void load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  // files — одне фото з камери або кілька з галереї; після першого завантаження (pending) — дозапис
  // сторінок у той самий документ (append), а не заміна файлу
  const send = async (it: Item, files: File[], append: boolean) => {
    const docTypeId = it.docTypeId;
    setTouched(p => ({ ...p, [docTypeId]: true }));
    if (Object.keys(checkFields(it.fields, vals[docTypeId] ?? {}, today)).length) return; // підсвітка полів, файл не шлемо
    setBusy(docTypeId); setError(null); setSrvErrs(p => ({ ...p, [docTypeId]: {} }));
    try {
      const fd = new FormData(); fd.append("docTypeId", String(docTypeId));
      for (const f of files) fd.append("files", f.type.startsWith("image/") ? await shrinkImageFile(f) : f);
      if (append) fd.append("append", "1");
      const picked: Record<string, string> = {}; for (const k of it.fields) picked[k] = (vals[docTypeId]?.[k] ?? "").trim();
      if (it.fields.length) fd.append("fields", JSON.stringify(picked));
      // прямий fetch (не upload()): 400 з {fields:{ключ:код}} треба показати по полях, а обгортка лишає лише текст
      const r = await fetch(`/api/docs/${token}/upload`, { method: "POST", headers: { "X-Requested-With": "grafik" }, body: fd });
      if (!r.ok) {
        let data: any = null; try { data = await r.json(); } catch { data = null; }
        if (data?.fields && typeof data.fields === "object") { setSrvErrs(p => ({ ...p, [docTypeId]: data.fields })); return; }
        throw new Error(data?.error ?? String(r.status));
      }
      setDoneFor(prev => new Set(prev).add(docTypeId));
      setSentCount(p => ({ ...p, [docTypeId]: (p[docTypeId] ?? 0) + files.length }));
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
        const expired = !!it.expiresAt && it.expiresAt < today;
        const v = vals[it.docTypeId] ?? {};
        const errs: Partial<Record<FieldKey, FieldErr>> = { ...(touched[it.docTypeId] ? checkFields(it.fields, v, today) : {}), ...(srvErrs[it.docTypeId] ?? {}) };
        const incomplete = it.fields.some(k => !(v[k] ?? "").trim());
        const setV = (k: FieldKey, val: string) => { setVals(p => ({ ...p, [it.docTypeId]: { ...(p[it.docTypeId] ?? {}), [k]: val } })); setSrvErrs(p => { const n = { ...(p[it.docTypeId] ?? {}) }; delete n[k]; return { ...p, [it.docTypeId]: n }; }); };
        return (
          <Card key={it.docTypeId} className={`space-y-2 p-4 ${it.docTypeId === info.focusTypeId ? "border-red-300" : ""}`}>
            <div className="text-base font-semibold text-slate-800">{it.name}</div>
            {it.expiresAt && <div className={`text-xs ${expired ? "text-rose-600" : "text-slate-500"}`}>{expired ? s("expired") : s("validUntil")} {fmt(it.expiresAt)}</div>}
            {it.reviewNote && !uploaded && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{s("rejected", { note: it.reviewNote })}</div>}
            {uploaded ? (
              <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                {doneFor.has(it.docTypeId) ? s("done") : s("pending")}
                {(sentCount[it.docTypeId] ?? 0) > 0 && <div className="mt-1 text-xs">{s("sentN", { n: String(sentCount[it.docTypeId]) })}</div>}
              </div>
            ) : <p className="text-xs text-slate-500">{s("hint")}</p>}
            {it.fields.length > 0 && (
              <div className="space-y-1.5 rounded-lg bg-slate-50 p-3">
                <div className="text-xs font-medium text-slate-600">{s("fieldsTitle")}</div>
                {it.fields.map(k => (
                  <label key={k} className="block">
                    <span className="text-xs text-slate-500">{s(`f.${k}`)}</span>
                    <input type={DATE_FIELDS.has(k) ? "date" : "text"} value={v[k] ?? ""} onChange={e => setV(k, e.target.value)} onBlur={() => setTouched(p => ({ ...p, [it.docTypeId]: true }))}
                      autoComplete="off" maxLength={120} disabled={busy != null}
                      className={`mt-0.5 block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 ${errs[k] ? "border-rose-400" : "border-slate-300"}`} />
                    {errs[k] && <span className="text-xs text-rose-600">{s(`e.${errs[k]}`)}</span>}
                  </label>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <label className="flex-1" title={incomplete ? s("fillFirst") : undefined}>
                <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy != null} onChange={e => { const f = e.target.files?.[0]; if (f) void send(it, [f], uploaded); e.target.value = ""; }} />
                <span className={`block w-full cursor-pointer rounded-lg bg-red-600 px-3 py-2.5 text-center text-sm font-semibold text-white ${busy != null || incomplete ? "opacity-60" : "hover:bg-red-700"}`}>{busy === it.docTypeId ? s("uploading") : uploaded ? s("more") : s("takePhoto")}</span>
              </label>
              <label title={incomplete ? s("fillFirst") : undefined}>
                <input type="file" accept="image/*,application/pdf" multiple className="hidden" disabled={busy != null} onChange={e => { const fs = Array.from(e.target.files ?? []); if (fs.length) void send(it, fs, uploaded); e.target.value = ""; }} />
                <span className={`block cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-center text-sm text-slate-700 ${incomplete ? "opacity-60" : "hover:bg-slate-50"}`}>{s("chooseFile")}</span>
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
