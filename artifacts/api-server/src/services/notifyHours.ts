// Години в powiadomieniu ПО ФАБРИЦІ (рішення власника 15.10.2026). Єдине місце, де
// резолвиться «скільки годин у повідомленні має людина на фабриці» — ліміт konto-годин
// рядка сводної цієї фабрики (applyLegalDefaults: на konto min(повідомлені, відпрацьовані)).
//
// Джерела, за пріоритетом для пари людина×фабрика:
//   1) рядок worker_notify_hours (manual — вписано вручну; powiadomienie — з документа);
//   2) workers.notify_hours — старе спільне значення «для всіх фабрик» (вважається ручним).
// Повідомлення (робот praca.gov або ручна форма документа) пише рядок фабрики, ЛИШЕ якщо
// для неї нема ручного значення (ні свого рядка manual, ні спільного) — applyNotificationHours.
// Самі години у формі повідомлення беруться з налаштувань фабрики (factories.ua_notify_hours).
import { db, workerNotifyHoursTable, workersTable, workerChangesTable, workerFactoriesTable, factoriesTable } from "@workspace/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

export type NotifyEntry = { hours: number; source: "manual" | "powiadomienie"; documentId: number | null; updatedAt: Date };
/** factoryId → години людини на цій фабриці */
export type NotifyByFactory = Map<number, NotifyEntry>;

/** Рядки «людина × фабрика» (усі, або для заданих людей): workerId → (factoryId → запис). */
export async function loadNotifyHours(workerIds?: Iterable<number>): Promise<Map<number, NotifyByFactory>> {
  const ids = workerIds ? [...new Set(workerIds)] : null;
  if (ids && !ids.length) return new Map();
  const rows = await db.select().from(workerNotifyHoursTable)
    .where(ids ? inArray(workerNotifyHoursTable.workerId, ids) : undefined);
  const out = new Map<number, NotifyByFactory>();
  for (const r of rows) {
    const m = out.get(r.workerId) ?? out.set(r.workerId, new Map()).get(r.workerId)!;
    m.set(r.factoryId, { hours: r.hours, source: r.source === "powiadomienie" ? "powiadomienie" : "manual", documentId: r.documentId, updatedAt: r.updatedAt });
  }
  return out;
}

/** Години для рядка сводної (людина × фабрика): свій рядок фабрики → спільне workers.notify_hours. */
export function resolveNotifyHours(legacy: number | null | undefined, byFactory: NotifyByFactory | undefined, factoryId: number | null | undefined): number | null {
  if (factoryId != null && byFactory?.has(factoryId)) return byFactory.get(factoryId)!.hours;
  return legacy ?? null;
}

/** Сума по фабриках (підказки легальності «години без документа / відпрацьовано більше»):
 *  є рядки по фабриках — їх сума, інакше спільне значення. */
export function totalNotifyHours(legacy: number | null | undefined, byFactory: NotifyByFactory | undefined): number | null {
  if (byFactory?.size) return [...byFactory.values()].reduce((a, e) => a + e.hours, 0);
  return legacy ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
// Серіалізація записів годин однієї людини: автоматика (повідомлення) читає «чи нема ручного»
// і пише під тим самим локом, що й ручні правки — ручне, вписане паралельно, не перезапишеться.
const lockWorker = (tx: Tx, workerId: number) => tx.execute(sql`select pg_advisory_xact_lock(7292, ${workerId})`);

async function writeNotify(tx: Tx, workerId: number, factoryId: number, hours: number | null,
  opts: { source: "manual" | "powiadomienie"; documentId?: number | null; adminId?: number | null }): Promise<void> {
  if (hours == null) {
    await tx.delete(workerNotifyHoursTable).where(and(eq(workerNotifyHoursTable.workerId, workerId), eq(workerNotifyHoursTable.factoryId, factoryId)));
    return;
  }
  const set = { hours, source: opts.source, documentId: opts.documentId ?? null, updatedBy: opts.adminId ?? null, updatedAt: new Date() };
  await tx.insert(workerNotifyHoursTable).values({ workerId, factoryId, ...set })
    .onConflictDoUpdate({ target: [workerNotifyHoursTable.workerId, workerNotifyHoursTable.factoryId], set });
}

/** Записати години людини на фабриці; null = прибрати рядок (назад до спільного значення). */
export async function setFactoryNotifyHours(
  workerId: number, factoryId: number, hours: number | null,
  opts: { source: "manual" | "powiadomienie"; documentId?: number | null; adminId?: number | null },
): Promise<void> {
  await db.transaction(async tx => { await lockWorker(tx, workerId); await writeNotify(tx, workerId, factoryId, hours, opts); });
}

/** Фабрика документа Powiadomienie: attrs.factoryId (робот) → назва attrs.factory серед фабрик
 *  людини (без регістру) → єдина фабрика людини. Не вдалось — null (години не застосовуються). */
export async function notifyFactoryOfDocument(workerId: number, attrs: Record<string, unknown> | null | undefined): Promise<number | null> {
  const fid = Number(attrs?.factoryId);
  if (Number.isInteger(fid) && fid > 0) return fid;
  const [w] = await db.select({ factoryId: workersTable.factoryId }).from(workersTable).where(eq(workersTable.id, workerId));
  const extra = await db.select({ factoryId: workerFactoriesTable.factoryId }).from(workerFactoriesTable)
    .where(and(eq(workerFactoriesTable.workerId, workerId), sql`(${workerFactoriesTable.validTo} is null or ${workerFactoriesTable.validTo} >= current_date)`));
  const mine = [...new Set([w?.factoryId, ...extra.map(e => e.factoryId)].filter((x): x is number => x != null))];
  const name = String(attrs?.factory ?? "").trim().toLowerCase();
  if (name) {
    // назву вказано — лише точний збіг серед фабрик людини; інакше не вгадуємо (документ про іншу фабрику)
    const facs = mine.length ? await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable).where(inArray(factoriesTable.id, mine)) : [];
    const hit = facs.filter(f => f.name.trim().toLowerCase() === name);
    return hit.length === 1 ? hit[0]!.id : null;
  }
  return mine.length === 1 ? mine[0]! : null;
}

/** Години з повідомлення → профіль (рядок фабрики), якщо для фабрики нема ручного значення.
 *  Пише журнал профілю (adminId NULL = автоматично) і застосовує зміну до НЕЗАЛОЧЕНИХ рядків
 *  сводної цієї фабрики від місяця дати; залочені — у ревʼю при розлоку (як інші зміни профілю). */
export async function applyNotificationHours(args: {
  workerId: number; factoryId: number | null; hours: number | null | undefined; documentId: number | null; effectiveDate: string;
}): Promise<{ applied: boolean; reason?: string }> {
  const { workerId, factoryId, documentId, effectiveDate } = args;
  const hours = args.hours != null && Number.isFinite(Number(args.hours)) && Number(args.hours) > 0 ? Number(args.hours) : null;
  if (!hours) return { applied: false, reason: "no-hours" };
  if (factoryId == null) { logger.info({ workerId, documentId }, "notify hours: factory of powiadomienie unknown — skipped"); return { applied: false, reason: "no-factory" }; }
  // перевірка «нема ручного» + запис + журнал — атомарно під локом людини
  const r = await db.transaction(async tx => {
    await lockWorker(tx, workerId);
    const [w] = await tx.select({ notifyHours: workersTable.notifyHours }).from(workersTable).where(eq(workersTable.id, workerId));
    if (!w) return { reason: "no-worker" } as const;
    const [cur] = await tx.select().from(workerNotifyHoursTable)
      .where(and(eq(workerNotifyHoursTable.workerId, workerId), eq(workerNotifyHoursTable.factoryId, factoryId)));
    if (cur?.source === "manual") return { reason: "manual" } as const;
    if (!cur && w.notifyHours != null) return { reason: "manual-shared" } as const;
    if (cur && cur.hours === hours) {
      if (cur.documentId !== documentId) await writeNotify(tx, workerId, factoryId, hours, { source: "powiadomienie", documentId });
      return { reason: "same" } as const;
    }
    await writeNotify(tx, workerId, factoryId, hours, { source: "powiadomienie", documentId });
    const [entry] = await tx.insert(workerChangesTable).values({
      workerId, field: "notifyHours", factoryId,
      oldValue: cur ? String(cur.hours) : null, newValue: String(hours),
      effectiveDate, adminId: null,
    }).returning({ id: workerChangesTable.id });
    return { entryId: entry!.id } as const;
  });
  if ("reason" in r && r.reason !== "same") return { applied: false, reason: r.reason };
  // сводна: свіжий запис, або (повтор із тими самими годинами) незастосований — якщо минулого разу впало
  const entryId = "entryId" in r ? r.entryId : (await db.select({ id: workerChangesTable.id }).from(workerChangesTable)
    .where(and(eq(workerChangesTable.workerId, workerId), eq(workerChangesTable.field, "notifyHours"), eq(workerChangesTable.factoryId, factoryId),
      isNull(workerChangesTable.appliedRows), isNull(workerChangesTable.reviewDismissedAt)))
    .orderBy(desc(workerChangesTable.id)).limit(1))[0]?.id;
  if (entryId != null) {
    try {
      const { autoApplyNotifyChange } = await import("../routes/svodni");
      await autoApplyNotifyChange(entryId);
    } catch (e) { logger.warn({ err: String(e), workerId, factoryId }, "notify hours: svodni auto-apply failed"); }
  }
  return "entryId" in r ? { applied: true } : { applied: false, reason: "same" };
}

/** Документ Powiadomienie більше не про цю фабрику (виправили фабрику в документі): години, що прийшли
 *  САМЕ з цього документа, з фабрики знімаються (назад до спільного); ручні не чіпаються. */
export async function revokeNotificationHours(args: { workerId: number; factoryId: number; documentId: number; effectiveDate: string }): Promise<boolean> {
  const { workerId, factoryId, documentId, effectiveDate } = args;
  const entryId = await db.transaction(async tx => {
    await lockWorker(tx, workerId);
    const [cur] = await tx.select().from(workerNotifyHoursTable)
      .where(and(eq(workerNotifyHoursTable.workerId, workerId), eq(workerNotifyHoursTable.factoryId, factoryId)));
    if (!cur || cur.source !== "powiadomienie" || cur.documentId !== documentId) return null;
    await writeNotify(tx, workerId, factoryId, null, { source: "powiadomienie" });
    const [entry] = await tx.insert(workerChangesTable).values({
      workerId, field: "notifyHours", factoryId, oldValue: String(cur.hours), newValue: null, effectiveDate, adminId: null,
    }).returning({ id: workerChangesTable.id });
    return entry!.id;
  });
  if (entryId == null) return false;
  try {
    const { autoApplyNotifyChange } = await import("../routes/svodni");
    await autoApplyNotifyChange(entryId);
  } catch (e) { logger.warn({ err: String(e), workerId, factoryId }, "notify hours revoke: svodni auto-apply failed"); }
  return true;
}
