// Публічна сторінка персонального SMS-лінка (/r/:token) — мобільна, мовою отримувача (uk/ru/en з
// перемикачем), з іменем. Рішення власника 21.09.2026: плитки вакансій → по кліку короткий опис і
// переваги → кнопки «Мене цікавить вакансія» (телефон уже відомий, форми немає; людині —
// «консультант звʼяжеться протягом 1 робочого дня») і «Порекомендувати друга» (імʼя + телефон
// друга). Унизу контакти: телефон, адреса з Google Maps, сайт, Instagram. Події — GET
// /api/r/:token/e?k=…&v=<вакансія>; друг — POST /api/r/:token/friend (з CSRF-заголовком).
import { useEffect, useState } from "react";
import { useRoute } from "wouter";

type L = "uk" | "ru" | "en";
type Txt = Partial<Record<L, string>>;
type Vacancy = { id: string; title: Txt; city?: string; rate?: string; housing?: string; transport?: string; shifts?: string; desc?: Txt; perks?: string[]; photo?: string };
type Data = {
  firstName: string; lang: string; kind: "job" | "referral"; campaign: string; closed: boolean; telegram: string;
  interested: boolean; interestedVacancies: string[]; friends: string[];
  cities: string[]; vacancies: Vacancy[]; recruiter: { name: string; hours: string };
  contacts: { phone?: string; address?: string; maps?: string; site?: string; instagram?: string; facebook?: string; vacanciesUrl?: string };
  offer: { bonus?: string; phone?: string; whatsapp?: string };
  landing: { title?: Txt; about?: Txt; faq?: { q: Txt; a: Txt }[]; buttons?: { call?: boolean; whatsapp?: boolean; telegram?: boolean } };
};

const S: Record<L, Record<string, string>> = {
  uk: {
    hi: "Привіт", title: "Робота в Польщі", sub: "Легально, з житлом і довозом. Без досвіду.", bonusLine: "Або порекомендуйте друга — {bonus} вам після його 10 змін.",
    vacancies: "Вакансії", rateNetto: "zł/год netto", rateBrutto: "zł/год brutto", from: "від", allVac: "Усі вакансії на сайті", housing: "житло від {n} zł", transport: "довіз", noexp: "без досвіду", perks: "Наші переваги", more: "Детальніше", less: "Згорнути",
    interest: "Мене цікавить ця вакансія", friend: "Порекомендувати друга", friendName: "Імʼя друга", friendPhone: "Телефон друга", send: "Надіслати", cancel: "Скасувати",
    thanksInterest: "Дякуємо! Консультант звʼяжеться з вами протягом 1 робочого дня.", thanksFriend: "Дякуємо! Ми зателефонуємо {friend}. Після 10 змін друга бонус {bonus} — ваш.",
    friendErr: "Вкажіть імʼя і номер телефону.", ownPhone: "Це ваш номер — впишіть номер друга.", dup: "Цей номер уже в нашій базі, дякуємо!",
    about: "Umowa zlecenie з першого дня, ZUS і легалізація. Зарплата на картку раз на місяць, аванс після 2 тижнів.",
    defaultPerks: "Житло біля фабрики;Довіз на зміну;Аванс після 2 тижнів;Рекрутер українською;Легально з першого дня",
    contacts: "Контакти", call: "Подзвонити", maps: "Показати на мапі", site: "Сайт", insta: "Instagram", fb: "Facebook", closed: "Ця пропозиція вже завершена. Зателефонуйте нам — роботу знайдемо.",
    footer: "Euro Support Group Sp. z o.o. · agencja zatrudnienia",
  },
  ru: {
    hi: "Привет", title: "Работа в Польше", sub: "Легально, с жильём и довозом. Без опыта.", bonusLine: "Или порекомендуйте друга — {bonus} вам после его 10 смен.",
    vacancies: "Вакансии", rateNetto: "zł/час netto", rateBrutto: "zł/час brutto", from: "от", allVac: "Все вакансии на сайте", housing: "жильё от {n} zł", transport: "довоз", noexp: "без опыта", perks: "Наши преимущества", more: "Подробнее", less: "Свернуть",
    interest: "Меня интересует эта вакансия", friend: "Порекомендовать друга", friendName: "Имя друга", friendPhone: "Телефон друга", send: "Отправить", cancel: "Отмена",
    thanksInterest: "Спасибо! Консультант свяжется с вами в течение 1 рабочего дня.", thanksFriend: "Спасибо! Мы позвоним {friend}. После 10 смен друга бонус {bonus} — ваш.",
    friendErr: "Укажите имя и номер телефона.", ownPhone: "Это ваш номер — впишите номер друга.", dup: "Этот номер уже есть в нашей базе, спасибо!",
    about: "Umowa zlecenie с первого дня, ZUS и легализация. Зарплата на карту раз в месяц, аванс после 2 недель.",
    defaultPerks: "Жильё рядом с фабрикой;Довоз на смену;Аванс после 2 недель;Рекрутер на русском;Легально с первого дня",
    contacts: "Контакты", call: "Позвонить", maps: "Показать на карте", site: "Сайт", insta: "Instagram", fb: "Facebook", closed: "Это предложение уже завершено. Позвоните нам — работу найдём.",
    footer: "Euro Support Group Sp. z o.o. · agencja zatrudnienia",
  },
  en: {
    hi: "Hi", title: "Work in Poland", sub: "Legal job with housing and transport. No experience needed.", bonusLine: "Or recommend a friend — {bonus} for you after their 10 shifts.",
    vacancies: "Vacancies", rateNetto: "zł/h net", rateBrutto: "zł/h gross", from: "from", allVac: "All vacancies on our website", housing: "housing from {n} zł", transport: "transport", noexp: "no experience", perks: "Why us", more: "Details", less: "Hide",
    interest: "I'm interested in this job", friend: "Recommend a friend", friendName: "Friend's name", friendPhone: "Friend's phone", send: "Send", cancel: "Cancel",
    thanksInterest: "Thank you! A consultant will contact you within 1 working day.", thanksFriend: "Thank you! We will call {friend}. After your friend's 10 shifts the {bonus} bonus is yours.",
    friendErr: "Enter a name and a phone number.", ownPhone: "That is your own number — enter your friend's.", dup: "This number is already in our database, thank you!",
    about: "Contract from day one, social insurance and legalisation. Salary to your card monthly, advance after 2 weeks.",
    defaultPerks: "Housing near the factory;Transport to shifts;Advance after 2 weeks;English-speaking recruiter;Legal from day one",
    contacts: "Contacts", call: "Call us", maps: "Show on map", site: "Website", insta: "Instagram", fb: "Facebook", closed: "This offer has ended. Call us — we will find you a job.",
    footer: "Euro Support Group Sp. z o.o. · employment agency",
  },
};
const pick = (m: Txt | undefined, l: L): string => (m?.[l] || m?.uk || m?.ru || m?.en || "").trim();
const num = (v?: string): string => { const m = (v ?? "").replace(/\s/g, "").match(/\d+([.,]\d+)?/); return m ? m[0] : ""; };
// ставка: усі числа (діапазон через –), префікс «від», brutto/netto — рендеримо мовою сторінки
const rateChip = (v: string | undefined, s: Record<string, string>): string => {
  if (!v) return "";
  const nums = v.replace(/\s/g, "").match(/\d+([.,]\d+)?/g); if (!nums) return v;
  const from = /^(від|от|from|od)\b/i.test(v.trim()) ? s.from + " " : "";
  return `${from}${nums.join("–")} ${/brutto/i.test(v) ? s.rateBrutto : s.rateNetto}`;
};
const fill = (tpl: string, vars: Record<string, string>): string => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

export default function SmsLanding() {
  const [, params] = useRoute("/r/:token");
  const token = params?.token ?? "";
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [lang, setLang] = useState<L>("uk");
  const [open, setOpen] = useState<string>("");
  const [interested, setInterested] = useState<Set<string>>(new Set());
  const [friendFor, setFriendFor] = useState<string>("");
  const [friend, setFriend] = useState({ name: "", phone: "" });
  const [friendMsg, setFriendMsg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`/api/r/${encodeURIComponent(token)}`).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Лінк недійсний");
      return r.json();
    }).then((x: Data) => {
      setD(x); setLang((["uk", "ru", "en"].includes(x.lang) ? x.lang : "uk") as L);
      setInterested(new Set(x.interestedVacancies ?? []));
      if (x.vacancies?.length === 1) setOpen(x.vacancies[0]!.id);
    }).catch((e) => setErr(e.message));
  }, [token]);
  const ev = (k: string, v?: string) => { try { fetch(`/api/r/${encodeURIComponent(token)}/e?k=${k}${v ? `&v=${encodeURIComponent(v)}` : ""}`, { keepalive: true }).catch(() => {}); } catch { /* ignore */ } };
  const s = S[lang];

  if (err) return <div className="min-h-screen flex items-center justify-center p-6 text-center text-slate-600">{err}</div>;
  if (!d) return <div className="min-h-screen flex items-center justify-center text-slate-400">…</div>;

  const bonus = d.offer.bonus || "300 zł";
  const ct = d.contacts;
  const phoneHref = (ct.phone || d.offer.phone || "").replace(/\s/g, "");
  const markInterest = (v: Vacancy) => { ev("interested", v.id); setInterested((prev) => new Set([...prev, v.id])); };
  const sendFriend = async (v: Vacancy) => {
    if (!friend.name.trim() || friend.phone.replace(/\D/g, "").length < 9) { setFriendMsg((m) => ({ ...m, [v.id]: s.friendErr })); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/r/${encodeURIComponent(token)}/friend`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "grafik" }, body: JSON.stringify({ ...friend, vacancyId: v.id }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 400 && j.error === "own_phone") { setFriendMsg((m) => ({ ...m, [v.id]: s.ownPhone })); return; }
      if (!r.ok) { setFriendMsg((m) => ({ ...m, [v.id]: s.friendErr })); return; }
      setFriendMsg((m) => ({ ...m, [v.id]: j.duplicate ? s.dup : fill(s.thanksFriend, { friend: friend.name.trim(), bonus }) }));
      setFriendFor(""); setFriend({ name: "", phone: "" });
    } finally { setBusy(false); }
  };

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

        <main className="flex-1 px-4 py-4 pb-8">
          {d.closed && <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm p-3 mb-3">{s.closed}</div>}
          <p className="text-xs uppercase tracking-wide text-slate-500">{s.hi}, {d.firstName} 👋</p>
          <h1 className="text-3xl font-extrabold leading-tight mt-1">{pick(d.landing.title, lang) || s.title}</h1>
          <p className="text-slate-600 mt-1">{s.sub}</p>
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">🎁 {fill(s.bonusLine, { bonus })}</p>

          <h2 className="font-bold mt-5 mb-2">{s.vacancies}</h2>
          <div className="space-y-3">
            {d.vacancies.map((v) => {
              const isOpen = open === v.id;
              const done = interested.has(v.id);
              const perks = v.perks?.length ? v.perks : s.defaultPerks.split(";");
              const chips = [rateChip(v.rate, s), num(v.housing) && fill(s.housing, { n: num(v.housing) }), v.transport && s.transport, v.shifts, s.noexp].filter(Boolean) as string[];
              return (
                <section key={v.id} className={`rounded-xl border ${isOpen ? "border-slate-900" : "border-slate-200"} overflow-hidden`}>
                  <button onClick={() => setOpen(isOpen ? "" : v.id)} className="w-full text-left p-4">
                    <div className="flex items-start gap-3">
                      {v.photo && <img src={v.photo} alt="" className="w-16 h-16 rounded-lg object-cover shrink-0" loading="lazy" />}
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-lg leading-snug">{pick(v.title, lang)}</div>
                        {v.city && <div className="text-sm text-slate-500">📍 {v.city}</div>}
                        <div className="flex flex-wrap gap-1.5 mt-2">{chips.map((c, i) => <span key={i} className="rounded-full bg-green-50 border border-green-200 text-green-800 text-xs font-semibold px-2 py-0.5">{c}</span>)}</div>
                      </div>
                      <span className="text-slate-400 text-sm shrink-0">{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-4 border-t border-slate-100">
                      <p className="text-slate-700 mt-3">{pick(v.desc, lang) || pick(d.landing.about, lang) || s.about}</p>
                      <div className="text-xs uppercase tracking-wide text-slate-500 mt-3 mb-1">{s.perks}</div>
                      <ul className="space-y-1">{perks.map((p, i) => <li key={i} className="text-sm text-slate-800">✅ {p.trim()}</li>)}</ul>

                      {done ? (
                        <div className="mt-4 rounded-lg bg-green-50 border border-green-200 text-green-900 p-3 text-sm font-semibold">✅ {s.thanksInterest}</div>
                      ) : (
                        <button onClick={() => markInterest(v)} className="mt-4 w-full rounded-lg bg-red-600 text-white font-bold py-3">{s.interest}</button>
                      )}

                      {friendMsg[v.id] && <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 p-3 text-sm">{friendMsg[v.id]}</div>}
                      {friendFor === v.id ? (
                        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
                          <input value={friend.name} onChange={(e) => setFriend((f) => ({ ...f, name: e.target.value }))} placeholder={s.friendName} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2" />
                          <input value={friend.phone} onChange={(e) => setFriend((f) => ({ ...f, phone: e.target.value }))} placeholder={`${s.friendPhone} · +48…`} inputMode="tel" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2" />
                          <div className="grid grid-cols-2 gap-2">
                            <button disabled={busy} onClick={() => sendFriend(v)} className="rounded-lg bg-amber-500 text-white font-bold py-2 disabled:opacity-50">{s.send}</button>
                            <button onClick={() => { setFriendFor(""); setFriendMsg((m) => ({ ...m, [v.id]: "" })); }} className="rounded-lg border border-slate-300 py-2 text-sm">{s.cancel}</button>
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => { setFriendFor(v.id); setFriendMsg((m) => ({ ...m, [v.id]: "" })); }} className="mt-2 w-full rounded-lg border border-amber-400 bg-white text-amber-900 font-semibold py-2 text-sm">🎁 {s.friend} · {bonus}</button>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          {d.landing.faq?.length ? (
            <div className="mt-5 space-y-2">
              {d.landing.faq.map((f, i) => (
                <div key={i} className="rounded-lg border border-slate-200 p-3"><div className="font-semibold">{pick(f.q, lang)}</div><div className="text-slate-600 text-sm mt-0.5">{pick(f.a, lang)}</div></div>
              ))}
            </div>
          ) : null}

          <section className="mt-6 rounded-xl bg-slate-50 border border-slate-200 p-4">
            <div className="font-bold mb-2">{s.contacts}</div>
            <div className="space-y-2 text-sm">
              {phoneHref && <a href={`tel:${phoneHref}`} onClick={() => ev("cta_call")} className="flex items-center gap-2 font-semibold"><span>📞</span><span>{ct.phone || d.offer.phone}</span></a>}
              {ct.address && <div className="flex items-start gap-2"><span>📍</span><span>{ct.address}{ct.maps && <> · <a href={ct.maps} target="_blank" rel="noreferrer" className="underline text-blue-700">{s.maps}</a></>}</span></div>}
              {ct.vacanciesUrl && <a href={ct.vacanciesUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2"><span>📋</span><span className="underline text-blue-700">{s.allVac}</span></a>}
              {ct.site && <a href={ct.site} target="_blank" rel="noreferrer" className="flex items-center gap-2"><span>🌐</span><span className="underline text-blue-700">{ct.site.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span></a>}
              {ct.instagram && <a href={ct.instagram} target="_blank" rel="noreferrer" className="flex items-center gap-2"><span>📸</span><span className="underline text-blue-700">{s.insta}</span></a>}
              {ct.facebook && <a href={ct.facebook} target="_blank" rel="noreferrer" className="flex items-center gap-2"><span>👥</span><span className="underline text-blue-700">{s.fb}</span></a>}
            </div>
          </section>
          <p className="text-xs text-slate-400 mt-4">{s.footer}</p>
        </main>
      </div>
    </div>
  );
}
