import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  app, hasTestDb, resetDb, seedAdmin, closeDb, db,
  factoriesTable, workersTable, factoryOrdersTable, absenceRequestsTable,
  scheduleWeeksTable, scheduleEntriesTable,
} from "../test/harness.ts";
import { eq, and } from "drizzle-orm";

// Operational-core mutations of admin-api that drive real scheduling data.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const WEEK = "2099-02-01";

let cookie = "";
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  cookie = (await seedAdmin({ role: "owner" })).cookie; // owner has editData (RW)
});
after(async () => { if (hasTestDb) await closeDb(); });

async function mkFactory(): Promise<number> {
  const [f] = await db.insert(factoriesTable).values({ name: "F" }).returning({ id: factoriesTable.id });
  return f!.id;
}
async function mkWorker(factoryId: number): Promise<number> {
  const [w] = await db.insert(workersTable).values({ fullName: "W", factoryId }).returning({ id: workersTable.id });
  return w!.id;
}
async function mkApprovedWeek(): Promise<number> {
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: WEEK, status: "approved" }).returning({ id: scheduleWeeksTable.id });
  return wk!.id;
}
async function mkEntry(weekId: number, workerId: number, factoryId: number, shift: string): Promise<number> {
  const [e] = await db.insert(scheduleEntriesTable).values({ weekId, workerId, factoryId, dayOfWeek: "mon" as any, shift: shift as any, status: "scheduled" }).returning({ id: scheduleEntriesTable.id });
  return e!.id;
}

test("PUT /orders writes factory_orders from the totals grid", opts, async () => {
  const f = await mkFactory();
  const res = await request(app).put("/api/orders").set("Cookie", cookie).set(H)
    .send({ factoryId: f, weekStart: WEEK, totals: { mon: [2, 0, 0, 0, 0, 0] }, req: {} });
  assert.equal(res.status, 200);
  const rows = await db.select().from(factoryOrdersTable).where(eq(factoryOrdersTable.factoryId, f));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.dayOfWeek, "mon");
  assert.equal(rows[0]!.shift, "1");
  assert.equal(rows[0]!.workersNeeded, 2);
});

test("PUT /orders replaces prior orders and sums a position/gender breakdown", opts, async () => {
  const f = await mkFactory();
  await request(app).put("/api/orders").set("Cookie", cookie).set(H)
    .send({ factoryId: f, weekStart: WEEK, totals: { mon: [2, 0, 0, 0, 0, 0] }, req: {} });
  // Re-PUT: shift 1 now driven by a breakdown (3), shift 2 zeroed, previous rows wiped.
  await request(app).put("/api/orders").set("Cookie", cookie).set(H)
    .send({ factoryId: f, weekStart: WEEK, totals: { mon: [0, 0, 0, 0, 0, 0] }, req: { "mon-1": [{ positionId: null, gender: "male", count: 3 }] } });
  const rows = await db.select().from(factoryOrdersTable).where(eq(factoryOrdersTable.factoryId, f));
  assert.equal(rows.length, 1, "old orders replaced, not duplicated");
  assert.equal(rows[0]!.workersNeeded, 3, "headcount = sum of the breakdown lines");
});

test("PATCH /schedule/entry/:id/status updates status; rejects an invalid one", opts, async () => {
  const f = await mkFactory(), w = await mkWorker(f), wk = await mkApprovedWeek();
  const e = await mkEntry(wk, w, f, "1");

  const present = await request(app).patch(`/api/schedule/entry/${e}/status`).set("Cookie", cookie).set(H).send({ status: "present" });
  assert.equal(present.status, 200);
  assert.equal((await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, e)))[0]!.status, "present");

  const bad = await request(app).patch(`/api/schedule/entry/${e}/status`).set("Cookie", cookie).set(H).send({ status: "wat" });
  assert.equal(bad.status, 400);
});

test("approving a shift-specific absence marks that scheduled entry absent", opts, async () => {
  const f = await mkFactory(), w = await mkWorker(f), wk = await mkApprovedWeek();
  const e = await mkEntry(wk, w, f, "1");
  const [ar] = await db.insert(absenceRequestsTable).values({ workerId: w, weekStart: WEEK, dayOfWeek: "mon" as any, shift: "1" as any, status: "pending" }).returning({ id: absenceRequestsTable.id });

  const res = await request(app).post(`/api/absence-requests/${ar!.id}/approve`).set("Cookie", cookie).set(H).send({});
  assert.equal(res.status, 200);
  assert.equal((await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, ar!.id)))[0]!.status, "accepted");
  assert.equal((await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, e)))[0]!.status, "absent");
});

test("approving a whole-day absence marks every scheduled shift that day absent", opts, async () => {
  const f = await mkFactory(), w = await mkWorker(f), wk = await mkApprovedWeek();
  const e1 = await mkEntry(wk, w, f, "1"), e2 = await mkEntry(wk, w, f, "2");
  const [ar] = await db.insert(absenceRequestsTable).values({ workerId: w, weekStart: WEEK, dayOfWeek: "mon" as any, shift: null, status: "pending" }).returning({ id: absenceRequestsTable.id });

  await request(app).post(`/api/absence-requests/${ar!.id}/approve`).set("Cookie", cookie).set(H).send({});
  const rows = await db.select().from(scheduleEntriesTable).where(and(eq(scheduleEntriesTable.id, e1)));
  const rows2 = await db.select().from(scheduleEntriesTable).where(and(eq(scheduleEntriesTable.id, e2)));
  assert.equal(rows[0]!.status, "absent");
  assert.equal(rows2[0]!.status, "absent");
});

test("rejecting an absence sets it rejected and leaves the entry scheduled", opts, async () => {
  const f = await mkFactory(), w = await mkWorker(f), wk = await mkApprovedWeek();
  const e = await mkEntry(wk, w, f, "1");
  const [ar] = await db.insert(absenceRequestsTable).values({ workerId: w, weekStart: WEEK, dayOfWeek: "mon" as any, shift: "1" as any, status: "pending" }).returning({ id: absenceRequestsTable.id });

  const res = await request(app).post(`/api/absence-requests/${ar!.id}/reject`).set("Cookie", cookie).set(H).send({});
  assert.equal(res.status, 200);
  assert.equal((await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, ar!.id)))[0]!.status, "rejected");
  assert.equal((await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, e)))[0]!.status, "scheduled");
});
