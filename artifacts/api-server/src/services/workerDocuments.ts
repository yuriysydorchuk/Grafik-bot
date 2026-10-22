// Самообслуговування працівника: додавання документа через бота (§6 плану
// worker-docs-signing, пункт 4 первинного запиту — «працівник додає документи
// сам через бота»). Спільна логіка для bot/handlers/workerDocuments.ts; існуючий
// адмінський upload (routes/admin-api.ts POST /worker-documents/:id/file) лишається
// окремим — той редагує вже створений рядок, цей створює/оновлює по docTypeId.
import fs from "node:fs";
import path from "node:path";
import { eq, and, isNull, desc } from "drizzle-orm";
import { db, documentTypesTable, workerDocumentsTable } from "@workspace/db";
import { WORKER_DOCS_DIR, UPLOADS_ROOT, makeStoredName, sniffDocMime, compressUploadImage, deleteStoredFile } from "../lib/uploads";
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
export type DocPart = { buffer: Buffer; name: string };

// Файл документа з кількох частин (22.10.2026, власник: «не обмежувати кількість фото» — паспорт
// зі штампами в'їзду/подання на карту, 3+ медичні довідки): одна частина без дозапису — як була
// (стиснене фото / PDF); інакше все склеюється в ОДИН PDF — решта системи (перегляд, задачі,
// вкладення паспорта в praca.gov) і далі читає один file_path. appendTo — наявний файл документа,
// до якого дописуються сторінки.
export async function buildDocFile(parts: DocPart[], appendTo: { buffer: Buffer; mime: string } | null, baseName: string, whitelist: Set<string> = DOC_MIME_WHITELIST): Promise<{ buffer: Buffer; mime: string; fileName: string }> {
  if (!parts.length) throw new Error("Файл не отримано");
  const prepared: { buffer: Buffer; mime: string; fileName: string }[] = [];
  for (const p of parts) {
    const rawMime = sniffDocMime(p.buffer);
    if (!rawMime || !whitelist.has(rawMime)) throw new Error("Тип файлу не підтверджено вмістом");
    prepared.push(await compressUploadImage(p.buffer, rawMime, p.name));
  }
  if (!appendTo && prepared.length === 1) return prepared[0]!;
  const all = [...(appendTo ? [appendTo] : []), ...prepared];
  if (all.some(x => !PDF_PARTS.has(x.mime))) throw new Error("Склеїти в один документ можна лише фото (JPG/PNG) і PDF");
  const { combineToPdf } = await import("./imagePdf");
  const safe = baseName.replace(/[\/\\:*?"<>|]/g, " ").trim() || "document";
  return { buffer: await combineToPdf(all), mime: "application/pdf", fileName: `${safe}.pdf` };
}
const PDF_PARTS = new Set(["application/pdf", "image/jpeg", "image/png"]);

// Поточний файл документа з диска (для дозапису сторінок); null — нема/не склеюється
export async function readDocFile(filePath: string | null, mime: string | null): Promise<{ buffer: Buffer; mime: string } | null> {
  if (!filePath || !mime || !PDF_PARTS.has(mime)) return null;
  const abs = path.resolve(UPLOADS_ROOT, filePath);
  if (!abs.startsWith(UPLOADS_ROOT + path.sep)) return null;
  try { return { buffer: await fs.promises.readFile(abs), mime }; } catch { return null; }
}

// append — «ще одне фото цього ж документа» з /docs/:token: дописуємо сторінки лише до ще не
// перевіреного файлу самого працівника (pending + worker_bot), інакше завантаження замінює файл
export async function applyWorkerDocumentUpload(workerId: number, docTypeId: number, rawBuffer: Buffer | DocPart[], rawName: string, fields: WorkerFieldValues = {}, opts: { append?: boolean } = {}): Promise<{ documentId: number; title: string }> {
  const [docType] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, docTypeId));
  if (!docType) throw new Error("Тип документа не знайдено");
  // кілька рядків одного типу можливі (по фірмах, після злиття профілів): дописуємо саме у файл
  // працівника на перевірці, інакше — найновіший рядок типу
  const sameType = await db.select().from(workerDocumentsTable)
    .where(and(eq(workerDocumentsTable.workerId, workerId), eq(workerDocumentsTable.docTypeId, docTypeId)))
    .orderBy(desc(workerDocumentsTable.id));
  const existing = (opts.append ? sameType.find(r => r.status === "pending" && r.source === "worker_bot") : undefined) ?? sameType[0];
  const parts = Array.isArray(rawBuffer) ? rawBuffer : [{ buffer: rawBuffer, name: rawName }];
  const appendTo = opts.append && existing?.status === "pending" && existing.source === "worker_bot"
    ? await readDocFile(existing.filePath, existing.fileMime) : null;
  const { buffer, mime: realMime, fileName: originalName } = await buildDocFile(parts, appendTo, docType.name);

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

  const [doc] = existing
    ? await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, existing.id)).returning()
    : await db.insert(workerDocumentsTable).values({ workerId, docTypeId, ...patch }).returning();

  if (appendTo) deleteStoredFile(existing!.filePath); // старі сторінки вже всередині нового PDF
  logger.info({ workerId, docTypeId, documentId: doc!.id, parts: parts.length, appended: !!appendTo, fields: Object.keys(fieldPatch) }, "worker self-uploaded document");
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
