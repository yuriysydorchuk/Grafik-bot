// Чиста арифметика тижневого обліку годин (26.10.2026): тиждень — завжди цілий
// Пн–Нд, місяць — завжди цілий 1–31; дані тижня розкладаються по місяцях ПО ДАТАХ.
// Без залежностей від БД — юніт-тести у weekMath.test.ts. Дати — рядки YYYY-MM-DD,
// жодних toISOString (прод-сервер у Europe/Berlin зрізає день).
import { addDaysStr } from "./dates";

const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Понеділок тижня, що містить дату. */
export function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const dow = d.getDay(); // 0 = нд
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return fmt(d);
}

/** 7 дат тижня Пн..Нд. */
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysStr(weekStart, i));
}

/** Останній день тижня (неділя). */
export const weekEnd = (weekStart: string) => addDaysStr(weekStart, 6);

/** Межі місяця: перший день і перший день наступного (ексклюзивно). */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  return { start: `${month}-01`, end: m === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01` };
}

/** Понеділки всіх тижнів, що мають хоч один день у місяці (у порядку). */
export function weeksOverlappingMonth(month: string): string[] {
  const { start, end } = monthBounds(month);
  const out: string[] = [];
  for (let w = mondayOf(start); w < end; w = addDaysStr(w, 7)) out.push(w);
  return out;
}

/** Місяці, яких торкається тиждень (1 або 2). */
export function monthsOfWeek(weekStart: string): string[] {
  return [...new Set(weekDates(weekStart).map(d => d.slice(0, 7)))];
}

/** Місяць тижня за ISO 8601 — той, у якому лежить четвер. Для тоталу без розбивки по днях. */
export const isoMonthOfWeek = (weekStart: string) => addDaysStr(weekStart, 3).slice(0, 7);

export const roundQuarter = (h: number) => Math.round(h * 4) / 4;
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Години між двома моментами, округлення до 0.25; від'ємне/NaN → 0. */
export function hoursBetween(start: Date, end: Date): number {
  const h = (end.getTime() - start.getTime()) / 3_600_000;
  return Number.isFinite(h) && h > 0 ? roundQuarter(h) : 0;
}

export type DayHours = Record<string, number>; // "YYYY-MM-DD" → год

/**
 * Розклад годин тижня по місяцях ПО ДАТАХ. Якщо є дні з годинами — кожен місяць
 * отримує суму своїх днів; вписаний працівником/фабрикою тотал, що не збігається
 * з сумою днів, масштабує дні пропорційно (тотал — істина, дні — пропорція).
 * Без днів (лише тотал) — увесь тотал у місяць четверга (ISO), straddle=true
 * сигналізує, що тиждень на межі місяця розкладено за правилом, а не за датами.
 */
export function splitWeekByMonth(
  weekStart: string, days: DayHours | null | undefined, total: number | null | undefined,
): { byMonth: Record<string, number>; straddle: boolean } {
  const dates = new Set(weekDates(weekStart));
  const dayEntries = Object.entries(days ?? {}).filter(([d, h]) => dates.has(d) && Number.isFinite(h) && h > 0);
  const daySum = dayEntries.reduce((s, [, h]) => s + h, 0);
  const byMonth: Record<string, number> = {};
  if (daySum > 0) {
    // вписаний тотал — істина (0 = нуль, навіть якщо зміни вибрано); null/undefined = тоталу нема
    const k = total != null && Number.isFinite(total) && total >= 0 ? total / daySum : 1;
    for (const [d, h] of dayEntries) { const m = d.slice(0, 7); byMonth[m] = (byMonth[m] ?? 0) + h * k; }
    // округлення по місяцях зі збереженням суми: залишок — останньому місяцю
    const months = Object.keys(byMonth).sort();
    const want = round2(daySum * k);
    let acc = 0;
    for (const m of months) { byMonth[m] = round2(byMonth[m]!); acc += byMonth[m]!; }
    const last = months.at(-1)!;
    byMonth[last] = round2(byMonth[last]! + (want - acc));
    for (const m of months) if (byMonth[m]! <= 0) delete byMonth[m];
    return { byMonth, straddle: false };
  }
  if (total != null && Number.isFinite(total) && total > 0) {
    byMonth[isoMonthOfWeek(weekStart)] = round2(total);
    return { byMonth, straddle: monthsOfWeek(weekStart).length > 1 };
  }
  return { byMonth, straddle: false };
}

/** Сума числових значень днів (разом за день або по змінах). */
export function dayValueTotal(v: number | Record<string, number> | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  return Object.values(v).reduce((s, h) => s + (Number.isFinite(h) ? h : 0), 0);
}

/** Дні тижня з довільних значень (число або {зміна: год}) → плоскі години по датах тижня. */
export function flattenWeekDays(weekStart: string, days: Record<string, number | Record<string, number>> | null | undefined): DayHours {
  const dates = new Set(weekDates(weekStart));
  const out: DayHours = {};
  for (const [d, v] of Object.entries(days ?? {})) {
    if (!dates.has(d)) continue;
    const h = dayValueTotal(v);
    if (h > 0) out[d] = round2(h);
  }
  return out;
}

/** «26.10» */
export const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
/** «20.10–26.10» */
export const weekLabel = (weekStart: string) => `${ddmm(weekStart)}–${ddmm(weekEnd(weekStart))}`;
