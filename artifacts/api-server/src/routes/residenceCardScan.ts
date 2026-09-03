// Скан karta pobytu з профілю (веб): 1–2 фото (лицьова + зворот) → Vision OCR →
// чернетка (тип карти, номер, строк, доступ до ринку праці) → офіс перевіряє в
// модалці → confirm створює документ з обома сторонами в одному PDF.
// Аналог passport-scan для карти; нічого не пише в workers.* (payroll-інваріант).
import { Router, type IRouter } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db, workersTable, workerDocumentsTable } from "@workspace/db";
import { authRequired, requireAnyCap, type AuthedRequest } from "../lib/auth";
import { UPLOADS_ROOT, WORKER_DOCS_DIR, PASSPORT_SCAN_TMP_DIR, makeStoredName, sniffDocMime, compressUploadImage, deleteStoredFile } from "../lib/uploads";
import { passportOcrConfigured } from "../services/docai";
import { processResidenceCard, RESIDENCE_CARD_CODES, type ResidenceCardTypeCode } from "../services/residenceCard";
import { imageToPdf, appendImageToPdf } from "../services/imagePdf";
import { ensureDocumentType } from "../services/workerDocuments";
import { documentChanged } from "../services/documentEvents";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(authRequired);
const LG = requireAnyCap("legalization", "workerDocs");
const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });
const SCAN_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 2 } });
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const PURPOSES = new Set(["work", "study", "family", "business", "other"]);
const TMP_PREFIX = "rc-";

router.post("/workers/:id/residence-card-scan", LG, upload.fields([{ name: "front", maxCount: 1 }, { name: "back", maxCount: 1 }]), async (req, res) => {
  const workerId = Number(req.params.id);
  const [w] = await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return fail(res, 404, "Працівника не знайдено");
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const front = files?.front?.[0], back = files?.back?.[0];
  if (!front) return fail(res, 400, "Потрібне фото лицьової сторони");
  if (!passportOcrConfigured()) return fail(res, 501, "OCR не налаштований на цьому сервері (GOOGLE_DOCAI_KEY_FILE)");
  const sides: { buffer: Buffer; mime: string }[] = [];
  for (const f of [front, back]) {
    if (!f) continue;
    const mime = sniffDocMime(f.buffer);
    if (!mime || !SCAN_MIME.has(mime)) return fail(res, 400, "Тип файлу не підтверджено вмістом");
    sides.push({ buffer: f.buffer, mime });
  }
  try {
    const { draft } = await processResidenceCard(sides);
    if (!draft.isResidenceCard) return fail(res, 400, "На фото не схоже на karta pobytu — сфотографуй чіткіше обидві сторони (без відблисків, картка на весь кадр).");
    // обидві сторони → один PDF у тимчасову теку; confirm переносить у профіль
    let pdf: Buffer | null = null;
    for (const s of sides) {
      if (s.mime === "application/pdf") { pdf = pdf ?? s.buffer; continue; }
      const c = await compressUploadImage(s.buffer, s.mime, "side.jpg");
      pdf = pdf ? await appendImageToPdf(pdf, c.buffer, c.mime) : await imageToPdf(c.buffer, c.mime);
    }
    const tempFile = `${TMP_PREFIX}${makeStoredName("karta-pobytu.pdf")}`;
    await fs.promises.writeFile(path.join(PASSPORT_SCAN_TMP_DIR, tempFile), pdf!);
    ok(res, { draft, tempFile, sides: sides.length });
  } catch (e: any) {
    logger.warn({ workerId, err: e?.message }, "residence-card scan failed");
    fail(res, 400, e?.message ?? "Не вдалося розпізнати карту");
  }
});

router.post("/workers/:id/residence-card-scan/confirm", LG, async (req: AuthedRequest, res) => {
  const workerId = Number(req.params.id);
  const b = req.body ?? {};
  const typeCode = b.typeCode as ResidenceCardTypeCode;
  if (!RESIDENCE_CARD_CODES.includes(typeCode)) return fail(res, 400, "typeCode: невідомий тип карти");
  if (!isDate(b.expiresAt)) return fail(res, 400, "expiresAt: дата YYYY-MM-DD");
  if (b.validFrom != null && b.validFrom !== "" && !isDate(b.validFrom)) return fail(res, 400, "validFrom: дата YYYY-MM-DD");
  if (b.purpose != null && b.purpose !== "" && !PURPOSES.has(b.purpose)) return fail(res, 400, "purpose: work|study|family|business|other");
  const tempFile = typeof b.tempFile === "string" ? path.basename(b.tempFile) : "";
  if (!tempFile.startsWith(TMP_PREFIX)) return fail(res, 400, "tempFile: невідомий файл скану");
  const tmpAbs = path.join(PASSPORT_SCAN_TMP_DIR, tempFile);
  if (!fs.existsSync(tmpAbs)) return fail(res, 410, "Скан протух — зроби фото ще раз");
  const [w] = await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return fail(res, 404, "Працівника не знайдено");

  const docType = await ensureDocumentType(typeCode);
  const storedName = makeStoredName("karta-pobytu.pdf");
  await fs.promises.rename(tmpAbs, path.join(WORKER_DOCS_DIR, storedName));

  // попередня чинна карта того ж типу → ланцюжок поновлення (replaces_document_id)
  const [prev] = await db.select({ id: workerDocumentsTable.id }).from(workerDocumentsTable)
    .where(and(eq(workerDocumentsTable.workerId, workerId), eq(workerDocumentsTable.docTypeId, docType.id), inArray(workerDocumentsTable.status, ["present", "pending"])))
    .orderBy(workerDocumentsTable.id).limit(1);
  const attrs: Record<string, unknown> = {};
  if (typeof b.laborMarketAccess === "boolean") attrs.laborMarketAccess = b.laborMarketAccess;
  if (b.purpose) attrs.purpose = b.purpose;
  const [doc] = await db.insert(workerDocumentsTable).values({
    workerId, docTypeId: docType.id, title: docType.name, status: "present", source: "ocr",
    number: typeof b.number === "string" && b.number.trim() ? b.number.trim().toUpperCase() : null,
    expiresAt: b.expiresAt, validFrom: b.validFrom || null,
    filePath: path.join("worker-documents", storedName), fileName: "karta-pobytu.pdf", fileMime: "application/pdf",
    attrs: Object.keys(attrs).length ? attrs : null,
    replacesDocumentId: prev?.id ?? null,
    verifiedBy: req.admin?.adminId ?? null, verifiedAt: new Date(), // офіс щойно звірив поля з карткою на екрані підтвердження
  }).returning();
  await documentChanged({ id: doc!.id, workerId }, "created", { adminId: req.admin?.adminId ?? null, name: req.admin?.name ?? null, source: "ocr" },
    [{ field: "typeCode", to: typeCode }, { field: "expiresAt", to: b.expiresAt }, ...(attrs.laborMarketAccess !== undefined ? [{ field: "laborMarketAccess", to: attrs.laborMarketAccess }] : [])]);
  logger.info({ workerId, documentId: doc!.id, typeCode }, "residence card confirmed");
  ok(res, doc);
});

// прибирання протухлих тимчасових сканів карт (>24 год) — виклик з housekeeping не обовʼязковий, best-effort
export function cleanupResidenceCardTmp(): void {
  try {
    for (const f of fs.readdirSync(PASSPORT_SCAN_TMP_DIR)) {
      if (!f.startsWith(TMP_PREFIX)) continue;
      const abs = path.join(PASSPORT_SCAN_TMP_DIR, f);
      if (Date.now() - fs.statSync(abs).mtimeMs > 24 * 3600 * 1000) deleteStoredFile(path.relative(UPLOADS_ROOT, abs));
    }
  } catch { /* best-effort */ }
}
export default router;
