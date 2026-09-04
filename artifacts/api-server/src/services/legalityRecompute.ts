// Обгортка движка легальності над БД: зібрати вхід (працівник, документи з типами,
// чинні правила, employerSince з журналу), порахувати computeLegality(), покласти
// результат у кеш worker_legality. Тригери: події документів/профілю (фаза 2),
// нічний крон (фаза 3). Сюди ж — єдина точка масового перерахунку.
//
// Пише ЛИШЕ worker_legality. workers.* не чіпає (інваріант payroll).
import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db, workersTable, workerDocumentsTable, documentTypesTable, legalRulesTable, workerLegalityTable, workerChangesTable, workerQuestionnairesTable,
  contractsTable, contractFilesTable, documentTemplatesTable, workerFactoriesTable, positionsTable, factoriesTable, scheduleEntriesTable, scheduleWeeksTable,
} from "@workspace/db";
import {
  computeLegality, type LegalityInput, type LegalityResult, type LegalityDocument, type LegalRuleInput, type LegalityWorker,
  type LegalityContract, type LegalityFactory,
} from "./legality";
import { mrzNationalityToCatalog } from "./docai";
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
    hasExpiry: t?.hasExpiry ?? false, grantsStay: t?.grantsStay ?? false,
    // Атрибути документа перекривають прапорець типу: TRC «z dostępem do rynku pracy» дає й працю;
    // zaświadczenie студента дає право на працю ЛИШЕ для стаціонару університету (attrs.studyMode='stationary') —
    // заочне/школа/policealna дають тільки студентську ставку (payroll), не work-basis (рішення власника 03.09.2026)
    grantsWork: t?.code === "student_cert"
      ? (d.attrs as Record<string, unknown> | null)?.studyMode === "stationary"
      : (t?.grantsWork ?? false) || (t?.code === "trc" && (d.attrs as Record<string, unknown> | null)?.laborMarketAccess === true),
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

// Умови працівника для осі «умова»: hasUmowa — у пакеті є файл із шаблону виду umowa
// (сталий пакет ZUS/PPK/BHP без umowy умовою не є — важливо для офісного пакета без фабрики).
export async function loadWorkerContracts(workerId: number): Promise<LegalityContract[]> {
  const rows = await db.select({ id: contractsTable.id, factoryId: contractsTable.factoryId, status: contractsTable.status, dateFrom: contractsTable.dateFrom, dateTo: contractsTable.dateTo })
    .from(contractsTable).where(eq(contractsTable.workerId, workerId));
  if (!rows.length) return [];
  const umowa = await db.select({ contractId: contractFilesTable.contractId })
    .from(contractFilesTable).innerJoin(documentTemplatesTable, eq(contractFilesTable.templateId, documentTemplatesTable.id))
    .where(and(inArray(contractFilesTable.contractId, rows.map(r => r.id)), inArray(documentTemplatesTable.kind, ["umowa", "sprzatanie_umowa"])));
  const withUmowa = new Set(umowa.map(u => u.contractId));
  return rows.map(r => ({ id: r.id, factoryId: r.factoryId, status: r.status, dateFrom: dateStr(r.dateFrom), dateTo: dateStr(r.dateTo), hasUmowa: withUmowa.has(r.id) }));
}

export async function loadWorkerFactories(workerId: number): Promise<LegalityFactory[]> {
  const rows = await db.select({ factoryId: workerFactoriesTable.factoryId, name: factoriesTable.name, validFrom: workerFactoriesTable.validFrom, validTo: workerFactoriesTable.validTo })
    .from(workerFactoriesTable).leftJoin(factoriesTable, eq(workerFactoriesTable.factoryId, factoriesTable.id))
    .where(eq(workerFactoriesTable.workerId, workerId));
  return rows.map(r => ({ factoryId: r.factoryId, name: r.name, validFrom: dateStr(r.validFrom), validTo: dateStr(r.validTo) }));
}

// Фабрики зі змінами в графіку за останні ~30 днів (тижні з week_start ≥ today−37):
// підказка «зміни на фабриці поза списком фабрик працівника».
async function scheduleFactoriesOf(workerId: number, today: string): Promise<{ factoryId: number; name: string | null }[]> {
  const from = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) - 37)).toISOString().slice(0, 10);
  const rows = await db.select({ factoryId: scheduleEntriesTable.factoryId, name: factoriesTable.name })
    .from(scheduleEntriesTable)
    .innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(eq(scheduleEntriesTable.workerId, workerId), gte(scheduleWeeksTable.weekStart, from)))
    .groupBy(scheduleEntriesTable.factoryId, factoriesTable.name);
  return rows.map(r => ({ factoryId: r.factoryId, name: r.name }));
}

export async function loadLegalityInput(workerId: number, today = warsawToday(), rules?: LegalRuleInput[]): Promise<LegalityInput | null> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return null;
  // громадянство з паспорта (MRZ анкети): фолбек, коли профіль порожній; інакше — факт для звірки (nationality_conflict)
  const [q] = await db.select({ citizenship: workerQuestionnairesTable.citizenship }).from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  const passportNationality = mrzNationalityToCatalog(q?.citizenship ?? null);
  const nationality = w.nationality ?? passportNationality;
  const [pos] = w.positionId != null ? await db.select({ isOffice: positionsTable.isOffice }).from(positionsTable).where(eq(positionsTable.id, w.positionId)) : [];
  const worker: LegalityWorker = {
    id: w.id, nationality, birthDate: dateStr(w.birthDate), companyId: w.companyId,
    employmentStartDate: dateStr(w.employmentStartDate), employerSince: await employerSinceOf({ id: w.id, employmentStartDate: dateStr(w.employmentStartDate) }),
    isStudent: w.isStudent, legalStatus: w.legalStatus, notifyHours: w.notifyHours,
    factoryId: w.factoryId, positionIsOffice: !!pos?.isOffice,
  };
  const [contracts, factories, scheduleFactories] = await Promise.all([loadWorkerContracts(workerId), loadWorkerFactories(workerId), scheduleFactoriesOf(workerId, today)]);
  const factoryNames: Record<number, string | null> = {};
  for (const f of factories) factoryNames[f.factoryId] = f.name;
  for (const f of scheduleFactories) factoryNames[f.factoryId] = f.name;
  if (w.factoryId != null && !(w.factoryId in factoryNames)) {
    const [f] = await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, w.factoryId));
    factoryNames[w.factoryId] = f?.name ?? null;
  }
  return {
    today, worker, documents: await loadWorkerDocuments(workerId), rules: rules ?? await loadLegalRules(),
    contracts, factories,
    facts: { passportNationality, nationalityFromPassport: !w.nationality && !!passportNationality, scheduleFactories, factoryNames },
  };
}

export async function saveLegality(workerId: number, input: LegalityInput, r: LegalityResult): Promise<void> {
  const values = {
    workerId, stay: r.stay.status, work: r.work.status, contract: r.contract.status, overall: r.overall,
    reviewRequired: r.reviewRequired, reasons: r.reasons,
    nextExpiryAt: r.nextExpiry?.date ?? null, nextExpiryDocId: r.nextExpiry?.docId ?? null,
    requiredMissing: r.requiredMissing, obligations: r.obligations,
    axes: {
      stay: { basisDocId: r.stay.basisDocId, basisRuleCode: r.stay.basisRuleCode, expiresAt: r.stay.expiresAt },
      work: { basisDocId: r.work.basisDocId, basisRuleCode: r.work.basisRuleCode, expiresAt: r.work.expiresAt },
      contract: { basisDocId: r.contract.basisDocId, basisRuleCode: null, expiresAt: r.contract.expiresAt }, // basisDocId = id умови
    },
    derivedLegalStatus: r.legacy.derivedLegalStatus, derivedPayrollClass: r.legacy.derivedPayrollClass,
    legacyMappingRequiresReview: r.legacy.legacyMappingRequiresReview, legacyMismatchKind: r.legacy.legacyMismatchKind,
    payrollHints: r.payrollHints as unknown as Record<string, unknown>,
    inputHash: sha1({ w: input.worker, d: input.documents, c: input.contracts ?? null, f: input.factories ?? null }), rulesHash: sha1(input.rules), computedAt: new Date(),
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
