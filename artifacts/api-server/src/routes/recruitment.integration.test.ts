import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import {
  app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db,
  funnelsTable, candidatesTable, candidateActivityTable, workersTable, factoriesTable, passportScanTokensTable,
  workerChangesTable, workerQuestionnairesTable,
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
  assert.equal(liveTokens[0]!.factoryId, fac!.id, "фабрика з модалки — на лінку");
  assert.ok(liveTokens[0]!.expiresAt.getTime() > Date.now() + 24 * 3600_000, "лінк для ручної передачі живе днями, не 30 хв");

  // Кандидат проходить сканування — симулюємо, як analyze() уже відпрацював.
  const token = res.body.link.split("/").pop();
  const storedName = `${Date.now()}-test.jpg`;
  await fs.promises.writeFile(path.join(PASSPORT_SCAN_TMP_DIR, storedName), Buffer.from("\x89PNG\r\n\x1a\n", "latin1"));
  await db.update(passportScanTokensTable).set({
    tempFilePath: path.join("passport-scan-tmp", storedName), tempFileName: "passport.jpg", tempFileMime: "image/jpeg",
    draftJson: { draft: { fullName: "Jan Kandydat" }, mrz: null },
  }).where(eq(passportScanTokensTable.token, token));

  const confirm = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ firstName: "Jan", lastName: "Kandydat", birthDate: "1995-05-05", passportNumber: "AB1234567", passportCountry: "POL", passportIssuedAt: "2020-01-02", passportExpiresAt: "2030-01-01", citizenship: "POL", sex: "M" });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

  const [candidateAfter] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, id));
  assert.equal(candidateAfter!.workerId, confirm.body.worker.id, "кандидат прив'язаний до щойно створеного працівника");
  assert.equal(candidateAfter!.stage, "hired");
  const [created] = await db.select().from(workersTable).where(eq(workersTable.id, confirm.body.worker.id));
  assert.equal(created!.factoryId, fac!.id, "профіль отримує фабрику з картки");
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

// Колишній працівник (інцидент Ndlovu 10.2026): картка без Telegram, профіль
// звільнений — скан закінчувався заявкою на повернення в боті, картка висіла «переведений».
test("convert (тезка/телефон звільненого) — 409 formerWorker; restoreWorkerId повертає профіль через журнал restored; newPerson — скан", opts, async () => {
  const f = await mkFunnel();
  const [fac] = await db.insert(factoriesTable).values({ name: "Fabryka Testowa" }).returning({ id: factoriesTable.id });
  const [w] = await db.insert(workersTable).values({ fullName: "Moyo Tendai Rutendo", isActive: false, status: "fired", firedAt: new Date("2026-08-06T12:00:00") }).returning({ id: workersTable.id });
  const id = await mkCandidate(f.id, { fullName: "Tendai Moyo" });

  const ask = await request(app).post(`/api/candidates/${id}/convert`).set("Cookie", owner).set(H).send({ factoryId: fac!.id });
  assert.equal(ask.status, 409, JSON.stringify(ask.body));
  assert.equal(ask.body.error, "formerWorker");
  assert.equal(ask.body.worker.id, w!.id);
  assert.equal(ask.body.worker.by, "name");
  assert.equal((await db.select().from(passportScanTokensTable)).length, 0, "до рішення офісу лінк скану не створюється");

  const res = await request(app).post(`/api/candidates/${id}/convert`).set("Cookie", owner).set(H).send({ factoryId: fac!.id, restoreWorkerId: w!.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.link, null);
  assert.equal(res.body.restoredWorkerId, w!.id);
  const [restored] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(restored!.isActive, true);
  assert.equal(restored!.factoryId, fac!.id);
  const journal = await db.select().from(workerChangesTable).where(eq(workerChangesTable.workerId, w!.id));
  assert.ok(journal.some(j => j.field === "restored"), "повернення — через restoreWorker (новий найм)");
  const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, id));
  assert.equal(c!.workerId, w!.id);
  assert.equal(c!.stage, "hired");
  assert.equal((await db.select().from(workersTable)).length, 1, "дубль-профіль не створено");

  // «Це інша людина» — звичайний скан
  const id2 = await mkCandidate(f.id, { fullName: "Tendai Moyo", phone: "+48 600 100 200" });
  await db.update(workersTable).set({ isActive: false, status: "fired" }).where(eq(workersTable.id, w!.id));
  await db.insert(workerQuestionnairesTable).values({ workerId: w!.id, phone: "600100200" });
  const byPhone = await request(app).post(`/api/candidates/${id2}/convert`).set("Cookie", owner).set(H).send({ factoryId: fac!.id });
  assert.equal(byPhone.status, 409);
  assert.equal(byPhone.body.worker.by, "phone");
  const scan = await request(app).post(`/api/candidates/${id2}/convert`).set("Cookie", owner).set(H).send({ factoryId: fac!.id, newPerson: true });
  assert.equal(scan.status, 200, JSON.stringify(scan.body));
  assert.ok(scan.body.link, "інша людина — лінк на скан+анкету");

  // той самий номер у АКТИВНОГО працівника — людина вже працює, повернення не пропонуємо
  const [act] = await db.insert(workersTable).values({ fullName: "Banda Chipo", isActive: true, status: "active" }).returning({ id: workersTable.id });
  await db.insert(workerQuestionnairesTable).values({ workerId: act!.id, phone: "600100200" });
  const id3 = await mkCandidate(f.id, { fullName: "Chipo Banda", phone: "600 100 200" });
  const noAsk = await request(app).post(`/api/candidates/${id3}/convert`).set("Cookie", owner).set(H).send({ factoryId: fac!.id });
  assert.equal(noAsk.status, 200, JSON.stringify(noAsk.body));
  assert.ok(noAsk.body.link, "активний власник номера — звичайний скан, без «повернути»");
});

test("convert (картку вже привʼязано до звільненого профілю) — повертає профіль, живий лінк скану анулюється", opts, async () => {
  const f = await mkFunnel();
  const [w] = await db.insert(workersTable).values({ fullName: "Moyo Tendai", isActive: false, status: "fired" }).returning({ id: workersTable.id });
  const id = await mkCandidate(f.id, { fullName: "Tendai Moyo" });
  await db.update(candidatesTable).set({ workerId: w!.id, stage: "hired" }).where(eq(candidatesTable.id, id));
  await db.insert(passportScanTokensTable).values({ token: "live-token-test", purpose: "office", candidateId: id, expiresAt: new Date(Date.now() + 86400_000) });

  const res = await request(app).post(`/api/candidates/${id}/convert`).set("Cookie", owner).set(H).send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.restoredWorkerId, w!.id);
  const [restored] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(restored!.isActive, true);
  const [tok] = await db.select().from(passportScanTokensTable).where(eq(passportScanTokensTable.candidateId, id));
  assert.ok(tok!.expiresAt <= new Date(), "старий лінк скану більше не живий");

  const again = await request(app).post(`/api/candidates/${id}/convert`).set("Cookie", owner).set(H).send({});
  assert.equal(again.status, 400, "профіль активний — повторний convert блокується");
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
