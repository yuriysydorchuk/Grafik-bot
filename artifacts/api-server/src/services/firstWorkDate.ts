// Перший робочий день (workers.first_work_date, 08.09.2026): перша явка «present» у
// ЗАТВЕРДЖЕНОМУ тижні. Ставиться сам: одразу при позначенні явки (веб PATCH статусу,
// посадка водієм) і бекфілом у нічному прогоні; лише коли поле порожнє — ручне значення
// графікової не перезаписується. Від нього рахується powiadomienie UA (7 днів) через
// employerSinceOf (legalityRecompute.ts) — фолбек employment_start_date.
import { db, workersTable, scheduleEntriesTable, scheduleWeeksTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { entryDateStr } from "../lib/dates";
import { logger } from "../lib/logger";

export async function computeFirstWorkDate(workerId: number): Promise<string | null> {
  const rows = await db.select({ day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart })
    .from(scheduleEntriesTable).innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(eq(scheduleEntriesTable.workerId, workerId), eq(scheduleEntriesTable.status, "present"), eq(scheduleWeeksTable.status, "approved")));
  let min: string | null = null;
  for (const r of rows) { const d = entryDateStr(String(r.weekStart), r.day); if (!min || d < min) min = d; }
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
