// SMS-кампанії (/sms-campaigns): список кампаній з воронками, плитка-зведення, майстер
// створення (параметри → тексти → імпорт xlsx з мапінгом колонок і перевіркою). API —
// routes/smsCampaigns.ts. Картка кампанії — SmsCampaignCard.tsx (/sms-campaigns/:id).
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Settings2, Upload } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch, upload } from "../lib/api";
import { Button, Input, Select, Card, Spinner, Badge, Empty, Label, Modal, Textarea } from "../components/ui";
import { useT } from "../lib/i18n";
import { smsParts, SMS_CAMPAIGN_STATUS } from "../lib/smsParts";

export type SmsStats = { recipients: number; queued: number; sent: number; delivered: number; failed: number; viewed: number; cta: number; interested: number; contacted: number; bot: number; form: number; hired: number; skipped: number; activeWorkers: number; parts: number; costEstimate: number; byLang: Record<string, number> };
export type Campaign = {
  id: number; name: string; kind: "job" | "referral"; status: string; provider: "smsapi" | "smsfly"; sender: string;
  texts: Record<string, string>; landing: any; offer: Record<string, any>; schedule: { days: number[]; from: string; to: string; dailyLimit: number; batchSize: number; testLimit?: number };
  recruiterAdminId: number | null; factoryName: string | null; stats: SmsStats; candidates: number; activeWorkersPending?: number; inFlight: boolean; startedAt: string | null; finishedAt: string | null; createdAt: string;
};
type ListResp = { campaigns: Campaign[]; summary: { views7d: number; newCandidates7d: number; viewedNoBot: number; queued: number; activeCampaigns: number } };
type Settings = { providers: { name: string; configured: boolean; pricePl: number; priceUa: number }[]; sender: string; linkBase: string; defaults: Campaign["schedule"]; officePhone: string };

export function FunnelBar({ s, width = 160 }: { s: SmsStats; width?: number }) {
  const total = Math.max(1, s.recipients);
  const seg = (n: number, cls: string, title: string) => <i key={title} title={`${title}: ${n}`} className={`block h-full ${cls}`} style={{ width: `${(n / total) * 100}%` }} />;
  return (
    <div className="flex h-3 rounded-full overflow-hidden bg-slate-200" style={{ width }}>
      {seg(s.delivered - s.viewed, "bg-sky-600", "доставлено")}{seg(s.viewed - s.bot, "bg-amber-500", "відкрили сторінку")}{seg(s.bot - s.form, "bg-violet-600", "у боті")}{seg(s.form, "bg-emerald-600", "анкета")}{seg(s.failed, "bg-rose-500", "не доставлено")}
    </div>
  );
}

const DAYS = [{ v: 1, l: "Пн" }, { v: 2, l: "Вт" }, { v: 3, l: "Ср" }, { v: 4, l: "Чт" }, { v: 5, l: "Пт" }, { v: 6, l: "Сб" }, { v: 7, l: "Нд" }];

export default function SmsCampaigns() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<ListResp>({ queryKey: ["sms-campaigns"], queryFn: () => get("/sms-campaigns") });
  const { data: settings } = useQuery<Settings>({ queryKey: ["sms-settings"], queryFn: () => get("/sms-campaigns/settings") });
  const [wizard, setWizard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const list = data?.campaigns ?? [];
  const sum = data?.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">{t("SMS-кампанії")}</h1>
        <span className="flex-1" />
        <Button variant="secondary" onClick={() => setShowSettings(true)}><Settings2 size={16} /> {t("Налаштування")}</Button>
        <Button onClick={() => setWizard(true)}><Plus size={16} /> {t("Нова кампанія")}</Button>
      </div>
      {sum && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {[[sum.views7d, t("відкрили сторінку за 7 днів")], [sum.newCandidates7d, t("нові кандидати з SMS за 7 днів")], [sum.viewedNoBot, t("відкрили, але не зайшли в бот")], [sum.queued, t("у черзі")], [sum.activeCampaigns, t("активних кампаній")]].map(([n, l], i) => (
            <Card key={i} className="p-3"><div className="text-2xl font-bold tabular-nums">{n as number}</div><div className="text-xs text-slate-500">{l as string}</div></Card>
          ))}
        </div>
      )}
      {isLoading ? <Spinner /> : !list.length ? <Empty>{t("Кампаній ще немає. Створіть першу: параметри → тексти → імпорт списку.")}</Empty> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500 border-b border-slate-200">
              {[t("Кампанія"), t("Тип"), t("Статус"), t("Отримувачів"), t("Воронка"), t("Відкрили"), t("У боті"), t("Анкети"), t("На зміні"), t("Витрати"), t("Провайдер")].map((h) => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}
            </tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2"><Link href={`/sms-campaigns/${c.id}`} className="font-semibold text-slate-900 hover:underline">{c.name}</Link><div className="text-xs text-slate-500">{c.factoryName ? `${c.factoryName} · ` : ""}{new Date(c.createdAt).toLocaleDateString("uk-UA")}</div></td>
                  <td className="px-3 py-2">{c.kind === "referral" ? t("Приведи друга") : t("Є робота")}</td>
                  <td className="px-3 py-2"><Badge color={SMS_CAMPAIGN_STATUS[c.status]?.color ?? "slate"}>{t(SMS_CAMPAIGN_STATUS[c.status]?.label ?? c.status)}</Badge>{c.status === "sending" && <div className="text-xs text-slate-500">{c.stats.sent} / {c.stats.recipients}</div>}</td>
                  <td className="px-3 py-2 tabular-nums">{c.stats.recipients}{c.stats.activeWorkers ? <span className="text-xs text-slate-400"> +{c.stats.activeWorkers} {t("акт.")}</span> : null}</td>
                  <td className="px-3 py-2"><FunnelBar s={c.stats} /></td>
                  <td className="px-3 py-2 tabular-nums">{c.stats.viewed}</td>
                  <td className="px-3 py-2 tabular-nums">{c.stats.bot}</td>
                  <td className="px-3 py-2 tabular-nums">{c.stats.form}</td>
                  <td className="px-3 py-2 tabular-nums">{c.stats.hired}</td>
                  <td className="px-3 py-2 tabular-nums">~{c.stats.costEstimate} zł</td>
                  <td className="px-3 py-2">{c.provider === "smsfly" ? "SMS-Fly" : "SMSAPI"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="text-xs text-slate-500">{t("Воронка: синє — доставлено, жовте — відкрили сторінку, фіолетове — у боті, зелене — анкета, червоне — не доставлено. Витрати — оцінка з ціни провайдера × частин SMS.")}</p>

      <Modal open={showSettings} onClose={() => setShowSettings(false)} title={t("Налаштування SMS-кампаній")}>
        {!settings ? <Spinner /> : (
          <div className="space-y-3 text-sm">
            <table className="w-full"><thead><tr className="text-left text-slate-500"><th className="py-1">{t("Провайдер")}</th><th>{t("Ключ")}</th><th>PL</th><th>UA</th></tr></thead><tbody>
              {settings.providers.map((p) => <tr key={p.name} className="border-t border-slate-100"><td className="py-1 font-medium">{p.name === "smsfly" ? "SMS-Fly" : "SMSAPI"}</td><td>{p.configured ? <Badge color="green">{t("налаштовано")}</Badge> : <Badge color="rose">{t("немає ключа в .env")}</Badge>}</td><td>{p.pricePl} zł</td><td>{p.priceUa} zł</td></tr>)}
            </tbody></table>
            <div><b>{t("Підпис відправника")}:</b> {settings.sender} · <b>{t("База лінків")}:</b> {settings.linkBase || t("не задано (SMS_LINK_BASE / WEB_APP_URL)")} · <b>{t("Телефон офісу")}:</b> {settings.officePhone || "—"}</div>
            <div className="text-slate-500">{t("Ключі й підпис задаються в .env: SMS_SMSAPI_TOKEN, SMS_SMSFLY_KEY, SMS_SENDER, SMS_LINK_BASE, SMS_OFFICE_PHONE. Вікно, ліміт і батч — у кожній кампанії (дефолт")} {settings.defaults.from}–{settings.defaults.to}, {settings.defaults.dailyLimit}/{t("день")}, {t("батч")} {settings.defaults.batchSize}).</div>
          </div>
        )}
      </Modal>

      {wizard && <Wizard onClose={() => { setWizard(false); qc.invalidateQueries({ queryKey: ["sms-campaigns"] }); }} settings={settings} />}
    </div>
  );
}

// ── Майстер: 1 параметри → 2 тексти → 3 імпорт ─────────────────────────────
type Factory = { id: number; name: string; city?: string | null };
type Staff = { id: number; name: string };
// Дефолтні тексти — ОДНА частина SMS (рішення власника 21.09.2026): латиниця/транслітерація = GSM-7,
// 160 знаків з іменем і лінком (~27 знаків при короткому домені); кирилиця дала б лише 70. Без ł/ą/ę/ś/ż (zl, не zł).
const TEXT_DEFAULTS: Record<string, Record<string, string>> = {
  // текст власника 21.09.2026: «у нас є вакансія для вас, або порекомендуйте нас друзям і отримайте 300 zl; вихід від зараз»
  job: { uk: "{імʼя}, u nas ye vakansii do 8000zl/mis! Abo porekomenduite nas druziam i otrymaite 300zl. Start cioho tyzhnia. Detali: {лінк}", ru: "{имя}, u nas est vakansii do 8000zl/mes! Ili porekomenduyte nas druzyam i poluchite 300zl. Start na etoy nedele. Detali: {ссылка}", en: "{name}, we have jobs up to 8000 PLN/month! Or recommend us to friends and get 300 PLN. Start this week. Details: {link}" },
  referral: { uk: "{імʼя}, pryvedy druga na robotu v Polshchi i otrymai 300zl pislia yoho 10 zmin. Robota z zhytlom i doizdom. Detali: {лінк}", ru: "{имя}, privedi druga na rabotu v Polshe i poluchi 300zl posle ego 10 smen. Rabota s zhilyom i dovozom. Detali: {ссылка}", en: "{name}, bring a friend to work in Poland and get 300 PLN after their 10 shifts. Job with housing and transport. Details: {link}" },
};

function Wizard({ onClose, settings }: { onClose: () => void; settings?: Settings }) {
  const t = useT();
  const { data: factories = [] } = useQuery<Factory[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const { data: staff = [] } = useQuery<Staff[]>({ queryKey: ["staff"], queryFn: () => get("/staff") });
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [c, setC] = useState<Campaign | null>(null);
  const [form, setForm] = useState({ name: "", kind: "job" as "job" | "referral", provider: "smsapi" as "smsapi" | "smsfly", sender: settings?.sender ?? "EuroSupport", factoryId: "", city: "", rate: "", monthly: "до 6 500 zł/міс", housing: "від 450 zł", transport: "довіз на зміну", startDate: "", bonus: "300 zł", phone: settings?.officePhone ?? "", recruiterAdminId: "", days: [2, 3, 4] as number[], from: "10:00", to: "14:00", dailyLimit: 1500, batchSize: 200, testLimit: 300 });
  const [texts, setTexts] = useState<Record<string, string>>(TEXT_DEFAULTS.job!);
  useEffect(() => { setTexts(TEXT_DEFAULTS[form.kind]!); }, [form.kind]);
  const f = (k: keyof typeof form) => (e: any) => setForm((s) => ({ ...s, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: form.name, kind: form.kind, provider: form.provider, sender: form.sender, texts, recruiterAdminId: form.recruiterAdminId ? Number(form.recruiterAdminId) : null,
        offer: { factoryId: form.factoryId ? Number(form.factoryId) : null, city: form.city, rate: form.rate, monthly: form.monthly, housing: form.housing, transport: form.transport, startDate: form.startDate, bonus: form.bonus, phone: form.phone },
        schedule: { days: form.days, from: form.from, to: form.to, dailyLimit: Number(form.dailyLimit), batchSize: Number(form.batchSize), testLimit: Number(form.testLimit) || 300 } };
      return c ? patch<Campaign>(`/sms-campaigns/${c.id}`, body) : post<Campaign>("/sms-campaigns", body);
    },
    onSuccess: (x) => { setC(x); setStep((s) => (s === 1 ? 2 : 3)); },
    onError: (e: any) => toast.error(e?.message ?? t("Помилка")),
  });

  return (
    <Modal open onClose={onClose} title={`${t("Нова кампанія")} · ${t("крок")} ${step}/3`} size="xl">
      {step === 1 && (
        <div className="grid md:grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>{t("Назва")}</Label><Input value={form.name} onChange={f("name")} placeholder="Хвиля 1 · кандидати 2025–26" />
            <Label>{t("Тип")}</Label><Select value={form.kind} onChange={f("kind")}><option value="job">{t("Є робота")}</option><option value="referral">{t("Приведи друга")}</option></Select>
            <Label>{t("Фабрика пропозиції")}</Label><Select value={form.factoryId} onChange={f("factoryId")}><option value="">—</option>{factories.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
            <div className="grid grid-cols-2 gap-2"><div><Label>{t("Місто")}</Label><Input value={form.city} onChange={f("city")} placeholder="Lublin" /></div><div><Label>{t("Старт")}</Label><Input value={form.startDate} onChange={f("startDate")} placeholder="27.10" /></div></div>
            <div className="grid grid-cols-2 gap-2"><div><Label>{t("Ставка")}</Label><Input value={form.rate} onChange={f("rate")} /></div><div><Label>{t("На місяць")}</Label><Input value={form.monthly} onChange={f("monthly")} /></div></div>
            <div className="grid grid-cols-2 gap-2"><div><Label>{t("Житло")}</Label><Input value={form.housing} onChange={f("housing")} /></div><div><Label>{t("Довіз")}</Label><Input value={form.transport} onChange={f("transport")} /></div></div>
            <div className="grid grid-cols-2 gap-2"><div><Label>{t("Бонус за друга")}</Label><Input value={form.bonus} onChange={f("bonus")} /></div><div><Label>{t("Телефон офісу (на сторінці)")}</Label><Input value={form.phone} onChange={f("phone")} /></div></div>
          </div>
          <div className="space-y-2">
            <Label>{t("Провайдер")}</Label><Select value={form.provider} onChange={f("provider")}>{(settings?.providers ?? [{ name: "smsapi", configured: false }, { name: "smsfly", configured: false }]).map((p) => <option key={p.name} value={p.name}>{p.name === "smsfly" ? "SMS-Fly" : "SMSAPI"}{p.configured ? "" : ` (${t("ключ не задано")})`}</option>)}</Select>
            <Label>{t("Підпис відправника")}</Label><Input value={form.sender} onChange={f("sender")} />
            <Label>{t("Рекрутер кампанії")}</Label><Select value={form.recruiterAdminId} onChange={f("recruiterAdminId")}><option value="">—</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
            <Label>{t("Дні відправки")}</Label>
            <div className="flex gap-1">{DAYS.map((d) => <button key={d.v} type="button" onClick={() => setForm((s) => ({ ...s, days: s.days.includes(d.v) ? s.days.filter((x) => x !== d.v) : [...s.days, d.v].sort() }))} className={`px-2 py-1 rounded border text-xs ${form.days.includes(d.v) ? "bg-slate-900 text-white border-slate-900" : "border-slate-300"}`}>{d.l}</button>)}</div>
            <div className="grid grid-cols-2 gap-2"><div><Label>{t("З")}</Label><Input type="time" value={form.from} onChange={f("from")} /></div><div><Label>{t("До")}</Label><Input type="time" value={form.to} onChange={f("to")} /></div></div>
            <div className="grid grid-cols-3 gap-2"><div><Label>{t("Ліміт на день")}</Label><Input type="number" value={form.dailyLimit} onChange={f("dailyLimit")} /></div><div><Label>{t("Батч (кожні 5 хв)")}</Label><Input type="number" value={form.batchSize} onChange={f("batchSize")} /></div><div><Label>{t("Стеля тест-режиму")}</Label><Input type="number" value={form.testLimit} onChange={f("testLimit")} /></div></div>
          </div>
          <div className="md:col-span-2 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button><Button disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>{t("Далі: тексти")} →</Button></div>
        </div>
      )}
      {step === 2 && (
        <div className="space-y-3">
          {(["uk", "ru", "en"] as const).map((l) => { const p = smsParts(texts[l] ?? ""); return (
            <div key={l}>
              <div className="flex items-center justify-between"><Label>{l.toUpperCase()}</Label><span className={`text-xs ${p.parts > 2 ? "text-rose-600" : "text-slate-500"}`}>{p.chars} {t("зн.")} · {p.parts} SMS · {p.encoding}</span></div>
              <Textarea rows={3} value={texts[l] ?? ""} onChange={(e) => setTexts((s) => ({ ...s, [l]: e.target.value }))} />
            </div>
          ); })}
          <p className="text-xs text-slate-500">{t("Поля: {імʼя} / {name} / {имя} і {лінк} / {link} / {ссылка}. Кирилиця — 70 знаків на частину, латиниця — 160. Літери ł ą ę ś ż переводять усе повідомлення в режим 70 знаків: пишіть zl і PLN. Назву фірми не повторюйте — вона стоїть відправником.")}</p>
          <div className="flex justify-between"><Button variant="secondary" onClick={() => setStep(1)}>← {t("Назад")}</Button><Button disabled={save.isPending} onClick={() => save.mutate()}>{t("Далі: імпорт списку")} →</Button></div>
        </div>
      )}
      {step === 3 && c && <ImportStep campaignId={c.id} onDone={onClose} />}
    </Modal>
  );
}

// ── Крок 3: імпорт xlsx (dry-run → запис) ───────────────────────────────────
type ImportResp = { sheet: string; sheets: string[]; columns: string[]; guessed: Record<string, string>; mapping?: Record<string, string>; total: number; filteredOut?: number; summary?: { total: number; added: number; skipped: Record<string, number>; byLang: Record<string, number>; activeWorkers: number }; dry?: boolean; error?: string };
const SKIP_LABEL: Record<string, string> = { active_worker: "активні працівники → «приведи друга» в бот", duplicate: "дубль номера", invalid: "невалідний / стаціонарний", foreign: "закордонний", ua_excluded: "UA до 2024 (виключено)", already_sent: "уже отримував SMS в іншій кампанії" };

export function ImportStep({ campaignId, onDone }: { campaignId: number; onDone: () => void }) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [resp, setResp] = useState<ImportResp | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [sheet, setSheet] = useState("");
  const [includeUa, setIncludeUa] = useState(false);
  const [skipSent, setSkipSent] = useState(true);
  const [years, setYears] = useState("");
  const [langs, setLangs] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (dry: boolean) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("dry", dry ? "1" : "0"); fd.append("mapping", JSON.stringify(mapping)); if (sheet) fd.append("sheet", sheet);
      fd.append("includeUa", includeUa ? "1" : "0"); fd.append("skipAlreadySent", skipSent ? "1" : "0"); if (years) fd.append("years", years); if (langs) fd.append("langs", langs);
      const r = await upload<ImportResp>(`/sms-campaigns/${campaignId}/import`, fd);
      setResp(r); if (r.mapping) setMapping(r.mapping); if (!sheet) setSheet(r.sheet);
      if (!dry && r.summary) { toast.success(`${t("Додано")}: ${r.summary.added}`); onDone(); }
    } catch (e: any) { toast.error(e?.message ?? t("Помилка імпорту")); } finally { setBusy(false); }
  };
  const fields = useMemo(() => [["phone", t("Телефон")], ["name", t("Імʼя (або повне)")], ["lastName", t("Прізвище (окремо, якщо є)")], ["lang", t("Мова")], ["segment", t("Сегмент")], ["year", t("Рік")]], [t]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResp(null); }} className="text-sm text-slate-500 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:text-slate-700" />
        <Button variant="secondary" disabled={!file || busy} onClick={() => run(true)}><Upload size={16} /> {t("Перевірити")}</Button>
      </div>
      {resp && (
        <>
          {resp.sheets.length > 1 && <div><Label>{t("Аркуш")}</Label><Select value={sheet || resp.sheet} onChange={(e) => { setSheet(e.target.value); }}>{resp.sheets.map((s) => <option key={s}>{s}</option>)}</Select></div>}
          <div className="grid md:grid-cols-3 gap-2">
            {fields.map(([k, l]) => <div key={k}><Label>{l}</Label><Select value={mapping[k] ?? resp.guessed[k] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [k]: e.target.value }))}><option value="">—</option>{resp.columns.map((c) => <option key={c} value={c}>{c}</option>)}</Select></div>)}
          </div>
          <div className="grid md:grid-cols-4 gap-2 items-end">
            <div><Label>{t("Роки (через кому)")}</Label><Input value={years} onChange={(e) => setYears(e.target.value)} placeholder="2025,2026" /></div>
            <div><Label>{t("Мови (через кому)")}</Label><Input value={langs} onChange={(e) => setLangs(e.target.value)} placeholder="uk,ru,en,?" /></div>
            <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={includeUa} onChange={(e) => setIncludeUa(e.target.checked)} /> {t("слати на +380 незалежно від року")}</label>
            <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={skipSent} onChange={(e) => setSkipSent(e.target.checked)} /> {t("пропускати тих, кому вже слали")}</label>
          </div>
          {resp.error && <div className="text-sm text-rose-600">{resp.error}</div>}
          {resp.summary && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <Card className="p-2"><b className="text-xl">{resp.total}</b><div className="text-slate-500">{t("рядків у файлі")}{resp.filteredOut ? ` · ${t("поза фільтром")}: ${resp.filteredOut}` : ""}</div></Card>
              <Card className="p-2"><b className="text-xl text-emerald-700">{resp.summary.added}</b><div className="text-slate-500">{t("буде додано")} · {Object.entries(resp.summary.byLang).map(([l, n]) => `${l} ${n}`).join(", ")}</div></Card>
              {Object.entries(resp.summary.skipped).map(([k, n]) => <Card key={k} className="p-2"><b className="text-xl">{n}</b><div className="text-slate-500">{t(SKIP_LABEL[k] ?? k)}</div></Card>)}
            </div>
          )}
          <div className="flex justify-between">
            <Button variant="secondary" disabled={!file || busy} onClick={() => run(true)}>{t("Перерахувати")}</Button>
            <Button disabled={!file || busy || !resp.summary || !!resp.error} onClick={() => run(false)}>{t("Додати до кампанії")} ({resp.summary?.added ?? 0})</Button>
          </div>
        </>
      )}
      <p className="text-xs text-slate-500">{t("Перевірка та сама, що в таблиці Drive-контактів: мобільні PL/UA/BY, підозрілі послідовності, дублі. Активні працівники SMS не отримують — вони йдуть у бот-список «приведи друга».")}</p>
    </div>
  );
}
