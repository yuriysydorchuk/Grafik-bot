// Публічна анкета ZUS ZCNA (/zcna/:token) — працівник вписує членів родини для зголошення до
// ubezpieczenia zdrowotnego (лише на його прохання). Без сесії, токен у URL — єдина авторизація
// (як /docs/:token). Поля — з бланка ZUS ZCNA (IV/V A+B); валідація на сервері (services/zcna.ts),
// помилка повертає поле + індекс.
import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Card, Button, Spinner, Input, Select, Label } from "../components/ui";
import { post } from "../lib/api";

type Lang = "uk" | "en" | "es" | "ru" | "pl";
const STR: Record<string, Record<Lang, string>> = {
  loading: { uk: "Завантаження…", en: "Loading…", es: "Cargando…", ru: "Загрузка…", pl: "Ładowanie…" },
  invalid: { uk: "Лінк недійсний або прострочений. Зверніться до офісу за новим.", en: "The link is invalid or expired. Ask the office for a new one.", es: "El enlace no es válido o ha caducado. Pide uno nuevo a la oficina.", ru: "Ссылка недействительна или просрочена. Обратитесь в офис за новой.", pl: "Link jest nieważny lub wygasł. Poproś biuro o nowy." },
  title: { uk: "Члени родини для страхування здоровʼя (ZUS ZCNA)", en: "Family members for health insurance (ZUS ZCNA)", es: "Familiares para el seguro de salud (ZUS ZCNA)", ru: "Члены семьи для медстрахования (ZUS ZCNA)", pl: "Członkowie rodziny do ubezpieczenia zdrowotnego (ZUS ZCNA)" },
  hello: { uk: "{name}, впишіть кожного члена родини, якого треба зголосити. Дані з документа, латиницею.", en: "{name}, enter each family member to be registered. Data as in the document, Latin letters.", es: "{name}, introduce a cada familiar que deba inscribirse. Datos según el documento, en letras latinas.", ru: "{name}, впишите каждого члена семьи, которого нужно заявить. Данные как в документе, латиницей.", pl: "{name}, wpisz każdego członka rodziny do zgłoszenia. Dane jak w dokumencie." },
  member: { uk: "Член родини", en: "Family member", es: "Familiar", ru: "Член семьи", pl: "Członek rodziny" },
  action: { uk: "Дія", en: "Action", es: "Acción", ru: "Действие", pl: "Czynność" },
  zgloszenie: { uk: "Зголосити", en: "Register", es: "Inscribir", ru: "Заявить", pl: "Zgłoszenie" },
  wyrejestrowanie: { uk: "Виреєструвати", en: "Deregister", es: "Dar de baja", ru: "Снять с учёта", pl: "Wyrejestrowanie" },
  lastName: { uk: "Прізвище", en: "Last name", es: "Apellido", ru: "Фамилия", pl: "Nazwisko" },
  firstName: { uk: "Імʼя", en: "First name", es: "Nombre", ru: "Имя", pl: "Imię" },
  birthDate: { uk: "Дата народження", en: "Date of birth", es: "Fecha de nacimiento", ru: "Дата рождения", pl: "Data urodzenia" },
  pesel: { uk: "PESEL (якщо є)", en: "PESEL (if any)", es: "PESEL (si lo tiene)", ru: "PESEL (если есть)", pl: "PESEL (jeśli jest)" },
  docKind: { uk: "Документ (якщо нема PESEL)", en: "Document (if no PESEL)", es: "Documento (si no hay PESEL)", ru: "Документ (если нет PESEL)", pl: "Dokument (gdy brak PESEL)" },
  dowod: { uk: "Dowód osobisty", en: "ID card", es: "DNI", ru: "ID-карта", pl: "Dowód osobisty" },
  paszport: { uk: "Паспорт", en: "Passport", es: "Pasaporte", ru: "Паспорт", pl: "Paszport" },
  docNumber: { uk: "Серія і номер документа", en: "Document series and number", es: "Serie y número del documento", ru: "Серия и номер документа", pl: "Seria i numer dokumentu" },
  relation: { uk: "Ступінь спорідненості", en: "Relationship", es: "Parentesco", ru: "Степень родства", pl: "Stopień pokrewieństwa" },
  rightsDate: { uk: "Дата набуття права (зазвичай від сьогодні)", en: "Date the right starts (usually today)", es: "Fecha de inicio del derecho (normalmente hoy)", ru: "Дата возникновения права (обычно с сегодня)", pl: "Data uzyskania uprawnień (zwykle dziś)" },
  shared: { uk: "Живе зі мною в одному господарстві", en: "Lives in my household", es: "Vive en mi hogar", ru: "Живёт со мной в одном хозяйстве", pl: "Pozostaje we wspólnym gospodarstwie domowym" },
  disability: { uk: "Ступінь інвалідності", en: "Disability degree", es: "Grado de discapacidad", ru: "Степень инвалидности", pl: "Stopień niepełnosprawności" },
  addressDiffers: { uk: "Адреса проживання інша, ніж моя", en: "Lives at a different address than me", es: "Vive en una dirección distinta a la mía", ru: "Адрес проживания отличается от моего", pl: "Adres zamieszkania inny niż mój" },
  postalCode: { uk: "Поштовий індекс", en: "Postal code", es: "Código postal", ru: "Почтовый индекс", pl: "Kod pocztowy" },
  city: { uk: "Місто", en: "City", es: "Ciudad", ru: "Город", pl: "Miejscowość" },
  gmina: { uk: "Gmina / район", en: "Municipality / district", es: "Municipio / distrito", ru: "Гмина / район", pl: "Gmina / dzielnica" },
  street: { uk: "Вулиця", en: "Street", es: "Calle", ru: "Улица", pl: "Ulica" },
  houseNo: { uk: "Будинок", en: "House no.", es: "Nº de casa", ru: "Дом", pl: "Numer domu" },
  flatNo: { uk: "Квартира", en: "Flat no.", es: "Nº de piso", ru: "Квартира", pl: "Numer lokalu" },
  phone: { uk: "Телефон", en: "Phone", es: "Teléfono", ru: "Телефон", pl: "Telefon" },
  country: { uk: "Країна (якщо не Польща) і закордонний індекс", en: "Country (if not Poland) and foreign postal code", es: "País (si no es Polonia) y código postal extranjero", ru: "Страна (если не Польша) и зарубежный индекс", pl: "Symbol państwa (jeśli poza Polską) i zagraniczny kod pocztowy" },
  add: { uk: "＋ Додати члена родини", en: "＋ Add a family member", es: "＋ Añadir familiar", ru: "＋ Добавить члена семьи", pl: "＋ Dodaj członka rodziny" },
  remove: { uk: "Прибрати", en: "Remove", es: "Quitar", ru: "Убрать", pl: "Usuń" },
  submit: { uk: "Надіслати в офіс", en: "Send to the office", es: "Enviar a la oficina", ru: "Отправить в офис", pl: "Wyślij do biura" },
  sending: { uk: "Надсилаю…", en: "Sending…", es: "Enviando…", ru: "Отправляю…", pl: "Wysyłanie…" },
  done: { uk: "Дякуємо! Дані отримано. Офіс підготує документ ZCNA і надішле вам у бот на підпис.", en: "Thank you! Data received. The office will prepare the ZCNA document and send it to you in the bot for signature.", es: "¡Gracias! Datos recibidos. La oficina preparará el documento ZCNA y te lo enviará al bot para firmar.", ru: "Спасибо! Данные получены. Офис подготовит документ ZCNA и отправит вам в бот на подпись.", pl: "Dziękujemy! Dane odebrane. Biuro przygotuje dokument ZCNA i wyśle go do podpisu w bocie." },
  errField: { uk: "Перевірте поле «{field}» у члені родини №{n}", en: "Check the field “{field}” for family member #{n}", es: "Revisa el campo «{field}» del familiar nº {n}", ru: "Проверьте поле «{field}» у члена семьи №{n}", pl: "Sprawdź pole „{field}” członka rodziny nr {n}" },
  empty: { uk: "Додайте хоча б одного члена родини", en: "Add at least one family member", es: "Añade al menos un familiar", ru: "Добавьте хотя бы одного члена семьи", pl: "Dodaj co najmniej jednego członka rodziny" },
  failed: { uk: "Не вдалося надіслати. Спробуйте ще раз.", en: "Sending failed. Please try again.", es: "No se pudo enviar. Inténtalo de nuevo.", ru: "Не удалось отправить. Попробуйте ещё раз.", pl: "Nie udało się wysłać. Spróbuj ponownie." },
};
type Member = { action: "zgloszenie" | "wyrejestrowanie"; rightsDate: string; pesel: string; docKind: string; docNumber: string; lastName: string; firstName: string; birthDate: string; relationCode: string; sharedHousehold: boolean; disabilityCode: string; addressDiffers: boolean; postalCode: string; city: string; gmina: string; street: string; houseNo: string; flatNo: string; phone: string; countryCode: string; foreignPostal: string };
type Info = { workerName: string; language: Lang; members: Partial<Member>[]; relationCodes: { code: string; pl: string }[]; disabilityCodes: { code: string; pl: string }[] };
const today = new Date().toLocaleDateString("sv-SE");
const blank = (): Member => ({ action: "zgloszenie", rightsDate: today, pesel: "", docKind: "", docNumber: "", lastName: "", firstName: "", birthDate: "", relationCode: "11", sharedHousehold: true, disabilityCode: "", addressDiffers: false, postalCode: "", city: "", gmina: "", street: "", houseNo: "", flatNo: "", phone: "", countryCode: "", foreignPostal: "" });
const FIELD_KEY: Record<string, string> = { lastName: "lastName", firstName: "firstName", relationCode: "relation", pesel: "pesel", document: "docNumber", birthDate: "birthDate", rightsDate: "rightsDate", city: "city", disabilityCode: "disability" };

export default function ZcnaForm() {
  const [, params] = useRoute("/zcna/:token");
  const token = params?.token ?? "";
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "invalid" | "done">("loading");
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lang: Lang = info?.language ?? "uk";
  const s = (k: string, p?: Record<string, string>) => { let v = STR[k]?.[lang] ?? STR[k]?.uk ?? k; for (const [a, b] of Object.entries(p ?? {})) v = v.replace(`{${a}}`, b); return v; };
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/zcna/${token}`); if (!r.ok) throw new Error();
        const j: Info = await r.json(); setInfo(j);
        const existing = (j.members ?? []).map(m => ({ ...blank(), ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v ?? (typeof blank()[k as keyof Member] === "boolean" ? false : "")])) } as Member));
        setMembers(existing.length ? existing : [blank()]);
        setState("ok");
      } catch { setState("invalid"); }
    })();
  }, [token]);
  const upd = (i: number, patch: Partial<Member>) => setMembers(ms => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const submit = async () => {
    if (!members.length) { setError(s("empty")); return; }
    setBusy(true); setError(null);
    try { await post(`/zcna/${token}`, { members }); setState("done"); }
    catch (e: any) {
      const field = e?.data?.field; const idx = e?.data?.index;
      setError(field != null && idx != null ? s("errField", { field: s(FIELD_KEY[field] ?? field), n: String(idx + 1) }) : (e?.message || s("failed")));
    } finally { setBusy(false); }
  };
  if (state === "loading") return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
  if (state === "invalid" || !info) return <div className="mx-auto max-w-md p-6"><Card className="p-6 text-center text-slate-600">{s("invalid")}</Card></div>;
  if (state === "done") return <div className="mx-auto max-w-md p-6"><Card className="p-6 text-center text-slate-700">{s("done")}</Card></div>;
  const rc = info.relationCodes, dc = info.disabilityCodes;
  return (
    <div className="mx-auto max-w-lg space-y-3 p-4">
      <div><h1 className="text-lg font-semibold text-slate-800">{s("title")}</h1><p className="text-sm text-slate-600">{s("hello", { name: info.workerName })}</p></div>
      {members.map((m, i) => (
        <Card key={i} className="space-y-2 p-3">
          <div className="flex items-center justify-between"><div className="font-semibold text-slate-700">{s("member")} {i + 1}</div>
            {members.length > 1 && <button type="button" onClick={() => setMembers(ms => ms.filter((_, j) => j !== i))} className="text-xs text-rose-600 hover:underline">{s("remove")}</button>}</div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>{s("action")}</Label><Select value={m.action} onChange={e => upd(i, { action: e.target.value as Member["action"] })}><option value="zgloszenie">{s("zgloszenie")}</option><option value="wyrejestrowanie">{s("wyrejestrowanie")}</option></Select></div>
            <div><Label>{s("relation")}</Label><Select value={m.relationCode} onChange={e => upd(i, { relationCode: e.target.value })}>{rc.map(r => <option key={r.code} value={r.code}>{r.code} — {r.pl}</option>)}</Select></div>
            <div><Label>{s("lastName")}</Label><Input value={m.lastName} onChange={e => upd(i, { lastName: e.target.value })} /></div>
            <div><Label>{s("firstName")}</Label><Input value={m.firstName} onChange={e => upd(i, { firstName: e.target.value })} /></div>
            <div><Label>{s("birthDate")}</Label><Input type="date" value={m.birthDate} onChange={e => upd(i, { birthDate: e.target.value })} /></div>
            <div><Label>{s("pesel")}</Label><Input inputMode="numeric" maxLength={11} value={m.pesel} onChange={e => upd(i, { pesel: e.target.value.replace(/\D/g, "") })} /></div>
            {!m.pesel && (<>
              <div><Label>{s("docKind")}</Label><Select value={m.docKind} onChange={e => upd(i, { docKind: e.target.value })}><option value="">—</option><option value="1">{s("dowod")}</option><option value="2">{s("paszport")}</option></Select></div>
              <div><Label>{s("docNumber")}</Label><Input value={m.docNumber} onChange={e => upd(i, { docNumber: e.target.value })} /></div>
            </>)}
            <div><Label>{s("rightsDate")}</Label><Input type="date" value={m.rightsDate} onChange={e => upd(i, { rightsDate: e.target.value })} /></div>
            <div><Label>{s("disability")}</Label><Select value={m.disabilityCode} onChange={e => upd(i, { disabilityCode: e.target.value })}>{dc.map(d => <option key={d.code} value={d.code}>{d.code ? `${d.code} — ` : ""}{d.pl}</option>)}</Select></div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={m.sharedHousehold} onChange={e => upd(i, { sharedHousehold: e.target.checked })} /> {s("shared")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={m.addressDiffers} onChange={e => upd(i, { addressDiffers: e.target.checked })} /> {s("addressDiffers")}</label>
          {m.addressDiffers && (
            <div className="grid grid-cols-2 gap-2">
              <div><Label>{s("postalCode")}</Label><Input value={m.postalCode} onChange={e => upd(i, { postalCode: e.target.value })} /></div>
              <div><Label>{s("city")}</Label><Input value={m.city} onChange={e => upd(i, { city: e.target.value })} /></div>
              <div><Label>{s("gmina")}</Label><Input value={m.gmina} onChange={e => upd(i, { gmina: e.target.value })} /></div>
              <div><Label>{s("street")}</Label><Input value={m.street} onChange={e => upd(i, { street: e.target.value })} /></div>
              <div><Label>{s("houseNo")}</Label><Input value={m.houseNo} onChange={e => upd(i, { houseNo: e.target.value })} /></div>
              <div><Label>{s("flatNo")}</Label><Input value={m.flatNo} onChange={e => upd(i, { flatNo: e.target.value })} /></div>
              <div><Label>{s("phone")}</Label><Input value={m.phone} onChange={e => upd(i, { phone: e.target.value })} /></div>
              <div><Label>{s("country")}</Label><div className="flex gap-1"><Input value={m.countryCode} placeholder="PL" className="w-16" onChange={e => upd(i, { countryCode: e.target.value.toUpperCase() })} /><Input value={m.foreignPostal} onChange={e => upd(i, { foreignPostal: e.target.value })} /></div></div>
            </div>
          )}
        </Card>
      ))}
      <Button variant="secondary" onClick={() => setMembers(ms => [...ms, blank()])} disabled={members.length >= 10}>{s("add")}</Button>
      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <Button onClick={submit} disabled={busy} className="w-full">{busy ? s("sending") : s("submit")}</Button>
    </div>
  );
}
