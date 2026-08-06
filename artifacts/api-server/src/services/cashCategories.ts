// Категорії каси: кеш довідника cash_categories + авто-класифікація записів
// за текстом опису (спадок гугл-таблиці STAN KASY, де категорій не було).
// Видатки: transfer → manual_category → авто-regex → 'other'.
// Приходи: transfer → manual_category → авто-regex → 'card' для каси офісу
// (вона живиться зняттями з карти) / 'other_income' для решти ящиків.
// Ключі видатків спільні з банківськими категоріями — кешфлоу зливає по ключу.
import { db, cashCategoriesTable, type CashCategory } from "@workspace/db";
import { asc } from "drizzle-orm";

let cache: CashCategory[] | null = null;
export function invalidateCashCats() { cache = null; }
export async function getCashCats(): Promise<CashCategory[]> {
  if (!cache) cache = await db.select().from(cashCategoriesTable)
    .orderBy(asc(cashCategoriesTable.flow), asc(cashCategoriesTable.sortOrder), asc(cashCategoriesTable.id));
  return cache;
}

// Фолбек-ключі, без яких класифікація/перепризначення ламаються — не видаляються
export const PROTECTED_CASH_KEYS = new Set(["other", "other_income", "card", "deposit"]);

// ── Авто-класифікація видатків ────────────────────────────────────────────────
// Перший збіг виграє. Зарплатні розбивки — ПЕРЕД загальним salary (історичні
// описи «ЗАРПЛАТА FABRYKI LUBLIN» лягають одразу в місто; «ЗАРПЛАТА ОФІСУ» —
// офіс Люблін, бо офіс-каса історично люблінська).
const CASH_AUTO_OUT: [key: string, re: RegExp][] = [
  ["deposit",              /ВПЛАЧЕНО НА РАХУНОК|WPLAC\w* NA RACHUNEK/i],
  ["worker_refund",        /ПОВЕРНЕННЯ КОШТІВ ПРАЦІВНИК/i],
  ["salary_fab_lublin",    /ЗАРПЛАТ.*(LUBLIN|ЛЮБЛІН)/i],
  ["salary_fab_lodz",      /ЗАРПЛАТ.*(LODZ|ŁÓDŹ|ЛОДЗЬ)/i],
  ["salary_fab_poznan",    /ЗАРПЛАТ.*(POZNAN|ПОЗНАНЬ)/i],
  ["salary_office_lublin", /ЗАРПЛАТ.*ОФІС|ЗАРПЛАТ.*OFIS/i],
  ["marketing",            /DUBAI|REKRUT|TARGET|РЕКРУТ/i],
  ["salary",               /ЗАРПЛАТ|ZARPLAT|WYPLATA|ДЛЯ ПРАЦІВНИКІВ/i],
  ["zaliczki",             /ZALICZK|ЗАЛІЧК|АВАНС/i],
  ["permits",              /ДОВІДК|DOWIDK|MED DOK|DOKI|OSWIADCZEN|OŚWIADCZEN|STUD/i],
  ["services",             /ПОШТА|ЛИСТИ|POCZTA|DO.ADO.*TEL|ІНТЕРНЕТ/i],
  ["housing",              /HOSTEL|КВАРТИР|MIESZKAN|ЖИТЛО/i],
  ["travel",               /HOTEL|BILET|КВИТК|ПОЇЗДК/i],
  ["office_rent",          /PGE|СВІТЛО|PRAD|PRĄD|ОРЕНДА ОФІС/i],
  ["household",            /ZAKUPY|WYDATKI|BIUR|KANCELARI|OFFICE|ПРІНТЕР|PRINTER|ОФІСН/i],
  ["kokos_external",       /КОКОС|KOKOS/i],
  ["owner_roman",          /SHEF VZIAV|ROMA SHEF|ДЛЯ РОМАНА|DLA ROMANA/i],
  ["owner_yuriy",          /DLA YURY|ДЛЯ ЮРІЯ|DLA JURIJA/i],
  ["owner_tetiana",        /DLA TANI|ДЛЯ ТЕТЯНИ|DLA TANIA/i],
];

// ── Авто-класифікація приходів ────────────────────────────────────────────────
// karta_pobytu раніше за card: «DOCHOD Z KARTY POBYTU» містить і «Z KARTY».
const CASH_AUTO_IN: [key: string, re: RegExp][] = [
  ["karta_pobytu",   /POBYTU|ПОБИТУ/i],
  ["card",           /ЗНЯЛ|ЗНЯТ[ОА]|Z KART|BANKOMAT/i],
  ["zezwolenie",     /ZEZWOLEN|ДОЗВІЛ|ДОЗВОЛ/i],
  ["hostel_payment", /ХОСТЕЛ|HOSTEL|ПОЛУЧЕНО/i],
  ["worker_return",  /ZWROT|ПОВЕРНЕННЯ/i],
  ["from_owner",     /SHEF|PRYNIS|ВІД ВЛАСНИК/i],
];

type CatInput = { kind: string; box?: string; description: string | null; transferGroup: string | null; manualCategory: string | null };

// Видатки (kind=out) — сигнатура як була в routes/cash.ts (кешфлоу/пейрол звуть її ж)
export function cashCategory(e: CatInput): string | null {
  if (e.kind !== "out") return null;
  if (e.transferGroup) return "transfer";
  if (e.manualCategory) return e.manualCategory;
  const d = e.description ?? "";
  for (const [key, re] of CASH_AUTO_OUT) if (re.test(d)) return key;
  return "other";
}

// Приходи (kind=in): 'card' = знято з карти (єдине, що звіряється з банком)
export function cashInCategory(e: CatInput): string | null {
  if (e.kind !== "in") return null;
  if (e.transferGroup) return "transfer";
  if (e.manualCategory) return e.manualCategory;
  const d = e.description ?? "";
  for (const [key, re] of CASH_AUTO_IN) if (re.test(d)) return key;
  return e.box === "office" ? "card" : "other_income";
}

export const cashCategoryOf = (e: CatInput): string | null =>
  e.kind === "out" ? cashCategory(e) : cashInCategory(e);
