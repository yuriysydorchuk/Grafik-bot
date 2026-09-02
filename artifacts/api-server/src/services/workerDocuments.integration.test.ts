import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, workersTable, documentTypesTable, workerDocumentsTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { ensureUploadDirs } from "../lib/uploads.ts";
import { applyWorkerDocumentUpload } from "./workerDocuments.ts";

// Самозавантаження документа працівником через бота (§6 плану worker-docs-signing).
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const PNG = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "latin1");

before(() => { if (hasTestDb) ensureUploadDirs(); });
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function mkWorkerAndType(): Promise<{ workerId: number; docTypeId: number }> {
  const [w] = await db.insert(workersTable).values({ fullName: "W" }).returning({ id: workersTable.id });
  const [ty] = await db.insert(documentTypesTable).values({ name: "Karta pobytu", required: true, hasExpiry: true }).returning({ id: documentTypesTable.id });
  return { workerId: w!.id, docTypeId: ty!.id };
}

test("перше самозавантаження створює рядок worker_documents зі статусом pending", opts, async () => {
  const { workerId, docTypeId } = await mkWorkerAndType();
  const { documentId, title } = await applyWorkerDocumentUpload(workerId, docTypeId, PNG, "scan.png");
  assert.equal(title, "Karta pobytu");
  const [doc] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, documentId));
  assert.equal(doc!.status, "pending");
  assert.equal(doc!.fileMime, "image/png");
  assert.ok(doc!.filePath);
});

test("повторне самозавантаження ОНОВЛЮЄ той самий рядок (не дублює)", opts, async () => {
  const { workerId, docTypeId } = await mkWorkerAndType();
  const first = await applyWorkerDocumentUpload(workerId, docTypeId, PNG, "scan1.png");
  const second = await applyWorkerDocumentUpload(workerId, docTypeId, PNG, "scan2.png");
  assert.equal(first.documentId, second.documentId);
  const rows = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.workerId, workerId));
  assert.equal(rows.length, 1);
});

test("HTML під виглядом PDF відхиляється (magic-byte перевірка)", opts, async () => {
  const { workerId, docTypeId } = await mkWorkerAndType();
  await assert.rejects(
    () => applyWorkerDocumentUpload(workerId, docTypeId, Buffer.from("<html></html>"), "evil.pdf"),
    /не підтверджено вмістом/,
  );
});

test("невідомий тип документа — помилка", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "W" }).returning({ id: workersTable.id });
  await assert.rejects(() => applyWorkerDocumentUpload(w!.id, 999999, PNG, "scan.png"), /Тип документа не знайдено/);
});
