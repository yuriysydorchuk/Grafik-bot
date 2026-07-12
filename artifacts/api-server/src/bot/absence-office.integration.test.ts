import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, pressButton, resetSent } from "../test/botHarness.ts";
import { workersTable, scheduleWeeksTable, scheduleEntriesTable, absenceRequestsTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";

// Office side of the absence flow, driven through the bot inline buttons an admin taps.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const WEEK = "2099-04-05";

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

async function seed(shift: string | null) {
  const { factoriesTable } = await import("@workspace/db");
  const [f] = await db.insert(factoriesTable).values({ name: "F" }).returning({ id: factoriesTable.id });
  const [w] = await db.insert(workersTable).values({ fullName: "Worker" }).returning({ id: workersTable.id });
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: WEEK, status: "approved" }).returning({ id: scheduleWeeksTable.id });
  const [e] = await db.insert(scheduleEntriesTable).values({ weekId: wk!.id, workerId: w!.id, factoryId: f!.id, dayOfWeek: "mon" as any, shift: "1" as any, status: "scheduled" }).returning({ id: scheduleEntriesTable.id });
  const [ar] = await db.insert(absenceRequestsTable).values({ workerId: w!.id, weekStart: WEEK, dayOfWeek: "mon" as any, shift: shift as any, status: "pending" }).returning({ id: absenceRequestsTable.id });
  return { entryId: e!.id, requestId: ar!.id };
}

test("absence_approve (shift-specific): request accepted and the entry goes absent", opts, async () => {
  const { entryId, requestId } = await seed("1");
  await pressButton("810100", `absence_approve_${requestId}`);
  assert.equal((await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, requestId)))[0]!.status, "accepted");
  assert.equal((await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, entryId)))[0]!.status, "absent");
});

test("absence_approve (whole day): every scheduled shift that day goes absent", opts, async () => {
  const { entryId, requestId } = await seed(null);
  await pressButton("810200", `absence_approve_${requestId}`);
  assert.equal((await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, entryId)))[0]!.status, "absent");
});

test("absence_reject: request rejected, entry left scheduled", opts, async () => {
  const { entryId, requestId } = await seed("1");
  await pressButton("810300", `absence_reject_${requestId}`);
  assert.equal((await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.id, requestId)))[0]!.status, "rejected");
  assert.equal((await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, entryId)))[0]!.status, "scheduled");
});

test("absence_approve on an unknown request id is handled gracefully", opts, async () => {
  await pressButton("810400", "absence_approve_999999");
  // no throw, nothing to assert beyond the handler not crashing the process
  assert.ok(true);
});
