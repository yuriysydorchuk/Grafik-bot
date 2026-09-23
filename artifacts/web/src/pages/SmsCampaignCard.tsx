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
import { smsParts, SMS_STATUS_LABEL, SMS_STATUS_COLOR, SMS_CAMPAIGN_STATUS, SMS_EVENT_LABEL } from "../lib/smsParts";
import { FunnelBar, ImportStep, type Campaign } from "./SmsCampaigns";

type Recipient = { id: number; phone: string; name: string | null; firstName: string | null; lang: string; segment: string | null; year: number | null; status: string; skippedReason: string | null; sentAt: string | null; deliveredAt: string | null; failReason: string | null; viewedAt: string | null; botAt: string | null; parts: number | null; candidateId: number | null; candidateStage: string | null; link: string; workerId: number | null ; secondsOnPage?: number };
type Ev = { id: number; kind: string; at: string; device: string | null; meta: any };
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
type Tab = "recipients" | "analytics" | "texts" | "landing" | "schedule" | "import";

export default function SmsCampaignCard() {
  const t = useT();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [, params] = useRoute("/sms-campaigns/:id");
  const id = Number(params?.id);
  const validId = Number.isInteger(id) && id > 0; // /sms-campaigns/null із застарілого лінка не має бити в API
  const { data: c, isLoading } = useQuery<Campaign>({ queryKey: ["sms-campaign", id], enabled: validId, queryFn: () => get(`/sms-campaigns/${id}`), refetchInterval: 30000 });
  const { data: me } = useQuery<any>({ queryKey: ["me"], queryFn: () => get("/auth/me") });
  const isMain = !!me?.isMain;
  const [tab, setTab] = useState<Tab>("recipients");
  const [testOpen, setTestOpen] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testLang, setTestLang] = useState("uk");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["sms-campaign", id] }); qc.invalidateQueries({ queryKey: ["sms-recipients", id] }); qc.invalidateQueries({ queryKey: ["sms-campaigns"] }); };
  const act = useMutation({ mutationFn: (p: { path: string; body?: any }) => post(`/sms-campaigns/${id}/${p.path}`, p.body), onSuccess: (r: any, v) => { refresh(); if (v.path === "send-batch") toast.success(`${t("Відправлено")}: ${r.sent}, ${t("помилок")}: ${r.failed}, ${t("у черзі")}: ${r.remaining}`); if (v.path === "test-sms") toast[r.ok ? "success" : "error"](r.ok ? `${t("Тест надіслано")} (${r.parts} SMS)` : r.error); if (v.path === "referral-active") toast.success(`${t("Надіслано в бот")}: ${r.notified}, ${t("пропущено")}: ${r.skipped}`); }, onError: (e: any) => toast.error(e?.message ?? t("Помилка")) });

  if (!validId) return <Card className="p-6 text-center text-slate-500">{t("Кампанію не знайдено")}</Card>;
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
        {isMain && (c.status === "draft" || c.status === "paused") && <Button variant="secondary" onClick={async () => { if (await confirm({ title: t("Запустити тестову відправку?"), message: `${t("Черга піде батчами у вікні розкладу.")} ${t("Стеля тест-режиму")}: ${c.schedule.testLimit ?? 300} SMS, далі пауза.`, confirmText: t("Тест") })) act.mutate({ path: "start", body: { mode: "test" } }); }}><FlaskConical size={16} /> {t("Тест")}</Button>}
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
        {([["recipients", t("Отримувачі")], ["analytics", t("Аналітика")], ["texts", t("Тексти SMS")], ["landing", t("Сторінка")], ["schedule", t("Розклад і пропозиція")], ["import", t("Імпорт")]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === k ? "border-red-600 font-semibold" : "border-transparent text-slate-500"}`}>{l}</button>
        ))}
      </div>

      {tab === "recipients" && <Recipients id={id} />}
      {tab === "texts" && <TextsTab c={c} onSaved={refresh} />}
      {tab === "landing" && <LandingTab c={c} onSaved={refresh} />}
      {tab === "schedule" && <ScheduleTab c={c} onSaved={refresh} />}
      {tab === "import" && <Card className="p-4"><ImportStep campaignId={id} onDone={refresh} /></Card>}
      {tab === "analytics" && <AnalyticsTab id={id} />}

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
            <thead><tr className="text-left text-slate-500 border-b border-slate-200">{[t("Імʼя"), t("Телефон"), t("Мова"), t("Сегмент · рік"), t("Статус"), t("Відправлено"), t("Доставлено"), t("Відкрив"), t("на сторінці"), t("У боті"), t("Кандидат"), ""].map((h, i) => <th key={i} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>{(data?.rows ?? []).map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="px-3 py-1.5"><button className="hover:underline text-left" onClick={() => setEvFor(r)}>{r.name || <span className="text-slate-400">—</span>}</button></td>
                <td className="px-3 py-1.5 tabular-nums">{r.phone}</td>
                <td className="px-3 py-1.5"><Badge>{r.lang}</Badge></td>
                <td className="px-3 py-1.5 text-slate-500">{r.segment ?? "—"}{r.year ? ` · ${r.year}` : ""}</td>
                <td className="px-3 py-1.5"><Badge color={SMS_STATUS_COLOR[r.status] ?? "slate"}>{t(SMS_STATUS_LABEL[r.status] ?? r.status)}</Badge>{r.skippedReason && <div className="text-xs text-slate-400">{r.skippedReason}</div>}{r.failReason && <div className="text-xs text-rose-500">{r.failReason}</div>}</td>
                <td className="px-3 py-1.5 text-slate-500">{fmt(r.sentAt)}</td><td className="px-3 py-1.5 text-slate-500">{fmt(r.deliveredAt)}</td><td className="px-3 py-1.5 text-slate-500">{fmt(r.viewedAt)}</td><td className="px-3 py-1.5 text-slate-500 tabular-nums">{r.secondsOnPage == null ? "—" : r.secondsOnPage < 60 ? `${r.secondsOnPage} ${t("с")}` : `${Math.floor(r.secondsOnPage / 60)}:${String(r.secondsOnPage % 60).padStart(2, "0")}`}</td><td className="px-3 py-1.5 text-slate-500">{fmt(r.botAt)}</td>
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
          <table className="w-full text-sm"><tbody>{events.map((e) => <tr key={e.id} className="border-b border-slate-100"><td className="py-1 text-slate-500 whitespace-nowrap">{fmt(e.at)}</td><td className="py-1 font-medium">{t(SMS_EVENT_LABEL[e.kind] ?? e.kind)}</td><td className="py-1 text-slate-500">{[e.device, (e.meta as any)?.v ?? (e.meta as any)?.vacancyId, (e.meta as any)?.name ? `${(e.meta as any).name} ${(e.meta as any).phone ?? ""}` : null].filter(Boolean).join(" · ")}</td></tr>)}</tbody></table>
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
      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
        <Label>{t("Довіра на першому екрані (порожнє — не показується)")}</Label>
        <div className="grid md:grid-cols-7 gap-2">
          {([["since", t("З якого року"), "2019"], ["placed", t("Працевлаштовано"), "2000"], ["factories", t("Підприємств"), "15"], ["rating", t("Рейтинг Google"), "4.2"], ["reviewsCount", t("Відгуків у Google"), "157"], ["reviewsUrl", t("Відгуки Google (URL)"), ""], ["kraz", t("№ KRAZ"), ""]] as const).map(([k, l, ph]) => (
            <div key={k}><Label>{l}</Label><Input value={ld.proof?.[k] ?? ""} placeholder={ph} onChange={(e) => setLd((s: any) => ({ ...s, proof: { ...(s.proof ?? {}), [k]: e.target.value } }))} /></div>
          ))}
        </div>
        <div className="grid md:grid-cols-4 gap-2">
          <div><Label>{t("Фото консультанта (URL)")}</Label><Input value={ld.recruiterPhoto ?? ""} onChange={(e) => setLd((s: any) => ({ ...s, recruiterPhoto: e.target.value }))} /></div>
          {([["whatsapp", "WhatsApp", "+48…"], ["viber", "Viber", "+48…"], ["telegram", "Telegram (@юзернейм)", "@eurosupport"]] as const).map(([k, l, ph]) => (
            <div key={k}><Label>{l}</Label><Input value={ld.messengers?.[k] ?? ""} placeholder={ph} onChange={(e) => setLd((s: any) => ({ ...s, messengers: { ...(s.messengers ?? {}), [k]: e.target.value } }))} /></div>
          ))}
        </div>
        <div><Label>{t("Відгуки (рядок = відгук: Імʼя | Місто | текст uk | текст ru | текст en)")}</Label>
          <Textarea rows={3} value={(ld.reviews ?? []).map((r: any) => [r.name, r.city ?? "", r.text?.uk ?? "", r.text?.ru ?? "", r.text?.en ?? ""].join(" | ")).join("\n")}
            onChange={(e) => setLd((s: any) => ({ ...s, reviews: e.target.value.split("\n").map((line: string) => line.split("|").map((x) => x.trim())).filter((a: string[]) => a[0] && a[2]).map((a: string[]) => ({ name: a[0], city: a[1] || undefined, text: { uk: a[2], ru: a[3] || undefined, en: a[4] || undefined } })) }))} />
        </div>
      </div>
      <VacanciesEditor value={ld.vacancies ?? []} onChange={(v) => setLd((s: any) => ({ ...s, vacancies: v }))} />
      <div className="grid md:grid-cols-3 gap-2">
        {([["phone", t("Телефон на сторінці"), "+48 792 991 524"], ["address", t("Адреса"), "ul. Krakowskie Przedmieście 55, 20-076 Lublin"], ["maps", "Google Maps (URL)", ""], ["site", t("Сайт"), "https://eurosupp.pl/"], ["vacanciesUrl", t("Усі вакансії (URL)"), "https://eurosupp.pl/dla-pracownika/"], ["instagram", "Instagram (URL)", "https://www.instagram.com/eurosupport.eu"], ["facebook", "Facebook (URL)", "https://www.facebook.com/share/1DEH5b7CnP/"]] as const).map(([k, l, ph]) => (
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
  const save = useMutation({ mutationFn: () => patch(`/sms-campaigns/${c.id}`, { ...meta, schedule: { ...sch, dailyLimit: Number(sch.dailyLimit), batchSize: Number(sch.batchSize), testLimit: Number(sch.testLimit) || 300 }, offer, recruiterAdminId: rec ? Number(rec) : null }), onSuccess: () => { toast.success(t("Збережено")); onSaved(); } });
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
        <div className="grid grid-cols-3 gap-2"><div><Label>{t("Ліміт на день")}</Label><Input type="number" value={sch.dailyLimit} onChange={(e) => setSch((s) => ({ ...s, dailyLimit: Number(e.target.value) }))} /></div><div><Label>{t("Батч (кожні 5 хв)")}</Label><Input type="number" value={sch.batchSize} onChange={(e) => setSch((s) => ({ ...s, batchSize: Number(e.target.value) }))} /></div><div><Label>{t("Стеля тест-режиму")}</Label><Input type="number" value={sch.testLimit ?? 300} onChange={(e) => setSch((s) => ({ ...s, testLimit: Number(e.target.value) }))} /></div></div>
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
type Vac = { id: string; title: Record<string, string>; city?: string; rate?: string; monthly?: string; housing?: string; transport?: string; shifts?: string; desc?: Record<string, string>; perks?: string[]; photo?: string; experience?: boolean };
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
          <div className="grid md:grid-cols-6 gap-2">
            <div><Label>{t("На місяць")}</Label><Input value={v.monthly ?? ""} placeholder="6 500 zł" onChange={(e) => upd(i, { monthly: e.target.value })} /></div>
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
          <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!v.experience} onChange={(e) => upd(i, { experience: e.target.checked })} /> {t("потрібен досвід")}</label><Button variant="secondary" onClick={() => onChange(value.filter((_, j) => j !== i))}>{t("Прибрати")}</Button></div>
        </div>
      ))}
    </div>
  );
}

// ── Аналітика сторінки: воронка кроків, вакансії/послуги, кнопки, FAQ, години, пристрої ─────
type Analytics = {
  people: { sent: number; delivered: number; viewed: number; engaged: number; interested: number; friend: number; contact: number; returning: number };
  vacancies: { id: string; title: string; opens: number; interested: number; friends: number }[];
  services: { id: string; title: string; opens: number; interested: number }[];
  buttons: Record<string, number>; faq: { n: number; opens: number }[]; langs: Record<string, number>; devices: Record<string, number>;
  byHour: number[]; byDay: { date: string; views: number; interested: number }[];
  timeToView: { medianMin: number | null; p75Min: number | null; within1h: number; within24h: number };
  timeOnPage: { medianSec: number | null; p75Sec: number | null; buckets: { label: string; n: number }[]; measured: number };
  exitAfter: { label: string; n: number }[]; events: number;
};
function AnalyticsTab({ id }: { id: number }) {
  const t = useT();
  const { data: a } = useQuery<Analytics>({ queryKey: ["sms-analytics", id], queryFn: () => get(`/sms-campaigns/${id}/analytics`), refetchInterval: 60_000 });
  if (!a) return <Spinner />;
  const p = a.people;
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
  const steps: [string, number, number][] = [
    [t("SMS відправлено"), p.sent, p.sent], [t("доставлено"), p.delivered, p.sent], [t("відкрили сторінку"), p.viewed, p.delivered || p.sent],
    [t("щось натиснули на сторінці"), p.engaged, p.viewed], [t("мене цікавить"), p.interested, p.viewed], [t("порекомендували друга"), p.friend, p.viewed], [t("натиснули подзвонити / написати"), p.contact, p.viewed],
  ];
  const maxHour = Math.max(1, ...a.byHour);
  const fmtSec = (x: number | null) => (x == null ? "—" : x < 60 ? `${x} ${t("с")}` : `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")} ${t("хв")}`);
  const fmtMin = (m: number | null) => (m == null ? "—" : m < 60 ? `${m} ${t("хв")}` : m < 1440 ? `${(m / 60).toFixed(1)} ${t("год")}` : `${(m / 1440).toFixed(1)} ${t("дн")}`);
  const BTN: Record<string, string> = { cta_call: t("подзвонити"), cta_wa: "WhatsApp", cta_viber: "Viber", cta_bot: "Telegram", link_maps: t("мапа"), link_site: t("сайт"), link_insta: "Instagram", link_fb: "Facebook", link_vacancies: t("усі вакансії"), link_reviews: t("відгуки Google") };
  const Bar = ({ n, d }: { n: number; d: number }) => <div className="h-2 rounded bg-slate-200 overflow-hidden"><div className="h-full bg-red-600" style={{ width: d ? `${Math.min(100, (n / d) * 100)}%` : 0 }} /></div>;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>{t("Унікальні люди на кожному кроці. Оновлюється щохвилини.")} · {t("подій")}: {a.events}</span>
        <a href={`/api/sms-campaigns/${id}/events.xlsx`} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-slate-300 text-slate-700"><Download size={14} /> {t("усі події xlsx")}</a>
      </div>
      <Card className="p-4">
        <div className="font-semibold mb-3">{t("Воронка сторінки")}</div>
        <div className="space-y-2">
          {steps.map(([l, n, d], i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-sm">
              <div className="min-w-0"><div className="truncate">{l}</div><Bar n={n} d={p.sent || 1} /></div>
              <div className="tabular-nums font-semibold w-12 text-right">{n}</div>
              <div className="tabular-nums text-slate-500 w-14 text-right">{i === 0 ? "" : pct(n, d)}</div>
            </div>
          ))}
        </div>
        <div className="text-xs text-slate-500 mt-3">{t("Відсоток — від попереднього кроку (відкрили — від доставлених; далі — від тих, хто відкрив).")} {t("Повернулись на сторінку повторно")}: {p.returning}.</div>
      </Card>
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="font-semibold mb-2">{t("Вакансії")}</div>
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th className="py-1">{t("Вакансія")}</th><th className="py-1 pl-3 text-right whitespace-nowrap">{t("розгорнули")}</th><th className="py-1 pl-3 text-right whitespace-nowrap">{t("цікавить")}</th><th className="py-1 pl-3 text-right whitespace-nowrap">%</th><th className="py-1 pl-3 text-right whitespace-nowrap">{t("друзів")}</th></tr></thead>
            <tbody>{a.vacancies.map((v) => <tr key={v.id} className="border-t border-slate-100"><td className="py-1.5 pr-2">{v.title}</td><td className="py-1.5 pl-3 text-right tabular-nums">{v.opens || "—"}</td><td className="py-1.5 pl-3 text-right tabular-nums font-semibold">{v.interested}</td><td className="py-1.5 pl-3 text-right tabular-nums text-slate-500">{v.opens ? pct(v.interested, v.opens) : ""}</td><td className="py-1.5 pl-3 text-right tabular-nums">{v.friends}</td></tr>)}</tbody></table>
        </Card>
        <Card className="p-4">
          <div className="font-semibold mb-2">{t("Послуги з документами")}</div>
          <table className="w-full text-sm"><thead><tr className="text-left text-slate-500"><th className="py-1">{t("Послуга")}</th><th className="py-1 pl-3 text-right whitespace-nowrap">{t("розгорнули")}</th><th className="py-1 pl-3 text-right whitespace-nowrap">{t("цікавить")}</th><th className="py-1 pl-3 text-right whitespace-nowrap">%</th></tr></thead>
            <tbody>{a.services.map((v) => <tr key={v.id} className="border-t border-slate-100"><td className="py-1.5 pr-2">{v.title}</td><td className="py-1.5 pl-3 text-right tabular-nums">{v.opens || "—"}</td><td className="py-1.5 pl-3 text-right tabular-nums font-semibold">{v.interested}</td><td className="py-1.5 pl-3 text-right tabular-nums text-slate-500">{v.opens ? pct(v.interested, v.opens) : ""}</td></tr>)}</tbody></table>
          <div className="font-semibold mt-4 mb-2">{t("Питання FAQ")}</div>
          {a.faq.length ? <div className="flex flex-wrap gap-2 text-sm">{a.faq.map((f) => <span key={f.n} className="rounded-full bg-slate-100 px-2.5 py-1">№{f.n}: {f.opens}</span>)}</div> : <div className="text-sm text-slate-400">—</div>}
        </Card>
        <Card className="p-4">
          <div className="font-semibold mb-2">{t("Кнопки контактів і посилання")}</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">{Object.entries(a.buttons).map(([k, n]) => <div key={k} className="flex justify-between border-b border-slate-100 py-1"><span>{BTN[k] ?? k}</span><span className="tabular-nums font-semibold">{n}</span></div>)}</div>
          <div className="font-semibold mt-4 mb-1">{t("Мови")}</div>
          <div className="text-sm text-slate-600">{t("перемикали мову")}: {Object.entries(a.langs).map(([l, n]) => `${l.toUpperCase()} ${n}`).join(" · ") || "—"}</div>
          <div className="font-semibold mt-4 mb-1">{t("Пристрої")}</div>
          <div className="text-sm text-slate-600">{Object.entries(a.devices).sort((x, y) => y[1] - x[1]).map(([d, n]) => `${d}: ${n}`).join(" · ") || "—"}</div>
        </Card>
        <Card className="p-4">
          <div className="font-semibold mb-2">{t("Коли відкривають (година, Варшава)")}</div>
          <div className="flex items-end gap-0.5 h-24">{a.byHour.map((n, h) => <div key={h} title={`${h}:00 — ${n}`} className="flex-1 bg-red-500/80 rounded-t" style={{ height: `${(n / maxHour) * 100}%`, minHeight: n ? 2 : 0 }} />)}</div>
          <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
          <div className="font-semibold mt-4 mb-1">{t("Час від SMS до відкриття")}</div>
          <div className="text-sm text-slate-600">{t("медіана")}: {fmtMin(a.timeToView.medianMin)} · 75%: {fmtMin(a.timeToView.p75Min)} · {t("за 1 год")}: {a.timeToView.within1h} · {t("за 24 год")}: {a.timeToView.within24h}</div>
          <div className="font-semibold mt-4 mb-1">{t("Скільки часу на сторінці")}</div>
          {a.timeOnPage.measured ? (
            <>
              <div className="text-sm text-slate-600">{t("медіана")}: {fmtSec(a.timeOnPage.medianSec)} · 75%: {fmtSec(a.timeOnPage.p75Sec)} · {t("вимірів")}: {a.timeOnPage.measured}</div>
              <div className="mt-1 space-y-1">{a.timeOnPage.buckets.map((b) => (
                <div key={b.label} className="grid grid-cols-[5.5rem_1fr_2rem] items-center gap-2 text-xs"><span className="text-slate-500">{t(b.label)}</span><div className="h-2 rounded bg-slate-200 overflow-hidden"><div className="h-full bg-slate-700" style={{ width: `${Math.round((b.n / Math.max(1, a.timeOnPage.measured)) * 100)}%` }} /></div><span className="tabular-nums text-right">{b.n}</span></div>
              ))}</div>
            </>
          ) : <div className="text-sm text-slate-400">{t("ще немає даних")}</div>}
          <div className="font-semibold mt-4 mb-1">{t("Після чого пішли зі сторінки")}</div>
          {a.exitAfter.length ? <div className="flex flex-wrap gap-2 text-sm">{a.exitAfter.map((x) => <span key={x.label} className="rounded-full bg-slate-100 px-2.5 py-1">{t(SMS_EVENT_LABEL[x.label] ?? x.label)}: {x.n}</span>)}</div> : <div className="text-sm text-slate-400">{t("ще немає даних")}</div>}
          {a.byDay.length ? (<><div className="font-semibold mt-4 mb-1">{t("По днях")}</div>
            <table className="w-full text-sm"><tbody>{a.byDay.slice(-14).map((d) => <tr key={d.date} className="border-t border-slate-100"><td className="py-1">{d.date.split("-").reverse().join(".")}</td><td className="py-1 text-right tabular-nums">{d.views} {t("відкр.")}</td><td className="py-1 text-right tabular-nums font-semibold">{d.interested} {t("цікав.")}</td></tr>)}</tbody></table></>) : null}
        </Card>
      </div>
    </div>
  );
}
