// Публічна продажна сторінка персонального SMS-лінка (/r/:token) — мобільна, мовою
// отримувача (uk/ru/en з перемикачем), з іменем у заголовку. Кнопки: «Записатись у
// Telegram» (бот ?start=sms<токен> — той самий токен, людина в боті вже відома),
// «Подзвонити», WhatsApp. Кожна кнопка шле подію GET /api/r/:token/e?k=… (без сесії,
// без CSRF — GET). Тексти: з блоку «Сторінка» кампанії, фолбек — вбудовані під пропозицію.
import { useEffect, useState } from "react";
import { useRoute } from "wouter";

type L = "uk" | "ru" | "en";
type Data = {
  firstName: string; lang: string; kind: "job" | "referral"; campaign: string; closed: boolean; telegram: string;
  offer: { factoryName?: string | null; city?: string | null; rate?: string; monthly?: string; housing?: string; transport?: string; startDate?: string; bonus?: string; phone?: string; whatsapp?: string };
  landing: { title?: Partial<Record<L, string>>; chips?: string[]; about?: Partial<Record<L, string>>; give?: Partial<Record<L, string>>; faq?: { q: Partial<Record<L, string>>; a: Partial<Record<L, string>> }[]; photos?: string[]; buttons?: { call?: boolean; whatsapp?: boolean } };
};

const S: Record<L, Record<string, string>> = {
  uk: { hi: "Привіт", jobTitle: "Робота на фабриці {factory}", jobTitleNoFac: "Робота в Польщі від Euro Support", refTitle: "{name}, отримай {bonus} за друга", what: "Що за робота", give: "Що ми даємо", how: "Як почати", faq: "Питання", s1: "Натисни «Записатись»", s2: "Анкета 5 хв", s3: "Дзвінок рекрутера сьогодні", cta: "Записатись у Telegram", call: "Подзвонити", wa: "WhatsApp", rate: "ставка", housing: "житло", transport: "довіз на зміну", start: "старт", noexp: "без досвіду", refHow: "Друг реєструється за твоїм лінком → відпрацьовує 10 змін → бонус тобі на картку.", refCta: "Отримати лінк для друга в Telegram", closed: "Ця кампанія вже завершена. Зателефонуйте нам — роботу знайдемо.", footer: "Euro Support Group Sp. z o.o. · agencja zatrudnienia · Lublin", about: "Umowa zlecenie з першого дня, ZUS і легалізація, зарплата на картку раз на місяць, аванс після 2 тижнів.", giveTxt: "Хостел біля фабрики, довіз на зміну, рекрутер українською 7 днів на тиждень.", q1: "Чи потрібен досвід?", a1: "Ні. Навчання на місці, перший день з бригадиром.", q2: "Коли перша зарплата?", a2: "До 10 числа наступного місяця, аванс можливий після 2 тижнів.", q3: "Я з паспортом без візи", a3: "Оформимо oświadczenie — працюєш легально з першого дня." },
  ru: { hi: "Привет", jobTitle: "Работа на фабрике {factory}", jobTitleNoFac: "Работа в Польше от Euro Support", refTitle: "{name}, получи {bonus} за друга", what: "Что за работа", give: "Что мы даём", how: "Как начать", faq: "Вопросы", s1: "Нажми «Записаться»", s2: "Анкета 5 мин", s3: "Звонок рекрутера сегодня", cta: "Записаться в Telegram", call: "Позвонить", wa: "WhatsApp", rate: "ставка", housing: "жильё", transport: "довоз на смену", start: "старт", noexp: "без опыта", refHow: "Друг регистрируется по твоей ссылке → отрабатывает 10 смен → бонус тебе на карту.", refCta: "Получить ссылку для друга в Telegram", closed: "Эта кампания уже завершена. Позвоните нам — работу найдём.", footer: "Euro Support Group Sp. z o.o. · agencja zatrudnienia · Lublin", about: "Umowa zlecenie с первого дня, ZUS и легализация, зарплата на карту раз в месяц, аванс после 2 недель.", giveTxt: "Хостел рядом с фабрикой, довоз на смену, рекрутер на русском 7 дней в неделю.", q1: "Нужен ли опыт?", a1: "Нет. Обучение на месте, первый день с бригадиром.", q2: "Когда первая зарплата?", a2: "До 10 числа следующего месяца, аванс возможен после 2 недель.", q3: "У меня паспорт без визы", a3: "Оформим oświadczenie — работаешь легально с первого дня." },
  en: { hi: "Hi", jobTitle: "Job at {factory}", jobTitleNoFac: "Work in Poland with Euro Support", refTitle: "{name}, get {bonus} for a friend", what: "The job", give: "What we provide", how: "How to start", faq: "FAQ", s1: "Tap “Sign up”", s2: "5-minute form", s3: "Recruiter calls you today", cta: "Sign up in Telegram", call: "Call us", wa: "WhatsApp", rate: "pay", housing: "housing", transport: "transport to work", start: "start", noexp: "no experience needed", refHow: "Your friend signs up via your link → works 10 shifts → bonus to your card.", refCta: "Get your friend link in Telegram", closed: "This campaign has ended. Call us — we will find you a job.", footer: "Euro Support Group Sp. z o.o. · employment agency · Lublin, Poland", about: "Contract from day one, social insurance and legalisation, salary to your card monthly, advance after 2 weeks.", giveTxt: "Hostel near the factory, transport to shifts, recruiter in English 7 days a week.", q1: "Do I need experience?", a1: "No. Training on site, first day with a team leader.", q2: "When is the first salary?", a2: "By the 10th of the next month; an advance is possible after 2 weeks.", q3: "I have a passport but no visa", a3: "We arrange the oświadczenie — you work legally from day one." },
};
const pick = (m: Partial<Record<L, string>> | undefined, l: L): string => (m?.[l] || m?.uk || m?.en || m?.ru || "");

export default function SmsLanding() {
  const [, params] = useRoute("/r/:token");
  const token = params?.token ?? "";
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [lang, setLang] = useState<L>("uk");
  useEffect(() => {
    fetch(`/api/r/${encodeURIComponent(token)}`).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Лінк недійсний");
      return r.json();
    }).then((x: Data) => { setD(x); setLang((["uk", "ru", "en"].includes(x.lang) ? x.lang : "uk") as L); }).catch((e) => setErr(e.message));
  }, [token]);
  const ev = (k: string) => { try { fetch(`/api/r/${encodeURIComponent(token)}/e?k=${k}`, { keepalive: true }).catch(() => {}); } catch { /* ignore */ } };
  const s = S[lang];

  if (err) return <div className="min-h-screen flex items-center justify-center p-6 text-center text-slate-600">{err}</div>;
  if (!d) return <div className="min-h-screen flex items-center justify-center text-slate-400">…</div>;

  const o = d.offer, ld = d.landing;
  const isRef = d.kind === "referral";
  const title = pick(ld.title, lang) || (isRef ? s.refTitle.replace("{name}", d.firstName).replace("{bonus}", o.bonus || "300 zł") : o.factoryName ? s.jobTitle.replace("{factory}", o.factoryName) : s.jobTitleNoFac);
  const chips = ld.chips?.length ? ld.chips : [o.rate, o.monthly, o.housing && `${s.housing}: ${o.housing}`, o.transport && s.transport, s.noexp].filter(Boolean) as string[];
  const faq = ld.faq?.length ? ld.faq.map((f) => ({ q: pick(f.q, lang), a: pick(f.a, lang) })) : [{ q: s.q1, a: s.a1 }, { q: s.q2, a: s.a2 }, { q: s.q3, a: s.a3 }];
  const waDigits = (o.whatsapp || "").replace(/\D/g, "");
  const goTelegram = () => { ev("cta_bot"); if (d.telegram) window.location.href = d.telegram; };

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
        <main className="flex-1 px-4 py-4 pb-40">
          {d.closed && <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm p-3">{s.closed}</div>}
          <div className="text-xs uppercase tracking-widest text-slate-500">{s.hi}, {d.firstName || "👋"} 👋</div>
          <h1 className="text-2xl font-extrabold leading-tight mt-1 mb-3" style={{ textWrap: "balance" }}>{title}{!isRef && o.startDate ? ` — ${s.start} ${o.startDate}` : ""}</h1>
          <div className="flex flex-wrap gap-1.5 mb-3">{chips.map((c, i) => <span key={i} className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">{c}</span>)}</div>
          {ld.photos?.length ? <div className="grid grid-cols-3 gap-1.5 mb-3">{ld.photos.slice(0, 3).map((p, i) => <img key={i} src={p} alt="" className="aspect-square object-cover rounded-lg border border-slate-200" />)}</div> : null}
          {isRef ? (
            <>
              <h2 className="font-bold mt-3 mb-1">{s.how}</h2>
              <p className="text-sm text-slate-700">{pick(ld.about, lang) || s.refHow}</p>
            </>
          ) : (
            <>
              <h2 className="font-bold mt-3 mb-1">{s.what}</h2>
              <p className="text-sm text-slate-700">{pick(ld.about, lang) || s.about}</p>
              <h2 className="font-bold mt-3 mb-1">{s.give}</h2>
              <p className="text-sm text-slate-700">{pick(ld.give, lang) || s.giveTxt}</p>
              <h2 className="font-bold mt-3 mb-1">{s.how}</h2>
              <ol className="text-sm text-slate-700 list-decimal pl-5 space-y-0.5"><li>{s.s1}</li><li>{s.s2}</li><li>{s.s3}</li></ol>
              <h2 className="font-bold mt-3 mb-1">{s.faq}</h2>
              <div className="space-y-1.5">{faq.map((f, i) => <div key={i} className="rounded-lg border border-slate-200 p-2.5 text-sm"><div className="font-semibold">{f.q}</div><div className="text-slate-600">{f.a}</div></div>)}</div>
            </>
          )}
          <p className="text-[11px] text-slate-400 mt-4">{s.footer}</p>
        </main>
        <div className="fixed bottom-0 left-0 right-0">
          <div className="max-w-md mx-auto bg-white border-t border-slate-200 p-3 grid gap-2">
            <button onClick={goTelegram} className="w-full rounded-lg bg-red-600 text-white font-bold py-3 text-base">{isRef ? s.refCta : `✅ ${s.cta}`}</button>
            <div className="grid grid-cols-2 gap-2">
              {(ld.buttons?.call ?? true) && o.phone && <a href={`tel:${o.phone.replace(/\s/g, "")}`} onClick={() => ev("cta_call")} className="text-center rounded-lg border border-slate-300 py-2 text-sm font-semibold">📞 {s.call}</a>}
              {(ld.buttons?.whatsapp ?? true) && waDigits && <a href={`https://wa.me/${waDigits}?text=${encodeURIComponent(`${d.firstName}: ${d.campaign}`)}`} onClick={() => ev("cta_wa")} className="text-center rounded-lg border border-slate-300 py-2 text-sm font-semibold">{s.wa}</a>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
