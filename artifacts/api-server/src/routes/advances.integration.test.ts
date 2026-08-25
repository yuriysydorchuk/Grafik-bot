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

test("approve stamps decidedBy, note and payout group; then paid succeeds and sets paidAt", opts, async () => {
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
  // затвердження ставить групу виплат за сьогоднішньою датою
  assert.match(r.payoutMonth ?? "", /^\d{4}-\d{2}$/);
  assert.ok(r.payoutGroup === "15" || r.payoutGroup === "30");

  const paid = await request(app).post(`/api/advances/${id}/paid`).set("Cookie", owner).set(H).send({ method: "cash" });
  assert.equal(paid.status, 200);
  r = await statusOf(id);
  assert.equal(r.status, "paid");
  assert.ok(r.paidAt, "paidAt must be set");
  assert.equal(r.paidMethod, "cash");
  void adminId;
});

test("office submission goes straight to approved with payout group and submitter", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Office Target" }).returning({ id: workersTable.id });
  const res = await request(app).post(`/api/advances`).set("Cookie", owner).set(H)
    .send({ workerId: w!.id, amount: 350.5, comment: "на пальне" });
  assert.equal(res.status, 200);
  const r = await statusOf(res.body.id);
  assert.equal(r.status, "approved");
  assert.equal(r.amount, 350.5);
  assert.equal(r.comment, "на пальне");
  assert.ok(r.decidedBy, "submitter is the decider");
  assert.match(r.payoutMonth ?? "", /^\d{4}-\d{2}$/);
  assert.ok(r.payoutGroup === "15" || r.payoutGroup === "30");

  // без працівника/суми — 400
  assert.equal((await request(app).post(`/api/advances`).set("Cookie", owner).set(H).send({ amount: 100 })).status, 400);
  assert.equal((await request(app).post(`/api/advances`).set("Cookie", owner).set(H).send({ workerId: w!.id, amount: 0 })).status, 400);
  assert.equal((await request(app).post(`/api/advances`).set("Cookie", owner).set(H).send({ workerId: 999999, amount: 100 })).status, 404);
});

test("PATCH moves an approved advance between payout groups; paid/pending are refused", opts, async () => {
  const { id } = await mkRequest();
  // pending — переносити нема куди
  assert.equal((await request(app).patch(`/api/advances/${id}`).set("Cookie", owner).set(H)
    .send({ payoutMonth: "2026-09", payoutGroup: "30" })).status, 400);

  await request(app).post(`/api/advances/${id}/approve`).set("Cookie", owner).set(H).send({});
  const mv = await request(app).patch(`/api/advances/${id}`).set("Cookie", owner).set(H)
    .send({ payoutMonth: "2026-09", payoutGroup: "30" });
  assert.equal(mv.status, 200);
  let r = await statusOf(id);
  assert.equal(r.payoutMonth, "2026-09");
  assert.equal(r.payoutGroup, "30");

  // невалідна група/місяць — 400
  assert.equal((await request(app).patch(`/api/advances/${id}`).set("Cookie", owner).set(H)
    .send({ payoutMonth: "2026-09", payoutGroup: "20" })).status, 400);

  await request(app).post(`/api/advances/${id}/paid`).set("Cookie", owner).set(H).send({ method: "transfer" });
  r = await statusOf(id);
  assert.equal(r.paidMethod, "transfer");
  assert.equal((await request(app).patch(`/api/advances/${id}`).set("Cookie", owner).set(H)
    .send({ payoutMonth: "2026-10", payoutGroup: "15" })).status, 400);
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

test("gratyfikant-ліста залічок: фірма+група, вибір rows, файл; гейт svodniSensitive", opts, async () => {
  const { companiesTable } = await import("../test/harness.ts");
  const [firmES] = await db.insert(companiesTable).values({ name: "ES" } as any).returning();
  const [firmESO] = await db.insert(companiesTable).values({ name: "ESO" } as any).returning();
  const [w1] = await db.insert(workersTable).values({ fullName: "Kowalski Jan", companyId: firmES!.id, gratyfikantName: "KOWALSKI JAN", pesel: "90010112345" } as any).returning();
  const [w2] = await db.insert(workersTable).values({ fullName: "Bez Pesela", companyId: firmES!.id } as any).returning();
  const [w3] = await db.insert(workersTable).values({ fullName: "Chuzha Firma", companyId: firmESO!.id } as any).returning();
  const mk = (workerId: number, amount: number, group: "15" | "30") => db.insert(advanceRequestsTable).values({
    workerId, amount, status: "approved", payoutMonth: "2026-09", payoutGroup: group, decidedAt: new Date(),
  } as any).returning();
  const [a1] = await mk(w1!.id, 200, "15");
  const [a2] = await mk(w2!.id, 300, "15");
  await mk(w3!.id, 999, "15");     // інша фірма — поза лістою ES
  await mk(w1!.id, 150, "30");     // інша група

  const prev = await request(app).get("/api/advances/gratyfikant-preview?month=2026-09&group=15&firm=ES").set("Cookie", owner);
  assert.equal(prev.status, 200);
  assert.equal(prev.body.payDate, "2026-09-15");
  assert.deepEqual(prev.body.rows.map((r: any) => r.rowId).sort(), [a1!.id, a2!.id].sort());
  const noPesel = prev.body.rows.find((r: any) => r.rowId === a2!.id);
  assert.ok(noPesel.warnings.includes("no_pesel"));
  assert.equal(prev.body.rows.find((r: any) => r.rowId === a1!.id).name, "KOWALSKI JAN");

  // файл: лише вибрані rows, xlsx content-type
  const dl = await request(app).get(`/api/advances/gratyfikant?month=2026-09&group=15&firm=ES&payDate=2026-09-15&rows=${a1!.id}`).set("Cookie", owner);
  assert.equal(dl.status, 200);
  assert.match(dl.headers["content-type"] ?? "", /spreadsheetml/);

  // editData без svodniSensitive — 403
  await seedRole("clerk", ["editData"], ["/advances"]);
  const clerk = (await seedAdmin({ role: "clerk" })).cookie;
  assert.equal((await request(app).get("/api/advances/gratyfikant-preview?month=2026-09&group=15&firm=ES").set("Cookie", clerk)).status, 403);
});

test("svodni-pending: виплачені без позначки; перенесені зникають", opts, async () => {
  const { id, workerId } = await mkRequest();
  await request(app).post(`/api/advances/${id}/approve`).set("Cookie", owner).set(H).send({});
  await request(app).post(`/api/advances/${id}/paid`).set("Cookie", owner).set(H).send({ method: "cash" });
  let pend = await request(app).get("/api/advances/svodni-pending").set("Cookie", owner);
  assert.equal(pend.status, 200);
  assert.deepEqual(pend.body.rows.map((r: any) => r.id), [id]);
  assert.equal(pend.body.total, 500);
  // позначка перенесення прибирає з черги і зʼявляється у «перенесених»
  await db.update(advanceRequestsTable).set({ svodniMonth: "2026-08", svodniAppliedAt: "2026-08-25" } as any)
    .where(eq(advanceRequestsTable.id, id));
  pend = await request(app).get("/api/advances/svodni-pending").set("Cookie", owner);
  assert.equal(pend.body.rows.length, 0);
  const applied = await request(app).get("/api/advances/svodni-applied").set("Cookie", owner);
  assert.deepEqual(applied.body.rows.map((r: any) => r.id), [id]);
  void workerId;
});
