// Самообслуговування працівника: додавання документа через бота (§6 плану
// worker-docs-signing, пункт 4 первинного запиту — «працівник додає документи
// сам через бота»). Спільна логіка для bot/handlers/workerDocuments.ts; існуючий
// адмінський upload (routes/admin-api.ts POST /worker-documents/:id/file) лишається
// окремим — той редагує вже створений рядок, цей створює/оновлює по docTypeId.
import fs from "node:fs";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { db, documentTypesTable, workerDocumentsTable } from "@workspace/db";
import { WORKER_DOCS_DIR, makeStoredName, sniffDocMime } from "../lib/uploads";
import { logger } from "../lib/logger";

const DOC_MIME_WHITELIST = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]);

// Знайти каталожний тип документа за назвою, чи створити (той самий патерн,
// що раніше дублювався для "Paszport" у routes/contracts.ts і routes/passportScan.ts).
export async function ensureDocumentType(name: string, opts: { required?: boolean; hasExpiry?: boolean; icon?: string } = {}) {
  let [docType] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.name, name));
  if (!docType) [docType] = await db.insert(documentTypesTable).values({
    name, required: opts.required ?? false, hasExpiry: opts.hasExpiry ?? false, icon: opts.icon ?? null, sortOrder: 0,
  }).returning();
  return docType!;
}

// Самозавантажений документ завжди йде в статус pending — офіс перевіряє й
// підтверджує (аналог questionnaire: worker-подані дані ніколи не стають
// «офіційними» автоматично).
export async function applyWorkerDocumentUpload(workerId: number, docTypeId: number, buffer: Buffer, originalName: string): Promise<{ documentId: number; title: string }> {
  const realMime = sniffDocMime(buffer);
  if (!realMime || !DOC_MIME_WHITELIST.has(realMime)) throw new Error("Тип файлу не підтверджено вмістом");

  const [docType] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, docTypeId));
  if (!docType) throw new Error("Тип документа не знайдено");

  const storedName = makeStoredName(originalName);
  await fs.promises.writeFile(path.join(WORKER_DOCS_DIR, storedName), buffer);
  const patch = {
    title: docType.name, status: "pending", filePath: path.join("worker-documents", storedName),
    fileName: originalName, fileMime: realMime, updatedAt: new Date(),
  };

  const [existing] = await db.select({ id: workerDocumentsTable.id }).from(workerDocumentsTable)
    .where(and(eq(workerDocumentsTable.workerId, workerId), eq(workerDocumentsTable.docTypeId, docTypeId)));
  const [doc] = existing
    ? await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, existing.id)).returning()
    : await db.insert(workerDocumentsTable).values({ workerId, docTypeId, ...patch }).returning();

  logger.info({ workerId, docTypeId, documentId: doc!.id }, "worker self-uploaded document");
  return { documentId: doc!.id, title: docType.name };
}
