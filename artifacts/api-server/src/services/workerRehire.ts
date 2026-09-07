// Повернення звільненого працівника на роботу — ЄДИНА точка активації профілю
// (веб POST /workers/:id/restore, кнопка «✅ Відновити» офіса в боті, «Відновити
// його» у модалці дубля). Старий профіль лишається (історія, №, документи,
// рапорти) — новий НЕ створюється; фабрика/посада/Telegram оновлюються за
// потреби, кожна зміна йде в журнал worker_changes (старий Telegram — «архів»
// саме там, окремої колонки немає).
import { db, workersTable, workerChangesTable } from "@workspace/db";
import type { Worker } from "@workspace/db";
import { and, eq, ne } from "drizzle-orm";
import { logger } from "../lib/logger";

const warsawToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });

export type RestoreOpts = {
  workerId: number;
  factoryId?: number | null;   // undefined = не чіпати
  positionId?: number | null;  // undefined = не чіпати
  telegramId?: string | null;  // undefined/null = не чіпати; інший tg = перепривʼязати
  adminId: number | null;      // хто відновив (журнал)
};
export type RestoreResult = { ok: true; worker: Worker } | { ok: false; error: string };

export async function restoreWorker(opts: RestoreOpts): Promise<RestoreResult> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, opts.workerId));
  if (!w) return { ok: false, error: "Працівника не знайдено" };
  if (w.isActive) return { ok: false, error: "Профіль уже активний" };

  const tg = opts.telegramId?.trim() || null;
  const tgChanged = !!tg && tg !== w.telegramId;
  // Новий Telegram уже в іншого профілю: активного — відмова (не переписуємо
  // чужу привʼязку), неактивного — знімаємо там (унікальність telegram_id).
  let tgOwner: Worker | undefined;
  if (tgChanged) {
    [tgOwner] = await db.select().from(workersTable).where(and(eq(workersTable.telegramId, tg!), ne(workersTable.id, w.id)));
    if (tgOwner?.isActive) return { ok: false, error: `Цей Telegram уже привʼязаний до активного працівника ${tgOwner.fullName}` };
  }
  const factoryChanged = opts.factoryId !== undefined && (opts.factoryId ?? null) !== (w.factoryId ?? null);
  const positionChanged = opts.positionId !== undefined && (opts.positionId ?? null) !== (w.positionId ?? null);
  const today = warsawToday();

  const restored = await db.transaction(async tx => {
    if (tgOwner) {
      await tx.update(workersTable).set({ telegramId: null }).where(eq(workersTable.id, tgOwner.id));
      await tx.insert(workerChangesTable).values({ workerId: tgOwner.id, field: "telegramId", oldValue: tg, newValue: null, effectiveDate: today, adminId: opts.adminId });
    }
    const patch: Partial<typeof workersTable.$inferInsert> = { isActive: true, status: "active", firedAt: null };
    if (factoryChanged) patch.factoryId = opts.factoryId ?? null;
    if (positionChanged) patch.positionId = opts.positionId ?? null;
    if (tgChanged) patch.telegramId = tg;
    const [row] = await tx.update(workersTable).set(patch).where(eq(workersTable.id, w.id)).returning();
    const journal: (typeof workerChangesTable.$inferInsert)[] = [
      { workerId: w.id, field: "restored", oldValue: "fired", newValue: "active", effectiveDate: today, adminId: opts.adminId },
    ];
    if (factoryChanged) journal.push({ workerId: w.id, field: "factoryId", oldValue: w.factoryId != null ? String(w.factoryId) : null, newValue: opts.factoryId != null ? String(opts.factoryId) : null, effectiveDate: today, adminId: opts.adminId });
    if (positionChanged) journal.push({ workerId: w.id, field: "positionId", oldValue: w.positionId != null ? String(w.positionId) : null, newValue: opts.positionId != null ? String(opts.positionId) : null, effectiveDate: today, adminId: opts.adminId });
    if (tgChanged) journal.push({ workerId: w.id, field: "telegramId", oldValue: w.telegramId, newValue: tg, effectiveDate: today, adminId: opts.adminId });
    await tx.insert(workerChangesTable).values(journal);
    return row!;
  });
  logger.info({ workerId: w.id, factoryChanged, positionChanged, tgChanged, adminId: opts.adminId }, "worker restored");
  return { ok: true, worker: restored };
}
