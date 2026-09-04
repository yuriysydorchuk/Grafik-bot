// Модуль «Легалізація» — фаза 2 (API). Cap `legalization` (D6): ведення документів
// зі строками/номерами/справами, правила, дашборд і Excel. Світлофори без деталей
// (GET /workers/:id/legality) — будь-якій авторизованій ролі.
//
// Гейти — per-route (не голий router.use(gate)): див. коментар у routes/contracts.ts.
// Payroll-інваріант: тут НЕМАЄ жодного запису у workers.* — лише worker_documents,
// legal_rules, worker_legality (кеш) і document_audit.
import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db, workersTable, workerDocumentsTable, documentTypesTable, legalRulesTable, workerLegalityTable,
  factoriesTable, companiesTable, workerFactoriesTable, contractsTable,
} from "@workspace/db";
import { authRequired, requireCap, requireAnyCap, type AuthedRequest } from "../lib/auth";
import { recomputeWorkerLegality, recomputeAllActiveLegality, warsawToday } from "../services/legalityRecompute";
import { documentAuditDiff, documentAuditRows } from "../services/documentAudit";
import { documentChanged, workerLegalityChanged } from "../services/documentEvents";
import { PAYROLL_GROUPS, resolveStatusMap } from "../services/legalStatusMap";
import { nameCaps } from "../services/drive";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(authRequired);
const LG = requireCap("legalization");
const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });
const adminOf = (req: any) => ({ adminId: (req as AuthedRequest).admin?.adminId ?? null, name: (req as AuthedRequest).admin?.name ?? null });
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const CASE_STATUSES = new Set(["to_submit", "submitted", "in_progress", "decision_positive", "decision_negative", "withdrawn"]);

// Польські назви громадянства для експорту (каталог — web/src/lib/nationality.tsx)
const NAT_PL: Record<string, string> = {
  ukraine: "Ukraina", belarus: "Białoruś", poland: "Polska", moldova: "Mołdawia", romania: "Rumunia", georgia: "Gruzja",
  azerbaijan: "Azerbejdżan", turkey: "Turcja", eu_other: "UE/EOG", africa: "Afryka", latin_america: "Ameryka Łacińska",
  central_asia: "Azja Środkowa", south_asia: "Azja Południowa", other: "Inne",
};
const STATUS_PL: Record<string, string> = { legal: "OK", pending: "W toku", expiring: "Wygasa", illegal: "BRAK PODSTAWY", unknown: "Brak danych" };
const RULE_LABEL_PL: Record<string, string> = { "stay.pl_citizen": "Obywatel PL", "stay.eu_citizen": "Obywatel UE/EOG" };

type AxisBasis = { basisDocId: number | null; basisRuleCode: string | null; expiresAt: string | null };
type Axes = { stay?: AxisBasis; work?: AxisBasis; contract?: AxisBasis };

// ── Світлофори одного працівника (будь-яка роль) ──
router.get("/workers/:id/legality", async (req, res) => {
  const id = Number(req.params.id);
  let [row] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, id));
  if (!row) {
    const r = await recomputeWorkerLegality(id);
    if (!r) return fail(res, 404, "Не знайдено");
    [row] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, id));
  }
  ok(res, row ?? null);
});
router.post("/workers/:id/legality/recompute", LG, async (req, res) => {
  const id = Number(req.params.id);
  const r = await recomputeWorkerLegality(id);
  if (!r) return fail(res, 404, "Не знайдено");
  const [row] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, id));
  ok(res, row);
});

// Глобальні параметри для UI (будь-яка роль): дата кінця UKR (ефективний строк status_ukr у списку документів),
// дефолтний lead — без розкриття решти правил.
router.get("/legalization/globals", async (_req, res) => {
  const rows = await db.select().from(legalRulesTable).where(and(eq(legalRulesTable.isActive, true), inArray(legalRulesTable.code, ["global.ukr_status_end", "defaults.lead_days"])));
  const today = warsawToday();
  const live = rows.filter(r => r.effectiveFrom <= today && (!r.effectiveTo || r.effectiveTo > today));
  const ukr = live.find(r => r.code === "global.ukr_status_end");
  const lead = live.find(r => r.code === "defaults.lead_days");
  ok(res, { today, ukrStatusEnd: (ukr?.conditions as any)?.date ?? null, defaultLeadDays: (lead?.conditions as any)?.defaultLeadDays ?? 30 });
});

// Мапа статусів (services/legalStatusMap.ts) + назви типів з каталогу — вкладка «Правила легальності».
// ── Додаткові фабрики працівника (worker_factories) — вісь «умова» вимагає пакет на кожну ──
const WF = requireAnyCap("editData", "legalization");
router.get("/workers/:id/factories", async (req, res) => {
  const workerId = Number(req.params.id);
  const rows = await db.select({ id: workerFactoriesTable.id, factoryId: workerFactoriesTable.factoryId, factoryName: factoriesTable.name, validFrom: workerFactoriesTable.validFrom, validTo: workerFactoriesTable.validTo, note: workerFactoriesTable.note })
    .from(workerFactoriesTable).leftJoin(factoriesTable, eq(workerFactoriesTable.factoryId, factoriesTable.id))
    .where(eq(workerFactoriesTable.workerId, workerId)).orderBy(factoriesTable.name);
  ok(res, rows);
});
router.post("/workers/:id/factories", WF, async (req, res) => {
  const workerId = Number(req.params.id);
  const b = req.body ?? {};
  const factoryId = Number(b.factoryId);
  if (!Number.isInteger(factoryId)) return fail(res, 400, "factoryId");
  if (b.validFrom != null && b.validFrom !== "" && !isDate(b.validFrom)) return fail(res, 400, "validFrom: YYYY-MM-DD");
  if (b.validTo != null && b.validTo !== "" && !isDate(b.validTo)) return fail(res, 400, "validTo: YYYY-MM-DD");
  const [w] = await db.select({ id: workersTable.id, factoryId: workersTable.factoryId }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return fail(res, 404, "Працівника не знайдено");
  if (w.factoryId === factoryId) return fail(res, 400, "Це основна фабрика працівника — вона вже в списку");
  const [f] = await db.select({ id: factoriesTable.id }).from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  if (!f) return fail(res, 404, "Фабрику не знайдено");
  const [row] = await db.insert(workerFactoriesTable).values({ workerId, factoryId, validFrom: b.validFrom || null, validTo: b.validTo || null, note: typeof b.note === "string" && b.note.trim() ? b.note.trim() : null })
    .onConflictDoUpdate({ target: [workerFactoriesTable.workerId, workerFactoriesTable.factoryId], set: { validFrom: b.validFrom || null, validTo: b.validTo || null } }).returning();
  await workerLegalityChanged(workerId);
  ok(res, row);
});
router.patch("/worker-factories/:id", WF, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.validFrom !== undefined) { if (b.validFrom && !isDate(b.validFrom)) return fail(res, 400, "validFrom"); patch.validFrom = b.validFrom || null; }
  if (b.validTo !== undefined) { if (b.validTo && !isDate(b.validTo)) return fail(res, 400, "validTo"); patch.validTo = b.validTo || null; }
  if (b.note !== undefined) patch.note = b.note ? String(b.note).trim() : null;
  const [row] = await db.update(workerFactoriesTable).set(patch).where(eq(workerFactoriesTable.id, id)).returning();
  if (!row) return fail(res, 404, "Не знайдено");
  await workerLegalityChanged(row.workerId);
  ok(res, row);
});
router.delete("/worker-factories/:id", WF, async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.delete(workerFactoriesTable).where(eq(workerFactoriesTable.id, id)).returning();
  if (!row) return fail(res, 404, "Не знайдено");
  await workerLegalityChanged(row.workerId);
  ok(res, { ok: true });
});

// Чинна мапа = правило payroll.status_map (якщо є) поверх дефолтів коду.
router.get("/legalization/status-map", async (_req, res) => {
  const types = await db.select({ code: documentTypesTable.code, name: documentTypesTable.name, isActive: documentTypesTable.isActive }).from(documentTypesTable);
  const nameOf = new Map(types.map(t => [t.code, t.name]));
  const today = warsawToday();
  const [rule] = await db.select().from(legalRulesTable)
    .where(and(eq(legalRulesTable.code, "payroll.status_map"), eq(legalRulesTable.isActive, true), sql`${legalRulesTable.effectiveFrom} <= ${today}`, sql`(${legalRulesTable.effectiveTo} IS NULL OR ${legalRulesTable.effectiveTo} > ${today})`))
    .orderBy(desc(legalRulesTable.effectiveFrom)).limit(1);
  const m = resolveStatusMap(rule?.conditions as Record<string, unknown> | undefined);
  ok(res, {
    groups: PAYROLL_GROUPS,
    studentMaxAge: m.studentMaxAge,
    overridden: m.overridden,
    rule: rule ? { id: rule.id, effectiveFrom: rule.effectiveFrom, verifiedAt: rule.verifiedAt, note: rule.note } : null,
    statuses: m.statuses.map(s => ({ ...s, docTypes: m.docTypes.filter(d => d.status === s.status).map(d => ({ code: d.typeCode, name: nameOf.get(d.typeCode) ?? d.typeCode })) })),
    docTypes: m.docTypes.map(d => ({ ...d, name: nameOf.get(d.typeCode) ?? d.typeCode, inCatalog: nameOf.has(d.typeCode) })),
  });
});

// ── Дашборд ──
async function dashboardRows() {
  const rows = await db.select({
      id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode,
      nationality: workersTable.nationality, legalStatus: workersTable.legalStatus, companyId: workersTable.companyId,
      factoryId: workersTable.factoryId, factoryName: factoriesTable.name, companyName: companiesTable.name,
      lg: workerLegalityTable,
    })
    .from(workersTable)
    .leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id))
    .leftJoin(companiesTable, eq(workersTable.companyId, companiesTable.id))
    .leftJoin(workerLegalityTable, eq(workerLegalityTable.workerId, workersTable.id))
    .where(eq(workersTable.isActive, true))
    .orderBy(workersTable.fullName);
  // назви документів-підстав (по осях)
  const docIds = new Set<number>();
  for (const r of rows) { const a = (r.lg?.axes ?? {}) as Axes; if (a.stay?.basisDocId) docIds.add(a.stay.basisDocId); if (a.work?.basisDocId) docIds.add(a.work.basisDocId); }
  const docName = new Map<number, string>();
  if (docIds.size) {
    const docs = await db.select({ id: workerDocumentsTable.id, title: workerDocumentsTable.title, typeName: documentTypesTable.name })
      .from(workerDocumentsTable).leftJoin(documentTypesTable, eq(workerDocumentsTable.docTypeId, documentTypesTable.id))
      .where(inArray(workerDocumentsTable.id, [...docIds]));
    for (const d of docs) docName.set(d.id, d.typeName ?? d.title);
  }
  const pendingCounts = new Map<number, number>();
  for (const p of await db.select({ workerId: workerDocumentsTable.workerId, n: sql<number>`count(*)::int` }).from(workerDocumentsTable)
    .where(eq(workerDocumentsTable.status, "pending")).groupBy(workerDocumentsTable.workerId)) pendingCounts.set(p.workerId, p.n);
  const basis = (a?: Axes["stay"]) => !a ? null : a.basisDocId ? { label: docName.get(a.basisDocId) ?? null, until: a.expiresAt, docId: a.basisDocId }
    : a.basisRuleCode ? { label: RULE_LABEL_PL[a.basisRuleCode] ?? a.basisRuleCode, until: null, docId: null } : null;
  // вісь «умова»: basisDocId = id умови; підпис — фабрика умови або «Biuro»
  const contractIds = new Set<number>();
  for (const r of rows) { const c = ((r.lg?.axes ?? {}) as Axes).contract; if (c?.basisDocId) contractIds.add(c.basisDocId); }
  const contractLabel = new Map<number, string>();
  if (contractIds.size) {
    const cs = await db.select({ id: contractsTable.id, factoryName: factoriesTable.name })
      .from(contractsTable).leftJoin(factoriesTable, eq(contractsTable.factoryId, factoriesTable.id)).where(inArray(contractsTable.id, [...contractIds]));
    for (const c of cs) contractLabel.set(c.id, c.factoryName ? `Umowa — ${c.factoryName}` : "Umowa — Biuro");
  }
  const contractBasis = (a?: Axes["contract"]) => !a || !a.basisDocId ? null : { label: contractLabel.get(a.basisDocId) ?? "Umowa", until: a.expiresAt, docId: null };
  return rows.map(r => {
    const a = (r.lg?.axes ?? {}) as Axes;
    return {
      id: r.id, fullName: r.fullName, workerCode: r.workerCode, nationality: r.nationality, legalStatus: r.legalStatus,
      factoryId: r.factoryId, factoryName: r.factoryName, companyId: r.companyId, companyName: r.companyName,
      legality: r.lg ? {
        stay: r.lg.stay, work: r.lg.work, contract: r.lg.contract, overall: r.lg.overall, reviewRequired: r.lg.reviewRequired,
        nextExpiryAt: r.lg.nextExpiryAt, nextExpiryDocId: r.lg.nextExpiryDocId, requiredMissing: r.lg.requiredMissing,
        derivedLegalStatus: r.lg.derivedLegalStatus, legacyMismatchKind: r.lg.legacyMismatchKind,
        legacyMappingRequiresReview: r.lg.legacyMappingRequiresReview, reasons: r.lg.reasons, computedAt: r.lg.computedAt,
      } : null,
      stayBasis: basis(a.stay), workBasis: basis(a.work), contractBasis: contractBasis(a.contract),
      pendingDocs: pendingCounts.get(r.id) ?? 0,
    };
  });
}
router.get("/legalization", LG, async (_req, res) => {
  const rows = await dashboardRows();
  const today = warsawToday();
  const summary = { total: rows.length, legal: 0, pending: 0, expiring: 0, illegal: 0, unknown: 0, notComputed: 0, review: 0, pendingDocs: 0 };
  for (const r of rows) {
    if (!r.legality) { summary.notComputed++; continue; }
    (summary as any)[r.legality.overall] = ((summary as any)[r.legality.overall] ?? 0) + 1;
    if (r.legality.reviewRequired) summary.review++;
    summary.pendingDocs += r.pendingDocs;
  }
  ok(res, { today, summary, rows });
});
router.post("/legalization/recompute-all", LG, async (_req, res) => {
  ok(res, await recomputeAllActiveLegality());
});

// Excel «Lista ważności dokumentów» — польською, імена капсом (nameCaps), колонки — рішення D15.
router.get("/legalization/excel", LG, async (_req, res) => {
  const rows = await dashboardRows();
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Lista ważności dokumentów");
  const cols = [
    { key: "name", header: "Nazwisko i imię", get: (r: any) => nameCaps(r.fullName) },
    { key: "nat", header: "Obywatelstwo", get: (r: any) => NAT_PL[r.nationality ?? ""] ?? "" },
    { key: "firm", header: "Firma", get: (r: any) => r.companyName ?? "" },
    { key: "factory", header: "Zakład", get: (r: any) => r.factoryName ?? "" },
    { key: "stay", header: "Podstawa pobytu", get: (r: any) => r.stayBasis?.label ?? "" },
    { key: "stayTo", header: "Pobyt do", get: (r: any) => r.stayBasis?.until ?? "" },
    { key: "work", header: "Podstawa pracy", get: (r: any) => r.workBasis?.label ?? "" },
    { key: "workTo", header: "Praca do", get: (r: any) => r.workBasis?.until ?? "" },
    { key: "umowa", header: "Umowa", get: (r: any) => (r.legality ? STATUS_PL[r.legality.contract] ?? r.legality.contract : "") },
    { key: "umowaTo", header: "Umowa do", get: (r: any) => r.contractBasis?.until ?? "" },
    { key: "status", header: "Status", get: (r: any) => (r.legality ? STATUS_PL[r.legality.overall] ?? r.legality.overall : "Brak danych") },
    { key: "next", header: "Najbliższy termin", get: (r: any) => r.legality?.nextExpiryAt ?? "" },
    { key: "resp", header: "Odpowiedzialny", get: () => "" }, // відповідальний фабрики — фаза 3 (D7)
  ];
  ws.addRow(cols.map(c => c.header)).font = { bold: true };
  const sorted = [...rows].sort((a, b) => new Intl.Collator("pl").compare(a.fullName, b.fullName));
  for (const r of sorted) ws.addRow(cols.map(c => c.get(r)));
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 32 : 18; });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`Lista waznosci dokumentow ${warsawToday()}.xlsx`)}"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

// ── Правила легальності: версії, не редагування на місці ──
router.get("/legal-rules", LG, async (_req, res) => {
  ok(res, await db.select().from(legalRulesTable).orderBy(legalRulesTable.code, desc(legalRulesTable.effectiveFrom)));
});
router.post("/legal-rules", LG, async (req, res) => {
  const b = req.body ?? {};
  const code = String(b.code ?? "").trim(), kind = String(b.kind ?? "").trim();
  if (!/^[a-z_]+\.[a-z_]+$/.test(code)) return fail(res, 400, "Код правила — формат група.назва (латиниця)");
  if (!["basis_by_nationality", "requirement", "obligation", "precedence", "global"].includes(kind)) return fail(res, 400, "Невідомий вид правила");
  if (!isDate(b.effectiveFrom)) return fail(res, 400, "Дата «діє з» — формат YYYY-MM-DD");
  const axis = ["stay", "work", "both"].includes(b.axis) ? b.axis : null;
  const conditions = b.conditions && typeof b.conditions === "object" ? b.conditions : null;
  if (!conditions) return fail(res, 400, "Умови правила — обов'язковий JSON-обʼєкт");
  const admin = adminOf(req);
  const created = await db.transaction(async tx => {
    // чинна попередня версія закривається датою нової
    await tx.update(legalRulesTable).set({ effectiveTo: b.effectiveFrom })
      .where(and(eq(legalRulesTable.code, code), sql`${legalRulesTable.effectiveTo} IS NULL`, sql`${legalRulesTable.effectiveFrom} < ${b.effectiveFrom}`));
    const [row] = await tx.insert(legalRulesTable).values({
      code, kind, axis, conditions, effectiveFrom: b.effectiveFrom, effectiveTo: isDate(b.effectiveTo) ? b.effectiveTo : null,
      source: b.source ? String(b.source).trim() : null, note: b.note ? String(b.note).trim() : null,
      verifiedAt: b.verified ? new Date() : null, verifiedBy: b.verified ? admin.adminId : null, createdBy: admin.adminId,
    }).returning();
    return row!;
  });
  recomputeAllActiveLegality().catch(err => logger.warn({ err: String(err) }, "recompute after rule change failed"));
  ok(res, created);
});
router.patch("/legal-rules/:id", LG, async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  const admin = adminOf(req);
  if (b.verified !== undefined) { patch.verifiedAt = b.verified ? new Date() : null; patch.verifiedBy = b.verified ? admin.adminId : null; }
  if (b.note !== undefined) patch.note = b.note ? String(b.note).trim() : null;
  if (b.source !== undefined) patch.source = b.source ? String(b.source).trim() : null;
  if (b.isActive !== undefined) patch.isActive = !!b.isActive;
  if (b.effectiveTo !== undefined) { if (b.effectiveTo !== null && !isDate(b.effectiveTo)) return fail(res, 400, "Дата «діє до» — формат YYYY-MM-DD"); patch.effectiveTo = b.effectiveTo; }
  if (!Object.keys(patch).length) return fail(res, 400, "Нема що змінювати (умови/код правлять новою версією)");
  const [row] = await db.update(legalRulesTable).set(patch).where(eq(legalRulesTable.id, id)).returning();
  if (!row) return fail(res, 404, "Не знайдено");
  recomputeAllActiveLegality().catch(err => logger.warn({ err: String(err) }, "recompute after rule change failed"));
  ok(res, row);
});

// ── Документи: юридичні поля, верифікація, журнал ──
router.get("/worker-documents/:id/audit", LG, async (req, res) => {
  ok(res, await documentAuditRows(Number(req.params.id)));
});

const LEGAL_DATE_FIELDS = ["validFrom", "issuedAt", "submittedAt", "decisionAt", "expiresAt"] as const;
router.patch("/worker-documents/:id/legal", LG, async (req, res) => {
  const id = Number(req.params.id);
  const [before] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  if (!before) return fail(res, 404, "Документ не знайдено");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  for (const f of LEGAL_DATE_FIELDS) {
    if (b[f] === undefined) continue;
    if (b[f] !== null && b[f] !== "" && !isDate(b[f])) return fail(res, 400, `${f}: формат YYYY-MM-DD`);
    patch[f] = b[f] || null;
  }
  for (const f of ["issuer", "caseNumber", "number", "note"] as const) if (b[f] !== undefined) patch[f] = b[f] ? String(b[f]).trim() || null : null;
  if (b.employerCompanyId !== undefined) {
    if (b.employerCompanyId === null || b.employerCompanyId === "") patch.employerCompanyId = null;
    else {
      const cid = Number(b.employerCompanyId);
      const [c] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, cid));
      if (!c) return fail(res, 400, "Невідома фірма");
      patch.employerCompanyId = cid;
    }
  }
  if (b.caseStatus !== undefined) {
    if (b.caseStatus !== null && b.caseStatus !== "" && !CASE_STATUSES.has(b.caseStatus)) return fail(res, 400, "Невідомий статус справи");
    patch.caseStatus = b.caseStatus || null;
  }
  // типоспецифічні атрибути — білий список ключів (web/src/lib/documentFields.ts)
  if (b.attrs !== undefined) {
    if (b.attrs === null) patch.attrs = null;
    else if (typeof b.attrs !== "object" || Array.isArray(b.attrs)) return fail(res, 400, "attrs: обʼєкт");
    else {
      // laborMarketAccess — TRC z dostępem do rynku pracy; studyMode — тип навчання (stationary дає працю; part_time/school — лише ставка студента)
      // purpose — мета перебування карти (з decyzji, на карті не друкується): інформаційно + для задач офісу
      const ALLOWED: Record<string, "boolean" | "string"> = { laborMarketAccess: "boolean", studyMode: "string", purpose: "string" };
      const ENUMS: Record<string, string[]> = { studyMode: ["stationary", "part_time", "school"], purpose: ["work", "study", "family", "business", "other"] };
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.attrs)) {
        if (!(k in ALLOWED)) return fail(res, 400, `attrs.${k}: невідомий атрибут`);
        if (v !== null && typeof v !== ALLOWED[k]) return fail(res, 400, `attrs.${k}: очікується ${ALLOWED[k]}`);
        if (v !== null && ENUMS[k] && !ENUMS[k].includes(String(v))) return fail(res, 400, `attrs.${k}: одне з ${ENUMS[k].join("|")}`);
        if (v !== null) clean[k] = v;
      }
      patch.attrs = Object.keys(clean).length ? clean : null;
    }
  }
  if (b.replacesDocumentId !== undefined) {
    if (b.replacesDocumentId === null || b.replacesDocumentId === "") patch.replacesDocumentId = null;
    else {
      const rid = Number(b.replacesDocumentId);
      const [old] = await db.select({ id: workerDocumentsTable.id, workerId: workerDocumentsTable.workerId }).from(workerDocumentsTable).where(eq(workerDocumentsTable.id, rid));
      if (!old || old.workerId !== before.workerId || old.id === id) return fail(res, 400, "Поновлюваний документ має належати цьому ж працівнику");
      patch.replacesDocumentId = rid;
    }
  }
  if (!Object.keys(patch).length) return fail(res, 400, "Нема що змінювати");
  patch.updatedAt = new Date();
  const [d] = await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, id)).returning();
  const changes = documentAuditDiff(before, patch);
  await documentChanged({ id, workerId: before.workerId }, changes.some(c => c.field === "caseStatus") ? "case" : "updated", adminOf(req), changes);
  ok(res, d);
});

router.post("/worker-documents/:id/verify", LG, async (req, res) => {
  const id = Number(req.params.id);
  const [before] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  if (!before) return fail(res, 404, "Документ не знайдено");
  const admin = adminOf(req);
  const patch = { verifiedAt: new Date(), verifiedBy: admin.adminId, reviewNote: null, status: before.status === "pending" ? "present" : before.status, updatedAt: new Date() };
  const [d] = await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, id)).returning();
  await documentChanged({ id, workerId: before.workerId }, "verified", admin, documentAuditDiff(before, patch));
  ok(res, d);
});

// Відхилення аплоуду: рядок лишається (історія + повторний аплоуд з бота оновить його),
// статус → missing, причина — у review_note (бот покаже працівнику).
router.post("/worker-documents/:id/reject", LG, async (req, res) => {
  const id = Number(req.params.id);
  const note = String(req.body?.note ?? "").trim();
  if (!note) return fail(res, 400, "Вкажіть причину відхилення");
  const [before] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  if (!before) return fail(res, 404, "Документ не знайдено");
  const patch = { status: "missing", reviewNote: note, verifiedAt: null, verifiedBy: null, updatedAt: new Date() };
  const [d] = await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, id)).returning();
  await documentChanged({ id, workerId: before.workerId }, "rejected", adminOf(req), documentAuditDiff(before, patch));
  ok(res, d);
});

// Запит на подачу: гейт кнопки «Додати» в боті (D3, фаза 4). Якщо рядка нема — створює
// порожній `missing` під тип.
router.post("/workers/:id/documents/request", LG, async (req, res) => {
  const workerId = Number(req.params.id);
  const docTypeId = Number(req.body?.docTypeId);
  if (!docTypeId) return fail(res, 400, "Вкажіть тип документа");
  const [t] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, docTypeId));
  if (!t) return fail(res, 404, "Тип не знайдено");
  const admin = adminOf(req);
  let [doc] = await db.select().from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, workerId), eq(workerDocumentsTable.docTypeId, docTypeId)));
  const patch = { requestedAt: new Date(), requestedBy: admin.adminId, updatedAt: new Date() };
  if (doc) [doc] = await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, doc.id)).returning();
  else [doc] = await db.insert(workerDocumentsTable).values({ workerId, docTypeId, title: t.name, status: "missing", ...patch }).returning();
  await documentChanged({ id: doc!.id, workerId }, "requested", admin);
  ok(res, doc);
});

export default router;
