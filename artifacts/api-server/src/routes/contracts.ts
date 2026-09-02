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
import {
  db, workerQuestionnairesTable, workerDocumentsTable, documentTypesTable,
  contractsTable, contractFilesTable, signatureTokensTable, signatureEventsTable,
  workersTable, factoriesTable,
} from "@workspace/db";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";
import { WORKER_DOCS_DIR, UPLOADS_ROOT, makeStoredName, sniffDocMime } from "../lib/uploads";
import { processPassport, passportOcrConfigured, type PassportDraft, type MrzResult } from "../services/docai";
import { generateContract, updateContractDates, finalizeContractSignature, resolveDocumentSet } from "../services/contracts";
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

  const [existing] = await db.select({ id: workerQuestionnairesTable.id }).from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  const [q] = existing
    ? await db.update(workerQuestionnairesTable).set(patch).where(eq(workerQuestionnairesTable.workerId, workerId)).returning()
    : await db.insert(workerQuestionnairesTable).values({ workerId, ...patch }).returning();

  // Ім'я/по-батькові/прізвище — поля workersTable, не анкети (той самий поділ,
  // що routes/passportScan.ts) — офіс редагує напряму, fullName НЕ чіпаємо
  // (канонічне поле для сортування/матчингу/бота лишається як є).
  const namePatch: Record<string, unknown> = {};
  if (body.firstName !== undefined) namePatch.firstName = String(body.firstName).trim() || null;
  if (body.middleName !== undefined) namePatch.middleName = String(body.middleName).trim() || null;
  if (body.lastName !== undefined) namePatch.lastName = String(body.lastName).trim() || null;
  if (Object.keys(namePatch).length) await db.update(workersTable).set(namePatch).where(eq(workersTable.id, workerId));

  ok(res, q);
});

router.post("/workers/:id/questionnaire/verify", WD, async (req: AuthedRequest, res) => {
  const workerId = Number(req.params.id);
  const [existing] = await db.select({ id: workerQuestionnairesTable.id }).from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  if (!existing) return fail(res, 404, "Анкета ще не заповнена");
  const [q] = await db.update(workerQuestionnairesTable).set({
    status: "verified", verifiedBy: req.admin?.adminId ?? null, verifiedAt: new Date(), updatedAt: new Date(),
  }).where(eq(workerQuestionnairesTable.workerId, workerId)).returning();
  ok(res, q);
});

// ─── Скан паспорта (OCR → чернетка анкети) ──────────────────────────────────────
// Спільна логіка для веб-кнопки «Сканувати паспорт» (нижче) і бот-хендлера
// bot/handlers/passportScan.ts — за зразком createScannedInvoice у
// routes/costInvoices.ts (одна функція, два виклики).
const SCAN_MIME_WHITELIST = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]);
const uploadScan = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const PASSPORT_DRAFT_FIELDS = ["passportNumber", "passportCountry", "passportIssuedAt", "passportExpiresAt", "citizenship", "sex"] as const;

export async function applyPassportScan(workerId: number, buffer: Buffer, originalName: string): Promise<{
  documentId: number; questionnaire: typeof workerQuestionnairesTable.$inferSelect; draft: PassportDraft; mrz: MrzResult | null;
  nameDraft: { firstName: string | null; middleName: string | null; lastName: string | null };
}> {
  const realMime = sniffDocMime(buffer);
  if (!realMime || !SCAN_MIME_WHITELIST.has(realMime)) throw new Error("Тип файлу не підтверджено вмістом");

  const docType = await ensureDocumentType("passport");

  const storedName = makeStoredName(originalName);
  await fs.promises.writeFile(path.join(WORKER_DOCS_DIR, storedName), buffer);
  const [doc] = await db.insert(workerDocumentsTable).values({
    workerId, docTypeId: docType.id, title: docType.name, status: "present", source: "ocr",
    filePath: path.join("worker-documents", storedName), fileName: originalName, fileMime: realMime,
  }).returning();

  const { draft, mrz } = await processPassport(buffer, realMime);
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
  const { factoryId, templateIds, dateFrom, dateTo, supersedesId, contractRateBrutto } = req.body ?? {};
  try {
    const contract = await generateContract({
      workerId, factoryId: factoryId ? Number(factoryId) : null,
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

// Дата може з'явитись у БУДЬ-якому нетермінальному статусі, навіть після
// підпису працівника — дозвіл на роботу часто оформлюють ВЖЕ маючи підписану
// умову, тож дата стає відома пізніше (services/contracts.ts:updateContractDates:
// у draft перегенеровує PDF, після — лише дані в БД, підписаного файлу не чіпає).
router.patch("/contracts/:id/dates", WD, async (req, res) => {
  const id = Number(req.params.id);
  const { dateFrom, dateTo } = req.body ?? {};
  if (!dateFrom) return fail(res, 400, "Потрібна дата початку (dateFrom)");
  try {
    const updated = await updateContractDates(id, String(dateFrom), dateTo ? String(dateTo) : null);
    ok(res, updated);
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося оновити дати");
  }
});

router.get("/workers/:id/contracts", WD, async (req, res) => {
  const workerId = Number(req.params.id);
  const rows = await db.select().from(contractsTable).where(eq(contractsTable.workerId, workerId)).orderBy(desc(contractsTable.id));
  ok(res, rows);
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
const SENDABLE = new Set(["draft", "pending_approval", "approved"]);
router.post("/contracts/:id/send", WD, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const [contract] = await db.select().from(contractsTable).where(eq(contractsTable.id, id));
  if (!contract) return fail(res, 404, "Умову не знайдено");
  if (!SENDABLE.has(contract.status)) return fail(res, 400, `Надіслати на підпис можна лише з draft/pending_approval/approved (поточний: ${contract.status})`);

  // Комплект підписується ОДНІЄЮ сесією: усі інші sendable пакети ЦІЄЇ Ж
  // людини (напр. сталий пакет, згенерований разом з факторі-умовою) ідуть
  // в один токен/лінк з contractId — не два окремі "Надіслати на підпис".
  const siblings = await db.select({ id: contractsTable.id }).from(contractsTable)
    .where(and(eq(contractsTable.workerId, contract.workerId), inArray(contractsTable.status, [...SENDABLE]), ne(contractsTable.id, id)));
  const bundle = [id, ...siblings.map(s => s.id)];

  await db.update(signatureTokensTable).set({ revokedAt: new Date() })
    .where(inArray(signatureTokensTable.contractId, bundle));

  const token = randomInviteCode(24); // ~120 біт ентропії — токен є єдиною авторизацією /sign/:token
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  const [tokenRow] = await db.insert(signatureTokensTable).values({
    token, contractId: id, extraContractIds: siblings.length ? siblings.map(s => s.id) : null,
    expiresAt, createdBy: req.admin?.adminId ?? null,
  }).returning();
  await db.insert(signatureEventsTable).values(bundle.map(cid => ({ contractId: cid, tokenId: tokenRow!.id, event: "token_created" })));

  const [worker] = await db.select({ telegramId: workersTable.telegramId, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, contract.workerId));
  const base = (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");
  const link = base ? `${base}/sign/${token}` : null;
  let notified = false;
  if (worker?.telegramId && link) notified = await sendSignLink(worker.telegramId, worker.language ?? "uk", link);

  await db.update(contractsTable).set({ status: "sent", sentAt: new Date(), updatedAt: new Date() }).where(inArray(contractsTable.id, bundle));
  const [updated] = await db.select().from(contractsTable).where(eq(contractsTable.id, id));
  ok(res, { ...updated, token, link, notified, bundledCount: siblings.length });
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
  res.setHeader("Content-Disposition", `inline; filename="${file.title.replace(/[^\w.\- ]/g, "_")}.pdf"`);
  fs.createReadStream(abs).pipe(res);
});

export default router;
