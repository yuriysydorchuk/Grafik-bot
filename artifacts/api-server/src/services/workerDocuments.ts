// Самообслуговування працівника: додавання документа через бота (§6 плану
// worker-docs-signing, пункт 4 первинного запиту — «працівник додає документи
// сам через бота»). Спільна логіка для bot/handlers/workerDocuments.ts; існуючий
// адмінський upload (routes/admin-api.ts POST /worker-documents/:id/file) лишається
// окремим — той редагує вже створений рядок, цей створює/оновлює по docTypeId.
import fs from "node:fs";
import path from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { db, documentTypesTable, workerDocumentsTable } from "@workspace/db";
import { WORKER_DOCS_DIR, makeStoredName, sniffDocMime, compressUploadImage } from "../lib/uploads";
import { logger } from "../lib/logger";
import { DOCUMENT_TYPE_SEED } from "./legalizationCatalog";

const DOC_MIME_WHITELIST = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]);

// Знайти каталожний тип документа за СТАБІЛЬНИМ code (02.09.2026: раніше — за
// назвою "Paszport"/"Довідка студента", що дублювалось у routes/contracts.ts і
// routes/passportScan.ts). Фолбек для баз без сіду: рядок з тією ж назвою (бекфіл
// code), інакше — вставка з параметрами сіду legalizationSeed.ts.
export async function ensureDocumentType(code: string) {
  let [docType] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.code, code));
  if (docType) return docType;
  const seed = DOCUMENT_TYPE_SEED.find(t => t.code === code);
  if (!seed) throw new Error(`Невідомий код типу документа: ${code}`);
  // легасі-рядок без code з тією самою назвою (або українською назвою довідки студента)
  const legacyNames = [seed.name, ...(code === "student_cert" ? ["Довідка студента"] : [])];
  for (const n of legacyNames) {
    const [legacy] = await db.select().from(documentTypesTable).where(and(eq(documentTypesTable.name, n), isNull(documentTypesTable.code)));
    if (legacy) {
      [docType] = await db.update(documentTypesTable).set({
        code, category: seed.category, grantsStay: seed.grantsStay, grantsWork: seed.grantsWork,
        requiresEmployerMatch: seed.requiresEmployerMatch, isSystem: true, icon: legacy.icon ?? seed.icon,
        hasExpiry: legacy.hasExpiry || seed.hasExpiry, renewalLeadDays: legacy.renewalLeadDays ?? seed.renewalLeadDays,
      }).where(eq(documentTypesTable.id, legacy.id)).returning();
      return docType!;
    }
  }
  [docType] = await db.insert(documentTypesTable).values({ ...seed, isSystem: true }).onConflictDoNothing({ target: documentTypesTable.code }).returning();
  if (!docType) [docType] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.code, code)); // гонка: хтось вставив паралельно
  return docType!;
}

// ── Дані, які працівник вписує сам при завантаженні (11.10.2026) ────────────────────────────
// Набір ключів фіксований (колонки worker_documents), склад — на тип у document_types.worker_fields
// (Налаштування → Документи). Усі налаштовані поля обовʼязкові; дати — YYYY-MM-DD, «дійсний до»
// не в минулому, «від» ≤ «до». Коди помилок віддаються клієнту (/docs/:token локалізує сам).
export const WORKER_FIELD_KEYS = ["number", "validFrom", "issuedAt", "expiresAt", "issuer"] as const;
export type WorkerFieldKey = typeof WORKER_FIELD_KEYS[number];
export type WorkerFieldError = "required" | "format" | "past" | "order";
export type WorkerFieldValues = Partial<Record<WorkerFieldKey, string>>;
const isWorkerFieldKey = (k: unknown): k is WorkerFieldKey => (WORKER_FIELD_KEYS as readonly string[]).includes(String(k));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validIso = (v: string) => ISO_DATE.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// Нормалізований список полів типу (невідомі ключі відкидаються — на випадок ручних правок у БД).
export const workerFieldsOf = (type: { workerFields?: unknown } | null | undefined): WorkerFieldKey[] =>
  Array.isArray(type?.workerFields) ? (type!.workerFields as unknown[]).filter(isWorkerFieldKey) : [];

export function validateWorkerFields(fields: WorkerFieldKey[], input: unknown, today: string): { values: WorkerFieldValues; errors: Partial<Record<WorkerFieldKey, WorkerFieldError>> } {
  const src = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const values: WorkerFieldValues = {};
  const errors: Partial<Record<WorkerFieldKey, WorkerFieldError>> = {};
  for (const k of fields) {
    const v = typeof src[k] === "string" ? (src[k] as string).trim() : "";
    if (!v) { errors[k] = "required"; continue; }
    if (k === "number" || k === "issuer") { values[k] = v.slice(0, 120); continue; }
    if (!validIso(v)) { errors[k] = "format"; continue; }
    if (k === "expiresAt" && v < today) { errors[k] = "past"; continue; }
    values[k] = v;
  }
  const from = values.validFrom ?? values.issuedAt;
  if (from && values.expiresAt && from > values.expiresAt) errors.expiresAt = "order";
  return { values, errors };
}

// Самозавантажений документ завжди йде в статус pending — офіс перевіряє й
// підтверджує (аналог questionnaire: worker-подані дані ніколи не стають
// «офіційними» автоматично). source='worker_bot' — для аудиту/движка легальності.
// fields — уже провалідовані дані працівника (validateWorkerFields): пишуться в колонки
// рядка разом із файлом; офіс бачить їх у модалці документа й може виправити до підтвердження.
export async function applyWorkerDocumentUpload(workerId: number, docTypeId: number, rawBuffer: Buffer, rawName: string, fields: WorkerFieldValues = {}): Promise<{ documentId: number; title: string }> {
  const rawMime = sniffDocMime(rawBuffer);
  if (!rawMime || !DOC_MIME_WHITELIST.has(rawMime)) throw new Error("Тип файлу не підтверджено вмістом");
  const { buffer, mime: realMime, fileName: originalName } = await compressUploadImage(rawBuffer, rawMime, rawName);

  const [docType] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, docTypeId));
  if (!docType) throw new Error("Тип документа не знайдено");

  const storedName = makeStoredName(originalName);
  await fs.promises.writeFile(path.join(WORKER_DOCS_DIR, storedName), buffer);
  const fieldPatch: Record<string, string> = {};
  for (const k of WORKER_FIELD_KEYS) if (fields[k]) fieldPatch[k] = fields[k]!;
  const patch = {
    title: docType.name, status: "pending", filePath: path.join("worker-documents", storedName),
    fileName: originalName, fileMime: realMime, updatedAt: new Date(), source: "worker_bot",
    verifiedAt: null, verifiedBy: null, // новий скан → попередня верифікація скасовується
    ...fieldPatch,
  };

  const [existing] = await db.select().from(workerDocumentsTable)
    .where(and(eq(workerDocumentsTable.workerId, workerId), eq(workerDocumentsTable.docTypeId, docTypeId)));
  const [doc] = existing
    ? await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, existing.id)).returning()
    : await db.insert(workerDocumentsTable).values({ workerId, docTypeId, ...patch }).returning();

  logger.info({ workerId, docTypeId, documentId: doc!.id, fields: Object.keys(fieldPatch) }, "worker self-uploaded document");
  // журнал + перерахунок світлофорів (best-effort; lazy import — не тягнути движок у бот-код при старті)
  const { documentChanged } = await import("./documentEvents");
  // вписані працівником дані — у журнал змін документа (diff лише по них; файл/статус пише сама подія)
  const changes = Object.keys(fieldPatch).length && existing ? (await import("./documentAudit")).documentAuditDiff(existing, fieldPatch) : undefined;
  await documentChanged({ id: doc!.id, workerId }, existing ? "file" : "created", { source: "worker_bot" }, changes?.length ? changes : undefined);
  // відкриті документні задачі цього працівника: файл у задачі + сповіщення виконавцю (best-effort)
  try { const { notifyTasksOnWorkerUpload } = await import("./taskResolve"); await notifyTasksOnWorkerUpload(workerId, doc!.id, docType.name); }
  catch (e: any) { logger.warn({ err: e?.message, workerId }, "task upload notify failed"); }
  // задача «Перевірити завантажений документ» — одразу, не чекаючи нічного прогону
  try { const { ensurePendingDocTask } = await import("./taskAutoRules"); await ensurePendingDocTask(doc!.id); }
  catch (e: any) { logger.warn({ err: e?.message, workerId }, "pending-doc task create failed"); }
  return { documentId: doc!.id, title: docType.name };
}
