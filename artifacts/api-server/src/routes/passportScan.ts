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
// показує РЕДАГОВНИЙ екран підтвердження (вручну ввести ім'я «з нуля» не
// можна, а виправити розпізнане — можна), confirm() із фінальних (можливо
// підправлених) полів створює працівника.
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import {
  db, passportScanTokensTable, workersTable, workerQuestionnairesTable, workerDocumentsTable,
  documentTypesTable, factoriesTable, adminsTable, candidatesTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { UPLOADS_ROOT, WORKER_DOCS_DIR, PASSPORT_SCAN_TMP_DIR, makeStoredName, sniffDocMime, deleteStoredFile } from "../lib/uploads";
import { processPassport, passportOcrConfigured, mrzNationalityToCatalog, mrzDiagnostics, type PassportDraft } from "../services/docai";
import { randomInviteCode, ensureWorkerInviteCode, workerInviteLink } from "../lib/invite";
import { nextWorkerCode } from "../lib/workerCode";
import { findLikelyDuplicate } from "../bot/workerMatch";
import { bot } from "../bot/instance";
import { logger } from "../lib/logger";
import { ensureDocumentType, applyWorkerDocumentUpload } from "../services/workerDocuments";

const router: IRouter = Router();
const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });

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
  const { row, error } = await loadValidToken(req.params.token);
  if (error || !row) return fail(res, 404, error ?? "Лінк недійсний.");
  const [factory] = row.factoryId ? await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, row.factoryId)) : [undefined];

  // purpose=anketa (bot "📄 Документи → заповнити анкету", запрошення
  // ІСНУЮЧОГО працівника на скан+анкету з веб-панелі) — workerId відомий
  // одразу. Віддаємо вже збережені відповіді, щоб форма не стартувала з
  // чистого бланку щоразу.
  let questionnaire: Record<string, unknown> | null = null;
  let pesel: string | null = null;
  let nameDraft: { firstName: string | null; middleName: string | null; lastName: string | null } | null = null;
  // office/self — паспорта в системі гарантовано ще нема, скан обов'язковий.
  // anketa — залежить від того, чи в цього працівника вже є "Paszport" на
  // файлі: якщо нема (запрошення на скан+анкету для когось, кого завели без
  // паспорта — бот-імпорт/ручне додавання) — сторінка теж стартує зі скану,
  // а не одразу з анкети.
  let needsPassportScan = row.purpose !== "anketa";
  if (row.workerId) {
    const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, row.workerId));
    if (q) questionnaire = q;
    const [w] = await db.select({ pesel: workersTable.pesel, fullName: workersTable.fullName, firstName: workersTable.firstName, middleName: workersTable.middleName, lastName: workersTable.lastName })
      .from(workersTable).where(eq(workersTable.id, row.workerId));
    pesel = w?.pesel ?? null;
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
    if (row.purpose === "anketa") {
      const [passportDoc] = await db.select({ id: workerDocumentsTable.id }).from(workerDocumentsTable)
        .innerJoin(documentTypesTable, eq(workerDocumentsTable.docTypeId, documentTypesTable.id))
        .where(and(eq(workerDocumentsTable.workerId, row.workerId), eq(documentTypesTable.name, "Paszport"), eq(workerDocumentsTable.status, "present")));
      needsPassportScan = !passportDoc;
    }
  }

  ok(res, { purpose: row.purpose, factoryName: factory?.name ?? null, language: row.language ?? "uk", questionnaire, pesel, needsPassportScan, nameDraft });
});

// Файл → OCR → чернетка. Файл лягає у тимчасову теку (переноситься у постійну
// лише при confirm()) — можна спробувати кілька разів (гірше фото не пройде
// перевірку MRZ), кожна спроба перезаписує попередню тимчасову теку.
router.post("/passport-scan/:token/analyze", uploadScan.single("file"), async (req, res) => {
  const { row, error } = await loadValidToken(String(req.params.token));
  if (error || !row) return fail(res, 404, error ?? "Лінк недійсний.");
  if (!req.file) return fail(res, 400, "Файл не отримано (недопустимий тип або завеликий)");
  const realMime = sniffDocMime(req.file.buffer);
  if (!realMime || !SCAN_MIME_WHITELIST.has(realMime)) return fail(res, 400, "Тип файлу не підтверджено вмістом");
  if (!passportOcrConfigured()) return fail(res, 501, "OCR паспорта не налаштований на цьому сервері");

  try {
    const { draft, mrz, fullText } = await processPassport(req.file.buffer, realMime);
    // parsePassportMrz() навмисно повертає БУДЬ-яку структурно схожу на MRZ
    // пару рядків, навіть якщо чек-суми не збігаються (це use-case для
    // сервісів, яким потрібен сам факт розбіжності) — mrzToPassportDraft()
    // так само беззастережно копіює поля. Без явної перевірки чек-сум ТУТ
    // (на межі використання) хибно розпізнана MRZ-подібна послідовність
    // (шум фону, злиті рядки) підставлялась як ніби достовірні дані —
    // побачений на практиці баг: номер паспорта й громадянство — сміття,
    // що користувач не мав шансів відрізнити від правди на екрані підтвердження.
    // НЕ вимагаємо compositeValid: вона рахується разом з полем "особистий
    // номер" (14 симв., у більшості паспортів — просто заповнювач "<<<<...",
    // дрібний і рясний на "<" фрагмент рядка) — те, що ми взагалі не
    // показуємо й не використовуємо. На практиці саме воно найчастіше
    // помиляється при OCR і валило composite навіть коли номер паспорта,
    // дата народження й дата закінчення (усе, що реально йде в анкету)
    // розпізнались і перевірились чек-сумою бездоганно — цілком читабельне
    // фото відхилялось як "не вдалося розпізнати".
    const mrzValid = !!mrz && mrz.documentNumberValid && mrz.birthDateValid && mrz.expiryDateValid;
    if (!draft.fullName || (mrz && !mrzValid)) {
      // Сам текст паспорта в лог НЕ пишемо (RODO) — лише структурні метрики
      // (mrzDiagnostics), щоб відрізнити «Vision взагалі нічого не побачив»
      // (проблема якості фото/кропу) від «побачив щось, але структура/чек-сума
      // не збіглась» (наприклад, Vision розбив один MRZ-рядок на два коротших).
      logger.warn({ tokenId: row.id, fileBytes: req.file.buffer.length, realMime, mrzFound: !!mrz, mrzChecks: mrz ? { doc: mrz.documentNumberValid, birth: mrz.birthDateValid, exp: mrz.expiryDateValid, composite: mrz.compositeValid } : null, ...mrzDiagnostics(fullText) }, "passport-scan analyze failed");
      return fail(res, 400, "Не вдалося розпізнати паспорт — сфотографуй чіткіше (рівне освітлення, без відблисків, сторінка з фото та машинозчитуваними рядками знизу, без стороннього фону в кадрі) і спробуй ще раз.");
    }

    deleteStoredFile(row.tempFilePath);
    const originalName = Buffer.from(req.file.originalname ?? "passport", "latin1").toString("utf8");
    const storedName = makeStoredName(originalName || "passport.jpg");
    await fs.promises.writeFile(path.join(PASSPORT_SCAN_TMP_DIR, storedName), req.file.buffer);

    await db.update(passportScanTokensTable).set({
      tempFilePath: path.join("passport-scan-tmp", storedName), tempFileName: originalName, tempFileMime: realMime,
      draftJson: { draft, mrz },
    }).where(eq(passportScanTokensTable.id, row.id));

    logger.info({ tokenId: row.id, mrzValid }, "passport-scan analyze ok");
    ok(res, { draft, mrzValid });
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося розпізнати паспорт");
  }
});

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// Фінальні (можливо підправлені на екрані підтвердження) поля → створює
// працівника. factoryId/telegramId/language — з ТОКЕНА (серверний контекст,
// не з тіла запиту) — клієнт не може підсунути чужу фабрику чи telegramId.
router.post("/passport-scan/:token/confirm", async (req, res) => {
  const { row, error } = await loadValidToken(req.params.token);
  if (error || !row) return fail(res, 404, error ?? "Лінк недійсний.");
  if (!row.tempFilePath || !row.tempFileMime) return fail(res, 400, "Спершу відскануй паспорт.");

  const birthDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.birthDate) ? req.body.birthDate : null;
  const passportExpiresAt = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.passportExpiresAt) ? req.body.passportExpiresAt : null;
  const sex = req.body?.sex === "M" || req.body?.sex === "F" ? req.body.sex : null;
  const passportNumber = strOrNull(req.body?.passportNumber);
  const passportCountry = strOrNull(req.body?.passportCountry);
  const citizenship = strOrNull(req.body?.citizenship);

  // Для anketa-токена з уже відомим workerId (запрошення ІСНУЮЧОГО працівника
  // без паспорта на файлі) — доповнюємо профіль, НЕ створюємо новий (інакше
  // дублікат): код лишається як є, порожні поля добираються зі сканування.
  const isExistingWorker = !!row.workerId;
  const LATIN_NAME = /^[a-ząćęłńóśźż' -]+$/i;
  const firstName = strOrNull(req.body?.firstName);
  const middleNameIn = strOrNull(req.body?.middleName);
  const lastName = strOrNull(req.body?.lastName);
  if (!firstName || !LATIN_NAME.test(firstName)) return fail(res, 400, "Ім'я — лише латиницею (напр. Jan)");
  if (!lastName || !LATIN_NAME.test(lastName)) return fail(res, 400, "Прізвище — лише латиницею (напр. Kowalski)");
  if (middleNameIn && !LATIN_NAME.test(middleNameIn)) return fail(res, 400, "Друге ім'я — лише латиницею");

  try {
    let worker: typeof workersTable.$inferSelect;
    if (isExistingWorker) {
      const [existing] = await db.select().from(workersTable).where(eq(workersTable.id, row.workerId!));
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
      const fullName = [firstName, lastName].join(" ");
      const [created] = await db.insert(workersTable).values({
        fullName, firstName, middleName: middleNameIn, lastName,
        workerCode, factoryId: row.factoryId, telegramId: row.telegramId, language: row.language,
        birthDate, gender: sex === "M" ? "male" : sex === "F" ? "female" : null,
        nationality: mrzNationalityToCatalog(citizenship),
      }).returning();
      worker = created!;
    }

    let [docType] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.name, "Paszport"));
    if (!docType) [docType] = await db.insert(documentTypesTable).values({ name: "Paszport", required: true, hasExpiry: true, sortOrder: 0 }).returning();
    const tmpAbs = path.join(UPLOADS_ROOT, row.tempFilePath);
    const storedName = makeStoredName(row.tempFileName || "passport.jpg");
    const finalRel = path.join("worker-documents", storedName);
    await fs.promises.rename(tmpAbs, path.join(WORKER_DOCS_DIR, storedName));
    const [doc] = await db.insert(workerDocumentsTable).values({
      workerId: worker.id, docTypeId: docType!.id, title: "Paszport", status: "present",
      filePath: finalRel, fileName: row.tempFileName, fileMime: row.tempFileMime,
    }).returning();

    // Upsert — для isExistingWorker анкета могла вже частково існувати
    // (напр. дозаповнена раніше через бот без скану паспорта).
    const qPatch = { ocrRaw: row.draftJson, ocrDocId: doc!.id, passportNumber, passportCountry, passportExpiresAt, citizenship, sex };
    const [existingQ] = await db.select({ id: workerQuestionnairesTable.id }).from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, worker.id));
    if (existingQ) await db.update(workerQuestionnairesTable).set(qPatch).where(eq(workerQuestionnairesTable.workerId, worker.id));
    else await db.insert(workerQuestionnairesTable).values({ workerId: worker.id, ...qPatch });

    // expiresAt продовжуємо ще на SCAN_TOKEN_TTL_MS — токен далі живе для кроку
    // анкети (questionnaire нижче), а не тільки для самого сканування.
    await db.update(passportScanTokensTable).set({
      usedAt: new Date(), workerId: worker.id, tempFilePath: null, expiresAt: new Date(Date.now() + SCAN_TOKEN_TTL_MS),
    }).where(eq(passportScanTokensTable.id, row.id));
    logger.info({ tokenId: row.id, workerId: worker.id, purpose: row.purpose, isExistingWorker }, "passport-scan confirmed");

    // Рекрутинг: конвертація кандидата відкладала прив'язку worker/stage до
    // цього моменту (candidateId на токені) — див. POST /candidates/:id/convert.
    if (row.candidateId) {
      await db.update(candidatesTable).set({ workerId: worker.id, stage: "hired" }).where(eq(candidatesTable.id, row.candidateId));
    }

    // Дублікат-детект + сповіщення офісу — best-effort, не блокує результат.
    // Лише для щойно створеного профілю (office/self); для isExistingWorker
    // офіс сам ініціював запрошення — повторне сповіщення не потрібне.
    if (!isExistingWorker) try {
      const allWorkers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));
      const dup = findLikelyDuplicate(worker.fullName, allWorkers.filter(w => w.id !== worker.id));
      const dupNote = dup ? `\n⚠️ Можливий дублікат: ${dup.fullName} (№${dup.workerCode ?? dup.id}).` : "";

      if (row.purpose === "office" && row.createdBy) {
        const [admin] = await db.select().from(adminsTable).where(eq(adminsTable.id, row.createdBy));
        if (admin?.telegramId) {
          const invite = await ensureWorkerInviteCode(worker.id);
          await bot.telegram.sendMessage(admin.telegramId,
            `✅ Профіль створено зі сканування: ${worker.fullName} (№${worker.workerCode}).${dupNote}\n\nПосилання для кандидата (прив'язати Telegram і дозаповнити анкету):\n${workerInviteLink(invite)}`);
        }
      } else if (row.purpose === "self") {
        const staff = await db.select().from(adminsTable);
        for (const a of staff) {
          if (!a.telegramId || (a.role !== "owner" && a.role !== "scheduler")) continue;
          await bot.telegram.sendMessage(a.telegramId, `🆕 Новий працівник зареєструвався сам (паспорт):\n👤 ${worker.fullName}${dupNote}\n\nПеревірте/відредагуйте в панелі (Працівники).`).catch(() => {});
        }
      }
    } catch (e) { logger.warn({ err: e }, "passport-scan confirm notify failed"); }

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
  const patch: Record<string, unknown> = { status: "submitted", submittedAt: new Date(), updatedAt: new Date() };
  for (const k of [
    "birthPlace", "addressRegistered", "addressPl", "postalCode", "city", "motherName", "fatherName", "bankName", "bankIban",
    "phone", "email", "taxOffice", "nfzBranch", "schoolName", "otherEmploymentNote", "emergencyContact",
    "nip", "taxOfficeAddress",
    "regWojewodztwo", "regPowiat", "regGmina", "regMiejscowosc", "regUlica", "regNumerDomu", "regKodPocztowy",
    "zamWojewodztwo", "zamPowiat", "zamGmina", "zamMiejscowosc", "zamUlica", "zamNumerDomu", "zamKodPocztowy",
  ] as const) {
    if (b[k] !== undefined) patch[k] = strOrNull(b[k]);
  }
  if (b.isStudent !== undefined) patch.isStudent = !!b.isStudent;
  if (b.hasOtherEmployment !== undefined) patch.hasOtherEmployment = !!b.hasOtherEmployment;
  if (b.isRegisteredUnemployed !== undefined) patch.isRegisteredUnemployed = !!b.isRegisteredUnemployed;
  if (b.pit0 !== undefined) patch.pit0 = !!b.pit0;
  if (b.ankietaInnyPracodawca !== undefined) patch.ankietaInnyPracodawca = !!b.ankietaInnyPracodawca;
  if (b.ankietaEmeryt !== undefined) patch.ankietaEmeryt = !!b.ankietaEmeryt;
  if (b.ankietaRencista !== undefined) patch.ankietaRencista = !!b.ankietaRencista;
  if (b.ankietaNiepelnosprawnosc !== undefined) patch.ankietaNiepelnosprawnosc = !!b.ankietaNiepelnosprawnosc;
  if (b.ankietaSkladkaChorobowa !== undefined) patch.ankietaSkladkaChorobowa = !!b.ankietaSkladkaChorobowa;

  // Upsert — з purpose=anketa (дозаповнення пізніше) рядка анкети може ще
  // не існувати взагалі (confirm(), що завжди його створює, для anketa-токена
  // не викликався — нема кроку сканування паспорта).
  const [existing] = await db.select({ id: workerQuestionnairesTable.id }).from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, row.workerId));
  if (existing) await db.update(workerQuestionnairesTable).set(patch).where(eq(workerQuestionnairesTable.workerId, row.workerId));
  else await db.insert(workerQuestionnairesTable).values({ workerId: row.workerId, ...patch });

  // PESEL і структуроване ім'я/по-батькові/прізвище живуть на workersTable
  // (канонічні поля, не дублюємо в анкеті) — обидва необов'язкові тут (для
  // needsPassportScan=false людина заповнює це вперше саме на цьому кроці,
  // без окремого екрана підтвердження), невалідний формат тихо ігноруємо
  // (не блокуємо решту анкети через одне поле). fullName НЕ чіпаємо —
  // канонічне джерело для сортування/матчингу/бота лишається як є.
  const workerPatch: Record<string, unknown> = {};
  const pesel = strOrNull(b.pesel);
  if (pesel && /^\d{11}$/.test(pesel)) workerPatch.pesel = pesel;
  const LATIN_NAME = /^[a-ząćęłńóśźż' -]+$/i;
  const firstNameIn = strOrNull(b.firstName);
  const lastNameIn = strOrNull(b.lastName);
  if (firstNameIn && LATIN_NAME.test(firstNameIn)) workerPatch.firstName = firstNameIn;
  if (lastNameIn && LATIN_NAME.test(lastNameIn)) workerPatch.lastName = lastNameIn;
  if (b.middleName !== undefined) {
    const middleNameIn = strOrNull(b.middleName);
    workerPatch.middleName = middleNameIn && LATIN_NAME.test(middleNameIn) ? middleNameIn : null;
  }
  if (Object.keys(workerPatch).length) await db.update(workersTable).set(workerPatch).where(eq(workersTable.id, row.workerId));

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
    const docType = await ensureDocumentType("Довідка студента", { hasExpiry: true, icon: "student" });
    const originalName = Buffer.from(req.file.originalname ?? "certificate.jpg", "latin1").toString("utf8");
    const { documentId, title } = await applyWorkerDocumentUpload(row.workerId, docType.id, req.file.buffer, originalName);
    ok(res, { doc: { id: documentId, title } });
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося завантажити файл");
  }
});

// ── Токен-генерація для бот-флоу (office/self) — імпортується з bot/ ────────
const SCAN_TOKEN_TTL_MS = 30 * 60 * 1000; // 30хв — набагато коротше за signature_tokens (72г): це разова дія «зайшов і відсканував», не «підпиши коли зручно»

export async function createOfficeScanToken(adminId: number, candidateId?: number): Promise<string> {
  const token = randomInviteCode(24);
  await db.insert(passportScanTokensTable).values({
    token, purpose: "office", createdBy: adminId, candidateId: candidateId ?? null, expiresAt: new Date(Date.now() + SCAN_TOKEN_TTL_MS),
  });
  return token;
}

export async function createSelfScanToken(opts: { factoryId: number; telegramId: string; language: string; candidateId?: number }): Promise<string> {
  const token = randomInviteCode(24);
  await db.insert(passportScanTokensTable).values({
    token, purpose: "self", factoryId: opts.factoryId, telegramId: opts.telegramId, language: opts.language,
    candidateId: opts.candidateId ?? null, expiresAt: new Date(Date.now() + SCAN_TOKEN_TTL_MS),
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
