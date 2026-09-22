// Публічна сторінка персонального SMS-лінка (/r/:token) — v3 (22.09.2026): конверсійна верстка для
// холодного ліда з SMS. Принципи: довіра з першого екрана (логотип, ліцензія, цифри, консультант з
// імʼям і фото), одна головна дія без форми («Мені цікаво — передзвоніть», телефон відомий з лінка),
// три кроки «як це працює», плитки вакансій → опис/переваги → кнопки, «порекомендувати друга»
// (імʼя + телефон), відгуки, FAQ під заперечення, контакти. Липка кнопка знизу, поки не натиснуто.
// Усе, чого власник ще не дав (цифри, відгуки, фото), ховається — нічого не вигадуємо.
// Події — GET /api/r/:token/e?k=…&v=<вакансія>; друг — POST /api/r/:token/friend (CSRF-заголовок).
import { useEffect, useState } from "react";
import { useRoute } from "wouter";

type L = "uk" | "ru" | "en";
type Txt = Partial<Record<L, string>>;
type Vacancy = { id: string; title: Txt; city?: string; rate?: string; housing?: string; transport?: string; shifts?: string; desc?: Txt; perks?: string[]; photo?: string; experience?: boolean };
type Data = {
  firstName: string; lang: string; kind: "job" | "referral"; closed: boolean; telegram: string;
  interested: boolean; interestedVacancies: string[]; friends: string[];
  cities: string[]; vacancies: Vacancy[]; recruiter: { name: string; hours: string };
  contacts: { phone?: string; address?: string; maps?: string; site?: string; instagram?: string; facebook?: string; vacanciesUrl?: string };
  offer: { bonus?: string; phone?: string; whatsapp?: string };
  landing: {
    title?: Txt; about?: Txt; faq?: { q: Txt; a: Txt }[]; photos?: string[]; buttons?: { call?: boolean; whatsapp?: boolean; telegram?: boolean };
    proof?: { since?: string; placed?: string; factories?: string; rating?: string; reviewsUrl?: string; kraz?: string };
    reviews?: { name: string; city?: string; text: Txt }[]; recruiterPhoto?: string; messengers?: { whatsapp?: string; viber?: string; telegram?: string };
  };
};

const S: Record<L, Record<string, string>> = {
  uk: {
    hi: "Привіт, {name}!", h1: "У нас є робота для вас", sub: "Легальна робота в Польщі з житлом і довозом. Досвід не потрібен — навчимо на місці.",
    licensed: "Ліцензована агенція", since: "з {y} року", placed: "{n}+ працевлаштованих", factories: "{n} підприємств", rating: "{n} у Google",
    cta: "Мені цікаво — передзвоніть", ctaSub: "Без анкети. Ми вже знаємо ваш номер — просто натисніть.",
    recruiterTitle: "Ваш консультант", recruiterTxt: "{name} зателефонує з {hours}, розкаже про вакансію, житло і документи. Українською або російською.", recruiterDefault: "Консультант",
    howTitle: "Як це працює", how1: "Натисніть «Мені цікаво»", how2: "Дзвінок консультанта протягом 1 робочого дня", how3: "Житло, довіз, документи — і старт цього тижня",
    vacancies: "Вакансії зараз", rateNetto: "zł/год netto", rateBrutto: "zł/год brutto", from: "від", housing: "житло від {n} zł", transport: "довіз", noexp: "без досвіду", exp: "з досвідом", perks: "Що отримуєте",
    interest: "Мене цікавить ця вакансія", friend: "Порекомендувати друга", friendName: "Імʼя друга", friendPhone: "Телефон друга", send: "Надіслати", cancel: "Скасувати",
    thanksTitle: "Дякуємо, {name}!", thanksTxt: "{who} зателефонує вам протягом 1 робочого дня ({hours}). Якщо зручніше — напишіть нам самі:", thanksShort: "{who} зателефонує протягом 1 робочого дня.", thanksFriend: "Дякуємо! Ми зателефонуємо {friend}. Після 10 змін друга бонус {bonus} — ваш.",
    friendErr: "Вкажіть імʼя і номер телефону.", ownPhone: "Це ваш номер — впишіть номер друга.", dup: "Цей номер уже в нашій базі, дякуємо!",
    refTitle: "Приведіть друга — отримайте {bonus}", refSteps: "Ви вписуєте імʼя і телефон друга;Ми телефонуємо і працевлаштовуємо;Друг відпрацьовує 10 змін — бонус вам на картку",
    reviews: "Що кажуть наші працівники", reviewsAll: "Усі відгуки в Google", faq: "Часті питання",
    q1: "Це легально?", a1: "Так. Umowa zlecenie з першого дня, внески ZUS, допомога з документами і легалізацією перебування.",
    q2: "Скільки коштує житло і довіз?", a2: "Житло 500–850 zł на місяць залежно від міста, довіз близько 270 zł на місяць. Точні цифри скаже консультант по вашій вакансії.",
    q3: "Коли перша зарплата?", a3: "До 10 числа наступного місяця на картку. Аванс можливий після 2 тижнів роботи.",
    q4: "Досвід потрібен?", a4: "На більшості вакансій ні: перший день з бригадиром, навчання на місці. Де досвід потрібен — це вказано на вакансії.",
    q5: "Я з України без візи, чи можна?", a5: "Так. Оформимо oświadczenie або працюєте за статусом UKR — консультант підкаже, що саме у вашому випадку.",
    svcTitle: "Допомагаємо з документами в Польщі", svcSub: "Не лише робота. Натисніть, що цікавить — консультант розкаже умови.", svcCta: "Цікавить — звʼяжіться зі мною",
    svc1: "Карта побиту", svc1t: "Збираємо документи, заповнюємо wniosek, записуємо до urzędu wojewódzkiego і супроводжуємо до отримання карти. Для тих, хто працює в нас — умови окремі.",
    svc2: "PESEL UKR / статус UKR", svc2t: "Оформлення та поновлення статусу UKR і номера PESEL, консультація, що робити, якщо статус втрачено після виїзду.",
    svc3: "Заміна водійського посвідчення", svc3t: "Обмін українських прав на польські: переклад, заява у wydział komunikacji, супровід до отримання.",
    waText: "Добрий день! Я {name}, отримав(ла) SMS про роботу. Хочу дізнатись більше.",
    netErr: "Не вдалося надіслати. Перевірте інтернет і спробуйте ще раз, або подзвоніть нам.",
    contacts: "Контакти", call: "Подзвонити", maps: "Показати на мапі", allVac: "Усі вакансії на сайті",
    closed: "Ця пропозиція вже завершена. Зателефонуйте нам — роботу знайдемо.", footer: "Euro Support Group Sp. z o.o. · agencja zatrudnienia · Lublin",
  },
  ru: {
    hi: "Привет, {name}!", h1: "У нас есть работа для вас", sub: "Легальная работа в Польше с жильём и довозом. Опыт не нужен — научим на месте.",
    licensed: "Лицензированное агентство", since: "с {y} года", placed: "{n}+ трудоустроенных", factories: "{n} предприятий", rating: "{n} в Google",
    cta: "Мне интересно — перезвоните", ctaSub: "Без анкеты. Мы уже знаем ваш номер — просто нажмите.",
    recruiterTitle: "Ваш консультант", recruiterTxt: "{name} позвонит с {hours}, расскажет о вакансии, жилье и документах. На русском или украинском.", recruiterDefault: "Консультант",
    howTitle: "Как это работает", how1: "Нажмите «Мне интересно»", how2: "Звонок консультанта в течение 1 рабочего дня", how3: "Жильё, довоз, документы — и старт на этой неделе",
    vacancies: "Вакансии сейчас", rateNetto: "zł/час netto", rateBrutto: "zł/час brutto", from: "от", housing: "жильё от {n} zł", transport: "довоз", noexp: "без опыта", exp: "с опытом", perks: "Что вы получаете",
    interest: "Меня интересует эта вакансия", friend: "Порекомендовать друга", friendName: "Имя друга", friendPhone: "Телефон друга", send: "Отправить", cancel: "Отмена",
    thanksTitle: "Спасибо, {name}!", thanksTxt: "{who} позвонит вам в течение 1 рабочего дня ({hours}). Если удобнее — напишите нам сами:", thanksShort: "{who} позвонит в течение 1 рабочего дня.", thanksFriend: "Спасибо! Мы позвоним {friend}. После 10 смен друга бонус {bonus} — ваш.",
    friendErr: "Укажите имя и номер телефона.", ownPhone: "Это ваш номер — впишите номер друга.", dup: "Этот номер уже есть в нашей базе, спасибо!",
    refTitle: "Приведите друга — получите {bonus}", refSteps: "Вы вписываете имя и телефон друга;Мы звоним и трудоустраиваем;Друг отрабатывает 10 смен — бонус вам на карту",
    reviews: "Что говорят наши работники", reviewsAll: "Все отзывы в Google", faq: "Частые вопросы",
    q1: "Это легально?", a1: "Да. Umowa zlecenie с первого дня, взносы ZUS, помощь с документами и легализацией пребывания.",
    q2: "Сколько стоит жильё и довоз?", a2: "Жильё 500–850 zł в месяц в зависимости от города, довоз около 270 zł в месяц. Точные цифры скажет консультант по вашей вакансии.",
    q3: "Когда первая зарплата?", a3: "До 10 числа следующего месяца на карту. Аванс возможен после 2 недель работы.",
    q4: "Нужен ли опыт?", a4: "На большинстве вакансий нет: первый день с бригадиром, обучение на месте. Где опыт нужен — это указано в вакансии.",
    q5: "Я из Украины без визы, можно?", a5: "Да. Оформим oświadczenie или работаете по статусу UKR — консультант подскажет, что именно в вашем случае.",
    svcTitle: "Помогаем с документами в Польше", svcSub: "Не только работа. Нажмите, что интересует — консультант расскажет условия.", svcCta: "Интересует — свяжитесь со мной",
    svc1: "Карта побыту", svc1t: "Собираем документы, заполняем wniosek, записываем в urząd wojewódzki и сопровождаем до получения карты. Для тех, кто работает у нас — отдельные условия.",
    svc2: "PESEL UKR / статус UKR", svc2t: "Оформление и восстановление статуса UKR и номера PESEL, консультация, что делать, если статус потерян после выезда.",
    svc3: "Замена водительского удостоверения", svc3t: "Обмен украинских прав на польские: перевод, заявление в wydział komunikacji, сопровождение до получения.",
    waText: "Добрый день! Я {name}, получил(а) SMS о работе. Хочу узнать больше.",
    netErr: "Не удалось отправить. Проверьте интернет и попробуйте ещё раз, или позвоните нам.",
    contacts: "Контакты", call: "Позвонить", maps: "Показать на карте", allVac: "Все вакансии на сайте",
    closed: "Это предложение уже завершено. Позвоните нам — работу найдём.", footer: "Euro Support Group Sp. z o.o. · agencja zatrudnienia · Lublin",
  },
  en: {
    hi: "Hi {name}!", h1: "We have a job for you", sub: "Legal work in Poland with housing and transport. No experience needed — we train you on site.",
    licensed: "Licensed agency", since: "since {y}", placed: "{n}+ people employed", factories: "{n} factories", rating: "{n} on Google",
    cta: "I'm interested — call me back", ctaSub: "No forms. We already have your number — just tap.",
    recruiterTitle: "Your consultant", recruiterTxt: "{name} will call you {hours} to talk about the job, housing and documents.", recruiterDefault: "Consultant",
    howTitle: "How it works", how1: "Tap “I'm interested”", how2: "A consultant calls within 1 working day", how3: "Housing, transport, documents — and you start this week",
    vacancies: "Open vacancies", rateNetto: "zł/h net", rateBrutto: "zł/h gross", from: "from", housing: "housing from {n} zł", transport: "transport", noexp: "no experience", exp: "experience required", perks: "What you get",
    interest: "I'm interested in this job", friend: "Recommend a friend", friendName: "Friend's name", friendPhone: "Friend's phone", send: "Send", cancel: "Cancel",
    thanksTitle: "Thank you, {name}!", thanksTxt: "{who} will call you within 1 working day ({hours}). Prefer to write? Message us:", thanksShort: "{who} will call within 1 working day.", thanksFriend: "Thank you! We will call {friend}. After your friend's 10 shifts the {bonus} bonus is yours.",
    friendErr: "Enter a name and a phone number.", ownPhone: "That is your own number — enter your friend's.", dup: "This number is already in our database, thank you!",
    refTitle: "Bring a friend — get {bonus}", refSteps: "You enter your friend's name and phone;We call and employ them;After their 10 shifts the bonus goes to your card",
    reviews: "What our workers say", reviewsAll: "All reviews on Google", faq: "FAQ",
    q1: "Is it legal?", a1: "Yes. Contract from day one, social insurance, help with documents and residence legalisation.",
    q2: "How much are housing and transport?", a2: "Housing 500–850 zł per month depending on the city, transport about 270 zł per month. Your consultant gives exact numbers for your job.",
    q3: "When is the first salary?", a3: "By the 10th of the next month to your card. An advance is possible after 2 weeks.",
    q4: "Do I need experience?", a4: "For most jobs no: first day with a team leader, training on site. Where experience is required, the vacancy says so.",
    q5: "I'm from Ukraine without a visa — can I work?", a5: "Yes. We arrange the oświadczenie or you work under UKR status — the consultant tells you what applies to you.",
    svcTitle: "We help with documents in Poland", svcSub: "Not only jobs. Tap what you need — a consultant explains the terms.", svcCta: "Interested — contact me",
    svc1: "Residence card (karta pobytu)", svc1t: "We collect documents, fill in the application, book the voivodeship office and guide you until you get the card. Special terms for our workers.",
    svc2: "PESEL UKR / UKR status", svc2t: "Obtaining or restoring UKR status and a PESEL number, advice on what to do if the status was lost after leaving Poland.",
    svc3: "Driving licence exchange", svc3t: "Exchange of a Ukrainian licence for a Polish one: translation, application at the transport office, support until you receive it.",
    waText: "Hello! I am {name}, I received your SMS about a job. I would like to know more.",
    netErr: "Could not send. Check your connection and try again, or call us.",
    contacts: "Contacts", call: "Call us", maps: "Show on map", allVac: "All vacancies on our website",
    closed: "This offer has ended. Call us — we will find you a job.", footer: "Euro Support Group Sp. z o.o. · employment agency · Lublin, Poland",
  },
};
const pick = (m: Txt | undefined, l: L): string => (m?.[l] || m?.uk || m?.ru || m?.en || "").trim();
const num = (v?: string): string => { const m = (v ?? "").replace(/\s/g, "").match(/\d+([.,]\d+)?/); return m ? m[0] : ""; };
const rateChip = (v: string | undefined, s: Record<string, string>): string => {
  if (!v) return "";
  const nums = v.replace(/\s/g, "").match(/\d+([.,]\d+)?/g); if (!nums) return v;
  const from = /^(від|от|from|od)(\s|\d)/i.test(v.trim()) ? s.from + " " : "";
  return `${from}${nums.join("–")} ${/brutto/i.test(v) ? s.rateBrutto : s.rateNetto}`;
};
const fill = (tpl: string, vars: Record<string, string>): string => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
const digits = (v?: string) => (v ?? "").replace(/\D/g, "");
const initials = (name: string) => name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();

export default function SmsLanding() {
  const [, params] = useRoute("/r/:token");
  const token = params?.token ?? "";
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [lang, setLang] = useState<L>("uk");
  const [open, setOpen] = useState("");
  const [interested, setInterested] = useState<Set<string>>(new Set());
  const [friendFor, setFriendFor] = useState("");
  const [friend, setFriend] = useState({ name: "", phone: "" });
  const [friendMsg, setFriendMsg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [faqOpen, setFaqOpen] = useState(0);
  const [svcOpen, setSvcOpen] = useState("");

  useEffect(() => {
    fetch(`/api/r/${encodeURIComponent(token)}`).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Лінк недійсний");
      return r.json();
    }).then((x: Data) => {
      setD(x); setLang((["uk", "ru", "en"].includes(x.lang) ? x.lang : "uk") as L);
      const ids = x.interestedVacancies ?? [];
      setInterested(new Set(x.interested && !ids.length ? ["any"] : ids));
      if (x.vacancies?.length === 1) setOpen(x.vacancies[0]!.id);
    }).catch((e) => setErr(e.message));
  }, [token]);
  const ev = (k: string, v?: string) => { try { fetch(`/api/r/${encodeURIComponent(token)}/e?k=${k}${v ? `&v=${encodeURIComponent(v)}` : ""}`, { keepalive: true }).catch(() => {}); } catch { /* ignore */ } };
  const s = S[lang];

  if (err) return <div className="min-h-screen flex items-center justify-center p-6 text-center text-slate-600">{err}</div>;
  if (!d) return <div className="min-h-screen flex items-center justify-center text-slate-400">…</div>;

  const ld = d.landing, ct = d.contacts, pf = ld.proof ?? {};
  const bonus = d.offer.bonus || "300 zł";
  const name = d.firstName || "";
  const who = d.recruiter.name || s.recruiterDefault;
  const phoneHref = digits(ct.phone || d.offer.phone);
  const wa = digits(ld.messengers?.whatsapp || d.offer.whatsapp || ct.phone);
  const viber = digits(ld.messengers?.viber);
  const tg = (ld.messengers?.telegram || "").replace(/^@/, "");
  const done = [...interested].some((id) => !id.startsWith("svc:"));
  // «Мені цікаво» — підтверджуємо лише після відповіді сервера (ревʼю 22.09.2026: без мережі сторінка обіцяла дзвінок)
  const mark = async (id: string) => {
    try {
      const r = await fetch(`/api/r/${encodeURIComponent(token)}/e?k=interested&v=${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(String(r.status));
      setInterested((p) => new Set([...p, id]));
      if (id === "any") window.scrollTo({ top: 0, behavior: "smooth" });
    } catch { alert(s.netErr); }
  };
  const sendFriend = async (vId: string) => {
    if (!friend.name.trim() || digits(friend.phone).length < 9) { setFriendMsg((m) => ({ ...m, [vId]: s.friendErr })); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/r/${encodeURIComponent(token)}/friend`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "grafik" }, body: JSON.stringify({ ...friend, vacancyId: vId === "any" ? "" : vId }) });
      const j: { error?: string } = await r.json().catch(() => ({}));
      if (r.status === 400 && j.error === "own_phone") { setFriendMsg((m) => ({ ...m, [vId]: s.ownPhone })); return; }
      if (!r.ok) { setFriendMsg((m) => ({ ...m, [vId]: s.friendErr })); return; }
      setFriendMsg((m) => ({ ...m, [vId]: fill(s.thanksFriend, { friend: friend.name.trim(), bonus }) }));
      setFriendFor(""); setFriend({ name: "", phone: "" });
    } finally { setBusy(false); }
  };
  const proofChips = [
    s.licensed + (pf.kraz ? ` · KRAZ ${pf.kraz}` : ""),
    pf.since && fill(s.since, { y: pf.since }), pf.placed && fill(s.placed, { n: pf.placed }), pf.factories && fill(s.factories, { n: pf.factories }), pf.rating && `⭐ ${fill(s.rating, { n: pf.rating })}`,
  ].filter(Boolean) as string[];
  const faq = ld.faq?.length ? ld.faq.map((f) => ({ q: pick(f.q, lang), a: pick(f.a, lang) })) : [1, 2, 3, 4, 5].map((i) => ({ q: s[`q${i}`]!, a: s[`a${i}`]! }));
  const avatar = (cls: string) => ld.recruiterPhoto
    ? <img src={ld.recruiterPhoto} alt="" className={`${cls} rounded-full object-cover shrink-0`} />
    : <div className={`${cls} rounded-full bg-red-600 text-white font-bold flex items-center justify-center shrink-0`}>{initials(who)}</div>;
  const messengers = (
    <div className="flex flex-wrap gap-2 mt-3">
      {wa && <a href={`https://wa.me/${wa}?text=${encodeURIComponent(fill(s.waText, { name }))}`} onClick={() => ev("cta_wa")} className="flex-1 min-w-[30%] text-center rounded-xl border border-green-300 bg-green-50 text-green-900 py-2 text-sm font-semibold">WhatsApp</a>}
      {viber && <a href={`viber://chat?number=%2B${viber}`} onClick={() => ev("cta_viber")} className="flex-1 min-w-[30%] text-center rounded-xl border border-violet-300 bg-violet-50 text-violet-900 py-2 text-sm font-semibold">Viber</a>}
      {tg && <a href={`https://t.me/${tg}`} onClick={() => ev("cta_bot")} className="flex-1 min-w-[30%] text-center rounded-xl border border-sky-300 bg-sky-50 text-sky-900 py-2 text-sm font-semibold">Telegram</a>}
      {phoneHref && <a href={`tel:+${phoneHref}`} onClick={() => ev("cta_call")} className="flex-1 min-w-[30%] text-center rounded-xl border border-slate-300 bg-white py-2 text-sm font-semibold">📞 {s.call}</a>}
    </div>
  );
  const friendForm = (vId: string) => (
    <>
      {friendMsg[vId] && <div className="mt-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 p-3 text-sm">{friendMsg[vId]}</div>}
      {friendFor === vId ? (
        <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 space-y-2">
          <input value={friend.name} onChange={(e) => setFriend((f) => ({ ...f, name: e.target.value }))} placeholder={s.friendName} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5" />
          <input value={friend.phone} onChange={(e) => setFriend((f) => ({ ...f, phone: e.target.value }))} placeholder={`${s.friendPhone} · +48…`} inputMode="tel" className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5" />
          <div className="grid grid-cols-2 gap-2">
            <button disabled={busy} onClick={() => sendFriend(vId)} className="rounded-xl bg-amber-500 text-white font-bold py-2.5 disabled:opacity-50">{s.send}</button>
            <button onClick={() => { setFriendFor(""); setFriendMsg((m) => ({ ...m, [vId]: "" })); }} className="rounded-xl border border-slate-300 py-2.5 text-sm">{s.cancel}</button>
          </div>
        </div>
      ) : (
        <button onClick={() => { setFriendFor(vId); setFriendMsg((m) => ({ ...m, [vId]: "" })); }} className="mt-2 w-full rounded-xl border-2 border-amber-400 bg-white text-amber-900 font-semibold py-2.5 text-sm">🎁 {s.friend} · {bonus}</button>
      )}
    </>
  );

  return (
    <div className="min-h-screen bg-orange-50/60 text-slate-900">
      <div className="max-w-md mx-auto bg-white min-h-screen flex flex-col shadow-sm">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
          <img src="/logo.png" alt="Euro Support" className="h-8 dark:hidden" /><img src="/logo-dark.png" alt="" className="h-8 hidden dark:block" />
          <span className="flex-1" />
          {(["uk", "ru", "en"] as L[]).map((l) => (
            <button key={l} onClick={() => { setLang(l); ev("lang", l); }} className={`text-xs px-2.5 py-1 rounded-full border ${l === lang ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-500"}`}>{l.toUpperCase()}</button>
          ))}
        </header>

        <main className={`flex-1 ${done ? "pb-8" : "pb-36"}`}>
          {d.closed && <div className="mx-4 mt-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm p-3">{s.closed}</div>}

          <section className="px-4 pt-5 pb-4 bg-gradient-to-b from-red-50 to-white">
            {done ? (
              <div className="rounded-2xl bg-green-50 border border-green-200 p-4">
                <div className="flex items-center gap-3">
                  {avatar("w-14 h-14 text-lg")}
                  <div>
                    <div className="text-xl font-extrabold text-green-800">✅ {fill(s.thanksTitle, { name })}</div>
                    <div className="text-sm text-green-900">{fill(s.thanksTxt, { who, hours: d.recruiter.hours })}</div>
                  </div>
                </div>
                {messengers}
              </div>
            ) : (
              <>
                <p className="text-sm font-semibold text-red-700">{fill(s.hi, { name })} 👋</p>
                <h1 className="text-3xl font-extrabold leading-tight mt-1">{pick(ld.title, lang) || s.h1}</h1>
                <p className="text-slate-600 mt-2">{pick(ld.about, lang) || s.sub}</p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {proofChips.map((c, i) => <span key={i} className="rounded-full bg-white border border-slate-200 text-slate-700 text-xs font-semibold px-2.5 py-1">✔ {c}</span>)}
                </div>
                <button onClick={() => mark("any")} className="mt-4 w-full rounded-2xl bg-red-600 text-white font-extrabold py-4 text-lg shadow-lg shadow-red-200">📞 {s.cta}</button>
                <p className="text-xs text-slate-500 text-center mt-1.5">{s.ctaSub}</p>
              </>
            )}
          </section>

          <section className="mx-4 mt-2 rounded-2xl border border-slate-200 p-4 flex items-center gap-3">
            {avatar("w-16 h-16 text-xl")}
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-slate-500">{s.recruiterTitle}</div>
              <div className="font-bold text-lg leading-tight">{who}</div>
              <div className="text-sm text-slate-600 mt-0.5">{fill(s.recruiterTxt, { name: who, hours: d.recruiter.hours })}</div>
            </div>
          </section>

          <section className="px-4 mt-6">
            <h2 className="font-bold text-lg">{s.howTitle}</h2>
            <ol className="mt-2 grid grid-cols-3 gap-2">
              {[s.how1, s.how2, s.how3].map((t, i) => (
                <li key={i} className="rounded-xl bg-slate-50 border border-slate-200 p-2.5">
                  <div className="w-7 h-7 rounded-full bg-red-600 text-white text-sm font-bold flex items-center justify-center">{i + 1}</div>
                  <div className="text-xs text-slate-700 mt-1.5 leading-snug">{t}</div>
                </li>
              ))}
            </ol>
          </section>

          {ld.photos?.length ? (
            <div className="px-4 mt-5 flex gap-2 overflow-x-auto snap-x">{ld.photos.map((u, i) => <img key={i} src={u} alt="" className="h-36 w-52 shrink-0 rounded-xl object-cover snap-start" loading="lazy" />)}</div>
          ) : null}

          <section className="px-4 mt-6">
            <h2 className="font-bold text-lg mb-2">{s.vacancies}</h2>
            <div className="space-y-3">
              {d.vacancies.map((v) => {
                const isOpen = open === v.id;
                const vDone = interested.has(v.id);
                const chips = [rateChip(v.rate, s), num(v.housing) && fill(s.housing, { n: num(v.housing) }), v.transport && s.transport, v.shifts, v.experience ? s.exp : s.noexp].filter(Boolean) as string[];
                return (
                  <article key={v.id} className={`rounded-2xl border-2 overflow-hidden ${isOpen ? "border-red-500" : "border-slate-200"}`}>
                    {v.photo && <img src={v.photo} alt="" className="w-full h-36 object-cover" loading="lazy" />}
                    <button onClick={() => { setOpen(isOpen ? "" : v.id); if (!isOpen) ev("open_vacancy", v.id); }} className="w-full text-left p-4">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-lg leading-snug">{pick(v.title, lang)}</div>
                          {v.city && <div className="text-sm text-slate-500 mt-0.5">📍 {v.city}</div>}
                          <div className="flex flex-wrap gap-1.5 mt-2">{chips.map((c, i) => <span key={i} className={`rounded-full text-xs font-semibold px-2 py-0.5 ${i === 0 ? "bg-green-600 text-white" : "bg-green-50 border border-green-200 text-green-800"}`}>{c}</span>)}</div>
                        </div>
                        <span className={`text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`}>▾</span>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-4">
                        <p className="text-slate-700">{pick(v.desc, lang)}</p>
                        {v.perks?.length ? (<><div className="text-xs uppercase tracking-wide text-slate-500 mt-3 mb-1">{s.perks}</div><ul className="space-y-1">{v.perks.map((p, i) => <li key={i} className="text-sm text-slate-800 flex gap-2"><span>✅</span><span>{p.trim()}</span></li>)}</ul></>) : null}
                        {vDone ? (
                          <div className="mt-4 rounded-xl bg-green-50 border border-green-200 text-green-900 p-3 text-sm font-semibold">✅ {fill(s.thanksShort, { who })}</div>
                        ) : (
                          <button onClick={() => mark(v.id)} className="mt-4 w-full rounded-xl bg-red-600 text-white font-bold py-3">📞 {s.interest}</button>
                        )}
                        {friendForm(v.id)}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
            {ct.vacanciesUrl && <a href={ct.vacanciesUrl} onClick={() => ev("link_vacancies")} target="_blank" rel="noreferrer" className="block text-center text-sm text-slate-500 underline mt-3">{s.allVac}</a>}
          </section>

          <section className="mx-4 mt-6 rounded-2xl bg-amber-50 border border-amber-200 p-4">
            <div className="font-bold text-lg text-amber-900">🎁 {fill(s.refTitle, { bonus })}</div>
            <ol className="mt-2 space-y-1.5">
              {s.refSteps!.split(";").map((t, i) => <li key={i} className="flex gap-2 text-sm text-amber-900/90"><span className="w-5 h-5 rounded-full bg-amber-500 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span><span>{t}</span></li>)}
            </ol>
            {friendForm("any")}
          </section>

          <section className="px-4 mt-6">
            <h2 className="font-bold text-lg">{s.svcTitle}</h2>
            <p className="text-sm text-slate-600 mt-0.5 mb-2">{s.svcSub}</p>
            <div className="space-y-2">
              {([["svc:karta", "🪪", s.svc1, s.svc1t], ["svc:ukr", "🇺🇦", s.svc2, s.svc2t], ["svc:prawko", "🚗", s.svc3, s.svc3t]] as const).map(([id, ico, title, txt]) => {
                const isOpen = svcOpen === id; const sDone = interested.has(id);
                return (
                  <article key={id} className={`rounded-2xl border-2 ${isOpen ? "border-slate-900" : "border-slate-200"}`}>
                    <button onClick={() => { setSvcOpen(isOpen ? "" : id); if (!isOpen) ev("open_service", id); }} className="w-full text-left px-4 py-3 flex items-center gap-3">
                      <span className="text-2xl">{ico}</span><span className="font-bold flex-1">{title}</span><span className={`text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`}>▾</span>
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-4">
                        <p className="text-sm text-slate-700">{txt}</p>
                        {sDone ? <div className="mt-3 rounded-xl bg-green-50 border border-green-200 text-green-900 p-3 text-sm font-semibold">✅ {fill(s.thanksShort, { who })}</div>
                          : <button onClick={() => mark(id)} className="mt-3 w-full rounded-xl bg-slate-900 text-white font-bold py-3">{s.svcCta}</button>}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          {ld.reviews?.length ? (
            <section className="mt-6">
              <h2 className="font-bold text-lg px-4">{s.reviews}</h2>
              <div className="flex gap-3 overflow-x-auto px-4 mt-2 pb-1 snap-x">
                {ld.reviews.map((r, i) => (
                  <figure key={i} className="w-72 shrink-0 rounded-2xl border border-slate-200 bg-slate-50 p-4 snap-start">
                    <div className="text-amber-500 text-sm">★★★★★</div>
                    <blockquote className="text-sm text-slate-800 mt-1">“{pick(r.text, lang)}”</blockquote>
                    <figcaption className="text-xs text-slate-500 mt-2 font-semibold">{r.name}{r.city ? ` · ${r.city}` : ""}</figcaption>
                  </figure>
                ))}
              </div>
              {pf.reviewsUrl && <a href={pf.reviewsUrl} onClick={() => ev("link_reviews")} target="_blank" rel="noreferrer" className="block px-4 mt-2 text-sm text-blue-700 underline">{s.reviewsAll}</a>}
            </section>
          ) : null}

          <section className="px-4 mt-6">
            <h2 className="font-bold text-lg mb-2">{s.faq}</h2>
            <div className="divide-y divide-slate-200 rounded-2xl border border-slate-200">
              {faq.map((f, i) => (
                <div key={i}>
                  <button onClick={() => { setFaqOpen(faqOpen === i ? -1 : i); if (faqOpen !== i) ev("open_faq", String(i + 1)); }} className="w-full text-left px-4 py-3 font-semibold flex justify-between gap-3"><span>{f.q}</span><span className="text-slate-400">{faqOpen === i ? "−" : "+"}</span></button>
                  {faqOpen === i && <p className="px-4 pb-3 text-sm text-slate-600">{f.a}</p>}
                </div>
              ))}
            </div>
          </section>

          <section className="mx-4 mt-6 rounded-2xl bg-slate-50 border border-slate-200 p-4">
            <div className="font-bold mb-2">{s.contacts}</div>
            <div className="space-y-2 text-sm">
              {phoneHref && <a href={`tel:+${phoneHref}`} onClick={() => ev("cta_call")} className="flex items-center gap-2 font-semibold"><span>📞</span><span>{ct.phone || d.offer.phone}</span></a>}
              {ct.address && <div className="flex items-start gap-2"><span>📍</span><span>{ct.address}{ct.maps && <> · <a href={ct.maps} onClick={() => ev("link_maps")} target="_blank" rel="noreferrer" className="underline text-blue-700">{s.maps}</a></>}</span></div>}
              {ct.site && <a href={ct.site} onClick={() => ev("link_site")} target="_blank" rel="noreferrer" className="flex items-center gap-2"><span>🌐</span><span className="underline text-blue-700">{ct.site.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span></a>}
              <div className="flex gap-3 pt-1">
                {ct.instagram && <a href={ct.instagram} onClick={() => ev("link_insta")} target="_blank" rel="noreferrer" className="underline text-blue-700">Instagram</a>}
                {ct.facebook && <a href={ct.facebook} onClick={() => ev("link_fb")} target="_blank" rel="noreferrer" className="underline text-blue-700">Facebook</a>}
              </div>
            </div>
            {messengers}
          </section>
          <p className="text-xs text-slate-400 mt-4 px-4">{s.footer}{pf.kraz ? ` · KRAZ ${pf.kraz}` : ""} · NIP 9462698100</p>
        </main>

        {!done && (
          <div className="fixed bottom-0 left-0 right-0 z-10">
            <div className="max-w-md mx-auto bg-white/95 backdrop-blur border-t border-slate-200 p-3 grid grid-cols-[1fr_auto] gap-2">
              <button onClick={() => mark("any")} className="rounded-xl bg-red-600 text-white font-bold py-3">📞 {s.cta}</button>
              {wa && <a href={`https://wa.me/${wa}?text=${encodeURIComponent(fill(s.waText, { name }))}`} onClick={() => ev("cta_wa")} className="rounded-xl border border-green-300 bg-green-50 text-green-900 font-semibold px-3 py-3 text-sm flex items-center">WhatsApp</a>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
