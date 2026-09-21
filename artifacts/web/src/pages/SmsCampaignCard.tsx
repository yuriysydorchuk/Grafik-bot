// Картка SMS-кампанії (/sms-campaigns/:id): плитки воронки, дії (запуск/тест/пауза/закрити,
// тест-SMS, батч зараз, експорт), вкладки Отримувачі / Тексти / Сторінка / Розклад / Імпорт.
import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Pause, Square, Send, Download, FlaskConical, ArrowLeft, Users } from "lucide-react";
import { toast } from "sonner";
import { get, post, patch } from "../lib/api";
import { Button, Input, Select, Card, Spinner, Badge, Label, Modal, Textarea } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useT } from "../lib/i18n";
import { smsParts, SMS_STATUS_LABEL, SMS_STATUS_COLOR, SMS_CAMPAIGN_STATUS } from "../lib/smsParts";
import { FunnelBar, ImportStep, type Campaign } from "./SmsCampaigns";

type Recipient = { id: number; phone: string; name: string | null; firstName: string | null; lang: string; segment: string | null; year: number | null; status: string; skippedReason: string | null; sentAt: string | null; deliveredAt: string | null; failReason: string | null; viewedAt: string | null; botAt: string | null; parts: number | null; candidateId: number | null; candidateStage: string | null; link: string; workerId: number | null };
type Ev = { id: number; kind: string; at: string; device: string | null; meta: any };
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
type Tab = "recipients" | "texts" | "landing" | "schedule" | "import";

export default function SmsCampaignCard() {
  const t = useT();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [, params] = useRoute("/sms-campaigns/:id");
  const id = Number(params?.id);
  const { data: c, isLoading } = useQuery<Campaign>({ queryKey: ["sms-campaign", id], queryFn: () => get(`/sms-campaigns/${id}`), refetchInterval: 30000 });
  const { data: me } = useQuery<any>({ queryKey: ["me"], queryFn: () => get("/auth/me") });
  const isMain = !!me?.isMain;
  const [tab, setTab] = useState<Tab>("recipients");
  const [testOpen, setTestOpen] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testLang, setTestLang] = useState("uk");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["sms-campaign", id] }); qc.invalidateQueries({ queryKey: ["sms-recipients", id] }); qc.invalidateQueries({ queryKey: ["sms-campaigns"] }); };
  const act = useMutation({ mutationFn: (p: { path: string; body?: any }) => post(`/sms-campaigns/${id}/${p.path}`, p.body), onSuccess: (r: any, v) => { refresh(); if (v.path === "send-batch") toast.success(`${t("Відправлено")}: ${r.sent}, ${t("помилок")}: ${r.failed}, ${t("у черзі")}: ${r.remaining}`); if (v.path === "test-sms") toast[r.ok ? "success" : "error"](r.ok ? `${t("Тест надіслано")} (${r.parts} SMS)` : r.error); if (v.path === "referral-active") toast.success(`${t("Надіслано в бот")}: ${r.notified}, ${t("пропущено")}: ${r.skipped}`); }, onError: (e: any) => toast.error(e?.message ?? t("Помилка")) });

  if (isLoading || !c) return <Spinner />;
  const s = c.stats;
  const pct = (n: number, d: number) => (d ? ` · ${Math.round((n / d) * 100)}%` : "");
  const st = SMS_CAMPAIGN_STATUS[c.status];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/sms-campaigns" className="text-slate-500 hover:text-slate-900"><ArrowLeft size={18} /></Link>
        <h1 className="text-xl font-bold">{c.name}</h1>
        <Badge color={st?.color ?? "slate"}>{t(st?.label ?? c.status)}</Badge>
        {c.inFlight && <Badge color="amber">{t("батч іде")}</Badge>}
        <span className="flex-1" />
        {isMain && (c.status === "draft" || c.status === "paused") && <Button variant="secondary" onClick={async () => { if (await confirm({ title: t("Запустити тестову відправку?"), message: t("Черга піде батчами у вікні розкладу."), confirmText: t("Тест") })) act.mutate({ path: "start", body: { mode: "test" } }); }}><FlaskConical size={16} /> {t("Тест")}</Button>}
        {isMain && (c.status === "draft" || c.status === "paused" || c.status === "test") && <Button onClick={async () => { if (await confirm({ title: t("Запустити відправку?"), message: `${s.queued} SMS · ~${(s.queued * (c.provider === "smsfly" ? 0.07 : 0.1)).toFixed(0)} zł. ${t("Це незворотно.")}`, confirmText: t("Запустити"), danger: true })) act.mutate({ path: "start", body: { mode: "sending" } }); }}><Play size={16} /> {t("Запустити")}</Button>}
        {(c.status === "sending" || c.status === "test") && <Button variant="secondary" onClick={() => act.mutate({ path: "pause" })}><Pause size={16} /> {t("Пауза")}</Button>}
        {isMain && ["sending", "test", "paused"].includes(c.status) && <Button variant="secondary" onClick={() => act.mutate({ path: "send-batch" })}><Send size={16} /> {t("Батч зараз")}</Button>}
        {isMain && <Button variant="secondary" onClick={() => setTestOpen(true)}>{t("Тест на мій номер")}</Button>}
        {(c.activeWorkersPending ?? 0) > 0 && <Button variant="secondary" onClick={async () => { if (await confirm({ title: t("Надіслати «приведи друга» активним працівникам?"), message: `${c.activeWorkersPending} ${t("людей з імпорту — це наші активні працівники; вони отримають реферальну розсилку в боті (не SMS)")}`, confirmText: t("Надіслати") })) act.mutate({ path: "referral-active" }); }}><Users size={16} /> {t("Приведи друга активним")} ({c.activeWorkersPending})</Button>}
        <a href={`/api/sms-campaigns/${id}/export.xlsx`} className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-md border border-slate-300"><Download size={16} /> xlsx</a>
        {s.cta > 0 && <a href={`/api/sms-campaigns/${id}/export.xlsx?status=cta`} className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-md border border-slate-300"><Download size={16} /> {t("на обдзвон")} ({s.cta})</a>}
        {c.status !== "closed" && <Button variant="secondary" onClick={async () => { if (await confirm({ title: t("Закрити кампанію?"), message: t("Відправка зупиниться."), confirmText: t("Закрити"), danger: true })) act.mutate({ path: "close" }); }}><Square size={16} /> {t("Закрити")}</Button>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-9 gap-2">
        {[[s.recipients, t("отримувачів")], [s.sent, t("відправлено")], [s.delivered, t("доставлено") + pct(s.delivered, s.sent)], [s.viewed, t("відкрили сторінку") + pct(s.viewed, s.delivered)], [s.cta, t("зацікавлені") + pct(s.cta, s.viewed)], [s.bot, t("зайшли в бот")], [s.form, t("анкети")], [s.hired, t("на зміні")], [`~${s.costEstimate} zł`, `${t("витрати")} · ${s.parts} ${t("частин")}`]].map(([n, l], i) => (
          <Card key={i} className="p-3"><div className="text-2xl font-bold tabular-nums">{n as any}</div><div className="text-xs text-slate-500">{l as string}</div></Card>
        ))}
      </div>
      <div className="flex items-center gap-3"><FunnelBar s={s} width={520} /><span className="text-xs text-slate-500">{t("у черзі")}: {s.queued} · {t("не доставлено")}: {s.failed} · {t("пропущено")}: {s.skipped} ({t("активних працівників")}: {s.activeWorkers}) · {t("кандидатів")}: {c.candidates}</span></div>

      <div className="flex gap-2 border-b border-slate-200">
        {([["recipients", t("Отримувачі")], ["texts", t("Тексти SMS")], ["landing", t("Сторінка")], ["schedule", t("Розклад і пропозиція")], ["import", t("Імпорт")]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === k ? "border-red-600 font-semibold" : "border-transparent text-slate-500"}`}>{l}</button>
        ))}
      </div>

      {tab === "recipients" && <Recipients id={id} />}
      {tab === "texts" && <TextsTab c={c} onSaved={refresh} />}
      {tab === "landing" && <LandingTab c={c} onSaved={refresh} />}
      {tab === "schedule" && <ScheduleTab c={c} onSaved={refresh} />}
      {tab === "import" && <Card className="p-4"><ImportStep campaignId={id} onDone={refresh} /></Card>}

      <Modal open={testOpen} onClose={() => setTestOpen(false)} title={t("Тест на мій номер")}>
        <div className="space-y-2">
          <Label>{t("Телефон")}</Label><Input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="+48 …" />
          <Label>{t("Мова")}</Label><Select value={testLang} onChange={(e) => setTestLang(e.target.value)}><option value="uk">uk</option><option value="ru">ru</option><option value="en">en</option></Select>
          <div className="text-xs text-slate-500">{t("Реальне SMS через провайдера кампанії")} ({c.provider}). {t("Лінк у тесті — фіктивний токен.")}</div>
          <div className="flex justify-end"><Button onClick={() => { act.mutate({ path: "test-sms", body: { phone: testPhone, lang: testLang, name: me?.name ?? "Test" } }); setTestOpen(false); }}>{t("Надіслати")}</Button></div>
        </div>
      </Modal>
    </div>
  );
}

function Recipients({ id }: { id: number }) {
  const t = useT();
  const [status, setStatus] = useState(""); const [lang, setLang] = useState(""); const [q, setQ] = useState(""); const [page, setPage] = useState(0);
  const limit = 100;
  const { data, isLoading } = useQuery<{ total: number; rows: Recipient[] }>({ queryKey: ["sms-recipients", id, status, lang, q, page], queryFn: () => get(`/sms-campaigns/${id}/recipients?status=${status}&lang=${lang}&q=${encodeURIComponent(q)}&limit=${limit}&offset=${page * limit}`) });
  const [evFor, setEvFor] = useState<Recipient | null>(null);
  const { data: events } = useQuery<Ev[]>({ queryKey: ["sms-events", evFor?.id], enabled: !!evFor, queryFn: () => get(`/sms-campaigns/${id}/recipients/${evFor!.id}/events`) });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} className="w-auto"><option value="">{t("Статус: усі")}</option>{Object.entries(SMS_STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</Select>
        <Select value={lang} onChange={(e) => { setLang(e.target.value); setPage(0); }} className="w-auto"><option value="">{t("Мова: усі")}</option><option value="uk">uk</option><option value="ru">ru</option><option value="en">en</option></Select>
        <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder={t("Пошук: телефон / імʼя")} className="w-56" />
        <span className="flex-1" /><span className="text-sm text-slate-500 self-center">{data?.total ?? 0} {t("рядків")}</span>
      </div>
      {isLoading ? <Spinner /> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500 border-b border-slate-200">{[t("Імʼя"), t("Телефон"), t("Мова"), t("Сегмент · рік"), t("Статус"), t("Відправлено"), t("Доставлено"), t("Відкрив"), t("У боті"), t("Кандидат"), ""].map((h, i) => <th key={i} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>{(data?.rows ?? []).map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="px-3 py-1.5"><button className="hover:underline text-left" onClick={() => setEvFor(r)}>{r.name || <span className="text-slate-400">—</span>}</button></td>
                <td className="px-3 py-1.5 tabular-nums">{r.phone}</td>
                <td className="px-3 py-1.5"><Badge>{r.lang}</Badge></td>
                <td className="px-3 py-1.5 text-slate-500">{r.segment ?? "—"}{r.year ? ` · ${r.year}` : ""}</td>
                <td className="px-3 py-1.5"><Badge color={SMS_STATUS_COLOR[r.status] ?? "slate"}>{t(SMS_STATUS_LABEL[r.status] ?? r.status)}</Badge>{r.skippedReason && <div className="text-xs text-slate-400">{r.skippedReason}</div>}{r.failReason && <div className="text-xs text-rose-500">{r.failReason}</div>}</td>
                <td className="px-3 py-1.5 text-slate-500">{fmt(r.sentAt)}</td><td className="px-3 py-1.5 text-slate-500">{fmt(r.deliveredAt)}</td><td className="px-3 py-1.5 text-slate-500">{fmt(r.viewedAt)}</td><td className="px-3 py-1.5 text-slate-500">{fmt(r.botAt)}</td>
                <td className="px-3 py-1.5">{r.candidateId ? <Link href="/recruitment" className="underline">#{r.candidateId}{r.candidateStage ? ` · ${r.candidateStage}` : ""}</Link> : r.workerId ? <span className="text-slate-400">{t("працівник")} #{r.workerId}</span> : "—"}</td>
                <td className="px-3 py-1.5"><a href={r.link} target="_blank" rel="noreferrer" className="text-xs text-slate-400 hover:text-slate-700">{t("лінк")}</a></td>
              </tr>
            ))}</tbody>
          </table>
        </Card>
      )}
      <div className="flex gap-2 justify-end"><Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>←</Button><Button variant="secondary" disabled={(page + 1) * limit >= (data?.total ?? 0)} onClick={() => setPage((p) => p + 1)}>→</Button></div>
      <Modal open={!!evFor} onClose={() => setEvFor(null)} title={`${evFor?.name ?? evFor?.phone ?? ""} · ${t("журнал")}`}>
        {!events ? <Spinner /> : !events.length ? <div className="text-sm text-slate-500">{t("Подій ще немає")}</div> : (
          <table className="w-full text-sm"><tbody>{events.map((e) => <tr key={e.id} className="border-b border-slate-100"><td className="py-1 text-slate-500 whitespace-nowrap">{fmt(e.at)}</td><td className="py-1 font-medium">{e.kind}</td><td className="py-1 text-slate-500">{e.device ?? ""}{e.meta ? ` ${JSON.stringify(e.meta)}` : ""}</td></tr>)}</tbody></table>
        )}
      </Modal>
    </div>
  );
}

function TextsTab({ c, onSaved }: { c: Campaign; onSaved: () => void }) {
  const t = useT();
  const [texts, setTexts] = useState<Record<string, string>>({ ...c.texts });
  const save = useMutation({ mutationFn: () => patch(`/sms-campaigns/${c.id}`, { texts }), onSuccess: () => { toast.success(t("Збережено")); onSaved(); } });
  return (
    <Card className="p-4 space-y-3">
      {(["uk", "ru", "en"] as const).map((l) => { const p = smsParts(texts[l] ?? ""); return (
        <div key={l}><div className="flex items-center justify-between"><Label>{l.toUpperCase()}</Label><span className={`text-xs ${p.parts > 2 ? "text-rose-600" : "text-slate-500"}`}>{p.chars} {t("зн.")} · {p.parts} SMS · {p.encoding}</span></div><Textarea rows={3} value={texts[l] ?? ""} onChange={(e) => setTexts((s) => ({ ...s, [l]: e.target.value }))} /></div>
      ); })}
      <div className="flex justify-end"><Button disabled={save.isPending} onClick={() => save.mutate()}>{t("Зберегти")}</Button></div>
    </Card>
  );
}

function LandingTab({ c, onSaved }: { c: Campaign; onSaved: () => void }) {
  const t = useT();
  const [ld, setLd] = useState<any>({ title: {}, about: {}, give: {}, chips: [], faq: [], photos: [], buttons: { call: true, whatsapp: true }, ...(c.landing ?? {}) });
  const save = useMutation({ mutationFn: () => patch(`/sms-campaigns/${c.id}`, { landing: ld }), onSuccess: () => { toast.success(t("Збережено")); onSaved(); } });
  const tri = (key: "title" | "about" | "give", label: string) => (
    <div className="grid md:grid-cols-3 gap-2">{(["uk", "ru", "en"] as const).map((l) => <div key={l}><Label>{label} · {l}</Label><Textarea rows={2} value={ld[key]?.[l] ?? ""} onChange={(e) => setLd((s: any) => ({ ...s, [key]: { ...(s[key] ?? {}), [l]: e.target.value } }))} /></div>)}</div>
  );
  return (
    <Card className="p-4 space-y-3">
      <p className="text-xs text-slate-500">{t("Плитки вакансій → опис і переваги → «Мене цікавить» (телефон уже відомий, рекрутер отримує картку в бот) і «Порекомендувати друга» (імʼя + телефон → кандидат у воронці). Без вакансій сторінка показує одну з пропозиції кампанії. Порожні контакти → дані офісу.")}</p>
      {tri("title", t("Заголовок"))}{tri("about", t("Що за робота"))}{tri("give", t("Що ми даємо"))}
      <div><Label>{t("Чіпи вигод (через ;)")}</Label><Input value={(ld.chips ?? []).join("; ")} onChange={(e) => setLd((s: any) => ({ ...s, chips: e.target.value.split(";").map((x: string) => x.trim()).filter(Boolean) }))} /></div>
      <div className="grid md:grid-cols-3 gap-2">
        <div><Label>{t("Міста (через ;)")}</Label><Input value={(ld.cities ?? []).join("; ")} placeholder={t("порожньо — міста фабрик")} onChange={(e) => setLd((s: any) => ({ ...s, cities: e.target.value.split(";").map((x: string) => x.trim()).filter(Boolean) }))} /></div>
        <div><Label>{t("Хто передзвонить")}</Label><Input value={ld.recruiterName ?? ""} placeholder="Володимир" onChange={(e) => setLd((s: any) => ({ ...s, recruiterName: e.target.value }))} /></div>
        <div><Label>{t("Години дзвінків")}</Label><Input value={ld.hours ?? ""} placeholder="10–17" onChange={(e) => setLd((s: any) => ({ ...s, hours: e.target.value }))} /></div>
      </div>
      <VacanciesEditor value={ld.vacancies ?? []} onChange={(v) => setLd((s: any) => ({ ...s, vacancies: v }))} />
      <div className="grid md:grid-cols-3 gap-2">
        {([["phone", t("Телефон на сторінці"), "+48 792 991 524"], ["address", t("Адреса"), "ul. Krakowskie Przedmieście 55, 20-076 Lublin"], ["maps", "Google Maps (URL)", ""], ["site", t("Сайт"), "https://eurosupp.pl/"], ["instagram", "Instagram (URL)", "https://instagram.com/euro_support_"], ["facebook", "Facebook (URL)", ""]] as const).map(([k, l, ph]) => (
          <div key={k}><Label>{l}</Label><Input value={ld.contacts?.[k] ?? ""} placeholder={ph} onChange={(e) => setLd((s: any) => ({ ...s, contacts: { ...(s.contacts ?? {}), [k]: e.target.value } }))} /></div>
        ))}
      </div>
      <div><Label>{t("Фото (URL через ;)")}</Label><Input value={(ld.photos ?? []).join("; ")} onChange={(e) => setLd((s: any) => ({ ...s, photos: e.target.value.split(";").map((x: string) => x.trim()).filter(Boolean) }))} /></div>
      <div className="flex gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={ld.buttons?.call !== false} onChange={(e) => setLd((s: any) => ({ ...s, buttons: { ...s.buttons, call: e.target.checked } }))} /> {t("кнопка «Подзвонити»")}</label><label className="flex items-center gap-2"><input type="checkbox" checked={ld.buttons?.whatsapp !== false} onChange={(e) => setLd((s: any) => ({ ...s, buttons: { ...s.buttons, whatsapp: e.target.checked } }))} /> WhatsApp</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={ld.buttons?.telegram === true} onChange={(e) => setLd((s: any) => ({ ...s, buttons: { ...s.buttons, telegram: e.target.checked } }))} /> {t("лінк у Telegram-бот (вимкнено — без форми, лише обдзвон)")}</label></div>
      <div className="flex justify-end"><Button disabled={save.isPending} onClick={() => save.mutate()}>{t("Зберегти")}</Button></div>
    </Card>
  );
}

function ScheduleTab({ c, onSaved }: { c: Campaign; onSaved: () => void }) {
  const t = useT();
  const [sch, setSch] = useState({ ...c.schedule });
  const [offer, setOffer] = useState<Record<string, any>>({ ...c.offer });
  const [meta, setMeta] = useState({ name: c.name, provider: c.provider, sender: c.sender });
  const { data: factories = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["factories"], queryFn: () => get("/factories") });
  const { data: staff = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ["staff"], queryFn: () => get("/staff") });
  const [rec, setRec] = useState(c.recruiterAdminId ? String(c.recruiterAdminId) : "");
  const save = useMutation({ mutationFn: () => patch(`/sms-campaigns/${c.id}`, { ...meta, schedule: { ...sch, dailyLimit: Number(sch.dailyLimit), batchSize: Number(sch.batchSize) }, offer, recruiterAdminId: rec ? Number(rec) : null }), onSuccess: () => { toast.success(t("Збережено")); onSaved(); } });
  const DAYS = [[1, "Пн"], [2, "Вт"], [3, "Ср"], [4, "Чт"], [5, "Пт"], [6, "Сб"], [7, "Нд"]] as const;
  const o = (k: string) => (e: any) => setOffer((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Card className="p-4 grid md:grid-cols-2 gap-3">
      <div className="space-y-2">
        <Label>{t("Назва")}</Label><Input value={meta.name} onChange={(e) => setMeta((s) => ({ ...s, name: e.target.value }))} />
        <Label>{t("Провайдер")}</Label><Select value={meta.provider} onChange={(e) => setMeta((s) => ({ ...s, provider: e.target.value as any }))}><option value="smsapi">SMSAPI</option><option value="smsfly">SMS-Fly</option></Select>
        <Label>{t("Підпис відправника")}</Label><Input value={meta.sender} onChange={(e) => setMeta((s) => ({ ...s, sender: e.target.value }))} />
        <Label>{t("Рекрутер кампанії")}</Label><Select value={rec} onChange={(e) => setRec(e.target.value)}><option value="">—</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Label>{t("Дні відправки")}</Label>
        <div className="flex gap-1">{DAYS.map(([v, l]) => <button key={v} type="button" onClick={() => setSch((s) => ({ ...s, days: s.days.includes(v) ? s.days.filter((x) => x !== v) : [...s.days, v].sort() }))} className={`px-2 py-1 rounded border text-xs ${sch.days.includes(v) ? "bg-slate-900 text-white border-slate-900" : "border-slate-300"}`}>{l}</button>)}</div>
        <div className="grid grid-cols-2 gap-2"><div><Label>{t("З")}</Label><Input type="time" value={sch.from} onChange={(e) => setSch((s) => ({ ...s, from: e.target.value }))} /></div><div><Label>{t("До")}</Label><Input type="time" value={sch.to} onChange={(e) => setSch((s) => ({ ...s, to: e.target.value }))} /></div></div>
        <div className="grid grid-cols-2 gap-2"><div><Label>{t("Ліміт на день")}</Label><Input type="number" value={sch.dailyLimit} onChange={(e) => setSch((s) => ({ ...s, dailyLimit: Number(e.target.value) }))} /></div><div><Label>{t("Батч (кожні 5 хв)")}</Label><Input type="number" value={sch.batchSize} onChange={(e) => setSch((s) => ({ ...s, batchSize: Number(e.target.value) }))} /></div></div>
      </div>
      <div className="space-y-2">
        <Label>{t("Фабрика пропозиції")}</Label><Select value={offer.factoryId ?? ""} onChange={(e) => setOffer((s) => ({ ...s, factoryId: e.target.value ? Number(e.target.value) : null }))}><option value="">—</option>{factories.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <div className="grid grid-cols-2 gap-2"><div><Label>{t("Місто")}</Label><Input value={offer.city ?? ""} onChange={o("city")} /></div><div><Label>{t("Старт")}</Label><Input value={offer.startDate ?? ""} onChange={o("startDate")} /></div></div>
        <div className="grid grid-cols-2 gap-2"><div><Label>{t("Ставка")}</Label><Input value={offer.rate ?? ""} onChange={o("rate")} /></div><div><Label>{t("На місяць")}</Label><Input value={offer.monthly ?? ""} onChange={o("monthly")} /></div></div>
        <div className="grid grid-cols-2 gap-2"><div><Label>{t("Житло")}</Label><Input value={offer.housing ?? ""} onChange={o("housing")} /></div><div><Label>{t("Довіз")}</Label><Input value={offer.transport ?? ""} onChange={o("transport")} /></div></div>
        <div className="grid grid-cols-2 gap-2"><div><Label>{t("Бонус за друга")}</Label><Input value={offer.bonus ?? ""} onChange={o("bonus")} /></div><div><Label>{t("Телефон офісу")}</Label><Input value={offer.phone ?? ""} onChange={o("phone")} /></div></div>
        <div><Label>WhatsApp</Label><Input value={offer.whatsapp ?? ""} onChange={o("whatsapp")} placeholder="+48 …" /></div>
      </div>
      <div className="md:col-span-2 flex justify-end"><Button disabled={save.isPending} onClick={() => save.mutate()}>{t("Зберегти")}</Button></div>
    </Card>
  );
}

// Редактор вакансій сторінки: плитки з назвою 3 мовами, містом, ставкою/житлом/довозом/змінами,
// коротким описом і перевагами (через ;). Порожній список → одна вакансія з пропозиції кампанії.
type Vac = { id: string; title: Record<string, string>; city?: string; rate?: string; housing?: string; transport?: string; shifts?: string; desc?: Record<string, string>; perks?: string[]; photo?: string };
function VacanciesEditor({ value, onChange }: { value: Vac[]; onChange: (v: Vac[]) => void }) {
  const t = useT();
  const upd = (i: number, patch: Partial<Vac>) => onChange(value.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const add = () => onChange([...value, { id: `v${Date.now().toString(36)}`, title: {}, desc: {}, perks: [] }]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between"><Label>{t("Вакансії на сторінці")} ({value.length})</Label><Button variant="secondary" onClick={add}>+ {t("Додати вакансію")}</Button></div>
      {value.map((v, i) => (
        <div key={v.id} className="rounded-lg border border-slate-200 p-3 space-y-2">
          <div className="grid md:grid-cols-3 gap-2">
            {(["uk", "ru", "en"] as const).map((l) => <div key={l}><Label>{t("Назва")} · {l}</Label><Input value={v.title?.[l] ?? ""} onChange={(e) => upd(i, { title: { ...(v.title ?? {}), [l]: e.target.value } })} /></div>)}
          </div>
          <div className="grid md:grid-cols-5 gap-2">
            <div><Label>{t("Місто")}</Label><Input value={v.city ?? ""} onChange={(e) => upd(i, { city: e.target.value })} /></div>
            <div><Label>{t("Ставка")}</Label><Input value={v.rate ?? ""} placeholder="31 zł/год" onChange={(e) => upd(i, { rate: e.target.value })} /></div>
            <div><Label>{t("Житло")}</Label><Input value={v.housing ?? ""} placeholder="від 450 zł" onChange={(e) => upd(i, { housing: e.target.value })} /></div>
            <div><Label>{t("Довіз")}</Label><Input value={v.transport ?? ""} placeholder={t("довіз на зміну")} onChange={(e) => upd(i, { transport: e.target.value })} /></div>
            <div><Label>{t("Зміни")}</Label><Input value={v.shifts ?? ""} placeholder="2 зміни / 12 год" onChange={(e) => upd(i, { shifts: e.target.value })} /></div>
          </div>
          <div className="grid md:grid-cols-3 gap-2">
            {(["uk", "ru", "en"] as const).map((l) => <div key={l}><Label>{t("Короткий опис")} · {l}</Label><Textarea rows={2} value={v.desc?.[l] ?? ""} onChange={(e) => upd(i, { desc: { ...(v.desc ?? {}), [l]: e.target.value } })} /></div>)}
          </div>
          <div className="grid md:grid-cols-[1fr_auto] gap-2 items-end">
            <div><Label>{t("Переваги (через ;)")}</Label><Input value={(v.perks ?? []).join("; ")} placeholder={t("Житло біля фабрики; Довіз; Аванс після 2 тижнів")} onChange={(e) => upd(i, { perks: e.target.value.split(";").map((x) => x.trim()).filter(Boolean) })} /></div>
            <div><Label>{t("Фото (URL)")}</Label><Input value={v.photo ?? ""} onChange={(e) => upd(i, { photo: e.target.value })} /></div>
          </div>
          <div className="flex justify-end"><Button variant="secondary" onClick={() => onChange(value.filter((_, j) => j !== i))}>{t("Прибрати")}</Button></div>
        </div>
      ))}
    </div>
  );
}
