import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import {
  app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db,
  funnelsTable, candidatesTable, candidateActivityTable, workersTable, factoriesTable, passportScanTokensTable,
} from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { ensureUploadDirs, PASSPORT_SCAN_TMP_DIR } from "../lib/uploads.ts";

// Recruitment CRM: funnels + candidates with stage validation, activity logging and
// convert-to-worker.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

let owner = "";
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  owner = (await seedAdmin({ role: "owner" })).cookie;
});
after(async () => { if (hasTestDb) await closeDb(); });

async function mkFunnel(): Promise<{ id: number; firstKey: string; secondKey: string }> {
  const res = await request(app).post("/api/funnels").set("Cookie", owner).set(H)
    .send({ name: "Zatrudnienie", stages: [{ key: "new", label: "Nowi", color: "blue" }, { key: "iview", label: "Rozmowa", color: "amber" }] });
  return { id: res.body.id, firstKey: res.body.stages[0].key, secondKey: res.body.stages[1].key };
}
async function mkCandidate(funnelId: number, over: Record<string, unknown> = {}): Promise<number> {
  const res = await request(app).post("/api/candidates").set("Cookie", owner).set(H)
    .send({ fullName: "Jan Kandydat", funnelId, ...over });
  return res.body.id;
}
const activity = (candidateId: number) => db.select().from(candidateActivityTable).where(eq(candidateActivityTable.candidateId, candidateId));

test("funnels: create uses given stages; delete blocked while candidates use it", opts, async () => {
  const f = await mkFunnel();
  assert.equal(f.firstKey, "new");
  await mkCandidate(f.id);
  const blocked = await request(app).delete(`/api/funnels/${f.id}`).set("Cookie", owner).set(H);
  assert.equal(blocked.status, 400);
});

test("funnels: create with no stages falls back to defaults", opts, async () => {
  const res = await request(app).post("/api/funnels").set("Cookie", owner).set(H).send({ name: "Domyślny" });
  assert.equal(res.status, 200);
  assert.equal(res.body.stages.length, 3);
});

test("candidate create lands on the funnel's first stage and logs a 'created' activity", opts, async () => {
  const f = await mkFunnel();
  const id = await mkCandidate(f.id);
  const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, id));
  assert.equal(c!.stage, f.firstKey);
  const acts = await activity(id);
  assert.ok(acts.some(a => a.kind === "created"));
});

test("candidate stage move is validated and logged", opts, async () => {
  const f = await mkFunnel();
  const id = await mkCandidate(f.id);

  const bad = await request(app).patch(`/api/candidates/${id}`).set("Cookie", owner).set(H).send({ stage: "does-not-exist" });
  assert.equal(bad.status, 400);

  const good = await request(app).patch(`/api/candidates/${id}`).set("Cookie", owner).set(H).send({ stage: f.secondKey });
  assert.equal(good.status, 200);
  assert.equal(good.body.stage, f.secondKey);
  assert.ok((await activity(id)).some(a => a.kind === "stage"), "a stage-move activity is logged");
});

// convert() не створює працівника напряму (worker-docs-signing: живий
// онбординг) — для кандидата без telegramId шле office-скан-токен і
// прив'язку candidateId; worker/stage → hired лише після
// POST /passport-scan/:token/confirm.
test("convert (без telegramId) — шле office-скан-токен, НЕ створює працівника одразу; повторний convert повертає той самий живий лінк; confirm() прив'язує кандидата", opts, async () => {
  ensureUploadDirs();
  const f = await mkFunnel();
  const id = await mkCandidate(f.id);
  const [fac] = await db.insert(factoriesTable).values({ name: "Fabryka Testowa" }).returning({ id: factoriesTable.id });

  const missingFactory = await request(app).post(`/api/candidates/${id}/convert`).set("Cookie", owner).set(H).send({});
  assert.equal(missingFactory.status, 400, "фабрика обов'язкова для нового кандидата");

  const res = await request(app).post(`/api/candidates/${id}/convert`).set("Cookie", owner).set(H).send({ factoryId: fac!.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.link, "лінк на скан+анкету повертається");
  assert.equal(res.body.notified, false, "телеграм кандидата невідомий — не надіслано");

  const [candidateBefore] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, id));
  assert.equal(candidateBefore!.workerId, null, "працівник ще НЕ прив'язаний — лише після сканування");
  assert.equal(candidateBefore!.stage, f.firstKey, "стадія кандидата НЕ змінена одразу");
  const workersBefore = (await db.select().from(workersTable)).length;
  assert.equal(workersBefore, 0, "жодного профілю ще не створено");

  // Ідемпотентність: повторний клік до сканування повертає той самий токен.
  const again = await request(app).post(`/api/candidates/${id}/convert`).set("Cookie", owner).set(H).send({ factoryId: fac!.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.link, res.body.link, "той самий живий лінк, не другий токен");
  const liveTokens = await db.select().from(passportScanTokensTable).where(eq(passportScanTokensTable.candidateId, id));
  assert.equal(liveTokens.length, 1, "жодного дубль-токена");

  // Кандидат проходить сканування — симулюємо, як analyze() уже відпрацював.
  const token = res.body.link.split("/").pop();
  const storedName = `${Date.now()}-test.jpg`;
  await fs.promises.writeFile(path.join(PASSPORT_SCAN_TMP_DIR, storedName), Buffer.from("\x89PNG\r\n\x1a\n", "latin1"));
  await db.update(passportScanTokensTable).set({
    tempFilePath: path.join("passport-scan-tmp", storedName), tempFileName: "passport.jpg", tempFileMime: "image/jpeg",
    draftJson: { draft: { fullName: "Jan Kandydat" }, mrz: null },
  }).where(eq(passportScanTokensTable.token, token));

  const confirm = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ firstName: "Jan", lastName: "Kandydat", birthDate: "1995-05-05", passportNumber: "AB1234567", passportCountry: "POL", passportExpiresAt: "2030-01-01", citizenship: "POL", sex: "M" });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

  const [candidateAfter] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, id));
  assert.equal(candidateAfter!.workerId, confirm.body.worker.id, "кандидат прив'язаний до щойно створеного працівника");
  assert.equal(candidateAfter!.stage, "hired");
});

// Telegram кандидата вже належить АКТИВНОМУ працівнику (повторний реферал) —
// це не живий онбординг, реактивація одразу без скану, стара синхронна
// поведінка блокування повторного convert() лишається.
test("convert (telegramId уже належить активному працівнику) — реактивує одразу, без скану; блокує повторний convert", opts, async () => {
  const f = await mkFunnel();
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kandydat", telegramId: "555", isActive: false, status: "fired" }).returning({ id: workersTable.id });
  const id = await mkCandidate(f.id);
  // POST /candidates не приймає telegramId з тіла (captured at signup через
  // бот-реферал) — виставляємо напряму, як бот-флоу зробив би.
  await db.update(candidatesTable).set({ telegramId: "555" }).where(eq(candidatesTable.id, id));

  const res = await request(app).post(`/api/candidates/${id}/convert`).set("Cookie", owner).set(H).send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.worker.id, w!.id, "прив'язується до ІСНУЮЧОГО профілю, не створює новий");
  assert.equal(res.body.notified, true);
  assert.equal(res.body.link, null);

  const [reactivated] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(reactivated!.isActive, true);

  const again = await request(app).post(`/api/candidates/${id}/convert`).set("Cookie", owner).set(H).send({});
  assert.equal(again.status, 400, "кандидат уже переведений — повторний convert блокується");
});

test("bonus: marking it paid flips the flag and logs a bonus activity", opts, async () => {
  const f = await mkFunnel();
  const id = await mkCandidate(f.id);
  const res = await request(app).post(`/api/candidates/${id}/bonus`).set("Cookie", owner).set(H).send({ bonusAmount: "300", bonusPaid: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.bonusPaid, true);
  assert.equal(res.body.bonusAmount, 300);
  assert.ok((await activity(id)).some(a => a.kind === "bonus"));
});

test("recruitment mutations require editData", opts, async () => {
  await seedRole("viewer", [], ["/"]);
  const { cookie } = await seedAdmin({ role: "viewer" });
  assert.equal((await request(app).post("/api/funnels").set("Cookie", cookie).set(H).send({ name: "X" })).status, 403);
  assert.equal((await request(app).post("/api/candidates").set("Cookie", cookie).set(H).send({ fullName: "X" })).status, 403);
});
