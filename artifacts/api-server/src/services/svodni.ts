// Сводні — повне дзеркало зарплатних таблиць трьох міст (Люблін / Познань /
// Лодзь): кожен рядок людини з УСІМА колонками вкладки + перерахунок формул
// таблиці кодом і звірка з числами у клітинках (mismatch). Чисте ядро без
// БД/Drive — покривається юніт-тестами на фікстурах реальних вкладок.
//
//शари даних: відкритий (фактичні години, ставки, відрахування, до виплати)
// і закритий — księgowość/готівка (hoursDeclared/ksieg*/gotowka/konto) — API
// віддає закритий шар лише з capability svodniSensitive.
import { num, cell, dateCell, norm, key, isServiceRow, cleanName, nameTokens } from "./payrollSummaries";

export interface SvodniParsedRow {
  section: string | null;
  rawName: string;
  // відкритий шар
  hoursNotified: number | null;
  hours: number | null;
  shifts: number | null;
  rateBrutto: number | null;
  rateNetto: number | null;
  premia: number | null;
  zaliczka: number | null;
  zaliczkaBd: number | null;
  hostel: number | null;
  odziez: number | null;
  dojazd: number | null;
  kara: number | null;
  komornik: number | null;
  kaucja: number | null;
  potracenia: number | null;
  doWyplaty: number | null;
  brutto: number | null;
  // закритий шар
  hoursDeclared: number | null;
  ksiegBrutto: number | null;
  ksiegNetto: number | null;
  gotowka: number | null;
  konto: number | null;
  isStudent: boolean | null;
  under26: boolean | null;
  extras: Record<string, number | string>;
  hr: Record<string, string>;
  sheetValues: Record<string, number>; // клітинки з обчислюваних колонок — для звірки
  mismatch: Record<string, { ours: number; sheet: number }> | null;
  /** індекс рядка у сітці вкладки — щоб підтягнути фон рядка (кольори позначок) */
  sheetRow?: number;
}

export interface SvodniParsedTab {
  factoryLabel: string;
  firmGuess: string | null;
  rows: SvodniParsedRow[];
  /** значення рядка SUMA вкладки за канонічними ключами (для tab_checks) */
  sheetSuma: Record<string, number>;
  counts: { workers?: number; students?: number; over26?: number };
  /** колонка імені у сітці (для кольорів рядків) */
  nameCol?: number;
  /** ключі колонок у порядку таблиці: core-ключ | extras.<k> | hr.<k> */
  colOrder?: string[];
  /** інформаційні блоки вкладки, напр. STAWKA EUROCASH (сирі рядки) */
  info?: { stawkaEurocash?: (string | number)[][] };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ── канонічні колонки (Люблін/Познань): заголовок → ключ ─────────────────────
// core = пишемо у власну колонку svodni_rows; решта — в extras.
type ColKind =
  | { key: keyof SvodniParsedRow & string; core: true }
  | { key: string; core: false };
const LUBLIN_COLS: { re: RegExp; col: ColKind; premia?: boolean }[] = [
  { re: /GODZ W POWIADOMIENIU/, col: { key: "hoursNotified", core: true } },
  { re: /^ILOSC GODZIN$|^GODZINY$|^GODZIN$/, col: { key: "hours", core: true } },
  { re: /^ILOSC ZMIAN$/, col: { key: "shifts", core: true } },
  { re: /^STAWKA BRUTTO$/, col: { key: "rateBrutto", core: true } },
  { re: /^STAWKA NETTO$/, col: { key: "rateNetto", core: true } },
  { re: /^ZALICZKA$|^ZALICZKI$/, col: { key: "zaliczka", core: true } },
  { re: /^ZALICZKA BD/, col: { key: "zaliczkaBd", core: true } },
  { re: /^HOSTEL$/, col: { key: "hostel", core: true } },
  { re: /^ODZIEZ/, col: { key: "odziez", core: true } }, // «Odzież», «Odzież+ kurs»
  { re: /^DOJAZD$|^DOPLATA ZA DOJAZD$/, col: { key: "dojazd", core: true } },
  { re: /^KARA(?! Z SUSHI| ES)/, col: { key: "kara", core: true } }, // «Kara za nieobecność»
  { re: /^KOMORNIK|KOMORNIK\/ZADLUZENIE/, col: { key: "komornik", core: true } },
  { re: /^KAUCJA/, col: { key: "kaucja", core: true } }, // Chip / Klucze
  { re: /POMYLKOWOSC|^POTRACENIA$|^SUMA POTRACEN/, col: { key: "potracenia", core: true } },
  { re: /^DO WYPLATY( NETTO)?$/, col: { key: "doWyplaty", core: true } },
  // премії: сумуються в premia, кожна окремо — в extras
  { re: /^PREMIA AGRAM/, col: { key: "premiaAgram", core: false }, premia: true },
  { re: /^PREMIA ES$/, col: { key: "premiaEs", core: false }, premia: true },
  { re: /^PREMIA$|^KIEROWCA\/PREMIA$/, col: { key: "premiaBase", core: false }, premia: true },
  // фабричні нюанси → extras
  { re: /^SUMA NOCNE/, col: { key: "nocneH", core: false } },
  { re: /^DOPLATA ZA NOCNE/, col: { key: "doplataNocna", core: false } },
  { re: /^OPLATA DLA KIEROWCY/, col: { key: "oplataKierowcy", core: false } },
  { re: /^DOPLATA ES$/, col: { key: "doplataEs", core: false } },
  { re: /^BADANIA/, col: { key: "badania", core: false } },
  { re: /^NAKLADKI/, col: { key: "nakladki", core: false } },
  { re: /^ZWROT KOSZTOW/, col: { key: "zwrotKosztow", core: false } },
  { re: /^KARTA POBYTU/, col: { key: "kartaPobytu", core: false } },
  { re: /^KARA Z SUSHI/, col: { key: "karaKlient", core: false } },
  { re: /^KARA ES$/, col: { key: "karaEs", core: false } },
  { re: /ЗАБОРГОВАН|ZADLUZENIE Z ZESZL/, col: { key: "zadluzenie", core: false } },
];
// кадрові колонки (текст/дата) → hr
const HR_COLS: { re: RegExp; key: string }[] = [
  { re: /^ZASWIADCZENIE DO KIEDY/, key: "zaswiadczenieDo" },
  { re: /ZASWIADCZENIE\s+KIEDY WYSTAWIONE/, key: "zaswiadczenieWystawione" },
  { re: /^KONIEC STUDIOW/, key: "koniecStudiow" },
  { re: /^WNIOSEK ZALICZKI/, key: "wniosekZaliczki" },
  { re: /^DATA (ROZPOCZECIA PRACY|POCZATKU PRACY)/, key: "dataStart" },
  { re: /^DATA OD KTOREJ LICZYMY/, key: "dataLiczymy" },
  { re: /^DATA WYPOWIEDZENIA/, key: "dataWypowiedzenia" },
  { re: /^DATA URODZEN/, key: "dataUrodzenia" },
  { re: /^DNI KTORE ODPRACOWANE/, key: "dniOdpracowane" },
  { re: /^STANOWISKO$/, key: "stanowisko" },
  { re: /^LINIA$/, key: "linia" },
  { re: /^SZKOLENIE$/, key: "szkolenie" },
  { re: /^ODDZIAL$/, key: "oddzial" },
  { re: /^NR OSOBOWY$/, key: "nrOsobowy" },
  { re: /^FIRMA$/, key: "firma" },
  { re: /^STATUS$/, key: "status" },
  { re: /^UWAGI$/, key: "uwagi" },
  { re: /^DOKUMENTY$/, key: "dokumenty" },
];

// секційні рядки всередині вкладки (не людина, не сервіс)
const SECTION_RE = /^(KOBIETY|MEZCZYZNI|NIE OPODATKOWANE|OPODATKOWANE|STUDENCI|NIE STUDENCI)$/;

// ── форма легалізації: канонічні статуси з тексту колонки Księgowość ─────────
// Каталог продубльований у web/src/lib/legalStatus.ts — тримати синхронними.
// Вік («до 26 / після») — ОКРЕМА властивість (under26/birthDate), не форма легалізації.
export const LEGAL_STATUSES = ["student", "dyplom", "powiadomienie", "zus", "oczekuje", "karta_pobytu", "staly_pobyt", "polak"] as const;
export type LegalStatus = (typeof LEGAL_STATUSES)[number];

// Профілі тепер зберігають канонічні форми сводної 2.0 — мапимо їх на статуси 1.0,
// щоб правила konto/готівки першої сводної читали їх правильно.
export function normalizeProfileLegal(status: string | null | undefined): LegalStatus | null {
  const s = String(status ?? "").trim();
  if (!s) return null;
  if ((LEGAL_STATUSES as readonly string[]).includes(s)) return s as LegalStatus;
  switch (s) {
    case "student_do26":
    case "student_po26":
    case "do26": return "student";
    case "oswiadczenie": return "powiadomienie";
    case "zezwolenie": return "zus";
    case "nieoformiony": return "oczekuje"; // не оформлений — усе готівкою
    default: return null;
  }
}
export function legalStatusOf(zusText: string | null | undefined): LegalStatus | null {
  const s = norm(String(zusText ?? ""));
  if (!s) return null;
  if (/DYPLOM/.test(s)) return "dyplom";
  if (/NIE ?ZGLOSZON|CZEKAMY/.test(s)) return "oczekuje";
  if (/KART[YA] POBYTU|DECYZJA/.test(s)) return "karta_pobytu";
  if (/STALY POBYT/.test(s)) return "staly_pobyt";
  if (/POLAK|POLKA/.test(s)) return "polak";
  if (/STUDENT/.test(s)) return "student";
  if (/^STUD(?!ENCI)/.test(s)) return "student"; // маркери STUD / STUD>26 з колонки повідомлень
  if (/POWIADOMIENIE/.test(s)) return "powiadomienie"; // зголошений повідомленням
  if (/ZEZWOLEN/.test(s)) return "zus"; // zezwolenie na pracę — оформлений
  if (/ZGLOSZON/.test(s)) return "zus"; // зголошений без уточнення («Zgłoszony, Do 26» — вік окремо)
  return null;
}

// Правила розкладу konto/готівка за статусом (як веде бухгалтерія):
// 1) студент до 26 — податків немає, все «до виплати» іде на конто;
// 2) є години в oświadczeniu/powiadomieniu — офіційно йдуть години oświadczenia
//    (але не більше реально відпрацьованих), решта готівкою;
// 3) легально оформлений БЕЗ вписаних год. oświadczenia — все на карту;
// 4) не оформлений (не зголошений / без форми легалізації) — все готівкою.
// Статус — з тексту Księgowość рядка або з профілю працівника (profileLegal).
// force: перерахунок після ручної правки на сайті (переписує наявний розклад);
// без force (google-імпорт) — заповнений бухгалтерією блок сильніший, а рядки
// без статусу лишаються нерозписаними (відсутність тексту ≠ «не оформлений»).
// ── Фабричне правило konto/готівки ───────────────────────────────────────────
// Версійні правила живуть у БД (factory_payout_rules, «діє з» — місяць цілком);
// резолюція на місяць — services/factoryRules.ts. Фабрика без записів працює за
// legacyPayoutRule нижче (колишній хардкод). Двигун (applyLegalDefaults,
// computeSegmented, factoryBonusPerHour) приймає готовий обʼєкт правила.
export interface PayoutRule {
  capH: number | null;          // стеля konto-годин (null = без стелі)
  capHighH: number | null;      // підвищена стеля (від capThresholdH відпрацьованих)
  capThresholdH: number | null; // поріг відпрацьованих годин для підвищеної стелі
  capFirm: string | null;       // стеля лише для цієї фірми (ES на Sushi); null = усі
  cashBonus: number;            // готівковий бонус до ставки, зл/год (гейт — галочка профілю)
  stazBonus: boolean;           // стажевий бонус увімкнено (галочка профілю + дата працевлаштування)
  stazMinHours: number | null;  // мін. годин/міс для стажевого (null = без порога)
  stazSteps: { days: number; add: number }[]; // сходинки за днями стажу на кінець місяця
  premiaCash: boolean;          // колонка Premia — завжди готівкою (крім студентів до 26)
}

// Legacy-правила (діяли хардкодом до 08.2026, лишаються фолбеком для фабрик без
// записів у factory_payout_rules — сідити БД небезпечно через розʼїзд id
// локальна/прод). Стелі księgowych годин (діють на всіх, КРІМ студентів до 26):
// DEZYNFEKCJA/SERWIS PLUS і LST — максимум 70 год, якщо реально відпрацьовано
// 200+, інакше максимум 60; Sushi&Food, фірма ES — максимум 80 год (рішення
// власника 08.2026), ESO/Klinex того ж клієнта стелі не мають. Бонуси —
// Agram/LST нижче (AGRAM_FACTORY_IDS/LST_FACTORY_ID).
export function legacyPayoutRule(factoryId: number | null | undefined, factoryLabel?: string | null): PayoutRule {
  const label = norm(String(factoryLabel ?? ""));
  const rule: PayoutRule = {
    capH: null, capHighH: null, capThresholdH: null, capFirm: null,
    cashBonus: 0, stazBonus: false, stazMinHours: null, stazSteps: [], premiaCash: false,
  };
  if (/DEZYNFEKCJA|SERWIS\s*PLUS|^LST\b/i.test(label)) { rule.capH = 60; rule.capHighH = 70; rule.capThresholdH = 200; }
  else if (/SUSHI/i.test(label)) { rule.capH = 80; rule.capFirm = "ES"; }
  if (factoryId != null && AGRAM_FACTORY_IDS.has(factoryId)) {
    rule.cashBonus = AGRAM_CASH_PER_HOUR;
    rule.stazBonus = true;
    rule.stazMinHours = AGRAM_BONUS_MIN_HOURS;
    rule.stazSteps = [{ days: 30, add: 1 }, { days: 60, add: 1.5 }];
    rule.premiaCash = true;
  } else if (factoryId === LST_FACTORY_ID) {
    rule.cashBonus = AGRAM_CASH_PER_HOUR;
  }
  return rule;
}

/** Стеля konto-годин правила для рядка (hours = відпрацьовані за місяць). */
export function declaredCapOf(rule: PayoutRule | null | undefined, hours: number | null, firm?: string | null): number | null {
  if (!rule || hours == null || rule.capH == null) return null;
  if (rule.capFirm && firm !== rule.capFirm) return null;
  if (rule.capThresholdH != null && rule.capHighH != null && hours >= rule.capThresholdH) return rule.capHighH;
  return rule.capH;
}

/** Чи фабрика «бонусна» (показ галочок у профілі, віднімання бонусу зі ставки). */
export function hasCashBonus(rule: PayoutRule | null | undefined): boolean {
  return rule != null && (rule.cashBonus > 0 || rule.stazBonus);
}

/** Legacy-обгортка: стеля по назві фабрики (без БД). Нові виклики — declaredCapOf. */
export function factoryDeclaredCap(factoryLabel: string | null | undefined, hours: number | null, firm?: string | null): number | null {
  if (!factoryLabel) return null;
  return declaredCapOf(legacyPayoutRule(null, factoryLabel), hours, firm);
}

// Стандартна księgowa пара ставок (umowa zlecenie): конто декларується по НИЖЧІЙ
// зі ставок — фабричній чи стандартній (LST платить 26,35, а декларує по 25,35;
// Sushi платить 24,60 — декларує по своїй). Решта до повного нетто — готівкою.
// Мінімальна ставка року редагується в налаштуваннях сводних (веб) і
// зберігається в settings (ключ ksieg_min_rates); тут — дефолт на 2026.
let ksiegStdNetto = 25.35;
let ksiegStdBrutto = 31.4;
export const KSIEG_STD_NETTO = () => ksiegStdNetto;
export const KSIEG_STD_BRUTTO = () => ksiegStdBrutto;
export function setKsiegStd(netto: number, brutto: number): void {
  if (Number.isFinite(netto) && netto > 0) ksiegStdNetto = netto;
  if (Number.isFinite(brutto) && brutto > 0) ksiegStdBrutto = brutto;
}

// ── Бонуси Agram: додаються до ставки нетто. Вшитий у ставку бонус — ЗАВЖДИ
// готівкою: рядок несе його в extras.facBonus (зл/год), applyLegalDefaults
// віднімає його від księgowої ставки і від стелі конто (правило 20.08.2026 —
// раніше бонус різався лише стандартною парою 25,35 і протікав у конто, коли
// база нижча за стандартну або при побажанні «все на конто»). Студенту до 26
// бонуси не нараховуються — його виплата вся на конто.
// Прапорці — у профілі працівника; детекція фабрик — по id (побажання власника).
export const AGRAM_FACTORY_IDS = new Set([12, 13]); // 12=AGRAM MOTYCZ, 13=AGRAM LUBLIN
export const AGRAM_CASH_PER_HOUR = 1; // готівковий бонус (частина ЗП налом): +1 зл/год
// Колонка Premia на Agram — теж завжди готівкою (на конто лише студентам до 26):
// стеля конто зменшується на премію в усіх гілках розкладу, вкл. «все на конто»
export const PREMIA_CASH_FACTORY_IDS = AGRAM_FACTORY_IDS;

/** Повних місяців між датами (YYYY-MM-DD, рядкова арифметика — без таймзон). */
export function monthsBetween(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.split("-").map(Number);
  const [ty, tm, td] = toDate.split("-").map(Number);
  let months = (ty! - fy!) * 12 + (tm! - fm!);
  // кламп кінця місяця: найнятий 29–31-го «доживає» місяць в останній день
  // коротшого місяця (31.12 + 6 міс = 30.06, а не «мінус місяць»)
  const daysInTo = new Date(Date.UTC(ty!, tm!, 0)).getUTCDate();
  if (td! < Math.min(fd!, daysInTo)) months--;
  return months;
}

/** Останній день місяця сводної (YYYY-MM → YYYY-MM-DD). */
export function monthEndStr(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y!, m!, 0)).getUTCDate()).padStart(2, "0")}`;
}

/** Календарних днів між датами (YYYY-MM-DD, включно з першим днем не рахуємо). */
export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(toDate + "T12:00:00Z") - Date.parse(fromDate + "T12:00:00Z")) / 86400000);
}

/**
 * Бонус Agram до ставки нетто, зл/год.
 * Стаж: лише якщо в місяці відпрацьовано ≥160 год; від дати працевлаштування
 * станом на кінець місяця сводної: до 30 днів → 0, від 30 днів → +1,
 * від 60 днів → +1.5; галочка стоїть, а дати нема → +1.
 * Нал: фіксований +1, від годин НЕ залежить (галочка = частина ЗП готівкою;
 * людям на przelew не належить — у них галочка знята).
 * Студентам до 26 бонуси не додаються взагалі (вирішується у викликачів).
 * (Звірено з таблицею AGRAM 06.2026: Lomako 147 год → без стаж-бонусу,
 * Nabieva 75 днів стажу → +1.5, Petrenko 34 дні → +1.)
 */
export const AGRAM_BONUS_MIN_HOURS = 160;

// LST: той самий готівковий бонус +1 зл/год, що на Agram (частина ЗП налом),
// але БЕЗ стажевого. Студентам до 26 не належить (нетто = брутто «як є»).
export const LST_FACTORY_ID = 1;
export const CASH_BONUS_FACTORY_IDS = new Set([...AGRAM_FACTORY_IDS, LST_FACTORY_ID]);
/**
 * Фабричний бонус до ставки нетто за правилом фабрики (не для студентів до 26 —
 * гейтять викликачі). Нал — фіксований, від годин не залежить; стаж — по
 * сходинках від дати працевлаштування на кінець місяця (галочка без дати =
 * перша сходинка), лише при stazMinHours+ годинах місяця.
 */
export function factoryBonusPerHour(
  w: { agramStazBonus: boolean; agramCashBonus: boolean; employmentStartDate: string | null },
  rule: PayoutRule | null | undefined,
  month: string,
  monthHours?: number | null,
): number {
  if (!rule) return 0;
  let b = w.agramCashBonus ? rule.cashBonus : 0;
  const stazEligible = !(rule.stazMinHours != null && monthHours != null && monthHours < rule.stazMinHours);
  if (rule.stazBonus && w.agramStazBonus && stazEligible && rule.stazSteps.length) {
    const steps = [...rule.stazSteps].sort((a, z) => a.days - z.days);
    if (!w.employmentStartDate) b += steps[0]!.add;
    else {
      const d = daysBetween(w.employmentStartDate, monthEndStr(month));
      let add = 0;
      for (const s of steps) if (d >= s.days) add = s.add;
      b += add;
    }
  }
  return r2(b);
}

/** Legacy-обгортка бонусу Agram (правило з хардкоду). Нові виклики — factoryBonusPerHour(w, rule, …). */
export function agramBonusPerHour(
  w: { agramStazBonus: boolean; agramCashBonus: boolean; employmentStartDate: string | null },
  month: string,
  monthHours?: number | null,
): number {
  return factoryBonusPerHour(w, legacyPayoutRule([...AGRAM_FACTORY_IDS][0], null), month, monthHours);
}

// ── Eurocash: ставка працівника від порогів продуктивності ───────────────────
// Джерело — блок STAWKA EUROCASH вкладки сводної (дзеркало в svodni_tab_meta):
// зелений рядок = ставка фабрики нам за порогом, жовтий = діапазони
// продуктивності, під ними нетто і брутто працівника; клітинки A нетто/брутто
// рядків = доплата за нічну годину (3,50 нетто / 4,50 брутто). Студент до 26 —
// нетто = брутто і нічна брутто. Таблиці різні по містах — поки лише Люблін.
export const EUROCASH_FACTORY_IDS = new Set([9, 8]); // 9=EUROCASH LUBLIN, 8=EUROCASH BIAŁYSTOK (Krosno — згодом)

export interface EurocashRates {
  agency: (number | null)[]; // ставки фабрики нам (зелений рядок)
  ranges: ({ from: number; to: number | null } | null)[]; // діапазони продуктивності («237 +» → to=null)
  netto: (number | null)[];
  brutto: (number | null)[];
  nightNetto: number;  // доплата за нічну, не студент
  nightBrutto: number; // студент до 26
}

const parseEurocashRange = (c: unknown): { from: number; to: number | null } | null => {
  const s = String(c ?? "").trim();
  const num = (t: string) => Number(t.replace(",", "."));
  let m = /^([\d.,]+)\s*-\s*([\d.,]+)$/.exec(s);
  if (m) return { from: num(m[1]!), to: num(m[2]!) };
  m = /^([\d.,]+)\s*\+$/.exec(s);
  if (m) return { from: num(m[1]!), to: null };
  return null;
};

/** Розбір дзеркала блоку STAWKA EUROCASH: [0] зелений, [1] жовтий (діапазони),
 *  [2] нетто, [3] брутто. Індекси колонок вирівняні між рядками. */
export function eurocashRatesFromBlock(block: (string | number)[][] | null | undefined): EurocashRates | null {
  if (!block || block.length < 4) return null;
  const [green, yellow, nettoRow, bruttoRow] = block;
  if (!/STAWKA EUROCASH/i.test(String(green![0] ?? ""))) return null;
  const num = (c: unknown): number | null => (typeof c === "number" && Number.isFinite(c) ? c : null);
  const count = Math.max(green!.length, yellow?.length ?? 0, nettoRow!.length, bruttoRow!.length) - 1;
  const rates: EurocashRates = {
    agency: [], ranges: [], netto: [], brutto: [],
    nightNetto: num(nettoRow![0]) ?? 3.5, nightBrutto: num(bruttoRow![0]) ?? 4.5,
  };
  for (let i = 1; i <= count; i++) {
    rates.agency.push(num(green![i]));
    rates.ranges.push(parseEurocashRange(yellow?.[i]));
    rates.netto.push(num(nettoRow![i]));
    rates.brutto.push(num(bruttoRow![i]));
  }
  return rates.netto.some(v => v != null) ? rates : null;
}

/** Індекс порогу: точний матч ставки агенції з файлу фабрики із зеленим рядком
 *  (±0.011 — дзеркало може бути округлене до копійки), фолбек — продуктивність
 *  у діапазони жовтого рядка. null = поріг не знайдено (ставки не проставляємо). */
export function eurocashBracketIndex(
  rates: EurocashRates,
  stawkaAgencji: number | null | undefined,
  produktywnosc: number | null | undefined,
): number | null {
  if (stawkaAgencji != null) {
    const i = rates.agency.findIndex(a => a != null && Math.abs(a - stawkaAgencji) <= 0.011);
    if (i >= 0) return i;
  }
  if (produktywnosc != null) {
    const i = rates.ranges.findIndex(r => r != null && produktywnosc >= r.from && (r.to == null || produktywnosc <= r.to));
    if (i >= 0) return i;
  }
  return null;
}

// ── Резолюція базової пари ставок (без фабричних бонусів) ────────────────────
// Пріоритет: профіль (якщо ставка вказана) → пара посади фабрики → найдешевша
// посада (фабрика веде посади, а в профілі посада не вказана = «звичайний
// працівник») → базова пара фабрики. Стандартну пару підставляють викликачі
// за своїми правилами (без статусу / Agram). Студент до 26 неоподаткований:
// нетто = брутто, профільна оподаткована нетто ігнорується.
export type RatePair = { brutto: number | null; netto: number | null };
export interface RateRules {
  position?: RatePair | null; // пара посади людини на цій фабриці
  cheapestPosition?: RatePair | null; // найдешевша посада фабрики (fallback без посади)
  factory?: RatePair | null; // базова пара фабрики
  /** id найдешевшої посади — секція безпосадних рядків сводної (ставку їм і так задає вона) */
  cheapestPositionId?: number | null;
}
export function resolveBaseRates(
  w: { hourlyRate: number | null; hourlyRateNetto: number | null },
  rules: RateRules,
  stud26: boolean,
): RatePair {
  const rule = rules.position?.brutto != null ? rules.position
    : rules.cheapestPosition?.brutto != null ? rules.cheapestPosition
    : rules.factory?.brutto != null ? rules.factory : null;
  const brutto = w.hourlyRate ?? rule?.brutto ?? null;
  if (stud26) return { brutto, netto: brutto };
  const netto = w.hourlyRateNetto
    // нетто з правила беремо лише коли брутто теж звідти (або профільна = правилу)
    ?? (rule && (w.hourlyRate == null || w.hourlyRate === rule.brutto) ? rule.netto : null);
  return { brutto, netto };
}

export interface LegalCtx {
  profileLegal?: LegalStatus | null;
  factoryLabel?: string | null;
  /** побажання працівника (примітки профілю) — найвищий пріоритет */
  payoutPref?: { kind: "all_konto" | "hours" | "amount"; value: number | null } | null;
  /** місто рядка: у Любліні/Познані Dopłata ES вже сидить у doWyplaty, у Лодзі — поверх */
  city?: string | null;
  /** фірма рядка (svodni_rows.firm) — фірмо-залежні стелі (Sushi ES → 80 год) */
  firm?: string | null;
  /** явна стеля księgowych годин (сегменти: місячний ліміт ділиться між ними) — перекриває factoryDeclaredCap */
  declaredCapH?: number | null;
  /** id фабрики рядка — фабрико-залежні правила (премія Agram завжди готівкою) */
  factoryId?: number | null;
  /** сума вшитого бонусу за місяць, зл (сегментований батько: Σ по сегментах) — перекриває facBonus × години */
  bonusTotal?: number | null;
  /**
   * правило konto/готівки фабрики на місяць рядка (services/factoryRules.ts).
   * Не передане/undefined — legacy-фолбек по factoryId+factoryLabel (шляхи без
   * контексту фабрики: парсери google-вкладок). null = «без правил».
   */
  rule?: PayoutRule | null;
}

// Księgowa пара ставок рядка: студентська неоподаткована (netto = brutto)
// декларується як є; всі інші — по нижчій зі ставок (фабрична LST 26,35 →
// стандартна 25,35; ANDROS wózkowy 36/36 — теж стандартна пара). Вшитий у
// ставку фабричний бонус (extras.facBonus) — не księgowa частина: віднімається
// ДО клампу, інакше рядок з базою нижче стандартної декларував би бонус у
// конто (а «студентоподібна» перевірка брутто ≤ нетто хибно спрацьовувала б
// на бонусній нетто вище брутто).
export function ksiegRatesOf(
  row: Pick<SvodniParsedRow, "rateBrutto" | "rateNetto" | "isStudent"> & { extras?: Record<string, unknown> },
  ls: LegalStatus | null,
): { netto: number | null; brutto: number | null } {
  const facBonus = typeof row.extras?.facBonus === "number" ? (row.extras.facBonus as number) : 0;
  const netto = row.rateNetto != null ? r2(row.rateNetto - facBonus) : null;
  const untaxed = (row.isStudent === true || ls === "student")
    && row.rateBrutto != null && netto != null && row.rateBrutto <= netto + 0.001;
  return {
    netto: netto != null ? (untaxed ? netto : Math.min(netto, KSIEG_STD_NETTO())) : null,
    brutto: row.rateBrutto != null ? (untaxed ? row.rateBrutto : Math.min(row.rateBrutto, KSIEG_STD_BRUTTO())) : null,
  };
}

export function applyLegalDefaults(row: SvodniParsedRow, force = false, ctx: LegalCtx = {}): void {
  if (row.doWyplaty == null) return;
  if (!force && (row.ksiegNetto != null || row.gotowka != null)) return;
  const doplata = typeof row.extras.doplataEs === "number" ? (row.extras.doplataEs as number) : 0;
  // Dopłata ES — завжди готівкова частина. У Любліні/Познані вона ВЖЕ входить
  // у doWyplaty (заробив 5000 + 500 доплати = 5500, з них 500 готівкою) →
  // конто не може її з'їсти і в готівку вдруге вона не додається. У Лодзі
  // RAZEM її не містить — там доплата йде поверх, готівкою (формула таблиці).
  const doplataInPayout = ctx.city !== "Лодзь";
  const ls = legalStatusOf(String(row.extras.zusStatus ?? "")) ?? normalizeProfileLegal(ctx.profileLegal) ?? null;
  const rule = ctx.rule !== undefined ? ctx.rule : legacyPayoutRule(ctx.factoryId ?? null, ctx.factoryLabel ?? null);
  const capH = ctx.declaredCapH !== undefined ? ctx.declaredCapH : declaredCapOf(rule, row.hours ?? null, ctx.firm ?? null);
  const { netto: ksiegNettoRate, brutto: ksiegBruttoRate } = ksiegRatesOf(row, ls);
  // Готівкові складові, які конто НЕ може зʼїсти в жодній гілці (вкл. побажання
  // «все на конто»); виняток — студент до 26: його виплата вся на конто.
  const stud26 = !!(row.isStudent && row.under26);
  // вшитий у ставку фабричний бонус (Agram нал/стаж, LST нал) — завжди готівкою
  const facBonus = !stud26 && typeof row.extras.facBonus === "number" ? (row.extras.facBonus as number) : 0;
  const bonusSum = !stud26 && ctx.bonusTotal != null ? ctx.bonusTotal
    : facBonus > 0 && row.hours != null ? r2(facBonus * row.hours) : 0;
  // колонка Premia — завжди готівкою, якщо так каже правило фабрики (Agram;
  // на конто лише студентам до 26)
  const premiaCash = !stud26 && rule?.premiaCash ? (row.premia ?? 0) : 0;
  // На карту не можна переказати більше, ніж людині взагалі належить:
  // відрахування (аванси/хостел/кари) могли зʼїсти виплату → конто ∈ [0, max(доВиплати, 0)]
  // мінус готівкова доплата (якщо вона всередині doWyplaty), мінус готівкові
  // бонус і премія Agram.
  // Якщо конто обрізане кепом — księgowe години/брутто рахуються від фактичного конто.
  const cap = Math.max(row.doWyplaty - (doplataInPayout ? doplata : 0) - bonusSum - premiaCash, 0);
  const finish = (targetKonto: number, declaredHours: number | null, studentBrutto = false) => {
    const konto = r2(Math.max(0, Math.min(targetKonto, cap)));
    row.konto = konto;
    row.ksiegNetto = konto;
    // Księgowe години — ЗАВЖДИ від фактичного конто (інваріант пари: год ×
    // ставка = brutto). Раніше перераховувались лише при обрізанні стелею —
    // у студентів до 26 (konto = виплата ПІСЛЯ знять: kara/hostel/zaliczka)
    // і «все на конто» лишались повні години при меншій сумі, і пара рвалась
    // рівно на суму знять (BIMIZ 07.2026, рішення 22.08.2026).
    row.hoursDeclared = ksiegNettoRate != null && ksiegNettoRate > 0 ? r2(konto / ksiegNettoRate) : declaredHours;
    // księg. brutto — від фактичного конто: konto ÷ ставка нетто × ставка брутто
    // (не «всі години × брутто» — конто може включати премію чи бути обрізаним)
    row.ksiegBrutto = studentBrutto
      ? konto // студент: netto = brutto
      : ksiegNettoRate != null && ksiegBruttoRate != null && ksiegNettoRate > 0
        ? r2(konto / ksiegNettoRate * ksiegBruttoRate)
        : row.hoursDeclared != null && ksiegBruttoRate != null ? r2(row.hoursDeclared * ksiegBruttoRate) : null;
    row.gotowka = r2(row.doWyplaty! - konto + (doplataInPayout ? 0 : doplata));
  };
  const pref = ctx.payoutPref;
  if (pref && (pref.kind === "all_konto" || pref.value != null)) {
    // побажання працівника — понад статуси й oświadczenie (заробив менше → менша сума через cap)
    if (pref.kind === "all_konto") finish(row.doWyplaty, row.hours ?? null);
    else if (pref.kind === "hours") finish((pref.value ?? 0) * (ksiegNettoRate ?? 0), ksiegNettoRate ? r2(pref.value ?? 0) : null);
    else finish(pref.value ?? 0, ksiegNettoRate ? r2(Math.min(Math.max(pref.value ?? 0, 0), cap) / ksiegNettoRate) : null);
  } else if (row.isStudent && row.under26) {
    finish(row.doWyplaty, row.hours ?? null, true);
  } else if (ls === "oczekuje" || (ls == null && force)) {
    // не оформлений / без статусу — все готівкою (перед гілкою освядчення:
    // вписані колись години дозволу без статусу конто не відкривають)
    finish(0, 0);
  } else if (row.hoursNotified != null && row.hoursNotified > 0 && row.hours != null && ksiegNettoRate != null) {
    const declared = Math.min(row.hoursNotified, row.hours, capH ?? Infinity);
    finish(declared * ksiegNettoRate, r2(declared));
  } else if (ls != null) {
    // оформлений без oświadczenia-годин: все на карту, але не вище фабричної
    // стелі годин. Бонусна ставка (платіжна нетто ВИЩА за księgową, напр.
    // AGRAM 26,85 = 25,35 + 1,5 бонус): конто декларується по księgowій за
    // фактичні години, бонусна різниця — готівкою.
    const bonusPerHour = typeof row.extras.premiaEs === "number" ? (row.extras.premiaEs as number) : 0;
    const bonusRate = (row.rateNetto != null && ksiegNettoRate != null && row.rateNetto > ksiegNettoRate + 0.001) || bonusPerHour > 0;
    if ((capH != null || bonusRate) && ksiegNettoRate != null && row.hours != null) {
      const declared = Math.min(row.hours, capH ?? Infinity);
      finish(declared * ksiegNettoRate, r2(declared));
    } else {
      finish(row.doWyplaty, row.hours ?? null);
    }
  }
}

// ── Люблін / Познань: одна вкладка = одна фабрика ────────────────────────────
export function parseLublinTab(factoryLabel: string, rows: unknown[][]): SvodniParsedTab | null {
  const header = rows[0];
  if (!header) return null;
  const labels = header.map(c => norm(String(c ?? "")));
  const hIdx = (re: RegExp, from = 0, to = labels.length) => labels.findIndex((h, i) => i >= from && i < to && re.test(h));
  const doWyplatyCol = hIdx(/^DO WYPLATY( NETTO)?$/);
  if (doWyplatyCol < 0) return null; // не зарплатна вкладка
  // імʼя — зліва від «Ilość godz w powiadomieniu» (Познань має службові колонки перед ним)
  const powiadCol = hIdx(/GODZ W POWIADOMIENIU/);
  const nameCol = powiadCol > 0 ? powiadCol - 1 : 0;

  // мапа колонок: ставки/brutto ліворуч від Do wypłaty; обчислені Brutto/Godzin
  // Faktycznie/Księgowość — праворуч (ANDROS: «Brutto|Netto» без слова Stawka = ставки)
  const colOf = new Map<number, { key: string; core: boolean; premia?: boolean }>();
  const hrOf = new Map<number, string>();
  for (let i = 0; i < labels.length; i++) {
    if (i === nameCol || !labels[i]) continue;
    const hr = HR_COLS.find(h => h.re.test(labels[i]!));
    if (hr && i > doWyplatyCol) { hrOf.set(i, hr.key); continue; }
    const m = LUBLIN_COLS.find(c => c.re.test(labels[i]!));
    if (m && i < doWyplatyCol) { colOf.set(i, { key: m.col.key, core: m.col.core, premia: m.premia }); continue; }
    if (i < doWyplatyCol && /^BRUTTO$/.test(labels[i]!)) colOf.set(i, { key: "rateBrutto", core: true });
    else if (i < doWyplatyCol && /^NETTO$/.test(labels[i]!)) colOf.set(i, { key: "rateNetto", core: true });
    else if (i === doWyplatyCol) colOf.set(i, { key: "doWyplaty", core: true });
    else if (i > doWyplatyCol && /^BRUTTO$/.test(labels[i]!)) colOf.set(i, { key: "brutto", core: true });
    else if (i > doWyplatyCol && /GODZIN FAKTYCZNIE/.test(labels[i]!)) colOf.set(i, { key: "ksiegHours", core: false });
    else if (i > doWyplatyCol && /^KSIEGOWOSC$/.test(labels[i]!)) colOf.set(i, { key: "zusStatus", core: false });
    else if (hr) hrOf.set(i, hr.key);
  }
  colOf.set(doWyplatyCol, { key: "doWyplaty", core: true });

  const out: SvodniParsedTab = { factoryLabel, firmGuess: null, rows: [], sheetSuma: {}, counts: {}, nameCol };
  // порядок колонок як у таблиці (для рендера вкладки тим самим порядком);
  // сумарна «premia» стає на місце першої преміальної колонки
  const colOrder: string[] = [];
  let premiaPlaced = false;
  for (const i of [...new Set([...colOf.keys(), ...hrOf.keys()])].sort((a, b) => a - b)) {
    const c = colOf.get(i);
    if (c) {
      if (c.premia && !premiaPlaced) { colOrder.push("premia"); premiaPlaced = true; }
      colOrder.push(c.core ? c.key : `extras.${c.key}`);
    } else colOrder.push(`hr.${hrOf.get(i)!}`);
  }
  out.colOrder = colOrder;
  let section: string | null = null;
  let r = 1;
  for (; r < rows.length; r++) {
    const name = cell(rows[r], nameCol);
    const normName = norm(name);
    if (/^SUMA GODZIN/.test(normName) || /^SUMA GODZIN/.test(norm(cell(rows[r], nameCol + 1)))) break;
    if (SECTION_RE.test(normName)) { section = name; continue; }
    if (!name || isServiceRow(name)) continue;
    // Познань: колонка «Firma» лівіше імені
    if (!out.firmGuess) for (let j = 0; j < nameCol; j++) {
      const v = norm(cell(rows[r], j));
      if (/OUTS/.test(v)) out.firmGuess = "ESO";
      else if (/KLINEX/.test(v)) out.firmGuess = "Klinex";
      else if (/EURO ?SUP/.test(v)) out.firmGuess = "ES";
      if (out.firmGuess) break;
    }
    const hasAnyNumber = [...colOf.keys()].some(i => num(rows[r]?.[i]) != null);
    const powiadMark = powiadCol >= 0 ? norm(cell(rows[r], powiadCol)) : "";
    const powiadMarkIsText = !!powiadMark && num(rows[r]?.[powiadCol]) == null;
    const row = emptyRow(section, name);
    (row as any).__hasNum = hasAnyNumber || powiadMarkIsText;
    let premiaSum: number | null = null;
    for (const [i, c] of colOf) {
      const v = rows[r]?.[i];
      if (c.key === "zusStatus") { const s = cell(rows[r], i); if (s) row.extras.zusStatus = s; continue; }
      const n = num(v);
      if (n == null) continue;
      if (c.premia) { premiaSum = (premiaSum ?? 0) + n; row.extras[c.key] = n; continue; }
      if (c.core) (row as any)[c.key] = n;
      else row.extras[c.key] = n;
    }
    row.premia = premiaSum != null ? r2(premiaSum) : null;
    for (const [i, k] of hrOf) { const v = dateCell(rows[r], i); if (v) row.hr[k] = v; }
    // Текст у колонці «повідомлення» — статусний маркер замість годин:
    // STUD / STUD>26 / DYPLOM / KARTA POBYTU / NIE ZGŁOSZONY / polka…
    // Якщо колонка Księgowość порожня — маркер стає джерелом форми легалізації.
    const powiadTxt = powiadMarkIsText ? powiadMark : "";
    if (powiadMarkIsText) {
      row.hoursNotified = null;
      if (!row.extras.zusStatus) row.extras.zusStatus = cell(rows[r], powiadCol);
    }
    const zusTxt = norm(String(row.extras.zusStatus ?? ""));
    row.isStudent = /^STUD/.test(powiadTxt) || /STUDENT/.test(zusTxt) ? true : zusTxt ? false : null;
    row.under26 = /(>|WYZEJ ?)26/.test(powiadTxt) ? false
      : powiadTxt === "STUD" ? true // класичний STUD-маркер = студент до 26 (після 26 маркують явно)
      : /DO ?26/.test(zusTxt) ? true : /WYZEJ ?26/.test(zusTxt) ? false : null;
    row.sheetRow = r;
    out.rows.push(row);
  }

  // рядок SUMA: клітинки під канонічними колонками
  if (r < rows.length) {
    for (const [i, c] of colOf) {
      const n = num(rows[r]?.[i]);
      if (n != null) out.sheetSuma[c.premia ? c.key : c.key] = n;
    }
  }
  // сервісні лічильники нижче
  for (let i = r; i < Math.min(r + 12, rows.length); i++) {
    const label = norm(cell(rows[i], nameCol)) || norm(cell(rows[i], 0));
    const v = num(rows[i]?.[nameCol + 1]) ?? num(rows[i]?.[1]);
    if (/^ILOSC PRACOWNIKOW/.test(label) && v != null) out.counts.workers = Math.round(v);
    if (/^(W TYM )?STUDENTOW|^W TYM STUDENTOW/.test(label) && v != null && out.counts.students == null) out.counts.students = Math.round(v);
    if (/WYZEJ ?26/.test(label) && v != null) out.counts.over26 = Math.round(v);
  }

  // Розділювачі позицій («OSOBY FUNKCYJNE», «LIDERZY», назви ліній) — рядки без
  // жодного числа. Але лише коли У ВКЛАДЦІ Є числові рядки: у травневих ANDROS
  // головна таблиця — самі імена (дані в нижньому блоці), там усі рядки — люди.
  if (out.rows.some(x => (x as any).__hasNum)) {
    const filtered: typeof out.rows = [];
    let divSection: string | null = null;
    let prevLoopSection: string | null | undefined;
    for (const x of out.rows) {
      if (prevLoopSection !== undefined && x.section !== prevLoopSection) divSection = null; // нова секція таблиці
      prevLoopSection = x.section;
      if (!(x as any).__hasNum) { divSection = x.rawName; continue; }
      if (divSection) x.section = divSection;
      filtered.push(x);
    }
    out.rows = filtered;
  }
  for (const x of out.rows) delete (x as any).__hasNum;

  // Premia ES на вкладках AGRAM — ставка-індикатор бонусної програми (1/1,5),
  // яку Agram платить окремо: формула Do wypłaty її НЕ додає. Прибираємо з premia.
  const hasPremiaAgram = [...colOf.values()].some(c => c.key === "premiaAgram");
  if (hasPremiaAgram) for (const row of out.rows) {
    const pes = typeof row.extras.premiaEs === "number" ? (row.extras.premiaEs as number) : 0;
    if (pes && row.premia != null) row.premia = r2(row.premia - pes) || null;
  }

  // інфо-блок «STAWKA EUROCASH» — ставки за діапазонами годин (дзеркалимо як є)
  for (let i = r; i < rows.length; i++) {
    if (norm(cell(rows[i], 0)) !== "STAWKA EUROCASH") continue;
    const block: (string | number)[][] = [];
    // до першого порожнього рядка, макс 8: у Білостоку під основними 5 рядками
    // ще норми wózkowych («operacji GD na godzinę» / «kartonów na operację GD»)
    for (let j = i; j < Math.min(i + 8, rows.length); j++) {
      // числа — повної точності: з блоку рахуються ставки працівника (from-hours
      // Eurocash), як у формулах таблиці; веб округлює лише при показі
      const rr = (rows[j] ?? []).map(c => (typeof c === "number" ? c : String(c ?? "")));
      while (rr.length && rr[rr.length - 1] === "") rr.pop();
      if (!rr.length) break;
      block.push(rr);
    }
    if (block.length) out.info = { ...(out.info ?? {}), stawkaEurocash: block };
    break;
  }

  // нижній блок księgowość/готівка (як у payrollSummaries.parseFactoryTab)
  mergeKsiegBlock(rows, r, out, nameCol);
  return out;
}

// нижній блок «godz fakt / godz księgowość / brutto / netto / gotówka» — якщо
// є, наповнює закритий шар відповідних людей (матч по імені). Варіанти:
//  a) з підписами (godz fakt / księgowość / gotówka);
//  b) без жодного підпису (Познань): та сама пʼятірка колонок одразу праворуч
//     від колонки імен головної таблиці — впізнаємо за рядком, де імʼя з
//     головної таблиці має ≥4 числа праворуч.
function mergeKsiegBlock(rows: unknown[][], from: number, out: SvodniParsedTab, mainNameCol: number) {
  const mainKeys = new Set(out.rows.map(w => key(cleanName(w.rawName))));
  let start = -1, faktCol = -1, ksieg = -1, bru = -1, net = -1, got = -1, zal = -1, nameCol = -1;
  for (let r = from; r < rows.length && start < 0; r++) {
    const line = rows[r] ?? [];
    const labels = line.map(c => norm(String(c ?? "")));
    const idx = (re: RegExp) => labels.findIndex(h => re.test(h));
    const fakt = idx(/GODZ\.?\s*FAKT/);
    const ksiegLbl = idx(/KSIEGOWOSC/);
    const gotLbl = idx(/GOTOWKA|DOTOWKA/);
    if (fakt >= 0 || (ksiegLbl >= 0 && gotLbl >= 0)) {
      ksieg = ksiegLbl >= 0 ? ksiegLbl : fakt + 1;
      faktCol = fakt >= 0 ? fakt : ksieg - 1;
      const bruLbl = idx(/^BRUTTO/); bru = bruLbl >= 0 ? bruLbl : ksieg + 1;
      const netLbl = idx(/^NETTO/); net = netLbl >= 0 ? netLbl : bru + 1;
      got = gotLbl >= 0 ? gotLbl : net + 1;
      const zalLbl = idx(/^ZALICZK/); zal = zalLbl > got ? zalLbl : -1; // блокова zaliczka — праворуч від готівки
      const firstData = rows[r + 1] ?? [];
      for (let j = faktCol - 1; j >= 0; j--) {
        const v = String(firstData[j] ?? "").trim();
        if (!v || num(v) != null) continue;
        if (/^(STUD|DYPLOM|NIE ZG|KARTA|POWIAD|СТОЛБЕЦ|STOLBEC)/.test(norm(v))) continue;
        nameCol = j;
        break;
      }
      if (nameCol >= 0) start = r + 1;
      continue;
    }
    if (gotLbl >= 5 && labels.filter(h => h).length === 1) {
      got = gotLbl; net = got - 1; bru = got - 2; ksieg = got - 3; faktCol = got - 4;
      nameCol = -1;
      const firstData = rows[r + 1] ?? [];
      for (let j = faktCol - 1; j >= 0; j--) {
        const v = String(firstData[j] ?? "").trim();
        if (v && num(v) == null) { nameCol = j; break; }
      }
      if (nameCol >= 0) start = r + 1;
      continue;
    }
    // хедер чужої нижньої таблиці (Eurocash: «Nazwisko i Imię … KOŃCOWE
    // ROZLICZENIE» — розрахунок для клієнта) — нижче księgowość-блоку немає
    if (labels.some(h => /NAZWISKO|KONCOWE ROZLICZ/.test(h))) break;
    // варіант (b): безлейбловий — імʼя з головної таблиці + ≥4 числа праворуч
    const nm = cell(line, mainNameCol);
    if (nm && mainKeys.has(key(cleanName(nm)))) {
      const nums = [1, 2, 3, 4, 5].map(o => num(line[mainNameCol + o]));
      if (nums.filter(v => v != null).length >= 4) {
        nameCol = mainNameCol;
        faktCol = mainNameCol + 1; ksieg = mainNameCol + 2; bru = mainNameCol + 3;
        net = mainNameCol + 4; got = mainNameCol + 5;
        start = r;
      }
    }
  }
  if (start < 0) return;
  {
    const used = new Set<number>();
    for (let i = start; i < rows.length; i++) {
      const name = cell(rows[i], nameCol);
      if (!name || isServiceRow(name)) break;
      const bk = key(cleanName(name));
      const bt = nameTokens(name);
      let m = out.rows.findIndex((w, wi) => !used.has(wi) && key(cleanName(w.rawName)) === bk);
      if (m < 0) m = out.rows.findIndex((w, wi) => {
        if (used.has(wi)) return false;
        const wt = new Set(nameTokens(w.rawName));
        return bt.filter(t => wt.has(t)).length >= 2;
      });
      const vals = {
        hoursDeclared: num(rows[i]?.[ksieg]),
        ksiegBrutto: num(rows[i]?.[bru]),
        ksiegNetto: num(rows[i]?.[net]),
        gotowka: num(rows[i]?.[got]),
        faktBlock: num(rows[i]?.[faktCol]),
        zaliczkaBlock: zal >= 0 ? num(rows[i]?.[zal]) : null,
      };
      if (m >= 0) {
        used.add(m);
        const w = out.rows[m]!;
        w.hoursDeclared = vals.hoursDeclared;
        w.ksiegBrutto = vals.ksiegBrutto;
        w.ksiegNetto = vals.ksiegNetto;
        w.gotowka = vals.gotowka;
        w.konto = vals.ksiegNetto;
        if (w.hours == null) w.hours = vals.faktBlock;
        if (vals.faktBlock != null) w.extras.godzFaktBlock = vals.faktBlock;
        if (vals.zaliczkaBlock != null) w.extras.zaliczkaBlock = vals.zaliczkaBlock;
      } else {
        // людина є лише в нижньому блоці (у головній таблиці її нема — звільнена
        // або нульова виплата): додаємо окремим рядком, помічаємо blockOnly
        const row = emptyRow(null, name);
        row.extras.blockOnly = 1;
        row.hours = vals.faktBlock;
        if (vals.zaliczkaBlock != null) row.extras.zaliczkaBlock = vals.zaliczkaBlock;
        row.hoursDeclared = vals.hoursDeclared;
        row.ksiegBrutto = vals.ksiegBrutto;
        row.ksiegNetto = vals.ksiegNetto;
        row.gotowka = vals.gotowka;
        row.konto = vals.ksiegNetto;
        row.doWyplaty = vals.ksiegNetto != null || vals.gotowka != null ? r2((vals.ksiegNetto ?? 0) + (vals.gotowka ?? 0)) : null;
        out.rows.push(row);
      }
    }
  }
}

function emptyRow(section: string | null, rawName: string): SvodniParsedRow {
  return {
    section, rawName,
    hoursNotified: null, hours: null, shifts: null, rateBrutto: null, rateNetto: null,
    premia: null, zaliczka: null, zaliczkaBd: null, hostel: null, odziez: null,
    dojazd: null, kara: null, komornik: null, kaucja: null, potracenia: null,
    doWyplaty: null, brutto: null,
    hoursDeclared: null, ksiegBrutto: null, ksiegNetto: null, gotowka: null, konto: null,
    isStudent: null, under26: null,
    extras: {}, hr: {}, sheetValues: {}, mismatch: null,
  };
}

// ── Познань: Sushi&Food Factory + Work List ──────────────────────────────────
// Основна вкладка парситься люблінським парсером (та сама модель заголовків);
// Work List — вивантаження обліку часу: Nr Osobowy → години (час × 24). Тут
// звіряємо години кожного рядка з Work List (розбіжність → mismatch.workList).
export function parseWorkList(rows: unknown[][]): Map<string, number> {
  const hours = new Map<string, number>();
  const header = (rows[0] ?? []).map(c => norm(String(c ?? "")));
  const numCol = header.findIndex(h => /^NUMER$/.test(h));
  const hCol = header.findIndex(h => /GODZINY LICZBOWO/.test(h));
  const sumCol = header.findIndex(h => /^SUMA GODZIN$/.test(h));
  if (numCol < 0) return hours;
  for (let r = 1; r < rows.length; r++) {
    const id = cell(rows[r], numCol);
    if (!id) continue;
    // «GODZINY LICZBOWO» — уже число; fallback: «SUMA GODZIN» час × 24
    const direct = hCol >= 0 ? num(rows[r]?.[hCol]) : null;
    const fromTime = sumCol >= 0 ? num(rows[r]?.[sumCol]) : null;
    const h = direct ?? (fromTime != null ? fromTime * 24 : null);
    if (h != null) hours.set(id, r2(h));
  }
  return hours;
}

// ── Лодзь: вкладки фірмових книг (ES/ESO: секційні заголовки; Klinex: Ew.) ───
// RAZEM = godziny×stawkaNetto + migawka − zaliczki − potrącenia − hostel + premia (+dojazd…)
// Офіційна частина: Ew.-години → ksiegNetto = Ew×stawkaNetto, gotówka = RAZEM − ksiegNetto + Dopłata ES.
export function parseLodzFullTab(factoryLabel: string, rows: unknown[][]): SvodniParsedTab | null {
  const out: SvodniParsedTab = { factoryLabel, firmGuess: null, rows: [], sheetSuma: {}, counts: {} };
  let c: Record<string, number> | null = null;
  let section: string | null = null;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const labels = row.map(x => norm(String(x ?? "")));
    if (labels.some(h => /NAZWISKO/.test(h)) && labels.some(h => /^RAZEM$/.test(h))) {
      const idx = (re: RegExp) => labels.findIndex(h => re.test(h));
      c = {
        name: idx(/NAZWISKO/), status: idx(/^STATUS$/), hours: idx(/^GODZINY?$/),
        stB: idx(/STAWKA.*BRUTTO/), stN: idx(/STAWKA.*NETTO/),
        premia: idx(/^PREMIA$/), hostel: idx(/^HOSTEL$/), potr: idx(/^POTRACENIA$|^POTRONCENIA$/),
        zal: idx(/^ZALICZKI$|^ZALICZKA$/), migawka: idx(/^MIGAWK/), dojazd: idx(/^DOJAZD$/),
        odziez: idx(/^ODZIEZ/), dokumenty: idx(/^DOKUMENTY$/),
        razem: idx(/^RAZEM$/), kontoH: idx(/^NA KONTO/), ew: idx(/^EW\.?$/), hRest: idx(/^H\.?$/),
        zl: idx(/^ZL\.?$/), doplata: idx(/^DOPLATA/), konto: idx(/^KONTO$/), ksieg: idx(/KSIEGOWOSC/),
        pow: idx(/^POW/), wniosek: idx(/WNIOSEK/), uwagi: idx(/^UWAGI$/),
      };
      out.nameCol = c.name;
      // порядок колонок вкладки — за індексами в хедері
      const KEY_OF: Record<string, string> = {
        status: "hr.status", hours: "hours", stB: "rateBrutto", stN: "rateNetto",
        premia: "premia", hostel: "hostel", potr: "potracenia", zal: "zaliczka",
        migawka: "extras.migawka", dojazd: "dojazd", odziez: "odziez",
        dokumenty: "extras.dokumenty", razem: "doWyplaty", kontoH: "extras.kontoH",
        ew: "hoursDeclared", hRest: "extras.gotowkaH", doplata: "extras.doplataEs",
        konto: "konto", pow: "hr.powOsw", wniosek: "hr.wniosekZaliczki", uwagi: "hr.uwagi",
      };
      out.colOrder = Object.entries(c)
        .filter(([k, i]) => i >= 0 && k !== "name" && KEY_OF[k])
        .sort((a, b) => a[1] - b[1])
        .map(([k]) => KEY_OF[k]!);
      continue;
    }
    if (!c) continue;
    const name = cell(row, c.name);
    const nn = norm(name);
    if (!name) continue;
    if (/^UL[. ]/.test(nn)) { section = name; continue; } // адреса-секція (точка збору)
    if (/^TOTAL/.test(nn)) {
      // рядок Total: — суми вкладки для tab_checks
      const grab = (col: number, k: string) => { if (col >= 0) { const v = num(row[col]); if (v != null) out.sheetSuma[k] = v; } };
      grab(c.hours!, "hours"); grab(c.razem!, "doWyplaty"); grab(c.premia!, "premia");
      grab(c.zal!, "zaliczka"); grab(c.hostel!, "hostel"); grab(c.potr!, "potracenia");
      grab(c.migawka!, "migawka"); grab(c.dojazd!, "dojazd"); grab(c.odziez!, "odziez");
      continue;
    }
    if (isServiceRow(name)) continue;
    const razem = num(row[c.razem]);
    if (razem == null) continue;
    const p = emptyRow(section, name);
    p.hours = c.hours >= 0 ? num(row[c.hours]) : null;
    p.rateBrutto = c.stB >= 0 ? num(row[c.stB]) : null;
    p.rateNetto = c.stN >= 0 ? num(row[c.stN]) : null;
    p.premia = c.premia >= 0 ? num(row[c.premia]) : null;
    p.hostel = c.hostel >= 0 ? num(row[c.hostel]) : null;
    p.potracenia = c.potr >= 0 ? num(row[c.potr]) : null;
    p.zaliczka = c.zal >= 0 ? num(row[c.zal]) : null;
    p.dojazd = c.dojazd >= 0 ? num(row[c.dojazd]) : null;
    p.odziez = c.odziez >= 0 ? num(row[c.odziez]) : null;
    p.doWyplaty = razem;
    const status = c.status >= 0 ? cell(row, c.status) : "";
    if (status) { p.hr.status = status; p.isStudent = /NIE\s*STUD/i.test(status) ? false : /STUD/i.test(status); }
    if (c.migawka >= 0) { const v = num(row[c.migawka]); if (v != null) p.extras.migawka = v; }
    if (c.dokumenty >= 0) { const v = num(row[c.dokumenty]); if (v != null) p.extras.dokumenty = v; }
    if (c.kontoH >= 0) { const v = num(row[c.kontoH]); if (v != null) p.extras.kontoH = v; }
    if (c.ksieg >= 0) { const v = cell(row, c.ksieg); if (v) p.extras.zusStatus = v; } // Księgowość-статус (форма легалізації)
    if (c.pow >= 0) { const v = cell(row, c.pow); if (v) p.hr.powOsw = v; }
    if (c.wniosek >= 0) { const v = cell(row, c.wniosek); if (v) p.hr.wniosekZaliczki = v; }
    if (c.uwagi >= 0) { const v = cell(row, c.uwagi); if (v) p.hr.uwagi = v; }
    // офіційна частина: повний Ew.-розклад (Klinex) або колонка KONTO
    const stN = p.rateNetto ?? 0;
    const stB = p.rateBrutto ?? 0;
    if (c.ew >= 0 && stN > 0) {
      // повний Ew.-розклад: порожня клітинка = 0 офіційних годин (усе готівкою) —
      // так само рахує зарплатний модуль (parseLodzTab)
      const ew = num(row[c.ew]) ?? 0;
      {
        const doplata = c.doplata >= 0 ? num(row[c.doplata]) ?? 0 : 0;
        p.extras.ewH = ew; // маркер: години зі СПРАВЖНЬОЇ таблички евіденції (Ew.)
        p.hoursDeclared = ew;
        p.ksiegBrutto = r2(ew * stB);
        p.ksiegNetto = r2(ew * stN);
        p.gotowka = r2(razem - p.ksiegNetto + doplata);
        p.konto = p.ksiegNetto;
        if (doplata) p.extras.doplataEs = doplata;
        if (c.hRest >= 0) { const v = num(row[c.hRest]); if (v != null) p.extras.gotowkaH = v; }
      }
    } else if (c.konto >= 0) {
      // «KONTO» в ES/ESO-вкладках — часто НОМЕР РАХУНКУ (текст «68 1600 …»),
      // а не сума: приймаємо як гроші лише правдоподібні значення
      const kontoRaw = cell(row, c.konto);
      const konto = num(kontoRaw);
      if (konto != null && konto > 0 && konto < 100_000) {
        p.konto = konto;
        p.ksiegNetto = konto;
        p.gotowka = r2(razem - konto);
        if (stN > 0) p.hoursDeclared = r2(konto / stN);
      } else if (/^\d[\d ]{20,}$/.test(kontoRaw)) {
        p.hr.kontoNr = kontoRaw; // номер банківського рахунку
      }
    }
    // обмежений розклад (ES/ESO без Ew., KONTO = номер рахунку): вважаємо все
    // офіційним (konto = RAZEM), як parseLodzTab зарплатного модуля;
    // WYPŁATA GOTÓWKĄ-оверлей далі поправляє тих, хто отримує частину готівкою.
    // Год. księg. — колонка «NA KONTO "h"» таблиці, без неї — konto / ставка
    if (p.ksiegNetto == null) {
      p.ksiegNetto = razem;
      p.konto = razem;
      const kontoH = typeof p.extras.kontoH === "number" ? (p.extras.kontoH as number) : null;
      p.hoursDeclared = kontoH != null ? r2(kontoH) : stN > 0 ? r2(razem / stN) : null;
    }
    p.sheetRow = r;
    out.rows.push(p);
  }
  if (!out.rows.length) return null;
  // лічильники в колонці Status (COUNTA-рядки під секціями обробляти не треба —
  // сервісні рядки відфільтровано; кількість рахуємо самі)
  out.counts.workers = out.rows.length;
  out.counts.students = out.rows.filter(x => x.isStudent).length;
  return out;
}

// ── Офісні вкладки (OFFICE ES / OFFICE KLINEX / Офис Лодзь …) ────────────────
// Люблін: name | status | godziny | stawka | brutto | umowa od/do | koniec
// studiów | zaświadczenie (+секції «LUBLIN», «STUDENTY», «Kierowcy | godziny»).
// Лодзь: Biuro | godziny | migawka | zaliczka | stawka | razem.
export function parseOfficeTab(tabLabel: string, rows: unknown[][]): SvodniParsedTab | null {
  const out: SvodniParsedTab = { factoryLabel: tabLabel, firmGuess: null, rows: [], sheetSuma: {}, counts: {} };
  const isLodz = rows.some(r => (r ?? []).some(c => /MIGAWKA/.test(norm(String(c ?? "")))));
  let section: string | null = null;
  for (const row of rows) {
    const name = cell(row, 0);
    if (!name) continue;
    const n = norm(name);
    if (/^BIURO$/.test(n)) continue; // заголовок лодзької вкладки
    if (/^LUBLIN|^LODZ|OFFICE|STUDENTY/.test(n) && num(row?.[4]) == null && num(row?.[5]) == null) { section = name; continue; }
    if (/^\d/.test(name) || isServiceRow(name)) continue;
    // секційні заголовки всередині («Kierowcy | godziny | stawka»)
    if (/GODZIN|DNI/.test(norm(cell(row, 1))) || /GODZIN|DNI/.test(norm(cell(row, 2)))) { section = name; continue; }
    const p = emptyRow(section, name);
    if (isLodz) {
      const h = num(row?.[1]);
      if (h != null) p.hours = h; else if (cell(row, 1)) p.hr.hoursText = cell(row, 1);
      const mig = num(row?.[2]); if (mig != null) p.extras.migawka = mig;
      p.zaliczka = num(row?.[3]);
      p.rateBrutto = num(row?.[4]);
      p.doWyplaty = num(row?.[5]);
    } else {
      if (cell(row, 1)) p.hr.status = cell(row, 1);
      const h = num(row?.[2]);
      if (h != null) p.hours = h; else if (cell(row, 2)) p.hr.hoursText = cell(row, 2);
      p.rateBrutto = num(row?.[3]);
      p.doWyplaty = num(row?.[4]);
      const d5 = dateCell(row, 5); if (d5) p.hr.umowaOd = d5;
      const d6 = dateCell(row, 6); if (d6) p.hr.umowaDo = d6;
      const d7 = dateCell(row, 7); if (d7) p.hr.koniecStudiow = d7;
      const d8 = dateCell(row, 8); if (d8) p.hr.zaswiadczenieDo = d8;
    }
    // людина без сум — все одно людина (умова/ставка/статус, суму ще не вписали);
    // скіпаємо лише рядки взагалі без даних (випадковий текст у колонці імен)
    const hasData = p.doWyplaty != null || p.hours != null || !!p.hr.hoursText
      || p.rateBrutto != null || p.zaliczka != null || p.extras.migawka != null
      || !!p.hr.status || !!p.hr.umowaOd || !!p.hr.umowaDo;
    if (!hasData) continue;
    out.rows.push(p);
  }
  return out.rows.length ? out : null;
}

// «WYPŁATA GOTÓWKĄ <фірма>»: вкладка = місяць MM.YYYY, рядки Imie/Nazwisko |
// Fabryka | Razem | Na konto | (Dopłata) | Na renke → фактичний розподіл.
export interface GotowkaRow { name: string; factory: string; razem: number | null; konto: number; renke: number }
export function parseGotowkaTab(rows: unknown[][]): GotowkaRow[] {
  const out: GotowkaRow[] = [];
  let c: { name: number; fab: number; razem: number; konto: number; renke: number } | null = null;
  for (const row of rows) {
    const labels = (row ?? []).map(x => norm(String(x ?? "")));
    if (labels.some(h => /NAZWISKO/.test(h)) && labels.some(h => /NA KONTO/.test(h))) {
      const idx = (re: RegExp) => labels.findIndex(h => re.test(h));
      c = { name: idx(/NAZWISKO/), fab: idx(/FABRYKA/), razem: idx(/^RAZEM$/), konto: idx(/^NA KONTO/), renke: idx(/NA RENKE|NA REKE/) };
      continue;
    }
    if (!c) continue;
    const name = cell(row, c.name);
    const fab = cell(row, c.fab);
    const konto = num(row?.[c.konto]);
    if (!name || !fab || isServiceRow(name) || konto == null) continue;
    out.push({ name, factory: fab, razem: num(row?.[c.razem]), konto, renke: num(row?.[c.renke]) ?? 0 });
  }
  return out;
}

// накладає фактичний банк/готівка-розподіл на рядки фабрики (де нема Ew.-даних)
export function overlayGotowka(tab: SvodniParsedTab, rows: GotowkaRow[]) {
  const used = new Set<number>();
  for (const g of rows) {
    const gk = key(cleanName(g.name));
    const gt = nameTokens(g.name);
    let m = tab.rows.findIndex((w, wi) => !used.has(wi) && key(cleanName(w.rawName)) === gk);
    if (m < 0) m = tab.rows.findIndex((w, wi) => {
      if (used.has(wi)) return false;
      const wt = new Set(nameTokens(w.rawName));
      return gt.filter(t => wt.has(t)).length >= 2;
    });
    if (m < 0) continue;
    used.add(m);
    const w = tab.rows[m]!;
    if (w.hoursDeclared != null && w.gotowka != null) continue; // точний Ew.-розклад сильніший
    w.konto = g.konto;
    w.ksiegNetto = g.konto;
    w.gotowka = g.renke;
    if (w.rateNetto) w.hoursDeclared = r2(g.konto / w.rateNetto);
  }
}

// ── перерахунок формул: do wypłaty з компонентів ─────────────────────────────
// Люблін/Познань: hours×rateNetto (+нічні +доплати +премії) − всі відрахування.
// Лодзь: hours×rateNetto + migawka (доплата) + premia − zaliczka − potrącenia
// − hostel − odzież − dojazd − dokumenty (dojazd — теж відрахування).
const TOL = 0.05; // заокруглення в таблицях

// Чистий розрахунок «до виплати» з компонентів рядка (формула таблиці) —
// використовується і для звірки з клітинкою, і для перерахунку після
// ручного редагування на сайті. null = бракує даних (годин/ставки).
type PayoutLike = Pick<SvodniParsedRow,
  "hours" | "rateNetto" | "premia" | "zaliczka" | "zaliczkaBd" | "hostel" | "odziez"
  | "dojazd" | "kara" | "komornik" | "kaucja" | "potracenia" | "extras">;
// baseOverride — база «год × ставка» для сегментованих рядків (Σ по сегментах
// з різними ставками); без нього база рахується з hours × rateNetto рядка.
export function computePayout(row: PayoutLike, city: "Люблін" | "Познань" | "Лодзь", baseOverride?: number | null): number | null {
  const base = baseOverride ?? (row.hours != null && row.rateNetto != null ? row.hours * row.rateNetto : null);
  if (base == null) return null;
  const ex = (k: string) => (typeof row.extras[k] === "number" ? (row.extras[k] as number) : 0);
  let ours: number;
  if (city === "Лодзь") {
    // Dojazd у лодзьких вкладках — ДОПЛАТА за доїзд (перевірено по RAZEM:
    // NOWOPAK 06.2026), на відміну від люблінського потрącення за транспорт
    ours = base + ex("migawka") + (row.premia ?? 0) + (row.dojazd ?? 0)
      - (row.zaliczka ?? 0) - (row.potracenia ?? 0) - (row.hostel ?? 0) - (row.odziez ?? 0)
      - ex("dokumenty");
  } else {
    // Premia ES — бонус за годину, ЗАВЖДИ додається до ставки нетто рядка.
    // Конвенція: ставка нетто в рядку — базова (без бонусу); базові в людей
    // різні, тож «вшитість» бонусу в ставку не детектиться — не вшивати.
    ours = base
      + ex("nocneH") * ex("doplataNocna")
      + ex("premiaEs") * (row.hours ?? 0)
      + (row.premia ?? 0) + ex("oplataKierowcy") + ex("doplataEs") + ex("zwrotKosztow")
      - (row.zaliczka ?? 0) - (row.zaliczkaBd ?? 0) - (row.hostel ?? 0) - (row.odziez ?? 0)
      - (row.dojazd ?? 0) - (row.kara ?? 0) - (row.komornik ?? 0) - (row.kaucja ?? 0)
      - (row.potracenia ?? 0) - ex("badania") - ex("kartaPobytu") - ex("karaKlient") - ex("karaEs") - ex("zadluzenie");
  }
  return r2(ours);
}

// ── Перенесення боргу (мінусова виплата) в наступний місяць ──────────────────
// Якщо відрахування з'їли більше, ніж людина заробила (doWyplaty < 0), борг
// автоматом переноситься в ту ж колонку наступного місяця (from-hours).
// «Черга знять»: реально знятим вважається з ПОЧАТКУ списку (аванси перші),
// тож недознятий залишок (|мінус|) розкладається по колонках З КІНЦЯ.
// У Лодзі dojazd — доплата (не зняття) і в черзі участі не бере.
export const DEBT_DEDUCTION_ORDER: string[] = [
  "zaliczka", "zaliczkaBd", "hostel", "dojazd", "kara", "komornik", "kaucja", "potracenia", "odziez",
  "extras.badania", "extras.kartaPobytu", "extras.karaKlient", "extras.karaEs", "extras.dokumenty", "extras.zadluzenie",
];
export function debtCarryFromRow(
  row: Pick<SvodniParsedRow, "doWyplaty" | "zaliczka" | "zaliczkaBd" | "hostel" | "odziez" | "dojazd"
    | "kara" | "komornik" | "kaucja" | "potracenia" | "extras">,
  city: string | null,
): Record<string, number> | null {
  if (row.doWyplaty == null || row.doWyplaty >= -0.005) return null;
  let shortfall = r2(-row.doWyplaty);
  const valOf = (k: string): number => {
    const v = k.startsWith("extras.") ? row.extras[k.slice(7)] : (row as any)[k];
    return typeof v === "number" && v > 0 ? v : 0;
  };
  const order = DEBT_DEDUCTION_ORDER.filter(k => !(city === "Лодзь" && k === "dojazd"));
  const carry: Record<string, number> = {};
  for (let i = order.length - 1; i >= 0 && shortfall > 0.005; i--) {
    const k = order[i]!;
    const take = Math.min(shortfall, valOf(k));
    if (take > 0) { carry[k] = r2(take); shortfall = r2(shortfall - take); }
  }
  // теоретично неможливий залишок (мінус більший за всі зняття) — чесно в аванс
  if (shortfall > 0.005) carry.zaliczka = r2((carry.zaliczka ?? 0) + shortfall);
  return Object.keys(carry).length ? carry : null;
}

// ── Сегменти всередині місяця ────────────────────────────────────────────────
// Людина з різними умовами в різні періоди місяця: база = Σ(год × ставка
// сегмента); księgowa пара декларується по НИЖЧІЙ зі ставок сегментів
// (батьківський рядок тримає min-ставки), розклад konto/готівка — місячний.
export type SegmentPart = { hours: number | null; rateNetto: number | null; rateBrutto?: number | null };
export function segmentsBase(parts: SegmentPart[]): {
  base: number | null; hours: number; minNetto: number | null; minBrutto: number | null; bruttoSum: number | null;
} {
  let base = 0, anyBase = false, hours = 0, bruttoSum = 0, anyBrutto = false;
  let minNetto: number | null = null, minBrutto: number | null = null;
  for (const p of parts) {
    if (p.hours != null) hours = r2(hours + p.hours);
    if (p.hours != null && p.rateNetto != null) { base = r2(base + p.hours * p.rateNetto); anyBase = true; }
    if (p.rateNetto != null) minNetto = minNetto == null ? p.rateNetto : Math.min(minNetto, p.rateNetto);
    if (p.rateBrutto != null) {
      minBrutto = minBrutto == null ? p.rateBrutto : Math.min(minBrutto, p.rateBrutto);
      if (p.hours != null) { bruttoSum = r2(bruttoSum + p.hours * p.rateBrutto); anyBrutto = true; }
    }
  }
  return { base: anyBase ? base : null, hours, minNetto, minBrutto, bruttoSum: anyBrutto ? bruttoSum : null };
}

// Повний розрахунок сегментованого рядка: кожен сегмент — «міні-місяць» зі
// своїми годинами/ставками/статусом → своя виплата і свій розклад konto/готівки
// за правилами СВОГО статусу. Місячні суми батька (премія, аванси, хостел,
// кари…) розкладаються пропорційно базі (год × ставка); години повідомлення
// (місячний ліміт) діляться послідовно, сегменти студентів до 26 їх не
// споживають. Батько = Σ сегментів; побажання по виплаті (payoutPref) —
// місячне: перекриває розклад konto/готівки на рівні батька.
export type SegmentCalcIn = {
  hours: number | null; rateNetto: number | null; rateBrutto: number | null;
  isStudent: boolean | null; under26: boolean | null; legal: string | null;
  /** вшитий у ставку фабричний бонус СВОГО вікна, зл/год (Agram/LST) — завжди готівкою */
  facBonus?: number | null;
};
export type SegmentCalcOut = SegmentCalcIn & {
  alloc: Record<string, number | null>;
  extras: Record<string, number>;
  hoursNotified: number | null;
  doWyplaty: number | null; brutto: number | null;
  hoursDeclared: number | null; ksiegBrutto: number | null; ksiegNetto: number | null;
  konto: number | null; gotowka: number | null;
};
export const SEG_SHARE_COLS = ["premia", "zaliczka", "zaliczkaBd", "hostel", "odziez", "dojazd", "kara", "komornik", "kaucja", "potracenia"] as const;
const SEG_RATE_EXTRAS = new Set(["premiaEs", "doplataNocna"]); // ставко-подібні — копіюються в кожен сегмент
const SEG_HOUR_EXTRAS = new Set(["nocneH"]);                   // годино-подібні — по частці годин

export function computeSegmented(
  parent: {
    city: string; factoryLabel: string; firm?: string | null; factoryId?: number | null;
    /** правило konto/готівки фабрики на місяць (не передане — legacy по id+label) */
    rule?: PayoutRule | null;
    hoursNotified: number | null;
    premia: number | null; zaliczka: number | null; zaliczkaBd: number | null; hostel: number | null;
    odziez: number | null; dojazd: number | null; kara: number | null; komornik: number | null;
    kaucja: number | null; potracenia: number | null;
    extras: Record<string, unknown>;
  },
  segs: SegmentCalcIn[],
  payoutPref: { kind: "all_konto" | "hours" | "amount"; value: number | null } | null,
): {
  segs: SegmentCalcOut[];
  parent: {
    hours: number | null; rateNetto: number | null; rateBrutto: number | null; brutto: number | null;
    doWyplaty: number | null; hoursDeclared: number | null; ksiegBrutto: number | null;
    ksiegNetto: number | null; konto: number | null; gotowka: number | null;
  };
} {
  const bases = segs.map(s => (s.hours ?? 0) * (s.rateNetto ?? 0));
  const hoursArr = segs.map(s => s.hours ?? 0);
  const baseSum = bases.reduce((a, b) => a + b, 0);
  const hoursSum = hoursArr.reduce((a, b) => a + b, 0);
  // частка сегмента: по базі; без бази — по годинах; без годин — усе останньому
  const weightArr = baseSum > 0 ? bases : hoursSum > 0 ? hoursArr : segs.map((_, i) => (i === segs.length - 1 ? 1 : 0));
  const wSum = weightArr.reduce((a, b) => a + b, 0) || 1;
  // залишок округлення — сегменту з НАЙБІЛЬШОЮ вагою (не порожньому останньому:
  // інакше нульовий сегмент ловить фантомні ±0.01)
  const remIdx = weightArr.reduce((best, x, i) => (x > weightArr[best]! ? i : best), 0);
  const allocate = (total: number): number[] => {
    const out = weightArr.map(x => r2(total * x / wSum));
    const diff = r2(total - out.reduce((a, b) => a + b, 0));
    out[remIdx] = r2(out[remIdx]! + diff);
    return out;
  };
  const isMoney = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v !== 0;
  // місячні колонки → частки
  const colAlloc = new Map<string, number[]>();
  for (const k of SEG_SHARE_COLS) {
    const v = (parent as any)[k];
    if (isMoney(v)) colAlloc.set(k, allocate(v));
  }
  // extras: ставко-подібні копіюються, годино-подібні — по годинах, грошові — по базі
  const extrasAlloc: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(parent.extras)) {
    if (k === "facBonus") continue; // вшитий бонус — свій у кожного сегмента (SegmentCalcIn), не ділиться як гроші
    if (!isMoney(v)) continue;
    if (SEG_RATE_EXTRAS.has(k)) extrasAlloc[k] = segs.map(() => v);
    else if (SEG_HOUR_EXTRAS.has(k)) {
      const hw = hoursSum > 0 ? hoursArr : weightArr;
      const hwSum = hw.reduce((a, b) => a + b, 0) || 1;
      const hwRem = hw.reduce((best, x, i) => (x > hw[best]! ? i : best), 0);
      const out = hw.map(x => r2(v * x / hwSum));
      out[hwRem] = r2(out[hwRem]! + r2(v - out.reduce((a, b) => a + b, 0)));
      extrasAlloc[k] = out;
    } else extrasAlloc[k] = allocate(v);
  }
  // Години повідомлення — місячний ліміт. Споживають лише сегменти, чий статус
  // реально відкриває konto через oświadczenie (студент до 26 — все на конто без
  // ліміту; «не зголошений»/oczekuje/без статусу — все готівкою, ліміт не палять).
  const notifyLimited = parent.hoursNotified != null && parent.hoursNotified > 0;
  let notifyLeft = parent.hoursNotified;
  // Фабрична стеля księgowych годин — теж МІСЯЧНИЙ ліміт (бракет — від сумарних
  // годин): ділиться між сегментами послідовно, студент до 26 її не споживає
  // (його гілка стелю ігнорує). Без стелі — undefined, applyLegalDefaults сам
  // зверне до правила (те все одно поверне null).
  const segRule = parent.rule !== undefined ? parent.rule : legacyPayoutRule(parent.factoryId ?? null, parent.factoryLabel);
  let capLeft = declaredCapOf(segRule, hoursSum > 0 ? hoursSum : null, parent.firm ?? null);
  const outSegs: SegmentCalcOut[] = segs.map((s, i) => {
    const legalNorm = normalizeProfileLegal(s.legal) ?? null;
    const stud26 = (s.isStudent === true || legalNorm === "student") && s.under26 === true;
    const usesNotify = !stud26 && legalNorm != null && legalNorm !== "oczekuje";
    let segNotify: number | null = null;
    if (notifyLeft != null) {
      segNotify = usesNotify ? r2(Math.min(s.hours ?? 0, Math.max(notifyLeft, 0))) : 0;
      if (usesNotify) notifyLeft = r2(notifyLeft - segNotify);
    }
    const alloc: Record<string, number | null> = {};
    for (const k of SEG_SHARE_COLS) alloc[k] = colAlloc.get(k)?.[i] ?? null;
    const extras: Record<string, number> = {};
    for (const [k, arr] of Object.entries(extrasAlloc)) extras[k] = arr[i]!;
    // вшитий бонус сегмента (свій у кожному вікні — стаж-поріг/галочки могли
    // змінитись усередині місяця) — в extras: applyLegalDefaults тримає його
    // готівкою, а recompute зберігає в рядку сегмента
    if (s.facBonus != null && s.facBonus > 0 && !stud26) extras.facBonus = s.facBonus;
    const row: any = {
      hours: s.hours, rateNetto: s.rateNetto, rateBrutto: s.rateBrutto,
      isStudent: s.isStudent, under26: s.under26, hoursNotified: segNotify,
      extras, hr: {}, sheetValues: {},
      ...alloc,
    };
    row.doWyplaty = computePayout(row, parent.city as any);
    row.brutto = s.hours != null && s.rateBrutto != null ? r2(s.hours * s.rateBrutto) : null;
    applyLegalDefaults(row, true, {
      profileLegal: s.legal as any, factoryLabel: parent.factoryLabel, payoutPref: null,
      city: parent.city, firm: parent.firm ?? null, factoryId: parent.factoryId ?? null, rule: segRule,
      // сегмент отримує залишок місячної стелі; спожите — по факту hoursDeclared
      ...(capLeft != null ? { declaredCapH: r2(Math.max(capLeft, 0)) } : {}),
    });
    if (capLeft != null && !stud26 && row.hoursDeclared != null) capLeft = r2(capLeft - row.hoursDeclared);
    // особа обмежена повідомленням, а сегменту ліміту не лишилось → konto 0
    // (інакше applyLegalDefaults трактує «0 годин» як «без oświadczenia — все на карту»)
    if (notifyLimited && usesNotify && (segNotify ?? 0) <= 0 && row.doWyplaty != null) {
      // доплата поверх doWyplaty — лише в Лодзі; у Любліні/Познані вона вже всередині
      const doplata = parent.city === "Лодзь" && typeof extras.doplataEs === "number" ? extras.doplataEs : 0;
      row.konto = 0; row.ksiegNetto = 0; row.ksiegBrutto = 0; row.hoursDeclared = 0;
      row.gotowka = r2(row.doWyplaty + doplata);
    }
    return {
      ...s, alloc, extras, hoursNotified: segNotify,
      doWyplaty: row.doWyplaty ?? null, brutto: row.brutto ?? null,
      hoursDeclared: row.hoursDeclared ?? null, ksiegBrutto: row.ksiegBrutto ?? null,
      ksiegNetto: row.ksiegNetto ?? null, konto: row.konto ?? null, gotowka: row.gotowka ?? null,
    };
  });
  // побажання по виплаті — місячне: розклад konto/готівки живе ЛИШЕ на батькові,
  // сегментні поля закритого шару обнуляються (інакше Σ сегментів ≠ батько)
  const prefActive = !!(payoutPref && (payoutPref.kind === "all_konto" || payoutPref.value != null));
  if (prefActive) {
    for (const s of outSegs) {
      s.hoursDeclared = null; s.ksiegBrutto = null; s.ksiegNetto = null; s.konto = null; s.gotowka = null;
    }
  }
  const sum = (f: (s: SegmentCalcOut) => number | null): number | null => {
    const vals = outSegs.map(f).filter((x): x is number => x != null);
    return vals.length ? r2(vals.reduce((a, b) => a + b, 0)) : null;
  };
  const min = (f: (s: SegmentCalcOut) => number | null): number | null => {
    const vals = outSegs.map(f).filter((x): x is number => x != null);
    return vals.length ? Math.min(...vals) : null;
  };
  const parentOut = {
    hours: sum(s => s.hours), rateNetto: min(s => s.rateNetto), rateBrutto: min(s => s.rateBrutto),
    brutto: sum(s => s.brutto), doWyplaty: sum(s => s.doWyplaty),
    hoursDeclared: sum(s => s.hoursDeclared), ksiegBrutto: sum(s => s.ksiegBrutto),
    ksiegNetto: sum(s => s.ksiegNetto), konto: sum(s => s.konto), gotowka: sum(s => s.gotowka),
  };
  // побажання по виплаті — місячне: перерозкладає konto/готівку на рівні батька
  if (payoutPref && (payoutPref.kind === "all_konto" || payoutPref.value != null) && parentOut.doWyplaty != null) {
    const last = outSegs[outSegs.length - 1];
    // готівкові складові місяця: Σ вшитих бонусів сегментів (точна сума — через
    // ctx.bonusTotal; в extras — середній бонус/год для księgowої ставки) + премія
    const bonusTotal = r2(outSegs.reduce((a, s) =>
      a + ((s.isStudent && s.under26) ? 0 : (s.facBonus ?? 0) * (s.hours ?? 0)), 0));
    const prowExtras: Record<string, unknown> = { ...(parent.extras as Record<string, unknown>) };
    delete prowExtras.facBonus;
    if (bonusTotal > 0 && parentOut.hours) prowExtras.facBonus = r2(bonusTotal / parentOut.hours);
    const prow: any = {
      hours: parentOut.hours, rateNetto: parentOut.rateNetto, rateBrutto: parentOut.rateBrutto,
      isStudent: last?.isStudent ?? null, under26: last?.under26 ?? null,
      hoursNotified: parent.hoursNotified, doWyplaty: parentOut.doWyplaty,
      premia: parent.premia ?? null,
      extras: prowExtras, hr: {}, sheetValues: {},
    };
    applyLegalDefaults(prow, true, {
      profileLegal: (last?.legal ?? null) as any, factoryLabel: parent.factoryLabel, payoutPref,
      city: parent.city, firm: parent.firm ?? null, factoryId: parent.factoryId ?? null, rule: segRule,
      ...(bonusTotal > 0 ? { bonusTotal } : {}),
    });
    parentOut.hoursDeclared = prow.hoursDeclared ?? null;
    parentOut.ksiegBrutto = prow.ksiegBrutto ?? null;
    parentOut.ksiegNetto = prow.ksiegNetto ?? null;
    parentOut.konto = prow.konto ?? null;
    parentOut.gotowka = prow.gotowka ?? null;
  }
  return { segs: outSegs, parent: parentOut };
}

// Розбивка місячної суми годин по вікнах між датами змін: пропорційно
// фактичним годинам явок у вікнах; якщо явок нема — порівну по календарних
// днях. Використовується для рапортних місяців (одне число без дат);
// вікна з явками масштабуються так, щоб Σ = total.
export function splitTotalByWindows(
  total: number,
  windows: { from: string; to: string; attHours: number }[],
): number[] {
  const attSum = windows.reduce((a, w) => a + w.attHours, 0);
  const daysOf = (w: { from: string; to: string }) =>
    Math.round((new Date(w.to + "T12:00:00").getTime() - new Date(w.from + "T12:00:00").getTime()) / 86400000) + 1;
  const weights = attSum > 0 ? windows.map(w => w.attHours) : windows.map(daysOf);
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  const out = windows.map((_, i) => r2(total * weights[i]! / wSum));
  // корекція округлення — останнє вікно добирає різницю до total
  const diff = r2(total - out.reduce((a, b) => a + b, 0));
  if (out.length) out[out.length - 1] = r2(out[out.length - 1]! + diff);
  return out;
}

// ── from-hours: пошук наявного рядка вкладки для пари (працівник, фабрика) ───
// Вкладка ідентифікується назвою (спадок Google-таблиці, де id не існує), але
// первинний матч наявного рядка — по factory_id: назва фабрики могла змінитися
// після створення вкладки, і матч лише по label плодив поруч другу вкладку з
// новою назвою (Scandic Food → SCANDIC FOOD, 08.2026). Оновлений рядок лишає
// свій label — вкладка не «переїжджає» за перейменуванням. multi_firm тепер
// живе на ОДНІЙ вкладці (фірма — у svodni_rows.firm), але legacy-рядки під
// старими суфіксованими назвами («… ESO» / «… EURO SUPORT») ще можливі, тож
// id-матч для multi_firm додатково приймає лише вкладку з суфіксом СВОЄЇ фірми
// (обʼєднана назва ловиться exact-матчем вище); фірма невідома — не матчимо.
// Нормалізований label — фолбек для рядків без factory_id (несматчені вкладки
// Google-синку).
export function findSvodniRowForPair<T extends { workerId: number | null; factoryId: number | null; factoryLabel: string }>(
  rows: T[],
  pair: { workerId: number; factoryId: number | null; label: string; firmSuffix: string; multiFirm: boolean },
): T | undefined {
  const norm = (s: string) => s.toLocaleUpperCase("pl-PL").replace(/[^\p{L}\p{N}]/gu, "");
  const mine = rows.filter(r => r.workerId === pair.workerId);
  const exact = mine.find(r => r.factoryLabel === pair.label);
  if (exact) return exact;
  if (pair.factoryId != null && (!pair.multiFirm || pair.firmSuffix)) {
    const suffix = pair.multiFirm ? norm(pair.firmSuffix) : "";
    const byId = mine.find(r => r.factoryId === pair.factoryId && (!suffix || norm(r.factoryLabel).endsWith(suffix)));
    if (byId) return byId;
  }
  const n = norm(pair.label);
  return n ? mine.find(r => r.factoryId == null && norm(r.factoryLabel) === n) : undefined;
}

export function computeMismatch(row: SvodniParsedRow, city: "Люблін" | "Познань" | "Лодзь"): void {
  const sheet = row.doWyplaty;
  if (sheet == null) return;
  const ours = computePayout(row, city);
  if (ours == null) return;
  row.sheetValues.doWyplaty = sheet;
  if (Math.abs(ours - sheet) > TOL) {
    row.mismatch = { ...(row.mismatch ?? {}), doWyplaty: { ours, sheet } };
  }
}
