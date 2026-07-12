import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, workersTable, advanceRequestsTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";

// Salary-advance decisions (editData): approve/reject stamp the decision; "paid" is only
// allowed after "approved".
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

let owner = "";
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  owner = (await seedAdmin({ role: "owner" })).cookie;
});
after(async () => { if (hasTestDb) await closeDb(); });

async function mkRequest(): Promise<{ workerId: number; id: number }> {
  const [w] = await db.insert(workersTable).values({ fullName: "W" }).returning({ id: workersTable.id });
  const [r] = await db.insert(advanceRequestsTable).values({ workerId: w!.id, amount: 500, status: "pending" }).returning({ id: advanceRequestsTable.id });
  return { workerId: w!.id, id: r!.id };
}
const statusOf = async (id: number) => (await db.select().from(advanceRequestsTable).where(eq(advanceRequestsTable.id, id)))[0]!;

test("approve stamps decidedBy and note; then paid succeeds and sets paidAt", opts, async () => {
  const { id } = await mkRequest();
  const { adminId } = await seedAdmin({ role: "owner", name: "Decider" });
  // use the decider's own cookie so decidedBy is theirs
  const deciderCookie = (await seedAdmin({ role: "owner", name: "D2" })).cookie;

  const appr = await request(app).post(`/api/advances/${id}/approve`).set("Cookie", deciderCookie).set(H).send({ note: "OK do wypłaty" });
  assert.equal(appr.status, 200);
  let r = await statusOf(id);
  assert.equal(r.status, "approved");
  assert.equal(r.adminNote, "OK do wypłaty");
  assert.ok(r.decidedBy, "decidedBy must be recorded");

  const paid = await request(app).post(`/api/advances/${id}/paid`).set("Cookie", owner).set(H).send({});
  assert.equal(paid.status, 200);
  r = await statusOf(id);
  assert.equal(r.status, "paid");
  assert.ok(r.paidAt, "paidAt must be set");
  void adminId;
});

test("paid is rejected for a request that was never approved", opts, async () => {
  const { id } = await mkRequest();
  const res = await request(app).post(`/api/advances/${id}/paid`).set("Cookie", owner).set(H).send({});
  assert.equal(res.status, 400);
  assert.equal((await statusOf(id)).status, "pending");
});

test("reject sets rejected; unknown id → 404", opts, async () => {
  const { id } = await mkRequest();
  const rej = await request(app).post(`/api/advances/${id}/reject`).set("Cookie", owner).set(H).send({});
  assert.equal(rej.status, 200);
  assert.equal((await statusOf(id)).status, "rejected");

  const missing = await request(app).post(`/api/advances/999999/approve`).set("Cookie", owner).set(H).send({});
  assert.equal(missing.status, 404);
});

test("advance decisions require editData", opts, async () => {
  const { id } = await mkRequest();
  await seedRole("viewer", [], ["/"]);
  const { cookie } = await seedAdmin({ role: "viewer" });
  assert.equal((await request(app).post(`/api/advances/${id}/approve`).set("Cookie", cookie).set(H).send({})).status, 403);
});
