import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, sendText, resetSent, sent, sentText } from "../test/botHarness.ts";
import { driversTable, factoriesTable, scheduleWeeksTable, driverShiftAssignmentsTable } from "../test/harness.ts";
import { getCurrentMonday } from "../services/scheduleGenerator.ts";
import { warsawDayName } from "./time.ts";
import { resolveWeekRow, ensureWeekRow } from "../services/weeks.ts";
import { setState } from "./state.ts";

// The web panel works with DRAFT weeks (and creates them when assigning drivers
// ahead), so driver-facing bot surfaces must resolve weeks the same way instead
// of filtering approved-only — that filter hid web-made assignments from drivers
// for a whole weekend (week approved Monday morning only).
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

const TID = "800200";
async function seedDriver(over: Record<string, unknown> = {}) {
  const [d] = await db.insert(driversTable)
    .values({ name: "Driver", telegramId: TID, inviteCode: "DRVWEEK00001", isActive: true, ...over })
    .returning({ id: driversTable.id });
  return d!.id;
}

test("resolveWeekRow prefers the approved row over a newer draft of the same week", opts, async () => {
  await db.insert(scheduleWeeksTable).values({ weekStart: "2099-03-02", status: "approved" });
  await db.insert(scheduleWeeksTable).values({ weekStart: "2099-03-02", status: "draft" });
  const row = await resolveWeekRow("2099-03-02");
  assert.equal(row!.status, "approved");
});

test("ensureWeekRow creates a draft once and then reuses it", opts, async () => {
  const row = await ensureWeekRow("2099-03-09");
  assert.equal(row.status, "draft");
  const again = await ensureWeekRow("2099-03-09");
  assert.equal(again.id, row.id, "second call reuses the same row");
});

test("driver sees assignments made on a DRAFT current week («Мій графік»)", opts, async () => {
  const driverId = await seedDriver();
  const [f] = await db.insert(factoriesTable).values({ name: "DraftFab" }).returning({ id: factoriesTable.id });
  const [wk] = await db.insert(scheduleWeeksTable)
    .values({ weekStart: getCurrentMonday(), status: "draft" })
    .returning({ id: scheduleWeeksTable.id });
  await db.insert(driverShiftAssignmentsTable)
    .values({ weekId: wk!.id, factoryId: f!.id, dayOfWeek: warsawDayName(), shift: "1", driverId, kind: "delivery" });

  await sendText(TID, "📅 Мій графік");

  assert.match(sentText(), /DraftFab/, "web-made assignments on the draft week are visible in the bot");
});

test("week selection: a free-typed non-Monday date does not create a bogus week row", opts, async () => {
  await seedDriver({ isHeadDriver: true });
  setState(TID, "hd:select_week", {});

  await sendText(TID, "2099-03-04 (щось вигадане)"); // a Wednesday

  const rows = await db.select().from(scheduleWeeksTable);
  assert.equal(rows.length, 0, "no week row is created for a non-Monday date");
});

test("head driver's week list always offers the current week, even with no week rows at all", opts, async () => {
  await seedDriver({ isHeadDriver: true });

  await sendText(TID, "📋 Призначити водіїв");

  const kb = JSON.stringify(sent.map(s => s.extra?.reply_markup ?? null));
  assert.ok(kb.includes(getCurrentMonday()), "current Monday is offered for assignment");
});
