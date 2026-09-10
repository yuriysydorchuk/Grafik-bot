// Звільнення працівника — ЄДИНА точка (веб POST /workers/:id/fire, бот «🔥 Звільнити
// працівника», крон виповідзення). Дзеркало workerRehire.ts (відновлення).
// Що робить: is_active=false/status=fired/fired_at, знімає termination_date, журнал
// worker_changes (field=fired, effective_date = дата звільнення), закриває чинні умови
// датою звільнення (date_to), прибирає НЕРОЗІСЛАНІ записи графіку після дати (розіслані
// й явки не чіпає — сводна позначає години після fired_at як «не оформлений»), запускає
// шаблони задач «при звільненні» і ланцюжок звільнення (документ → затвердження → ZUS).
// Виповідзення: workers.termination_date (запланована дата звільнення) — крон 00:10
// fireDueTerminations() звільняє всіх, у кого дата настала.
import { db, workersTable, workerChangesTable, contractsTable, scheduleEntriesTable, scheduleWeeksTable } from "@workspace/db";
import type { Worker } from "@workspace/db";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
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
    .set({ isActive: false, status: "fired", firedAt, terminationDate: null })
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

// Виповідзення: запланована дата звільнення. Пишеться з профілю (гейт editData), журнал —
// field=terminationDate. Дата може бути й сьогоднішньою/минулою — тоді крон (або виклик
// одразу нижче) звільняє негайно.
export async function setTerminationDate(workerId: number, date: string | null, adminId: number | null): Promise<{ ok: true; worker: Worker; firedNow: boolean } | { ok: false; error: string }> {
  if (date != null && !isDate(date)) return { ok: false, error: "Дата звільнення — формат YYYY-MM-DD" };
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return { ok: false, error: "Працівника не знайдено" };
  if (!w.isActive) return { ok: false, error: "Профіль неактивний — дата звільнення вже не потрібна" };
  const prev = w.terminationDate ? String(w.terminationDate) : null;
  if (prev === date) return { ok: true, worker: w, firedNow: false };
  const [row] = await db.update(workersTable).set({ terminationDate: date }).where(eq(workersTable.id, workerId)).returning();
  await db.insert(workerChangesTable).values({ workerId, field: "terminationDate", oldValue: prev, newValue: date, effectiveDate: warsawToday(), adminId }).catch(() => {});
  if (date && date <= warsawToday()) {
    const r = await fireWorker({ workerId, date, adminId, source: "web" });
    if (r.ok) return { ok: true, worker: r.worker, firedNow: true };
  }
  return { ok: true, worker: row!, firedNow: false };
}

// Крон 00:10: усі активні з termination_date ≤ сьогодні — звільнити цією датою.
export async function fireDueTerminations(today = warsawToday()): Promise<number> {
  const due = await db.select({ id: workersTable.id, date: workersTable.terminationDate }).from(workersTable)
    .where(and(eq(workersTable.isActive, true), lte(workersTable.terminationDate, today)));
  let n = 0;
  for (const w of due) {
    const r = await fireWorker({ workerId: w.id, date: String(w.date), adminId: null, source: "cron" });
    if (r.ok) n++; else logger.warn({ workerId: w.id, error: r.error }, "termination cron: fire failed");
  }
  return n;
}
