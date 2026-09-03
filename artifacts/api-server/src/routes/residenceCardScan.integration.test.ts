// Скан karta pobytu: confirm створює документ з атрибутами й перераховує легальність;
// валідація тіла; протухлий tempFile → 410; analyze без файла → 400.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, workerDocumentsTable, workerLegalityTable } from "../test/harness.ts";
import { seedLegalizationCatalog } from "../services/legalizationSeed.ts";
import { PASSPORT_SCAN_TMP_DIR, ensureUploadDirs } from "../lib/uploads.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); await seedLegalizationCatalog(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const H = { "X-Requested-With": "grafik" };

function tmpScan(): string {
  ensureUploadDirs();
  const name = `rc-${Date.now()}-test.pdf`;
  fs.writeFileSync(path.join(PASSPORT_SCAN_TMP_DIR, name), "%PDF-1.7\n1 0 obj\n");
  return name;
}

test("confirm: TRC з dostęp + мета → документ present/ocr/verified, attrs, легальність перерахована", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [w] = await db.insert(workersTable).values({ fullName: "Test Karta", isActive: true, nationality: "georgia", companyId: null }).returning();
  const tempFile = tmpScan();
  const r = await request(app).post(`/api/workers/${w!.id}/residence-card-scan/confirm`).set("Cookie", owner.cookie).set(H)
    .send({ tempFile, typeCode: "trc", number: "zuv123456", expiresAt: "2028-03-15", laborMarketAccess: true, purpose: "study" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.number, "ZUV123456");
  assert.equal(r.body.source, "ocr");
  assert.equal(r.body.fileMime, "application/pdf");
  assert.deepEqual(r.body.attrs, { laborMarketAccess: true, purpose: "study" });
  assert.ok(r.body.verifiedAt, "офіс звірив поля на екрані підтвердження → verified");
  assert.equal(fs.existsSync(path.join(PASSPORT_SCAN_TMP_DIR, tempFile)), false, "тимчасовий файл перенесено");
  const [lg] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, w!.id));
  assert.equal(lg?.stay, "legal"); assert.equal(lg?.work, "legal", "TRC з доступом до ринку праці дає й працю");

  // друга карта того ж типу → ланцюжок поновлення
  const tempFile2 = tmpScan();
  const r2 = await request(app).post(`/api/workers/${w!.id}/residence-card-scan/confirm`).set("Cookie", owner.cookie).set(H)
    .send({ tempFile: tempFile2, typeCode: "trc", expiresAt: "2030-01-01" });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.replacesDocumentId, r.body.id);
  const docs = await db.select({ id: workerDocumentsTable.id }).from(workerDocumentsTable).where(eq(workerDocumentsTable.workerId, w!.id));
  assert.equal(docs.length, 2);
});

test("confirm: валідація typeCode/expiresAt/purpose, невідомий tempFile → 400, протухлий → 410; analyze без файла → 400", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [w] = await db.insert(workersTable).values({ fullName: "Test Karta", isActive: true }).returning();
  const base = request(app).post(`/api/workers/${w!.id}/residence-card-scan/confirm`).set("Cookie", owner.cookie).set(H);
  assert.equal((await base.send({ tempFile: tmpScan(), typeCode: "passport", expiresAt: "2028-01-01" })).status, 400);
  assert.equal((await request(app).post(`/api/workers/${w!.id}/residence-card-scan/confirm`).set("Cookie", owner.cookie).set(H).send({ tempFile: tmpScan(), typeCode: "trc", expiresAt: "15.03.2028" })).status, 400);
  assert.equal((await request(app).post(`/api/workers/${w!.id}/residence-card-scan/confirm`).set("Cookie", owner.cookie).set(H).send({ tempFile: tmpScan(), typeCode: "trc", expiresAt: "2028-01-01", purpose: "tourism" })).status, 400);
  assert.equal((await request(app).post(`/api/workers/${w!.id}/residence-card-scan/confirm`).set("Cookie", owner.cookie).set(H).send({ tempFile: "../../etc/passwd", typeCode: "trc", expiresAt: "2028-01-01" })).status, 400);
  assert.equal((await request(app).post(`/api/workers/${w!.id}/residence-card-scan/confirm`).set("Cookie", owner.cookie).set(H).send({ tempFile: "rc-does-not-exist.pdf", typeCode: "trc", expiresAt: "2028-01-01" })).status, 410);
  assert.equal((await request(app).post(`/api/workers/${w!.id}/residence-card-scan`).set("Cookie", owner.cookie).set(H)).status, 400);
});
