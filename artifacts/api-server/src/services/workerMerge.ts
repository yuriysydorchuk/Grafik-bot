// Злиття двох профілів однієї людини (дублікат): усі звʼязані записи
// переїжджають на профіль keep, порожні поля keep заповнюються з drop,
// drop видаляється. Викликається ЛИШЕ після ручного затвердження адміном
// (кнопка в боті / разовий скрипт) — автоматичних злиттів у системі немає.
import { db } from "@workspace/db";
import {
  workersTable, scheduleEntriesTable, monthlyReportsTable, svodniRowsTable,
  availabilityTable, absenceRequestsTable, advanceRequestsTable, candidatesTable,
  workerDocumentsTable, unplannedWorkersTable, hoursDisputesTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

export async function mergeWorkers(keepId: number, dropId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (keepId === dropId) return { ok: false, error: "той самий профіль" };
  const [keep] = await db.select().from(workersTable).where(eq(workersTable.id, keepId));
  const [drop] = await db.select().from(workersTable).where(eq(workersTable.id, dropId));
  if (!keep || !drop) return { ok: false, error: "профіль не знайдено" };
  // Telegram головного профілю — пріоритетний: у ЗВІЛЬНЕНОГО дубля інший Telegram
  // просто відкидається. Відмова — лише коли обидва профілі активні з різними tg.
  if (keep.telegramId && drop.telegramId && keep.telegramId !== drop.telegramId && drop.isActive) {
    return { ok: false, error: "обидва профілі активні з різними Telegram — обʼєднувати треба вручну" };
  }

  await db.transaction(async tx => {
    // порожні поля keep доповнюємо даними drop (Telegram — головне)
    const fill: Partial<typeof workersTable.$inferInsert> = {};
    if (!keep.telegramId && drop.telegramId) fill.telegramId = drop.telegramId;
    if (!keep.language && drop.language) fill.language = drop.language;
    if (!keep.birthDate && drop.birthDate) fill.birthDate = drop.birthDate;
    if (!keep.legalStatus && drop.legalStatus) fill.legalStatus = drop.legalStatus;
    if (keep.notifyHours == null && drop.notifyHours != null) fill.notifyHours = drop.notifyHours;
    if (keep.hourlyRateNetto == null && drop.hourlyRateNetto != null) fill.hourlyRateNetto = drop.hourlyRateNetto;
    if (!keep.gender && drop.gender) fill.gender = drop.gender;
    if (keep.positionId == null && drop.positionId != null) fill.positionId = drop.positionId;
    if (!keep.isActive && drop.isActive) { fill.isActive = true; fill.status = "active"; fill.firedAt = null; }
    // Telegram у drop прибираємо ПЕРШИМ — унікальність telegram_id
    if (drop.telegramId) await tx.update(workersTable).set({ telegramId: null }).where(eq(workersTable.id, dropId));
    if (Object.keys(fill).length) await tx.update(workersTable).set(fill).where(eq(workersTable.id, keepId));

    // рапорти: конфлікт (worker, month, factory) — лишаємо запис keep, дубль drop зникає
    const dropReports = await tx.select().from(monthlyReportsTable).where(eq(monthlyReportsTable.workerId, dropId));
    for (const r of dropReports) {
      const clash = await tx.select({ id: monthlyReportsTable.id }).from(monthlyReportsTable).where(and(
        eq(monthlyReportsTable.workerId, keepId), eq(monthlyReportsTable.month, r.month),
        r.factoryId != null ? eq(monthlyReportsTable.factoryId, r.factoryId) : eq(monthlyReportsTable.id, -1),
      ));
      if (clash.length) await tx.delete(monthlyReportsTable).where(eq(monthlyReportsTable.id, r.id));
      else await tx.update(monthlyReportsTable).set({ workerId: keepId }).where(eq(monthlyReportsTable.id, r.id));
    }
    // планові (scheduled) клітинки дубля, що повторюють клітинку keep того ж
    // дня і зміни — сміття з подвійного заведення, не переносимо
    await tx.execute(sql`
      DELETE FROM schedule_entries se
      WHERE se.worker_id = ${dropId} AND se.status = 'scheduled'
        AND EXISTS (
          SELECT 1 FROM schedule_entries k
          WHERE k.worker_id = ${keepId} AND k.week_id = se.week_id
            AND k.day_of_week = se.day_of_week AND k.shift = se.shift
        )`);
    await tx.update(scheduleEntriesTable).set({ workerId: keepId }).where(eq(scheduleEntriesTable.workerId, dropId));
    await tx.update(svodniRowsTable).set({ workerId: keepId }).where(eq(svodniRowsTable.workerId, dropId));
    await tx.update(availabilityTable).set({ workerId: keepId }).where(eq(availabilityTable.workerId, dropId));
    await tx.update(absenceRequestsTable).set({ workerId: keepId }).where(eq(absenceRequestsTable.workerId, dropId));
    await tx.update(absenceRequestsTable).set({ substituteWorkerId: keepId }).where(eq(absenceRequestsTable.substituteWorkerId, dropId));
    await tx.update(advanceRequestsTable).set({ workerId: keepId }).where(eq(advanceRequestsTable.workerId, dropId));
    await tx.update(candidatesTable).set({ workerId: keepId }).where(eq(candidatesTable.workerId, dropId));
    await tx.update(candidatesTable).set({ referrerWorkerId: keepId }).where(eq(candidatesTable.referrerWorkerId, dropId));
    await tx.update(hoursDisputesTable).set({ workerId: keepId }).where(eq(hoursDisputesTable.workerId, dropId));
    await tx.update(unplannedWorkersTable).set({ workerId: keepId }).where(eq(unplannedWorkersTable.workerId, dropId));
    await tx.update(unplannedWorkersTable).set({ replacesWorkerId: keepId }).where(eq(unplannedWorkersTable.replacesWorkerId, dropId));
    await tx.update(workerDocumentsTable).set({ workerId: keepId }).where(eq(workerDocumentsTable.workerId, dropId));

    await tx.delete(workersTable).where(eq(workersTable.id, dropId));
  });
  return { ok: true };
}
