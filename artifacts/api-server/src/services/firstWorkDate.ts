// Перший робочий день (workers.first_work_date, 08.09.2026): перша явка «present» у
// ЗАТВЕРДЖЕНОМУ тижні. Ставиться сам: одразу при позначенні явки (веб PATCH статусу,
// посадка водієм) і бекфілом у нічному прогоні; лише коли поле порожнє — ручне значення
// графікової не перезаписується. Від нього рахується powiadomienie UA (7 днів) через
// employerSinceOf (legalityRecompute.ts) — фолбек employment_start_date.
import { db, workersTable, scheduleEntriesTable, scheduleWeeksTable, factoryHoursTable } from "@workspace/db";
import { and, eq, inArray, isNull, isNotNull, or } from "drizzle-orm";
import { entryDateStr } from "../lib/dates";
import { warsawToday } from "./tasks";
import { logger } from "../lib/logger";

// Ланцюжок джерел (20.09.2026 — до того лише «approved»-тиждень, і 180+ активних лишались
// без дати: графік у системі з 22.06.2026, старіших тижнів немає):
//   1) явка present у затвердженому АБО розісланому (sent_at) тижні;
//   2) розіслана зміна (scheduled, sent_at), дата якої вже минула і яку не позначили absent —
//      для нових людей явку часто ніхто не відмічає (прод 20.09.2026: 28 з 62 нових без дати,
//      у всіх лише scheduled), а повідомлення UA рахується саме від першого дня;
//   3) перший день з годинами у factory_hours.days (імпорт годин фабрики / рапорт).
// employment_start_date свідомо НЕ фолбек: то фінансова дата (стаж Agram), нею вже
// користується employerSinceOf у движку легальності.
export async function computeFirstWorkDate(workerId: number, today = warsawToday()): Promise<string | null> {
  const rows = await db.select({ day: scheduleEntriesTable.dayOfWeek, status: scheduleEntriesTable.status, sentAt: scheduleEntriesTable.sentAt, weekStart: scheduleWeeksTable.weekStart, weekStatus: scheduleWeeksTable.status })
    .from(scheduleEntriesTable).innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(eq(scheduleEntriesTable.workerId, workerId), inArray(scheduleEntriesTable.status, ["present", "scheduled"]),
      or(eq(scheduleWeeksTable.status, "approved"), isNotNull(scheduleEntriesTable.sentAt))));
  let min: string | null = null;
  for (const r of rows) {
    const d = entryDateStr(String(r.weekStart), r.day);
    if (r.status === "scheduled" && (d >= today || !r.sentAt)) continue; // майбутня або нерозіслана зміна — ще не факт
    if (!min || d < min) min = d;
  }
  const hours = await db.select({ days: factoryHoursTable.days, month: factoryHoursTable.month }).from(factoryHoursTable).where(eq(factoryHoursTable.workerId, workerId));
  for (const h of hours) {
    // значення дня: число (разом) АБО {№зміни: год} — позмінна евіденція (docs/API_ROUTES «години з фабрики»)
    const days = (h.days ?? {}) as Record<string, number | Record<string, number>>;
    for (const [d, v] of Object.entries(days)) {
      const hours = typeof v === "object" && v ? Object.values(v).reduce((s, x) => s + (Number(x) || 0), 0) : Number(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !(hours > 0)) continue;
      if (!min || d < min) min = d;
    }
  }
  return min;
}

// Заповнити, якщо порожнє. Повертає дату, якщо саме зараз поставили.
export async function ensureFirstWorkDate(workerId: number): Promise<string | null> {
  const [w] = await db.select({ firstWorkDate: workersTable.firstWorkDate }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!w || w.firstWorkDate) return null;
  const d = await computeFirstWorkDate(workerId);
  if (!d) return null;
  await db.update(workersTable).set({ firstWorkDate: d }).where(and(eq(workersTable.id, workerId), isNull(workersTable.firstWorkDate)));
  import("./documentEvents").then(m => m.workerLegalityChanged(workerId)).catch(() => {});
  logger.info({ workerId, firstWorkDate: d }, "first work date set");
  return d;
}

// Нічний бекфіл: усі активні без дати (дешево — по одному запиту на людину без дати).
export async function backfillFirstWorkDates(): Promise<number> {
  const ws = await db.select({ id: workersTable.id }).from(workersTable).where(and(eq(workersTable.isActive, true), isNull(workersTable.firstWorkDate)));
  let n = 0;
  for (const w of ws) { try { if (await ensureFirstWorkDate(w.id)) n++; } catch (e) { logger.warn({ err: String(e), workerId: w.id }, "first work date backfill failed"); } }
  return n;
}
