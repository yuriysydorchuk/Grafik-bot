// Публічна сторінка завантаження запитаного документа (/docs/:token) — без сесії, токен
// (passport_scan_tokens.purpose='docs', 30 днів) єдина авторизація, як /passport-scan/:token.
// GET — що просимо (типи з requested_at, статуси), POST upload — той самий сервіс, що й
// самозавантаження (applyWorkerDocumentUpload → pending → задача перевірки офісу одразу).
import { Router, type IRouter } from "express";
import multer from "multer";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, passportScanTokensTable, workersTable, workerDocumentsTable, documentTypesTable } from "@workspace/db";
import { applyWorkerDocumentUpload, validateWorkerFields, workerFieldsOf } from "../services/workerDocuments";
import { warsawToday } from "../services/tasks";
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
  const docs = await db.select({ d: workerDocumentsTable, type: documentTypesTable })
    .from(workerDocumentsTable).leftJoin(documentTypesTable, eq(workerDocumentsTable.docTypeId, documentTypesTable.id))
    .where(and(eq(workerDocumentsTable.workerId, w.id), isNotNull(workerDocumentsTable.requestedAt)));
  // fields — що людина вписує сама (document_types.worker_fields); values — передзаповнення лише для
  // щойно надісланого (pending) файла, щоб «ще один файл» не змушував вводити дані повторно
  const pick = (d: typeof workerDocumentsTable.$inferSelect) => ({ number: d.number ?? "", validFrom: d.validFrom ?? "", issuedAt: d.issuedAt ?? "", expiresAt: d.expiresAt ?? "", issuer: d.issuer ?? "" });
  const items = docs.filter(x => x.type).map(x => ({
    docTypeId: x.type!.id, name: x.type!.name, expiresAt: dateStr(x.d.expiresAt), status: x.d.status,
    requestedAt: x.d.requestedAt ? dateStr(x.d.requestedAt) : null, uploadedAt: x.d.status === "pending" ? dateStr(x.d.updatedAt) : null, reviewNote: x.d.status === "missing" ? x.d.reviewNote : null,
    fields: workerFieldsOf(x.type), values: x.d.status === "pending" ? pick(x.d) : null,
  }));
  if (focusTypeId && !items.some(i => i.docTypeId === focusTypeId)) {
    // тип з лінка без requested_at (прямий токен): показуємо фактичний рядок, якщо він уже є (напр. щойно завантажений pending)
    const [ty] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, focusTypeId));
    const [own] = ty ? await db.select().from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, w.id), eq(workerDocumentsTable.docTypeId, ty.id))) : [];
    if (ty) items.unshift({
      docTypeId: ty.id, name: ty.name, expiresAt: dateStr(own?.expiresAt ?? null), status: own?.status ?? "missing", requestedAt: null,
      uploadedAt: own?.status === "pending" ? dateStr(own.updatedAt) : null, reviewNote: own?.status === "missing" ? own.reviewNote : null,
      fields: workerFieldsOf(ty), values: own?.status === "pending" ? pick(own) : null,
    });
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
  // дані, які тип вимагає від працівника (worker_fields) — multipart-поле `fields` з JSON; усі обовʼязкові.
  // Помилки — по полю кодом (required|format|past|order), клієнт показує мовою працівника.
  const [ty] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, docTypeId));
  if (!ty) return fail(res, 400, "Тип документа не знайдено");
  let rawFields: unknown = null;
  if (typeof req.body?.fields === "string" && req.body.fields) { try { rawFields = JSON.parse(req.body.fields); } catch { return fail(res, 400, "fields: невалідний JSON"); } }
  const { values, errors } = validateWorkerFields(workerFieldsOf(ty), rawFields, warsawToday());
  if (Object.keys(errors).length) return res.status(400).json({ error: "Заповніть дані документа", fields: errors });
  try {
    const originalName = Buffer.from(req.file.originalname ?? "document.jpg", "latin1").toString("utf8");
    const { documentId, title } = await applyWorkerDocumentUpload(row.workerId!, docTypeId, req.file.buffer, originalName, values);
    // підтвердження в бот (best-effort)
    const [w] = await db.select({ telegramId: workersTable.telegramId, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, row.workerId!));
    if (w?.telegramId) bot.telegram.sendMessage(w.telegramId, tw(asLang(w.language), "docs.uploaded", { doc: title })).catch(() => {});
    return res.json({ ok: true, doc: { id: documentId, title } });
  } catch (e: any) { return fail(res, 400, e?.message ?? "Не вдалося завантажити файл"); }
});

export default router;
