// Звільнення працівника — ЄДИНА точка (веб POST /workers/:id/fire, бот «🔥 Звільнити
// працівника», крон виповідзення). Дзеркало workerRehire.ts (відновлення).
// Що робить: is_active=false/status=fired/fired_at, знімає termination_date, журнал
// worker_changes (field=fired, effective_date = дата звільнення), закриває чинні умови
// датою звільнення (date_to), прибирає НЕРОЗІСЛАНІ записи графіку після дати (розіслані
// й явки не чіпає — сводна позначає години після fired_at як «не оформлений»), запускає
// шаблони задач «при звільненні» і ланцюжок звільнення (документ → затвердження → ZUS).
// Виповідзення: workers.termination_date (запланована дата звільнення) — крон 00:10
// fireDueTerminations() звільняє всіх, у кого дата настала. З 11.09.2026 виповідзення може
// бути ПО ФАБРИЦІ (workers.termination_factory_id): людина йде з однієї фабрики/фірми, а на
// решті лишається активною — endWorkerAtFactory() нижче (умови/графік/документи лише цієї фабрики).
import { db, workersTable, workerChangesTable, contractsTable, scheduleEntriesTable, scheduleWeeksTable, workerFactoriesTable, factoriesTable } from "@workspace/db";
import type { Worker } from "@workspace/db";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { entryDateStr } from "../lib/dates";
import { logger } from "../lib/logger";

const warsawToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export type FireOpts = {
  workerId: number;
  date?: string | null;          // YYYY-MM-DD, дозволено минулим числом; без дати — сьогодні
  adminId: number | null;        // хто звільнив (журнал); null = крон
  source: "web" | "bot" | "cron" | "hours";
};
export type FireResult = { ok: true; worker: Worker; removedEntries: number; closedContracts: number } | { ok: false; error: string };

export async function fireWorker(opts: FireOpts): Promise<FireResult> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, opts.workerId));
  if (!w) return { ok: false, error: "Працівника не знайдено" };
  if (!w.isActive) return { ok: false, error: "Профіль уже неактивний" };
  const fireDate = isDate(opts.date) ? opts.date : warsawToday();
  const firedAt = new Date(`${fireDate}T12:00:00`);

  const [fired] = await db.update(workersTable)
    .set({ isActive: false, status: "fired", firedAt, terminationDate: null, terminationFactoryId: null })
    .where(eq(workersTable.id, w.id)).returning();
  await db.insert(workerChangesTable).values({
    workerId: w.id, field: "fired", oldValue: "active", newValue: "fired", effectiveDate: fireDate, adminId: opts.adminId,
  }).catch(err => logger.error({ err }, "worker change journal failed"));

  // чинні умови закриваються датою звільнення (date_to порожнє або пізніше за дату) — саме вони
  // «раніше кінця» → wypowiedzenie від працівника (terminationFlow → contractEndDocs)
  const closed = await db.update(contractsTable)
    .set({ dateTo: fireDate, updatedAt: new Date() })
    .where(and(eq(contractsTable.workerId, w.id), eq(contractsTable.status, "signed"), or(isNull(contractsTable.dateTo), gt(contractsTable.dateTo, fireDate))))
    .returning({ id: contractsTable.id });

  // нерозіслані записи графіку після дати звільнення — геть (розіслані/явки лишаються)
  const future = await db.select({ id: scheduleEntriesTable.id, day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart })
    .from(scheduleEntriesTable).innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(eq(scheduleEntriesTable.workerId, w.id), eq(scheduleEntriesTable.status, "scheduled"), isNull(scheduleEntriesTable.sentAt), sql`${scheduleWeeksTable.weekStart} >= ${fireDate}::date - interval '6 days'`));
  const toRemove = future.filter(e => entryDateStr(String(e.weekStart), e.day) > fireDate).map(e => e.id);
  if (toRemove.length) await db.delete(scheduleEntriesTable).where(inArray(scheduleEntriesTable.id, toRemove));

  // шаблони «при звільненні» + ланцюжок звільнення (best-effort, не блокує відповідь)
  import("./tasks").then(m => m.workerTrigger("worker_fired", fired!)).catch(() => {});
  import("./terminationFlow").then(m => m.startTerminationFlow(fired!, fireDate, opts.adminId, closed.map(c => c.id))).catch(err => logger.warn({ err: String(err), workerId: w.id }, "termination flow failed"));
  logger.info({ workerId: w.id, fireDate, source: opts.source, adminId: opts.adminId, removedEntries: toRemove.length, closedContracts: closed.length }, "worker fired");
  return { ok: true, worker: fired!, removedEntries: toRemove.length, closedContracts: closed.length };
}

// Фабрики, де людина працює станом на дату: основна (workers.factory_id) + додаткові
// (worker_factories без valid_to або з valid_to після дати; ще не почата теж рахується).
export type LiveFactory = { factoryId: number; primary: boolean; rowId: number | null; companyId: number | null; validFrom: string | null; validTo: string | null };
export async function liveFactoriesOf(w: Pick<Worker, "id" | "factoryId">, date: string): Promise<LiveFactory[]> {
  const out: LiveFactory[] = [];
  if (w.factoryId != null) out.push({ factoryId: w.factoryId, primary: true, rowId: null, companyId: null, validFrom: null, validTo: null });
  const rows = await db.select({ id: workerFactoriesTable.id, factoryId: workerFactoriesTable.factoryId, companyId: workerFactoriesTable.companyId, validFrom: workerFactoriesTable.validFrom, validTo: workerFactoriesTable.validTo })
    .from(workerFactoriesTable).where(eq(workerFactoriesTable.workerId, w.id)).orderBy(asc(workerFactoriesTable.validFrom), asc(workerFactoriesTable.id));
  for (const r of rows) {
    if (r.validTo && String(r.validTo) <= date) continue;
    if (out.some(x => x.factoryId === r.factoryId)) continue;
    out.push({ factoryId: r.factoryId, primary: false, rowId: r.id, companyId: r.companyId, validFrom: r.validFrom ? String(r.validFrom) : null, validTo: r.validTo ? String(r.validTo) : null });
  }
  return out;
}

export type FactoryEndOpts = { workerId: number; factoryId: number; date?: string | null; adminId: number | null; source: FireOpts["source"] };
export type FactoryEndResult =
  | { ok: true; worker: Worker; firedWhole: boolean; removedEntries: number; closedContracts: number; promotedFactoryId: number | null }
  | { ok: false; error: string };

// Закінчення роботи на ОДНІЙ фабриці (виповідзення по фабриці). Якщо це єдина фабрика людини —
// звичайне звільнення (fireWorker). Інакше: умови цієї фабрики закриваються датою (+ маркер
// _endedAtFactory, щоб правило contract_end не просило «звільнити або аннекс»), нерозісланий
// графік цієї фабрики після дати — геть, додаткова фабрика дістає valid_to, а якщо йде з
// ОСНОВНОЇ — основною стає перша чинна додаткова (журнал factoryId). Документи (zaświadczenie +
// wypowiedzenie) і ZUS ZWUA (лише якщо не лишається умови з тією ж фірмою) — terminationFlow.
export async function endWorkerAtFactory(opts: FactoryEndOpts): Promise<FactoryEndResult> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, opts.workerId));
  if (!w) return { ok: false, error: "Працівника не знайдено" };
  if (!w.isActive) return { ok: false, error: "Профіль уже неактивний" };
  const endDate = isDate(opts.date) ? opts.date : warsawToday();
  const live = await liveFactoriesOf(w, endDate);
  const me = live.find(f => f.factoryId === opts.factoryId);
  if (!me) return { ok: false, error: "Працівник не працює на цій фабриці" };
  const others = live.filter(f => f.factoryId !== opts.factoryId);
  if (!others.length) {
    const r = await fireWorker({ workerId: w.id, date: endDate, adminId: opts.adminId, source: opts.source });
    return r.ok ? { ok: true, worker: r.worker, firedWhole: true, removedEntries: r.removedEntries, closedContracts: r.closedContracts, promotedFactoryId: null } : r;
  }

  // умови ЦІЄЇ фабрики: відкриті/довші за дату → закрити датою (це «раніше кінця» → wypowiedzenie);
  // маркер на всіх підписаних умовах фабрики — кінець вирішено, contract_end мовчить
  const closed = await db.update(contractsTable)
    .set({ dateTo: endDate, updatedAt: new Date() })
    .where(and(eq(contractsTable.workerId, w.id), eq(contractsTable.factoryId, opts.factoryId), eq(contractsTable.status, "signed"), or(isNull(contractsTable.dateTo), gt(contractsTable.dateTo, endDate))))
    .returning({ id: contractsTable.id });
  await db.update(contractsTable)
    .set({ data: sql`${contractsTable.data} || ${JSON.stringify({ _endedAtFactory: endDate })}::jsonb` })
    .where(and(eq(contractsTable.workerId, w.id), eq(contractsTable.factoryId, opts.factoryId), eq(contractsTable.status, "signed")));

  // нерозіслані записи графіку цієї фабрики після дати
  const future = await db.select({ id: scheduleEntriesTable.id, day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart })
    .from(scheduleEntriesTable).innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(eq(scheduleEntriesTable.workerId, w.id), eq(scheduleEntriesTable.factoryId, opts.factoryId), eq(scheduleEntriesTable.status, "scheduled"), isNull(scheduleEntriesTable.sentAt), sql`${scheduleWeeksTable.weekStart} >= ${endDate}::date - interval '6 days'`));
  const toRemove = future.filter(e => entryDateStr(String(e.weekStart), e.day) > endDate).map(e => e.id);
  if (toRemove.length) await db.delete(scheduleEntriesTable).where(inArray(scheduleEntriesTable.id, toRemove));

  // привʼязка до фабрики
  let promotedFactoryId: number | null = null;
  const patch: Partial<typeof workersTable.$inferInsert> = {};
  if (w.terminationFactoryId === opts.factoryId) { patch.terminationDate = null; patch.terminationFactoryId = null; }
  if (me.primary) {
    // основною стає перша чинна додаткова: уже почата — пріоритет, серед них — без дати «до», далі за valid_from/id
    const started = others.filter(f => !f.validFrom || f.validFrom <= endDate);
    const next = started.find(f => !f.validTo) ?? started[0] ?? others.find(f => !f.validTo) ?? others[0]!;
    const [nf] = await db.select({ companyId: factoriesTable.companyId }).from(factoriesTable).where(eq(factoriesTable.id, next.factoryId));
    patch.factoryId = next.factoryId;
    patch.companyId = next.companyId ?? nf?.companyId ?? null;
    if (next.rowId != null) await db.delete(workerFactoriesTable).where(eq(workerFactoriesTable.id, next.rowId));
    // у додаткової був строк «до» — в основної такого поля нема, тож він стає запланованим виповідзенням
    // по цій фабриці (якщо слот вільний або звільнився щойно)
    const slotFree = patch.terminationFactoryId === null || (w.terminationDate == null && w.terminationFactoryId == null);
    if (next.validTo && slotFree) { patch.terminationDate = next.validTo; patch.terminationFactoryId = next.factoryId; }
    else if (next.validTo) logger.warn({ workerId: w.id, factoryId: next.factoryId, validTo: next.validTo }, "promoted factory had valid_to but termination slot is taken");
    promotedFactoryId = next.factoryId;
    await db.insert(workerChangesTable).values({ workerId: w.id, field: "factoryId", oldValue: String(opts.factoryId), newValue: String(next.factoryId), effectiveDate: endDate, adminId: opts.adminId }).catch(() => {});
  } else if (me.rowId != null) {
    // ще не почата додаткова — прибрати; чинна — закрити датою (легальність/календар читають valid_to)
    if (me.validFrom && me.validFrom > endDate) await db.delete(workerFactoriesTable).where(eq(workerFactoriesTable.id, me.rowId));
    else await db.update(workerFactoriesTable).set({ validTo: endDate }).where(eq(workerFactoriesTable.id, me.rowId));
  }
  const [updated] = Object.keys(patch).length
    ? await db.update(workersTable).set(patch).where(eq(workersTable.id, w.id)).returning()
    : [w];
  await db.insert(workerChangesTable).values({ workerId: w.id, field: "factoryEnded", oldValue: String(opts.factoryId), newValue: endDate, effectiveDate: endDate, adminId: opts.adminId }).catch(err => logger.error({ err }, "worker change journal failed"));

  import("./documentEvents").then(m => m.workerLegalityChanged(w.id)).catch(() => {});
  import("./terminationFlow").then(m => m.startFactoryEndFlow(updated!, opts.factoryId, endDate, opts.adminId, closed.map(c => c.id))).catch(err => logger.warn({ err: String(err), workerId: w.id }, "factory end flow failed"));
  logger.info({ workerId: w.id, factoryId: opts.factoryId, endDate, source: opts.source, adminId: opts.adminId, removedEntries: toRemove.length, closedContracts: closed.length, promotedFactoryId }, "worker ended at factory");
  return { ok: true, worker: updated!, firedWhole: false, removedEntries: toRemove.length, closedContracts: closed.length, promotedFactoryId };
}

// Виповідзення: запланована дата звільнення. Пишеться з профілю (гейт editData), журнал —
// field=terminationDate (значення «дата» або «дата @фабрика»). Дата може бути й сьогоднішньою/
// минулою — тоді крон (або виклик одразу нижче) звільняє негайно. factoryId: лише з цієї
// фабрики (endWorkerAtFactory), null = з усіх (fireWorker).
export async function setTerminationDate(workerId: number, date: string | null, adminId: number | null, factoryId: number | null = null): Promise<{ ok: true; worker: Worker; firedNow: boolean } | { ok: false; error: string }> {
  if (date != null && !isDate(date)) return { ok: false, error: "Дата звільнення — формат YYYY-MM-DD" };
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return { ok: false, error: "Працівника не знайдено" };
  if (!w.isActive) return { ok: false, error: "Профіль неактивний — дата звільнення вже не потрібна" };
  if (date == null) factoryId = null;
  if (factoryId != null && !(await liveFactoriesOf(w, date!)).some(f => f.factoryId === factoryId)) return { ok: false, error: "Працівник не працює на цій фабриці" };
  const fmt = (d: string | null, f: number | null) => d == null ? null : f == null ? d : `${d} @${f}`;
  const prev = fmt(w.terminationDate ? String(w.terminationDate) : null, w.terminationFactoryId ?? null);
  const next = fmt(date, factoryId);
  if (prev === next) return { ok: true, worker: w, firedNow: false };
  const [row] = await db.update(workersTable).set({ terminationDate: date, terminationFactoryId: factoryId }).where(eq(workersTable.id, workerId)).returning();
  await db.insert(workerChangesTable).values({ workerId, field: "terminationDate", oldValue: prev, newValue: next, effectiveDate: warsawToday(), adminId }).catch(() => {});
  if (date && date <= warsawToday()) {
    const r = factoryId != null
      ? await endWorkerAtFactory({ workerId, factoryId, date, adminId, source: "web" })
      : await fireWorker({ workerId, date, adminId, source: "web" });
    if (r.ok) return { ok: true, worker: r.worker, firedNow: true };
  }
  return { ok: true, worker: row!, firedNow: false };
}

// Крон 00:10: усі активні з termination_date ≤ сьогодні — звільнити цією датою
// (з усіх фабрик або лише з termination_factory_id).
export async function fireDueTerminations(today = warsawToday()): Promise<number> {
  const due = await db.select({ id: workersTable.id, date: workersTable.terminationDate, factoryId: workersTable.terminationFactoryId }).from(workersTable)
    .where(and(eq(workersTable.isActive, true), lte(workersTable.terminationDate, today)));
  let n = 0;
  for (const w of due) {
    const r = w.factoryId != null
      ? await endWorkerAtFactory({ workerId: w.id, factoryId: w.factoryId, date: String(w.date), adminId: null, source: "cron" })
      : await fireWorker({ workerId: w.id, date: String(w.date), adminId: null, source: "cron" });
    if (r.ok) n++; else logger.warn({ workerId: w.id, factoryId: w.factoryId, error: r.error }, "termination cron: fire failed");
  }
  return n;
}
