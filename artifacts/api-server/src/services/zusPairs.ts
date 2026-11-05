// Пари ZUS (зголошення ↔ виреєстрування) — завантаження ZUS-документів людини й мітки для профілю.
// Правила пар — чисте ядро lib/zusPairs.ts.
import { db, workerDocumentsTable, documentTypesTable, contractsTable, factoriesTable, contractFilesTable, documentTemplatesTable } from "@workspace/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { dateStr, warsawToday } from "./taskUtils";

import { pairZusDocs, ZUS_REG_CODES, ZUS_DEREG_CODE, type ZusPairState } from "../lib/zusPairs";
export { pairZusDocs, ZUS_REG_CODES, ZUS_DEREG_CODE, type ZusPairState, type ZusDocIn } from "../lib/zusPairs";

export interface ZusDocRow { id: number; code: string; companyId: number | null; date: string; state: ZusPairState }

/** ZUS-документи людини (крім запитаних без файлу — missing) з обчисленими парами. */
export async function loadZusPairs(workerId: number): Promise<ZusDocRow[]> {
  const types = await db.select({ id: documentTypesTable.id, code: documentTypesTable.code }).from(documentTypesTable)
    .where(inArray(documentTypesTable.code, [...ZUS_REG_CODES, ZUS_DEREG_CODE]));
  if (!types.length) return [];
  const codeOf = new Map(types.map(t => [t.id, t.code]));
  const docs = await db.select({
    id: workerDocumentsTable.id, docTypeId: workerDocumentsTable.docTypeId, companyId: workerDocumentsTable.employerCompanyId,
    issuedAt: workerDocumentsTable.issuedAt, submittedAt: workerDocumentsTable.submittedAt, expiresAt: workerDocumentsTable.expiresAt, createdAt: workerDocumentsTable.createdAt,
  }).from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, workerId), inArray(workerDocumentsTable.docTypeId, types.map(t => t.id)), ne(workerDocumentsTable.status, "missing")));
  const rows = docs.map(d => {
    const code = codeOf.get(d.docTypeId!)!;
    // дата зголошення/виреєстрування живе в issuedAt (легасі — expiresAt); без неї — дата внесення
    const date = dateStr(d.issuedAt) ?? dateStr(d.submittedAt) ?? dateStr(d.expiresAt) ?? dateStr(d.createdAt)!;
    return { id: d.id, code, companyId: d.companyId ?? null, date, kind: (code === ZUS_DEREG_CODE ? "dereg" : "reg") as "reg" | "dereg" };
  });
  const states = pairZusDocs(rows);
  return rows.map(r => ({ id: r.id, code: r.code, companyId: r.companyId, date: r.date, state: states.get(r.id)! }));
}

/** Чинні (відкриті) зголошення: по фірмі або будь-які (companyId=null — фірма невідома / не важлива). */
export function openRegistrations(rows: ZusDocRow[], companyId: number | null): ZusDocRow[] {
  return rows.filter(r => r.state.kind === "reg" && r.state.status === "open" && (companyId == null || r.state.companyId == null || r.state.companyId === companyId));
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
