// Самообслуговування працівника: додавання документа через бота (§6 плану
// worker-docs-signing, пункт 4 первинного запиту — «працівник додає документи
// сам через бота»). Спільна логіка для bot/handlers/workerDocuments.ts; існуючий
// адмінський upload (routes/admin-api.ts POST /worker-documents/:id/file) лишається
// окремим — той редагує вже створений рядок, цей створює/оновлює по docTypeId.
import fs from "node:fs";
import path from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { db, documentTypesTable, workerDocumentsTable } from "@workspace/db";
import { WORKER_DOCS_DIR, makeStoredName, sniffDocMime } from "../lib/uploads";
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

// Самозавантажений документ завжди йде в статус pending — офіс перевіряє й
// підтверджує (аналог questionnaire: worker-подані дані ніколи не стають
// «офіційними» автоматично). source='worker_bot' — для аудиту/движка легальності.
export async function applyWorkerDocumentUpload(workerId: number, docTypeId: number, buffer: Buffer, originalName: string): Promise<{ documentId: number; title: string }> {
  const realMime = sniffDocMime(buffer);
  if (!realMime || !DOC_MIME_WHITELIST.has(realMime)) throw new Error("Тип файлу не підтверджено вмістом");

  const [docType] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, docTypeId));
  if (!docType) throw new Error("Тип документа не знайдено");

  const storedName = makeStoredName(originalName);
  await fs.promises.writeFile(path.join(WORKER_DOCS_DIR, storedName), buffer);
  const patch = {
    title: docType.name, status: "pending", filePath: path.join("worker-documents", storedName),
    fileName: originalName, fileMime: realMime, updatedAt: new Date(), source: "worker_bot",
    verifiedAt: null, verifiedBy: null, // новий скан → попередня верифікація скасовується
  };

  const [existing] = await db.select({ id: workerDocumentsTable.id }).from(workerDocumentsTable)
    .where(and(eq(workerDocumentsTable.workerId, workerId), eq(workerDocumentsTable.docTypeId, docTypeId)));
  const [doc] = existing
    ? await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, existing.id)).returning()
    : await db.insert(workerDocumentsTable).values({ workerId, docTypeId, ...patch }).returning();

  logger.info({ workerId, docTypeId, documentId: doc!.id }, "worker self-uploaded document");
  return { documentId: doc!.id, title: docType.name };
}
