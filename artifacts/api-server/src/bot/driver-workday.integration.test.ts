import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, sendText, pressButton, resetSent, sentText } from "../test/botHarness.ts";
import { driversTable, vehiclesTable, driverWorkdaysTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";

// Driver workday / odometer flow (mileage report), driven through the real bot handlers.
// The reply-keyboard labels are matched via bhears; the km input goes through bot.on("text").
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const TID = "820100";

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

async function seedDriver() {
  const [d] = await db.insert(driversTable).values({ name: "Driver", telegramId: TID, inviteCode: "DRVWORKDAY01", isActive: true }).returning({ id: driversTable.id });
  return d!.id;
}
const openWorkday = (driverId: number) => db.select().from(driverWorkdaysTable).where(eq(driverWorkdaysTable.driverId, driverId));

test("start shift: entering the odometer opens a workday", opts, async () => {
  const driverId = await seedDriver();
  await sendText(TID, "🚗 Почати зміну");
  await sendText(TID, "152 340");            // spaces are stripped

  const rows = await openWorkday(driverId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.odometerStart, 152340);
  assert.equal(rows[0]!.endedAt, null, "workday is open");
});

test("start shift: a non-numeric odometer is rejected, no workday created", opts, async () => {
  const driverId = await seedDriver();
  await sendText(TID, "🚗 Почати зміну");
  resetSent();
  await sendText(TID, "не памʼятаю");
  assert.match(sentText(), /числом|км/i);
  assert.equal((await openWorkday(driverId)).length, 0);
});

test("end shift: closing computes the distance; end < start is rejected", opts, async () => {
  const driverId = await seedDriver();
  const [wd] = await db.insert(driverWorkdaysTable).values({ driverId, workDate: "2099-05-05", startedAt: new Date(), odometerStart: 100000 }).returning({ id: driverWorkdaysTable.id });

  await sendText(TID, "🏁 Закінчити зміну");
  resetSent();
  await sendText(TID, "99000");              // less than start → rejected
  assert.match(sentText(), /не може бути меншим|менш/i);
  assert.equal((await db.select().from(driverWorkdaysTable).where(eq(driverWorkdaysTable.id, wd!.id)))[0]!.endedAt, null);

  await sendText(TID, "100160");             // valid close
  const [closed] = await db.select().from(driverWorkdaysTable).where(eq(driverWorkdaysTable.id, wd!.id));
  assert.equal(closed!.odometerEnd, 100160);
  assert.ok(closed!.endedAt, "workday is closed");
});

test("start shift: an open workday from a PREVIOUS day is auto-closed by the new reading", opts, async () => {
  const driverId = await seedDriver();
  const [stale] = await db.insert(driverWorkdaysTable).values({ driverId, workDate: "2099-05-01", startedAt: new Date(), odometerStart: 90000 }).returning({ id: driverWorkdaysTable.id });

  await sendText(TID, "🚗 Почати зміну");
  await sendText(TID, "90500");

  const [old] = await db.select().from(driverWorkdaysTable).where(eq(driverWorkdaysTable.id, stale!.id));
  assert.equal(old!.odometerEnd, 90500, "the forgotten workday is closed with the new leaving reading");
  const all = await openWorkday(driverId);
  assert.equal(all.filter(w => !w.endedAt).length, 1, "exactly one open workday remains (the new one)");
});

test("vehicle picker attaches the chosen vehicle to the workday", opts, async () => {
  const driverId = await seedDriver();
  const [v] = await db.insert(vehiclesTable).values({ plate: "PO 123AB" }).returning({ id: vehiclesTable.id });

  await sendText(TID, "🚗 Почати зміну");
  await sendText(TID, "200000");
  const [wd] = await openWorkday(driverId);
  await pressButton(TID, `wdveh:${wd!.id}:${v!.id}`);

  const [after] = await db.select().from(driverWorkdaysTable).where(eq(driverWorkdaysTable.id, wd!.id));
  assert.equal(after!.vehicleId, v!.id);
});
