// Разові зміни фабрики (factory_shift_overrides): час start/end для конкретної
// дати+№ зміни. Дозволяють «додати/змінити зміну на один день» поза стандартним
// налаштуванням фабрики — усі поверхні часу зміни (пуші, водійський борд, /live,
// Excel, бот) мусять питати override перед factoryShifts().
import { db, factoryShiftOverridesTable } from "@workspace/db";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { entryDateStr, addDaysStr } from "../lib/dates";

export type ShiftTime = { start: string; end: string };
// key: `${factoryId}|${YYYY-MM-DD}|${shift}`
export type ShiftOverrideMap = Map<string, ShiftTime>;

export const shiftOverrideKey = (factoryId: number, date: string, shift: string | number) =>
  `${factoryId}|${date}|${shift}`;

// Усі override-и тижня (Пн..Нд), опційно однієї фабрики.
export async function loadWeekShiftOverrides(weekStart: string, factoryId?: number): Promise<ShiftOverrideMap> {
  const conds = [gte(factoryShiftOverridesTable.date, weekStart), lte(factoryShiftOverridesTable.date, addDaysStr(weekStart, 6))];
  if (factoryId != null) conds.push(eq(factoryShiftOverridesTable.factoryId, factoryId));
  const rows = await db.select().from(factoryShiftOverridesTable).where(and(...conds));
  return new Map(rows.map(r => [shiftOverrideKey(r.factoryId, String(r.date), r.shift), { start: r.start, end: r.end }]));
}

// Override-и одного календарного дня (для кронів, що працюють «сьогодні»).
export async function loadDateShiftOverrides(date: string): Promise<ShiftOverrideMap> {
  return loadDatesShiftOverrides([date]);
}

// Override-и кількох конкретних дат (посадка «сьогодні + вчора» тощо).
export async function loadDatesShiftOverrides(dates: string[]): Promise<ShiftOverrideMap> {
  if (!dates.length) return new Map();
  const rows = await db.select().from(factoryShiftOverridesTable).where(inArray(factoryShiftOverridesTable.date, dates));
  return new Map(rows.map(r => [shiftOverrideKey(r.factoryId, String(r.date), r.shift), { start: r.start, end: r.end }]));
}

// Override для клітинки тижневого графіку (weekStart + day → дата).
export function overrideFor(
  ov: ShiftOverrideMap, factoryId: number, weekStart: string, day: string, shift: string | number,
): ShiftTime | undefined {
  return ov.get(shiftOverrideKey(factoryId, entryDateStr(weekStart, day), shift));
}

// Тривалість зміни в годинах (нічні через північ — як factoryShiftHours).
export function shiftDurationHours(start: string, end: string): number {
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  let diff = toMin(end) - toMin(start);
  if (diff <= 0) diff += 24 * 60;
  return Math.round((diff / 60) * 100) / 100;
}
