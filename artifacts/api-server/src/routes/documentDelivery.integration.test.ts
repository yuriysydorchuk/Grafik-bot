// «Надіслати працівнику»: цілі доставки, валідація каналу, email без SMTP →
// зрозуміла помилка, Telegram без привʼязки → 400; ?download=1 → attachment.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, workerDocumentsTable, documentTypesTable, workerQuestionnairesTable,
} from "../test/harness.ts";
import { seedLegalizationCatalog } from "../services/legalizationSeed.ts";
import { WORKER_DOCS_DIR, ensureUploadDirs } from "../lib/uploads.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); await seedLegalizationCatalog(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const H = { "X-Requested-With": "grafik" };

async function seedDoc(workerId: number) {
  ensureUploadDirs();
  const [pt] = await db.select({ id: documentTypesTable.id }).from(documentTypesTable).where(eq(documentTypesTable.code, "passport"));
  const name = `test-${Date.now()}.pdf`;
  fs.writeFileSync(path.join(WORKER_DOCS_DIR, name), "%PDF-1.7\n1 0 obj\n");
  const [doc] = await db.insert(workerDocumentsTable).values({
    workerId, docTypeId: pt!.id, title: "Paszport", status: "present", filePath: path.join("worker-documents", name), fileName: "paszport.pdf", fileMime: "application/pdf",
  }).returning();
  return doc!;
}

test("delivery-targets: Telegram з профілю, email з анкети", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [w] = await db.insert(workersTable).values({ fullName: "Test Delivery", isActive: true, telegramId: "555001" }).returning();
  await db.insert(workerQuestionnairesTable).values({ workerId: w!.id, email: " jan@example.com " });
  const r = await request(app).get(`/api/workers/${w!.id}/delivery-targets`).set("Cookie", owner.cookie);
  assert.equal(r.status, 200);
  assert.deepEqual({ telegram: r.body.telegram, email: r.body.email }, { telegram: true, email: "jan@example.com" });
});

test("send: невалідний канал → 400; Telegram без привʼязки → 400; email без адреси → 400; ?download=1 → attachment", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [w] = await db.insert(workersTable).values({ fullName: "Test Delivery", isActive: true }).returning();
  const doc = await seedDoc(w!.id);
  const bad = await request(app).post(`/api/worker-documents/${doc.id}/send`).set("Cookie", owner.cookie).set(H).send({ via: "fax" });
  assert.equal(bad.status, 400);
  const tg = await request(app).post(`/api/worker-documents/${doc.id}/send`).set("Cookie", owner.cookie).set(H).send({ via: "telegram" });
  assert.equal(tg.status, 400); assert.match(tg.body.error, /Telegram/);
  const em = await request(app).post(`/api/worker-documents/${doc.id}/send`).set("Cookie", owner.cookie).set(H).send({ via: "email" });
  assert.equal(em.status, 400); assert.match(em.body.error, /email/i);
  const badEmail = await request(app).post(`/api/worker-documents/${doc.id}/send`).set("Cookie", owner.cookie).set(H).send({ via: "email", email: "not-an-email" });
  assert.equal(badEmail.status, 400);

  const inline = await request(app).get(`/api/worker-documents/${doc.id}/file`).set("Cookie", owner.cookie);
  assert.match(inline.headers["content-disposition"] ?? "", /^inline/);
  const dl = await request(app).get(`/api/worker-documents/${doc.id}/file?download=1`).set("Cookie", owner.cookie);
  assert.match(dl.headers["content-disposition"] ?? "", /^attachment/);
});

test("send: роль без editData/legalization/workerDocs → 403", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [w] = await db.insert(workersTable).values({ fullName: "Test Delivery", isActive: true }).returning();
  const doc = await seedDoc(w!.id);
  const viewer = await seedAdmin({ role: "driver", name: "Viewer" });
  const r = await request(app).post(`/api/worker-documents/${doc.id}/send`).set("Cookie", viewer.cookie).set(H).send({ via: "telegram" });
  assert.equal(r.status, 403);
  void owner;
});
