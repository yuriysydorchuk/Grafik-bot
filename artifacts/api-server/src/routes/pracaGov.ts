// /praca-gov — робот подачі powiadomienia PSZ-PPWPU (12.10.2026). Гейт: cap `legalization`.
// Акаунти profilu zaufanego: свої (власник = хто додав; коди SMS ідуть йому), головний/owner
// бачать усі без секретів. Паролі приймаються лише на створення/зміну і ніколи не повертаються.
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { db, workersTable, workerDocumentsTable, documentTypesTable } from "@workspace/db";
import { UPLOADS_ROOT, WORKER_DOCS_DIR, sniffDocMime, compressUploadImage, makeStoredName } from "../lib/uploads";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";
import {
  listPzAccounts, createPzAccount, updatePzAccount, deletePzAccount, pzAccountById, pzReady, setPzAccountPoa,
  startLoginTest, submitCode, cancelSubmission, submissionById, recentSubmissions, screenshotPath, previewPath, isAccountBusy, decideSubmission,
  previewSubmission, startSubmission, openSubmissionFor,
} from "../services/pracaGov";

const router: IRouter = Router();
router.use("/praca-gov", authRequired, requireCap("legalization"));

const ok = (res: any, data: unknown) => res.json(data);
const fail = (res: any, code: number, error: string) => res.status(code).json({ error });
const seesAll = (req: AuthedRequest) => !!req.admin && (req.admin.isMain || req.admin.role === "owner");

// Акаунт profilu zaufanego привʼязаний до адміна, який його додав: будь-яка дія з ним (редагування,
// пароль, довіреність, тест входу, видалення, подача) — ЛИШЕ власник. Головний/owner бачать
// список без секретів і стан подач, але чужий акаунт використати чи змінити не можуть.
async function ownAccount(req: AuthedRequest, id: number) {
  const a = await pzAccountById(id);
  if (!a) return undefined;
  return a.adminId === req.admin!.adminId ? a : undefined;
}
// перегляд подачі — власник або головний/owner; КЕРУВАННЯ (код, рішення, скасування) — лише власник
async function viewSubmission(req: AuthedRequest, id: number) {
  const s = await submissionById(id);
  if (!s) return undefined;
  return seesAll(req) || s.adminId === req.admin!.adminId ? s : undefined;
}
async function ownSubmission(req: AuthedRequest, id: number) {
  const s = await submissionById(id);
  if (!s) return undefined;
  return s.adminId === req.admin!.adminId ? s : undefined;
}

router.get("/praca-gov/status", (_req, res) => ok(res, { ready: pzReady() }));

router.get("/praca-gov/accounts", async (req: AuthedRequest, res) => {
  const rows = await listPzAccounts(seesAll(req) ? {} : { adminId: req.admin!.adminId });
  ok(res, rows.map(r => ({ ...r, busy: isAccountBusy(r.id), own: r.adminId === req.admin!.adminId })));
});

router.post("/praca-gov/accounts", async (req: AuthedRequest, res) => {
  try { ok(res, await createPzAccount(req.admin!.adminId, req.body ?? {})); } catch (e: any) { fail(res, 400, e?.message ?? "Помилка"); }
});

router.patch("/praca-gov/accounts/:id", async (req: AuthedRequest, res) => {
  const a = await ownAccount(req, Number(req.params.id));
  if (!a) return fail(res, 404, "Акаунт не знайдено");
  try { await updatePzAccount(a.id, req.body ?? {}); ok(res, { ok: true }); } catch (e: any) { fail(res, 400, e?.message ?? "Помилка"); }
});

router.delete("/praca-gov/accounts/:id", async (req: AuthedRequest, res) => {
  const a = await ownAccount(req, Number(req.params.id));
  if (!a) return fail(res, 404, "Акаунт не знайдено");
  if (isAccountBusy(a.id)) return fail(res, 409, "Акаунт зараз виконує подачу");
  await deletePzAccount(a.id);
  ok(res, { ok: true });
});

// Pełnomocnictwo (PDF) власника акаунта: форма вимагає załącznik, коли підписує pełnomocnik.
// Зберігається під UPLOADS_ROOT/pz-attachments/<accountId>/pelnomocnictwo.pdf; усе — лише власник акаунта.
const POA_DIR = path.join(UPLOADS_ROOT, "pz-attachments");
const poaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
router.post("/praca-gov/accounts/:id/poa", poaUpload.single("file"), async (req: AuthedRequest, res) => {
  const a = await ownAccount(req, Number(req.params.id));
  if (!a) return fail(res, 404, "Акаунт не знайдено");
  if (isAccountBusy(a.id)) return fail(res, 409, "Акаунт зараз виконує подачу");
  if (!req.file) return fail(res, 400, "Файл не отримано");
  if (sniffDocMime(req.file.buffer) !== "application/pdf") return fail(res, 400, "Потрібен PDF");
  const dir = path.join(POA_DIR, String(a.id));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "pelnomocnictwo.pdf"), req.file.buffer);
  await setPzAccountPoa(a.id, path.posix.join("pz-attachments", String(a.id), "pelnomocnictwo.pdf"));
  ok(res, { ok: true });
});
router.delete("/praca-gov/accounts/:id/poa", async (req: AuthedRequest, res) => {
  const a = await ownAccount(req, Number(req.params.id));
  if (!a) return fail(res, 404, "Акаунт не знайдено");
  if (isAccountBusy(a.id)) return fail(res, 409, "Акаунт зараз виконує подачу");
  if (a.poaFilePath) { const abs = path.resolve(UPLOADS_ROOT, a.poaFilePath); if (abs.startsWith(POA_DIR + path.sep)) fs.rmSync(abs, { force: true }); }
  await setPzAccountPoa(a.id, null);
  ok(res, { ok: true });
});
router.get("/praca-gov/accounts/:id/poa", async (req: AuthedRequest, res) => {
  const a = await ownAccount(req, Number(req.params.id));
  if (!a?.poaFilePath) return fail(res, 404, "Довіреності нема");
  const abs = path.resolve(UPLOADS_ROOT, a.poaFilePath);
  if (!abs.startsWith(POA_DIR + path.sep) || !fs.existsSync(abs)) return fail(res, 404, "Файл не знайдено");
  res.setHeader("Content-Type", "application/pdf"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "private, no-store");
  fs.createReadStream(abs).pipe(res);
});

// Тест входу — лише власник (коди SMS приходять на його телефон)
router.post("/praca-gov/accounts/:id/test-login", async (req: AuthedRequest, res) => {
  const a = await ownAccount(req, Number(req.params.id));
  if (!a) return fail(res, 404, "Акаунт не знайдено");
  if (a.adminId !== req.admin!.adminId) return fail(res, 403, "Тест входу запускає власник акаунта");
  try { ok(res, { submissionId: await startLoginTest(a.id, req.admin!.adminId) }); } catch (e: any) { fail(res, 400, e?.message ?? "Помилка"); }
});

// Подача з профілю працівника (14.10.2026): плюсик біля Powiadomienie → «Автоматична подача» без задачі
// ступеня 2. Той самий ланцюжок, що з задачі (перегляд анкети → робот → Wydruk → підпис); документ у профіль
// кладе attachConfirmation напряму, задачу ступеня 2 (якщо є) закриє синк. ?companyId= — рядок людина×фірма.
const workerExists = async (id: number) => id > 0 && !!(await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.id, id))).length;
const companyOf = (v: unknown) => v != null && Number(v) > 0 ? Number(v) : null;
router.get("/praca-gov/workers/:id/ua-preview", async (req: AuthedRequest, res) => {
  const wid = Number(req.params.id);
  if (!(await workerExists(wid))) return fail(res, 404, "Працівника не знайдено");
  try { ok(res, await previewSubmission(wid, companyOf(req.query.companyId), req.admin!.adminId)); } catch (e: any) { fail(res, 400, e?.message ?? "Помилка"); }
});
router.post("/praca-gov/workers/:id/ua-submit", async (req: AuthedRequest, res) => {
  const wid = Number(req.params.id);
  if (!(await workerExists(wid))) return fail(res, 404, "Працівника не знайдено");
  try { ok(res, await startSubmission({ taskId: null, workerId: wid, companyId: companyOf(req.body?.companyId), adminId: req.admin!.adminId, overrides: req.body?.overrides })); } catch (e: any) { fail(res, 400, e?.message ?? "Помилка"); }
});
// Скан паспорта для załącznika, якщо в профілі його нема (19.10.2026): файл лягає в документ «Paszport» профілю
// (наявний рядок без файлу — доповнюємо; нема — створюємо present), далі анкета перечитує залучники.
const passUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
router.post("/praca-gov/workers/:id/passport-file", passUpload.single("file"), async (req: AuthedRequest, res) => {
  const wid = Number(req.params.id);
  if (!(await workerExists(wid))) return fail(res, 404, "Працівника не знайдено");
  if (!req.file) return fail(res, 400, "Файл не отримано");
  const rawMime = sniffDocMime(req.file.buffer);
  if (!rawMime || !["application/pdf", "image/jpeg", "image/png"].includes(rawMime)) return fail(res, 400, "Дозволено PDF, JPG або PNG");
  const { ensureDocumentType } = await import("../services/workerDocuments");
  const { documentChanged } = await import("../services/documentEvents");
  const ty = await ensureDocumentType("passport");
  // доповнюємо ЛИШЕ рядок без файлу (запрошений/на перевірці/внесений без скану); рядок зі сканом не чіпаємо — створюємо новий
  const [existing] = await db.select().from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, wid), eq(workerDocumentsTable.docTypeId, ty.id), ne(workerDocumentsTable.status, "expired"), isNull(workerDocumentsTable.filePath))).orderBy(desc(workerDocumentsTable.id)).limit(1);
  const rawName = Buffer.from(req.file.originalname || "paszport", "latin1").toString("utf8");
  const { buffer, mime, fileName } = await compressUploadImage(req.file.buffer, rawMime, rawName);
  const stored = makeStoredName(fileName);
  fs.mkdirSync(WORKER_DOCS_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(WORKER_DOCS_DIR, stored), buffer);
  const relPath = path.join("worker-documents", stored);
  let docId: number;
  if (existing) {
    // офіс вантажить скан сам = перевірено: missing/pending стають present (інакше залучник не потрапить у подачу — payload бере лише present)
    await db.update(workerDocumentsTable).set({ filePath: relPath, fileName, fileMime: mime, status: existing.status === "missing" || existing.status === "pending" ? "present" : existing.status, updatedAt: new Date() }).where(eq(workerDocumentsTable.id, existing.id));
    docId = existing.id;
    await documentChanged({ id: docId, workerId: wid }, "file", { adminId: req.admin!.adminId }, [{ field: "fileName", to: fileName }]);
  } else {
    const [d] = await db.insert(workerDocumentsTable).values({ workerId: wid, docTypeId: ty.id, title: ty.name, status: "present", filePath: relPath, fileName, fileMime: mime, source: "office" }).returning();
    docId = d!.id;
    await documentChanged({ id: docId, workerId: wid }, "created", { adminId: req.admin!.adminId });
  }
  ok(res, { ok: true, documentId: docId });
});
router.get("/praca-gov/workers/:id/ua-submission", async (req: AuthedRequest, res) => {
  const wid = Number(req.params.id);
  if (!(await workerExists(wid))) return fail(res, 404, "Працівника не знайдено");
  ok(res, { submissionId: await openSubmissionFor(wid, companyOf(req.query.companyId), req.admin!.adminId) });
});

router.get("/praca-gov/submissions", async (req: AuthedRequest, res) => {
  const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
  ok(res, await recentSubmissions({ adminId: seesAll(req) ? undefined : req.admin!.adminId, accountId: Number.isInteger(accountId) ? accountId : undefined, limit: 30 }));
});

router.get("/praca-gov/submissions/:id", async (req: AuthedRequest, res) => {
  const s = await viewSubmission(req, Number(req.params.id));
  if (!s) return fail(res, 404, "Подачу не знайдено");
  ok(res, s);
});

router.post("/praca-gov/submissions/:id/code", async (req: AuthedRequest, res) => {
  const s = await ownSubmission(req, Number(req.params.id));
  if (!s) return fail(res, 404, "Подачу не знайдено");
  try { await submitCode(s.id, String(req.body?.code ?? "")); ok(res, { ok: true }); } catch (e: any) { fail(res, 400, e?.message ?? "Помилка"); }
});

// Рішення на перегляді заповненої форми: save_draft | sign | cancel
router.post("/praca-gov/submissions/:id/decision", async (req: AuthedRequest, res) => {
  const s = await ownSubmission(req, Number(req.params.id));
  if (!s) return fail(res, 404, "Подачу не знайдено");
  const d = String(req.body?.decision ?? "");
  if (!["save_draft", "sign", "cancel"].includes(d)) return fail(res, 400, "Невідоме рішення");
  try { await decideSubmission(s.id, d as "save_draft" | "sign" | "cancel"); ok(res, { ok: true }); } catch (e: any) { fail(res, 400, e?.message ?? "Помилка"); }
});

router.post("/praca-gov/submissions/:id/cancel", async (req: AuthedRequest, res) => {
  const s = await ownSubmission(req, Number(req.params.id));
  if (!s) return fail(res, 404, "Подачу не знайдено");
  await cancelSubmission(s.id);
  ok(res, { ok: true });
});

// «Wydruk» заповненої форми (PDF/PNG) — те, що піде на підпис; inline для iframe
router.get("/praca-gov/submissions/:id/preview", async (req: AuthedRequest, res) => {
  const s = await viewSubmission(req, Number(req.params.id));
  if (!s) return fail(res, 404, "Подачу не знайдено");
  const p = previewPath(s);
  if (!p) return fail(res, 404, "Wydruk ще не готовий");
  res.setHeader("Content-Type", p.mime); res.setHeader("Content-Disposition", "inline; filename=\"powiadomienie.pdf\"");
  res.setHeader("Cache-Control", "private, no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(p.abs).pipe(res);
});

// Скріншоти кроків (персональні дані — лише під auth, без кешу)
router.get("/praca-gov/submissions/:id/screenshot/:idx", async (req: AuthedRequest, res) => {
  const s = await viewSubmission(req, Number(req.params.id));
  if (!s) return fail(res, 404, "Подачу не знайдено");
  const abs = screenshotPath(s, Number(req.params.idx));
  if (!abs) return fail(res, 404, "Знімка нема");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(abs).pipe(res);
});

export default router;
