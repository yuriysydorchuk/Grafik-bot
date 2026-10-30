// Експорт конкретних працівників (`ids`, зголошення #2 30.10.2026): пачка вибраних незалежно від
// режиму active/fired; решта фільтрів звужує пачку.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, factoriesTable } from "../test/harness.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("export preview: ids обмежує список; звільнений у пачці теж іде; фільтр фабрики звужує пачку", opts, async () => {
  const owner = await seedAdmin({ role: "owner", isMain: true });
  const [fa] = await db.insert(factoriesTable).values({ name: "LST" }).returning();
  const [fb] = await db.insert(factoriesTable).values({ name: "ALMIZ" }).returning();
  const ws = await db.insert(workersTable).values([
    { fullName: "Adam A", factoryId: fa!.id, isActive: true }, { fullName: "Bogdan B", factoryId: fb!.id, isActive: true },
    { fullName: "Cezary C", factoryId: fa!.id, isActive: false, status: "fired" }, { fullName: "Dawid D", factoryId: fa!.id, isActive: true },
  ]).returning();
  const names = async (qs: string) => { const r = await request(app).get(`/api/workers/export/preview?cols=fullName&${qs}`).set("Cookie", owner.cookie); assert.equal(r.status, 200, r.text); return r.body.rows.map((x: any[]) => String(x[0]).toUpperCase()).sort(); }; // імена в експорті — капсом (nameCaps)
  assert.deepEqual(await names("mode=active"), ["ADAM A", "BOGDAN B", "DAWID D"]);
  assert.deepEqual(await names(`mode=active&ids=${ws[0]!.id},${ws[2]!.id}`), ["ADAM A", "CEZARY C"], "звільнений у пачці експортується попри mode=active");
  assert.deepEqual(await names(`mode=all&ids=${ws[0]!.id},${ws[1]!.id}&factoryIds=${fa!.id}`), ["ADAM A"], "фільтр фабрики звужує пачку");
  assert.deepEqual(await names("mode=all&ids=999999"), []);
});
