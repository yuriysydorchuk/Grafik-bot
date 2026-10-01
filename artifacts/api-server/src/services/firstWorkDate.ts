// Перший робочий день (workers.first_work_date, 08.09.2026): перша явка «present» у
// ЗАТВЕРДЖЕНОМУ тижні. Ставиться сам: одразу при позначенні явки (веб PATCH статусу,
// посадка водієм) і бекфілом у нічному прогоні; лише коли поле порожнє — ручне значення
// графікової не перезаписується. Від нього рахується powiadomienie UA (7 днів) через
// employerSinceOf (legalityRecompute.ts) — фолбек employment_start_date.
import { db, workersTable, scheduleEntriesTable, scheduleWeeksTable, factoryHoursTable, workerFactoriesTable } from "@workspace/db";
import { and, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
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

// Перший робочий день ПО ФАБРИКАХ (єдине джерело для календаря працівників і профілю,
// 02.10.2026): перша фактична зміна на фабриці (present, або розіслана минула scheduled
// без absent; лише затверджені/розіслані тижні) ∪ перший день з годинами фабрики
// (factory_hours.days) ∪ worker_factories.valid_from; основна фабрика без жодної явки —
// workers.first_work_date. Повертає Map "<workerId>:<factoryId>" → YYYY-MM-DD.
export async function firstWorkDatesByFactory(workerIds: number[], today = warsawToday()): Promise<Map<string, string>> {
  const first = new Map<string, string>();
  if (!workerIds.length) return first;
  const ids = sql.join(workerIds.map(i => sql`${i}`), sql`, `);
  const dayOff = sql`(case e.day_of_week when 'mon' then 0 when 'tue' then 1 when 'wed' then 2 when 'thu' then 3 when 'fri' then 4 when 'sat' then 5 else 6 end)`;
  const firstShift = await db.execute(sql`
    select e.worker_id, e.factory_id, min(k.week_start + ${dayOff})::text as d
    from schedule_entries e join schedule_weeks k on k.id = e.week_id
    where e.worker_id in (${ids})
      and (k.status = 'approved' or e.sent_at is not null)
      and (e.status = 'present' or (e.status = 'scheduled' and e.sent_at is not null and k.week_start + ${dayOff} < ${today}::date))
    group by e.worker_id, e.factory_id`);
  const firstHours = await db.execute(sql`
    select h.worker_id, h.factory_id, min(d.key) as d
    from factory_hours h, jsonb_each(coalesce(h.days, '{}'::jsonb)) d
    where h.worker_id in (${ids}) and d.key ~ '^\\d{4}-\\d{2}-\\d{2}$'
    group by h.worker_id, h.factory_id`);
  const take = (wid: number, fid: number | null, d: string | null) => {
    if (fid == null || !d) return;
    const v = String(d).slice(0, 10); const k = `${wid}:${fid}`; const cur = first.get(k);
    if (!cur || v < cur) first.set(k, v);
  };
  for (const r of firstShift.rows as { worker_id: number; factory_id: number | null; d: string | null }[]) take(r.worker_id, r.factory_id, r.d);
  for (const r of firstHours.rows as { worker_id: number; factory_id: number | null; d: string | null }[]) take(r.worker_id, r.factory_id, r.d);
  const wf = await db.select({ workerId: workerFactoriesTable.workerId, factoryId: workerFactoriesTable.factoryId, validFrom: workerFactoriesTable.validFrom })
    .from(workerFactoriesTable).where(inArray(workerFactoriesTable.workerId, workerIds));
  for (const r of wf) if (r.validFrom) take(r.workerId, r.factoryId, String(r.validFrom));
  const ws = await db.select({ id: workersTable.id, factoryId: workersTable.factoryId, firstWorkDate: workersTable.firstWorkDate })
    .from(workersTable).where(inArray(workersTable.id, workerIds));
  for (const w of ws) if (w.factoryId != null && w.firstWorkDate && !first.has(`${w.id}:${w.factoryId}`)) first.set(`${w.id}:${w.factoryId}`, String(w.firstWorkDate).slice(0, 10));
  return first;
}
