// Обгортка движка легальності над БД: зібрати вхід (працівник, документи з типами,
// чинні правила, employerSince з журналу), порахувати computeLegality(), покласти
// результат у кеш worker_legality. Тригери: події документів/профілю (фаза 2),
// нічний крон (фаза 3). Сюди ж — єдина точка масового перерахунку.
//
// Пише ЛИШЕ worker_legality. workers.* не чіпає (інваріант payroll).
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db, workersTable, workerDocumentsTable, documentTypesTable, legalRulesTable, workerLegalityTable, workerChangesTable,
} from "@workspace/db";
import { computeLegality, type LegalityInput, type LegalityResult, type LegalityDocument, type LegalRuleInput, type LegalityWorker } from "./legality";
import { logger } from "../lib/logger";

export const warsawToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const dateStr = (v: unknown): string | null => (v == null ? null : typeof v === "string" ? v.slice(0, 10) : v instanceof Date ? v.toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" }) : String(v).slice(0, 10));
const sha1 = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex");

export async function loadLegalRules(): Promise<LegalRuleInput[]> {
  const rows = await db.select().from(legalRulesTable).where(eq(legalRulesTable.isActive, true));
  return rows.map(r => ({
    code: r.code, kind: r.kind, axis: (r.axis as LegalRuleInput["axis"]) ?? null, conditions: r.conditions ?? {},
    effectiveFrom: dateStr(r.effectiveFrom), effectiveTo: dateStr(r.effectiveTo), isActive: r.isActive, verifiedAt: r.verifiedAt,
  }));
}

export async function loadWorkerDocuments(workerId: number): Promise<LegalityDocument[]> {
  const rows = await db.select({ d: workerDocumentsTable, t: documentTypesTable })
    .from(workerDocumentsTable)
    .leftJoin(documentTypesTable, eq(workerDocumentsTable.docTypeId, documentTypesTable.id))
    .where(eq(workerDocumentsTable.workerId, workerId));
  return rows.map(({ d, t }) => ({
    id: d.id, typeCode: t?.code ?? null, category: t?.category ?? "other",
    status: (d.status as LegalityDocument["status"]) ?? "present",
    hasExpiry: t?.hasExpiry ?? false, grantsStay: t?.grantsStay ?? false, grantsWork: t?.grantsWork ?? false,
    requiresEmployerMatch: t?.requiresEmployerMatch ?? false,
    validFrom: dateStr(d.validFrom), expiresAt: dateStr(d.expiresAt), renewalLeadDays: t?.renewalLeadDays ?? null,
    appliesToNationalities: t?.appliesToNationalities ?? null,
    employerCompanyId: d.employerCompanyId, caseStatus: d.caseStatus, submittedAt: dateStr(d.submittedAt),
    verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null, replacesDocumentId: d.replacesDocumentId,
  }));
}

// employerSince = max(employment_start_date, дата останнього переходу фірми в журналі)
export async function employerSinceOf(worker: { id: number; employmentStartDate: string | null }): Promise<string | null> {
  const [last] = await db.select({ effectiveDate: workerChangesTable.effectiveDate })
    .from(workerChangesTable)
    .where(and(eq(workerChangesTable.workerId, worker.id), eq(workerChangesTable.field, "companyId")))
    .orderBy(desc(workerChangesTable.effectiveDate), desc(workerChangesTable.id)).limit(1);
  const a = dateStr(worker.employmentStartDate), b = dateStr(last?.effectiveDate);
  if (a && b) return a > b ? a : b;
  return a ?? b ?? null;
}

export async function loadLegalityInput(workerId: number, today = warsawToday(), rules?: LegalRuleInput[]): Promise<LegalityInput | null> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return null;
  const worker: LegalityWorker = {
    id: w.id, nationality: w.nationality, birthDate: dateStr(w.birthDate), companyId: w.companyId,
    employmentStartDate: dateStr(w.employmentStartDate), employerSince: await employerSinceOf({ id: w.id, employmentStartDate: dateStr(w.employmentStartDate) }),
    isStudent: w.isStudent, legalStatus: w.legalStatus, notifyHours: w.notifyHours,
  };
  return { today, worker, documents: await loadWorkerDocuments(workerId), rules: rules ?? await loadLegalRules() };
}

export async function saveLegality(workerId: number, input: LegalityInput, r: LegalityResult): Promise<void> {
  const values = {
    workerId, stay: r.stay.status, work: r.work.status, overall: r.overall,
    reviewRequired: r.reviewRequired, reasons: r.reasons,
    nextExpiryAt: r.nextExpiry?.date ?? null, nextExpiryDocId: r.nextExpiry?.docId ?? null,
    requiredMissing: r.requiredMissing, obligations: r.obligations,
    derivedLegalStatus: r.legacy.derivedLegalStatus, derivedPayrollClass: r.legacy.derivedPayrollClass,
    legacyMappingRequiresReview: r.legacy.legacyMappingRequiresReview, legacyMismatchKind: r.legacy.legacyMismatchKind,
    payrollHints: r.payrollHints as unknown as Record<string, unknown>,
    inputHash: sha1({ w: input.worker, d: input.documents }), rulesHash: sha1(input.rules), computedAt: new Date(),
  };
  await db.insert(workerLegalityTable).values(values).onConflictDoUpdate({ target: workerLegalityTable.workerId, set: values });
}

export async function recomputeWorkerLegality(workerId: number, today = warsawToday(), rules?: LegalRuleInput[]): Promise<LegalityResult | null> {
  const input = await loadLegalityInput(workerId, today, rules);
  if (!input) return null;
  const result = computeLegality(input);
  await saveLegality(workerId, input, result);
  return result;
}

export async function recomputeAllActiveLegality(today = warsawToday()): Promise<{ total: number; byOverall: Record<string, number>; reviewRequired: number }> {
  const rules = await loadLegalRules();
  const ids = (await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.isActive, true))).map(r => r.id);
  const byOverall: Record<string, number> = {};
  let reviewRequired = 0;
  for (const id of ids) {
    try {
      const r = await recomputeWorkerLegality(id, today, rules);
      if (!r) continue;
      byOverall[r.overall] = (byOverall[r.overall] ?? 0) + 1;
      if (r.reviewRequired) reviewRequired++;
    } catch (e) {
      logger.warn({ err: String(e), workerId: id }, "legality recompute failed");
    }
  }
  // кеш звільнених — прибрати, щоб дашборд не показував неактивних
  const stale = await db.select({ workerId: workerLegalityTable.workerId }).from(workerLegalityTable);
  const activeSet = new Set(ids);
  const toDrop = stale.map(s => s.workerId).filter(id => !activeSet.has(id));
  if (toDrop.length) await db.delete(workerLegalityTable).where(inArray(workerLegalityTable.workerId, toDrop));
  return { total: ids.length, byOverall, reviewRequired };
}
