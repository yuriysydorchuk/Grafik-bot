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

test("editData (non-finance) admin cannot set hourlyRate on create — it keeps the default", opts, async () => {
  const { cookie } = await seedAdmin({ role: "editor" });
  const res = await request(app).post("/api/workers").set("Cookie", cookie).set(H)
    .send({ fullName: "Jan Kowalski", hourlyRate: 999, isStudent: true, under26: true });
  assert.equal(res.status, 200);
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, res.body.id));
  assert.equal(w!.hourlyRate, 31.5, "hourlyRate must stay at the schema default, not 999");
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
