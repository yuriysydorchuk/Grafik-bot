// Пари ZUS (зголошення ↔ виреєстрування) — завантаження ZUS-документів людини й мітки для профілю.
// Правила пар — чисте ядро lib/zusPairs.ts.
import { db, workerDocumentsTable, documentTypesTable, contractsTable, factoriesTable, contractFilesTable, documentTemplatesTable } from "@workspace/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { dateStr, warsawToday } from "./taskUtils";
import { addDaysStr } from "../lib/dates";

import { pairZusDocs, ZUS_REG_CODES, ZUS_DEREG_CODE, type ZusPairState } from "../lib/zusPairs";
export { pairZusDocs, ZUS_REG_CODES, ZUS_DEREG_CODE, type ZusPairState, type ZusDocIn } from "../lib/zusPairs";

// companyId — фірма з САМОГО документа (null = не вказана, «підходить будь-якій»); state.companyId — фірма
// групи після парування (документ без фірми приєднаний до єдиної відомої). at — коли документ внесено/змінено.
export interface ZusDocRow { id: number; code: string; companyId: number | null; date: string; at: Date; state: ZusPairState }

/** ZUS-документи людей (крім запитаних без файлу — missing) з обчисленими парами — одним запитом на всіх. */
export async function loadZusPairsMany(workerIds: number[]): Promise<Map<number, ZusDocRow[]>> {
  const out = new Map<number, ZusDocRow[]>();
  const ids = [...new Set(workerIds.filter(Boolean))];
  if (!ids.length) return out;
  const types = await db.select({ id: documentTypesTable.id, code: documentTypesTable.code }).from(documentTypesTable)
    .where(inArray(documentTypesTable.code, [...ZUS_REG_CODES, ZUS_DEREG_CODE]));
  if (!types.length) return out;
  const codeOf = new Map(types.map(t => [t.id, t.code]));
  const docs = await db.select({
    id: workerDocumentsTable.id, workerId: workerDocumentsTable.workerId, docTypeId: workerDocumentsTable.docTypeId, companyId: workerDocumentsTable.employerCompanyId,
    issuedAt: workerDocumentsTable.issuedAt, submittedAt: workerDocumentsTable.submittedAt, expiresAt: workerDocumentsTable.expiresAt,
    createdAt: workerDocumentsTable.createdAt, updatedAt: workerDocumentsTable.updatedAt,
  }).from(workerDocumentsTable).where(and(inArray(workerDocumentsTable.workerId, ids), inArray(workerDocumentsTable.docTypeId, types.map(t => t.id)), ne(workerDocumentsTable.status, "missing")));
  const byWorker = new Map<number, typeof docs>();
  for (const d of docs) byWorker.set(d.workerId, [...(byWorker.get(d.workerId) ?? []), d]);
  for (const [workerId, list] of byWorker) {
    const rows = list.map(d => {
      const code = codeOf.get(d.docTypeId!)!;
      // дата зголошення/виреєстрування: issuedAt, у легасі-документів — expiresAt; дата подання й дата
      // внесення — лише коли самої дати немає (подання буває пізнішим за дію й перевернуло б порядок пар)
      const date = dateStr(d.issuedAt) ?? dateStr(d.expiresAt) ?? dateStr(d.submittedAt) ?? dateStr(d.createdAt)!;
      return { id: d.id, code, companyId: d.companyId ?? null, date, at: d.updatedAt && d.updatedAt > d.createdAt ? d.updatedAt : d.createdAt, kind: (code === ZUS_DEREG_CODE ? "dereg" : "reg") as "reg" | "dereg" };
    });
    const states = pairZusDocs(rows);
    out.set(workerId, rows.map(r => ({ id: r.id, code: r.code, companyId: r.companyId, date: r.date, at: r.at, state: states.get(r.id)! })));
  }
  return out;
}
export async function loadZusPairs(workerId: number): Promise<ZusDocRow[]> {
  return (await loadZusPairsMany([workerId])).get(workerId) ?? [];
}

/**
 * Чинні (відкриті) зголошення: по фірмі або будь-які (companyId=null — фірма невідома / не важлива).
 * Звіряється фірма з самого документа: зголошення без фірми підходить будь-якій (як і до пар) —
 * інакше людина з ZUA «без роботодавця» отримала б зайву задачу зголошення на іншу фірму.
 */
export function openRegistrations(rows: ZusDocRow[], companyId: number | null): ZusDocRow[] {
  return rows.filter(r => r.state.kind === "reg" && r.state.status === "open" && (companyId == null || r.companyId == null || r.companyId === companyId));
}

/**
 * ZWUA саме ЦЬОГО звільнення (задача виреєстрування виконана): є виреєстрування (потрібної фірми),
 * внесене від дня звільнення або з датою не ранішою за звільнення (допуск 14 днів — дату звільнення
 * в системі могли поставити пізнішою за фактичну), і у фірми цього ZWUA не лишилось чинного зголошення
 * (старий ZWUA людини, яку взяли знову й звільнили вдруге, не рахується). Без дати звільнення (старі
 * задачі) — як раніше: будь-який ZWUA / внесений після `fallbackSince`.
 */
export function zwuaCoversFiring(rows: ZusDocRow[], o: { fireDate: string | null; companyId: number | null; fallbackSince?: Date | null }): boolean {
  const deregs = rows.filter(r => r.state.kind === "dereg" && (o.companyId == null || r.companyId == null || r.companyId === o.companyId));
  if (!deregs.length) return false;
  if (!o.fireDate) return o.fallbackSince ? deregs.some(d => d.at > o.fallbackSince!) : true;
  const since = new Date(`${o.fireDate}T00:00:00`);
  const floor = addDaysStr(o.fireDate, -14);
  return deregs.some(d => (d.at >= since || d.date >= floor) && openRegistrations(rows, d.state.companyId ?? o.companyId).length === 0);
}

/**
 * Мітки для профілю: стан пари на кожен ZUS-документ + needsDereg для відкритого зголошення —
 * людину звільнено або з цією фірмою вже немає чинної підписаної умови (а колись була).
 */
export async function zusDocLabels(workerId: number, workerActive: boolean): Promise<Map<number, ZusPairState & { needsDereg?: boolean }>> {
  const rows = await loadZusPairs(workerId);
  const out = new Map<number, ZusPairState & { needsDereg?: boolean }>();
  if (!rows.length) return out;
  const today = warsawToday();
  const contracts = await db.select({ id: contractsTable.id, dateTo: contractsTable.dateTo, companyId: sql<number | null>`coalesce(${contractsTable.companyId}, ${factoriesTable.companyId})` })
    .from(contractsTable).leftJoin(factoriesTable, eq(contractsTable.factoryId, factoriesTable.id))
    .where(and(eq(contractsTable.workerId, workerId), eq(contractsTable.status, "signed")));
  const eventIds = contracts.length ? new Set((await db.select({ contractId: contractFilesTable.contractId }).from(contractFilesTable)
    .innerJoin(documentTemplatesTable, eq(contractFilesTable.templateId, documentTemplatesTable.id))
    .where(and(inArray(contractFilesTable.contractId, contracts.map(c => c.id)), inArray(documentTemplatesTable.kind, ["swiadectwo", "zaswiadczenie", "wypowiedzenie", "wypowiedzenie_firma", "aneks", "zcna"])))).map(r => r.contractId)) : new Set<number>();
  const umowy = contracts.filter(c => !eventIds.has(c.id));
  for (const r of rows) {
    if (r.state.kind === "reg" && r.state.status === "open") {
      const co = r.state.companyId;
      const mine = umowy.filter(c => co == null || c.companyId == null || c.companyId === co);
      const live = mine.some(c => c.dateTo == null || dateStr(c.dateTo)! >= today);
      out.set(r.id, { ...r.state, needsDereg: !workerActive || (mine.length > 0 && !live) });
    } else out.set(r.id, r.state);
  }
  return out;
}
