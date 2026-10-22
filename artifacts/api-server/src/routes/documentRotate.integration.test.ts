// Поворот файлу документа (22.10.2026): фото — цілком (sharp), PDF — одна сторінка (pdf-lib
// setRotation); новий файл на диску, старий прибрано.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, workerDocumentsTable } from "../test/harness.ts";
import { ensureUploadDirs, UPLOADS_ROOT, WORKER_DOCS_DIR } from "../lib/uploads.ts";
import { combineToPdf } from "../services/imagePdf.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" };
before(() => { if (hasTestDb) ensureUploadDirs(); });
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function docWithFile(buf: Buffer, name: string, mime: string) {
  const [w] = await db.insert(workersTable).values({ fullName: "Rot Test", isActive: true }).returning();
  const stored = `${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`;
  fs.writeFileSync(path.join(WORKER_DOCS_DIR, stored), buf);
  const [d] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, title: "Paszport", status: "present", filePath: path.join("worker-documents", stored), fileName: name, fileMime: mime }).returning();
  return d!;
}

test("rotate: фото 40×20 → 90° → 20×40, старий файл прибрано; PDF — лише сторінка 2", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const img = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#c00" } }).jpeg().toBuffer();
  const d = await docWithFile(img, "scan.jpg", "image/jpeg");
  const r = await request(app).post(`/api/worker-documents/${d.id}/rotate`).set("Cookie", owner.cookie).set(H).send({ degrees: 90 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [after1] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, d.id));
  const meta = await sharp(fs.readFileSync(path.join(UPLOADS_ROOT, after1!.filePath!))).metadata();
  assert.deepEqual([meta.width, meta.height], [20, 40]);
  assert.equal(fs.existsSync(path.join(UPLOADS_ROOT, d.filePath!)), false);

  const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: "#0c0" } }).png().toBuffer();
  const pdf = await combineToPdf([{ buffer: png, mime: "image/png" }, { buffer: png, mime: "image/png" }]);
  const p = await docWithFile(pdf, "doc.pdf", "application/pdf");
  const r2 = await request(app).post(`/api/worker-documents/${p.id}/rotate`).set("Cookie", owner.cookie).set(H).send({ degrees: 90, page: 2 });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const [after2] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, p.id));
  const loaded = await PDFDocument.load(fs.readFileSync(path.join(UPLOADS_ROOT, after2!.filePath!)));
  assert.deepEqual(loaded.getPages().map(pg => pg.getRotation().angle), [0, 90]);
  const bad = await request(app).post(`/api/worker-documents/${p.id}/rotate`).set("Cookie", owner.cookie).set(H).send({ degrees: 90, page: 5 });
  assert.equal(bad.status, 400);
});
