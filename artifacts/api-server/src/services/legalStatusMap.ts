// Мапа «група виплат ↔ старий статус легалізації ↔ типи документів» — єдине
// джерело для legacy-адаптера движка (legality.ts deriveLegacy) і для вкладки
// Налаштування → Правила легальності → «Мапа статусів» (рішення власника
// 04.09.2026: одна мапа, за якою виплати рахуються з документів, якщо вони є,
// інакше зі старого блоку). Чиста константа без БД; кожен запис — доведена
// існуючим payroll-кодом відповідність (regex у services/svodni.ts
// legalStatusOf / normalizeProfileLegal), не юридична інтерпретація.
//
// Групи виплат (з applyLegalDefaults/computeSegmented): A_cash — усе готівкою
// (oczekuje); B_student — податковий клас студента (student); C_registered —
// «оформлений», 6 статусів у грошах невідмінні; N_none — статусу немає.
import type { LegacyStatus, PayrollClass } from "./legality";

export interface PayrollGroupInfo { code: PayrollClass; label: string; money: string }
// Уточнення власника 04.09.2026: «без статусу» = «не зголошений» (група A), окремої групи немає.
export const PAYROLL_GROUPS: PayrollGroupInfo[] = [
  { code: "C_registered", label: "Оформлений", money: "konto за правилами фабрики, готівка лише за правилом/бонусом" },
  { code: "B_student", label: "Студент", money: "довідка студента/учня (будь-яка форма) + вік до 26 → усе на konto, без ZUS" },
  { code: "A_cash", label: "Не зголошений", money: "усе готівкою, без ZUS; сюди ж — без статусу і без документів" },
];

export interface LegacyStatusInfo {
  status: LegacyStatus;
  group: PayrollClass;
  // порядок вибору, коли документи дають кілька статусів однієї групи C (менше = сильніше):
  // безстрокові/сильніші підстави вище, щоб відображуваний статус не «стрибав» при появі слабшого документа
  precedence: number;
  // статус ніколи не виводиться з документів (лише ручний прапорець/рішення офісу)
  manualOnly: boolean;
  note: string;
}
export const LEGACY_STATUS_MAP: LegacyStatusInfo[] = [
  { status: "polak", group: "C_registered", precedence: 1, manualOnly: false, note: "громадянство PL з профілю (правило stay.pl_citizen), документ не потрібен" },
  { status: "staly_pobyt", group: "C_registered", precedence: 2, manualOnly: false, note: "karta stałego pobytu" },
  { status: "karta_pobytu", group: "C_registered", precedence: 3, manualOnly: false, note: "TRC (з dostępem do rynku pracy) або zezwolenie jednolite на нашу фірму" },
  { status: "zus", group: "C_registered", precedence: 4, manualOnly: false, note: "zezwolenie na pracę typ A на нашу фірму" },
  { status: "dyplom", group: "C_registered", precedence: 5, manualOnly: false, note: "dyplom studiów stacjonarnych w PL" },
  { status: "powiadomienie", group: "C_registered", precedence: 6, manualOnly: false, note: "powiadomienie UA або oświadczenie на нашу фірму" },
  // Студент — сильніший за всі C-підстави (уточнення власника 04.09.2026: довідка студента
  // або учня будь-якої форми + вік до 26 → усе на konto). Право на працю без zezwolenia
  // дає лише стаціонар — це окрема вісь (work), не група виплат.
  { status: "student", group: "B_student", precedence: 0, manualOnly: false, note: "довідка студента/учня (будь-яка форма навчання) + вік до 26 за датою народження; без дати народження — потребує перевірки" },
  { status: "oczekuje", group: "A_cash", precedence: 99, manualOnly: false, note: "справа в toku без права на працю, або немає ані статусу, ані документів, ані умов" },
];

export interface DocTypeStatusInfo {
  typeCode: string;
  status: LegacyStatus | null;     // null = групу знаємо, статусу-відповідника в старому блоці немає → потребує перевірки
  group: PayrollClass;
  review: boolean;                 // пропозиція завжди з «потребує перевірки»
  requiresEmployerMatch: boolean;  // рахується лише якщо employer_company_id = фірма працівника
  condition: string | null;        // додаткова умова (attrs)
}
export const DOC_TYPE_STATUS_MAP: DocTypeStatusInfo[] = [
  { typeCode: "karta_stalego_pobytu", status: "staly_pobyt", group: "C_registered", review: false, requiresEmployerMatch: false, condition: null },
  { typeCode: "rezydent_ue", status: null, group: "C_registered", review: true, requiresEmployerMatch: false, condition: "у старому блоці відповідника немає" },
  { typeCode: "trc", status: "karta_pobytu", group: "C_registered", review: false, requiresEmployerMatch: false, condition: "право на працю лише з «dostęp do rynku pracy»" },
  { typeCode: "zezwolenie_jednolite", status: "karta_pobytu", group: "C_registered", review: false, requiresEmployerMatch: true, condition: null },
  { typeCode: "diploma", status: "dyplom", group: "C_registered", review: false, requiresEmployerMatch: false, condition: null },
  { typeCode: "powiadomienie_ua", status: "powiadomienie", group: "C_registered", review: false, requiresEmployerMatch: true, condition: "лише громадяни UA" },
  { typeCode: "oswiadczenie", status: "powiadomienie", group: "C_registered", review: false, requiresEmployerMatch: true, condition: null },
  { typeCode: "zezwolenie_a", status: "zus", group: "C_registered", review: false, requiresEmployerMatch: true, condition: null },
  { typeCode: "student_cert", status: "student", group: "B_student", review: false, requiresEmployerMatch: false, condition: "будь-яка форма навчання + вік до 26; після 26 довідка на виплати не впливає" },
  { typeCode: "karta_polaka", status: null, group: "C_registered", review: true, requiresEmployerMatch: false, condition: "право на працю є, статусу-відповідника немає" },
  { typeCode: "humanitarian_visa", status: null, group: "C_registered", review: true, requiresEmployerMatch: false, condition: "гуманітарні підстави — відповідника немає" },
  { typeCode: "refugee_status", status: null, group: "C_registered", review: true, requiresEmployerMatch: false, condition: "гуманітарні підстави — відповідника немає" },
  { typeCode: "subsidiary_protection", status: null, group: "C_registered", review: true, requiresEmployerMatch: false, condition: "гуманітарні підстави — відповідника немає" },
  { typeCode: "humanitarian_stay", status: null, group: "C_registered", review: true, requiresEmployerMatch: false, condition: "гуманітарні підстави — відповідника немає" },
  { typeCode: "tolerated_stay", status: null, group: "C_registered", review: true, requiresEmployerMatch: false, condition: "гуманітарні підстави — відповідника немає" },
  { typeCode: "eu_family_member_card", status: null, group: "C_registered", review: true, requiresEmployerMatch: false, condition: "відповідника немає" },
  { typeCode: "status_ukr", status: null, group: "C_registered", review: true, requiresEmployerMatch: false, condition: "лише побут; праця — з powiadomieniem" },
  { typeCode: "stay_case_certificate", status: "oczekuje", group: "A_cash", review: true, requiresEmployerMatch: false, condition: "справа в toku без попереднього права на працю" },
];

export const docTypeStatus = (typeCode: string): DocTypeStatusInfo | undefined => DOC_TYPE_STATUS_MAP.find(m => m.typeCode === typeCode);
export const legacyStatusInfo = (status: LegacyStatus): LegacyStatusInfo => LEGACY_STATUS_MAP.find(m => m.status === status)!;
export const precedenceOf = (status: LegacyStatus | null): number => status ? legacyStatusInfo(status).precedence : 999;
