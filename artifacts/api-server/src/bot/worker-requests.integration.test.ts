import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, sendText, pressButton, resetSent, sentText } from "../test/botHarness.ts";
import { workersTable, advanceRequestsTable, absenceRequestsTable } from "../test/harness.ts";
import { setState } from "./state.ts";
import { eq } from "drizzle-orm";

// Worker-initiated requests: salary advance (adv:new → amount → comment) and absence
// (the reason step, seeded directly to avoid the time-gated shift list).
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const TID = "830100";

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

async function seedWorker() {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan", telegramId: TID, isActive: true }).returning({ id: workersTable.id });
  return w!.id;
}
const advances = (workerId: number) => db.select().from(advanceRequestsTable).where(eq(advanceRequestsTable.workerId, workerId));

test("advance: adv:new → amount → comment creates a pending request", opts, async () => {
  const workerId = await seedWorker();
  await pressButton(TID, "adv:new");
  await sendText(TID, "300");
  await sendText(TID, "na paliwo");
  const rows = await advances(workerId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.amount, 300);
  assert.equal(rows[0]!.status, "pending");
  assert.equal(rows[0]!.comment, "na paliwo");
});

test("advance: a '-' comment stores no note", opts, async () => {
  const workerId = await seedWorker();
  await pressButton(TID, "adv:new");
  await sendText(TID, "150,50");            // comma decimal
  await sendText(TID, "-");
  const [r] = await advances(workerId);
  assert.equal(r!.amount, 150.5);
  assert.equal(r!.comment, null);
});

test("advance: an amount over the 500 cap is rejected before any request is created", opts, async () => {
  const workerId = await seedWorker();
  await pressButton(TID, "adv:new");
  resetSent();
  await sendText(TID, "999");
  assert.match(sentText(), /500|макс|max/i);
  assert.equal((await advances(workerId)).length, 0);
});

test("advance: the once-per-day limit blocks a second request", opts, async () => {
  const workerId = await seedWorker();
  // first request (full flow)
  await pressButton(TID, "adv:new");
  await sendText(TID, "100");
  await sendText(TID, "-");
  assert.equal((await advances(workerId)).length, 1);
  // second attempt the same day
  resetSent();
  await pressButton(TID, "adv:new");
  assert.match(sentText(), /день|раз на день|limit|раз|день/i);
  assert.equal((await advances(workerId)).length, 1, "no second request is created");
});

test("absence: entering a reason for a whole day creates a pending request (shift NULL)", opts, async () => {
  const workerId = await seedWorker();
  setState(TID, "absence:enter_reason", { workerId, lang: "uk", weekStart: "2099-06-01", weekId: null, day: "mon", shift: null, entryId: null, dateLabel: "01.06" });
  await sendText(TID, "wesele");
  const rows = await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.workerId, workerId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.shift, null, "whole-day request has a null shift");
  assert.equal(rows[0]!.status, "pending");
  assert.equal(rows[0]!.reason, "wesele");
});

test("absence: entering a reason for a specific shift creates a pending request", opts, async () => {
  const workerId = await seedWorker();
  setState(TID, "absence:enter_reason", { workerId, lang: "uk", weekStart: "2099-06-01", weekId: 1, day: "tue", shift: "2", entryId: 1, dateLabel: "02.06" });
  await sendText(TID, "wizyta u lekarza");
  const [r] = await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.workerId, workerId));
  assert.equal(r!.shift, "2");
  assert.equal(r!.dayOfWeek, "tue");
  assert.equal(r!.status, "pending");
});
