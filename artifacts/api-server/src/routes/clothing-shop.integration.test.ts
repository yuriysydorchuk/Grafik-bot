import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db,
  workersTable, factoriesTable, clothingItemsTable, clothingStockTable,
  svodniRowsTable, svodniLocksTable, transportDeductionsTable,
} from "../test/harness.ts";

// Магазин одягу: склад (тип/розмір/стан/ціна/кількість) → видача (мінусує
// склад, ціна = «маємо зняти») → повернення (нове стає БУ) → перенесення
// «до зняття» у колонку Odzież сводної (рядок фабрики з найбільшими годинами).
// Плюс: вкладка знять за довіз показує ВСІХ людей платних фабрик (віртуальні
// рядки без нарахування) з маркером self_transport, а генерація знять вирішує
// режим self помісячно за self_transport_since.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const MONTH = "2026-06";

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function opsCookie() {
  await seedRole("ops", ["editData"], ["/clothing"]);
  return (await seedAdmin({ role: "ops", name: "Ops" })).cookie;
}

test("склад → видача: qty-1, запис із ціною/станом; видача з порожнього складу — 400", opts, async () => {
  const cookie = await opsCookie();
  const [w] = await db.insert(workersTable).values({ fullName: "Kowalski Jan" }).returning();

  const created = await request(app).post("/api/clothing/stock").set("Cookie", cookie).set(H)
    .send({ itemType: "boots", size: "42", condition: "new", price: 50, qty: 1 });
  assert.equal(created.status, 200);

  const issued = await request(app).post("/api/clothing/issue").set("Cookie", cookie).set(H)
    .send({ stockId: created.body.id, workerId: w!.id, date: "2026-06-10" });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.price, 50);
  assert.equal(issued.body.condition, "new");
  assert.equal(issued.body.size, "42");
  assert.equal(issued.body.issuedAt, "2026-06-10");
  assert.equal(issued.body.ownership, "sold"); // ціна > 0 → зняти з ЗП

  const [stock] = await db.select().from(clothingStockTable).where(eq(clothingStockTable.id, created.body.id));
  assert.equal(stock!.qty, 0);
  // склад вичерпано → друга видача не проходить
  const again = await request(app).post("/api/clothing/issue").set("Cookie", cookie).set(H)
    .send({ stockId: created.body.id, workerId: w!.id });
  assert.equal(again.status, 400);
});

test("повернення: нова річ вертається на склад БУ-позицією; пропадає з «до зняття»", opts, async () => {
  const cookie = await opsCookie();
  const [w] = await db.insert(workersTable).values({ fullName: "Kowalski Jan" }).returning();
  const stock = (await request(app).post("/api/clothing/stock").set("Cookie", cookie).set(H)
    .send({ itemType: "jacket", size: "L", condition: "new", price: 80, qty: 2 })).body;
  const item = (await request(app).post("/api/clothing/issue").set("Cookie", cookie).set(H)
    .send({ stockId: stock.id, workerId: w!.id })).body;

  const pendingBefore = (await request(app).get("/api/clothing/pending").set("Cookie", cookie)).body;
  assert.equal(pendingBefore.total, 80);

  const ret = await request(app).post(`/api/clothing/${item.id}/return`).set("Cookie", cookie).set(H)
    .send({ date: "2026-06-20" });
  assert.equal(ret.status, 200);
  assert.equal(ret.body.returnedAt, "2026-06-20");
  assert.equal(ret.body.restocked.condition, "used");

  // нова позиція БУ з qty 1; оригінальна лишилась із qty 1 (2−1 видача)
  const rows = await db.select().from(clothingStockTable);
  const used = rows.find(r => r.condition === "used");
  assert.ok(used, "створено БУ-позицію");
  assert.equal(used!.qty, 1);
  assert.equal(used!.itemType, "jacket");
  assert.equal(rows.find(r => r.id === stock.id)?.qty, 1);
  // повторне повернення — 400
  assert.equal((await request(app).post(`/api/clothing/${item.id}/return`).set("Cookie", cookie).set(H).send({})).status, 400);
  // повернене зникло з «до зняття»
  const pendingAfter = (await request(app).get("/api/clothing/pending").set("Cookie", cookie)).body;
  assert.equal(pendingAfter.total, 0);
});

test("перенесення до сводної: Odzież у рядок фабрики з найбільшими годинами; позиції → архів; лок/без-рядка — у звіт", opts, async () => {
  const ops = await opsCookie();
  const [w1] = await db.insert(workersTable).values({ fullName: "Kowalski Jan" }).returning();
  const [w2] = await db.insert(workersTable).values({ fullName: "Bez Wiersza" }).returning();
  const [w3] = await db.insert(workersTable).values({ fullName: "Pod Lockiem" }).returning();
  const [facA] = await db.insert(factoriesTable).values({ name: "FAB A" } as any).returning();
  const [facB] = await db.insert(factoriesTable).values({ name: "FAB B" } as any).returning();
  const seedRow = (workerId: number, fac: { id: number; name: string }, hours: number, over: Record<string, unknown> = {}) =>
    db.insert(svodniRowsTable).values({
      periodMonth: MONTH, city: "Люблін", factoryLabel: fac.name, factoryId: fac.id,
      rawName: `W${workerId}`, workerId, linkStatus: "confirmed",
      hours, rateNetto: 25, doWyplaty: hours * 25, extras: {}, hr: {}, sheetValues: {},
      ...over,
    } as any);
  // w1: дві фабрики — Odzież має лягти у FAB B (більше годин)
  await seedRow(w1!.id, facA!, 40);
  await seedRow(w1!.id, facB!, 120);
  // w3 — під точковим локом FAB A (лок на все місто зачепив би і w1)
  await seedRow(w3!.id, facA!, 80);
  await db.insert(svodniLocksTable).values({ periodMonth: MONTH, city: "Люблін", factoryLabel: "FAB A" } as any);

  // одяг до зняття: w1 дві позиції (30+20), w2 без рядка сводної (60), w3 у залоченій вкладці (40)
  await db.insert(clothingItemsTable).values([
    { workerId: w1!.id, itemType: "boots", price: 30, issuedAt: "2026-06-01" },
    { workerId: w1!.id, itemType: "hat", price: 20, issuedAt: "2026-06-02" },
    { workerId: w2!.id, itemType: "boots", price: 60 },
    { workerId: w3!.id, itemType: "jacket", price: 40 },
  ] as any);

  await seedRole("svodniBase", ["svodni"], ["/svodni"]);
  const cookie = (await seedAdmin({ role: "svodniBase", name: "Svod" })).cookie;
  const res = await request(app).post("/api/svodni/apply-clothing-deductions").set("Cookie", cookie).set(H).send({ month: MONTH });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 1, "лише w1 (w2 без рядка, w3 під локом)");
  assert.equal(res.body.itemsMarked, 2);
  assert.equal(res.body.skippedLocked, 1);
  assert.equal(res.body.unmatched.length, 1);
  assert.deepEqual(res.body.verifyMismatches, []);

  // сума лягла у рядок FAB B (найбільше годин) з перерахунком до виплати
  const rows = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w1!.id));
  const rowB = rows.find(r => r.factoryLabel === "FAB B");
  const rowA = rows.find(r => r.factoryLabel === "FAB A");
  assert.equal(rowB?.odziez, 50);
  assert.equal(rowB?.doWyplaty, 120 * 25 - 50);
  assert.equal(rowA?.odziez, null);
  // позиції w1 позначені «знято» з місяцем і фактичною сумою
  const items = await db.select().from(clothingItemsTable).where(eq(clothingItemsTable.workerId, w1!.id));
  assert.ok(items.every(i => i.deducted && i.deductedMonth === MONTH && i.deductedAmount === i.price));
  // w3 не позначено (вкладка залочена)
  const [w3item] = await db.select().from(clothingItemsTable).where(eq(clothingItemsTable.workerId, w3!.id));
  assert.equal(w3item!.deducted, false);
});

test("зняття за довіз: віртуальні рядки всіх людей платної фабрики + маркер self_transport", opts, async () => {
  const [fab] = await db.insert(factoriesTable).values({
    name: "FAB A", paidTransport: true, transportFeePerShift: 20,
    shifts: [{ start: "06:00", end: "14:00" }], shiftCount: 1,
  } as any).returning();
  const [wSelf] = await db.insert(workersTable).values({ fullName: "Sam Dojezdza", selfTransport: true, selfTransportSince: "2026-05-01" } as any).returning();
  const [wReg] = await db.insert(workersTable).values({ fullName: "Zwykly Jan" }).returning();
  const seedHours = (workerId: number, hours: number) => db.insert(svodniRowsTable).values({
    periodMonth: MONTH, city: "Люблін", factoryLabel: "FAB A", factoryId: fab!.id,
    rawName: `W${workerId}`, workerId, linkStatus: "confirmed", hours, extras: {}, hr: {}, sheetValues: {},
  } as any);
  await seedHours(wSelf!.id, 80);
  await seedHours(wReg!.id, 40);
  // реальний рядок зняття лише у звичайного
  await db.insert(transportDeductionsTable).values({
    periodMonth: MONTH, workerId: wReg!.id, factoryId: fab!.id, factoryLabel: "FAB A",
    tripsCount: 5, amount: 100, sourceRef: "auto",
  } as any);

  const cookie = await opsCookie();
  const res = await request(app).get(`/api/transport/deductions?month=${MONTH}`).set("Cookie", cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 2, "звичайний з нарахуванням + віртуальний рядок self-людини");
  const selfRow = res.body.rows.find((r: any) => r.workerId === wSelf!.id);
  assert.equal(selfRow.id, null, "віртуальний — без id");
  assert.equal(selfRow.amount, null);
  assert.equal(selfRow.hours, 80);
  assert.equal(selfRow.selfTransport, true);
  assert.equal(selfRow.selfTransportSince, "2026-05-01");
  const regRow = res.body.rows.find((r: any) => r.workerId === wReg!.id);
  assert.equal(regRow.amount, 100);
  assert.equal(regRow.selfTransport, false);
});

test("self_transport_since: прапорець увімкнули ПІСЛЯ місяця → місяць рахується як звичайний (з годин)", opts, async () => {
  const [fab] = await db.insert(factoriesTable).values({
    name: "FAB A", paidTransport: true, transportFeePerShift: 20,
    shifts: [{ start: "06:00", end: "14:00" }], shiftCount: 1,
  } as any).returning();
  // з 2026-07-15 доїжджає сам, але рахуємо ЧЕРВЕНЬ → у червні його возили
  const [w] = await db.insert(workersTable).values({
    fullName: "Pozniej Sam", selfTransport: true, selfTransportSince: "2026-07-15",
  } as any).returning();
  await db.insert(svodniRowsTable).values({
    periodMonth: MONTH, city: "Люблін", factoryLabel: "FAB A", factoryId: fab!.id,
    rawName: "W", workerId: w!.id, linkStatus: "confirmed", hours: 40, extras: {}, hr: {}, sheetValues: {},
  } as any);

  const cookie = await opsCookie();
  const res = await request(app).post("/api/transport/deductions/generate").set("Cookie", cookie).set(H).send({ month: MONTH });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1, "у червні ще НЕ self — тарифікується з годин");
  const [row] = await db.select().from(transportDeductionsTable).where(eq(transportDeductionsTable.workerId, w!.id));
  assert.equal(row?.tripsCount, 5);
  assert.equal(row?.amount, 100);
});
