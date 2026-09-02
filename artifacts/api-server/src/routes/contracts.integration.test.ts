import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, seedRole, db, workersTable, workerQuestionnairesTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";

// Анкета працівника (§1/§2 плану worker-docs-signing): upsert, verify-флоу (status
// можна виставити лише draft|submitted через PUT — verified лише через окремий
// /verify), гейт по capability workerDocs.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

let owner = "";
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  owner = (await seedAdmin({ role: "owner" })).cookie;
});
after(async () => { if (hasTestDb) await closeDb(); });

async function mkWorker(): Promise<number> {
  const [w] = await db.insert(workersTable).values({ fullName: "W" }).returning({ id: workersTable.id });
  return w!.id;
}

test("PUT: створює анкету при першому зверненні, оновлює при повторному", opts, async () => {
  const id = await mkWorker();
  const created = await request(app).put(`/api/workers/${id}/questionnaire`).set("Cookie", owner).set(H)
    .send({ passportNumber: "AB1234567", citizenship: "Ukraina" });
  assert.equal(created.status, 200);
  assert.equal(created.body.status, "draft");
  assert.equal(created.body.passportNumber, "AB1234567");

  const updated = await request(app).put(`/api/workers/${id}/questionnaire`).set("Cookie", owner).set(H)
    .send({ citizenship: "Polska" });
  assert.equal(updated.status, 200);
  const [row] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, id));
  assert.equal(row!.citizenship, "Polska");
  assert.equal(row!.passportNumber, "AB1234567", "поля, не передані в другому PUT, зберігаються");
});

test("PUT не приймає status=verified — лише draft|submitted", opts, async () => {
  const id = await mkWorker();
  const res = await request(app).put(`/api/workers/${id}/questionnaire`).set("Cookie", owner).set(H)
    .send({ status: "verified" });
  assert.equal(res.status, 400);
});

test("submitted виставляє submittedAt", opts, async () => {
  const id = await mkWorker();
  const res = await request(app).put(`/api/workers/${id}/questionnaire`).set("Cookie", owner).set(H)
    .send({ status: "submitted" });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "submitted");
  assert.ok(res.body.submittedAt);
});

test("/verify: 404 без анкети, інакше status=verified + verifiedBy/verifiedAt", opts, async () => {
  const id = await mkWorker();
  const missing = await request(app).post(`/api/workers/${id}/questionnaire/verify`).set("Cookie", owner).set(H);
  assert.equal(missing.status, 404);

  await request(app).put(`/api/workers/${id}/questionnaire`).set("Cookie", owner).set(H).send({ citizenship: "Ukraina" });
  const verified = await request(app).post(`/api/workers/${id}/questionnaire/verify`).set("Cookie", owner).set(H);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.status, "verified");
  assert.ok(verified.body.verifiedAt);
  assert.ok(verified.body.verifiedBy);
});

test("гейт: роль без workerDocs отримує 403 на GET і PUT анкети", opts, async () => {
  const id = await mkWorker();
  await seedRole("plain", [], ["/"]);
  const plain = (await seedAdmin({ role: "plain" })).cookie;
  const getRes = await request(app).get(`/api/workers/${id}/questionnaire`).set("Cookie", plain);
  assert.equal(getRes.status, 403);
  const putRes = await request(app).put(`/api/workers/${id}/questionnaire`).set("Cookie", plain).set(H).send({ citizenship: "X" });
  assert.equal(putRes.status, 403);
});

test("гейт: роль з workerDocs проходить", opts, async () => {
  const id = await mkWorker();
  await seedRole("docs", ["workerDocs"], ["/contracts"]);
  const docsAdmin = (await seedAdmin({ role: "docs" })).cookie;
  const res = await request(app).get(`/api/workers/${id}/questionnaire`).set("Cookie", docsAdmin);
  assert.equal(res.status, 200);
  assert.equal(res.body, null);
});

// ── /passport-scan (OCR через Vision API + MRZ, §3 плану) ────────────────────────
// Живий GOOGLE_DOCAI_KEY_FILE у тестовому середовищі не налаштований —
// перевіряємо гейти, magic-byte MIME-валідацію і чіткий 501 замість краху,
// коли сервер не налаштований (той самий контракт, що docaiConfigured() у боті).
const PNG = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "latin1");

test("passport-scan: без файлу — 400", opts, async () => {
  const id = await mkWorker();
  const res = await request(app).post(`/api/workers/${id}/passport-scan`).set("Cookie", owner).set(H);
  assert.equal(res.status, 400);
});

test("passport-scan: HTML під виглядом PDF — 400 (magic-byte перевірка)", opts, async () => {
  const id = await mkWorker();
  const res = await request(app).post(`/api/workers/${id}/passport-scan`).set("Cookie", owner).set(H)
    .attach("file", Buffer.from("<html><script>alert(1)</script></html>"), { filename: "evil.pdf", contentType: "application/pdf" });
  assert.equal(res.status, 400);
});

test("passport-scan: валідний PNG, але GOOGLE_DOCAI_KEY_FILE не налаштований — 501, не крашиться", opts, async () => {
  const id = await mkWorker();
  const res = await request(app).post(`/api/workers/${id}/passport-scan`).set("Cookie", owner).set(H)
    .attach("file", PNG, "passport.png");
  assert.equal(res.status, 501);
});

test("passport-scan: гейт workerDocs — 403 без capability", opts, async () => {
  const id = await mkWorker();
  await seedRole("plain2", [], ["/"]);
  const plain = (await seedAdmin({ role: "plain2" })).cookie;
  const res = await request(app).post(`/api/workers/${id}/passport-scan`).set("Cookie", plain).set(H).attach("file", PNG, "passport.png");
  assert.equal(res.status, 403);
});

// Онбординг «паспорт — джерело істини» (§1) тепер через публічну веб-сторінку
// /passport-scan/:token (routes/passportScan.ts, camera+OCR у браузері) — не
// через прямий виклик у боті. Тести — passportScan.integration.test.ts.
