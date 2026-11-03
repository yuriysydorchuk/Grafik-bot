// Посада людини ПО ФАБРИЦІ (зголошення #12, 03.11.2026): Pracownik на основній фабриці A, Wózkowy на додатковій B.
// Профіль, облік годин, сводна (новий рядок, profile-apply, відкат), умова й журнал беруть посаду ФАБРИКИ,
// без власного значення — профільну (як до 03.11).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, factoriesTable, positionsTable, factoryPositionsTable, workerChangesTable, svodniRowsTable, scheduleWeeksTable, scheduleEntriesTable } from "../test/harness.ts";
import { workerFactoriesTable, workerFactoryPositionsTable } from "@workspace/db";
import { buildContractData } from "../services/contracts.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" };
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("посада по фабриці: профіль, облік годин, сводна, profile-apply + відкат, умова, журнал", opts, async () => {
  const owner = (await seedAdmin({ role: "owner", isMain: true })).cookie;
  const [fa] = await db.insert(factoriesTable).values({ name: "FAB A", city: "Люблін", usesPositions: true } as any).returning();
  const [fb] = await db.insert(factoriesTable).values({ name: "FAB B", city: "Люблін", usesPositions: true } as any).returning();
  const [p1] = await db.insert(positionsTable).values({ name: "Pracownik" }).returning();
  const [p2] = await db.insert(positionsTable).values({ name: "Wózkowy" }).returning();
  await db.insert(factoryPositionsTable).values([
    { factoryId: fa!.id, positionId: p1!.id, rate: 31.4, rateNetto: 25.35 },
    { factoryId: fb!.id, positionId: p1!.id, rate: 31.4, rateNetto: 25.35 },
    { factoryId: fb!.id, positionId: p2!.id, rate: 35, rateNetto: 28 },
  ]);
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Wozny", factoryId: fa!.id, positionId: p1!.id, legalStatus: "dyplom", birthDate: "1990-01-01", isActive: true } as any).returning();
  await db.insert(workerFactoriesTable).values({ workerId: w!.id, factoryId: fb!.id } as any);

  // 1) посада на фабриці B — прямий ендпойнт + журнал з фабрикою
  const put = await request(app).put(`/api/workers/${w!.id}/factory-position`).set("Cookie", owner).set(H).send({ factoryId: fb!.id, positionId: p2!.id });
  assert.equal(put.status, 200, put.text);
  const [jr] = await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, w!.id), eq(workerChangesTable.field, "positionId")));
  assert.equal(jr!.factoryId, fb!.id); assert.equal(jr!.newValue, String(p2!.id));

  // 2) профіль: A — профільна (own=false), B — своя
  const prof = (await request(app).get(`/api/workers/${w!.id}`).set("Cookie", owner)).body;
  const byF = new Map(prof.positionsByFactory.map((r: any) => [r.factoryId, r]));
  assert.deepEqual([(byF.get(fa!.id) as any).positionId, (byF.get(fa!.id) as any).own], [p1!.id, false]);
  assert.deepEqual([(byF.get(fb!.id) as any).positionId, (byF.get(fb!.id) as any).own], [p2!.id, true]);

  // 3) облік годин: явка на B → ставка посади B (35), на A — посада профілю (31.4)
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-06-01", status: "approved" }).returning();
  await db.insert(scheduleEntriesTable).values([
    { weekId: wk!.id, workerId: w!.id, factoryId: fb!.id, dayOfWeek: "mon", shift: "1", status: "present" },
    { weekId: wk!.id, workerId: w!.id, factoryId: fa!.id, dayOfWeek: "tue", shift: "1", status: "present" },
  ] as any);
  const hrs = (await request(app).get("/api/hours?month=2026-06").set("Cookie", owner)).body.workers.filter((x: any) => x.workerId === w!.id);
  assert.equal(hrs.find((x: any) => x.factoryId === fb!.id)?.rate, 35, "ставка посади на B");
  assert.equal(hrs.find((x: any) => x.factoryId === fa!.id)?.rate, 31.4, "ставка профільної посади на A");

  // 4) сводна: новий рядок B — секція й ставка Wózkowy; A — Pracownik
  const addB = await request(app).post("/api/svodni/rows").set("Cookie", owner).set(H).send({ periodMonth: "2026-06", city: "Люблін", factoryLabel: "FAB B", workerId: w!.id });
  assert.equal(addB.status, 200, addB.text);
  assert.equal(addB.body.section, "Wózkowy"); assert.equal(addB.body.rateBrutto, 35);
  const addA = await request(app).post("/api/svodni/rows").set("Cookie", owner).set(H).send({ periodMonth: "2026-06", city: "Люблін", factoryLabel: "FAB A", workerId: w!.id });
  assert.equal(addA.body.section, "Pracownik"); assert.equal(addA.body.rateBrutto, 31.4);

  // 5) умова: {%Stanowisko%} — посада фабрики умови
  assert.equal((await buildContractData(w!.id, fb!.id))["Stanowisko"], "Wózkowy");
  assert.equal((await buildContractData(w!.id, fa!.id))["Stanowisko"], "Pracownik");

  // 6) profile-apply: B «як основна» → рядок B секція Pracownik; рядок A не чіпається; рядок пари зник
  const apply = await request(app).post("/api/svodni/profile-apply").set("Cookie", owner).set(H)
    .send({ workerId: w!.id, from: "2026-06-01", rowIds: [addB.body.id, addA.body.id], changes: { positionByFactory: { [fb!.id]: null } } });
  assert.equal(apply.status, 200, apply.text);
  assert.equal(apply.body.applied, 1, "лише рядок фабрики B");
  const rowB = (await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, addB.body.id)))[0]!;
  assert.equal(rowB.section, "Pracownik");
  assert.equal((await db.select().from(workerFactoryPositionsTable).where(eq(workerFactoryPositionsTable.workerId, w!.id))).length, 0);
  const [w2] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(w2!.positionId, p1!.id, "профільна посада не змінилась");
  const jApply = (await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, w!.id), eq(workerChangesTable.field, "positionId"))))
    .find(j => j.newValue == null && j.factoryId === fb!.id);
  assert.ok(jApply, "журнал по фабриці B");

  // 7) відкат: посада B повертається, рядок B знову Wózkowy
  const undo = await request(app).delete(`/api/svodni/profile-change/${jApply!.id}`).set("Cookie", owner).set(H);
  assert.equal(undo.status, 200, undo.text);
  const [back] = await db.select().from(workerFactoryPositionsTable).where(eq(workerFactoryPositionsTable.workerId, w!.id));
  assert.equal(back?.positionId, p2!.id);
  assert.equal((await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, addB.body.id)))[0]!.section, "Wózkowy");

  // 8) каталог: посаду, задану людині на фабриці, не видалити
  assert.equal((await request(app).delete(`/api/positions/${p2!.id}`).set("Cookie", owner).set(H)).status, 400);
});
