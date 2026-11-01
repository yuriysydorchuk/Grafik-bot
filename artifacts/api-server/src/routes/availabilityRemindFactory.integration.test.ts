// Нагадування заповнити доступність по одній фабриці (зголошення #4, 01.11.2026):
// factoryId у тілі звужує розсилку до людей цієї фабрики; без нього — усі, хто не заповнив.
// Працівники без Telegram — розсилка нікому не йде, відповідь лише рахує, тож мережі не треба.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, factoriesTable } from "../test/harness.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" };
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("availability/remind: factoryId звужує до однієї фабрики", opts, async () => {
  const owner = await seedAdmin({ role: "owner", isMain: true });
  const [fa] = await db.insert(factoriesTable).values({ name: "AGRAM MOTYCZ" }).returning();
  const [fb] = await db.insert(factoriesTable).values({ name: "LST" }).returning();
  await db.insert(workersTable).values([
    { fullName: "A1", factoryId: fa!.id, isActive: true }, { fullName: "A2", factoryId: fa!.id, isActive: true },
    { fullName: "B1", factoryId: fb!.id, isActive: true },
  ]);
  const week = "2099-03-02";
  const all = await request(app).post("/api/availability/remind").set("Cookie", owner.cookie).set(H).send({ weekStart: week });
  assert.equal(all.status, 200, all.text); assert.equal(all.body.total, 3);
  const one = await request(app).post("/api/availability/remind").set("Cookie", owner.cookie).set(H).send({ weekStart: week, factoryId: fa!.id });
  assert.equal(one.status, 200, one.text); assert.equal(one.body.total, 2, "лише люди AGRAM MOTYCZ");
  assert.equal(one.body.notified, 0);
});
