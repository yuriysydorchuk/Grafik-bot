// Публічна продажна сторінка персонального SMS-лінка (/r/:token) — мобільна, мовою отримувача
// (uk/ru/en з перемикачем), з іменем. Рішення власника 21.09.2026: без форми й без бота —
// одна головна кнопка «Мені цікаво» фіксує телефон (він уже відомий з лінка), рекрутер
// обдзвонює у вказані години; другий шлях — «приведи друга, отримай бонус». Кожна кнопка шле
// подію GET /api/r/:token/e?k=… (без сесії, без CSRF — GET). Мінімум тексту: ставка, житло,
// довіз, міста, три питання. Telegram-кнопка — лише якщо увімкнена в лендінгу кампанії.
import { useEffect, useState } from "react";
import { useRoute } from "wouter";

type L = "uk" | "ru" | "en";
type Data = {
  firstName: string; lang: string; kind: "job" | "referral"; campaign: string; closed: boolean; telegram: string; interested: boolean;
  cities: string[]; recruiter: { name: string; hours: string };
  offer: { factoryName?: string | null; city?: string | null; rate?: string; monthly?: string; housing?: string; transport?: string; startDate?: string; bonus?: string; phone?: string; whatsapp?: string };
  landing: { title?: Partial<Record<L, string>>; chips?: string[]; about?: Partial<Record<L, string>>; give?: Partial<Record<L, string>>; faq?: { q: Partial<Record<L, string>>; a: Partial<Record<L, string>> }[]; photos?: string[]; buttons?: { call?: boolean; whatsapp?: boolean; telegram?: boolean } };
};

const S: Record<L, Record<string, string>> = {
  uk: {
    hi: "Привіт", title: "Робота в Польщі", sub: "Легально, з житлом і довозом. Без досвіду.",
    rate: "{n} zł/год netto", month: "до {n} zł/міс", housing: "житло від {n} zł", transport: "довіз на зміну", noexp: "без досвіду", start: "старт {d}",
    cities: "Міста", about: "Umowa zlecenie з першого дня, ZUS і легалізація. Зарплата на картку раз на місяць, аванс після 2 тижнів.",
    refTitle: "Приведи друга — отримай {bonus}", refText: "Друг виходить на роботу і відпрацьовує 10 змін — бонус тобі на картку.",
    cta: "Мені цікаво — передзвоніть", ctaRef: "Хочу привести друга", call: "Подзвонити", wa: "WhatsApp", tg: "Написати в Telegram",
    thanks: "Дякуємо, {name}!", thanksTxt: "{who} передзвонить на ваш номер сьогодні або завтра з {hours}.", thanksWho: "Рекрутер", thanksCall: "Не хочете чекати — дзвоніть зараз:",
    faq: "Питання", q1: "Чи потрібен досвід?", a1: "Ні. Навчання на місці, перший день з бригадиром.", q2: "Коли перша зарплата?", a2: "До 10 числа наступного місяця, аванс можливий після 2 тижнів.", q3: "Я з паспортом без візи", a3: "Оформимо oświadczenie — працюєш легально з першого дня.",
    closed: "Ця пропозиція вже завершена. Зателефонуйте нам — роботу знайдемо.", footer: "Euro Support Group Sp. z o.o. · agencja zatrudnienia · Lublin",
  },
  ru: {
    hi: "Привет", title: "Работа в Польше", sub: "Легально, с жильём и довозом. Без опыта.",
    rate: "{n} zł/час netto", month: "до {n} zł/мес", housing: "жильё от {n} zł", transport: "довоз на смену", noexp: "без опыта", start: "старт {d}",
    cities: "Города", about: "Umowa zlecenie с первого дня, ZUS и легализация. Зарплата на карту раз в месяц, аванс после 2 недель.",
    refTitle: "Приведи друга — получи {bonus}", refText: "Друг выходит на работу и отрабатывает 10 смен — бонус тебе на карту.",
    cta: "Мне интересно — перезвоните", ctaRef: "Хочу привести друга", call: "Позвонить", wa: "WhatsApp", tg: "Написать в Telegram",
    thanks: "Спасибо, {name}!", thanksTxt: "{who} перезвонит на ваш номер сегодня или завтра с {hours}.", thanksWho: "Рекрутер", thanksCall: "Не хотите ждать — звоните сейчас:",
    faq: "Вопросы", q1: "Нужен ли опыт?", a1: "Нет. Обучение на месте, первый день с бригадиром.", q2: "Когда первая зарплата?", a2: "До 10 числа следующего месяца, аванс возможен после 2 недель.", q3: "У меня паспорт без визы", a3: "Оформим oświadczenie — работаешь легально с первого дня.",
    closed: "Это предложение уже завершено. Позвоните нам — работу найдём.", footer: "Euro Support Group Sp. z o.o. · agencja zatrudnienia · Lublin",
  },
  en: {
    hi: "Hi", title: "Work in Poland", sub: "Legal job with housing and transport. No experience needed.",
    rate: "{n} zł/h net", month: "up to {n} zł/month", housing: "housing from {n} zł", transport: "transport to work", noexp: "no experience needed", start: "start {d}",
    cities: "Cities", about: "Contract from day one, social insurance and legalisation. Salary to your card monthly, advance after 2 weeks.",
    refTitle: "Bring a friend — get {bonus}", refText: "Your friend starts and works 10 shifts — the bonus goes to your card.",
    cta: "I'm interested — call me back", ctaRef: "I want to bring a friend", call: "Call now", wa: "WhatsApp", tg: "Message on Telegram",
    thanks: "Thank you, {name}!", thanksTxt: "{who} will call your number today or tomorrow, {hours}.", thanksWho: "Our recruiter", thanksCall: "Don't want to wait — call now:",
    faq: "FAQ", q1: "Do I need experience?", a1: "No. Training on site, first day with a team leader.", q2: "When is the first salary?", a2: "By the 10th of the next month; an advance is possible after 2 weeks.", q3: "I have a passport but no visa", a3: "We arrange the oświadczenie — you work legally from day one.",
    closed: "This offer has ended. Call us — we will find you a job.", footer: "Euro Support Group Sp. z o.o. · employment agency · Lublin, Poland",
  },
};
const pick = (m: Partial<Record<L, string>> | undefined, l: L): string => (m?.[l] || m?.uk || m?.ru || m?.en || "").trim();
// Значення пропозиції офіс вводить одним рядком («31 zł/год netto», «від 450 zł») — на сторінці
// беремо число й підставляємо в шаблон мови, щоб чіпи не змішували мови.
const num = (v?: string): string => { const m = (v ?? "").replace(/\s/g, "").match(/\d+([.,]\d+)?/); return m ? m[0] : ""; };
const fill = (tpl: string, vars: Record<string, string>): string => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

export default function SmsLanding() {
  const [, params] = useRoute("/r/:token");
  const token = params?.token ?? "";
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [lang, setLang] = useState<L>("uk");
  const [done, setDone] = useState<"" | "job" | "ref">("");
  useEffect(() => {
    fetch(`/api/r/${encodeURIComponent(token)}`).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Лінк недійсний");
      return r.json();
    }).then((x: Data) => { setD(x); setLang((["uk", "ru", "en"].includes(x.lang) ? x.lang : "uk") as L); if (x.interested) setDone("job"); }).catch((e) => setErr(e.message));
  }, [token]);
  const ev = (k: string) => { try { fetch(`/api/r/${encodeURIComponent(token)}/e?k=${k}`, { keepalive: true }).catch(() => {}); } catch { /* ignore */ } };
  const s = S[lang];

  if (err) return <div className="min-h-screen flex items-center justify-center p-6 text-center text-slate-600">{err}</div>;
  if (!d) return <div className="min-h-screen flex items-center justify-center text-slate-400">…</div>;

  const o = d.offer, ld = d.landing;
  const bonus = o.bonus || "300 zł";
  const title = pick(ld.title, lang) || s.title;
  const chips = ld.chips?.length ? ld.chips : [
    num(o.rate) && fill(s.rate, { n: num(o.rate) }), num(o.monthly) && fill(s.month, { n: num(o.monthly) }), num(o.housing) && fill(s.housing, { n: num(o.housing) }),
    o.transport && s.transport, o.startDate && fill(s.start, { d: o.startDate }), s.noexp,
  ].filter(Boolean) as string[];
  const faq = ld.faq?.length ? ld.faq.map((f) => ({ q: pick(f.q, lang), a: pick(f.a, lang) })) : [{ q: s.q1, a: s.a1 }, { q: s.q2, a: s.a2 }, { q: s.q3, a: s.a3 }];
  const about = pick(ld.about, lang) || s.about;
  const waDigits = (o.whatsapp || "").replace(/\D/g, "");
  const phoneHref = (o.phone || "").replace(/\s/g, "");
  const who = d.recruiter.name || s.thanksWho;
  const interested = (kind: "job" | "ref") => { ev(kind === "ref" ? "interested_ref" : "interested"); setDone(kind); window.scrollTo({ top: 0, behavior: "smooth" }); };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="max-w-md mx-auto bg-white min-h-screen flex flex-col">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
          <span className="bg-red-600 text-white font-extrabold rounded px-2 py-0.5 text-xs">ES</span>
          <span className="font-bold">Euro Support</span>
          <span className="flex-1" />
          {(["uk", "ru", "en"] as L[]).map((l) => (
            <button key={l} onClick={() => setLang(l)} className={`text-xs px-2 py-0.5 rounded-full border ${l === lang ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-500"}`}>{l.toUpperCase()}</button>
          ))}
        </header>

        <main className={`flex-1 px-4 py-4 ${done ? "pb-8" : "pb-44"}`}>
          {d.closed && <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm p-3 mb-3">{s.closed}</div>}

          {done ? (
            <section className="rounded-xl bg-green-50 border border-green-200 p-4 mb-4">
              <div className="text-xl font-bold text-green-800">✅ {fill(s.thanks, { name: d.firstName })}</div>
              <p className="text-green-900 mt-1">{fill(s.thanksTxt, { who, hours: d.recruiter.hours })}</p>
              {phoneHref && (
                <div className="mt-3 text-sm text-green-900">
                  {s.thanksCall}{" "}
                  <a href={`tel:${phoneHref}`} onClick={() => ev("cta_call")} className="font-bold underline">{o.phone}</a>
                </div>
              )}
            </section>
          ) : (
            <p className="text-xs uppercase tracking-wide text-slate-500">{s.hi}, {d.firstName} 👋</p>
          )}

          <h1 className="text-3xl font-extrabold leading-tight mt-1">{title}</h1>
          <p className="text-slate-600 mt-1">{s.sub}</p>

          <div className="flex flex-wrap gap-2 mt-3">
            {chips.map((c, i) => <span key={i} className="rounded-full bg-green-50 border border-green-200 text-green-800 text-sm font-semibold px-3 py-1">{c}</span>)}
          </div>

          {d.cities.length > 0 && (
            <div className="mt-4">
              <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{s.cities}</div>
              <div className="flex flex-wrap gap-2">{d.cities.map((c) => <span key={c} className="rounded-md bg-slate-100 text-slate-800 text-sm px-2.5 py-1">📍 {c}</span>)}</div>
            </div>
          )}

          <p className="text-slate-700 mt-4">{about}</p>

          {ld.photos?.length ? (
            <div className="grid grid-cols-2 gap-2 mt-4">{ld.photos.slice(0, 4).map((u, i) => <img key={i} src={u} alt="" className="rounded-lg object-cover w-full h-28" loading="lazy" />)}</div>
          ) : null}

          <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 mt-5">
            <div className="font-bold text-amber-900">🎁 {fill(s.refTitle, { bonus })}</div>
            <p className="text-sm text-amber-900/80 mt-1">{s.refText}</p>
            {done !== "ref" && <button onClick={() => interested("ref")} className="mt-3 w-full rounded-lg border border-amber-400 bg-white text-amber-900 font-semibold py-2 text-sm">{s.ctaRef}</button>}
          </section>

          <h2 className="font-bold mt-5 mb-2">{s.faq}</h2>
          <div className="space-y-2">
            {faq.map((f, i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-3">
                <div className="font-semibold">{f.q}</div>
                <div className="text-slate-600 text-sm mt-0.5">{f.a}</div>
              </div>
            ))}
          </div>

          {done && (
            <div className="grid grid-cols-2 gap-2 mt-5">
              {(ld.buttons?.call ?? true) && phoneHref && <a href={`tel:${phoneHref}`} onClick={() => ev("cta_call")} className="text-center rounded-lg border border-slate-300 py-2 text-sm font-semibold">📞 {s.call}</a>}
              {(ld.buttons?.whatsapp ?? true) && waDigits && <a href={`https://wa.me/${waDigits}?text=${encodeURIComponent(`${d.firstName}: ${d.campaign}`)}`} onClick={() => ev("cta_wa")} className="text-center rounded-lg border border-slate-300 py-2 text-sm font-semibold">{s.wa}</a>}
            </div>
          )}
          <p className="text-xs text-slate-400 mt-6">{s.footer}</p>
        </main>

        {!done && (
          <div className="fixed bottom-0 left-0 right-0">
            <div className="max-w-md mx-auto bg-white border-t border-slate-200 p-3 grid gap-2">
              <button onClick={() => interested("job")} className="w-full rounded-lg bg-red-600 text-white font-bold py-3 text-base">📞 {s.cta}</button>
              <div className="grid grid-cols-2 gap-2">
                {(ld.buttons?.call ?? true) && phoneHref && <a href={`tel:${phoneHref}`} onClick={() => ev("cta_call")} className="text-center rounded-lg border border-slate-300 py-2 text-sm font-semibold">📞 {s.call}</a>}
                {(ld.buttons?.whatsapp ?? true) && waDigits && <a href={`https://wa.me/${waDigits}?text=${encodeURIComponent(`${d.firstName}: ${d.campaign}`)}`} onClick={() => ev("cta_wa")} className="text-center rounded-lg border border-slate-300 py-2 text-sm font-semibold">{s.wa}</a>}
              </div>
              {ld.buttons?.telegram && d.telegram && <a href={d.telegram} onClick={() => ev("cta_bot")} className="text-center text-sm text-slate-500 underline">{s.tg}</a>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
