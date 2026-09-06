// Публічна сторінка завантаження запитаного документа (/docs/:token) — без сесії, токен
// (passport_scan_tokens.purpose='docs', 30 днів) єдина авторизація, як /passport-scan/:token.
// GET — що просимо (типи з requested_at, статуси), POST upload — той самий сервіс, що й
// самозавантаження (applyWorkerDocumentUpload → pending → задача перевірки офісу одразу).
import { Router, type IRouter } from "express";
import multer from "multer";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, passportScanTokensTable, workersTable, workerDocumentsTable, documentTypesTable } from "@workspace/db";
import { applyWorkerDocumentUpload } from "../services/workerDocuments";
import { t as tw, asLang } from "../bot/i18n";
import { bot } from "../bot/instance";
import { dateStr } from "../services/taskUtils";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });

async function loadToken(token: string) {
  const [row] = await db.select().from(passportScanTokensTable).where(and(eq(passportScanTokensTable.token, token), eq(passportScanTokensTable.purpose, "docs")));
  if (!row || !row.workerId) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  return row;
}

router.get("/docs/:token", async (req, res) => {
  const row = await loadToken(String(req.params.token));
  if (!row) return fail(res, 404, "Лінк недійсний або прострочений");
  const [w] = await db.select({ id: workersTable.id, fullName: workersTable.fullName, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, row.workerId!));
  if (!w) return fail(res, 404, "Лінк недійсний");
  const focusTypeId = Number((row.draftJson as any)?.docTypeId) || null;
  const docs = await db.select({ d: workerDocumentsTable, typeName: documentTypesTable.name, typeId: documentTypesTable.id })
    .from(workerDocumentsTable).leftJoin(documentTypesTable, eq(workerDocumentsTable.docTypeId, documentTypesTable.id))
    .where(and(eq(workerDocumentsTable.workerId, w.id), isNotNull(workerDocumentsTable.requestedAt)));
  const items = docs.filter(x => x.typeId).map(x => ({
    docTypeId: x.typeId!, name: x.typeName ?? x.d.title, expiresAt: dateStr(x.d.expiresAt), status: x.d.status,
    requestedAt: x.d.requestedAt ? dateStr(x.d.requestedAt) : null, uploadedAt: x.d.status === "pending" ? dateStr(x.d.updatedAt) : null, reviewNote: x.d.status === "missing" ? x.d.reviewNote : null,
  }));
  if (focusTypeId && !items.some(i => i.docTypeId === focusTypeId)) {
    const [ty] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, focusTypeId));
    if (ty) items.unshift({ docTypeId: ty.id, name: ty.name, expiresAt: null, status: "missing", requestedAt: null, uploadedAt: null, reviewNote: null });
  }
  items.sort((a, b) => (a.docTypeId === focusTypeId ? -1 : b.docTypeId === focusTypeId ? 1 : 0));
  return res.json({ workerName: w.fullName, language: asLang(row.language ?? w.language), focusTypeId, items });
});

router.post("/docs/:token/upload", upload.single("file"), async (req, res) => {
  const row = await loadToken(String(req.params.token));
  if (!row) return fail(res, 404, "Лінк недійсний або прострочений");
  const docTypeId = Number(req.body?.docTypeId);
  if (!docTypeId) return fail(res, 400, "Вкажіть тип документа");
  if (!req.file) return fail(res, 400, "Файл не отримано (недопустимий тип або завеликий)");
  // дозволено лише те, що просили (requested_at) або тип із лінка
  const focusTypeId = Number((row.draftJson as any)?.docTypeId) || null;
  const [requested] = await db.select({ id: workerDocumentsTable.id }).from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, row.workerId!), eq(workerDocumentsTable.docTypeId, docTypeId), isNotNull(workerDocumentsTable.requestedAt)));
  if (!requested && focusTypeId !== docTypeId) return fail(res, 400, "Цей документ не запитували");
  try {
    const originalName = Buffer.from(req.file.originalname ?? "document.jpg", "latin1").toString("utf8");
    const { documentId, title } = await applyWorkerDocumentUpload(row.workerId!, docTypeId, req.file.buffer, originalName);
    // підтвердження в бот (best-effort)
    const [w] = await db.select({ telegramId: workersTable.telegramId, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, row.workerId!));
    if (w?.telegramId) bot.telegram.sendMessage(w.telegramId, tw(asLang(w.language), "docs.uploaded", { doc: title })).catch(() => {});
    return res.json({ ok: true, doc: { id: documentId, title } });
  } catch (e: any) { return fail(res, 400, e?.message ?? "Не вдалося завантажити файл"); }
});

export default router;
