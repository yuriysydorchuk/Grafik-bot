// Облік годин бере явки тижнів обліку (accountingWeekSql, зголошення #6 02.11.2026): тиждень,
// затверджений лише по днях (status draft), рахується; дубль-draft поруч із затвердженим — ні.
// Деталізація днів (/worker-days) і «додати зміну» — за тим самим правилом.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, factoriesTable, scheduleWeeksTable, scheduleEntriesTable } from "../test/harness.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" };
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("hours: draft-тиждень без затвердженого рахується, дубль-draft поруч із затвердженим — ні", opts, async () => {
  const owner = await seedAdmin({ role: "owner", isMain: true });
  const [f] = await db.insert(factoriesTable).values({ name: "ALMIZ" }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Test Draftweek", factoryId: f!.id, isActive: true }).returning();
  const entry = (weekId: number, day: "mon" | "tue" | "wed", status: "present" | "scheduled" = "present") =>
    ({ weekId, workerId: w!.id, factoryId: f!.id, dayOfWeek: day, shift: "1" as const, status });
  // 02.03 — затверджений: 1 явка
  const [a] = await db.insert(scheduleWeeksTable).values({ weekStart: "2099-03-02", status: "approved" }).returning();
  await db.insert(scheduleEntriesTable).values([entry(a!.id, "mon")]);
  // 09.03 — лише draft (затверджували по днях): 2 явки + 1 запланована
  const [b] = await db.insert(scheduleWeeksTable).values({ weekStart: "2099-03-09", status: "draft" }).returning();
  await db.insert(scheduleEntriesTable).values([entry(b!.id, "tue"), entry(b!.id, "wed"), entry(b!.id, "mon", "scheduled")]);
  // 16.03 — затверджений (1 явка) + новіший дубль-draft зі старими явками (2) — дубль не рахується
  const [c] = await db.insert(scheduleWeeksTable).values({ weekStart: "2099-03-16", status: "approved" }).returning();
  const [c2] = await db.insert(scheduleWeeksTable).values({ weekStart: "2099-03-16", status: "draft" }).returning();
  await db.insert(scheduleEntriesTable).values([entry(c!.id, "mon"), entry(c2!.id, "mon"), entry(c2!.id, "tue")]);

  const r = await request(app).get("/api/hours?month=2099-03").set("Cookie", owner.cookie);
  assert.equal(r.status, 200, r.text);
  const row = r.body.workers.find((x: any) => x.workerId === w!.id);
  assert.ok(row, "рядок працівника є");
  assert.equal(row.shifts, 4, "1 (approved) + 2 (draft без затвердженого) + 1 (approved, без дубля)");

  const d = await request(app).get(`/api/worker-days/${w!.id}?month=2099-03`).set("Cookie", owner.cookie);
  assert.equal(d.status, 200, d.text);
  const present = d.body.days.filter((x: any) => x.status === "present");
  assert.equal(present.length, 4, "деталізація днів збігається з обліком: " + JSON.stringify(d.body.days.map((x: any) => [x.date, x.status])));

  // «додати зміну» на дату draft-тижня лягає в цей тиждень (раніше — 400 «Немає затвердженого тижня»)
  const add = await request(app).post(`/api/worker-days/${w!.id}/add-shift`).set("Cookie", owner.cookie).set(H).send({ date: "2099-03-12", factoryId: f!.id, shift: "1" });
  assert.equal(add.status, 200, add.text);
  const r2 = await request(app).get("/api/hours?month=2099-03").set("Cookie", owner.cookie);
  assert.equal(r2.body.workers.find((x: any) => x.workerId === w!.id).shifts, 5);
});
