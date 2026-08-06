// «Сводні» — повне дзеркало зарплатних таблиць по містах (Люблін/Познань/Лодзь).
// Вкладка = фабрика; кожна клітинка редагується (рядок стає «ручним» і синк із
// Google його більше не перезаписує — сайт є джерелом). Відкритий шар: фактичні
// години, ставки, відрахування, до виплати. Закритий (księgowość/готівка/конто)
// приходить з API лише з capability svodniSensitive — показуємо, що прийшло.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw, Link2, CircleAlert, CircleCheck, Users, PencilLine, Columns3,
  Coins, CreditCard, Banknote, PiggyBank, HandCoins,
  Home, Gavel, IdCard, GraduationCap, Wallet, UserPlus, Trash2,
  Search as SearchIcon, Lock, LockOpen, Download, ArrowUp, ArrowDown, Combine,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { get, post, patch, del } from "../lib/api";
import { Button, Card, Empty, Badge, Spinner, Select, Modal, Input } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { PageHeader } from "../components/Layout";
import { useMe } from "../lib/hooks";
import { can } from "../lib/roles";
import { useT } from "../lib/i18n";
import { LEGAL_LABEL, LEGAL_BADGE, type LegalStatus } from "../lib/legalStatus";
import { useOrderPref, orderBy, useDragOrder } from "../lib/prefs";
import { FIRM_TAB } from "../lib/colors";

type Row = {
  id: number; city: string; firm: string | null; factoryLabel: string; factoryId: number | null;
  section: string | null; rawName: string; workerId: number | null; workerName: string | null;
  linkStatus: string; manual: boolean;
  hoursNotified: number | null; hours: number | null; shifts: number | null;
  rateBrutto: number | null; rateNetto: number | null; premia: number | null;
  zaliczka: number | null; zaliczkaBd: number | null; hostel: number | null; odziez: number | null;
  dojazd: number | null; kara: number | null; komornik: number | null; kaucja: number | null;
  potracenia: number | null; doWyplaty: number | null; brutto: number | null;
  isStudent: boolean | null; under26: boolean | null;
  hoursDeclared?: number | null; ksiegBrutto?: number | null; ksiegNetto?: number | null;
  gotowka?: number | null; konto?: number | null;
  payoutPref?: { kind: string; value: number | null } | null;
  extras: Record<string, number | string>; hr: Record<string, string>;
  mismatch: Record<string, { ours: number; sheet: number }> | null;
  rowColor: string | null;
  note: string | null; // ручна замітка «для себе» — редагується завжди, навіть при затвердженні
  legalStatus: string | null; // форма легалізації (з Księgowość або профілю)
  // порізка місяця на сегменти (різні умови в різні періоди): батько — суми,
  // сегмент — повноцінний рядок (свої до виплати/konto/готівка + частки відрахувань)
  segments?: Seg[];
};
type Seg = Row & { from: string | null; to: string | null; label: string | null };
// кольори сегментів по порядку (Tailwind бачить лише буквальні класи)
const SEG_COLORS = [
  // bgName — липка клітинка імені: фон МУСИТЬ бути суцільним (без /alpha),
  // інакше при горизонтальному скролі крізь неї просвічує текст колонок
  { border: "border-violet-400", bg: "bg-violet-50/40", bgHover: "hover:bg-violet-50/70", bgName: "bg-violet-50", chip: "bg-violet-100 text-violet-700" },
  { border: "border-sky-400", bg: "bg-sky-50/40", bgHover: "hover:bg-sky-50/70", bgName: "bg-sky-50", chip: "bg-sky-100 text-sky-700" },
  { border: "border-teal-400", bg: "bg-teal-50/40", bgHover: "hover:bg-teal-50/70", bgName: "bg-teal-50", chip: "bg-teal-100 text-teal-700" },
  { border: "border-rose-400", bg: "bg-rose-50/40", bgHover: "hover:bg-rose-50/70", bgName: "bg-rose-50", chip: "bg-rose-100 text-rose-700" },
];
const segColor = (i: number) => SEG_COLORS[i % SEG_COLORS.length]!;
// на порізаному батькові ці поля рахуються З сегментів — сервер відхиляє правку
// (409), тож клітинки показуємо read-only, як при затвердженні
const SEG_PARENT_RO = new Set(["hours", "rateNetto", "rateBrutto", "doWyplaty", "brutto", "hoursDeclared", "ksiegNetto", "ksiegBrutto", "konto", "gotowka"]);
const cellIsSegLocked = (r: Row, key: string) => (r.segments?.length ?? 0) > 0 && SEG_PARENT_RO.has(key);
const cellLockTitle = (r: Row, key: string, t: (s: string) => string) =>
  cellIsSegLocked(r, key) ? t("Рядок порізаний на сегменти — це поле рахується з них (розкрий 🧩)") : undefined;
// ключі поза каталогом (приїхали з даних імпорту) сервер не редагує — read-only
const hrEditableKey = (key: string) => key === "extras.zusStatus" || HR_LABEL[key.slice(3)] !== undefined;
type Check = { city: string; factoryLabel: string; metric: string; ours: number | null; sheetSuma: number | null; summaryTab: number | null; ok: boolean };
type TabMeta = { city: string; factoryLabel: string; colOrder: string[]; info: { stawkaEurocash?: (string | number)[][] } };
type Lock = { city: string; factoryLabel: string }; // factoryLabel "" = усе місто
type Data = { month: string; cities: string[]; rows: Row[]; checks: Check[]; tabMeta?: TabMeta[]; sensitive: boolean; locks: Lock[]; staleLocks?: Lock[]; ksiegMin?: { netto: number; brutto: number } };
type Unmatched = { rawName: string; city: string; factories: string[]; months: string[]; candidates: { id: number; name: string }[] };

// колонки відкритого шару: [поле, заголовок]
const OPEN_COLS: [keyof Row & string, string][] = [
  ["hoursNotified", "Год. повід."], ["hours", "Години"],
  ["rateBrutto", "Ставка бр."], ["rateNetto", "Ставка нет."], ["premia", "Премія"],
  ["zaliczka", "Zaliczka"], ["zaliczkaBd", "Zaliczka BD"], ["hostel", "Hostel"],
  ["odziez", "Odzież"], ["dojazd", "Dojazd"], ["kara", "Kara"], ["komornik", "Komornik"],
  ["kaucja", "Kaucja"], ["potracenia", "Potrącenia"], ["doWyplaty", "До виплати"], ["brutto", "Brutto"],
];
const SENS_COLS: [keyof Row & string, string][] = [
  ["hoursDeclared", "Год. księg."], ["ksiegBrutto", "Księg. brutto"], ["ksiegNetto", "Księg. netto (конто)"], ["gotowka", "Готівка"],
];
// кадрові текстові колонки (hr.*) + ZUS-статус (extras.zusStatus): базовий набір
// показується завжди, решта (Stanowisko, Linia, Nr osobowy…) — коли є дані в місті
const HR_COLS: [string, string][] = [
  ["extras.zusStatus", "Księgowość (статус)"],
  ["hr.zaswiadczenieDo", "Zaświadczenie до"],
  ["hr.zaswiadczenieWystawione", "Zaśw. виставлено"],
  ["hr.wniosekZaliczki", "Wniosek zaliczki"],
  ["hr.dataUrodzenia", "Дата народження"],
];
const HR_LABEL: Record<string, string> = {
  zusStatus: "Księgowość (статус)", zaswiadczenieDo: "Zaświadczenie до",
  zaswiadczenieWystawione: "Zaśw. виставлено", wniosekZaliczki: "Wniosek zaliczki",
  dataUrodzenia: "Дата народження", nrOsobowy: "Nr osobowy", stanowisko: "Stanowisko",
  linia: "Linia", szkolenie: "Szkolenie", oddzial: "Oddział", firma: "Firma",
  status: "Status", umowaOd: "Umowa od", umowaDo: "Umowa do",
  dataStart: "Початок роботи", dataLiczymy: "Дата відліку", dataWypowiedzenia: "Wypowiedzenie",
  dniOdpracowane: "Дні відпрац.", koniecStudiow: "Кінець студій", uwagi: "Uwagi",
  powOsw: "Pow./Ośw.", hoursText: "Години (текст)", kontoNr: "Nr konta",
};
const EXTRA_LABEL: Record<string, string> = {
  nocneH: "Нічні [год]", doplataNocna: "Допл. нічні", oplataKierowcy: "Оплата водія",
  doplataEs: "Dopłata ES", badania: "Badania", nakladki: "Nakładki", zwrotKosztow: "Zwrot kosztów",
  kartaPobytu: "Karta pobytu", karaKlient: "Кара клієнта", karaEs: "Кара ES",
  zadluzenie: "Заборгованість", migawka: "Migawka", dokumenty: "Dokumenty", workListHours: "Work List [год]",
  premiaBase: "Premia (кол.)", premiaAgram: "Premia Agram", premiaEs: "Premia ES",
  ksiegHours: "Godzin faktycznie", kontoH: "Конто [год]", gotowkaH: "Готівка [год]",
  godzFaktBlock: "Год. факт (księg.)", zaliczkaBlock: "Zaliczka (księg.)",
};
// не в каталозі вводу: блокові/дзеркальні (ksiegHours, kontoH…) і мертві
// (оплата водія, badania, nakładki…) — показуються ЛИШЕ коли приїхали з даними
const CATALOG_HIDDEN = new Set([
  "ksiegHours", "kontoH", "gotowkaH", "godzFaktBlock", "zaliczkaBlock", "workListHours",
  "oplataKierowcy", "badania", "nakladki", "zadluzenie", "dokumenty", "zwrotKosztow",
]);
const EXTRA_ORDER = Object.keys(EXTRA_LABEL).filter(k => !CATALOG_HIDDEN.has(k));

// кольорове кодування колонок за змістом: години — блакитні, ставки — фіолетові,
// нарахування — зелені, утримання — помаранчеві («До виплати» і księgowe мають
// власні червоний/бурштиновий). Класи буквальні — Tailwind v4 не бачить динамічних.
const TINT = {
  sky: { th: "bg-sky-100/70 text-sky-800", td: "bg-sky-50/50" },
  violet: { th: "bg-violet-100/60 text-violet-800", td: "bg-violet-50/40" },
  emerald: { th: "bg-emerald-100/60 text-emerald-800", td: "bg-emerald-50/40" },
  orange: { th: "bg-orange-100/60 text-orange-800", td: "bg-orange-50/40" },
} as const;
const COL_TINT: Record<string, keyof typeof TINT> = {
  hoursNotified: "sky", hours: "sky", "extras.nocneH": "sky", "extras.workListHours": "sky", "extras.ksiegHours": "sky",
  rateBrutto: "violet", rateNetto: "violet",
  premia: "emerald", brutto: "emerald", "extras.premiaBase": "emerald", "extras.premiaAgram": "emerald",
  "extras.premiaEs": "emerald", "extras.doplataNocna": "emerald", "extras.doplataEs": "emerald", "extras.zwrotKosztow": "emerald",
  zaliczka: "orange", zaliczkaBd: "orange", hostel: "orange", odziez: "orange", dojazd: "orange",
  kara: "orange", komornik: "orange", kaucja: "orange", potracenia: "orange",
  "extras.karaKlient": "orange", "extras.karaEs": "orange", "extras.zadluzenie": "orange",
  "extras.badania": "orange", "extras.nakladki": "orange", "extras.migawka": "orange",
  "extras.kartaPobytu": "orange", "extras.oplataKierowcy": "orange", "extras.dokumenty": "orange",
};
// «не оформлений» (без форми легалізації і не студент — дзеркало бейджа «?») і
// «не поданий» (oczekuje — чекає дозвіл): підсвічуються червоним — на них треба реагувати
const isUnlegalized = (r: { legalStatus?: string | null; isStudent?: boolean | null }) =>
  (!r.legalStatus && !r.isStudent) || r.legalStatus === "oczekuje";
const extraLabel = (k: string) => EXTRA_LABEL[k] ?? k;
const EXTRA_STUDENTS = "Додаткові студенти";
const OFFICE_CITY = "Офіс"; // віртуальна вкладка поряд із містами
const TOTAL_CITY = "Підсумок"; // віртуальна вкладка: підсумок по всьому місяцю
const OFFICE_RE = /^OFFICE|^ОФИС|^ОФІС|^OFIS/i;
const isSpecial = (label: string) => OFFICE_RE.test(label) || label === EXTRA_STUDENTS;
// Фірма з назви вкладки — для міток, що самі несуть фірму (мульти-контрактні
// «ANDROS KLINEX»/«ANDROS EURO SUPORT», офісні «OFFICE ES OUTSOURCING»);
// «OUTS» перевіряємо першим, бо в назві поруч стоїть і «ES»
const labelFirm = (label: string): string | null =>
  /OUTS/i.test(label) ? "ESO" : /KLINEX/i.test(label) ? "Klinex" : /EURO ?SUP|(^|\s)ES(\s|$)/i.test(label) ? "ES" : null;
const fmt = (v: unknown) => typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : "";
const r2 = (n: number) => Math.round(n * 100) / 100;
const STD_RATIO = 31.4 / 25.35;

// Księgowa пара ставок (дзеркало бекенду): студентська неоподаткована — як є,
// решта — нижча зі ставок (мінімальна пара року, з налаштувань — GET /svodni)
let KSIEG_MIN = { netto: 25.35, brutto: 31.4 };
const untaxedStud = (r: Row) => (r.isStudent || r.legalStatus === "student") && r.rateBrutto != null && r.rateNetto != null && r.rateBrutto <= r.rateNetto + 0.001;
const ksiegRate = (r: Row) => untaxedStud(r) ? r.rateNetto! : Math.min(r.rateNetto ?? KSIEG_MIN.netto, KSIEG_MIN.netto);
const ksiegRateBr = (r: Row) => untaxedStud(r) ? r.rateBrutto! : Math.min(r.rateBrutto ?? KSIEG_MIN.brutto, KSIEG_MIN.brutto);

// Формула клітинки з реальними числами («як в екселі») — показується в тултіпі.
// Дзеркалить перерахунок бекенду: computePayout / computeKsiegHours / applyLegalDefaults.
function cellFormula(r: Row, key: string, t: (s: string) => string): string | null {
  const ex = (k: string) => (typeof r.extras[k] === "number" ? (r.extras[k] as number) : 0);
  const f = (v: number | null | undefined) => fmt(r2(v ?? 0));
  const studentDo26 = !!r.isStudent && !!r.under26;
  const oczekuje = r.legalStatus === "oczekuje";
  const pref = r.payoutPref;
  const prefText = pref
    ? pref.kind === "all_konto" ? t("Побажання працівника: все на конто")
      : pref.kind === "hours" ? `${t("Побажання працівника")}: ${fmt(pref.value ?? 0)} ${t("год")} ${t("на конто")}`
      : `${t("Побажання працівника")}: ${fmt(pref.value ?? 0)} zł ${t("на конто")}`
    : null;
  // сума з компонентів: [лейбл, значення, знак]; нульові пропускаються
  const build = (parts: [string, number | null | undefined, 1 | -1][], total: number | null | undefined) => {
    const used = parts.filter(([, v]) => v != null && v !== 0);
    if (!used.length || total == null) return null;
    return used.map(([l, v, s], i) => `${i === 0 ? (s < 0 ? "−" : "") : s > 0 ? " + " : " − "}${l} ${f(Math.abs(v!))}`).join("") + ` = ${f(total)}`;
  };
  switch (key) {
    case "doWyplaty": {
      if (r.city === "Лодзь") return build([
        [`${t("Години")} ${f(r.hours)} × ${t("Ставка нет.")}`, (r.hours ?? 0) * (r.rateNetto ?? 0), 1],
        ["Migawka", ex("migawka"), 1], [t("Премія"), r.premia, 1],
        [t("Dojazd (доплата)"), r.dojazd, 1], // у Лодзі доїзд ДОПЛАЧУЮТЬ
        ["Zaliczka", r.zaliczka, -1], ["Potrącenia", r.potracenia, -1], ["Hostel", r.hostel, -1],
        ["Odzież", r.odziez, -1], ["Dokumenty", ex("dokumenty"), -1],
      ], r.doWyplaty);
      return build([
        [`${t("Години")} ${f(r.hours)} × ${t("Ставка нет.")}`, (r.hours ?? 0) * (r.rateNetto ?? 0), 1],
        [`${t("Нічні [год]")} ${f(ex("nocneH"))} × ${t("Допл. нічні")}`, ex("nocneH") * ex("doplataNocna"), 1],
        [`Premia ES ${f(ex("premiaEs"))}/${t("год")} × ${f(r.hours)}`, ex("premiaEs") * (r.hours ?? 0), 1],
        [t("Премія"), r.premia, 1], [t("Оплата водія"), ex("oplataKierowcy"), 1],
        ["Dopłata ES", ex("doplataEs"), 1], ["Zwrot kosztów", ex("zwrotKosztow"), 1],
        ["Zaliczka", r.zaliczka, -1], ["Zaliczka BD", r.zaliczkaBd, -1], ["Hostel", r.hostel, -1],
        ["Odzież", r.odziez, -1], ["Dojazd", r.dojazd, -1], ["Kara", r.kara, -1],
        ["Komornik", r.komornik, -1], ["Kaucja", r.kaucja, -1], [t("Potrącenia"), r.potracenia, -1],
        ["Badania", ex("badania"), -1], ["Karta pobytu", ex("kartaPobytu"), -1],
        [t("Кара клієнта"), ex("karaKlient"), -1], [t("Кара ES"), ex("karaEs"), -1],
        [t("Заборгованість"), ex("zadluzenie"), -1],
      ], r.doWyplaty);
    }
    case "brutto":
      if (/SUSHI/i.test(r.factoryLabel)) return `Godzin fakt ${f(ex("ksiegHours"))} × 30,5 = ${f(r.brutto)}`;
      if (r.hours != null && r.rateBrutto != null && r.brutto != null)
        return `${t("Години")} ${f(r.hours)} × ${t("Ставка бр.")} ${f(r.rateBrutto)} = ${f(r.brutto)}`;
      return null;
    case "premia": {
      const parts = ["premiaBase", "premiaAgram", "premiaEs"].filter(k => ex(k));
      if (parts.length < 2) return null;
      return parts.map(k => `${extraLabel(k)} ${f(ex(k))}`).join(" + ") + ` = ${f(r.premia)}`;
    }
    case "hoursDeclared": {
      if (prefText) return `${prefText}`;
      if (studentDo26) return `${t("Студент до 26: усі години офіційні")} = ${f(r.hoursDeclared)}`;
      if (r.hoursNotified != null && r.hoursNotified > 0 && r.hours != null && r.hoursDeclared != null)
        return `${t("Офіційно — години oświadczenia, але не більше відпрацьованих")}: min(${f(r.hoursNotified)}, ${f(r.hours)}) = ${f(r.hoursDeclared)}`;
      if (oczekuje || !r.legalStatus) return `${t("Не оформлений: офіційних годин немає")} = 0`;
      return `${t(LEGAL_LABEL[r.legalStatus as LegalStatus] ?? "Оформлений")} ${t("без год. oświadczenia: усі години офіційні")} = ${f(r.hoursDeclared)}`;
    }
    case "ksiegNetto":
      if (prefText) return `${prefText} = ${f(r.ksiegNetto)}`;
      if (studentDo26) return `${t("Студент до 26: усе «До виплати» йде на конто")} = ${f(r.ksiegNetto)}`;
      if (r.hoursDeclared != null && r.hoursNotified != null && r.hoursNotified > 0 && r.rateNetto != null && r.ksiegNetto != null)
        return `${t("Год. księg.")} ${f(r.hoursDeclared)} × ${t("Ставка нет.")} ${f(ksiegRate(r))} = ${f(r.ksiegNetto)}`;
      if (oczekuje || !r.legalStatus) return `${t("Не оформлений: все готівкою")} → 0`;
      return `${t(LEGAL_LABEL[r.legalStatus as LegalStatus] ?? "Оформлений")}: ${t("усе «До виплати» на конто")} = ${f(r.ksiegNetto)}`;
    case "ksiegBrutto": {
      if (studentDo26) return `${t("Студент: без податків (brutto = netto)")} = ${f(r.ksiegBrutto)}`;
      if (oczekuje || !r.legalStatus) return `${t("Не оформлений: все готівкою")} → 0`;
      if (r.ksiegNetto != null && r.rateNetto != null && r.rateBrutto != null && r.ksiegBrutto != null) {
        return `${t("Конто")} ${f(r.ksiegNetto)} ÷ ${t("Ставка нет.")} ${f(ksiegRate(r))} × ${t("Ставка бр.")} ${f(ksiegRateBr(r))} = ${f(r.ksiegBrutto)}`;
      }
      return null;
    }
    case "konto":
      return r.konto != null ? `= ${t("Księg. netto (конто)")} ${f(r.konto)}` : null;
    case "gotowka":
      if (prefText) return `${prefText}; ${t("решта готівкою")} = ${f(r.gotowka)}`;
      if (studentDo26) return `${t("Студент до 26: усе на конто, готівки немає")} = 0`;
      if (r.hoursNotified != null && r.hoursNotified > 0 && r.gotowka != null && r.doWyplaty != null && r.ksiegNetto != null)
        return `${t("До виплати")} ${f(r.doWyplaty)} − ${t("Księg. netto (конто)")} ${f(r.ksiegNetto)}${ex("doplataEs") ? ` + Dopłata ES ${f(ex("doplataEs"))}` : ""} = ${f(r.gotowka)}`;
      if (oczekuje || !r.legalStatus) return `${t("Не оформлений: усе «До виплати» готівкою")} = ${f(r.gotowka)}`;
      return `${t(LEGAL_LABEL[r.legalStatus as LegalStatus] ?? "Оформлений")}: ${t("усе на конто, готівки немає")} = 0`;
    default:
      return null;
  }
}

// остання позиція на сторінці (місяць/місто/фабрика) — переживає перехід у
// профіль працівника і повернення «назад» (sessionStorage, у межах вкладки)
const readNav = (): { m?: string; c?: string; f?: string } => {
  try { return JSON.parse(sessionStorage.getItem("svodni.nav") ?? "{}"); } catch { return {}; }
};

export default function Svodni() {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const [month, setMonth] = useState<string>(() => readNav().m ?? "");
  const [city, setCity] = useState<string>(() => readNav().c ?? "");
  const [factory, setFactory] = useState<string>(() => readNav().f ?? "");
  const [showLinks, setShowLinks] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const [search, setSearch] = useState("");
  const [legalFilter, setLegalFilter] = useState("");
  const [excelOpen, setExcelOpen] = useState(false);
  // «Без порожніх колонок» — типово УВІМКНЕНО (показуємо лише стовпчики з даними)
  const [hideEmptyCols, setHideEmptyCols] = useState(() => localStorage.getItem("svodni.hideEmptyCols") !== "0");
  const [hideKsieg, setHideKsieg] = useState(() => localStorage.getItem("svodni.hideKsieg") === "1");
  const toggleEmptyCols = () => setHideEmptyCols(v => { localStorage.setItem("svodni.hideEmptyCols", v ? "0" : "1"); return !v; });
  const toggleKsieg = () => setHideKsieg(v => { localStorage.setItem("svodni.hideKsieg", v ? "0" : "1"); return !v; });
  // видимість колонок: свій набір на кожну (місяць, місто, фабрика) і лише в
  // цьому браузері (localStorage) — інші користувачі мають власні налаштування
  const [colsVer, setColsVer] = useState(0); // інкремент після кожного запису — useMemo перечитує

  const { data: monthsData } = useQuery<{ months: string[] }>({ queryKey: ["svodni-months"], queryFn: () => get("/svodni/months") });
  const months = monthsData?.months ?? [];
  const effMonth = month || months[0] || "";

  const { data, isFetching } = useQuery<Data>({
    queryKey: ["svodni", effMonth], enabled: !!effMonth,
    queryFn: () => get(`/svodni?month=${effMonth}`),
  });
  // мінімальна пара року для формул-тултіпів (з налаштувань, приходить з API)
  useEffect(() => { if (data?.ksiegMin) KSIEG_MIN = data.ksiegMin; }, [data?.ksiegMin]);
  // Персональний порядок міст (drag-and-drop, admins.web_prefs); «Офіс» і
  // «Підсумок» — приколоті в кінці, не перетягуються
  const [cityOrder, saveCityOrder] = useOrderPref("order.svodni.cities");
  const regularCities = useMemo(() => orderBy((data?.cities ?? []).filter(c => c !== OFFICE_CITY), c => c, cityOrder), [data, cityOrder]);
  const cityDrag = useDragOrder(regularCities, saveCityOrder);
  const cityTabs = useMemo(() => [
    ...regularCities,
    ...(data?.sensitive ? [OFFICE_CITY] : []),
    ...((data?.rows.length ?? 0) > 0 ? [TOTAL_CITY] : []),
  ], [regularCities, data]);
  const effCity = cityTabs.includes(city) ? city : cityTabs[0] ?? "";
  // «Офіс» збирає офісні вкладки всіх міст + додаткових студентів;
  // з міських вкладок вони відповідно прибрані
  const cityRows = useMemo(() => (data?.rows ?? []).filter(r =>
    effCity === TOTAL_CITY ? false :
    effCity === OFFICE_CITY ? isSpecial(r.factoryLabel) : (r.city === effCity && !isSpecial(r.factoryLabel))
  ), [data, effCity]);
  // фабрики міста: з рядків ∪ зі звірок імпорту — порожні вкладки (фабрика без
  // людей цього місяця) теж мають бути видимі з повним набором колонок
  const factories = useMemo(() => {
    if (effCity === TOTAL_CITY) return [];
    const set = new Set(cityRows.map(r => r.factoryLabel));
    if (effCity === OFFICE_CITY) {
      set.add(EXTRA_STUDENTS); // завжди доступна для наповнення
    } else {
      for (const c of (data?.checks ?? [])) {
        if (c.city === effCity && !c.factoryLabel.includes(" + ") && !isSpecial(c.factoryLabel)) set.add(c.factoryLabel);
      }
    }
    const rank = (f: string) => f === EXTRA_STUDENTS ? 2 : cityRows.some(r => r.factoryLabel === f) ? 0 : 1;
    return [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [cityRows, data, effCity]);
  // Персональний порядок фабрик — окремий на кожне місто
  const [facOrder, saveFacOrder] = useOrderPref(`order.svodni.factories.${effCity}`);
  const orderedFactories = useMemo(() => orderBy(factories, f => f, facOrder), [factories, facOrder]);
  const facDrag = useDragOrder(orderedFactories, saveFacOrder);
  const effFactory = factories.includes(factory) ? factory : orderedFactories[0] ?? "";
  useEffect(() => { if (factory && !factories.includes(factory) && orderedFactories.length) setFactory(orderedFactories[0]!); }, [factories]); // eslint-disable-line react-hooks/exhaustive-deps
  // запам'ятати позицію (для повернення зі сторінки профілю)
  useEffect(() => {
    try { sessionStorage.setItem("svodni.nav", JSON.stringify({ m: effMonth, c: effCity, f: effFactory })); } catch { /* ignore */ }
  }, [effMonth, effCity, effFactory]);
  // ключ набору прихованих колонок: конкретна фабрика конкретного місяця
  const colsScopeKey = `svodni.hiddenCols.${effMonth}.${effCity}.${effFactory}`;
  // синхронно з localStorage: useEffect-варіант давав кадр зі списком
  // прихованих колонок ПОПЕРЕДНЬОЇ фабрики після перемикання вкладки
  const hiddenCols = useMemo<Set<string>>(() => {
    void colsVer;
    try { return new Set(JSON.parse(localStorage.getItem(colsScopeKey) ?? "[]")); }
    catch { return new Set(); }
  }, [colsScopeKey, colsVer]);
  const setHidden = (n: Set<string>) => {
    try { localStorage.setItem(colsScopeKey, JSON.stringify([...n])); } catch { /* ignore */ }
    setColsVer(v => v + 1);
  };
  const toggleCol = (k: string) => {
    const n = new Set(hiddenCols);
    n.has(k) ? n.delete(k) : n.add(k);
    setHidden(n);
  };
  // пошук по імені + фільтр форми легалізації (застосовуються до рядків міста)
  const matchesFilters = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (r: Row) => {
      if (q && !(r.workerName ?? r.rawName).toLowerCase().includes(q)) return false;
      if (legalFilter === "none") return r.legalStatus == null;
      if (legalFilter && r.legalStatus !== legalFilter) return false;
      return true;
    };
  }, [search, legalFilter]);
  const filterActive = !!search.trim() || !!legalFilter;
  const rows = useMemo(() => cityRows.filter(r => r.factoryLabel === effFactory).filter(matchesFilters), [cityRows, effFactory, matchesFilters]);
  // локи затвердження: місто цілком або конкретна фабрика
  const locks = data?.locks ?? [];
  const isCityLocked = (c: string) => locks.some(l => l.city === c && l.factoryLabel === "");
  const isFactoryLocked = (c: string, f: string) => isCityLocked(c) || locks.some(l => l.city === c && l.factoryLabel === f);
  const lockToggle = useMutation({
    mutationFn: (v: { city: string; factoryLabel: string }) => post<{ locked: boolean }>("/svodni/lock", { month: effMonth, ...v }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["svodni"] }); toast.success(r.locked ? t("Затверджено 🔒") : t("Розблоковано")); },
    onError: (e: any) => toast.error(e.message),
  });
  const checks = useMemo(() => (data?.checks ?? []).filter(c => c.factoryLabel.split(" + ").includes(effFactory)), [data, effFactory]);
  // extras-колонки міста: каталожні (для ручного вводу — нічні, migawka, кари…)
  // ЗАВЖДИ доступні, навіть порожні (тумблер «Без порожніх колонок» їх ховає);
  // плюс усі числові ключі з даних (фабричні нюанси на кшталт Sushi)
  const cityExtraKeys = useMemo(() => {
    const SENSITIVE = new Set(["kontoH", "gotowkaH", "doplataEs", "godzFaktBlock", "zaliczkaBlock"]);
    const keys = new Set<string>(EXTRA_ORDER.filter(k => data?.sensitive || !SENSITIVE.has(k)));
    for (const r of cityRows) for (const [k, v] of Object.entries(r.extras)) {
      if (typeof v === "number" && k !== "blockOnly") keys.add(k);
    }
    const idx = (k: string) => { const i = EXTRA_ORDER.indexOf(k); return i < 0 ? EXTRA_ORDER.length : i; };
    return [...keys].sort((a, b) => idx(a) - idx(b) || a.localeCompare(b));
  }, [cityRows, data?.sensitive]);
  // кадрові колонки: базовий набір + усі hr-ключі, що є в даних міста
  const cityHrCols = useMemo(() => {
    const cols = new Map<string, string>(HR_COLS);
    const order = Object.keys(HR_LABEL);
    const found = new Set<string>();
    for (const r of cityRows) for (const k of Object.keys(r.hr)) if (r.hr[k]) found.add(k);
    const dynamic = [...found].filter(k => !cols.has(`hr.${k}`))
      .sort((a, b) => (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1) || a.localeCompare(b));
    for (const k of dynamic) cols.set(`hr.${k}`, HR_LABEL[k] ?? k);
    return [...cols.entries()] as [string, string][];
  }, [cityRows]);
  const allColumns: [string, string][] = useMemo(() => [
    ...OPEN_COLS as [string, string][],
    ...cityExtraKeys.map(k => [`extras.${k}`, extraLabel(k)] as [string, string]),
    ...cityHrCols,
    ...(data?.sensitive ? SENS_COLS as [string, string][] : []),
  ], [cityExtraKeys, cityHrCols, data?.sensitive]);
  const visible = useMemo(() => {
    const v = new Set(allColumns.map(([k]) => k).filter(k => !hiddenCols.has(k)));
    if (hideKsieg) for (const [k] of SENS_COLS) v.delete(k);
    return v;
  }, [allColumns, hiddenCols, hideKsieg]);
  // колонки, приховані не вручну, а тумблерами («Без порожніх колонок» /
  // «Księgowe: сховано») — чіпси в панелі показують їх окремим станом,
  // інакше чіп виглядає активним, а колонки в таблиці нема
  // порожність рахуємо по ВСІХ рядках фабрики (без пошуку/фільтрів) — інакше
  // колонки «стрибають» під час набору в пошуку
  const factoryAllRows = useMemo(() => cityRows.filter(r => r.factoryLabel === effFactory), [cityRows, effFactory]);
  const colHasVal = (k: string) => factoryAllRows.some(r =>
    k.startsWith("extras.") ? r.extras[k.slice(7)] != null :
    k.startsWith("hr.") ? !!r.hr[k.slice(3)] :
    (r as any)[k] != null);
  const emptyHiddenCol = (k: string) => hideEmptyCols && factoryAllRows.length > 0 && !colHasVal(k);
  const ksiegHiddenCol = (k: string) => hideKsieg && SENS_COLS.some(([s]) => s === k);
  const autoHiddenCount = allColumns.filter(([k]) => !hiddenCols.has(k) && (emptyHiddenCol(k) || ksiegHiddenCol(k))).length;
  const showAllCols = () => {
    setHidden(new Set());
    if (hideEmptyCols) toggleEmptyCols();
    if (hideKsieg) toggleKsieg();
  };

  const sync = useMutation({
    mutationFn: (onlyCity?: string) => post("/svodni/sync", { months: [effMonth], ...(onlyCity ? { city: onlyCity } : {}) }),
    onSuccess: (_r, onlyCity) => { qc.invalidateQueries({ queryKey: ["svodni"] }); qc.invalidateQueries({ queryKey: ["svodni-unmatched"] }); toast.success(onlyCity ? t("Синхронізовано з Google: {city}", { city: t(onlyCity) }) : t("Синхронізовано з Google")); },
    onError: (e: any) => toast.error(e.message),
  });
  const rematch = useMutation({
    mutationFn: () => post<{ linked: number }>("/svodni/rematch", {}),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["svodni"] }); qc.invalidateQueries({ queryKey: ["svodni-unmatched"] }); toast.success(t("Підвʼязано рядків: {n}", { n: r.linked })); },
    onError: (e: any) => toast.error(e.message),
  });
  const applyRates = useMutation({
    mutationFn: () => post<{ updated: number }>("/svodni/apply-rates", { month: effMonth }),
    onSuccess: (r) => toast.success(t("Оновлено працівників: {n}", { n: r.updated })),
    onError: (e: any) => toast.error(e.message),
  });

  // маркери на вкладки фабрик: розбіжності/ручні правки; при активному фільтрі
  // лічильник показує кількість збігів
  const factoryFlags = useMemo(() => {
    const m = new Map<string, { count: number; mismatch: boolean; manual: boolean; firm: string | null }>();
    for (const f of factories) {
      const fr = cityRows.filter(r => r.factoryLabel === f);
      const cnt = filterActive ? fr.filter(matchesFilters).length : fr.length;
      m.set(f, { count: cnt, mismatch: fr.some(r => r.mismatch), manual: fr.some(r => r.manual), firm: labelFirm(f) ?? fr.find(r => r.firm)?.firm ?? null });
    }
    return m;
  }, [factories, cityRows, filterActive, matchesFilters]);

  return (
    <>
      <PageHeader title={t("Сводні")} subtitle={t("Зарплатні таблиці по містах — дзеркало з перевіркою формул")} />

      {/* панель керування */}
      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={effMonth} onChange={e => setMonth(e.target.value)} className="font-medium">
            {months.map(m => <option key={m} value={m}>{m}</option>)}
          </Select>
          <div className="flex rounded-xl bg-slate-100 p-1">
            {cityTabs.map(c => (
              <button key={c} onClick={() => { setCity(c); setFactory(""); }}
                {...(c !== OFFICE_CITY && c !== TOTAL_CITY ? { ...cityDrag(c), title: t("Перетягни, щоб змінити порядок") } : {})}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${effCity === c ? "bg-white text-red-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                {c === OFFICE_CITY ? "🏢 " : c === TOTAL_CITY ? "📊 " : ""}{t(c)}
              </button>
            ))}
          </div>
          <div className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" />
          <button onClick={() => setShowCols(v => !v)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${showCols ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
            <Columns3 className="h-3.5 w-3.5" /> {t("Колонки")}
            {hiddenCols.size > 0 && (
              <span className="rounded-full bg-rose-100 px-1.5 text-[10px] font-semibold text-rose-700" title={t("Приховано колонок — клікни, щоб показати список")}>
                −{hiddenCols.size}
              </span>
            )}
          </button>
          <button onClick={toggleEmptyCols}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${hideEmptyCols ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`}
            title={t("Ховає колонки без жодного значення в цій фабриці")}>
            {t("Без порожніх колонок")}
          </button>
          {data?.sensitive && (
            <button onClick={toggleKsieg}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${hideKsieg ? "bg-amber-500 text-white" : "text-amber-700 hover:bg-amber-50"}`}
              title={t("Швидко сховати/показати księgowe колонки")}>
              {hideKsieg ? t("Księgowe: сховано") : t("Księgowe: видно")}
            </button>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setExcelOpen(true)} title={t("Скачати Excel")}><Download className="h-4 w-4" /> Excel</Button>
            <Button variant="secondary" onClick={() => setShowLinks(v => !v)}><Users className="h-4 w-4" /> {t("Привʼязки")}</Button>
            <Button variant="secondary" loading={rematch.isPending} onClick={() => rematch.mutate()} title={t("Пробує підвʼязати нерозпізнаних людей до працівників")}><Link2 className="h-4 w-4" /></Button>
            <Button variant="secondary" loading={sync.isPending} onClick={() => sync.mutate(undefined)} title={t("Синк із Google (всі міста)")}><RefreshCw className="h-4 w-4" /></Button>
            {can(me, "viewFinance") && (
              <Button variant="secondary" loading={applyRates.isPending} onClick={() => applyRates.mutate()}>{t("Ставки → профілі")}</Button>
            )}
          </div>
        </div>

        {/* пошук + фільтри + дії міста */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-300" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("Пошук по імені…")}
              className="w-56 rounded-lg border border-slate-200 py-1.5 pl-8 pr-7 text-sm focus:border-red-400 focus:outline-none" />
            {search && <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">×</button>}
          </div>
          <Select value={legalFilter} onChange={e => setLegalFilter(e.target.value)} className="w-48 text-sm">
            <option value="">{t("Легалізація: всі")}</option>
            <option value="none">{t("Не оформлені")}</option>
            {Object.entries(LEGAL_LABEL).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
          </Select>
          {filterActive && <Badge color="amber">{t("фільтр активний")}</Badge>}
          {effCity && effCity !== TOTAL_CITY && effCity !== OFFICE_CITY && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button onClick={() => sync.mutate(effCity)} disabled={sync.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                <RefreshCw className="h-3.5 w-3.5" /> {t("Підтягнути з таблиць")}: {t(effCity)}
              </button>
              <button onClick={() => lockToggle.mutate({ city: effCity, factoryLabel: "" })} disabled={lockToggle.isPending}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                  isCityLocked(effCity) ? "bg-emerald-600 text-white hover:bg-emerald-700" : "border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"}`}>
                {isCityLocked(effCity) ? <><LockOpen className="h-3.5 w-3.5" /> {t("Розблокувати місто")}</> : <><Lock className="h-3.5 w-3.5" /> {t("Затвердити місто")}</>}
              </button>
            </div>
          )}
        </div>

        {/* фільтр колонок */}
        {showCols && (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="mb-2 flex items-center gap-3 text-[11px]">
              <span className="font-semibold uppercase tracking-wide text-slate-400">{t("Видимі колонки")}</span>
              <button className="text-red-600 hover:underline" onClick={showAllCols} title={t("Показати всі колонки — включно з порожніми та księgowe")}>{t("показати всі")}</button>
              {autoHiddenCount > 0 && <span className="text-slate-400">{t("сховано тумблерами: {n}", { n: autoHiddenCount })}</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allColumns.map(([k, hRaw]) => {
                const h = k === "dojazd" && effCity === "Лодзь" ? "Dojazd (доплата)" : hRaw;
                const manualOff = hiddenCols.has(k);
                const autoOff = !manualOff && (emptyHiddenCol(k) || ksiegHiddenCol(k));
                return (
                  <button key={k}
                    title={!autoOff ? undefined : emptyHiddenCol(k)
                      ? t("Порожня — схована тумблером «Без порожніх колонок»; клік вимкне тумблер")
                      : t("Схована тумблером «Księgowe: сховано»; клік поверне księgowe")}
                    onClick={() => {
                      if (!autoOff) return toggleCol(k);
                      if (emptyHiddenCol(k)) toggleEmptyCols(); else toggleKsieg();
                    }}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                      autoOff ? "bg-amber-50 text-amber-600 ring-1 ring-amber-200"
                      : !manualOff ? "bg-red-50 text-red-700 ring-1 ring-red-200"
                      : "bg-slate-50 text-slate-400 ring-1 ring-slate-200 line-through"}`}>
                    {t(h)}{autoOff && emptyHiddenCol(k) ? ` · ${t("порожня")}` : ""}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      {/* вкладки фабрик міста */}
      {factories.length > 0 && (
        <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
          {orderedFactories.map(f => {
            const fl = factoryFlags.get(f)!;
            const active = effFactory === f;
            const special = f === EXTRA_STUDENTS;
            const fc = fl.firm ? FIRM_TAB[fl.firm] : undefined;
            return (
              <button key={f} onClick={() => setFactory(f)}
                {...facDrag(f)} title={t("Перетягни, щоб змінити порядок")}
                className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition ${
                  active ? "border-red-600 bg-red-600 text-white shadow-sm"
                  : special ? "border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-400"
                  : fc ? fc.idle
                  : "border-slate-200 bg-white text-slate-600 hover:border-red-300"}`}>
                {fc && <span className={`h-2 w-2 shrink-0 rounded-full ${fc.dot} ${active ? "ring-1 ring-white/80" : ""}`} />}
                {isFactoryLocked(effCity, f) ? "🔒 " : ""}{f === EXTRA_STUDENTS ? "🎓 " : OFFICE_RE.test(f) ? "🏢 " : ""}{f}
                <span className={`rounded-full px-1.5 text-[10px] font-medium ${active ? "bg-red-500 text-red-50" : "bg-slate-100 text-slate-500"}`}>{fl.count}</span>
                {(data?.staleLocks ?? []).some(l => l.city === effCity && (l.factoryLabel === "" || l.factoryLabel === f)) && (
                  <span title={t("Профілі людей змінились після затвердження — переглянь лок")}>❗</span>
                )}
                {fl.mismatch && <span title={t("є розбіжності формул")}>⚠</span>}
                {fl.manual && <PencilLine className={`h-3 w-3 ${active ? "text-red-100" : "text-sky-500"}`} />}
              </button>
            );
          })}
        </div>
      )}

      {showLinks && <UnmatchedPanel />}

      {isFetching && !data ? <Spinner /> : effCity === TOTAL_CITY ? (
        // «Підсумок» — лише фабрики: офісні вкладки і «Додаткові студенти»
        // мають власний підсумок на вкладці «Офіс» і в загальний не входять
        <div className="space-y-4">
          <SummaryBlock rows={(data?.rows ?? []).filter(r => !isSpecial(r.factoryLabel))} sensitive={!!data?.sensitive} />
          <TotalBreakdown rows={(data?.rows ?? []).filter(r => !isSpecial(r.factoryLabel))} sensitive={!!data?.sensitive} />
        </div>
      ) : !factories.length ? (
        <Empty>{t("Немає даних за цей місяць — запусти «Синк із Google»")}</Empty>
      ) : (
        <div className="space-y-4">
          <FactoryTable month={effMonth} city={effCity} label={effFactory} rows={rows} checks={checks} sensitive={!!data?.sensitive}
            visible={visible} cityExtraKeys={cityExtraKeys} cityHrCols={cityHrCols} hideEmptyCols={hideEmptyCols} onHideCol={toggleCol} cityRows={cityRows}
            meta={data?.tabMeta?.find(m => m.factoryLabel === effFactory && (effCity === OFFICE_CITY || m.city === effCity))}
            locked={isFactoryLocked(effCity, effFactory)} cityLocked={isCityLocked(effCity)}
            onToggleLock={() => lockToggle.mutate({ city: effCity, factoryLabel: effFactory })} lockPending={lockToggle.isPending} />
          <SummaryBlock rows={rows} sensitive={!!data?.sensitive} />
        </div>
      )}
      {excelOpen && (
        <ExcelModal month={effMonth} city={effCity !== TOTAL_CITY && effCity !== OFFICE_CITY ? effCity : null}
          factory={effFactory && !isSpecial(effFactory) ? effFactory : null} sensitive={!!data?.sensitive} onClose={() => setExcelOpen(false)} />
      )}
    </>
  );
}

// Заголовок колонки з кнопкою «сховати» (зʼявляється при наведенні)
function Th({ label, onHide, left, amber, strong, divider, tint, onSort, sortDir }: {
  label: string; onHide: () => void; left?: boolean; amber?: boolean; strong?: boolean; divider?: boolean; tint?: string;
  onSort?: () => void; sortDir?: "asc" | "desc" | null;
}) {
  const t = useT();
  return (
    <th className={`group/th px-1.5 py-2.5 whitespace-nowrap text-xs font-semibold uppercase tracking-wide ${
      left ? "text-left" : "text-right"} ${divider ? (amber ? "border-l-2 border-amber-300 " : "border-l-2 border-slate-300 ") : ""}${amber ? "bg-amber-100/80 text-amber-700" : strong ? "border-x-2 border-red-200 bg-red-100/70 text-red-700" : tint ?? "text-slate-500"}`}>
      <span className="inline-flex items-center gap-0.5">
        {onSort ? (
          <button type="button" onClick={onSort} title={t("Сортувати")} className="inline-flex items-center gap-0.5 uppercase hover:text-slate-600">
            {label}
            {sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : sortDir === "desc" ? <ArrowDown className="h-3 w-3" /> : null}
          </button>
        ) : label}
        <button type="button" onClick={onHide} title={t("Сховати колонку")}
          className="invisible rounded px-0.5 text-slate-300 hover:bg-slate-200 hover:text-slate-600 group-hover/th:visible">×</button>
      </span>
    </th>
  );
}

// Глобальний тултіп формул: singleton із position:fixed — показується миттєво
// при наведенні і не ріжеться overflow-скролом таблиці (на відміну від title).
let tipEl: HTMLDivElement | null = null;
function showFormulaTip(e: React.MouseEvent, text: string) {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "pointer-events-none fixed z-50 max-w-md whitespace-pre-line rounded-lg bg-slate-800 px-3 py-2 text-[11px] leading-relaxed text-white shadow-xl";
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = text;
  tipEl.style.display = "block";
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const w = Math.min(tipEl.offsetWidth, 448);
  tipEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  const h = tipEl.offsetHeight;
  tipEl.style.top = `${r.top - h - 6 < 4 ? r.bottom + 6 : r.top - h - 6}px`;
}
function hideFormulaTip() { if (tipEl) tipEl.style.display = "none"; }

// Редагована клітинка: клік → інпут (для кадрових — випадаючий список значень
// колонки, як data validation в екселі), Enter/blur → PATCH. Порожнє = очистити.
if (typeof window !== "undefined") window.addEventListener("scroll", () => hideFormulaTip(), true);

function EditableCell({ row, field, value, month, text, strong, options, formula, locked }: {
  row: Row; field: string; value: unknown; month: string; text?: boolean; strong?: boolean; options?: string[]; formula?: string | null; locked?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [freeText, setFreeText] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: (v: string) => patch<Row>(`/svodni/rows/${row.id}`, { field, value: v === "" ? null : v }),
    onSuccess: (updated) => {
      qc.setQueryData<Data>(["svodni", month], old => old ? { ...old, rows: old.rows.map(r => r.id === updated.id ? updated : r) } : old);
      setEditing(false);
      setFreeText(false);
    },
    onError: (e: any) => { toast.error(e.message); setEditing(false); setFreeText(false); },
  });
  // хуки вище — ПЕРЕД цим return, інакше зміна лока міняє їх кількість (креш React)
  if (locked) {
    // затверджена фабрика: значення лише читаються (формула в тултіпі лишається)
    return (
      <span onMouseEnter={formula ? (e) => showFormulaTip(e, formula) : undefined} onMouseLeave={formula ? hideFormulaTip : undefined}
        className={`block w-full rounded px-1 py-1 tabular-nums ${text ? "text-left" : "text-right"} ${strong ? "font-semibold text-slate-900" : ""} ${formula ? "underline decoration-dotted decoration-slate-300 underline-offset-2" : ""}`}>
        {text ? (String(value ?? "") || <span className="text-slate-300">—</span>) : (fmt(value) || <span className="text-slate-300">—</span>)}
      </span>
    );
  }
  if (editing && options?.length && !freeText) {
    // випадаючий список значень колонки (як в екселі) + «(інше…)» для свого тексту
    return (
      <select autoFocus value={draft}
        onChange={e => { if (e.target.value === "__other__") { setFreeText(true); setDraft(""); } else save.mutate(e.target.value); }}
        onBlur={() => setEditing(false)}
        onKeyDown={e => { if (e.key === "Escape") setEditing(false); }}
        className="w-44 rounded-md border border-red-400 bg-white px-1 py-1 text-left text-xs shadow-sm focus:outline-none">
        <option value="">{"—"}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
        <option value="__other__">{t("(інше…)")}</option>
      </select>
    );
  }
  if (editing) {
    return (
      <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={() => save.mutate(draft)}
        onKeyDown={e => { if (e.key === "Enter") save.mutate(draft); if (e.key === "Escape") { setEditing(false); setFreeText(false); } }}
        className={`rounded-md border border-red-400 bg-white px-1 py-1 text-right text-xs shadow-sm focus:outline-none ${text ? "w-40 text-left" : "w-20"}`} />
    );
  }
  return (
    <button type="button"
      onClick={() => { hideFormulaTip(); setDraft(value == null ? "" : String(value)); setEditing(true); }}
      title={formula ? undefined : t("Клікни, щоб редагувати")}
      onMouseEnter={formula ? (e) => showFormulaTip(e, formula) : undefined}
      onMouseLeave={formula ? hideFormulaTip : undefined}
      className={`block w-full cursor-text rounded px-1 py-1 tabular-nums transition hover:bg-red-50 hover:ring-1 hover:ring-red-200 ${
        text ? "text-left" : "text-right"} ${strong ? "font-semibold text-slate-900" : ""} ${formula ? "underline decoration-dotted decoration-slate-300 underline-offset-2" : ""}`}>
      {text ? (String(value ?? "") || <span className="text-slate-300">—</span>) : (fmt(value) || <span className="text-slate-300">—</span>)}
    </button>
  );
}

function FactoryTable({ month, city, label, rows, checks, sensitive, visible, cityExtraKeys, cityHrCols, hideEmptyCols, onHideCol, cityRows, meta, locked, cityLocked, onToggleLock, lockPending }: {
  month: string; city: string; label: string; rows: Row[]; checks: Check[]; sensitive: boolean;
  visible: Set<string>; cityExtraKeys: string[]; cityHrCols: [string, string][]; hideEmptyCols: boolean;
  onHideCol: (key: string) => void; cityRows: Row[]; meta?: TabMeta;
  locked: boolean; cityLocked: boolean; onToggleLock: () => void; lockPending: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  // сортування кліком по заголовку: none → desc → asc; дефолт — секції+алфавіт
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const cycleSort = (key: string) => setSort(s => s?.key !== key ? { key, dir: "desc" } : s.dir === "desc" ? { key, dir: "asc" } : null);
  // скрол-позиція: зберігається при переході в профіль, відновлюється «назад»
  const scrollRef = useRef<HTMLDivElement>(null);
  const saveScroll = () => {
    try { sessionStorage.setItem("svodni.scroll", JSON.stringify({ f: label, win: window.scrollY, top: scrollRef.current?.scrollTop ?? 0 })); } catch { /* ignore */ }
  };
  useEffect(() => {
    if (!rows.length) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem("svodni.scroll") ?? "null");
      if (saved && saved.f === label) {
        sessionStorage.removeItem("svodni.scroll");
        requestAnimationFrame(() => {
          window.scrollTo(0, saved.win ?? 0);
          if (scrollRef.current) scrollRef.current.scrollTop = saved.top ?? 0;
        });
      }
    } catch { /* ignore */ }
  }, [rows.length, label]);
  const removeRow = useMutation({
    mutationFn: (id: number) => del(`/svodni/rows/${id}`),
    onSuccess: (_r, id) => qc.setQueryData<Data>(["svodni", month], old => old ? { ...old, rows: old.rows.filter(r => r.id !== id) } : old),
    onError: (e: any) => toast.error(e.message),
  });
  // порізка місяця: розкриття сегмент-рядків + обʼєднання назад
  const [openSegs, setOpenSegs] = useState<Set<number>>(new Set());
  const toggleSegs = (id: number) => setOpenSegs(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const unsplit = useMutation({
    mutationFn: (id: number) => post(`/svodni/rows/${id}/unsplit`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["svodni"] }); toast.success(t("Сегменти обʼєднано")); },
    onError: (e: any) => toast.error(e.message),
  });
  const segRange = (s: Seg) => (s.from && s.to ? `${s.from.slice(8, 10)}.${s.from.slice(5, 7)}–${s.to.slice(8, 10)}.${s.to.slice(5, 7)}` : "—");
  const hrVal = (r: Row, k: string) => k.startsWith("hr.") ? r.hr[k.slice(3)] : (r.extras as any)[k.slice(7)];
  // порядок рядків: явне сортування користувача > секції-становіска (алфавіт
  // всередині, pl) > порядок таблиці (sortIdx)
  const collator = useMemo(() => new Intl.Collator("pl"), []);
  const cellVal = (r: Row, k: string): unknown =>
    k.startsWith("extras.") ? r.extras[k.slice(7)] : k.startsWith("hr.") ? r.hr[k.slice(3)] : (r as any)[k];
  const sortedRows = useMemo(() => {
    const list = [...rows];
    if (sort) {
      const { key: k, dir } = sort;
      list.sort((a, b) => {
        if (k === "name") return dir === "asc"
          ? collator.compare(a.workerName ?? a.rawName, b.workerName ?? b.rawName)
          : collator.compare(b.workerName ?? b.rawName, a.workerName ?? a.rawName);
        const av = cellVal(a, k), bv = cellVal(b, k);
        const an = typeof av === "number" ? av : av != null && av !== "" ? Number(av) : null;
        const bn = typeof bv === "number" ? bv : bv != null && bv !== "" ? Number(bv) : null;
        if (an != null && !Number.isNaN(an) && bn != null && !Number.isNaN(bn)) return dir === "asc" ? an - bn : bn - an;
        if (an != null && !Number.isNaN(an)) return -1;
        if (bn != null && !Number.isNaN(bn)) return 1;
        return collator.compare(String(av ?? ""), String(bv ?? "")) * (dir === "asc" ? 1 : -1);
      });
      return list;
    }
    if (list.some(r => r.section)) {
      list.sort((a, b) =>
        collator.compare(a.section ?? "￿", b.section ?? "￿")
        || collator.compare(a.workerName ?? a.rawName, b.workerName ?? b.rawName));
    }
    return list;
  }, [rows, sort, collator]);
  // «порожня колонка» = жодного значення в поточній фабриці (тумблер зверху);
  // рахуємо по ВСІХ рядках фабрики — інакше колонки стрибають під час пошуку
  const allFactoryRows = useMemo(() => cityRows.filter(r => r.factoryLabel === label), [cityRows, label]);
  const hasVal = (k: string) => allFactoryRows.some(r =>
    k.startsWith("extras.") ? r.extras[k.slice(7)] != null :
    k.startsWith("hr.") ? !!r.hr[k.slice(3)] :
    (r as any)[k] != null);
  // у порожній фабриці колонки показуються всі (інакше не було б чого бачити)
  const show = (k: string) => visible.has(k) && (!hideEmptyCols || allFactoryRows.length === 0 || hasVal(k));
  // єдиний список колонок у порядку таблиці Google (colOrder вкладки);
  // колонки поза colOrder — у каталожному порядку в кінці, закритий шар — окремо
  const cols = useMemo(() => {
    const defs: { key: string; label: string; kind: "open" | "extra" | "hr" }[] = [
      ...OPEN_COLS.map(([k, h]) => ({ key: k as string, label: h, kind: "open" as const })),
      ...cityExtraKeys.map(k => ({ key: `extras.${k}`, label: extraLabel(k), kind: "extra" as const })),
      ...cityHrCols.map(([k, h]) => ({ key: k, label: h, kind: "hr" as const })),
    ];
    const orderIdx = new Map((meta?.colOrder ?? []).map((k, i) => [k, i]));
    return defs
      .map((d, i) => ({ ...d, ord: orderIdx.get(d.key) ?? 1000 + i }))
      .sort((a, b) => a.ord - b.ord);
  }, [cityExtraKeys, cityHrCols, meta]);
  const shownCols = cols.filter(d => show(d.key));
  const sensCols = sensitive ? SENS_COLS.filter(([k]) => show(k)) : [];
  const colCount = 2 + shownCols.length + sensCols.length; // +імʼя +замітки
  // випадаючі списки кадрових колонок: унікальні значення колонки по місту (як в екселі)
  const hrOptions = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [k] of cityHrCols) {
      const vals = [...new Set(cityRows.map(r => String(hrVal(r, k) ?? "")).filter(Boolean))].sort();
      m.set(k, vals);
    }
    return m;
  }, [cityRows, cityHrCols]);
  const badChecks = checks.filter(c => !c.ok);
  const sum = (f: (r: Row) => number | null | undefined) => r2(rows.reduce((a, r) => a + (f(r) ?? 0), 0));

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
        <span className="text-sm font-bold tracking-tight text-slate-800">{label}</span>
        <Badge color="slate">{rows.length} {t("ос.")}</Badge>
        {rows.some(r => r.manual) && <Badge color="blue">✎ {t("є ручні правки")}</Badge>}
        {badChecks.length
          ? <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700" title={badChecks.map(c => `${c.metric}: ${c.ours} ≠ ${c.sheetSuma ?? c.summaryTab}`).join("; ")}>
              <CircleAlert className="h-3.5 w-3.5" /> {t("суми не сходяться")}
            </span>
          : <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"><CircleCheck className="h-3.5 w-3.5" /> {t("звірено")}</span>}
        {locked && <Badge color="green">🔒 {t("затверджено")}</Badge>}
        <span className="ml-auto text-[11px] text-slate-400">{locked ? t("затверджено — редагування вимкнено") : t("клік по клітинці — редагування")}</span>
        {!locked && (
          <button onClick={() => setAdding(true)}
            className="flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700">
            <UserPlus className="h-3.5 w-3.5" /> {t("Додати людину")}
          </button>
        )}
        {!cityLocked && (
          <button onClick={onToggleLock} disabled={lockPending}
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
              locked ? "bg-emerald-600 text-white hover:bg-emerald-700" : "border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"}`}>
            {locked ? <><LockOpen className="h-3.5 w-3.5" /> {t("Розблокувати")}</> : <><Lock className="h-3.5 w-3.5" /> {t("Затвердити")}</>}
          </button>
        )}
      </div>
      {adding && <AddPersonModal month={month} factoryLabel={label} onClose={() => setAdding(false)}
        city={rows[0]?.city ?? (label === EXTRA_STUDENTS ? OFFICE_CITY : city)} />}
      {meta?.info?.stawkaEurocash && (
        <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t("Ставки Eurocash (за діапазонами годин)")}</div>
          <div className="overflow-x-auto">
            <table className="border-collapse text-xs">
              <tbody>
                {meta.info.stawkaEurocash.map((row, i) => (
                  <tr key={i} className={i === 0 ? "font-semibold text-slate-700" : "text-slate-600"}>
                    {row.map((c, j) => (
                      <td key={j} className={`whitespace-nowrap border border-slate-200 bg-white px-2 py-1 tabular-nums ${j === 0 ? "font-medium text-slate-500" : "text-right"}`}>
                        {typeof c === "number" ? fmt(r2(c)) : c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div ref={scrollRef} className="max-h-[70vh] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-20 border-b-2 border-slate-200 bg-slate-100 shadow-sm">
            <tr>
              <th className="sticky left-0 z-30 bg-slate-100 px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <button type="button" onClick={() => cycleSort("name")} className="inline-flex items-center gap-0.5 uppercase hover:text-slate-700" title={t("Сортувати")}>
                  {t("Працівник")}
                  {sort?.key === "name" && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                </button>
              </th>
              <th className="whitespace-nowrap px-1.5 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Замітки")}</th>
              {shownCols.map((d, ci) => <Th key={d.key}
                label={d.key === "dojazd" && city === "Лодзь" ? t("Dojazd (доплата)") : t(d.label)}
                strong={d.key === "doWyplaty"} left={d.kind === "hr"} divider={ci > 0 && (shownCols[ci - 1].kind === "hr") !== (d.kind === "hr")}
                tint={COL_TINT[d.key] ? TINT[COL_TINT[d.key]].th : undefined}
                onHide={() => onHideCol(d.key)} onSort={() => cycleSort(d.key)} sortDir={sort?.key === d.key ? sort.dir : null} />)}
              {sensCols.map(([k, h], ci) => <Th key={k} label={t(h)} amber divider={ci === 0} onHide={() => onHideCol(k)} onSort={() => cycleSort(k)} sortDir={sort?.key === k ? sort.dir : null} />)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sortedRows.length === 0 && (
              <tr><td colSpan={colCount} className="px-3 py-6 text-center text-sm text-slate-400">{t("У цій фабриці немає людей цього місяця")}</td></tr>
            )}
            {sortedRows.map((r, i) => {
              const sectionChanged = !sort && r.section && r.section !== sortedRows[i - 1]?.section;
              return [
                sectionChanged ? (
                  <tr key={`sec-${r.id}`} className="border-y border-slate-200 bg-slate-100">
                    <td colSpan={colCount} className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-slate-500">{r.section}</td>
                  </tr>
                ) : null,
                <tr key={r.id} className={`group/row transition ${r.mismatch || isUnlegalized(r) ? "bg-rose-50/70 hover:bg-rose-100/60" : `${i % 2 ? "bg-slate-50/70" : ""} hover:bg-red-50/30`}`}>
                  <td className={`sticky left-0 z-10 px-3 py-1 ${r.mismatch || isUnlegalized(r) ? "border-l-2 border-rose-400 bg-rose-50" : `${i % 2 ? "bg-slate-50" : "bg-white"} group-hover/row:bg-red-50/60`}`}
                    title={r.workerName ?? r.rawName}>
                    <span className="flex w-56 items-center gap-1.5">
                      {r.manual && <PencilLine className="h-3 w-3 shrink-0 text-sky-500" aria-label={t("є ручні правки")} />}
                      {r.workerId
                        ? <Link href={`/workers/${r.workerId}`} onClick={saveScroll} className="min-w-0 truncate font-medium text-slate-700 hover:text-red-600 hover:underline">{r.workerName ?? r.rawName}</Link>
                        : <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"><EditableCell row={r} field="rawName" value={r.rawName} month={month} text locked={locked} /></span>}
                      {r.linkStatus === "unmatched" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title={t("Немає в системі")} />}
                      {(r.isStudent || r.legalStatus === "student") && <span className="rounded bg-sky-50 px-1 text-[10px] font-medium text-sky-700" title={t(LEGAL_LABEL.student)}>STUD</span>}
                      {r.under26 && <span className="rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-700">&lt;26</span>}
                      {r.legalStatus && r.legalStatus !== "student" && LEGAL_BADGE[r.legalStatus as LegalStatus] && (
                        <span className={`shrink-0 rounded px-1 text-[10px] font-medium ${LEGAL_BADGE[r.legalStatus as LegalStatus]!.cls}`}
                          title={`${t("Форма легалізації")}: ${t(LEGAL_LABEL[r.legalStatus as LegalStatus])}${r.extras.zusStatus ? ` — ${r.extras.zusStatus}` : ""}`}>
                          {LEGAL_BADGE[r.legalStatus as LegalStatus]!.short}
                        </span>
                      )}
                      {!r.legalStatus && !r.isStudent && (
                        <span className="shrink-0 rounded bg-rose-100 px-1 text-[10px] font-semibold text-rose-700"
                          title={t("Немає форми легалізації — розклад конто/готівки не рахується. Впиши статус у колонку Księgowość або в профіль.")}>
                          ?
                        </span>
                      )}
                      {r.mismatch && (
                        <span className="cursor-help text-[11px] font-medium text-rose-600"
                          title={`${t("Підсвічено, бо цифри не збігаються: наш перерахунок ≠ значенню в Google-таблиці. Перевір вкладку або виправ клітинку тут.")}\n`
                            + Object.entries(r.mismatch).map(([k, v]) => `${k === "doWyplaty" ? t("До виплати") : k}: ${t("наш розрахунок")} ${v.ours} ≠ ${t("у таблиці")} ${v.sheet}`).join("\n")}>
                          ⚠
                        </span>
                      )}
                      {(r.segments?.length ?? 0) > 0 && (
                        <button type="button" onClick={() => toggleSegs(r.id)}
                          className="shrink-0 rounded bg-violet-50 px-1 text-[10px] font-semibold text-violet-700 hover:bg-violet-100"
                          title={t("Місяць порізаний на сегменти (різні умови в різні періоди) — клік розкриє розбивку")}>
                          🧩{r.segments!.length}{openSegs.has(r.id) ? " ▾" : " ▸"}
                        </button>
                      )}
                      {!locked && (
                        <button type="button" title={t("Видалити рядок")}
                          onClick={async () => { if (await confirm({ title: t("Видалити рядок?"), message: `${r.rawName} — ${t("рядок зникне зі сводної цього місяця")}`, confirmText: t("Видалити") })) removeRow.mutate(r.id); }}
                          className="invisible ml-0.5 rounded p-0.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500 group-hover/row:visible">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  </td>
                  <td className="max-w-48 px-1 py-0.5 text-left text-slate-500">
                    <EditableCell row={r} field="note" value={r.note} month={month} text />
                  </td>
                  {shownCols.map((d, ci) => {
                    const divider = ci > 0 && (shownCols[ci - 1].kind === "hr") !== (d.kind === "hr") ? "border-l-2 border-slate-200 " : "";
                    const tint = COL_TINT[d.key] ? `${TINT[COL_TINT[d.key]].td} ` : "";
                    return d.kind === "hr" ? (
                    <td key={d.key} className={`max-w-48 px-1 py-0.5 text-left text-slate-500 ${divider}`}>
                      <EditableCell row={r} field={d.key} value={hrVal(r, d.key)} month={month} text options={hrOptions.get(d.key)}
                        locked={locked || !hrEditableKey(d.key)} />
                    </td>
                  ) : (
                    <td key={d.key} className={`px-1 py-0.5 text-right ${divider}${tint}${d.key === "doWyplaty" ? "border-x-2 border-red-100 bg-red-50/70 font-medium" : ""} text-slate-600`}
                      title={cellLockTitle(r, d.key, t)}>
                      <EditableCell row={r} field={d.key} value={d.kind === "extra" ? r.extras[d.key.slice(7)] : r[d.key as keyof Row & string]} month={month} strong={d.key === "doWyplaty"} formula={cellFormula(r, d.key, t)}
                        locked={locked || cellIsSegLocked(r, d.key) || (d.kind === "extra" && !EXTRA_LABEL[d.key.slice(7)])} />
                    </td>
                  );
                  })}
                  {sensCols.map(([k], ci) => (
                    <td key={k} className={`bg-amber-50/50 px-1 py-0.5 text-right text-slate-700 ${ci === 0 ? "border-l-2 border-amber-300" : ""}`} title={cellLockTitle(r, k, t)}>
                      <EditableCell row={r} field={k} value={r[k]} month={month} formula={cellFormula(r, k, t)}
                        locked={locked || cellIsSegLocked(r, k)} />
                    </td>
                  ))}
                </tr>,
                // сегменти порізаного місяця: повноцінні рядки — кожен зі своїм
                // «до виплати», konto/готівкою (за правилами свого статусу) і
                // частками місячних відрахувань; редагуються години і ставки
                ...(openSegs.has(r.id) && r.segments ? r.segments.map((s, si) => (
                  <tr key={`seg-${s.id}`} className={`${segColor(si).bg} ${segColor(si).bgHover} text-[13px]`}>
                    <td className={`sticky left-0 z-10 border-l-2 ${segColor(si).border} ${segColor(si).bgName} px-3 py-0.5`}>
                      <span className="flex w-56 items-center gap-1.5 pl-2">
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${segColor(si).chip}`}>{segRange(s)}</span>
                        {(s.label ?? s.section) && <span className="min-w-0 truncate text-xs font-medium text-slate-600">{s.label ?? s.section}</span>}
                        {(s.isStudent || s.legalStatus === "student") && <span className="shrink-0 rounded bg-sky-50 px-1 text-[10px] font-medium text-sky-700">STUD</span>}
                        {s.under26 && <span className="shrink-0 rounded bg-emerald-50 px-1 text-[10px] font-medium text-emerald-700">&lt;26</span>}
                        {s.legalStatus && s.legalStatus !== "student" && LEGAL_BADGE[s.legalStatus as LegalStatus] && (
                          <span className={`shrink-0 rounded px-1 text-[10px] font-medium ${LEGAL_BADGE[s.legalStatus as LegalStatus]!.cls}`}
                            title={`${t("Форма легалізації")}: ${t(LEGAL_LABEL[s.legalStatus as LegalStatus])}`}>
                            {LEGAL_BADGE[s.legalStatus as LegalStatus]!.short}
                          </span>
                        )}
                        {!locked && si === 0 && (
                          <button type="button" title={t("Обʼєднати сегменти назад в один рядок")}
                            onClick={async () => {
                              if (await confirm({ title: t("Обʼєднати сегменти?"), message: t("Рядок повернеться до одного набору умов, сумарні години збережуться"), confirmText: t("Обʼєднати") })) unsplit.mutate(r.id);
                            }}
                            className="ml-auto shrink-0 rounded p-0.5 text-violet-300 transition hover:bg-violet-100 hover:text-violet-600">
                            <Combine className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                    </td>
                    <td />
                    {shownCols.map(d => {
                      const editable = ["hours", "rateBrutto", "rateNetto"].includes(d.key);
                      const v = d.kind === "hr" ? hrVal(s, d.key)
                        : d.kind === "extra" ? s.extras[d.key.slice(7)]
                        : s[d.key as keyof Row & string];
                      if (d.kind === "hr") return <td key={d.key} className="max-w-48 px-1 py-0.5 text-left text-slate-400">{String(v ?? "") || "—"}</td>;
                      const manualH = d.key === "hours" && !!(s.extras as any)?.manualHours;
                      return (
                        <td key={d.key} className={`px-1 py-0.5 text-right text-slate-600 ${d.key === "doWyplaty" ? "bg-red-50/40 font-medium" : ""}`}
                          title={manualH ? t("Години вписані вручну — перебудови сегментів їх не перетирають") : undefined}>
                          <span className="flex items-center justify-end gap-0.5">
                            {manualH && <PencilLine className="h-2.5 w-2.5 shrink-0 text-sky-500" />}
                            <span className="min-w-0 flex-1">
                              {editable
                                ? <EditableCell row={s} field={d.key} value={v} month={month} locked={locked} />
                                : <span className="block px-1 py-1 tabular-nums">{fmt(v) || <span className="text-slate-300">—</span>}</span>}
                            </span>
                          </span>
                        </td>
                      );
                    })}
                    {sensCols.map(([k]) => (
                      <td key={k} className="bg-amber-50/40 px-1 py-0.5 text-right text-slate-700">
                        <span className="block px-1 py-1 tabular-nums">{fmt(s[k]) || <span className="text-slate-300">—</span>}</span>
                      </td>
                    ))}
                  </tr>
                )) : []),
              ];
            })}
          </tbody>
          <tfoot className="sticky bottom-0 z-20">
            <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold text-slate-800">
              <td className="sticky left-0 z-30 bg-slate-100 px-3 py-2.5">{t("Разом")}</td>
              <td />
              {shownCols.map(d => d.kind === "hr" || ["rateBrutto", "rateNetto"].includes(d.key) ? <td key={d.key} /> : (
                <td key={d.key} className={`px-1.5 py-2.5 text-right tabular-nums ${d.key === "doWyplaty" ? "border-x-2 border-red-200 bg-red-100/60 text-red-700" : ""}`}>
                  {fmt(sum(r => d.kind === "extra"
                    ? (typeof r.extras[d.key.slice(7)] === "number" ? r.extras[d.key.slice(7)] as number : 0)
                    : r[d.key as keyof Row & string] as number | null))}
                </td>
              ))}
              {sensCols.map(([k], ci) => <td key={k} className={`bg-amber-100/70 px-1.5 py-2.5 text-right tabular-nums ${ci === 0 ? "border-l-2 border-amber-300" : ""}`}>{fmt(sum(r => r[k] as number | null))}</td>)}
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

// Підсумок фабрики: ЗП/карта/податки/готівка/економія/аванси/хостел/штрафи/karta pobytu.
// Чутливі позиції — лише коли API віддав закритий шар. Тултіп = формула з числами.
function SummaryBlock({ rows, sensitive }: { rows: Row[]; sensitive: boolean }) {
  const t = useT();
  const sum = (f: (r: Row) => number | null | undefined) => r2(rows.reduce((a, r) => a + (f(r) ?? 0), 0));
  const ex = (r: Row, k: string) => (typeof r.extras[k] === "number" ? (r.extras[k] as number) : 0);
  const z = (n: number) => `${n.toFixed(2)} zł`;

  const total = sum(r => r.doWyplaty);
  // офіс у сводних ведеться брутто, фабрики — нетто «до виплати» (для тултіпа)
  const officePay = sum(r => isSpecial(r.factoryLabel) ? r.doWyplaty : 0);
  const factoryPay = r2(total - officePay);
  const konto = sum(r => r.konto ?? r.ksiegNetto);
  const ksiegBrutto = sum(r => (r.ksiegBrutto != null && r.ksiegNetto != null && r.ksiegBrutto > r.ksiegNetto) ? r.ksiegBrutto : 0);
  const workerTax = r2(ksiegBrutto - sum(r => (r.ksiegBrutto != null && r.ksiegNetto != null && r.ksiegBrutto > r.ksiegNetto) ? r.ksiegNetto : 0));
  const taxableBrutto = sum(r => (r.ksiegBrutto != null && r.ksiegNetto != null && r.ksiegBrutto > r.ksiegNetto + 0.01) ? r.ksiegBrutto : 0);
  const employerZus = r2(taxableBrutto * 0.2048);
  const gotowka = sum(r => r.gotowka);
  // до видачі — лише додатна готівка: мінусова (борг людини) касу не зменшує
  const gotowkaPay = sum(r => Math.max(0, r.gotowka ?? 0));
  // не розписано: сума «до виплати» рядків без розкладу konto/готівка (офіс +
  // фабрики, де бухгалтерія ще не заповнила блок); doplataEs — легальний надлишок
  const doplataEsSum = sum(r => ex(r, "doplataEs"));
  const nierozp = r2(total - (konto + gotowka - doplataEsSum));
  // хто саме не розписаний — для тултіпа (рядки, де розклад не покриває виплату)
  const nierozpPeople = rows
    .filter(r => r.doWyplaty != null && Math.abs(((r.konto ?? r.ksiegNetto ?? 0) + (r.gotowka ?? 0) - ex(r, "doplataEs")) - r.doWyplaty) > 0.5)
    .map(r => `${r.workerName ?? r.rawName} (${fmt(r2(r.doWyplaty! - ((r.konto ?? r.ksiegNetto ?? 0) + (r.gotowka ?? 0) - ex(r, "doplataEs"))))} zł)`);
  const nierozpList = nierozpPeople.slice(0, 15).join(", ") + (nierozpPeople.length > 15 ? ` … ${t("і ще")} ${nierozpPeople.length - 15}` : "");
  // економія: якби готівкова частина йшла офіційно — брутто-еквівалент + ZUS
  // роботодавця мінус сама готівка; студенти без податків → економії немає
  const savedParts = rows.reduce((acc, r) => {
    const g = r.gotowka ?? 0;
    if (!g || r.isStudent) return acc;
    const ratio = r.rateBrutto && r.rateNetto && r.rateBrutto > r.rateNetto ? r.rateBrutto / r.rateNetto : STD_RATIO;
    if (ratio <= 1) return acc;
    const bruttoEq = g * ratio;
    return { got: acc.got + g, bruttoEq: acc.bruttoEq + bruttoEq };
  }, { got: 0, bruttoEq: 0 });
  const saved = r2((savedParts.bruttoEq - savedParts.got) + savedParts.bruttoEq * 0.2048);
  const zalA = sum(r => r.zaliczka), zalBd = sum(r => r.zaliczkaBd);
  const zaliczki = r2(zalA + zalBd);
  const hostel = sum(r => r.hostel);
  const karaSum = sum(r => r.kara), karaKl = sum(r => ex(r, "karaKlient")), karaEs = sum(r => ex(r, "karaEs"));
  const kary = r2(karaSum + karaKl + karaEs);
  const kartaPobytu = sum(r => ex(r, "kartaPobytu"));
  const stud = rows.filter(r => r.isStudent === true).length;
  const nonStud = rows.filter(r => r.isStudent === false).length;
  const unknown = rows.length - stud - nonStud;

  const Item = ({ label, value, icon: Icon, tone, formula, textValue }: {
    label: string; value?: number; icon: any; tone: string; formula: string; textValue?: string;
  }) => (
    <div className="group relative flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3 transition hover:border-slate-300 hover:shadow-sm">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-[11px] text-slate-400">{label}</div>
        <div className="text-sm font-bold tabular-nums text-slate-800">{textValue ?? z(value!)}</div>
      </div>
      <div className="pointer-events-none absolute bottom-full left-0 z-30 mb-1.5 hidden w-max max-w-md whitespace-pre-line rounded-lg bg-slate-800 px-3 py-2 text-[11px] leading-relaxed text-white shadow-xl group-hover:block">
        {formula}
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <Item label={t("Загальна ЗП")} value={total} icon={Coins} tone="bg-slate-800 text-white"
        formula={officePay > 0
          ? `${t("Σ колонки «До виплати»")}: ${t("фабрики (нетто)")} ${z(factoryPay)} + ${t("офіс (брутто)")} ${z(officePay)} = ${z(total)}`
          : `${t("Σ колонки «До виплати» по рядках фабрики")} = ${z(total)}`} />
      {sensitive && <Item label={t("ЗП на карту")} value={konto} icon={CreditCard} tone="bg-sky-50 text-sky-600"
        formula={`${t("Σ «Księg. netto (конто)» — офіційна частина, що йде на рахунок")} = ${z(konto)}. ${t("Лише рядки, де розклад уже заповнений у сводній.")}`} />}
      {sensitive && <Item label={t("ЗП готівкою")} value={gotowkaPay} icon={Banknote} tone="bg-amber-50 text-amber-600"
        formula={`${t("Σ колонки «Готівка» (лише додатні; мінусова готівка — борг, до видачі не входить)")} = ${z(gotowkaPay)}. ${t("Лише рядки, де розклад уже заповнений у сводній.")}`} />}
      {sensitive && nierozp > 0.5 && <Item label={t("Не розписано (конто/готівка)")} value={nierozp} icon={CircleAlert} tone="bg-slate-100 text-slate-500"
        formula={`${t("Загальна ЗП − (На карту + Готівка − Dopłata ES) — офіс і фабрики, де бухгалтерія ще не розписала офіційну частину")}: ${z(total)} − (${z(konto)} + ${z(gotowka)} − ${z(doplataEsSum)}) = ${z(nierozp)}${nierozpPeople.length ? `\n${t("Люди")}: ${nierozpList}` : ""}`} />}
      {sensitive && <Item label={t("Зекономлено на готівці (оцінка)")} value={saved} icon={PiggyBank} tone="bg-emerald-50 text-emerald-600"
        formula={`${t("Якби готівку платили офіційно: (брутто-еквівалент − готівка) + брутто-еквівалент × 20,48% ZUS. Студенти не рахуються — у них податків немає.")} (${z(savedParts.bruttoEq)} − ${z(savedParts.got)}) + ${z(savedParts.bruttoEq)} × 0,2048 = ${z(saved)}`} />}
      {sensitive && <Item label={t("Податки разом (я плачу)")} value={r2(workerTax + employerZus)} icon={Wallet} tone="bg-rose-600 text-white"
        formula={`${t("Утримання з працівника + ZUS роботодавця — повна податкова вартість офіційної частини")}: (${z(ksiegBrutto)} − ${z(r2(ksiegBrutto - workerTax))}) + ${z(taxableBrutto)} × 0,2048 = ${z(workerTax)} + ${z(employerZus)} = ${z(r2(workerTax + employerZus))}`} />}
      <Item label={t("Аванси (zaliczki)")} value={zaliczki} icon={HandCoins} tone="bg-violet-50 text-violet-600"
        formula={`Σ Zaliczka + Σ Zaliczka BD = ${z(zalA)} + ${z(zalBd)} = ${z(zaliczki)}`} />
      <Item label={t("Хостел")} value={hostel} icon={Home} tone="bg-slate-100 text-slate-600"
        formula={`${t("Σ колонки Hostel")} = ${z(hostel)}`} />
      <Item label={t("Штрафи (разом)")} value={kary} icon={Gavel} tone="bg-orange-50 text-orange-600"
        formula={`Σ Kara + ${t("Кара клієнта")} + ${t("Кара ES")} = ${z(karaSum)} + ${z(karaKl)} + ${z(karaEs)} = ${z(kary)}`} />
      <Item label={t("Karta pobytu")} value={kartaPobytu} icon={IdCard} tone="bg-slate-100 text-slate-600"
        formula={`${t("Σ колонки Karta pobytu")} = ${z(kartaPobytu)}`} />
      <Item label={t("Студенти / не студенти")} icon={GraduationCap} tone="bg-sky-50 text-sky-600"
        textValue={`${stud} / ${nonStud}${unknown ? ` (+${unknown})` : ""}`}
        formula={t("Студент = без податків (netto = brutto). Невідомо — статус у сводній не вказаний.") + (unknown ? ` +${unknown} ${t("невідомо")}` : "")} />
    </div>
  );
}

// Вкладка «Підсумок»: розбивка місяця по містах і фабриках із проміжними
// підсумками міст і загальним рядком. Закриті колонки — лише з sensitive.
function TotalBreakdown({ rows, sensitive }: { rows: Row[]; sensitive: boolean }) {
  const t = useT();
  const ex = (r: Row, k: string) => (typeof r.extras[k] === "number" ? (r.extras[k] as number) : 0);
  // розгорнуті фабрики: клік по рядку → знизу список людей із цифрами
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (k: string) => setExpanded(prev => {
    const n = new Set(prev);
    n.has(k) ? n.delete(k) : n.add(k);
    return n;
  });
  type Agg = { count: number; hours: number; pay: number; konto: number; gotowka: number; gotowkaPay: number; doplata: number; zaliczki: number; hostel: number; kary: number; students: number };
  const zero = (): Agg => ({ count: 0, hours: 0, pay: 0, konto: 0, gotowka: 0, gotowkaPay: 0, doplata: 0, zaliczki: 0, hostel: 0, kary: 0, students: 0 });
  const add = (a: Agg, r: Row) => {
    a.count += 1;
    a.hours += r.hours ?? 0;
    a.pay += r.doWyplaty ?? 0;
    a.konto += r.konto ?? r.ksiegNetto ?? 0;
    a.gotowka += r.gotowka ?? 0;
    a.gotowkaPay += Math.max(0, r.gotowka ?? 0);
    a.doplata += ex(r, "doplataEs");
    a.zaliczki += (r.zaliczka ?? 0) + (r.zaliczkaBd ?? 0);
    a.hostel += r.hostel ?? 0;
    a.kary += (r.kara ?? 0) + ex(r, "karaKlient") + ex(r, "karaEs");
    if (r.isStudent) a.students += 1;
  };
  // не розписано = виплата без розкладу konto/готівка (блок ще не заповнений)
  const nierozpOf = (a: Agg) => r2(a.pay - (a.konto + a.gotowka - a.doplata));
  // місто → фабрика → агрегат (офісні вкладки і додаткові студенти — під «Офіс»)
  const { cities, grand } = useMemo(() => {
    const byCity = new Map<string, Map<string, Agg>>();
    const grand = zero();
    for (const r of rows) {
      const c = isSpecial(r.factoryLabel) ? OFFICE_CITY : r.city;
      const m = byCity.get(c) ?? byCity.set(c, new Map()).get(c)!;
      const a = m.get(r.factoryLabel) ?? m.set(r.factoryLabel, zero()).get(r.factoryLabel)!;
      add(a, r);
      add(grand, r);
    }
    const cities = [...byCity.entries()]
      .sort((a, b) => (a[0] === OFFICE_CITY ? 1 : 0) - (b[0] === OFFICE_CITY ? 1 : 0) || a[0].localeCompare(b[0]))
      .map(([c, m]) => {
        const total = zero();
        const factories = [...m.entries()].sort((a, b) => b[1].pay - a[1].pay || a[0].localeCompare(b[0]));
        for (const [, a] of factories) {
          total.count += a.count; total.hours += a.hours; total.pay += a.pay; total.konto += a.konto;
          total.gotowka += a.gotowka; total.gotowkaPay += a.gotowkaPay; total.doplata += a.doplata; total.zaliczki += a.zaliczki;
          total.hostel += a.hostel; total.kary += a.kary; total.students += a.students;
        }
        return { city: c, factories, total };
      });
    return { cities, grand };
  }, [rows]);

  // не розписані люди групи — для тултіпа на сумі «Не розп.»
  const rowNierozp = (r: Row) => r.doWyplaty != null
    && Math.abs(((r.konto ?? r.ksiegNetto ?? 0) + (r.gotowka ?? 0) - ex(r, "doplataEs")) - r.doWyplaty) > 0.5;
  const nierozpNames = (list: Row[]) => {
    const ppl = list.filter(rowNierozp).map(r => r.workerName ?? r.rawName);
    if (!ppl.length) return undefined;
    return `${t("Не розписані")}: ${ppl.slice(0, 20).join(", ")}${ppl.length > 20 ? ` … ${t("і ще")} ${ppl.length - 20}` : ""}`;
  };
  const num = (v: number) => <td className="bg-orange-50/40 px-2 py-1.5 text-right tabular-nums">{fmt(r2(v))}</td>;
  const cells = (a: Agg, payCls = "", nierozpTitle?: string) => (
    <>
      <td className="px-2 py-1.5 text-right tabular-nums">{a.count}</td>
      <td className="bg-sky-50/40 px-2 py-1.5 text-right tabular-nums">{fmt(r2(a.hours))}</td>
      <td className={`border-x-2 border-red-100 bg-red-50/60 px-2 py-1.5 text-right font-semibold tabular-nums ${payCls}`}>{fmt(r2(a.pay))}</td>
      {sensitive && <td className="bg-amber-50/50 px-2 py-1.5 text-right tabular-nums">{fmt(r2(a.konto))}</td>}
      {sensitive && <td className="bg-amber-50/50 px-2 py-1.5 text-right tabular-nums">{fmt(r2(a.gotowkaPay))}</td>}
      {sensitive && (
        <td className={`bg-amber-50/50 px-2 py-1.5 text-right tabular-nums ${nierozpTitle ? "cursor-help text-amber-600 underline decoration-dotted underline-offset-2" : "text-slate-400"}`}
          title={nierozpTitle}>
          {nierozpOf(a) > 0.5 ? fmt(nierozpOf(a)) : ""}
        </td>
      )}
      {num(a.zaliczki)}
      {num(a.hostel)}
      {num(a.kary)}
      <td className="px-2 py-1.5 text-right tabular-nums text-sky-700">{a.students}</td>
    </>
  );

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-4 py-3 text-sm font-bold tracking-tight text-slate-800">
        {t("Розбивка по містах і фабриках")}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="border-b-2 border-slate-200 bg-slate-100/80">
            <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2.5 text-left">{t("Фабрика")}</th>
              <th className="px-2 py-2.5 text-right">{t("Людей")}</th>
              <th className="bg-sky-100/70 px-2 py-2.5 text-right text-sky-800">{t("Години")}</th>
              <th className="border-x-2 border-red-200 bg-red-100/70 px-2 py-2.5 text-right text-red-700">{t("До виплати")}</th>
              {sensitive && <th className="bg-amber-100/80 px-2 py-2.5 text-right text-amber-700">{t("На карту")}</th>}
              {sensitive && <th className="bg-amber-100/80 px-2 py-2.5 text-right text-amber-700">{t("Готівка")}</th>}
              {sensitive && <th className="bg-amber-100/80 px-2 py-2.5 text-right text-amber-700" title={t("Виплата, для якої бухгалтерія ще не розписала конто/готівку")}>{t("Не розп.")}</th>}
              <th className="bg-orange-100/60 px-2 py-2.5 text-right text-orange-800">{t("Аванси")}</th>
              <th className="bg-orange-100/60 px-2 py-2.5 text-right text-orange-800">{t("Хостел")}</th>
              <th className="bg-orange-100/60 px-2 py-2.5 text-right text-orange-800">{t("Штрафи")}</th>
              <th className="px-2 py-2.5 text-right">{t("Студ.")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {cities.map(({ city, factories, total }) => [
              <tr key={`c-${city}`} className="border-y border-slate-200 bg-slate-100">
                <td className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
                  {city === OFFICE_CITY ? "🏢 " : ""}{t(city)}
                </td>
                {cells(total, "", nierozpNames(rows.filter(r => (isSpecial(r.factoryLabel) ? OFFICE_CITY : r.city) === city)))}
              </tr>,
              ...factories.flatMap(([f, a]) => {
                const k = `${city}|${f}`;
                const people = rows
                  .filter(r => r.factoryLabel === f && (isSpecial(r.factoryLabel) ? OFFICE_CITY : r.city) === city)
                  .sort((x, y) => (x.workerName ?? x.rawName).localeCompare(y.workerName ?? y.rawName, "pl"));
                const open = expanded.has(k);
                const out = [
                  <tr key={k} onClick={() => { if (window.getSelection()?.toString()) return; toggleExpand(k); }}
                    className={`cursor-pointer ${open ? "bg-red-50/50" : "hover:bg-red-50/30"}`}
                    title={t("Клікни, щоб розгорнути список людей")}>
                    <td className="whitespace-nowrap px-3 py-1.5 pl-6 text-slate-600">
                      <span className="mr-1 inline-block w-3 text-slate-400">{open ? "▾" : "▸"}</span>
                      {f === EXTRA_STUDENTS ? "🎓 " : ""}{f === EXTRA_STUDENTS ? t(f) : f}
                    </td>
                    {cells(a, "", nierozpNames(people))}
                  </tr>,
                ];
                if (open) out.push(
                  <tr key={`${k}-detail`}>
                    <td colSpan={sensitive ? 11 : 8} className="bg-slate-50/60 px-3 pb-2 pt-1">
                      <table className="w-full text-[13px]">
                        <tbody className="divide-y divide-slate-100">
                          {people.map(r => (
                            <tr key={r.id} className={rowNierozp(r) ? "text-amber-700" : "text-slate-600"}>
                              <td className="py-1 pl-9">
                                {r.workerId
                                  ? <Link href={`/workers/${r.workerId}`} className="hover:text-red-600 hover:underline">{r.workerName ?? r.rawName}</Link>
                                  : (r.workerName ?? r.rawName)}
                                {rowNierozp(r) && <span className="ml-1" title={t("не розписано конто/готівку")}>⚠</span>}
                              </td>
                              <td className="w-16 py-1 text-right tabular-nums" />
                              <td className="w-20 py-1 text-right tabular-nums">{fmt(r2(r.hours ?? 0))}</td>
                              <td className="w-24 py-1 text-right font-semibold tabular-nums">{fmt(r2(r.doWyplaty ?? 0))}</td>
                              {sensitive && <td className="w-24 py-1 text-right tabular-nums">{fmt(r2(r.konto ?? r.ksiegNetto ?? 0))}</td>}
                              {sensitive && <td className="w-24 py-1 text-right tabular-nums">{fmt(r2(r.gotowka ?? 0))}</td>}
                              {sensitive && <td className="w-20 py-1 text-right tabular-nums text-amber-600">
                                {rowNierozp(r) ? fmt(r2((r.doWyplaty ?? 0) - ((r.konto ?? r.ksiegNetto ?? 0) + (r.gotowka ?? 0) - ex(r, "doplataEs")))) : ""}
                              </td>}
                              <td className="w-20 py-1 text-right tabular-nums">{fmt(r2((r.zaliczka ?? 0) + (r.zaliczkaBd ?? 0)))}</td>
                              <td className="w-20 py-1 text-right tabular-nums">{fmt(r2(r.hostel ?? 0))}</td>
                              <td className="w-20 py-1 text-right tabular-nums">{fmt(r2((r.kara ?? 0) + ex(r, "karaKlient") + ex(r, "karaEs")))}</td>
                              <td className="w-14 py-1 text-right">{r.isStudent ? "🎓" : ""}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>,
                );
                return out;
              }),
            ])}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold text-slate-800">
              <td className="px-3 py-2.5">{t("Разом")}</td>
              {cells(grand, "text-red-700", nierozpNames(rows))}
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

// Додавання людини у сводну фабрики: пошук по базі (рядок префілиться з
// профілю) або створення нового працівника — профіль зʼявляється автоматично.
function AddPersonModal({ month, city, factoryLabel, onClose }: {
  month: string; city: string; factoryLabel: string; onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const { data: workers } = useQuery<{ id: number; fullName: string; factoryName?: string | null; isActive?: boolean }[]>({
    queryKey: ["workers"], queryFn: () => get("/workers"),
  });
  const addRow = useMutation({
    mutationFn: (p: { workerId?: number; newWorkerName?: string; force?: boolean }) =>
      post<Row>("/svodni/rows", { periodMonth: month, city, factoryLabel, ...p }),
    onSuccess: (created) => {
      qc.setQueryData<Data>(["svodni", month], old => old ? { ...old, rows: [...old.rows, created] } : old);
      qc.invalidateQueries({ queryKey: ["workers"] });
      toast.success(t("Додано"));
      onClose();
    },
    onError: (e: any, vars) => {
      // 409 — схожа людина вже є: підтвердження перед свідомим створенням дубля
      if (e.status === 409 && window.confirm(`${e.message}\n\n${t("Створити нового працівника все одно?")}`)) addRow.mutate({ ...vars, force: true });
      else if (e.status !== 409) toast.error(e.message);
    },
  });
  const needle = q.trim().toLowerCase();
  const found = (workers ?? [])
    .filter(w => needle && w.fullName.toLowerCase().includes(needle))
    .slice(0, 12);
  const exact = (workers ?? []).some(w => w.fullName.toLowerCase() === needle);

  return (
    <Modal open onClose={onClose} title={`${t("Додати людину")} — ${factoryLabel} · ${month}`}>
      <div className="space-y-3">
        <Input autoFocus placeholder={t("Імʼя працівника (пошук по базі або нове)")} value={q} onChange={e => setQ(e.target.value)} />
        {needle.length >= 2 && (
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {found.map(w => (
              <button key={w.id} onClick={() => addRow.mutate({ workerId: w.id })} disabled={addRow.isPending}
                className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-sm transition hover:border-red-300 hover:bg-red-50/40">
                <span className="font-medium text-slate-700">{w.fullName}</span>
                <span className="text-xs text-slate-400">{w.factoryName ?? ""}{w.isActive === false ? ` · ${t("звільнений")}` : ""}</span>
              </button>
            ))}
            {!exact && (
              <button onClick={() => addRow.mutate({ newWorkerName: q.trim() })} disabled={addRow.isPending}
                className="flex w-full items-center gap-2 rounded-lg border border-dashed border-emerald-300 bg-emerald-50/50 px-3 py-2 text-left text-sm font-medium text-emerald-700 transition hover:bg-emerald-50">
                <UserPlus className="h-4 w-4" /> {t("Створити нового працівника")} «{q.trim()}»
              </button>
            )}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-slate-400">
          {t("Рядок префілиться з профілю (ставки, студент, до-26, дата народження). Новому працівнику профіль створюється автоматично — далі його можна заповнювати прямо з таблиці: правки ставок/статусів синхронізуються з профілем і підтягнуться в наступні місяці.")}
        </p>
      </div>
    </Modal>
  );
}

// Панель незматчених: привʼязка людини зі сводної до працівника системи
function UnmatchedPanel() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery<{ people: Unmatched[] }>({ queryKey: ["svodni-unmatched"], queryFn: () => get("/svodni/unmatched") });
  const people = data?.people ?? [];
  const link = useMutation({
    mutationFn: (p: { rawName: string; city: string; workerId?: number; status: string }) => post("/svodni/link", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["svodni"] }); qc.invalidateQueries({ queryKey: ["svodni-unmatched"] }); toast.success(t("Збережено")); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-amber-50 to-white px-4 py-3">
        <Users className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-bold text-slate-800">{t("Не привʼязані до працівників")}</span>
        <Badge color="amber">{people.length}</Badge>
      </div>
      {!people.length ? <div className="p-4 text-sm text-slate-400">{t("Всі рядки привʼязані")} 🎉</div> : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {people.map(p => (
                <tr key={`${p.city}-${p.rawName}`} className="even:bg-slate-50/60 hover:bg-red-50/30">
                  <td className="px-4 py-2 font-semibold text-slate-700">{p.rawName}</td>
                  <td className="px-2 py-2 text-slate-500">{t(p.city)} · {p.factories.join(", ")}</td>
                  <td className="px-2 py-2">
                    <span className="flex flex-wrap gap-1">
                      {p.months.map(m => <span key={m} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{m.slice(5)}.{m.slice(2, 4)}</span>)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      {p.candidates.length === 0 && <span className="text-[11px] text-slate-300">{t("кандидатів немає")}</span>}
                      {p.candidates.map(c => (
                        <button key={c.id} onClick={() => link.mutate({ rawName: p.rawName, city: p.city, workerId: c.id, status: "confirmed" })}
                          className="rounded-lg bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200 transition hover:bg-emerald-100"
                          title={t("Привʼязати до")}>
                          <Link2 className="mr-0.5 inline h-3 w-3" />{c.name}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// Модалка Excel-експорту: обсяг (все/місто/фабрика) + вибір стовпчиків.
// Вибір колонок запам'ятовується в браузері. Каталог — дзеркало бекенду
// (GET /svodni/excel), сенситивні пункти показуються лише з закритим доступом.
const XLS_COL_DEFS: { key: string; label: string; sensitive?: boolean }[] = [
  { key: "section", label: "Stanowisko" },
  { key: "hoursNotified", label: "Год. повід." },
  { key: "hours", label: "Години" },
  { key: "rateBrutto", label: "Ставка бр." },
  { key: "rateNetto", label: "Ставка нет." },
  { key: "premia", label: "Премія" },
  { key: "zaliczka", label: "Zaliczka" },
  { key: "zaliczkaBd", label: "Zaliczka BD" },
  { key: "hostel", label: "Hostel" },
  { key: "odziez", label: "Odzież" },
  { key: "dojazd", label: "Dojazd" },
  { key: "kara", label: "Kara" },
  { key: "komornik", label: "Komornik" },
  { key: "kaucja", label: "Kaucja" },
  { key: "potracenia", label: "Potrącenia" },
  { key: "brutto", label: "Brutto" },
  { key: "doWyplaty", label: "До виплати" },
  { key: "legalStatus", label: "Księgowość (статус)" },
  { key: "hoursDeclared", label: "Год. księg.", sensitive: true },
  { key: "ksiegBrutto", label: "Księg. brutto", sensitive: true },
  { key: "ksiegNetto", label: "Księg. netto", sensitive: true },
  { key: "konto", label: "Konto", sensitive: true },
  { key: "gotowka", label: "Готівка", sensitive: true },
  { key: "kontoNr", label: "Nr konta", sensitive: true },
];

function ExcelModal({ month, city, factory, sensitive, onClose }: {
  month: string; city: string | null; factory: string | null; sensitive: boolean; onClose: () => void;
}) {
  const t = useT();
  const defs = XLS_COL_DEFS.filter(d => sensitive || !d.sensitive);
  const [scope, setScope] = useState<"all" | "city" | "factory">(factory ? "factory" : city ? "city" : "all");
  const [cols, setCols] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("svodni.xlsCols") ?? "null");
      if (Array.isArray(saved) && saved.length) return new Set(saved.filter(k => defs.some(d => d.key === k)));
    } catch { /* ignore */ }
    return new Set(defs.map(d => d.key));
  });
  const toggle = (k: string) => setCols(prev => {
    const n = new Set(prev);
    n.has(k) ? n.delete(k) : n.add(k);
    try { localStorage.setItem("svodni.xlsCols", JSON.stringify([...n])); } catch { /* ignore */ }
    return n;
  });
  const params = new URLSearchParams({ month, cols: [...cols].join(",") });
  if (scope !== "all" && city) params.set("city", city);
  if (scope === "factory" && factory) params.set("factory", factory);
  return (
    <Modal open onClose={onClose} title={t("Скачати Excel сводної")}>
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("Що скачати")}</div>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setScope("all")} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${scope === "all" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>{t("Вся сводна")} · {month}</button>
            {city && <button onClick={() => setScope("city")} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${scope === "city" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>{t(city)}</button>}
            {factory && <button onClick={() => setScope("factory")} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${scope === "factory" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>{factory}</button>}
          </div>
        </div>
        <div>
          <div className="mb-1.5 flex items-center gap-3 text-xs">
            <span className="font-semibold uppercase tracking-wide text-slate-400">{t("Стовпчики")}</span>
            <button className="text-red-600 hover:underline" onClick={() => setCols(new Set(defs.map(d => d.key)))}>{t("всі")}</button>
            <button className="text-red-600 hover:underline" onClick={() => setCols(new Set())}>{t("жодного")}</button>
          </div>
          <div className="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto">
            {defs.map(d => {
              const on = cols.has(d.key);
              return (
                <button key={d.key} onClick={() => toggle(d.key)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${on
                    ? d.sensitive ? "bg-amber-50 text-amber-700 ring-1 ring-amber-300" : "bg-red-50 text-red-700 ring-1 ring-red-200"
                    : "bg-slate-50 text-slate-400 ring-1 ring-slate-200 line-through"}`}>
                  {t(d.label)}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">{t("Ім'я і фабрика включаються завжди; документ формується польською.")}</p>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("Скасувати")}</Button>
          {/* порожній список сервер трактує як «усі» — без вибору не качаємо */}
          {cols.size > 0 ? (
            <a href={`/api/svodni/excel?${params.toString()}`} onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700">
              <Download className="h-4 w-4" /> {t("Скачати")}
            </a>
          ) : (
            <span className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-400"
              title={t("Вибери хоча б один стовпчик")}>
              <Download className="h-4 w-4" /> {t("Скачати")}
            </span>
          )}
        </div>
      </div>
    </Modal>
  );
}
