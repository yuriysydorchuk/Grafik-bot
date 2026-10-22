// Публічна веб-сторінка сканування паспорта (/passport-scan/:token) — заміна
// завантаження фото в Telegram: камера прямо в браузері (getUserMedia) з
// рамкою-підказкою, або файл/PDF. БЕЗ authRequired — токен у шляху єдина
// авторизація (той самий підхід, що routes/sign.ts). Два джерела токена:
// офіс генерує для нового кандидата в боті (bot/handlers/passportScan.ts,
// purpose=office, factoryId/telegramId ще невідомі), або сам кандидат за
// лінком фабрики (bot/index.ts ?start=fac<factoryId>, purpose=self,
// telegramId/language вже відомі — це його чат).
//
// Двоетапно: analyze() запускає OCR і кладе файл+чернетку в токен, сторінка
// показує РЕДАГОВНИЙ екран підтвердження, confirm() із фінальних (можливо
// підправлених) полів створює працівника. З 16.10.2026 нерозпізнані поля (або
// все — «ввести вручну») людина вписує сама, фото паспорта обов'язкове;
// вписаний працівником паспорт іде офісу на звірку (status pending).
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import {
  db, passportScanTokensTable, workersTable, workerQuestionnairesTable, workerDocumentsTable,
  documentTypesTable, factoriesTable, adminsTable, candidatesTable,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { UPLOADS_ROOT, WORKER_DOCS_DIR, PASSPORT_SCAN_TMP_DIR, makeStoredName, sniffDocMime, deleteStoredFile, compressUploadImage } from "../lib/uploads";
import {
  processPassport, passportOcrConfigured, mrzNationalityToCatalog, mrzDiagnostics, mrzToPassportDraft, trustedPassportDraft,
  PASSPORT_REQUIRED_FIELDS, type PassportDraft, type MrzResult,
} from "../services/docai";
import { randomInviteCode, ensureWorkerInviteCode, workerInviteLink } from "../lib/invite";
import { workerSignupInfo } from "../services/signupLinks";
import { nextWorkerCode } from "../lib/workerCode";
import { findLikelyDuplicate } from "../bot/workerMatch";
import { bot } from "../bot/instance";
import { logger } from "../lib/logger";
import { journalQuestionnaire } from "../services/questionnaireJournal";
import { ensureDocumentType, applyWorkerDocumentUpload } from "../services/workerDocuments";
import { requestRehire } from "../bot/handlers/rehire";
import { validatePassport, validateQuestionnaire, passportIssuedError, trimStr, CONSENTS_VERSION } from "../lib/questionnaireRules";
import { companiesTable } from "@workspace/db";

const router: IRouter = Router();
const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });
// Валідація анкети: 400 + мапа field → код помилки (клієнт підсвічує поле й перекладає код)
const failFields = (res: any, fields: Record<string, string>) =>
  res.status(400).json({ error: `Перевір поля: ${Object.keys(fields).join(", ")}`, fields });
// календарний день за Варшавою (toISOString давав UTC — о 00:30 ще «вчора»)
const todayIso = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });

const scanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Забагато запитів. Спробуйте пізніше." },
});
// Скоупимо по префіксу — цей роутер монтується РАНІШЕ за блокові authRequired-
// гейти (routes/index.ts), як і sign.ts; неупакований router.use() тут
// зачепив би rate-limit'ом усі запити до /api.
router.use("/passport-scan", scanLimiter);

const SCAN_MIME_WHITELIST = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]);
const uploadScan = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

async function loadValidToken(token: string) {
  const [row] = await db.select().from(passportScanTokensTable).where(eq(passportScanTokensTable.token, token));
  if (!row) return { error: "Лінк недійсний." };
  if (row.usedAt) return { error: "Лінк уже використано." };
  if (new Date(row.expiresAt).getTime() < Date.now()) return { error: "Термін дії лінку вичерпано." };
  return { row };
}

router.get("/passport-scan/:token", async (req, res) => {
  // Використаний токен З workerId (паспорт уже підтверджено) — лінк далі веде на анкету: працівник
  // міг закрити сторінку після скану й відкрити лінк з бота знову (прод 21.09.2026 — два такі випадки
  // давали «Лінк недійсний»). Без workerId «використано» = справді мертвий.
  const [row0] = await db.select().from(passportScanTokensTable).where(eq(passportScanTokensTable.token, req.params.token));
  if (!row0) return fail(res, 404, "Лінк недійсний.");
  if (new Date(row0.expiresAt).getTime() < Date.now()) return fail(res, 404, "Термін дії лінку вичерпано.");
  if (row0.usedAt && !row0.workerId) return fail(res, 404, "Лінк уже використано.");
  const row = row0;
  const [factory] = row.factoryId ? await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, row.factoryId)) : [undefined];

  // purpose=anketa (bot "📄 Документи → заповнити анкету", запрошення
  // ІСНУЮЧОГО працівника на скан+анкету з веб-панелі) — workerId відомий
  // одразу. Віддаємо вже збережені відповіді, щоб форма не стартувала з
  // чистого бланку щоразу.
  let questionnaire: Record<string, unknown> | null = null;
  let pesel: string | null = null;
  let birthDate: string | null = null; // клієнт звіряє PESEL з датою народження
  let nameDraft: { firstName: string | null; middleName: string | null; lastName: string | null } | null = null;
  // anketa-токен мови не несе — сторінка відкривається мовою бота працівника (інакше завжди укр.)
  let workerLang: string | null = null;
  // office/self — паспорта в системі гарантовано ще нема, скан обов'язковий.
  // anketa — залежить від того, чи в цього працівника вже є "Paszport" на
  // файлі: якщо нема (запрошення на скан+анкету для когось, кого завели без
  // паспорта — бот-імпорт/ручне додавання) — сторінка теж стартує зі скану,
  // а не одразу з анкети.
  let needsPassportScan = row.purpose !== "anketa";
  if (row.workerId) {
    const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, row.workerId));
    if (q) questionnaire = q;
    const [w] = await db.select({ pesel: workersTable.pesel, fullName: workersTable.fullName, firstName: workersTable.firstName, middleName: workersTable.middleName, lastName: workersTable.lastName, birthDate: workersTable.birthDate, language: workersTable.language })
      .from(workersTable).where(eq(workersTable.id, row.workerId));
    pesel = w?.pesel ?? null;
    workerLang = w?.language ?? null;
    birthDate = w?.birthDate ? String(w.birthDate) : null;
    if (w) {
      // Немає структурованих полів (профіль заведений до цієї фічі) —
      // best-effort split fullName для префілу (той самий евристичний поділ,
      // що й старий services/contracts.ts buildContractData).
      const [guessFirst, ...guessRest] = (w.fullName ?? "").trim().split(/\s+/);
      nameDraft = {
        firstName: w.firstName ?? guessFirst ?? null,
        middleName: w.middleName ?? null,
        lastName: w.lastName ?? (guessRest.join(" ") || null),
      };
    }
    if (row.purpose === "anketa" || row.usedAt) { // повторне відкриття після скану — одразу анкета, якщо паспорт уже є
      const [passportDoc] = await db.select({ id: workerDocumentsTable.id }).from(workerDocumentsTable)
        .innerJoin(documentTypesTable, eq(workerDocumentsTable.docTypeId, documentTypesTable.id))
        .where(and(eq(workerDocumentsTable.workerId, row.workerId), eq(documentTypesTable.code, "passport"), inArray(workerDocumentsTable.status, ["present", "pending"])));
      needsPassportScan = !passportDoc; // pending = вписаний вручну, чекає звірки офісом — сканувати вдруге не треба
    }
  }

  // Адміністратор даних у згодах RODO — наша фірма, з якою буде umowa: фірма
  // фабрики з лінка → фірма профілю → перша активна (фолбек, щоб текст не був порожнім).
  let companyName: string | null = null;
  {
    let companyId: number | null = null;
    if (row.factoryId) { const [f] = await db.select({ companyId: factoriesTable.companyId }).from(factoriesTable).where(eq(factoriesTable.id, row.factoryId)); companyId = f?.companyId ?? null; }
    if (companyId == null && row.workerId) { const [w] = await db.select({ companyId: workersTable.companyId }).from(workersTable).where(eq(workersTable.id, row.workerId)); companyId = w?.companyId ?? null; }
    const [c] = companyId != null
      ? await db.select({ name: companiesTable.name, legalName: companiesTable.legalName }).from(companiesTable).where(eq(companiesTable.id, companyId))
      : await db.select({ name: companiesTable.name, legalName: companiesTable.legalName }).from(companiesTable).limit(1);
    companyName = c?.legalName || c?.name || null;
  }
  ok(res, { purpose: row.purpose, factoryName: factory?.name ?? null, companyName, language: row.language ?? workerLang ?? "uk", questionnaire, pesel, birthDate, needsPassportScan, nameDraft });
});

// Файл → OCR → чернетка. Файл лягає у тимчасову теку (переноситься у постійну
// лише при confirm()) — можна спробувати кілька разів, кожна спроба перезаписує
// попередню тимчасову теку.
//
// 16.10.2026 (скарга власника: жінку з нечитабельним паспортом не вдалося
// зареєструвати взагалі) — нерозпізнаний скан більше НЕ відхиляється: фото
// зберігається, розпізнане (лише з валідною чек-сумою) підставляється, решту
// людина вписує вручну (сторінка підсвічує порожні поля). manual=1 — «ввести
// вручну» без OCR взагалі. Чернетка не з повністю валідної MRZ = manual: на
// confirm() паспорт від працівника йде офісу на перевірку з фото (status pending).
router.post("/passport-scan/:token/analyze", uploadScan.single("file"), async (req, res) => {
  const { row, error } = await loadValidToken(String(req.params.token));
  if (error || !row) return fail(res, 404, error ?? "Лінк недійсний.");
  if (!req.file) return fail(res, 400, "Файл не отримано (недопустимий тип або завеликий)");
  const realMime = sniffDocMime(req.file.buffer);
  if (!realMime || !SCAN_MIME_WHITELIST.has(realMime)) return fail(res, 400, "Тип файлу не підтверджено вмістом");
  const manualRequested = String(req.body?.manual ?? "") === "1";

  try {
    let draft: PassportDraft = mrzToPassportDraft(null);
    let mrz: MrzResult | null = null;
    // full — MRZ з валідними чек-сумами; partial — щось розпізнано; none — нічого; manual — OCR не запускали
    let recognized: "full" | "partial" | "none" | "manual" = "manual";
    if (!manualRequested && passportOcrConfigured()) {
      try {
        const r = await processPassport(req.file.buffer, realMime);
        mrz = r.mrz;
        // parsePassportMrz() повертає БУДЬ-яку структурно схожу на MRZ пару рядків,
        // навіть з чек-сумами, що не збігаються, — поля без валідної чек-суми
        // відкидаємо тут (trustedPassportDraft), інакше сміття (номер паспорта,
        // дата) виглядало б як правда на екрані підтвердження. compositeValid НЕ
        // вимагаємо: вона включає «особистий номер» (здебільшого заповнювач «<<<»),
        // який ми не використовуємо, а OCR саме в ньому помиляється найчастіше.
        draft = trustedPassportDraft(r.draft, mrz);
        const mrzValid = !!mrz && mrz.documentNumberValid && mrz.birthDateValid && mrz.expiryDateValid;
        recognized = mrzValid && draft.fullName ? "full" : PASSPORT_REQUIRED_FIELDS.some(k => draft[k]) ? "partial" : "none";
        if (recognized !== "full") {
          // Сам текст паспорта в лог НЕ пишемо (RODO) — лише структурні метрики (mrzDiagnostics):
          // «Vision нічого не побачив» (якість фото/кроп) vs «побачив, але структура/чек-сума не збіглась».
          logger.warn({ tokenId: row.id, fileBytes: req.file.buffer.length, realMime, recognized, mrzFound: !!mrz, mrzChecks: mrz ? { doc: mrz.documentNumberValid, birth: mrz.birthDateValid, exp: mrz.expiryDateValid, composite: mrz.compositeValid } : null, ...mrzDiagnostics(r.fullText) }, "passport-scan analyze: not fully recognized → manual entry");
        }
      } catch (e: any) {
        // Vision недоступний / PDF завеликий тощо — не блокуємо реєстрацію, дані впишуть вручну
        logger.warn({ tokenId: row.id, err: e?.message }, "passport-scan OCR failed → manual entry");
        recognized = "none";
      }
    }
    const manual = recognized !== "full";
    const missing = PASSPORT_REQUIRED_FIELDS.filter(k => !draft[k]);

    deleteStoredFile(row.tempFilePath);
    const rawName = Buffer.from(req.file.originalname ?? "passport", "latin1").toString("utf8") || "passport.jpg";
    // на диск (і далі в профіль при confirm) — стиснута копія; OCR вище вже відпрацював на оригіналі
    const stored = await compressUploadImage(req.file.buffer, realMime, rawName);
    const storedName = makeStoredName(stored.fileName);
    await fs.promises.writeFile(path.join(PASSPORT_SCAN_TMP_DIR, storedName), stored.buffer);

    await db.update(passportScanTokensTable).set({
      tempFilePath: path.join("passport-scan-tmp", storedName), tempFileName: stored.fileName, tempFileMime: stored.mime,
      draftJson: { draft, mrz, recognized, manual, missing },
    }).where(eq(passportScanTokensTable.id, row.id));

    logger.info({ tokenId: row.id, recognized, missing: missing.length }, "passport-scan analyze ok");
    ok(res, { draft, recognized, manual, missing });
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося зберегти фото паспорта");
  }
});


// Фінальні (можливо підправлені на екрані підтвердження) поля → створює
// працівника. factoryId/telegramId/language — з ТОКЕНА (серверний контекст,
// не з тіла запиту) — клієнт не може підсунути чужу фабрику чи telegramId.
router.post("/passport-scan/:token/confirm", async (req, res) => {
  const { row, error } = await loadValidToken(req.params.token);
  if (error || !row) return fail(res, 404, error ?? "Лінк недійсний.");
  if (!row.tempFilePath || !row.tempFileMime) return fail(res, 400, "Спершу відскануй паспорт.");

  // Усі поля паспорта обов'язкові, лише латиниця, формати — lib/questionnaireRules
  // (рішення 08.09.2026; ті самі правила підсвічує клієнт).
  const pv = validatePassport(req.body ?? {}, todayIso());
  if (Object.keys(pv.errors).length) return failFields(res, pv.errors);
  const { birthDate, passportIssuedAt, passportExpiresAt, sex, passportNumber, passportCountry, citizenship } = pv.values;

  // Для anketa-токена з уже відомим workerId (запрошення ІСНУЮЧОГО працівника
  // без паспорта на файлі) — доповнюємо профіль, НЕ створюємо новий (інакше
  // дублікат): код лишається як є, порожні поля добираються зі сканування.
  // Повернення звільненого (self-лінк, новий Telegram): ім'я зі скану збіглось
  // зі звільненим профілем → без force/rehireWorkerId нічого не створюємо, а
  // віддаємо кандидата — сторінка питає «Це я?» (bot/handlers/rehire.ts).
  // rehireWorkerId = «це я»: скан і анкета йдуть у СТАРИЙ профіль (як для
  // anketa-токена), офісу летить запит «✅ Відновити»; force = «інша людина».
  const rehireWorkerId = Number.isInteger(req.body?.rehireWorkerId) ? Number(req.body.rehireWorkerId) : null;
  const forceNew = req.body?.force === true;
  let rehireTarget: typeof workersTable.$inferSelect | null = null;
  if (rehireWorkerId != null && row.purpose === "self" && !row.workerId) {
    const [cand] = await db.select().from(workersTable).where(eq(workersTable.id, rehireWorkerId));
    if (!cand || cand.isActive) return fail(res, 400, "Профіль для повернення не знайдено або вже активний.");
    rehireTarget = cand;
  }
  const isExistingWorker = !!row.workerId || !!rehireTarget;
  const { firstName, lastName } = pv.values;
  const middleNameIn = pv.values.middleName;

  try {
    let worker: typeof workersTable.$inferSelect;
    if (row.purpose === "self" && !isExistingWorker && !forceNew) {
      const dup = findLikelyDuplicate([lastName, firstName].join(" "), await db.select().from(workersTable));
      if (dup && !dup.isActive) return ok(res, { rehireCandidate: { id: dup.id, fullName: dup.fullName, workerCode: dup.workerCode } });
    }
    if (isExistingWorker) {
      const [existing] = await db.select().from(workersTable).where(eq(workersTable.id, rehireTarget?.id ?? row.workerId!));
      if (!existing) return fail(res, 404, "Працівника не знайдено.");
      const [updated] = await db.update(workersTable).set({
        firstName: existing.firstName ?? firstName,
        middleName: existing.middleName ?? middleNameIn,
        lastName: existing.lastName ?? lastName,
        birthDate: existing.birthDate ?? birthDate,
        gender: existing.gender ?? (sex === "M" ? "male" : sex === "F" ? "female" : null),
        nationality: existing.nationality ?? mrzNationalityToCatalog(citizenship),
      }).where(eq(workersTable.id, existing.id)).returning();
      worker = updated!;
    } else {
      const workerCode = await nextWorkerCode();
      // «Прізвище Ім'я» — порядок full_name у профілях (рішення власника 15.10.2026)
      const fullName = [lastName, firstName].join(" ");
      const [created] = await db.insert(workersTable).values({
        fullName, firstName, middleName: middleNameIn, lastName,
        workerCode, factoryId: row.factoryId, telegramId: row.telegramId, language: row.language,
        signupLinkId: row.signupLinkId ?? null, // «хто привів» — персональний лінк рекрутера (?start=rec…)
        birthDate, gender: sex === "M" ? "male" : sex === "F" ? "female" : null,
        nationality: mrzNationalityToCatalog(citizenship),
      }).returning();
      worker = created!;
      import("../services/tasks").then(m => m.workerTrigger("worker_created", created)).catch(() => {}); // шаблони задач «при реєстрації»
    }

    // Дані не з повністю валідної MRZ (16.10.2026: нерозпізнаний скан / «ввести вручну») —
    // вписані людиною; так само, якщо людина ЗМІНИЛА будь-яке розпізнане поле (інакше
    // валідний скан + підмінені дані обходили б звірку). Від працівника (self/anketa)
    // паспорт іде офісу на звірку з фото: status pending + задача «Перевірити завантажений
    // документ» (той самий шлях, що й самозавантажені документи). Офісний лінк
    // (purpose=office) вписує сам офіс — одразу present.
    const draftJson = (row.draftJson ?? {}) as { draft?: Partial<PassportDraft>; manual?: boolean };
    const manualEntry = draftJson.manual === true;
    const norm = (v: unknown) => String(v ?? "").trim().toUpperCase();
    const typed: Record<string, unknown> = { firstName, middleName: middleNameIn, lastName, birthDate, passportNumber, passportCountry, passportIssuedAt, passportExpiresAt, citizenship, sex };
    const fields = [...PASSPORT_REQUIRED_FIELDS, "middleName"] as const;
    // Які поля людина вписала/змінила відносно розпізнаного — доказ походження для офісу (ocrRaw)
    const enteredManually = fields.filter(k => norm(draftJson.draft?.[k]) !== norm(typed[k]));
    // будь-яке РОЗПІЗНАНЕ поле змінене (вкл. дату видачі-пропозицію, країну, стать) → звірка
    const changedRecognized = fields.some(k => norm(draftJson.draft?.[k]) && norm(draftJson.draft?.[k]) !== norm(typed[k]));
    // офісний лінк з картки кандидата заповнює сам кандидат (передали йому) — теж на звірку
    const filledByOffice = row.purpose === "office" && !row.candidateId;
    const needsReview = (manualEntry || changedRecognized) && !filledByOffice;
    const docType = await ensureDocumentType("passport");
    const tmpAbs = path.join(UPLOADS_ROOT, row.tempFilePath);
    const storedName = makeStoredName(row.tempFileName || "passport.jpg");
    const finalRel = path.join("worker-documents", storedName);
    await fs.promises.rename(tmpAbs, path.join(WORKER_DOCS_DIR, storedName));
    const [doc] = await db.insert(workerDocumentsTable).values({
      workerId: worker.id, docTypeId: docType.id, title: docType.name,
      status: needsReview ? "pending" : "present", source: manualEntry || changedRecognized ? (filledByOffice ? "office" : "worker_bot") : "ocr",
      expiresAt: passportExpiresAt, number: passportNumber, // номер і строк — з MRZ або вписані (підтверджені людиною на кроці confirm)
      filePath: finalRel, fileName: row.tempFileName, fileMime: row.tempFileMime,
    }).returning();
    if (needsReview) {
      try { const { ensurePendingDocTask } = await import("../services/taskAutoRules"); await ensurePendingDocTask(doc!.id); }
      catch (e: any) { logger.warn({ err: e?.message, workerId: worker.id }, "passport-scan: pending-doc task create failed"); }
    }

    // Upsert — для isExistingWorker анкета могла вже частково існувати
    // (напр. дозаповнена раніше через бот без скану паспорта).
    const qPatch = { ocrRaw: { ...draftJson, enteredManually }, ocrDocId: doc!.id, passportNumber, passportCountry, passportIssuedAt, passportExpiresAt, citizenship, sex };
    const [existingQ] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, worker.id));
    if (existingQ) await db.update(workerQuestionnairesTable).set(qPatch).where(eq(workerQuestionnairesTable.workerId, worker.id));
    else await db.insert(workerQuestionnairesTable).values({ workerId: worker.id, ...qPatch });
    // історія анкети: лише заміна вже вписаних значень (adminId NULL = сам працівник)
    await journalQuestionnaire(worker.id, existingQ, qPatch, null, { onlyOverwrites: true });

    // expiresAt продовжуємо на ANKETA_TOKEN_TTL_MS — токен далі живе для кроку анкети
    // (questionnaire нижче), яку працівник може дозаповнити пізніше за тим самим лінком з бота.
    await db.update(passportScanTokensTable).set({
      usedAt: new Date(), workerId: worker.id, tempFilePath: null, expiresAt: new Date(Date.now() + ANKETA_TOKEN_TTL_MS),
    }).where(eq(passportScanTokensTable.id, row.id));
    logger.info({ tokenId: row.id, workerId: worker.id, purpose: row.purpose, isExistingWorker }, "passport-scan confirmed");

    // Рекрутинг: конвертація кандидата відкладала прив'язку worker/stage до
    // цього моменту (candidateId на токені) — див. POST /candidates/:id/convert.
    if (row.candidateId) {
      await db.update(candidatesTable).set({ workerId: worker.id, stage: "hired" }).where(eq(candidatesTable.id, row.candidateId));
      try { const { markCandidateSmsEvent } = await import("../services/sms/campaigns"); await markCandidateSmsEvent(row.candidateId, "form"); } catch (e) { logger.warn({ err: e }, "sms form event failed"); }
    }

    // Повернення: запит офісу «✅ Відновити / ❌ Відхилити» (фабрика — з лінка,
    // Telegram — з токена; profile активується лише після рішення офісу).
    if (rehireTarget && row.factoryId && row.telegramId) {
      try { await requestRehire({ worker, factoryId: row.factoryId, tid: row.telegramId, lang: row.language as any }); }
      catch (e) { logger.warn({ err: e, workerId: worker.id }, "rehire request from passport-scan failed"); }
    }

    // Дублікат-детект + сповіщення офісу — best-effort, не блокує результат.
    // Лише для щойно створеного профілю (office/self); для isExistingWorker
    // офіс сам ініціював запрошення — повторне сповіщення не потрібне.
    if (!isExistingWorker) try {
      const allWorkers = await db.select().from(workersTable);
      const dup = findLikelyDuplicate(worker.fullName, allWorkers.filter(w => w.id !== worker.id));
      const dupNote = dup ? `\n⚠️ Можливий дублікат: ${dup.fullName} (№${dup.workerCode ?? dup.id}${dup.isActive ? "" : ", звільнений"}).` : "";
      const manualNote = needsReview ? "\n✍️ Дані паспорта вписано/виправлено вручну — звірте з фото (задача «Перевірити завантажений документ»)."
        : manualEntry ? "\n✍️ Дані паспорта вписано вручну (не розпізнано)." : "";

      if (row.purpose === "office" && row.createdBy) {
        const [admin] = await db.select().from(adminsTable).where(eq(adminsTable.id, row.createdBy));
        if (admin?.telegramId) {
          const invite = await ensureWorkerInviteCode(worker.id);
          await bot.telegram.sendMessage(admin.telegramId,
            `✅ Профіль створено зі сканування: ${worker.fullName} (№${worker.workerCode}).${dupNote}${manualNote}\n\nПосилання для кандидата (прив'язати Telegram і дозаповнити анкету):\n${workerInviteLink(invite)}`);
        }
      } else if (row.purpose === "self") {
        // за персональним лінком — рекрутеру окремо (він може бути скоуп-адміном без ролі owner/scheduler)
        const via = row.signupLinkId ? await workerSignupInfo(row.signupLinkId) : null;
        const viaNote = via ? `\n🔗 За лінком: ${via.adminName}` : "";
        const staff = await db.select().from(adminsTable);
        for (const a of staff) {
          if (!a.telegramId || (a.role !== "owner" && a.role !== "scheduler")) continue;
          await bot.telegram.sendMessage(a.telegramId, `🆕 Новий працівник зареєструвався сам (паспорт):\n👤 ${worker.fullName}${viaNote}${dupNote}${manualNote}\n\nПеревірте/відредагуйте в панелі (Працівники).`).catch(() => {});
        }
        if (via) {
          // деактивований між видачею скан-лінка і confirm() — персональні дані йому вже не шлемо
          const [rec] = await db.select({ telegramId: adminsTable.telegramId, role: adminsTable.role, deactivatedAt: adminsTable.deactivatedAt }).from(adminsTable).where(eq(adminsTable.id, via.adminId));
          if (rec?.telegramId && !rec.deactivatedAt && rec.role !== "owner" && rec.role !== "scheduler") {
            await bot.telegram.sendMessage(rec.telegramId, `🆕 За вашим лінком зареєструвався працівник:\n👤 ${worker.fullName} (№${worker.workerCode}) — ${via.factoryName}${dupNote}`).catch(() => {});
          }
        }
      }
    } catch (e) { logger.warn({ err: e }, "passport-scan confirm notify failed"); }

    // Самореєстрація з бота: лінк на скан прибрав клавіатуру (signup.factory) — даємо меню
    // одразу, не чекаючи /start (02.10.2026: нові люди лишались без меню). Повернення
    // (rehireTarget) — ні: профіль активує рішення офісу, меню прийде з ним.
    if (!isExistingWorker && !rehireTarget && row.telegramId) {
      try {
        const [{ t, asLang }, { workerMenuFor }] = await Promise.all([import("../bot/i18n"), import("../bot/menus")]);
        const lang = asLang(worker.language ?? row.language);
        await bot.telegram.sendMessage(row.telegramId, t(lang, "start.greet", { name: worker.fullName }), await workerMenuFor(worker, lang));
      } catch (e) { logger.warn({ err: e, workerId: worker.id }, "passport-scan welcome failed"); }
    }

    ok(res, { worker: { id: worker.id, fullName: worker.fullName, workerCode: worker.workerCode } });
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося створити профіль");
  }
});

// Решта анкети (адреса, IBAN, urząd skarbowy, NFZ, студент/інша робота,
// контакт для екстрених випадків) — ОДРАЗУ після скану, поки людина вже на
// сторінці, замість окремого походу через бот-флоу «📄 Документи» пізніше.
// Дозволено лише ПІСЛЯ confirm() (row.workerId уже є) — токен той самий,
// expiresAt продовжений у confirm(). status → submitted, не verified —
// офіс підтверджує (§ канон «людина вирішує» — той самий принцип, що й PUT
// /workers/:id/questionnaire).
router.post("/passport-scan/:token/questionnaire", async (req, res) => {
  const [row] = await db.select().from(passportScanTokensTable).where(eq(passportScanTokensTable.token, String(req.params.token)));
  if (!row) return fail(res, 404, "Лінк недійсний.");
  if (!row.workerId) return fail(res, 400, "Спершу відскануй паспорт.");
  if (new Date(row.expiresAt).getTime() < Date.now()) return fail(res, 404, "Термін дії лінку вичерпано.");

  const b = req.body ?? {};
  const [workerRow] = await db.select({ birthDate: workersTable.birthDate, gender: workersTable.gender, firstName: workersTable.firstName, middleName: workersTable.middleName, lastName: workersTable.lastName })
    .from(workersTable).where(eq(workersTable.id, row.workerId));

  // Ім'я/по-батькові/прізвище (лише коли кроку паспорта не було — needsPassportScan=false):
  // канонічні поля workersTable; невалідні — 400, як і решта (рішення 08.09.2026:
  // нічого не ігноруємо мовчки).
  const errors: Record<string, string> = {};
  const workerPatch: Record<string, unknown> = {};
  const wantsName = b.firstName !== undefined || b.lastName !== undefined || b.middleName !== undefined;
  if (wantsName) {
    const pvName = validatePassport({ firstName: b.firstName, middleName: b.middleName, lastName: b.lastName }, todayIso());
    for (const k of ["firstName", "middleName", "lastName"] as const) if (pvName.errors[k]) errors[k] = pvName.errors[k]!;
    if (!errors.firstName && !errors.lastName) {
      workerPatch.firstName = pvName.values.firstName; workerPatch.lastName = pvName.values.lastName;
      if (b.middleName !== undefined) workerPatch.middleName = pvName.values.middleName;
    }
  }

  // Дата видачі паспорта (у MRZ її нема): хто пройшов скан до 14.10.2026, має її
  // порожньою — дозапитуємо тут, поки поле порожнє (клієнт показує його за тим самим
  // правилом: questionnaire.passportIssuedAt порожнє і кроку скану в цій сесії не було).
  const [qRow] = await db.select({ passportIssuedAt: workerQuestionnairesTable.passportIssuedAt, passportExpiresAt: workerQuestionnairesTable.passportExpiresAt })
    .from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, row.workerId));
  let issuedPatch: string | null = null;
  if (!qRow?.passportIssuedAt || b.passportIssuedAt !== undefined) {
    const issued = trimStr(b.passportIssuedAt);
    const issuedErr = passportIssuedError(issued, qRow?.passportExpiresAt ?? null, todayIso(), workerRow?.birthDate ? String(workerRow.birthDate) : null);
    if (issuedErr) errors.passportIssuedAt = issuedErr; else issuedPatch = issued;
  }

  // Усі обов'язкові поля/формати/латиниця/згоди — lib/questionnaireRules (те саме на клієнті).
  const qv = validateQuestionnaire(b, { birthDate: workerRow?.birthDate ? String(workerRow.birthDate) : null });
  Object.assign(errors, qv.errors);
  if (Object.keys(errors).length) return failFields(res, errors);
  const v = qv.values;

  const patch: Record<string, unknown> = {
    status: "submitted", submittedAt: new Date(), updatedAt: new Date(),
    ...(issuedPatch ? { passportIssuedAt: issuedPatch } : {}),
    birthPlace: v.birthPlace, motherName: v.motherName, fatherName: v.fatherName,
    // «Немає рахунку» (16.10.2026) → банк порожній і виплата do rąk (у сталий пакет іде Wniosek
    // o wypłatę do rąk, services/contracts.ts). Назад на konto анкета НЕ перемикає: reka без
    // рахунку могла бути свідомим рішенням офісу — з'явився рахунок, офіс сам змінить у профілі.
    bankName: v.noBankAccount ? null : v.bankName, bankIban: v.noBankAccount ? null : v.bankIban,
    ...(v.noBankAccount ? { payoutMethod: "reka" } : {}),
    phone: v.phone, email: v.email, taxOffice: v.taxOffice, nfzBranch: v.nfzBranch,
    isStudent: v.isStudent, schoolName: v.schoolName, hasOtherEmployment: v.hasOtherEmployment, otherEmploymentNote: v.otherEmploymentNote,
    isRegisteredUnemployed: v.isRegisteredUnemployed, emergencyContact: v.emergencyContact, nip: v.nip, pit0: v.pit0,
    ankietaInnyPracodawca: v.ankietaInnyPracodawca, ankietaEmeryt: v.ankietaEmeryt, ankietaRencista: v.ankietaRencista,
    ankietaNiepelnosprawnosc: v.ankietaNiepelnosprawnosc, ankietaSkladkaChorobowa: v.ankietaSkladkaChorobowa,
    regWojewodztwo: v.reg.Wojewodztwo, regPowiat: v.reg.Powiat, regGmina: v.reg.Gmina, regMiejscowosc: v.reg.Miejscowosc,
    regUlica: v.reg.Ulica, regNumerDomu: v.reg.NumerDomu, regKodPocztowy: v.reg.KodPocztowy,
    zamWojewodztwo: v.zam.Wojewodztwo, zamPowiat: v.zam.Powiat, zamGmina: v.zam.Gmina, zamMiejscowosc: v.zam.Miejscowosc,
    zamUlica: v.zam.Ulica, zamNumerDomu: v.zam.NumerDomu, zamKodPocztowy: v.zam.KodPocztowy,
    // Вільнотекстові адреси старих плейсхолдерів («Pełny adres …») — похідні від структурованих,
    // працівник їх більше не вводить окремо (рішення 08.09.2026)
    addressPl: v.addressPl, addressRegistered: v.addressRegistered, postalCode: v.postalCode, city: v.city,
    // Згоди RODO — доказова база: що, коли, звідки, яка версія тексту
    consents: v.consents, consentsAt: new Date(), consentsVersion: CONSENTS_VERSION,
    consentsIp: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.ip || null,
    consentsUserAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) || null,
  };

  // Upsert — з purpose=anketa (дозаповнення пізніше) рядка анкети може ще
  // не існувати взагалі (confirm(), що завжди його створює, для anketa-токена
  // не викликався — нема кроку сканування паспорта).
  const [existing] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, row.workerId));
  if (existing) await db.update(workerQuestionnairesTable).set(patch).where(eq(workerQuestionnairesTable.workerId, row.workerId));
  else await db.insert(workerQuestionnairesTable).values({ workerId: row.workerId, ...patch });
  // історія анкети: перша подача — не «зміна», журналимо лише заміну вписаного (adminId NULL = працівник)
  await journalQuestionnaire(row.workerId, { ...existing, firstName: workerRow?.firstName, middleName: workerRow?.middleName, lastName: workerRow?.lastName },
    { ...patch, ...workerPatch }, null, { onlyOverwrites: true });

  // PESEL — канонічне поле на workersTable (не дублюємо в анкеті). fullName НЕ
  // чіпаємо — канонічне джерело для сортування/матчингу/бота лишається як є.
  workerPatch.pesel = v.pesel;
  await db.update(workersTable).set(workerPatch).where(eq(workersTable.id, row.workerId));
  // анкета → профіль: рахунок з анкети стає рахунком профілю (services/questionnaireSync.ts)
  await (await import("../services/questionnaireSync")).syncQuestionnaireToProfile(row.workerId);

  ok(res, { ok: true });
});

// Довідка студента — окремим типом документа (icon="student"), одразу з
// кроку анкети (замість окремого походу через бот пізніше). Той самий сервіс,
// що й самозавантаження в боті (applyWorkerDocumentUpload) — status=pending,
// офіс перевіряє актуальність.
router.post("/passport-scan/:token/student-cert", uploadScan.single("file"), async (req, res) => {
  const [row] = await db.select().from(passportScanTokensTable).where(eq(passportScanTokensTable.token, String(req.params.token)));
  if (!row) return fail(res, 404, "Лінк недійсний.");
  if (!row.workerId) return fail(res, 400, "Спершу відскануй паспорт.");
  if (new Date(row.expiresAt).getTime() < Date.now()) return fail(res, 404, "Термін дії лінку вичерпано.");
  if (!req.file) return fail(res, 400, "Файл не отримано (недопустимий тип або завеликий)");

  try {
    const docType = await ensureDocumentType("student_cert");
    const originalName = Buffer.from(req.file.originalname ?? "certificate.jpg", "latin1").toString("utf8");
    const { documentId, title } = await applyWorkerDocumentUpload(row.workerId, docType.id, req.file.buffer, originalName);
    ok(res, { doc: { id: documentId, title } });
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося завантажити файл");
  }
});

// ── Токен-генерація для бот-флоу (office/self) — імпортується з bot/ ────────
const SCAN_TOKEN_TTL_MS = 30 * 60 * 1000; // 30хв — офісний лінк «зайшов і відсканував» (кандидат поруч)
const SELF_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // самореєстрація з бота — 7 днів, відкривають коли зручно

export async function createOfficeScanToken(adminId: number, candidateId?: number, factoryId?: number): Promise<string> {
  const token = randomInviteCode(24);
  // Лінк з картки кандидата без Telegram офіс ПЕРЕДАЄ кандидату (SMS/WhatsApp) — 30 хв на це
  // замало (інцидент Ndlovu 12.10.2026: лінк протух, «нічого не відбувалось»)
  const ttl = candidateId != null ? SELF_TOKEN_TTL_MS : SCAN_TOKEN_TTL_MS;
  await db.insert(passportScanTokensTable).values({
    token, purpose: "office", createdBy: adminId, candidateId: candidateId ?? null, factoryId: factoryId ?? null, expiresAt: new Date(Date.now() + ttl),
  });
  return token;
}

export async function createSelfScanToken(opts: { factoryId: number; telegramId: string; language: string; candidateId?: number; signupLinkId?: number }): Promise<string> {
  const token = randomInviteCode(24);
  await db.insert(passportScanTokensTable).values({
    token, purpose: "self", factoryId: opts.factoryId, telegramId: opts.telegramId, language: opts.language,
    // самореєстрація з бота: лінк відкривають не «зайшов і відсканував», а коли зручно — 7 днів
    // (30 хв убивали лінк, поки людина доходила до телефону; прод 21.09.2026)
    candidateId: opts.candidateId ?? null, signupLinkId: opts.signupLinkId ?? null, expiresAt: new Date(Date.now() + SELF_TOKEN_TTL_MS),
  });
  return token;
}

// Дозаповнення/редагування анкети ІСНУЮЧИМ працівником пізніше (бот «📄
// Документи → заповнити анкету») — на відміну від office/self, workerId
// відомий одразу (нема кроку сканування паспорта), сторінка одразу відкриває
// крок анкети. usedAt НЕ ставимо — loadValidToken() трактує usedAt як «лінк
// уже спожито» (для office/self це означає «профіль уже створено, цей
// токен — для сканування, не для повторного використання»), а анкету можна
// дозаповнювати кілька разів у межах TTL. Довший TTL (24г, не 30хв) — це не
// разова дія «зайшов і відсканував», людина може повернутись пізніше.
const ANKETA_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export async function createAnketaToken(workerId: number): Promise<string> {
  const token = randomInviteCode(24);
  await db.insert(passportScanTokensTable).values({
    token, purpose: "anketa", workerId, expiresAt: new Date(Date.now() + ANKETA_TOKEN_TTL_MS),
  });
  return token;
}

export const passportScanLink = (token: string): string => {
  const base = (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");
  return base ? `${base}/passport-scan/${token}` : `/passport-scan/${token}`;
};

export default router;
