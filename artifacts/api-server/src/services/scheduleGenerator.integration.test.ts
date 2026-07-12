import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  hasTestDb, resetDb, closeDb, db,
  factoriesTable, workersTable, positionsTable, factoryOrdersTable, availabilityTable, absenceRequestsTable,
  scheduleEntriesTable,
} from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { generateSchedule } from "./scheduleGenerator.ts";

// Full end-to-end tests of the schedule placement algorithm against a real Postgres.
// A far-future weekStart keeps every shift "in the future", so nothing is time-locked and
// the result is deterministic regardless of when the suite runs.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const WEEK = "2099-01-05";

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function mkFactory(over: Record<string, unknown> = {}): Promise<number> {
  const [f] = await db.insert(factoriesTable).values({ name: "F", ...over }).returning({ id: factoriesTable.id });
  return f!.id;
}
async function mkWorker(factoryId: number, over: Record<string, unknown> = {}): Promise<number> {
  const [w] = await db.insert(workersTable).values({ fullName: `W${Math.random().toString(36).slice(2, 8)}`, factoryId, ...over }).returning({ id: workersTable.id });
  return w!.id;
}
async function mkOrder(factoryId: number, day: string, shift: string, needed: number, requirements: unknown[] = []): Promise<void> {
  await db.insert(factoryOrdersTable).values({ factoryId, weekStart: WEEK, dayOfWeek: day as any, shift: shift as any, workersNeeded: needed, requirements: requirements as any });
}
async function mkAvail(workerId: number, day: string, shift: string): Promise<void> {
  await db.insert(availabilityTable).values({ fullNameRaw: "x", workerId, weekStart: WEEK, dayOfWeek: day as any, shift: shift as any, submittedAt: new Date() });
}
async function entriesFor(weekId: number) {
  return db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.weekId, weekId));
}

test("availability mode: assigns available workers and reports a shortage when the pool is too small", opts, async () => {
  const f = await mkFactory({ usesAvailability: true });
  const w1 = await mkWorker(f), w2 = await mkWorker(f);
  await mkAvail(w1, "mon", "1"); await mkAvail(w2, "mon", "1");
  await mkOrder(f, "mon", "1", 3); // need 3, only 2 available

  const res = await generateSchedule(WEEK);
  assert.equal(res.totalAssigned, 2);
  const rows = await entriesFor(res.weekId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.workerId).sort(), [w1, w2].sort());
  assert.equal(res.shortages.length, 1);
  assert.equal(res.shortages[0]!.shortage, 1);
});

test("position requirement: only a worker of the required position fills the line", opts, async () => {
  const f = await mkFactory({ usesAvailability: true, usesPositions: true });
  const [p] = await db.insert(positionsTable).values({ name: "Welder" }).returning({ id: positionsTable.id });
  const welder = await mkWorker(f, { positionId: p!.id });
  const generic = await mkWorker(f, { positionId: null });
  await mkAvail(welder, "mon", "1"); await mkAvail(generic, "mon", "1");
  await mkOrder(f, "mon", "1", 1, [{ positionId: p!.id, gender: "any", count: 1 }]);

  const res = await generateSchedule(WEEK);
  const rows = await entriesFor(res.weekId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.workerId, welder);
});

test("gender requirement: only the requested gender is placed", opts, async () => {
  const f = await mkFactory({ usesAvailability: true, usesGender: true });
  const female = await mkWorker(f, { gender: "female" });
  const male = await mkWorker(f, { gender: "male" });
  await mkAvail(female, "mon", "1"); await mkAvail(male, "mon", "1");
  await mkOrder(f, "mon", "1", 1, [{ positionId: null, gender: "female", count: 1 }]);

  const res = await generateSchedule(WEEK);
  const rows = await entriesFor(res.weekId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.workerId, female);
});

test("absence (whole day) removes the worker from every shift that day", opts, async () => {
  const f = await mkFactory({ usesAvailability: true });
  const w = await mkWorker(f);
  await mkAvail(w, "mon", "1");
  await mkOrder(f, "mon", "1", 1);
  await db.insert(absenceRequestsTable).values({ workerId: w, weekStart: WEEK, dayOfWeek: "mon" as any, shift: null, status: "accepted" });

  const res = await generateSchedule(WEEK);
  assert.equal(res.totalAssigned, 0);
  assert.equal(res.shortages[0]!.shortage, 1);
});

test("no double-booking: one worker can't fill two shifts on the same day", opts, async () => {
  const f = await mkFactory({ usesAvailability: true });
  const w = await mkWorker(f);
  await mkAvail(w, "mon", "1"); await mkAvail(w, "mon", "2");
  await mkOrder(f, "mon", "1", 1); await mkOrder(f, "mon", "2", 1);

  const res = await generateSchedule(WEEK);
  assert.equal(res.totalAssigned, 1); // placed once, second shift left short
});

test("'all' mode releases everyone Mon–Sat with fixed-shift workers pinned to their shift", opts, async () => {
  const f = await mkFactory({ genMode: "all", usesAvailability: false, shiftCount: 2 });
  const bound = await mkWorker(f, { fixedShift: "1" });
  const flex = await mkWorker(f, { fixedShift: null });

  const res = await generateSchedule(WEEK);
  const rows = await entriesFor(res.weekId);
  // Mon–Sat (6 days) × 2 workers = 12 entries.
  assert.equal(rows.length, 12);
  const boundRows = rows.filter(r => r.workerId === bound);
  assert.equal(boundRows.length, 6);
  assert.ok(boundRows.every(r => r.shift === "1"), "bound worker must always be on shift 1");
  assert.ok(rows.some(r => r.workerId === flex), "flexible worker must be scheduled too");
});
