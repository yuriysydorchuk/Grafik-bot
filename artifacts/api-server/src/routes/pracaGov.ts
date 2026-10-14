// /praca-gov — робот подачі powiadomienia PSZ-PPWPU (12.10.2026). Гейт: cap `legalization`.
// Акаунти profilu zaufanego: свої (власник = хто додав; коди SMS ідуть йому), головний/owner
// бачать усі без секретів. Паролі приймаються лише на створення/зміну і ніколи не повертаються.
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { Router, type IRouter } from "express";
import { UPLOADS_ROOT, sniffDocMime } from "../lib/uploads";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";
import {
  listPzAccounts, createPzAccount, updatePzAccount, deletePzAccount, pzAccountById, pzReady, setPzAccountPoa,
  startLoginTest, submitCode, cancelSubmission, submissionById, recentSubmissions, screenshotPath, previewPath, isAccountBusy, decideSubmission,
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
