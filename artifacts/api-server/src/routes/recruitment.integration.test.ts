import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db,
  funnelsTable, candidatesTable, candidateActivityTable, workersTable,
} from "../test/harness.ts";
import { eq } from "drizzle-orm";

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

test("convert creates a worker, marks the candidate hired, and blocks a second convert", opts, async () => {
  const f = await mkFunnel();
  const id = await mkCandidate(f.id);

  const res = await request(app).post(`/api/candidates/${id}/convert`).set("Cookie", owner).set(H).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.stage, "hired");
  assert.ok(res.body.workerId, "a worker id is linked");
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, res.body.workerId));
  assert.equal(w!.fullName, "Jan Kandydat");

  const again = await request(app).post(`/api/candidates/${id}/convert`).set("Cookie", owner).set(H).send({});
  assert.equal(again.status, 400);
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
