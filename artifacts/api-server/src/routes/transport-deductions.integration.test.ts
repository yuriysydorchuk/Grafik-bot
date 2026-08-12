import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db,
  workersTable, factoriesTable, driversTable, scheduleWeeksTable, scheduleEntriesTable,
  shiftCancellationsTable, transportDeductionsTable, svodniRowsTable, svodniLocksTable,
} from "../test/harness.ts";

// Платний довіз: авторозрахунок знять (POST /transport/deductions/generate) і
// перенесення сум у колонку Dojazd сводної (POST /svodni/apply-transport-deductions).
// Кількість змін — ЗАВЖДИ з годин сводної: ceil(svodni_rows.hours ÷ тривалість
// 1-ї зміни фабрики); сума = min(зміни × ціна, місячний кап). Виняток —
// self_transport: лише зміни з посадкою водієм (picked_up_by, затверджені
// тижні, без скасованих клітинок).
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const MONTH = "2026-06"; // 2026-06-01 — понеділок

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function opsCookie() {
  await seedRole("ops", ["editData"], ["/transport"]);
  return (await seedAdmin({ role: "ops", name: "Ops" })).cookie;
}

async function seedPaidFactory(over: Record<string, unknown> = {}) {
  const [f] = await db.insert(factoriesTable).values({
    name: "FAB A", paidTransport: true, transportFeePerShift: 20, transportFeeMonthCap: 150,
    shifts: [{ start: "06:00", end: "14:00" }], shiftCount: 1,
    ...over,
  } as any).returning();
  return f!;
}

async function seedWorker(name: string, over: Record<string, unknown> = {}) {
  const [w] = await db.insert(workersTable).values({ fullName: name, ...over } as any).returning();
  return w!;
}

// рядок сводної пари працівник+фабрика — джерело годин для розрахунку
async function seedSvodniHours(workerId: number, factory: { id: number; name: string }, hours: number, over: Record<string, unknown> = {}) {
  await db.insert(svodniRowsTable).values({
    periodMonth: MONTH, city: "Люблін", factoryLabel: factory.name, factoryId: factory.id,
    rawName: `W${workerId}`, workerId, linkStatus: "confirmed",
    hours, extras: {}, hr: {}, sheetValues: {},
    ...over,
  } as any);
}

test("генерація з годин сводної: 40г/8г=5×20=100; 80г=10×20 → кап 150", opts, async () => {
  const fab = await seedPaidFactory();
  const w1 = await seedWorker("JAN PIEC");
  const w2 = await seedWorker("ADAM DZIESIEC");
  await seedSvodniHours(w1.id, fab, 40);  // 5 змін
  await seedSvodniHours(w2.id, fab, 80);  // 10 змін

  const cookie = await opsCookie();
  const res = await request(app).post("/api/transport/deductions/generate").set("Cookie", cookie).set(H).send({ month: MONTH });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 2);

  const rows = await db.select().from(transportDeductionsTable).where(eq(transportDeductionsTable.periodMonth, MONTH));
  const byWorker = new Map(rows.map(r => [r.workerId, r]));
  assert.equal(byWorker.get(w1.id)?.tripsCount, 5);
  assert.equal(byWorker.get(w1.id)?.amount, 100);   // 5 × 20
  assert.equal(byWorker.get(w2.id)?.tripsCount, 10);
  assert.equal(byWorker.get(w2.id)?.amount, 150);   // 10 × 20 = 200 → кап 150
  assert.equal(byWorker.get(w1.id)?.sourceRef, "auto");
});

test("вибірковий платний довіз: список «хто платить» тарифікує лише вибраних; порожній = усі", opts, async () => {
  const fab = await seedPaidFactory();
  const w1 = await seedWorker("PLACI ADAM");
  const w2 = await seedWorker("NIE PLACI EWA");
  await seedSvodniHours(w1.id, fab, 40); // 5 змін
  await seedSvodniHours(w2.id, fab, 40);
  const cookie = await opsCookie();

  // вибрані: лише w1 → w2 не тарифікується
  const putRes = await request(app).put("/api/transport/fee-members").set("Cookie", cookie).set(H)
    .send({ factoryId: fab.id, workerIds: [w1.id] });
  assert.equal(putRes.status, 200);
  const cfg = await request(app).get("/api/transport/fee-members").set("Cookie", cookie);
  assert.deepEqual(cfg.body.factories.find((f: any) => f.factoryId === fab.id).members.map((m: any) => m.workerId), [w1.id]);

  let res = await request(app).post("/api/transport/deductions/generate").set("Cookie", cookie).set(H).send({ month: MONTH });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);
  let rows = await db.select().from(transportDeductionsTable).where(eq(transportDeductionsTable.periodMonth, MONTH));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.workerId, w1.id);
  assert.equal(rows[0]!.amount, 100);

  // кандидати модалки: обидва з годинами, w1 позначений членом
  const cand = await request(app).get(`/api/transport/fee-members/candidates?factoryId=${fab.id}&month=${MONTH}`).set("Cookie", cookie);
  const byId = new Map(cand.body.candidates.map((c: any) => [c.workerId, c]));
  assert.equal((byId.get(w1.id) as any).member, true);
  assert.equal((byId.get(w2.id) as any).member, false);
  assert.equal((byId.get(w2.id) as any).hasHours, true);

  // очистили список → платить уся фабрика, w2 зʼявляється
  await request(app).put("/api/transport/fee-members").set("Cookie", cookie).set(H)
    .send({ factoryId: fab.id, workerIds: [] });
  res = await request(app).post("/api/transport/deductions/generate").set("Cookie", cookie).set(H).send({ month: MONTH });
  assert.equal(res.status, 200);
  rows = await db.select().from(transportDeductionsTable).where(eq(transportDeductionsTable.periodMonth, MONTH));
  assert.equal(rows.length, 2);

  // знову лише w1 → авто-рядок w2 зноситься при перерахунку
  await request(app).put("/api/transport/fee-members").set("Cookie", cookie).set(H)
    .send({ factoryId: fab.id, workerIds: [w1.id] });
  res = await request(app).post("/api/transport/deductions/generate").set("Cookie", cookie).set(H).send({ month: MONTH });
  assert.equal(res.body.deleted, 1);
  rows = await db.select().from(transportDeductionsTable).where(eq(transportDeductionsTable.periodMonth, MONTH));
  assert.deepEqual(rows.map(r => r.workerId), [w1.id]);
});

test("генерація: неціле ділення — округлення вгору; 12-годинна зміна", opts, async () => {
  const fab = await seedPaidFactory({
    name: "FAB B", transportFeePerShift: 10, transportFeeMonthCap: null,
    shifts: [{ start: "06:00", end: "18:00" }], // 12-годинна зміна
  });
  const w4 = await seedWorker("GODZINY DZIEWIEC");
  const w5 = await seedWorker("GODZINY OSIEM");
  await seedSvodniHours(w4.id, fab, 100); // ceil(100/12) = 9
  await seedSvodniHours(w5.id, fab, 90);  // ceil(90/12) = 8

  const cookie = await opsCookie();
  const res = await request(app).post("/api/transport/deductions/generate").set("Cookie", cookie).set(H).send({ month: MONTH });
  assert.equal(res.status, 200);
  const rows = await db.select().from(transportDeductionsTable).where(eq(transportDeductionsTable.periodMonth, MONTH));
  const byWorker = new Map(rows.map(r => [r.workerId, r]));
  assert.equal(byWorker.get(w4.id)?.tripsCount, 9);
  assert.equal(byWorker.get(w4.id)?.amount, 90);
  assert.equal(byWorker.get(w5.id)?.tripsCount, 8);
  assert.equal(byWorker.get(w5.id)?.amount, 80);
});

test("генерація: self_transport — не з годин, а лише зміни з посадкою; скасована клітинка і draft-тиждень — ні", opts, async () => {
  const fab = await seedPaidFactory();
  const [drv] = await db.insert(driversTable).values({ name: "KIEROWCA TEST" } as any).returning();
  const wSelf = await seedWorker("SAM DOJEZDZA", { selfTransport: true });
  // години сводної в self_transport НЕ тарифікуються (80г дали б 10 змін)
  await seedSvodniHours(wSelf.id, fab, 80);
  const [wk1] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-06-01", status: "approved" } as any).returning();
  const entry = (day: string, over: Record<string, unknown> = {}) => db.insert(scheduleEntriesTable).values({
    weekId: wk1!.id, workerId: wSelf.id, factoryId: fab.id, dayOfWeek: day, shift: "1", status: "present", ...over,
  } as any);
  await entry("mon");                          // без посадки — не рахується
  await entry("tue", { pickedUpBy: drv!.id }); // посадка — рахується
  await entry("wed", { pickedUpBy: drv!.id }); // посадка у скасованій клітинці — ні
  await db.insert(shiftCancellationsTable).values({
    weekId: wk1!.id, factoryId: fab.id, dayOfWeek: "wed", shift: "1",
  } as any);
  // посадка у draft-тижні — не рахується (фінансові вибірки approved-only)
  const [draft] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-06-08", status: "draft" } as any).returning();
  await db.insert(scheduleEntriesTable).values({
    weekId: draft!.id, workerId: wSelf.id, factoryId: fab.id, dayOfWeek: "mon", shift: "1",
    status: "present", pickedUpBy: drv!.id,
  } as any);

  const cookie = await opsCookie();
  const res = await request(app).post("/api/transport/deductions/generate").set("Cookie", cookie).set(H).send({ month: MONTH });
  assert.equal(res.status, 200);
  const rows = await db.select().from(transportDeductionsTable).where(eq(transportDeductionsTable.workerId, wSelf.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.tripsCount, 1); // лише вт з посадкою
  assert.equal(rows[0]?.amount, 20);
});

test("повторна генерація: ручні рядки не чіпаються, авто — оновлюються/зносяться", opts, async () => {
  const fab = await seedPaidFactory();
  const w1 = await seedWorker("JAN PIEC");
  const w2 = await seedWorker("ADAM ZNIKAJACY");
  await seedSvodniHours(w1.id, fab, 40);
  await seedSvodniHours(w2.id, fab, 16);

  const cookie = await opsCookie();
  await request(app).post("/api/transport/deductions/generate").set("Cookie", cookie).set(H).send({ month: MONTH });

  // ручна правка суми на авто-рядку → рядок стає manual-edit
  const [row1] = await db.select().from(transportDeductionsTable).where(eq(transportDeductionsTable.workerId, w1.id));
  const patched = await request(app).patch(`/api/transport/deductions/${row1!.id}`).set("Cookie", cookie).set(H).send({ amount: 77 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.sourceRef, "manual-edit");

  // w2 зникає зі сводної → його авто-рядок зноситься; w1 лишається з ручними 77
  await db.delete(svodniRowsTable).where(eq(svodniRowsTable.workerId, w2.id));
  const res2 = await request(app).post("/api/transport/deductions/generate").set("Cookie", cookie).set(H).send({ month: MONTH });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.skippedManual, 1);
  assert.equal(res2.body.deleted, 1);
  const after2 = await db.select().from(transportDeductionsTable).where(eq(transportDeductionsTable.periodMonth, MONTH));
  assert.equal(after2.length, 1);
  assert.equal(after2[0]?.amount, 77);
});

test("перенесення до сводної: Dojazd + перерахунок до виплати + самозвірка; лок і без-рядка — у звіт", opts, async () => {
  const fab = await seedPaidFactory();
  const fabB = await seedPaidFactory({ name: "FAB B" });
  const w1 = await seedWorker("JAN PIEC");
  const w2 = await seedWorker("BEZ WIERSZA");
  const w3 = await seedWorker("POD LOCKIEM");
  // рядок сводної пари w1×FAB A: 160 год × 25 нетто → 20 змін → кап 150
  await seedSvodniHours(w1.id, fab, 160, { rawName: w1.fullName, rateNetto: 25, doWyplaty: 4000 });
  // залочена вкладка FAB B: 100 год → 13 змін → кап 150
  await seedSvodniHours(w3.id, fabB, 100, { rawName: w3.fullName, rateNetto: 25, doWyplaty: 2500 });
  await db.insert(svodniLocksTable).values({ periodMonth: MONTH, city: "Люблін", factoryLabel: "FAB B" } as any);
  // зняття (узгоджені з формулою): w1 → 150 (є рядок), w2 → 60 (рядка нема), w3 → 150 (лок)
  await db.insert(transportDeductionsTable).values([
    { periodMonth: MONTH, workerId: w1.id, factoryId: fab.id, factoryLabel: "FAB A", tripsCount: 20, amount: 150, sourceRef: "auto" },
    { periodMonth: MONTH, workerId: w2.id, factoryId: fab.id, factoryLabel: "FAB A", tripsCount: 3, amount: 60, sourceRef: "auto" },
    { periodMonth: MONTH, workerId: w3.id, factoryId: fabB.id, factoryLabel: "FAB B", tripsCount: 13, amount: 150, sourceRef: "auto" },
  ] as any);

  await seedRole("svodniBase", ["svodni"], ["/svodni"]);
  const cookie = (await seedAdmin({ role: "svodniBase", name: "Svod" })).cookie;
  const res = await request(app).post("/api/svodni/apply-transport-deductions").set("Cookie", cookie).set(H).send({ month: MONTH });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 1);
  assert.equal(res.body.skippedLocked, 1);
  assert.equal(res.body.unmatched.length, 1);
  assert.equal(res.body.unmatched[0].workerName, w2.fullName);
  // самозвірка: записане перечитане і зійшлося
  assert.equal(res.body.verified, 1);
  assert.deepEqual(res.body.verifyMismatches, []);

  const [row] = await db.select().from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.workerId, w1.id), eq(svodniRowsTable.periodMonth, MONTH)));
  assert.equal(row?.dojazd, 150);
  // Люблін: dojazd — відрахування: 160×25 − 150
  assert.equal(row?.doWyplaty, 3850);
  assert.equal(row?.manual, true);
  // залочений рядок не змінився
  const [locked] = await db.select().from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.workerId, w3.id), eq(svodniRowsTable.periodMonth, MONTH)));
  assert.equal(locked?.dojazd, null);
});

test("перед-звірка: сводну перезаповнили після розрахунку → 409 зі списком; force переносить", opts, async () => {
  const fab = await seedPaidFactory();
  const w1 = await seedWorker("JAN PIEC");
  await seedSvodniHours(w1.id, fab, 40, { rawName: w1.fullName, rateNetto: 25 });

  const ops = await opsCookie();
  await request(app).post("/api/transport/deductions/generate").set("Cookie", ops).set(H).send({ month: MONTH }); // 5 змін → 100

  // сводну перезаповнили: годин стало 80 → тепер мало б бути 10 змін → кап 150
  await db.update(svodniRowsTable).set({ hours: 80 }).where(eq(svodniRowsTable.workerId, w1.id));

  await seedRole("svodniBase", ["svodni"], ["/svodni"]);
  const cookie = (await seedAdmin({ role: "svodniBase", name: "Svod" })).cookie;
  const stale = await request(app).post("/api/svodni/apply-transport-deductions").set("Cookie", cookie).set(H).send({ month: MONTH });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.stale.length, 1);
  assert.equal(stale.body.stale[0].expectedShifts, 10);
  // нічого не записалось
  const [rowBefore] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w1.id));
  assert.equal(rowBefore?.dojazd, null);
  // force=true — переносить як є
  const forced = await request(app).post("/api/svodni/apply-transport-deductions").set("Cookie", cookie).set(H).send({ month: MONTH, force: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.updated, 1);
  const [rowAfter] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w1.id));
  assert.equal(rowAfter?.dojazd, 100);
});

test("перенесення однієї фабрики: factoryId зачіпає лише її рядки", opts, async () => {
  const fabA = await seedPaidFactory();
  const fabB = await seedPaidFactory({ name: "FAB B" });
  const w1 = await seedWorker("JAN A");
  const w2 = await seedWorker("JAN B");
  await seedSvodniHours(w1.id, fabA, 40, { rawName: w1.fullName, rateNetto: 25 });   // 5 змін → 100
  await seedSvodniHours(w2.id, fabB, 24, { rawName: w2.fullName, rateNetto: 25 });   // 3 зміни → 60

  const ops = await opsCookie();
  await request(app).post("/api/transport/deductions/generate").set("Cookie", ops).set(H).send({ month: MONTH });

  await seedRole("svodniBase", ["svodni"], ["/svodni"]);
  const cookie = (await seedAdmin({ role: "svodniBase", name: "Svod" })).cookie;
  const res = await request(app).post("/api/svodni/apply-transport-deductions").set("Cookie", cookie).set(H).send({ month: MONTH, factoryId: fabA.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 1);

  const [rowA] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w1.id));
  const [rowB] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w2.id));
  assert.equal(rowA?.dojazd, 100);  // перенесено
  assert.equal(rowB?.dojazd, null); // інша фабрика не зачеплена
});

test("гейти: generate вимагає editData|assignDrivers, apply — cap svodni", opts, async () => {
  await seedRole("svodniOnly", ["svodni"], ["/svodni"]);
  await seedRole("opsOnly", ["editData"], ["/transport"]);
  const svodni = (await seedAdmin({ role: "svodniOnly", name: "S" })).cookie;
  const ops = (await seedAdmin({ role: "opsOnly", name: "O" })).cookie;
  assert.equal((await request(app).post("/api/transport/deductions/generate").set("Cookie", svodni).set(H).send({ month: MONTH })).status, 403);
  assert.equal((await request(app).post("/api/svodni/apply-transport-deductions").set("Cookie", ops).set(H).send({ month: MONTH })).status, 403);
});
