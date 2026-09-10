// «Документи й підписання» (cap `workerDocs`) — генерація умов (umowa
// zlecenie) із шаблону, онлайн-підписання пальцем, анкета працівника з OCR
// паспорта, облік строків дії документів. МОДУЛЬ У РОЗРОБЦІ
// (гілка feature/worker-docs-signing). Маршрути під кількома префіксами
// (/contracts, /workers/:id/questionnaire, ...) — cap гейт per-route (WD),
// не router.use(), щоб не повторити регресію з неупакованим use-гейтом
// (CLAUDE.md: скоупити по префіксу шляху).
//
// Публічні токен-роути підписання (§5 плану) — окремий файл routes/sign.ts,
// БЕЗ authRequired (токен у шляху — єдина авторизація). Виявилось, що CSRF-
// гейту app.ts виняток не потрібен: сторінка /sign/:token — наш власний
// same-origin фронтенд і шле X-Requested-With через ту саму обгортку
// api()/post(), що й решта панелі (на відміну від /auth/login, де лишився
// застарілий «сирий» fetch без цього заголовка).
import { Router, type IRouter } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  db, workerQuestionnairesTable, workerDocumentsTable, documentTypesTable,
  contractsTable, contractFilesTable, signatureTokensTable, signatureEventsTable,
  workersTable, factoriesTable, companiesTable,
} from "@workspace/db";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";
import { WORKER_DOCS_DIR, UPLOADS_ROOT, makeStoredName, sniffDocMime, compressUploadImage } from "../lib/uploads";
import { processPassport, passportOcrConfigured, mrzNationalityToCatalog, type PassportDraft, type MrzResult } from "../services/docai";
import { generateContract, updateContractDates, finalizeContractSignature, resolveDocumentSet, resolveContractDuties, sendContractForSignature } from "../services/contracts";
import { ensureDocumentType } from "../services/workerDocuments";
import { randomInviteCode } from "../lib/invite";
import { sendSignLink } from "../bot/notify";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(authRequired);
const WD = requireCap("workerDocs");

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });

// Інбокс умов (§10 плану) — фільтр ?status=pending_approval і т.п.
router.get("/contracts", WD, async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const rows = await db.select({
    id: contractsTable.id, workerId: contractsTable.workerId, factoryId: contractsTable.factoryId,
    status: contractsTable.status, dateFrom: contractsTable.dateFrom, dateTo: contractsTable.dateTo,
    generatedAt: contractsTable.generatedAt, approvedAt: contractsTable.approvedAt,
    sentAt: contractsTable.sentAt, signedAt: contractsTable.signedAt, supersedesId: contractsTable.supersedesId,
    workerName: workersTable.fullName, factoryName: factoriesTable.name,
  }).from(contractsTable)
    .leftJoin(workersTable, eq(contractsTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(contractsTable.factoryId, factoriesTable.id))
    .where(status ? eq(contractsTable.status, status) : undefined)
    .orderBy(desc(contractsTable.id));
  ok(res, rows);
});

// Авторезолвлений чекліст документів для працівника — factoryId=опущено/null
// → сталий пакет (ZUS/tax/PPK/BHP/wniosek*), factoryId=N → факторі-пакет
// (Umowa/Regulamin/andros_extra). Веб показує це як чекліст перед генерацією,
// адмін може зняти/додати пункти (POST .../contracts приймає templateIds).
router.get("/workers/:id/document-set", WD, async (req, res) => {
  const workerId = Number(req.params.id);
  const factoryId = req.query.factoryId ? Number(req.query.factoryId) : null;
  try {
    const templates = await resolveDocumentSet(workerId, factoryId);
    ok(res, templates.map(t => ({ id: t.id, kind: t.kind, title: t.title })));
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося підібрати комплект");
  }
});

// ─── Анкета працівника (паспорт + адмін-дані для генерації umowa zlecenie) ──────
const QUESTIONNAIRE_TEXT_FIELDS = [
  "passportNumber", "passportCountry", "birthPlace", "sex", "citizenship",
  "addressRegistered", "addressPl", "postalCode", "city", "motherName", "fatherName", "bankName", "bankIban",
  "phone", "email", "taxOffice", "nfzBranch", "schoolName", "seriaINumerDowodu",
  "emergencyContact", "otherEmploymentNote", "nip", "taxOfficeAddress",
  "regWojewodztwo", "regPowiat", "regGmina", "regMiejscowosc", "regUlica", "regNumerDomu", "regKodPocztowy",
  "zamWojewodztwo", "zamPowiat", "zamGmina", "zamMiejscowosc", "zamUlica", "zamNumerDomu", "zamKodPocztowy",
] as const;
const QUESTIONNAIRE_DATE_FIELDS = ["passportIssuedAt", "passportExpiresAt"] as const;
const QUESTIONNAIRE_BOOL_FIELDS = [
  "isStudent", "hasOtherEmployment", "isRegisteredUnemployed", "waivesTaxAdvance", "pit0",
  "ankietaInnyPracodawca", "ankietaEmeryt", "ankietaRencista", "ankietaNiepelnosprawnosc", "ankietaSkladkaChorobowa",
] as const;

router.get("/workers/:id/questionnaire", WD, async (req, res) => {
  const workerId = Number(req.params.id);
  const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  ok(res, q ?? null);
});

// Upsert — анкета редагується поетапно (офіс/працівник), одна на людину.
// status приймається лише draft|submitted тут; verified — виключно через /verify,
// щоб випадкова правка поля не могла тихо підтвердити ще не перевірені дані.
router.put("/workers/:id/questionnaire", WD, async (req, res) => {
  const workerId = Number(req.params.id);
  const body = req.body ?? {};
  if (body.status !== undefined && !["draft", "submitted"].includes(body.status)) {
    return fail(res, 400, "status може бути лише draft або submitted (verified — через /verify)");
  }
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of QUESTIONNAIRE_TEXT_FIELDS) if (body[k] !== undefined) patch[k] = String(body[k]).trim() || null;
  for (const k of QUESTIONNAIRE_DATE_FIELDS) if (body[k] !== undefined) patch[k] = body[k] || null;
  for (const k of QUESTIONNAIRE_BOOL_FIELDS) if (body[k] !== undefined) patch[k] = !!body[k];
  if (body.payoutMethod !== undefined) {
    if (!["konto", "reka"].includes(body.payoutMethod)) return fail(res, 400, "payoutMethod може бути лише konto або reka");
    patch.payoutMethod = body.payoutMethod;
  }
  if (body.status !== undefined) patch.status = body.status;
  if (body.status === "submitted") patch.submittedAt = new Date();

  const [existing] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  const [q] = existing
    ? await db.update(workerQuestionnairesTable).set(patch).where(eq(workerQuestionnairesTable.workerId, workerId)).returning()
    : await db.insert(workerQuestionnairesTable).values({ workerId, ...patch }).returning();
  // поля, які людина реально змінила цим збереженням — їх значення виграє над профілем
  const changed = new Set(["citizenship", "sex"].filter(k => existing ? (existing as any)[k] !== (patch as any)[k] && patch[k] !== undefined : patch[k] != null));

  // Ім'я/по-батькові/прізвище — поля workersTable, не анкети (той самий поділ,
  // що routes/passportScan.ts) — офіс редагує напряму, fullName НЕ чіпаємо
  // (канонічне поле для сортування/матчингу/бота лишається як є).
  const namePatch: Record<string, unknown> = {};
  if (body.firstName !== undefined) namePatch.firstName = String(body.firstName).trim() || null;
  if (body.middleName !== undefined) namePatch.middleName = String(body.middleName).trim() || null;
  if (body.lastName !== undefined) namePatch.lastName = String(body.lastName).trim() || null;
  if (Object.keys(namePatch).length) await db.update(workersTable).set(namePatch).where(eq(workersTable.id, workerId));
  // анкета → профіль (громадянство/стать) + перерахунок світлофорів легальності
  await syncProfileFromQuestionnaire(workerId, {
    citizenship: q?.citizenship ?? null, sex: q?.sex ?? null,
    passportNumber: q?.passportNumber ?? null, passportExpiresAt: q?.passportExpiresAt ?? null,
  }, changed);

  ok(res, q);
});

// Анкета — джерело фактів про особу; поля-двійники профілю (nationality ← citizenship
// MRZ, gender ← sex, birthDate ← MRZ при скані) підтягуються самі (рішення власника
// 03.09.2026: «поля анкети мають бути зв'язані з полями профілю»). Правило, щоб не
// затирати ручні правки профілю OCR-помилкою: пишемо, якщо поле профілю порожнє АБО
// саме це поле щойно змінили в анкеті (changed). is_student анкети НЕ синкається —
// це payroll-поле профілю (інваріант listy płac). Після синку — перерахунок worker_legality.
async function syncProfileFromQuestionnaire(
  workerId: number, src: { citizenship: string | null; sex: string | null; birthDate?: string | null; passportNumber?: string | null; passportExpiresAt?: string | null },
  changed: Set<string> = new Set(),
): Promise<void> {
  try {
    const [w] = await db.select({ nationality: workersTable.nationality, gender: workersTable.gender, birthDate: workersTable.birthDate }).from(workersTable).where(eq(workersTable.id, workerId));
    if (!w) return;
    const patch: Record<string, unknown> = {};
    const nat = mrzNationalityToCatalog(src.citizenship);
    if (nat && (!w.nationality || changed.has("citizenship")) && nat !== w.nationality) patch.nationality = nat;
    const gender = src.sex === "M" ? "male" : src.sex === "F" ? "female" : null;
    if (gender && (!w.gender || changed.has("sex")) && gender !== w.gender) patch.gender = gender;
    if (src.birthDate && /^\d{4}-\d{2}-\d{2}$/.test(src.birthDate) && !w.birthDate) patch.birthDate = src.birthDate;
    if (Object.keys(patch).length) await db.update(workersTable).set(patch).where(eq(workersTable.id, workerId));
    // паспорт як документ: номер і строк з анкети → рядок «Paszport» (present), щоб список документів
    // і движок бачили строк без ручного дублювання
    if (src.passportNumber !== undefined || src.passportExpiresAt !== undefined) {
      const [pdoc] = await db.select({ id: workerDocumentsTable.id, number: workerDocumentsTable.number, expiresAt: workerDocumentsTable.expiresAt })
        .from(workerDocumentsTable).innerJoin(documentTypesTable, eq(workerDocumentsTable.docTypeId, documentTypesTable.id))
        .where(and(eq(workerDocumentsTable.workerId, workerId), eq(documentTypesTable.code, "passport"), ne(workerDocumentsTable.status, "missing")))
        .orderBy(desc(workerDocumentsTable.id)).limit(1);
      if (pdoc) {
        const dp: Record<string, unknown> = {};
        if (src.passportNumber && src.passportNumber !== pdoc.number) dp.number = src.passportNumber;
        if (src.passportExpiresAt && /^\d{4}-\d{2}-\d{2}$/.test(src.passportExpiresAt) && src.passportExpiresAt !== pdoc.expiresAt) dp.expiresAt = src.passportExpiresAt;
        if (Object.keys(dp).length) await db.update(workerDocumentsTable).set({ ...dp, updatedAt: new Date() }).where(eq(workerDocumentsTable.id, pdoc.id));
      }
    }
    const { workerLegalityChanged } = await import("../services/documentEvents");
    await workerLegalityChanged(workerId);
  } catch (e) { logger.warn({ err: String(e), workerId }, "profile sync from questionnaire failed"); }
}

router.post("/workers/:id/questionnaire/verify", WD, async (req: AuthedRequest, res) => {
  const workerId = Number(req.params.id);
  const [existing] = await db.select({ id: workerQuestionnairesTable.id }).from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  if (!existing) return fail(res, 404, "Анкета ще не заповнена");
  const [q] = await db.update(workerQuestionnairesTable).set({
    status: "verified", verifiedBy: req.admin?.adminId ?? null, verifiedAt: new Date(), updatedAt: new Date(),
  }).where(eq(workerQuestionnairesTable.workerId, workerId)).returning();
  await syncProfileFromQuestionnaire(workerId, {
    citizenship: q?.citizenship ?? null, sex: q?.sex ?? null,
    passportNumber: q?.passportNumber ?? null, passportExpiresAt: q?.passportExpiresAt ?? null,
  });
  ok(res, q);
});

// ─── Скан паспорта (OCR → чернетка анкети) ──────────────────────────────────────
// Спільна логіка для веб-кнопки «Сканувати паспорт» (нижче) і бот-хендлера
// bot/handlers/passportScan.ts — за зразком createScannedInvoice у
// routes/costInvoices.ts (одна функція, два виклики).
const SCAN_MIME_WHITELIST = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]);
const uploadScan = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const PASSPORT_DRAFT_FIELDS = ["passportNumber", "passportCountry", "passportIssuedAt", "passportExpiresAt", "citizenship", "sex"] as const;

export async function applyPassportScan(workerId: number, rawBuffer: Buffer, rawName: string): Promise<{
  documentId: number; questionnaire: typeof workerQuestionnairesTable.$inferSelect; draft: PassportDraft; mrz: MrzResult | null;
  nameDraft: { firstName: string | null; middleName: string | null; lastName: string | null };
}> {
  const rawMime = sniffDocMime(rawBuffer);
  if (!rawMime || !SCAN_MIME_WHITELIST.has(rawMime)) throw new Error("Тип файлу не підтверджено вмістом");
  // на диск — стиснута копія; OCR нижче отримує оригінал (normalizeForOcr робить своє)
  const { buffer: storedBuffer, mime: realMime, fileName: originalName } = await compressUploadImage(rawBuffer, rawMime, rawName);
  const buffer = rawBuffer;

  const docType = await ensureDocumentType("passport");

  const storedName = makeStoredName(originalName);
  await fs.promises.writeFile(path.join(WORKER_DOCS_DIR, storedName), storedBuffer);
  const [doc] = await db.insert(workerDocumentsTable).values({
    workerId, docTypeId: docType.id, title: docType.name, status: "present", source: "ocr",
    filePath: path.join("worker-documents", storedName), fileName: originalName, fileMime: realMime,
  }).returning();

  const { draft, mrz } = await processPassport(buffer, rawMime);
  logger.info({ workerId, documentId: doc!.id, mrzValid: mrz?.documentNumberValid ?? null }, "passport scan applied");

  // OCR ніколи не перезаписує вже ПІДТВЕРДЖЕНУ анкету — лише прикладає сирий
  // результат для довідки; людина сама вирішує, чи оновлювати підтверджені поля.
  const [existing] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  const ocrPatch: Record<string, unknown> = { ocrRaw: { draft, mrz }, ocrDocId: doc!.id, updatedAt: new Date() };
  if (!existing || existing.status !== "verified") {
    for (const k of PASSPORT_DRAFT_FIELDS) if (draft[k]) ocrPatch[k] = draft[k];
  }
  const [questionnaire] = existing
    ? await db.update(workerQuestionnairesTable).set(ocrPatch).where(eq(workerQuestionnairesTable.workerId, workerId)).returning()
    : await db.insert(workerQuestionnairesTable).values({ workerId, ...ocrPatch }).returning();

  // номер і строк паспорта з MRZ → на документ (список документів і движок легальності читають number/expires_at)
  const docPatch: Record<string, unknown> = {};
  if (draft.passportExpiresAt) docPatch.expiresAt = draft.passportExpiresAt;
  if (draft.passportNumber) docPatch.number = draft.passportNumber;
  if (Object.keys(docPatch).length) await db.update(workerDocumentsTable).set(docPatch).where(eq(workerDocumentsTable.id, doc!.id));
  // MRZ → профіль (громадянство/стать/дата народження — лише порожні поля; OCR ще не підтверджений) + перерахунок
  await syncProfileFromQuestionnaire(workerId, {
    citizenship: draft.citizenship ?? questionnaire?.citizenship ?? null, sex: draft.sex ?? questionnaire?.sex ?? null, birthDate: draft.birthDate,
  });

  // Ім'я/по-батькові/прізвище — поля workersTable, не анкети (той самий поділ,
  // що routes/passportScan.ts) — офіс підтверджує/править у QuestionnaireModal,
  // сюди лише пропонуємо чернетку, нічого не пишемо в workersTable сам.
  const nameDraft = { firstName: draft.firstName, middleName: draft.middleName, lastName: draft.lastName };

  return { documentId: doc!.id, questionnaire: questionnaire!, draft, mrz, nameDraft };
}

router.post("/workers/:id/passport-scan", WD, uploadScan.single("file"), async (req, res) => {
  const workerId = Number(req.params.id);
  if (!req.file) return fail(res, 400, "Файл не отримано (недопустимий тип або завеликий)");
  const realMime = sniffDocMime(req.file.buffer);
  if (!realMime || !SCAN_MIME_WHITELIST.has(realMime)) return fail(res, 400, "Тип файлу не підтверджено вмістом");
  if (!passportOcrConfigured()) return fail(res, 501, "OCR паспорта не налаштований на цьому сервері (GOOGLE_DOCAI_KEY_FILE)");
  try {
    const result = await applyPassportScan(workerId, req.file.buffer, Buffer.from(req.file.originalname, "latin1").toString("utf8"));
    ok(res, result);
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося розпізнати паспорт");
  }
});

// ─── Генерація умов (§4/§12 Етап 3) ─────────────────────────────────────────────
// dateFrom/dateTo необов'язкові тут — умову можна підготувати заздалегідь
// (шаблон, паспорт, анкета вже готові), поки чекаємо запрошення/карту побиту/
// статус студента; дати дописуються пізніше через PATCH .../dates.
// factoryId відсутній/null → сталий пакет; templateIds — ручний override
// чекліста (§2.2 плану), інакше автовибір через resolveDocumentSet.
router.post("/workers/:id/contracts", WD, async (req, res) => {
  const workerId = Number(req.params.id);
  const { factoryId, templateIds, dateFrom, dateTo, supersedesId, contractRateBrutto, companyId } = req.body ?? {};
  try {
    const contract = await generateContract({
      workerId, factoryId: factoryId ? Number(factoryId) : null, companyId: companyId ? Number(companyId) : null,
      templateIds: Array.isArray(templateIds) ? templateIds.map(Number) : undefined,
      dateFrom: dateFrom ? String(dateFrom) : null, dateTo: dateTo ? String(dateTo) : null,
      supersedesId: supersedesId ? Number(supersedesId) : null,
      contractRateBrutto: contractRateBrutto !== undefined && contractRateBrutto !== null && contractRateBrutto !== ""
        ? Number(contractRateBrutto) : null,
    });
    ok(res, contract);
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося згенерувати пакет документів");
  }
});

// Імпорт ВЖЕ підписаної умови (скан PDF) — бекфіл старих умов, підписаних поза
// системою (запит офісу 10.09.2026). Одразу status=signed, файл — як signedPath
// пакета (той самий GET /contracts/:id/files/:fileId), data.imported=true — для осі
// «умова» движка (legalityRecompute: hasUmowa без шаблону виду umowa).
const uploadContract = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
router.post("/workers/:id/contracts/import", WD, uploadContract.single("file"), async (req: AuthedRequest, res) => {
  const workerId = Number(req.params.id);
  const b = req.body ?? {};
  const factoryId = b.factoryId ? Number(b.factoryId) : null;
  const companyId = b.companyId ? Number(b.companyId) : null;
  // дата: порожньо → null; непорожнє мусить бути реальною календарною датою YYYY-MM-DD (не 2026-02-31)
  const isoDate = (v: unknown): string | null | false => {
    if (v == null || v === "") return null;
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    return new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v ? v : false;
  };
  const dateFrom = isoDate(b.dateFrom), dateTo = isoDate(b.dateTo), signedAtIn = isoDate(b.signedAt);
  if (dateFrom === false || dateTo === false || signedAtIn === false) return fail(res, 400, "Дата: очікується YYYY-MM-DD");
  const signedOn = signedAtIn ?? dateFrom;
  if (!req.file) return fail(res, 400, "Файл не отримано (лише PDF до 15 МБ)");
  if (sniffDocMime(req.file.buffer) !== "application/pdf") return fail(res, 400, "Очікується PDF (тип файлу перевіряється за вмістом)");
  if (!factoryId || !Number.isInteger(factoryId)) return fail(res, 400, "Вкажіть фабрику умови");
  if (!companyId || !Number.isInteger(companyId)) return fail(res, 400, "Вкажіть нашу фірму в умові");
  if (!dateFrom) return fail(res, 400, "Вкажіть дату початку умови (YYYY-MM-DD)");
  if (dateTo && dateTo < dateFrom) return fail(res, 400, "Дата кінця раніше за дату початку");
  const [worker] = await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!worker) return fail(res, 404, "Працівника не знайдено");
  const [factory] = await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  if (!factory) return fail(res, 404, "Фабрику не знайдено");
  const [company] = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!company) return fail(res, 404, "Фірму не знайдено");

  const rawName = Buffer.from(req.file.originalname ?? "umowa.pdf", "latin1").toString("utf8");
  const storedName = makeStoredName(rawName.toLowerCase().endsWith(".pdf") ? rawName : `${rawName}.pdf`);
  const relPath = path.join("contracts", storedName);
  await fs.promises.mkdir(path.join(UPLOADS_ROOT, "contracts"), { recursive: true });
  await fs.promises.writeFile(path.join(UPLOADS_ROOT, relPath), req.file.buffer);
  const sha256 = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
  const signedAt = new Date(`${signedOn}T12:00:00Z`);
  const adminId = req.admin?.adminId ?? null;
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";
  // умова + файл — однією транзакцією; впало → файл з диска прибираємо (не лишати
  // signed-умову без PDF або PDF-сироту)
  let contract: typeof contractsTable.$inferSelect;
  try {
    contract = await db.transaction(async tx => {
      const [c] = await tx.insert(contractsTable).values({
        workerId, factoryId, companyId, status: "signed", dateFrom, dateTo,
        signedAt, companySignedAt: signedAt, companySignedBy: adminId,
        data: { imported: true, importedBy: adminId, importedAt: new Date().toISOString(), originalName: rawName, ...(note ? { note } : {}) },
      }).returning();
      await tx.insert(contractFilesTable).values({
        contractId: c!.id, sortOrder: 0, title: "Umowa (skan podpisany)", signedPath: relPath, signedSha256: sha256,
      });
      return c!;
    });
  } catch (e) {
    await fs.promises.unlink(path.join(UPLOADS_ROOT, relPath)).catch(() => {});
    throw e;
  }
  const { workerLegalityChanged } = await import("../services/documentEvents");
  await workerLegalityChanged(workerId);
  logger.info({ contractId: contract.id, workerId, factoryId, companyId, dateFrom, dateTo, adminId }, "signed contract imported");
  ok(res, { ...contract, factoryName: factory.name, companyName: company.name });
});

// Дата може з'явитись у БУДЬ-якому нетермінальному статусі, навіть після
// підпису працівника — дозвіл на роботу часто оформлюють ВЖЕ маючи підписану
// умову, тож дата стає відома пізніше (services/contracts.ts:updateContractDates:
// у draft перегенеровує PDF, після — лише дані в БД, підписаного файлу не чіпає).
router.patch("/contracts/:id/dates", WD, async (req, res) => {
  const id = Number(req.params.id);
  const { dateFrom, dateTo } = req.body ?? {};
  if (!dateFrom && !dateTo) return fail(res, 400, "Вкажіть хоча б одну дату (від або до)");
  try {
    const updated = await updateContractDates(id, dateFrom ? String(dateFrom) : null, dateTo ? String(dateTo) : null);
    ok(res, updated);
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося оновити дати");
  }
});

// Превʼю {%Czynności%} для модалки генерації: звідки візьметься текст обов'язків
// (посада на фабриці / поле фабрики / назва посади / нічого).
router.get("/workers/:id/contract-duties", WD, async (req, res) => {
  const [worker] = await db.select({ positionId: workersTable.positionId }).from(workersTable).where(eq(workersTable.id, Number(req.params.id)));
  if (!worker) return fail(res, 404, "Працівника не знайдено");
  const factoryId = req.query.factoryId ? Number(req.query.factoryId) : null;
  ok(res, await resolveContractDuties(worker.positionId, factoryId));
});

// Список умов працівника з назвами фабрики/фірми і файлами пакета — картка в
// профілі показує документи пакета одразу, без окремого запиту на кожну умову.
router.get("/workers/:id/contracts", WD, async (req, res) => {
  const workerId = Number(req.params.id);
  const rows = await db.select({
    c: contractsTable, factoryName: factoriesTable.name, companyName: companiesTable.name,
  }).from(contractsTable)
    .leftJoin(factoriesTable, eq(contractsTable.factoryId, factoriesTable.id))
    .leftJoin(companiesTable, eq(contractsTable.companyId, companiesTable.id))
    .where(eq(contractsTable.workerId, workerId)).orderBy(desc(contractsTable.id));
  const ids = rows.map(r => r.c.id);
  const files = ids.length ? await db.select({
    id: contractFilesTable.id, contractId: contractFilesTable.contractId, title: contractFilesTable.title,
    sortOrder: contractFilesTable.sortOrder, signedSha256: contractFilesTable.signedSha256,
  }).from(contractFilesTable).where(inArray(contractFilesTable.contractId, ids)).orderBy(contractFilesTable.sortOrder) : [];
  ok(res, rows.map(r => ({
    ...r.c, factoryName: r.factoryName, companyName: r.companyName,
    files: files.filter(f => f.contractId === r.c.id).map(f => ({ id: f.id, title: f.title, signed: !!f.signedSha256 })),
  })));
});

router.get("/contracts/:id", WD, async (req, res) => {
  const id = Number(req.params.id);
  const [contract] = await db.select().from(contractsTable).where(eq(contractsTable.id, id));
  if (!contract) return fail(res, 404, "Умову не знайдено");
  const files = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, id)).orderBy(contractFilesTable.sortOrder);
  ok(res, { ...contract, files });
});

// ─── Workflow затвердження (§12 Етап 4) ─────────────────────────────────────────
const CONTRACT_TERMINAL = new Set(["declined", "cancelled", "superseded", "expired", "signed"]);

// draft → pending_approval: ставить умову в чергу на розгляд (окремо від
// генерації — офіс може перегенерувати чернетку, перш ніж формально подати).
// dateFrom НЕ вимагається: дата може залежати від дозволу на роботу, який
// оформлюють ВЖЕ маючи підписану умову (дописується пізніше, updateContractDates).
router.post("/contracts/:id/submit", WD, async (req, res) => {
  const id = Number(req.params.id);
  const [contract] = await db.select().from(contractsTable).where(eq(contractsTable.id, id));
  if (!contract) return fail(res, 404, "Умову не знайдено");
  if (contract.status !== "draft") return fail(res, 400, `Подати на затвердження можна лише з draft (поточний статус: ${contract.status})`);
  const [updated] = await db.update(contractsTable).set({ status: "pending_approval", updatedAt: new Date() }).where(eq(contractsTable.id, id)).returning();
  ok(res, updated);
});

// draft|pending_approval → approved: суто робочий статус («офіс перевірив,
// готово до відправки») — БЕЗ печатки фірми. Компанія підписує лише після
// працівника (finalizeContractSignature, /contracts/:id/finalize нижче) —
// не тут, щоб не випередити підпис працівника.
router.post("/contracts/:id/approve", WD, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const [contract] = await db.select().from(contractsTable).where(eq(contractsTable.id, id));
  if (!contract) return fail(res, 404, "Умову не знайдено");
  if (!["draft", "pending_approval"].includes(contract.status)) return fail(res, 400, `Не можна затвердити зі статусу ${contract.status}`);
  const [updated] = await db.update(contractsTable).set({
    status: "approved", approvedBy: req.admin?.adminId ?? null, approvedAt: new Date(), updatedAt: new Date(),
  }).where(eq(contractsTable.id, id)).returning();
  ok(res, updated);
});

// worker_signed → signed: компанія підписує/штампує У ВІДПОВІДЬ на вже
// підписаний працівником файл (best-effort щодо самої печатки — без
// COMPANY_STAMP_PNG статус усе одно просувається, §13 плану).
router.post("/contracts/:id/finalize", WD, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  try {
    const stamp = await finalizeContractSignature(id, req.admin?.adminId ?? null);
    const [updated] = await db.select().from(contractsTable).where(eq(contractsTable.id, id));
    ok(res, { ...updated, stamp });
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося завершити підписання");
  }
});

// Будь-який нетермінальний статус → cancelled (з опційною причиною).
router.post("/contracts/:id/cancel", WD, async (req, res) => {
  const id = Number(req.params.id);
  const [contract] = await db.select().from(contractsTable).where(eq(contractsTable.id, id));
  if (!contract) return fail(res, 404, "Умову не знайдено");
  if (CONTRACT_TERMINAL.has(contract.status)) return fail(res, 400, `Умова вже в термінальному статусі (${contract.status})`);
  const reason = req.body?.reason ? String(req.body.reason).trim() : null;
  const [updated] = await db.update(contractsTable).set({
    status: "cancelled", declineReason: reason, updatedAt: new Date(),
  }).where(eq(contractsTable.id, id)).returning();
  ok(res, updated);
});

// draft|pending_approval|approved → sent: одноразовий токен-лінк на /sign/:token
// (§5 плану), Telegram-повідомлення працівнику (best-effort — без telegramId
// токен усе одно створюється, офіс копіює лінк вручну з відповіді). Повторний
// send ревокує попередній живий токен цієї умови, щоб діяв лише один лінк
// одночасно. Дозволено прямо з draft — submit/approve лишились як окремі
// ендпоінти (напр. для команд з окремим внутрішнім рев'ю), але «Надіслати на
// підпис» — одна кнопка, без обов'язкового проміжного клацання по них.
router.post("/contracts/:id/send", WD, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  try {
    const r = await sendContractForSignature(id, req.admin?.adminId ?? null); // services/contracts.ts — те саме робить дія задачі
    const [updated] = await db.select().from(contractsTable).where(eq(contractsTable.id, id));
    ok(res, { ...updated, ...r });
  } catch (e: any) {
    fail(res, /не знайдено/i.test(e?.message ?? "") ? 404 : 400, e?.message ?? "Не вдалося надіслати на підпис");
  }
});

// Стрім PDF (unsigned — до підписання; signed зʼявляється після /sign/:token).
router.get("/contracts/:id/files/:fileId", WD, async (req, res) => {
  const contractId = Number(req.params.id);
  const fileId = Number(req.params.fileId);
  const [file] = await db.select().from(contractFilesTable).where(eq(contractFilesTable.id, fileId));
  if (!file || file.contractId !== contractId) return fail(res, 404, "Файл не знайдено");
  const relPath = file.signedPath ?? file.unsignedPath;
  if (!relPath) return fail(res, 404, "Файл ще не згенеровано");
  const abs = path.join(UPLOADS_ROOT, relPath);
  if (!fs.existsSync(abs)) return fail(res, 404, "Файл не знайдено на диску");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/pdf");
  const disposition = req.query.download === "1" ? "attachment" : "inline"; // ?download=1 — «Скачати» в профілі
  res.setHeader("Content-Disposition", `${disposition}; filename="${file.title.replace(/[^\w.\- ]/g, "_")}.pdf"`);
  const stream = fs.createReadStream(abs);
  // помилка читання (права/диск) без обробника — необроблений 'error' стріму валить процес
  stream.on("error", () => { if (!res.headersSent) res.status(500).json({ error: "Не вдалося прочитати файл" }); else res.destroy(); });
  stream.pipe(res);
});

export default router;
