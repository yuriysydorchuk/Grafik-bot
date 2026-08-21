import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedRole, seedAdmin, closeDb, db, workersTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";

// Worker CRUD must only let a viewFinance role write payroll fields (hourlyRate/isStudent/
// under26). A plain editData role sending those must be ignored — the field-gating the
// security review could previously only confirm by reading code.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  await seedRole("editor", ["editData"], ["/workers"]);   // can edit, cannot see/set finance
});
after(async () => { if (hasTestDb) await closeDb(); });

test("editData (non-finance) admin cannot set hourlyRate on create — it stays NULL (авто)", opts, async () => {
  const { cookie } = await seedAdmin({ role: "editor" });
  const res = await request(app).post("/api/workers").set("Cookie", cookie).set(H)
    .send({ fullName: "Jan Kowalski", hourlyRate: 999, isStudent: true, under26: true });
  assert.equal(res.status, 200);
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, res.body.id));
  // ставка — профільний override: без viewFinance не пишеться, NULL = «авто» за правилами фабрики
  assert.equal(w!.hourlyRate, null, "hourlyRate must stay NULL (auto), not 999");
  assert.equal(w!.isStudent, false);
  assert.equal(w!.under26, false);
});

test("owner (viewFinance) admin CAN set hourlyRate on create", opts, async () => {
  const { cookie } = await seedAdmin({ role: "owner" });
  const res = await request(app).post("/api/workers").set("Cookie", cookie).set(H)
    .send({ fullName: "Anna Nowak", hourlyRate: 42.5, isStudent: true });
  assert.equal(res.status, 200);
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, res.body.id));
  assert.equal(w!.hourlyRate, 42.5);
  assert.equal(w!.isStudent, true);
});

test("editData admin cannot change hourlyRate on patch, but CAN change a non-finance field", opts, async () => {
  const { cookie: owner } = await seedAdmin({ role: "owner" });
  const created = await request(app).post("/api/workers").set("Cookie", owner).set(H)
    .send({ fullName: "Piotr Zielinski", hourlyRate: 40 });
  const id = created.body.id;

  const { cookie: editor } = await seedAdmin({ role: "editor" });
  const res = await request(app).patch(`/api/workers/${id}`).set("Cookie", editor).set(H)
    .send({ fullName: "Piotr Z.", hourlyRate: 1 });
  assert.equal(res.status, 200);
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, id));
  assert.equal(w!.fullName, "Piotr Z.", "the non-finance field must be updated");
  assert.equal(w!.hourlyRate, 40, "the finance field must be untouched by a non-finance admin");
});

// telegram_id у схемі unique: без явної перевірки конфлікт падав 500-кою з БД
// (інцидент 19.08.2026, PATCH /workers/363) — тепер це людське 400 з іменем власника.
test("patch with another worker's telegram id → 400 with the holder's name, row untouched", opts, async () => {
  const { cookie } = await seedAdmin({ role: "editor" });
  const holder = await request(app).post("/api/workers").set("Cookie", cookie).set(H)
    .send({ fullName: "Marek Wisniewski", telegramId: "111222333", workerCode: "901" });
  const victim = await request(app).post("/api/workers").set("Cookie", cookie).set(H)
    .send({ fullName: "Tomasz Kaczmarek", workerCode: "902" });
  const res = await request(app).patch(`/api/workers/${victim.body.id}`).set("Cookie", cookie).set(H)
    .send({ telegramId: "111222333" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Telegram ID вже привʼязаний до Marek Wisniewski/);
  assert.match(res.body.error, /№901/);
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, victim.body.id));
  assert.equal(w!.telegramId, null);
  assert.equal(holder.status, 200);
});

test("patch re-sending the worker's own telegram id is not a conflict", opts, async () => {
  const { cookie } = await seedAdmin({ role: "editor" });
  const created = await request(app).post("/api/workers").set("Cookie", cookie).set(H)
    .send({ fullName: "Adam Mazur", telegramId: "444555666" });
  const res = await request(app).patch(`/api/workers/${created.body.id}`).set("Cookie", cookie).set(H)
    .send({ fullName: "Adam M.", telegramId: "444555666" });
  assert.equal(res.status, 200);
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, created.body.id));
  assert.equal(w!.fullName, "Adam M.");
  assert.equal(w!.telegramId, "444555666");
});

test("create with an already-bound telegram id → 400, no row inserted", opts, async () => {
  const { cookie } = await seedAdmin({ role: "editor" });
  await request(app).post("/api/workers").set("Cookie", cookie).set(H)
    .send({ fullName: "Pawel Lewandowski", telegramId: "777888999" });
  const res = await request(app).post("/api/workers").set("Cookie", cookie).set(H)
    .send({ fullName: "Krzysztof Wojcik", telegramId: "777888999" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Telegram ID вже привʼязаний до Pawel Lewandowski/);
  const rows = await db.select().from(workersTable).where(eq(workersTable.fullName, "Krzysztof Wojcik"));
  assert.equal(rows.length, 0);
});

test("worker create still requires the editData capability", opts, async () => {
  await seedRole("viewer", [], ["/"]);
  const { cookie } = await seedAdmin({ role: "viewer" });
  const res = await request(app).post("/api/workers").set("Cookie", cookie).set(H).send({ fullName: "X" });
  assert.equal(res.status, 403);
});

test("worker create is blocked without the CSRF header", opts, async () => {
  const { cookie } = await seedAdmin({ role: "owner" });
  const res = await request(app).post("/api/workers").set("Cookie", cookie).send({ fullName: "X" });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "csrf");
});
