import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db,
  companiesTable, positionsTable, documentTypesTable, driversTable, vehiclesTable,
  workersTable, workerDocumentsTable,
} from "../test/harness.ts";
import { eq } from "drizzle-orm";

// Reference-data CRUD: companies / positions / document-types (RW = editData) and
// drivers / vehicles (DRIVER_RW), including the "in use → can't delete" guards.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

let owner = "";
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  owner = (await seedAdmin({ role: "owner" })).cookie;
});
after(async () => { if (hasTestDb) await closeDb(); });

test("companies: create, then delete is blocked while a worker references it, allowed once free", opts, async () => {
  const created = await request(app).post("/api/companies").set("Cookie", owner).set(H).send({ name: "ES Sp z oo" });
  assert.equal(created.status, 200);
  const cid = created.body.id;

  const [w] = await db.insert(workersTable).values({ fullName: "W", companyId: cid }).returning({ id: workersTable.id });
  const blocked = await request(app).delete(`/api/companies/${cid}`).set("Cookie", owner).set(H);
  assert.equal(blocked.status, 400);

  await db.update(workersTable).set({ companyId: null }).where(eq(workersTable.id, w!.id));
  const freed = await request(app).delete(`/api/companies/${cid}`).set("Cookie", owner).set(H);
  assert.equal(freed.status, 200);
  assert.equal((await db.select().from(companiesTable).where(eq(companiesTable.id, cid))).length, 0);
});

test("companies: empty name is rejected", opts, async () => {
  const res = await request(app).post("/api/companies").set("Cookie", owner).set(H).send({ name: "   " });
  assert.equal(res.status, 400);
});

test("positions: create assigns a sortOrder; delete blocked while assigned to a worker", opts, async () => {
  const a = await request(app).post("/api/positions").set("Cookie", owner).set(H).send({ name: "Welder", color: "amber" });
  const b = await request(app).post("/api/positions").set("Cookie", owner).set(H).send({ name: "Packer" });
  assert.ok(b.body.sortOrder > a.body.sortOrder, "sortOrder must increment");

  await db.insert(workersTable).values({ fullName: "W", positionId: a.body.id });
  const blocked = await request(app).delete(`/api/positions/${a.body.id}`).set("Cookie", owner).set(H);
  assert.equal(blocked.status, 400);
  const free = await request(app).delete(`/api/positions/${b.body.id}`).set("Cookie", owner).set(H);
  assert.equal(free.status, 200);
});

test("document-types: create with flags; delete blocked while a worker document uses it", opts, async () => {
  const dt = await request(app).post("/api/document-types").set("Cookie", owner).set(H).send({ name: "Paszport", required: true, hasExpiry: true });
  assert.equal(dt.body.required, true);
  assert.equal(dt.body.hasExpiry, true);

  const [w] = await db.insert(workersTable).values({ fullName: "W" }).returning({ id: workersTable.id });
  await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: dt.body.id, title: "Paszport" });
  const blocked = await request(app).delete(`/api/document-types/${dt.body.id}`).set("Cookie", owner).set(H);
  assert.equal(blocked.status, 400);
});

test("drivers: create returns a crypto invite code; delete is a soft-delete", opts, async () => {
  const created = await request(app).post("/api/drivers").set("Cookie", owner).set(H).send({ name: "Kierowca", seats: 8 });
  assert.equal(created.status, 200);
  assert.ok((created.body.inviteCode ?? "").length >= 12, "a crypto invite code must be issued");
  assert.equal(created.body.seats, 8);

  const del = await request(app).delete(`/api/drivers/${created.body.id}`).set("Cookie", owner).set(H);
  assert.equal(del.status, 200);
  const [d] = await db.select().from(driversTable).where(eq(driversTable.id, created.body.id));
  assert.ok(d, "row still exists (soft delete)");
  assert.equal(d!.isActive, false);
});

test("promoting a head driver is head-admin-only and demotes any previous head driver", opts, async () => {
  const main = await seedAdmin({ role: "owner", isMain: true });
  const [d1] = await db.insert(driversTable).values({ name: "D1", isHeadDriver: true, inviteCode: "AAAAAAAAAAAA" }).returning({ id: driversTable.id });
  const [d2] = await db.insert(driversTable).values({ name: "D2", inviteCode: "BBBBBBBBBBBB" }).returning({ id: driversTable.id });

  // A non-main admin cannot toggle isHeadDriver.
  await seedRole("drivermgr", ["assignDrivers"], ["/drivers"]);
  const nonMain = await seedAdmin({ role: "drivermgr" });
  const forbidden = await request(app).patch(`/api/drivers/${d2!.id}`).set("Cookie", nonMain.cookie).set(H).send({ isHeadDriver: true });
  assert.equal(forbidden.status, 403);

  // The head admin promotes d2 → d1 must be demoted (single head driver).
  const okRes = await request(app).patch(`/api/drivers/${d2!.id}`).set("Cookie", main.cookie).set(H).send({ isHeadDriver: true });
  assert.equal(okRes.status, 200);
  assert.equal((await db.select().from(driversTable).where(eq(driversTable.id, d1!.id)))[0]!.isHeadDriver, false);
  assert.equal((await db.select().from(driversTable).where(eq(driversTable.id, d2!.id)))[0]!.isHeadDriver, true);
});

test("vehicles: plate is upper-cased on create; delete is a soft-delete", opts, async () => {
  const created = await request(app).post("/api/vehicles").set("Cookie", owner).set(H).send({ plate: "po 123ab", brandModel: "VW Crafter", seats: 9 });
  assert.equal(created.status, 200);
  assert.equal(created.body.plate, "PO 123AB");

  await request(app).delete(`/api/vehicles/${created.body.id}`).set("Cookie", owner).set(H);
  const [v] = await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, created.body.id));
  assert.equal(v!.isActive, false, "soft delete keeps the plate for old mileage reports");
});

test("reference-data mutations require the right capability", opts, async () => {
  await seedRole("viewer", [], ["/"]);
  const { cookie } = await seedAdmin({ role: "viewer" });
  assert.equal((await request(app).post("/api/companies").set("Cookie", cookie).set(H).send({ name: "X" })).status, 403);
  assert.equal((await request(app).post("/api/drivers").set("Cookie", cookie).set(H).send({ name: "X" })).status, 403);
});
