// Виповідзення на умові (29.10.2026, рішення власника): дія в модулі умов — кнопка «Виповідзення» у рядку
// підписаної umowy. Ставить на умові останній робочий день та ініціатора (типово працівник, можна фірму),
// одразу генерує wypowiedzenie цієї умови на підпис (від працівника — без печатки, підписує працівник; від
// фірми — з печаткою, працівник підписує отримання) і, якщо це остання жива умова на фабриці, виставляє
// профільне виповідзення (workers.termination_* → крон 00:10 закриває фабрику/звільняє як раніше).
// Якщо на фабриці є інші живі умови (друга фірма на Sushi), у дату закривається лише ця умова
// (applyDueContractTerminations, перед fireDueTerminations у кроні); коли після цього живих умов
// на фабриці не лишилось — endWorkerAtFactory.
import { db, contractsTable, workersTable, workerChangesTable, tasksTable } from "@workspace/db";
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { warsawToday, dateStr, OPEN_STATUSES } from "./tasks";
import { issueEventDocId, eventContractIds, WYPOW_KIND, WYPOW_FIRMA_KIND } from "./contractEndDocs";
import { setTerminationDate, endWorkerAtFactory } from "./workerFire";
import { logger } from "../lib/logger";

export type TerminationBy = "worker" | "company";
const LIVE = ["signed", "worker_signed"];
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const DATA_TERMINATED_BY_CONTRACT = "_terminatedByContract"; // маркер на умові, закритій виповідзенням на умові

/** Інші живі umowy людини на тій самій фабриці (крім цієї), що діють на дату. */
async function otherLiveOnFactory(c: typeof contractsTable.$inferSelect, date: string): Promise<number[]> {
  const rows = await db.select({ id: contractsTable.id }).from(contractsTable).where(and(
    eq(contractsTable.workerId, c.workerId), eq(contractsTable.factoryId, c.factoryId!), ne(contractsTable.id, c.id),
    inArray(contractsTable.status, LIVE), or(isNull(contractsTable.dateTo), gt(contractsTable.dateTo, date)),
  ));
  const events = await eventContractIds(rows.map(r => r.id));
  return rows.map(r => r.id).filter(id => !events.has(id));
}

export async function setContractTermination(contractId: number, input: { date: string; by: TerminationBy }, adminId: number | null) {
  if (!isDate(input.date)) throw new Error("Дата — формат YYYY-MM-DD");
  const by: TerminationBy = input.by === "company" ? "company" : "worker";
  const [c] = await db.select().from(contractsTable).where(eq(contractsTable.id, contractId));
  if (!c) throw new Error("Умову не знайдено");
  if (c.factoryId == null) throw new Error("Виповідзення — лише для умови на фабрику (не сталий пакет)");
  if (!LIVE.includes(c.status)) throw new Error(`Виповідзення можна поставити лише на підписану умову (поточний статус: ${c.status})`);
  if ((await eventContractIds([c.id])).has(c.id)) throw new Error("Це подієвий документ, а не умова");
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, c.workerId));
  if (!w?.isActive) throw new Error("Працівник уже звільнений");
  const from = dateStr(c.dateFrom), to = dateStr(c.dateTo);
  if (from && input.date < from) throw new Error(`Дата раніше початку умови (${from})`);
  if (to && input.date > to) throw new Error(`Умова й так закінчується ${to} — виповідзення має бути не пізніше`);

  const prev = c.terminationDate ? `${dateStr(c.terminationDate)} (${c.terminationBy ?? "worker"})` : null;
  await db.update(contractsTable).set({ terminationDate: input.date, terminationBy: by, terminationSetAt: new Date(), terminationSetBy: adminId, updatedAt: new Date() })
    .where(eq(contractsTable.id, c.id));
  await db.insert(workerChangesTable).values({ workerId: c.workerId, field: "contractTermination", oldValue: prev, newValue: `${input.date} (${by}) #${c.id}`, effectiveDate: warsawToday(), adminId }).catch(() => {});

  // wypowiedzenie одразу на підпис (той самий механізм, що при звільненні; dedup — ключ задачі `<kind>:<contractId>`)
  let docId: number | null = c.terminationDocId ?? null;
  if (docId == null) {
    const kind = by === "company" ? WYPOW_FIRMA_KIND : WYPOW_KIND;
    docId = await issueEventDocId({
      kind, contract: c, worker: { id: w.id, fullName: w.fullName }, dateTo: input.date, stamp: by === "company", actorAdminId: adminId,
      title: by === "company" ? `Wypowiedzenie umowy zlecenia (від фірми) — надіслати на підпис: ${w.fullName}` : `Wypowiedzenie umowy zlecenia (від працівника) — надіслати на підпис: ${w.fullName}`,
      checklistFirst: by === "company" ? "Переглянути wypowiedzenie (PDF у задачі; печатка фірми вже стоїть, працівник підписує отримання)" : "Переглянути wypowiedzenie (PDF у задачі; підписує працівник)",
    });
    if (docId != null) await db.update(contractsTable).set({ terminationDocId: docId }).where(eq(contractsTable.id, c.id));
  }

  // остання жива умова на фабриці → профільне виповідзення по фабриці (крон/негайно — як раніше)
  const others = await otherLiveOnFactory(c, input.date);
  let firedNow = false, factoryLevel = false;
  if (!others.length) {
    const r = await setTerminationDate(c.workerId, input.date, adminId, c.factoryId);
    if (!r.ok) logger.warn({ contractId: c.id, error: r.error }, "contract termination: worker-level termination not set");
    else { factoryLevel = true; firedNow = r.firedNow; }
  } else if (input.date <= warsawToday()) {
    await closeContractByTermination(c.id, input.date);
  }
  return { ok: true as const, docId, factoryLevel, firedNow, othersOnFactory: others.length };
}

export async function clearContractTermination(contractId: number, adminId: number | null) {
  const [c] = await db.select().from(contractsTable).where(eq(contractsTable.id, contractId));
  if (!c) throw new Error("Умову не знайдено");
  if (!c.terminationDate) return { ok: true as const };
  const date = dateStr(c.terminationDate)!;
  await db.update(contractsTable).set({ terminationDate: null, terminationBy: null, terminationDocId: null, terminationSetAt: null, terminationSetBy: null, updatedAt: new Date() }).where(eq(contractsTable.id, c.id));
  await db.insert(workerChangesTable).values({ workerId: c.workerId, field: "contractTermination", oldValue: `${date} (${c.terminationBy ?? "worker"}) #${c.id}`, newValue: null, effectiveDate: warsawToday(), adminId }).catch(() => {});
  // непідписаний пакет wypowiedzenia — скасувати разом із задачею
  if (c.terminationDocId != null) {
    const [d] = await db.select({ status: contractsTable.status }).from(contractsTable).where(eq(contractsTable.id, c.terminationDocId));
    if (d && !["signed", "cancelled", "superseded", "declined", "expired"].includes(d.status)) {
      await db.update(contractsTable).set({ status: "cancelled", updatedAt: new Date() }).where(eq(contractsTable.id, c.terminationDocId));
      await db.update(tasksTable).set({ status: "cancelled", completedAt: new Date(), resolutionNote: "виповідзення скасовано", updatedAt: new Date() })
        .where(and(eq(tasksTable.contractId, c.terminationDocId), inArray(tasksTable.status, OPEN_STATUSES)));
    }
  }
  // профільне виповідзення, що походило з цієї умови (та сама фабрика й дата) — зняти
  const [w] = await db.select({ td: workersTable.terminationDate, tf: workersTable.terminationFactoryId }).from(workersTable).where(eq(workersTable.id, c.workerId));
  if (w?.td && dateStr(w.td) === date && w.tf === c.factoryId) {
    const [sibling] = await db.select({ id: contractsTable.id }).from(contractsTable).where(and(eq(contractsTable.workerId, c.workerId), eq(contractsTable.factoryId, c.factoryId!), eq(contractsTable.terminationDate, date), ne(contractsTable.id, c.id))).limit(1);
    if (!sibling) await setTerminationDate(c.workerId, null, adminId, null);
  }
  return { ok: true as const };
}

/** Закрити умову датою виповідзення (без звільнення з фабрики). */
async function closeContractByTermination(contractId: number, date: string): Promise<void> {
  await db.update(contractsTable).set({
    dateTo: date, updatedAt: new Date(),
    data: sql`coalesce(${contractsTable.data}, '{}'::jsonb) || ${JSON.stringify({ [DATA_TERMINATED_BY_CONTRACT]: date, _endedAtFactory: date })}::jsonb`,
  }).where(and(eq(contractsTable.id, contractId), or(isNull(contractsTable.dateTo), gt(contractsTable.dateTo, date))));
}

/**
 * Крон 00:10 (перед fireDueTerminations): умови з termination_date ≤ сьогодні, ще не закриті цією датою —
 * закрити; якщо після цього на фабриці не лишилось живих умов, а профільного виповідзення по ній нема —
 * endWorkerAtFactory (звільнення з фабрики / повне, якщо остання).
 */
export async function applyDueContractTerminations(today = warsawToday()): Promise<number> {
  const due = await db.select().from(contractsTable).where(and(
    sql`${contractsTable.terminationDate} <= ${today}::date`, inArray(contractsTable.status, LIVE),
    or(isNull(contractsTable.dateTo), gt(contractsTable.dateTo, contractsTable.terminationDate)),
  ));
  let n = 0;
  for (const c of due) {
    const date = dateStr(c.terminationDate)!;
    const [w] = await db.select({ isActive: workersTable.isActive, td: workersTable.terminationDate, tf: workersTable.terminationFactoryId }).from(workersTable).where(eq(workersTable.id, c.workerId));
    if (!w?.isActive) continue;
    // профільне виповідзення по цій фабриці на цю дату — його виконає fireDueTerminations (закриє умови сам)
    if (w.td && dateStr(w.td)! <= today && (w.tf == null || w.tf === c.factoryId)) continue;
    await closeContractByTermination(c.id, date);
    n++;
    const others = c.factoryId != null ? await otherLiveOnFactory(c, date) : [1];
    if (!others.length && c.factoryId != null) {
      const r = await endWorkerAtFactory({ workerId: c.workerId, factoryId: c.factoryId, date, adminId: null, source: "cron" });
      if (!r.ok) logger.warn({ contractId: c.id, error: r.error }, "contract termination cron: factory end failed");
    }
  }
  return n;
}
