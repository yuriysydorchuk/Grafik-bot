import { Router, type IRouter, type Response } from "express";
import multer from "multer";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import {
  workersTable,
  factoriesTable,
  companiesTable,
  penaltiesTable,
  sushiWorkerCodesTable,
  sushiRolesTable,
  sushiLinesTable,
  sushiLineAliasesTable,
  sushiSupervisorsTable,
  sushiImportBatchesTable,
  sushiStagingEntriesTable,
  sushiWorkIntervalsTable,
  sushiDisputesTable,
  sushiZalacznikSummariesTable,
  sushiReconciliationExceptionsTable,
} from "@workspace/db";
import { eq, and, desc, asc, inArray, gte, lte } from "drizzle-orm";
import { authRequired, requireAnyCap, type AuthedRequest } from "../lib/auth";
import {
  parseDailyShiftExcel,
  previewExcelReport,
  validateStagingRow,
  normalizeRcpCode,
  decodeOriginalFilename,
  type SushiColumnMapping,
} from "../services/sushiImport";
import { buildTimesheetTree, prepareStagingCommit } from "../services/sushiTimesheet";
import { validateTimeInterval, roundStartTime, roundStopTime, calcIntervalHours } from "../services/sushiTime";
import { calculateSushiZalacznik, reconcileSushiHours } from "../services/sushiFinance";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(authRequired);
router.use("/sushi", requireAnyCap("editData", "viewFinance", "svodni", "viewWorkers"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

const ok = (res: Response, data: any = { ok: true }) => {
  res.json(data);
};
const fail = (res: Response, status: number, error: string) => {
  res.status(status).json({ error });
};

// ─── 1. ДОВІДНИКИ РОЛЕЙ ТА ЛІНІЙ ───────────────────────────────────────────────

router.get("/sushi/roles", async (_req, res) => {
  const rows = await db.select().from(sushiRolesTable).orderBy(asc(sushiRolesTable.displayOrder));
  ok(res, rows);
});

router.get("/sushi/lines", async (req, res) => {
  const factoryId = Number(req.query.factoryId) || 1;
  const lines = await db
    .select()
    .from(sushiLinesTable)
    .where(eq(sushiLinesTable.factoryId, factoryId))
    .orderBy(asc(sushiLinesTable.displayOrder));

  const lineIds = lines.map((l) => l.id);
  const aliases = lineIds.length > 0
    ? await db.select().from(sushiLineAliasesTable).where(inArray(sushiLineAliasesTable.lineId, lineIds))
    : [];

  const aliasMap = new Map<number, string[]>();
  for (const a of aliases) {
    if (!aliasMap.has(a.lineId)) aliasMap.set(a.lineId, []);
    aliasMap.get(a.lineId)!.push(a.rawAlias);
  }

  const result = lines.map((l) => ({
    ...l,
    aliases: aliasMap.get(l.id) || [],
  }));

  ok(res, result);
});

router.post("/sushi/lines", async (req, res) => {
  const { factoryId, name, code, requiresLeader, minStaffing, displayOrder } = req.body ?? {};
  if (!name || !code) {
    fail(res, 400, "Назва та код лінії обов'язкові");
    return;
  }

  const [row] = await db
    .insert(sushiLinesTable)
    .values({
      factoryId: Number(factoryId) || 1,
      name: String(name).trim(),
      code: String(code).trim().toUpperCase(),
      requiresLeader: requiresLeader !== false,
      minStaffing: Number(minStaffing) || 1,
      displayOrder: Number(displayOrder) || 0,
    })
    .returning();

  ok(res, row);
});

router.post("/sushi/lines/:id/aliases", async (req, res) => {
  const lineId = Number(req.params.id);
  const { rawAlias } = req.body ?? {};
  if (!lineId || !rawAlias) {
    fail(res, 400, "lineId та rawAlias обов'язкові");
    return;
  }

  const [row] = await db
    .insert(sushiLineAliasesTable)
    .values({
      lineId,
      rawAlias: String(rawAlias).trim(),
    })
    .onConflictDoNothing()
    .returning();

  ok(res, row || { lineId, rawAlias });
});

router.get("/sushi/supervisors", async (_req, res) => {
  const rows = await db
    .select({
      id: sushiSupervisorsTable.id,
      signatureName: sushiSupervisorsTable.signatureName,
      workerId: sushiSupervisorsTable.workerId,
      workerName: workersTable.fullName,
      isActive: sushiSupervisorsTable.isActive,
    })
    .from(sushiSupervisorsTable)
    .leftJoin(workersTable, eq(sushiSupervisorsTable.workerId, workersTable.id))
    .orderBy(asc(sushiSupervisorsTable.signatureName));

  ok(res, rows);
});

router.post("/sushi/supervisors", async (req, res) => {
  const { signatureName, workerId } = req.body ?? {};
  if (!signatureName) {
    fail(res, 400, "signatureName обов'язкове");
    return;
  }

  const [row] = await db
    .insert(sushiSupervisorsTable)
    .values({
      signatureName: String(signatureName).trim(),
      workerId: workerId ? Number(workerId) : null,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [sushiSupervisorsTable.signatureName],
      set: { workerId: workerId ? Number(workerId) : null },
    })
    .returning();

  ok(res, row);
});

// ─── 2. ФАБРИЧНІ КОДИ RCP ТА АЛІАСИ ────────────────────────────────────────────

router.get("/sushi/worker-codes", async (req, res) => {
  const factoryId = Number(req.query.factoryId) || 1;
  const rows = await db
    .select({
      id: sushiWorkerCodesTable.id,
      workerId: sushiWorkerCodesTable.workerId,
      workerName: workersTable.fullName,
      workerCode: workersTable.workerCode,
      factoryId: sushiWorkerCodesTable.factoryId,
      companyId: sushiWorkerCodesTable.companyId,
      companyName: companiesTable.name,
      rcpCode: sushiWorkerCodesTable.rcpCode,
      validFrom: sushiWorkerCodesTable.validFrom,
      validTo: sushiWorkerCodesTable.validTo,
      isPrimary: sushiWorkerCodesTable.isPrimary,
      notes: sushiWorkerCodesTable.notes,
      createdAt: sushiWorkerCodesTable.createdAt,
    })
    .from(sushiWorkerCodesTable)
    .leftJoin(workersTable, eq(sushiWorkerCodesTable.workerId, workersTable.id))
    .leftJoin(companiesTable, eq(sushiWorkerCodesTable.companyId, companiesTable.id))
    .where(eq(sushiWorkerCodesTable.factoryId, factoryId))
    .orderBy(desc(sushiWorkerCodesTable.id));

  ok(res, rows);
});

router.post("/sushi/worker-codes", async (req, res) => {
  const { workerId, factoryId, companyId, rcpCode, validFrom, validTo, isPrimary, notes } = req.body ?? {};
  if (!workerId || !rcpCode) {
    fail(res, 400, "workerId та rcpCode обов'язкові");
    return;
  }

  const normalized = normalizeRcpCode(rcpCode);
  const [row] = await db
    .insert(sushiWorkerCodesTable)
    .values({
      workerId: Number(workerId),
      factoryId: Number(factoryId) || 1,
      companyId: Number(companyId) || 1,
      rcpCode: normalized,
      validFrom: validFrom ? String(validFrom) : "2020-01-01",
      validTo: validTo ? String(validTo) : null,
      isPrimary: isPrimary !== false,
      notes: notes ? String(notes).trim() : null,
    })
    .returning();

  ok(res, row);
});

router.delete("/sushi/worker-codes/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    fail(res, 400, "id обов'язковий");
    return;
  }
  await db.delete(sushiWorkerCodesTable).where(eq(sushiWorkerCodesTable.id, id));
  ok(res);
});

// ─── 3. ШЛЮЗ ІМПОРТУ (STAGING AREA) ────────────────────────────────────────────

router.post("/sushi/import/preview", upload.any(), async (req: AuthedRequest, res) => {
  const rawFiles = (req.files as Express.Multer.File[] | undefined) || (req.file ? [req.file] : []);
  const file = rawFiles[0];
  if (!file || !file.buffer) {
    fail(res, 400, "Будь ласка, оберіть Excel файл для попереднього перегляду");
    return;
  }
  try {
    const sheetName = req.body?.sheetName ? String(req.body.sheetName) : undefined;
    const fileName = decodeOriginalFilename(file.originalname || "report.xlsx");
    const preview = previewExcelReport(file.buffer, fileName, sheetName);
    ok(res, preview);
  } catch (err: any) {
    logger.error({ err }, "sushi import preview failed");
    fail(res, 400, err.message || "Помилка читання файлу Excel");
  }
});

router.post("/sushi/import/upload", upload.any(), async (req: AuthedRequest, res) => {
  const rawFiles = (req.files as Express.Multer.File[] | undefined) || (req.file ? [req.file] : []);
  if (!rawFiles || rawFiles.length === 0) {
    logger.warn({ body: req.body }, "sushi upload: no files in request");
    fail(res, 400, "Будь ласка, оберіть Excel файл(и) для завантаження");
    return;
  }

  const factoryId = Number(req.body?.factoryId) || 1;
  let customMapping: SushiColumnMapping | undefined;
  if (req.body?.mapping) {
    try {
      customMapping = typeof req.body.mapping === "string" ? JSON.parse(req.body.mapping) : req.body.mapping;
    } catch (e) {
      logger.warn({ err: e }, "failed parsing custom mapping from upload body");
    }
  }

  logger.info(
    { count: rawFiles.length, names: rawFiles.map((f) => decodeOriginalFilename(f.originalname || "")), hasCustomMapping: !!customMapping },
    "sushi upload: processing files",
  );

  // Завантажуємо спільний контекст валідації
  const workerCodes = await db.select().from(sushiWorkerCodesTable).where(eq(sushiWorkerCodesTable.factoryId, factoryId));
  const companies = await db.select().from(companiesTable);
  const lines = await db.select().from(sushiLinesTable).where(eq(sushiLinesTable.factoryId, factoryId));
  const lineAliases = await db.select().from(sushiLineAliasesTable);
  const supervisors = await db.select().from(sushiSupervisorsTable);

  const batchesProcessed = [];
  let totalRowsOverall = 0;
  let totalValidOverall = 0;
  let totalErrorsOverall = 0;
  let lastErrorMsg: string | null = null;

  for (const file of rawFiles) {
    const fileName = decodeOriginalFilename(file.originalname || "report.xlsx");
    const fileHash = crypto.createHash("sha256").update(file.buffer).digest("hex");

    try {
      const parsed = parseDailyShiftExcel(file.buffer, fileName, customMapping);

      const validationContext = {
        reportDate: parsed.reportDate || "1970-01-01",
        workerCodes: workerCodes.map((c) => ({
          rcpCode: c.rcpCode,
          workerId: c.workerId,
          companyId: c.companyId,
          validFrom: c.validFrom,
          validTo: c.validTo,
        })),
        companies: companies.map((c) => ({ id: c.id, name: c.name })),
        lines: lines.map((l) => ({ id: l.id, name: l.name, code: l.code })),
        lineAliases: lineAliases.map((a) => ({ lineId: a.lineId, rawAlias: a.rawAlias })),
        supervisors: supervisors.map((s) => ({ id: s.id, signatureName: s.signatureName, workerId: s.workerId })),
      };

      const [batch] = await db
        .insert(sushiImportBatchesTable)
        .values({
          factoryId,
          sourceFilename: fileName,
          fileHashSha256: fileHash,
          reportDate: parsed.reportDate,
          isDateMissing: parsed.isDateMissing,
          totalRowsCount: parsed.rows.length,
          status: "PENDING",
          uploadedByAdminId: req.admin?.adminId ?? null,
        })
        .onConflictDoUpdate({
          target: [sushiImportBatchesTable.fileHashSha256],
          set: {
            reportDate: parsed.reportDate,
            isDateMissing: parsed.isDateMissing,
            totalRowsCount: parsed.rows.length,
            status: "PENDING",
          },
        })
        .returning();

      // Очищаємо попередні staging записи цього батчу при перезавантаженні
      await db.delete(sushiStagingEntriesTable).where(eq(sushiStagingEntriesTable.batchId, batch!.id));

      let validCount = 0;
      let errorCount = 0;
      const stagingEntriesToInsert = [];

      for (const row of parsed.rows) {
        const valResult = validateStagingRow(row, validationContext);
        if (valResult.status === "OK") {
          validCount++;
        } else {
          errorCount++;
        }

        stagingEntriesToInsert.push({
          batchId: batch!.id,
          rowNumber: row.rowNumber,
          rawFirma: row.firma,
          rawRcp: row.rcpCode,
          rawDzial: row.dzial,
          rawOd: row.od,
          rawDo: row.do,
          rawRealneGodziny: String(row.realneGodziny),
          rawPodpis: row.podpis,
          rawUwagi: row.uwagi,
          resolvedWorkerId: valResult.resolvedWorkerId,
          resolvedLineId: valResult.resolvedLineId,
          resolvedSupervisorId: valResult.resolvedSupervisorId,
          validationStatus: valResult.status,
          errorMessage: valResult.errorMessage ?? null,
        });
      }

      if (stagingEntriesToInsert.length > 0) {
        await db.insert(sushiStagingEntriesTable).values(stagingEntriesToInsert);
      }

      await db
        .update(sushiImportBatchesTable)
        .set({
          validRowsCount: validCount,
          errorRowsCount: errorCount,
        })
        .where(eq(sushiImportBatchesTable.id, batch!.id));

      totalRowsOverall += parsed.rows.length;
      totalValidOverall += validCount;
      totalErrorsOverall += errorCount;

      batchesProcessed.push({
        batchId: batch!.id,
        fileName,
        reportDate: parsed.reportDate,
        totalRows: parsed.rows.length,
        validRows: validCount,
        errorRows: errorCount,
      });
    } catch (err: any) {
      lastErrorMsg = err.message || "Помилка структури файлу";
      logger.error({ err, fileName }, "sushi import: failed parsing report file in batch");
    }
  }

  if (batchesProcessed.length === 0) {
    fail(res, 400, lastErrorMsg || "Не вдалося розпізнати структуру файлу");
    return;
  }

  ok(res, {
    batchesCount: batchesProcessed.length,
    batchId: batchesProcessed[0]?.batchId,
    reportDate: batchesProcessed[0]?.reportDate,
    totalRows: totalRowsOverall,
    validRows: totalValidOverall,
    errorRows: totalErrorsOverall,
    batches: batchesProcessed,
  });
});

router.get("/sushi/import/batches", async (req, res) => {
  const factoryId = Number(req.query.factoryId) || 1;
  const rows = await db
    .select({
      id: sushiImportBatchesTable.id,
      factoryId: sushiImportBatchesTable.factoryId,
      sourceFilename: sushiImportBatchesTable.sourceFilename,
      reportDate: sushiImportBatchesTable.reportDate,
      isDateMissing: sushiImportBatchesTable.isDateMissing,
      totalRowsCount: sushiImportBatchesTable.totalRowsCount,
      validRowsCount: sushiImportBatchesTable.validRowsCount,
      errorRowsCount: sushiImportBatchesTable.errorRowsCount,
      status: sushiImportBatchesTable.status,
      createdAt: sushiImportBatchesTable.createdAt,
    })
    .from(sushiImportBatchesTable)
    .where(eq(sushiImportBatchesTable.factoryId, factoryId))
    .orderBy(desc(sushiImportBatchesTable.reportDate), desc(sushiImportBatchesTable.id));

  ok(res, rows);
});

// Оновлення дати звіту для імпортованого батчу (якщо бригадир пропустив дату)
router.patch("/sushi/import/batches/:id", async (req, res) => {
  const batchId = Number(req.params.id);
  if (!batchId) {
    fail(res, 400, "batchId обов'язковий");
    return;
  }

  const { reportDate } = req.body ?? {};
  if (!reportDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(reportDate))) {
    fail(res, 400, "Вкажіть коректну дату у форматі YYYY-MM-DD");
    return;
  }

  const [batch] = await db.select().from(sushiImportBatchesTable).where(eq(sushiImportBatchesTable.id, batchId));
  if (!batch) {
    fail(res, 404, "Батч не знайдено");
    return;
  }

  await db
    .update(sushiImportBatchesTable)
    .set({
      reportDate: String(reportDate),
      isDateMissing: false,
    })
    .where(eq(sushiImportBatchesTable.id, batchId));

  // Оновлюємо також дати у вже створених робочих інтервалах (якщо є)
  const stagingEntries = await db
    .select({ id: sushiStagingEntriesTable.id })
    .from(sushiStagingEntriesTable)
    .where(eq(sushiStagingEntriesTable.batchId, batchId));

  const stagingIds = stagingEntries.map((e) => e.id);
  if (stagingIds.length > 0) {
    await db
      .update(sushiWorkIntervalsTable)
      .set({
        workDate: String(reportDate),
        billingMonth: String(reportDate).slice(0, 7),
      })
      .where(inArray(sushiWorkIntervalsTable.stagingEntryId, stagingIds));
  }

  ok(res, { success: true, reportDate });
});

router.get("/sushi/staging", async (req, res) => {
  const batchId = req.query.batchId ? Number(req.query.batchId) : null;
  const status = req.query.status ? String(req.query.status) : null;

  const conditions = [];
  if (batchId) conditions.push(eq(sushiStagingEntriesTable.batchId, batchId));
  if (status) conditions.push(eq(sushiStagingEntriesTable.validationStatus, status));

  const rows = await db
    .select({
      id: sushiStagingEntriesTable.id,
      batchId: sushiStagingEntriesTable.batchId,
      rowNumber: sushiStagingEntriesTable.rowNumber,
      rawFirma: sushiStagingEntriesTable.rawFirma,
      rawRcp: sushiStagingEntriesTable.rawRcp,
      rawDzial: sushiStagingEntriesTable.rawDzial,
      rawOd: sushiStagingEntriesTable.rawOd,
      rawDo: sushiStagingEntriesTable.rawDo,
      rawRealneGodziny: sushiStagingEntriesTable.rawRealneGodziny,
      rawPodpis: sushiStagingEntriesTable.rawPodpis,
      rawUwagi: sushiStagingEntriesTable.rawUwagi,
      resolvedWorkerId: sushiStagingEntriesTable.resolvedWorkerId,
      workerName: workersTable.fullName,
      resolvedLineId: sushiStagingEntriesTable.resolvedLineId,
      lineName: sushiLinesTable.name,
      validationStatus: sushiStagingEntriesTable.validationStatus,
      errorMessage: sushiStagingEntriesTable.errorMessage,
      isProcessed: sushiStagingEntriesTable.isProcessed,
      createdAt: sushiStagingEntriesTable.createdAt,
    })
    .from(sushiStagingEntriesTable)
    .leftJoin(workersTable, eq(sushiStagingEntriesTable.resolvedWorkerId, workersTable.id))
    .leftJoin(sushiLinesTable, eq(sushiStagingEntriesTable.resolvedLineId, sushiLinesTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(sushiStagingEntriesTable.rowNumber));

  ok(res, rows);
});

router.patch("/sushi/staging/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { rawOd, rawDo, rawDzial, rawPodpis, resolvedWorkerId, resolvedLineId, validationStatus } = req.body ?? {};
  if (!id) {
    fail(res, 400, "id обов'язковий");
    return;
  }

  const [row] = await db
    .update(sushiStagingEntriesTable)
    .set({
      ...(rawOd !== undefined ? { rawOd: String(rawOd) } : {}),
      ...(rawDo !== undefined ? { rawDo: String(rawDo) } : {}),
      ...(rawDzial !== undefined ? { rawDzial: String(rawDzial) } : {}),
      ...(rawPodpis !== undefined ? { rawPodpis: String(rawPodpis) } : {}),
      ...(resolvedWorkerId !== undefined ? { resolvedWorkerId: resolvedWorkerId ? Number(resolvedWorkerId) : null } : {}),
      ...(resolvedLineId !== undefined ? { resolvedLineId: resolvedLineId ? Number(resolvedLineId) : null } : {}),
      ...(validationStatus !== undefined ? { validationStatus: String(validationStatus) } : {}),
    })
    .where(eq(sushiStagingEntriesTable.id, id))
    .returning();

  ok(res, row);
});

// Прив'язка аліасу з Staging до існуючого працівника
router.post("/sushi/staging/link-alias", async (req, res) => {
  const { workerId, factoryId, rcpCode, notes, validFrom } = req.body ?? {};
  if (!workerId || !rcpCode) {
    fail(res, 400, "workerId та rcpCode обов'язкові");
    return;
  }

  const normalized = normalizeRcpCode(rcpCode);
  const fid = Number(factoryId) || 1;
  const wid = Number(workerId);

  // Отримуємо компанію працівника
  const [w] = await db.select({ companyId: workersTable.companyId }).from(workersTable).where(eq(workersTable.id, wid));
  const companyId = w?.companyId ?? 1;

  // 1. Додаємо в sushi_worker_codes
  await db
    .insert(sushiWorkerCodesTable)
    .values({
      workerId: wid,
      factoryId: fid,
      companyId,
      rcpCode: normalized,
      validFrom: validFrom ? String(validFrom) : "2020-01-01",
      isPrimary: false,
      notes: notes ? String(notes).trim() : "Linked via Staging",
    })
    .onConflictDoNothing();

  // 2. Оновлюємо всі непідтверджені записи staging з цим RCP
  const stagingRows = await db
    .select()
    .from(sushiStagingEntriesTable)
    .where(and(eq(sushiStagingEntriesTable.rawRcp, normalized), eq(sushiStagingEntriesTable.isProcessed, false)));

  let updatedCount = 0;
  for (const sr of stagingRows) {
    const timeVal = validateTimeInterval(sr.rawOd, sr.rawDo);
    const newStatus = timeVal.valid ? "OK" : "INVALID_TIME";

    await db
      .update(sushiStagingEntriesTable)
      .set({
        resolvedWorkerId: wid,
        validationStatus: newStatus,
        errorMessage: timeVal.valid ? null : timeVal.errorMessage,
      })
      .where(eq(sushiStagingEntriesTable.id, sr.id));

    updatedCount++;
  }

  ok(res, { linkedRcp: normalized, workerId: wid, updatedStagingRows: updatedCount });
});

// Масовий коміт перевірених рядків Staging Area в робочі інтервали
router.post("/sushi/staging/approve-all-valid", async (req, res) => {
  const batchId = Number(req.body?.batchId);
  if (!batchId) {
    fail(res, 400, "batchId обов'язковий");
    return;
  }

  const [batch] = await db.select().from(sushiImportBatchesTable).where(eq(sushiImportBatchesTable.id, batchId));
  if (!batch) {
    fail(res, 404, "Батч не знайдено");
    return;
  }

  if (!batch.reportDate || batch.isDateMissing) {
    fail(
      res,
      400,
      "Неможливо затвердити години: у цьому файлі не вказано дату зміни! Бригадир забув вписати дату в Excel. Будь ласка, вкажіть дату звіту перед затвердженням.",
    );
    return;
  }

  const validEntries = await db
    .select()
    .from(sushiStagingEntriesTable)
    .where(
      and(
        eq(sushiStagingEntriesTable.batchId, batchId),
        eq(sushiStagingEntriesTable.validationStatus, "OK"),
        eq(sushiStagingEntriesTable.isProcessed, false),
      ),
    );

  if (validEntries.length === 0) {
    fail(res, 400, "Немає валідних (OK) рядків для коміту");
    return;
  }

  const factoryId = batch.factoryId;
  const roles = await db.select().from(sushiRolesTable);
  const defaultRole = roles.find((r) => r.code === "worker") || roles[0]!;
  const [fac] = await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId));

  // Отримуємо або використовуємо першу наявну лінію для цієї фабрики як безпечний фолбек
  const factoryLines = await db.select().from(sushiLinesTable).where(eq(sushiLinesTable.factoryId, factoryId));
  const defaultLineId = factoryLines[0]?.id ?? null;

  const candidates = validEntries.map((e) => {
    const timeVal = validateTimeInterval(e.rawOd, e.rawDo);
    const roundedStart = timeVal.roundedStart || roundStartTime(e.rawOd || "06:00");
    const roundedStop = timeVal.roundedStop || roundStopTime(e.rawDo || "14:00");
    const roundedHours = timeVal.hours || calcIntervalHours(roundedStart, roundedStop);

    return {
      stagingId: e.id,
      workerId: e.resolvedWorkerId!,
      factoryId,
      companyId: batch.companyId || 1,
      workDate: batch.reportDate!,
      billingMonth: batch.reportDate!.slice(0, 7),
      startTime: e.rawOd || "06:00",
      stopTime: e.rawDo || "14:00",
      roundedStartTime: roundedStart,
      roundedStopTime: roundedStop,
      rawHours: parseFloat(e.rawRealneGodziny || "0") || roundedHours,
      roundedHours,
      lineId: e.resolvedLineId || defaultLineId,
      roleId: e.resolvedRoleId || defaultRole.id,
      supervisorId: e.resolvedSupervisorId ?? null,
      isTraining: false,
      notes: e.rawUwagi,
    };
  });

  const getRatesFn = (_workerId: number, roleId: number) => {
    const role = roles.find((r) => r.id === roleId) || defaultRole;
    return {
      factoryDefaultWorkerRate: fac?.rateNetto ? Number(fac.rateNetto) : 28.0,
      factoryDefaultClientRate: fac?.invoiceRate ? Number(fac.invoiceRate) : 40.0,
      roleWorkerRate: Number(role.defaultWorkerRate),
      roleClientRate: Number(role.defaultClientRate),
      workerCustomRate: null,
    };
  };

  const prepared = prepareStagingCommit(candidates, getRatesFn);

  // Транзакційне збереження
  let committedCount = 0;
  await db.transaction(async (tx) => {
    for (const p of prepared) {
      const [intRow] = await tx
        .insert(sushiWorkIntervalsTable)
        .values({
          workerId: p.workerId,
          factoryId: p.factoryId,
          companyId: p.companyId,
          lineId: p.lineId,
          roleId: p.roleId,
          supervisorId: p.supervisorId,
          stagingEntryId: p.stagingEntryId,
          workDate: p.workDate,
          billingMonth: p.billingMonth,
          startTime: p.startTime,
          stopTime: p.stopTime,
          roundedStartTime: p.roundedStartTime,
          roundedStopTime: p.roundedStopTime,
          rawHours: p.rawHours,
          roundedHours: p.roundedHours,
          billableHours: p.billableHours,
          payableHours: p.payableHours,
          appliedClientRate: p.appliedClientRate,
          appliedWorkerRate: p.appliedWorkerRate,
          rateSnapshotSource: p.rateSnapshotSource,
          isPrimaryDailyInterval: p.isPrimaryDailyInterval,
          odziezFeeApplicable: p.odziezFeeApplicable,
          status: "SYNCED",
          overrideReason: p.notes,
        })
        .returning({ id: sushiWorkIntervalsTable.id });

      await tx
        .update(sushiStagingEntriesTable)
        .set({
          isProcessed: true,
          validationStatus: "PROCESSED",
          processedIntervalId: intRow!.id,
        })
        .where(eq(sushiStagingEntriesTable.id, p.stagingEntryId));

      committedCount++;
    }

    await tx
      .update(sushiImportBatchesTable)
      .set({ status: "PROCESSED" })
      .where(eq(sushiImportBatchesTable.id, batchId));
  });

  ok(res, { committed: committedCount });
});

// ─── 4. ТАБЕЛЬ РОБОЧИХ ІНТЕРВАЛІВ ──────────────────────────────────────────────

router.get("/sushi/timesheet/:workerId", async (req, res) => {
  const workerId = Number(req.params.workerId);
  if (!workerId) {
    fail(res, 400, "workerId обов'язковий");
    return;
  }

  const intervals = await db
    .select({
      id: sushiWorkIntervalsTable.id,
      workerId: sushiWorkIntervalsTable.workerId,
      workDate: sushiWorkIntervalsTable.workDate,
      billingMonth: sushiWorkIntervalsTable.billingMonth,
      startTime: sushiWorkIntervalsTable.startTime,
      stopTime: sushiWorkIntervalsTable.stopTime,
      roundedStartTime: sushiWorkIntervalsTable.roundedStartTime,
      roundedStopTime: sushiWorkIntervalsTable.roundedStopTime,
      hours: sushiWorkIntervalsTable.roundedHours,
      payableHours: sushiWorkIntervalsTable.payableHours,
      billableHours: sushiWorkIntervalsTable.billableHours,
      lineName: sushiLinesTable.name,
      roleName: sushiRolesTable.name,
      supervisorName: sushiSupervisorsTable.signatureName,
      status: sushiWorkIntervalsTable.status,
      odziezFeeApplicable: sushiWorkIntervalsTable.odziezFeeApplicable,
      notes: sushiWorkIntervalsTable.overrideReason,
    })
    .from(sushiWorkIntervalsTable)
    .leftJoin(sushiLinesTable, eq(sushiWorkIntervalsTable.lineId, sushiLinesTable.id))
    .leftJoin(sushiRolesTable, eq(sushiWorkIntervalsTable.roleId, sushiRolesTable.id))
    .leftJoin(sushiSupervisorsTable, eq(sushiWorkIntervalsTable.supervisorId, sushiSupervisorsTable.id))
    .where(eq(sushiWorkIntervalsTable.workerId, workerId))
    .orderBy(desc(sushiWorkIntervalsTable.workDate));

  const flatList = intervals.map((i) => ({
    ...i,
    lineName: i.lineName ?? undefined,
    roleName: i.roleName ?? undefined,
    supervisorName: i.supervisorName ?? undefined,
  }));

  const tree = buildTimesheetTree(flatList);
  ok(res, { tree, intervalsCount: intervals.length });
});

router.get("/sushi/intervals", async (req, res) => {
  const factoryId = Number(req.query.factoryId) || 1;
  const month = req.query.month ? String(req.query.month) : null;
  const date = req.query.date ? String(req.query.date) : null;
  const workerId = req.query.workerId ? Number(req.query.workerId) : null;

  const conditions = [eq(sushiWorkIntervalsTable.factoryId, factoryId)];
  if (month) conditions.push(eq(sushiWorkIntervalsTable.billingMonth, month));
  if (date) conditions.push(eq(sushiWorkIntervalsTable.workDate, date));
  if (workerId) conditions.push(eq(sushiWorkIntervalsTable.workerId, workerId));

  const rows = await db
    .select({
      id: sushiWorkIntervalsTable.id,
      workerId: sushiWorkIntervalsTable.workerId,
      workerName: workersTable.fullName,
      workerCode: workersTable.workerCode,
      workDate: sushiWorkIntervalsTable.workDate,
      billingMonth: sushiWorkIntervalsTable.billingMonth,
      startTime: sushiWorkIntervalsTable.startTime,
      stopTime: sushiWorkIntervalsTable.stopTime,
      roundedStartTime: sushiWorkIntervalsTable.roundedStartTime,
      roundedStopTime: sushiWorkIntervalsTable.roundedStopTime,
      rawHours: sushiWorkIntervalsTable.rawHours,
      roundedHours: sushiWorkIntervalsTable.roundedHours,
      billableHours: sushiWorkIntervalsTable.billableHours,
      payableHours: sushiWorkIntervalsTable.payableHours,
      lineId: sushiWorkIntervalsTable.lineId,
      lineName: sushiLinesTable.name,
      roleId: sushiWorkIntervalsTable.roleId,
      roleName: sushiRolesTable.name,
      supervisorId: sushiWorkIntervalsTable.supervisorId,
      supervisorName: sushiSupervisorsTable.signatureName,
      status: sushiWorkIntervalsTable.status,
      odziezFeeApplicable: sushiWorkIntervalsTable.odziezFeeApplicable,
      notes: sushiWorkIntervalsTable.overrideReason,
      createdAt: sushiWorkIntervalsTable.createdAt,
    })
    .from(sushiWorkIntervalsTable)
    .leftJoin(workersTable, eq(sushiWorkIntervalsTable.workerId, workersTable.id))
    .leftJoin(sushiLinesTable, eq(sushiWorkIntervalsTable.lineId, sushiLinesTable.id))
    .leftJoin(sushiRolesTable, eq(sushiWorkIntervalsTable.roleId, sushiRolesTable.id))
    .leftJoin(sushiSupervisorsTable, eq(sushiWorkIntervalsTable.supervisorId, sushiSupervisorsTable.id))
    .where(and(...conditions))
    .orderBy(desc(sushiWorkIntervalsTable.workDate), desc(sushiWorkIntervalsTable.id));

  ok(res, rows);
});

router.post("/sushi/intervals", async (req, res) => {
  const { workerId, factoryId, companyId, workDate, startTime, stopTime, lineId, roleId, supervisorId, notes } = req.body ?? {};
  if (!workerId || !workDate || !startTime || !stopTime) {
    fail(res, 400, "workerId, workDate, startTime та stopTime обов'язкові");
    return;
  }

  const timeVal = validateTimeInterval(startTime, stopTime);
  if (!timeVal.valid) {
    fail(res, 400, timeVal.errorMessage || "Некоректний інтервал часу");
    return;
  }

  const wid = Number(workerId);
  const fid = Number(factoryId) || 1;
  const cid = Number(companyId) || 1;
  const lid = Number(lineId) || 1;
  const rid = Number(roleId) || 1;
  const sid = supervisorId ? Number(supervisorId) : null;
  const dateStr = String(workDate);
  const monthStr = dateStr.slice(0, 7);

  // Перевірка чи є це перший інтервал за день (для одягу)
  const existingToday = await db
    .select({ id: sushiWorkIntervalsTable.id })
    .from(sushiWorkIntervalsTable)
    .where(and(eq(sushiWorkIntervalsTable.workerId, wid), eq(sushiWorkIntervalsTable.workDate, dateStr)));

  const isPrimary = existingToday.length === 0;

  const [role] = await db.select().from(sushiRolesTable).where(eq(sushiRolesTable.id, rid));
  const clientRate = role ? Number(role.defaultClientRate) : 40.0;
  const workerRate = role ? Number(role.defaultWorkerRate) : 28.0;

  const [row] = await db
    .insert(sushiWorkIntervalsTable)
    .values({
      workerId: wid,
      factoryId: fid,
      companyId: cid,
      lineId: lid,
      roleId: rid,
      supervisorId: sid,
      workDate: dateStr,
      billingMonth: monthStr,
      startTime: timeVal.normalizedStart!,
      stopTime: timeVal.normalizedStop!,
      roundedStartTime: timeVal.roundedStart!,
      roundedStopTime: timeVal.roundedStop!,
      rawHours: timeVal.hours!,
      roundedHours: timeVal.hours!,
      billableHours: clientRate === 0 ? 0 : timeVal.hours!,
      payableHours: timeVal.hours!,
      appliedClientRate: clientRate,
      appliedWorkerRate: workerRate,
      rateSnapshotSource: "ROLE_DEFAULT",
      isPrimaryDailyInterval: isPrimary,
      odziezFeeApplicable: isPrimary,
      status: "SYNCED",
      createdVia: "MANUAL_ADMIN",
      overrideReason: notes ? String(notes).trim() : null,
    })
    .returning();

  ok(res, row);
});

router.patch("/sushi/intervals/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    fail(res, 400, "id обов'язковий");
    return;
  }

  const { startTime, stopTime, lineId, roleId, supervisorId, status, notes } = req.body ?? {};

  const patch: any = { updatedAt: new Date(), isManualOverride: true };
  if (lineId !== undefined) patch.lineId = Number(lineId);
  if (roleId !== undefined) patch.roleId = Number(roleId);
  if (supervisorId !== undefined) patch.supervisorId = supervisorId ? Number(supervisorId) : null;
  if (status !== undefined) patch.status = String(status);
  if (notes !== undefined) patch.overrideReason = notes ? String(notes).trim() : null;

  if (startTime !== undefined || stopTime !== undefined) {
    const [curr] = await db.select().from(sushiWorkIntervalsTable).where(eq(sushiWorkIntervalsTable.id, id));
    if (!curr) {
      fail(res, 404, "Інтервал не знайдено");
      return;
    }

    const st = startTime !== undefined ? String(startTime) : curr.startTime;
    const sp = stopTime !== undefined ? String(stopTime) : curr.stopTime;

    const timeVal = validateTimeInterval(st, sp);
    if (!timeVal.valid) {
      fail(res, 400, timeVal.errorMessage || "Некоректний час");
      return;
    }

    patch.startTime = timeVal.normalizedStart;
    patch.stopTime = timeVal.normalizedStop;
    patch.roundedStartTime = timeVal.roundedStart;
    patch.roundedStopTime = timeVal.roundedStop;
    patch.roundedHours = timeVal.hours;
    patch.payableHours = timeVal.hours;
    if (curr.appliedClientRate > 0) patch.billableHours = timeVal.hours;
  }

  const [row] = await db.update(sushiWorkIntervalsTable).set(patch).where(eq(sushiWorkIntervalsTable.id, id)).returning();
  ok(res, row);
});

router.delete("/sushi/intervals/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    fail(res, 400, "id обов'язковий");
    return;
  }
  await db.delete(sushiWorkIntervalsTable).where(eq(sushiWorkIntervalsTable.id, id));
  ok(res);
});

// ─── 5. ДИСПУТИ ТА СКАРГИ ──────────────────────────────────────────────────────

router.get("/sushi/disputes", async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const month = req.query.month ? String(req.query.month) : null;

  const conditions = [];
  if (status) conditions.push(eq(sushiDisputesTable.status, status));
  if (month) conditions.push(eq(sushiDisputesTable.billingMonth, month));

  const rows = await db
    .select({
      id: sushiDisputesTable.id,
      workerId: sushiDisputesTable.workerId,
      workerName: workersTable.fullName,
      workerCode: workersTable.workerCode,
      workIntervalId: sushiDisputesTable.workIntervalId,
      disputeType: sushiDisputesTable.disputeType,
      targetDate: sushiDisputesTable.targetDate,
      billingMonth: sushiDisputesTable.billingMonth,
      claimedStartTime: sushiDisputesTable.claimedStartTime,
      claimedStopTime: sushiDisputesTable.claimedStopTime,
      claimedHours: sushiDisputesTable.claimedHours,
      claimedLineId: sushiDisputesTable.claimedLineId,
      claimedLineName: sushiLinesTable.name,
      workerComment: sushiDisputesTable.workerComment,
      status: sushiDisputesTable.status,
      resolutionAction: sushiDisputesTable.resolutionAction,
      adminResolutionNote: sushiDisputesTable.adminResolutionNote,
      resolvedAt: sushiDisputesTable.resolvedAt,
      createdAt: sushiDisputesTable.createdAt,
    })
    .from(sushiDisputesTable)
    .leftJoin(workersTable, eq(sushiDisputesTable.workerId, workersTable.id))
    .leftJoin(sushiLinesTable, eq(sushiDisputesTable.claimedLineId, sushiLinesTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(sushiDisputesTable.id));

  ok(res, rows);
});

router.post("/sushi/disputes", async (req, res) => {
  const { workerId, workIntervalId, disputeType, targetDate, claimedStartTime, claimedStopTime, claimedHours, claimedLineId, workerComment } = req.body ?? {};
  if (!workerId || !targetDate || !disputeType) {
    fail(res, 400, "workerId, targetDate та disputeType обов'язкові");
    return;
  }

  const [row] = await db
    .insert(sushiDisputesTable)
    .values({
      workerId: Number(workerId),
      workIntervalId: workIntervalId ? Number(workIntervalId) : null,
      disputeType: String(disputeType),
      targetDate: String(targetDate),
      billingMonth: String(targetDate).slice(0, 7),
      claimedStartTime: claimedStartTime ? String(claimedStartTime) : null,
      claimedStopTime: claimedStopTime ? String(claimedStopTime) : null,
      claimedHours: claimedHours ? Number(claimedHours) : null,
      claimedLineId: claimedLineId ? Number(claimedLineId) : null,
      workerComment: workerComment ? String(workerComment).trim() : null,
      status: "OPEN",
    })
    .returning();

  ok(res, row);
});

router.post("/sushi/disputes/:id/resolve", async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { action, note, startTime, stopTime, lineId, supervisorId, applyPenaltyToSupervisor, penaltyAmount } = req.body ?? {};
  if (!id) {
    fail(res, 400, "id обов'язковий");
    return;
  }

  const [dispute] = await db.select().from(sushiDisputesTable).where(eq(sushiDisputesTable.id, id));
  if (!dispute) {
    fail(res, 404, "Диспут не знайдено");
    return;
  }

  await db.transaction(async (tx) => {
    let penaltyId: number | null = null;

    // Списання штрафу з бригадира за помилку
    if (applyPenaltyToSupervisor && supervisorId && penaltyAmount) {
      const [sup] = await tx.select().from(sushiSupervisorsTable).where(eq(sushiSupervisorsTable.id, Number(supervisorId)));
      if (sup && sup.workerId) {
        const [pen] = await tx
          .insert(penaltiesTable)
          .values({
            workerId: sup.workerId,
            periodMonth: dispute.billingMonth,
            amount: Number(penaltyAmount),
            factoryId: 1,
            note: `Штраф за непідтверджені години (Диспут #${dispute.id} працівника #${dispute.workerId})`,
            deducted: false,
          })
          .returning({ id: penaltiesTable.id });
        penaltyId = pen?.id ?? null;
      }
    }

    if (action === "CREATED_NEW_INTERVAL" || (!dispute.workIntervalId && (startTime || dispute.claimedStartTime))) {
      const st = startTime || dispute.claimedStartTime || "06:00";
      const sp = stopTime || dispute.claimedStopTime || "14:00";
      const timeVal = validateTimeInterval(st, sp);

      await tx.insert(sushiWorkIntervalsTable).values({
        workerId: dispute.workerId,
        factoryId: 1,
        companyId: 1,
        lineId: lineId ? Number(lineId) : dispute.claimedLineId || 1,
        roleId: 1,
        supervisorId: supervisorId ? Number(supervisorId) : null,
        workDate: dispute.targetDate,
        billingMonth: dispute.billingMonth,
        startTime: timeVal.normalizedStart || st,
        stopTime: timeVal.normalizedStop || sp,
        roundedStartTime: timeVal.roundedStart || roundStartTime(st),
        roundedStopTime: timeVal.roundedStop || roundStopTime(sp),
        rawHours: timeVal.hours || 8.0,
        roundedHours: timeVal.hours || 8.0,
        billableHours: timeVal.hours || 8.0,
        payableHours: timeVal.hours || 8.0,
        appliedClientRate: 40.0,
        appliedWorkerRate: 28.0,
        rateSnapshotSource: "ROLE_DEFAULT",
        isPrimaryDailyInterval: true,
        odziezFeeApplicable: true,
        status: "CONFIRMED",
        createdVia: "DISPUTE",
        overrideReason: `Створено за диспутом #${dispute.id}`,
      });
    } else if (dispute.workIntervalId && (startTime || stopTime)) {
      const [curr] = await tx.select().from(sushiWorkIntervalsTable).where(eq(sushiWorkIntervalsTable.id, dispute.workIntervalId));
      if (curr) {
        const st = startTime || curr.startTime;
        const sp = stopTime || curr.stopTime;
        const timeVal = validateTimeInterval(st, sp);
        if (timeVal.valid) {
          await tx
            .update(sushiWorkIntervalsTable)
            .set({
              startTime: timeVal.normalizedStart!,
              stopTime: timeVal.normalizedStop!,
              roundedStartTime: timeVal.roundedStart!,
              roundedStopTime: timeVal.roundedStop!,
              roundedHours: timeVal.hours!,
              payableHours: timeVal.hours!,
              billableHours: curr.appliedClientRate > 0 ? timeVal.hours! : 0,
              status: "CONFIRMED",
              updatedAt: new Date(),
            })
            .where(eq(sushiWorkIntervalsTable.id, dispute.workIntervalId));
        }
      }
    }

    await tx
      .update(sushiDisputesTable)
      .set({
        status: "RESOLVED",
        resolutionAction: action || "RESOLVED",
        adminResolutionNote: note ? String(note).trim() : null,
        resolvedByAdminId: req.admin?.adminId ?? null,
        resolvedAt: new Date(),
        supervisorPenaltyApplied: !!penaltyId,
        penaltyId,
      })
      .where(eq(sushiDisputesTable.id, id));
  });

  ok(res);
});

router.post("/sushi/disputes/:id/reject", async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { note } = req.body ?? {};
  if (!id) {
    fail(res, 400, "id обов'язковий");
    return;
  }

  await db
    .update(sushiDisputesTable)
    .set({
      status: "REJECTED",
      resolutionAction: "REJECTED",
      adminResolutionNote: note ? String(note).trim() : "Відхилено",
      resolvedByAdminId: req.admin?.adminId ?? null,
      resolvedAt: new Date(),
    })
    .where(eq(sushiDisputesTable.id, id));

  ok(res);
});

// ─── 6. ФІНАНСИ, ZAŁĄCZNIK ТА ЗВІРКА ───────────────────────────────────────────

router.get("/sushi/finance/zalacznik", async (req, res) => {
  const factoryId = Number(req.query.factoryId) || 1;
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;

  const intervals = await db
    .select({
      id: sushiWorkIntervalsTable.id,
      workerId: sushiWorkIntervalsTable.workerId,
      workDate: sushiWorkIntervalsTable.workDate,
      companyId: sushiWorkIntervalsTable.companyId,
      roleCode: sushiRolesTable.code,
      roleName: sushiRolesTable.name,
      billableHours: sushiWorkIntervalsTable.billableHours,
      appliedClientRate: sushiWorkIntervalsTable.appliedClientRate,
      odziezFeeApplicable: sushiWorkIntervalsTable.odziezFeeApplicable,
    })
    .from(sushiWorkIntervalsTable)
    .leftJoin(sushiRolesTable, eq(sushiWorkIntervalsTable.roleId, sushiRolesTable.id))
    .where(
      and(
        eq(sushiWorkIntervalsTable.factoryId, factoryId),
        eq(sushiWorkIntervalsTable.billingMonth, month),
      ),
    );

  const mappedIntervals = intervals.map((i) => ({
    id: i.id,
    workerId: i.workerId,
    workDate: i.workDate,
    companyId: i.companyId,
    roleCode: i.roleCode || "worker",
    roleName: i.roleName || "Pracownik Fizyczny",
    billableHours: Number(i.billableHours),
    appliedClientRate: Number(i.appliedClientRate),
    odziezFeeApplicable: i.odziezFeeApplicable,
  }));

  const penaltiesAmount = Number(req.query.penalties || 0);
  const adjustmentsAmount = Number(req.query.adjustments || 0);

  const result = calculateSushiZalacznik({
    periodMonth: month,
    factoryId,
    companyId,
    intervals: mappedIntervals,
    contractualPenalties: penaltiesAmount,
    adjustments: adjustmentsAmount,
  });

  ok(res, result);
});

router.post("/sushi/finance/zalacznik/lock", async (req: AuthedRequest, res) => {
  const { factoryId, companyId, periodMonth, totalBillableHours, totalLaborCostNet, totalOdziezDaysCount, totalOdziezDeductionNet, totalContractualPenalties, otherAdjustmentsNet, finalInvoiceNet, details } = req.body ?? {};
  if (!periodMonth) {
    fail(res, 400, "periodMonth обов'язковий");
    return;
  }

  const [row] = await db
    .insert(sushiZalacznikSummariesTable)
    .values({
      factoryId: Number(factoryId) || 1,
      companyId: Number(companyId) || 1,
      periodMonth: String(periodMonth),
      totalBillableHours: Number(totalBillableHours) || 0,
      totalLaborCostNet: Number(totalLaborCostNet) || 0,
      totalOdziezDaysCount: Number(totalOdziezDaysCount) || 0,
      totalOdziezDeductionNet: Number(totalOdziezDeductionNet) || 0,
      totalContractualPenalties: Number(totalContractualPenalties) || 0,
      otherAdjustmentsNet: Number(otherAdjustmentsNet) || 0,
      finalInvoiceNet: Number(finalInvoiceNet) || 0,
      details: details || {},
      isLocked: true,
      lockedAt: new Date(),
      lockedByAdminId: req.admin?.adminId ?? null,
    })
    .onConflictDoUpdate({
      target: [sushiZalacznikSummariesTable.factoryId, sushiZalacznikSummariesTable.companyId, sushiZalacznikSummariesTable.periodMonth],
      set: {
        totalBillableHours: Number(totalBillableHours) || 0,
        totalLaborCostNet: Number(totalLaborCostNet) || 0,
        totalOdziezDaysCount: Number(totalOdziezDaysCount) || 0,
        totalOdziezDeductionNet: Number(totalOdziezDeductionNet) || 0,
        totalContractualPenalties: Number(totalContractualPenalties) || 0,
        otherAdjustmentsNet: Number(otherAdjustmentsNet) || 0,
        finalInvoiceNet: Number(finalInvoiceNet) || 0,
        details: details || {},
        isLocked: true,
        lockedAt: new Date(),
        lockedByAdminId: req.admin?.adminId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  ok(res, row);
});

router.get("/sushi/finance/reconciliation", async (req, res) => {
  const factoryId = Number(req.query.factoryId) || 1;
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));

  // Отримуємо внутрішні інтервали
  const internalRows = await db
    .select({
      id: sushiWorkIntervalsTable.id,
      workerId: sushiWorkIntervalsTable.workerId,
      workDate: sushiWorkIntervalsTable.workDate,
      companyId: sushiWorkIntervalsTable.companyId,
      roleCode: sushiRolesTable.code,
      roleName: sushiRolesTable.name,
      billableHours: sushiWorkIntervalsTable.billableHours,
      appliedClientRate: sushiWorkIntervalsTable.appliedClientRate,
      odziezFeeApplicable: sushiWorkIntervalsTable.odziezFeeApplicable,
    })
    .from(sushiWorkIntervalsTable)
    .leftJoin(sushiRolesTable, eq(sushiWorkIntervalsTable.roleId, sushiRolesTable.id))
    .where(
      and(
        eq(sushiWorkIntervalsTable.factoryId, factoryId),
        eq(sushiWorkIntervalsTable.billingMonth, month),
      ),
    );

  const internalIntervals = internalRows.map((i) => ({
    id: i.id,
    workerId: i.workerId,
    workDate: i.workDate,
    companyId: i.companyId,
    roleCode: i.roleCode || "worker",
    roleName: i.roleName || "Pracownik Fizyczny",
    billableHours: Number(i.billableHours),
    appliedClientRate: Number(i.appliedClientRate),
    odziezFeeApplicable: i.odziezFeeApplicable,
  }));

  // Отримуємо сирі години зі Staging за цей місяць
  const stagingRows = await db
    .select({
      workerId: sushiStagingEntriesTable.resolvedWorkerId,
      reportDate: sushiImportBatchesTable.reportDate,
      rawHours: sushiStagingEntriesTable.rawRealneGodziny,
    })
    .from(sushiStagingEntriesTable)
    .innerJoin(sushiImportBatchesTable, eq(sushiStagingEntriesTable.batchId, sushiImportBatchesTable.id))
    .where(
      and(
        eq(sushiImportBatchesTable.factoryId, factoryId),
        gte(sushiImportBatchesTable.reportDate, `${month}-01`),
        lte(sushiImportBatchesTable.reportDate, `${month}-31`),
      ),
    );

  const factoryRecords = stagingRows
    .filter((s) => s.workerId != null && s.reportDate != null)
    .map((s) => ({
      workerId: s.workerId!,
      workDate: s.reportDate!,
      factoryHours: parseFloat(s.rawHours || "0") || 0,
    }));

  const exceptions = await db
    .select({
      workerId: sushiReconciliationExceptionsTable.workerId,
      fromDate: sushiReconciliationExceptionsTable.fromDate,
      toDate: sushiReconciliationExceptionsTable.toDate,
      reason: sushiReconciliationExceptionsTable.reason,
    })
    .from(sushiReconciliationExceptionsTable)
    .where(eq(sushiReconciliationExceptionsTable.factoryId, factoryId));

  const report = reconcileSushiHours(factoryRecords, internalIntervals, exceptions);
  ok(res, report);
});

router.post("/sushi/finance/exceptions", async (req: AuthedRequest, res) => {
  const { factoryId, workerId, fromDate, toDate, reason } = req.body ?? {};
  if (!workerId || !fromDate || !toDate || !reason) {
    fail(res, 400, "workerId, fromDate, toDate та reason обов'язкові");
    return;
  }

  const [row] = await db
    .insert(sushiReconciliationExceptionsTable)
    .values({
      factoryId: Number(factoryId) || 1,
      workerId: Number(workerId),
      fromDate: String(fromDate),
      toDate: String(toDate),
      reason: String(reason).trim(),
      approvedByAdminId: req.admin?.adminId ?? 1,
    })
    .returning();

  ok(res, row);
});

export default router;
