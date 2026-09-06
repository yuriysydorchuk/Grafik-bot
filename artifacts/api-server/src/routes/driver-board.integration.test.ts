import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, closeDb, db, factoriesTable, workersTable, scheduleWeeksTable, scheduleEntriesTable } from "../test/harness.ts";
import { detectPickupGaps } from "../services/pickupGaps.ts";

// Фабрики без довозу (uses_transport=false) не отримують водіїв: вони не мають
// зʼявлятися ні на борді призначень, ні в детекторі прогалин забору.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function seedTwoFactories() {
  const shifts = [{ start: "06:00", end: "14:00" }];
  const [withBus] = await db.insert(factoriesTable).values({ name: "Z DOWOZEM", shiftCount: 1, shifts, usesTransport: true }).returning();
  const [noBus] = await db.insert(factoriesTable).values({ name: "BEZ DOWOZU", shiftCount: 1, shifts, usesTransport: false }).returning();
  const [week] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-07-20", status: "approved" }).returning();
  const workers = await db.insert(workersTable).values([{ fullName: "Adam T" }, { fullName: "Beata T" }]).returning();
  await db.insert(scheduleEntriesTable).values([
    { weekId: week!.id, workerId: workers[0]!.id, factoryId: withBus!.id, dayOfWeek: "mon", shift: "1" },
    { weekId: week!.id, workerId: workers[1]!.id, factoryId: noBus!.id, dayOfWeek: "mon", shift: "1" },
  ]);
  return { withBus: withBus!, noBus: noBus!, week: week! };
}

test("driver-board lists only factories with agency transport", opts, async () => {
  const { withBus } = await seedTwoFactories();
  const { cookie } = await seedAdmin();
  const res = await request(app).get("/api/driver-board?weekStart=2026-07-20").set("Cookie", cookie);
  assert.equal(res.status, 200);
  const names = (res.body.factories as { id: number; name: string }[]).map(f => f.name);
  assert.deepEqual(names, [withBus.name], "фабрика без довозу не має потрапляти на борд");
});

// Хто доїжджає сам — не в headcount (його не везуть), але окремо в selfCount,
// щоб водій розумів, чому на борді менше людей, ніж у списку графіку фабрики.
test("driver-board splits self-transport workers into selfCount", opts, async () => {
  const { withBus, week } = await seedTwoFactories();
  const [selfW] = await db.insert(workersTable).values({ fullName: "Cezary Sam", selfTransport: true }).returning();
  await db.insert(scheduleEntriesTable).values({ weekId: week.id, workerId: selfW!.id, factoryId: withBus.id, dayOfWeek: "mon", shift: "1" });
  const { cookie } = await seedAdmin();
  const res = await request(app).get("/api/driver-board?weekStart=2026-07-20").set("Cookie", cookie);
  assert.equal(res.status, 200);
  const cell = res.body.factories[0].cells.find((c: any) => c.day === "mon" && c.shift === "1");
  assert.equal(cell.headcount, 1, "самотранспортний не рахується до посадки");
  assert.equal(cell.selfCount, 1, "але показується окремо");
});

test("pickup-gap detector ignores factories without agency transport", opts, async () => {
  const { withBus, week } = await seedTwoFactories();
  const gaps = await detectPickupGaps(week.id, "mon");
  assert.deepEqual([...new Set(gaps.map(g => g.factoryId))], [withBus.id], "прогалина лише там, куди возимо");
});
