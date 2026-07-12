import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, pressButton, resetSent } from "../test/botHarness.ts";
import { driversTable, workersTable, scheduleWeeksTable, scheduleEntriesTable, factoriesTable } from "../test/harness.ts";
import { setState } from "./state.ts";
import { eq } from "drizzle-orm";

// Driver boarding commit (brd:ok). We seed the "boarding" dialog state directly to bypass
// the time-gated list builder, and use a FAR-FUTURE boardDate so the wall-clock-dependent
// auto-absent pass is skipped — leaving the deterministic present/substitution logic.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const FUTURE = "2099-03-02";

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

let factoryId = 0;
async function seedBase() {
  const [f] = await db.insert(factoriesTable).values({ name: "F" }).returning({ id: factoriesTable.id });
  factoryId = f!.id;
  const [drv] = await db.insert(driversTable).values({ name: "Driver", telegramId: "800100", inviteCode: "DRVBOARD0001", isActive: true }).returning({ id: driversTable.id });
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: FUTURE, status: "approved" }).returning({ id: scheduleWeeksTable.id });
  return { driverId: drv!.id, weekId: wk!.id };
}
async function mkEntry(weekId: number, workerName: string, over: Record<string, unknown> = {}) {
  const [w] = await db.insert(workersTable).values({ fullName: workerName }).returning({ id: workersTable.id });
  const [e] = await db.insert(scheduleEntriesTable).values({ weekId, workerId: w!.id, factoryId, dayOfWeek: "mon" as any, shift: "1" as any, status: "scheduled", ...over }).returning({ id: scheduleEntriesTable.id });
  return { workerId: w!.id, entryId: e!.id };
}
const board = (weekId: number, workers: any[]) => ({
  weekId, dayName: "mon", boardDate: FUTURE,
  sections: [{ factoryId, shift: "1", factoryName: "F" }],
  workers, chatId: 800100, messageId: 0, lang: "uk",
});

test("boarding: a boarded worker becomes present and is attributed to the driver", opts, async () => {
  const { driverId, weekId } = await seedBase();
  const a = await mkEntry(weekId, "Boarded");
  setState("800100", "boarding", board(weekId, [
    { key: `e${a.entryId}`, entryId: a.entryId, workerId: a.workerId, name: "Boarded", factoryId, shift: "1", boarded: true, unplanned: false },
  ]));

  await pressButton("800100", "brd:ok");

  const [after] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, a.entryId));
  assert.equal(after!.status, "present");
  assert.equal(after!.pickedUpBy, driverId, "presence is attributed to the confirming driver");
});

test("boarding: a substitution marks the replaced worker absent with a 'заміна' reason", opts, async () => {
  const { weekId } = await seedBase();
  const replaced = await mkEntry(weekId, "Replaced");
  const [subW] = await db.insert(workersTable).values({ fullName: "Substitute" }).returning({ id: workersTable.id });

  setState("800100", "boarding", board(weekId, [
    { key: "sub", entryId: null, workerId: subW!.id, name: "Substitute", factoryId, shift: "1", boarded: true, unplanned: false, subForEntryId: replaced.entryId, subForName: "Replaced" },
    { key: `e${replaced.entryId}`, entryId: replaced.entryId, workerId: replaced.workerId, name: "Replaced", factoryId, shift: "1", boarded: false, unplanned: false },
  ]));

  await pressButton("800100", "brd:ok");

  const [rep] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, replaced.entryId));
  assert.equal(rep!.status, "absent");
  assert.match(rep!.absenceReason ?? "", /заміна/i);
});

test("boarding: brd:ok is a no-op without a boarding state", opts, async () => {
  const { weekId } = await seedBase();
  const a = await mkEntry(weekId, "Untouched");
  await pressButton("800100", "brd:ok"); // no state set
  const [after] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, a.entryId));
  assert.equal(after!.status, "scheduled", "nothing changes without an active boarding dialog");
});
