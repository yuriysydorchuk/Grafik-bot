// Дата звільнення вже звільненого (22.10.2026, кейс Okafor: звільнили «сьогодні» 21.08, реально
// останній день 13.08): журнал fired + fired_at + кінець умов, закритих звільненням; історія fireDate.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, workerChangesTable, contractsTable } from "../test/harness.ts";
import { fireWorker } from "../services/workerFire.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" };
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("PUT /workers/:id/fire-date: 21.08 → 13.08 — журнал, fired_at, умова, закрита звільненням; активному/майбутня — 400", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [w] = await db.insert(workersTable).values({ fullName: "Okafor Test", isActive: true }).returning();
  const [c] = await db.insert(contractsTable).values({ workerId: w!.id, status: "signed", dateFrom: "2026-07-01" } as any).returning();
  const [other] = await db.insert(contractsTable).values({ workerId: w!.id, status: "signed", dateFrom: "2026-05-01", dateTo: "2026-06-30" } as any).returning();

  const put = (id: number, date: string) => request(app).put(`/api/workers/${id}/fire-date`).set("Cookie", owner.cookie).set(H).send({ date });
  assert.equal((await put(w!.id, "2026-08-13")).status, 400, "активному — 400 (дату ставить «Звільнити»)");

  assert.equal((await fireWorker({ workerId: w!.id, date: "2026-08-21", adminId: owner.adminId, source: "web" })).ok, true);
  assert.equal((await put(w!.id, "2999-01-01")).status, 400, "майбутня дата — 400");
  const r = await put(w!.id, "2026-08-13");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.from, "2026-08-21"); assert.equal(r.body.contracts, 1);

  const [fired] = await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, w!.id), eq(workerChangesTable.field, "fired")));
  assert.equal(String(fired!.effectiveDate), "2026-08-13");
  const [hist] = await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, w!.id), eq(workerChangesTable.field, "fireDate")));
  assert.deepEqual([hist!.oldValue, hist!.newValue, hist!.adminId], ["2026-08-21", "2026-08-13", owner.adminId]);
  const [ww] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(ww!.firedAt!.toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" }), "2026-08-13");
  const [c2] = await db.select().from(contractsTable).where(eq(contractsTable.id, c!.id));
  assert.equal(String(c2!.dateTo), "2026-08-13", "умову, закриту звільненням, перенесено");
  const [o2] = await db.select().from(contractsTable).where(eq(contractsTable.id, other!.id));
  assert.equal(String(o2!.dateTo), "2026-06-30", "умову, що скінчилась раніше, не чіпаємо");
});
