import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, svodniRowsTable, svodniLocksTable, workersTable, factoriesTable, factoryPayoutRulesTable } from "../test/harness.ts";

// Фабричні правила konto/готівки (factory_payout_rules): версійність «діє з»
// (місяць цілком), legacy-фолбек для фабрик без версій, гейти (читання —
// svodniSensitive, запис — viewFinance), перерахунок наявних рядків від місяця
// з повагою локів.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function seedFactory(name = "TESTOWA") {
  const [f] = await db.insert(factoriesTable).values({ name, city: "Люблін" } as any).returning();
  return f!;
}
async function seedWorker(over: Record<string, unknown> = {}) {
  const [w] = await db.insert(workersTable).values({
    fullName: "KOWALSKI JAN", legalStatus: "zus", ...over,
  } as any).returning();
  return w!;
}
// рядок сводної пари: 100 год × 25,35 = 2535, без відрахувань; статус zus →
// legacy на TESTOWA (без стелі) тримає все на конто
async function seedSvodniRow(factoryId: number, workerId: number, month: string, over: Record<string, unknown> = {}) {
  const [r] = await db.insert(svodniRowsTable).values({
    periodMonth: month, city: "Люблін", factoryLabel: "TESTOWA", factoryId,
    rawName: "KOWALSKI JAN", workerId, linkStatus: "confirmed",
    hours: 100, rateBrutto: 31.4, rateNetto: 25.35, doWyplaty: 2535,
    hoursDeclared: 100, ksiegBrutto: 3140, ksiegNetto: 2535, konto: 2535, gotowka: 0,
    extras: {}, hr: {}, sheetValues: {},
    ...over,
  } as any).returning();
  return r!;
}

test("гейти: читання — svodniSensitive, запис — viewFinance", opts, async () => {
  const f = await seedFactory();
  await seedRole("svodniBase", ["svodni"], ["/svodni"]);
  await seedRole("svodniFull", ["svodni", "svodniSensitive"], ["/svodni"]);
  const base = (await seedAdmin({ role: "svodniBase" })).cookie;
  const full = (await seedAdmin({ role: "svodniFull", name: "Full" })).cookie;
  const owner = (await seedAdmin({ role: "owner", name: "Own" })).cookie;

  assert.equal((await request(app).get(`/api/svodni/factory-rules?factoryId=${f.id}`).set("Cookie", base)).status, 403);
  const rFull = await request(app).get(`/api/svodni/factory-rules?factoryId=${f.id}`).set("Cookie", full);
  assert.equal(rFull.status, 200);
  assert.equal(rFull.body.effectiveSource, "legacy");
  // svodniSensitive без viewFinance писати не може
  assert.equal((await request(app).post("/api/svodni/factory-rules").set("Cookie", full).set(H)
    .send({ factoryId: f.id, effectiveFrom: "2026-07-01" })).status, 403);
  assert.equal((await request(app).post("/api/svodni/factory-rules").set("Cookie", owner).set(H)
    .send({ factoryId: f.id, effectiveFrom: "2026-07-01", capH: 60 })).status, 200);
});

test("CRUD + резолюція: версія діє з місяця своєї дати, до неї — legacy", opts, async () => {
  const f = await seedFactory();
  const owner = (await seedAdmin({ role: "owner" })).cookie;

  const created = await request(app).post("/api/svodni/factory-rules").set("Cookie", owner).set(H)
    .send({ factoryId: f.id, effectiveFrom: "2026-07-15", capH: 50, cashBonus: 2, premiaCash: true, stazSteps: [{ days: 30, add: 1 }] });
  assert.equal(created.status, 200);
  // дубль дати — 409
  assert.equal((await request(app).post("/api/svodni/factory-rules").set("Cookie", owner).set(H)
    .send({ factoryId: f.id, effectiveFrom: "2026-07-15" })).status, 409);

  // червень — ще legacy; липень (дата 15-те → місяць цілком) — уже версія
  const june = (await request(app).get(`/api/svodni/factory-rules?factoryId=${f.id}&month=2026-06`).set("Cookie", owner)).body;
  assert.equal(june.effectiveSource, "legacy");
  assert.equal(june.effective.capH, null, "TESTOWA legacy — без стелі");
  const july = (await request(app).get(`/api/svodni/factory-rules?factoryId=${f.id}&month=2026-07`).set("Cookie", owner)).body;
  assert.equal(july.effectiveSource.id, created.body.id);
  assert.equal(july.effective.capH, 50);
  assert.equal(july.effective.premiaCash, true);

  // PATCH міняє поля; DELETE прибирає версію → знову legacy
  const patched = await request(app).patch(`/api/svodni/factory-rules/${created.body.id}`).set("Cookie", owner).set(H)
    .send({ capH: 80 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.capH, 80);
  assert.equal((await request(app).delete(`/api/svodni/factory-rules/${created.body.id}`).set("Cookie", owner).set(H)).status, 200);
  const after1 = (await request(app).get(`/api/svodni/factory-rules?factoryId=${f.id}&month=2026-07`).set("Cookie", owner)).body;
  assert.equal(after1.effectiveSource, "legacy");
});

test("recompute: стеля конто застосовується від місяця версії, попередні місяці не чіпаються", opts, async () => {
  const f = await seedFactory();
  const w = await seedWorker();
  const juneRow = await seedSvodniRow(f.id, w.id, "2026-06");
  const julyRow = await seedSvodniRow(f.id, w.id, "2026-07");
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  await request(app).post("/api/svodni/factory-rules").set("Cookie", owner).set(H)
    .send({ factoryId: f.id, effectiveFrom: "2026-07-01", capH: 50 });

  // impact: лише липневий рядок (червень — legacy, без змін)
  const imp = await request(app).post("/api/svodni/factory-rules/impact").set("Cookie", owner).set(H)
    .send({ factoryId: f.id, fromMonth: "2026-06" });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.rows.length, 1);
  assert.equal(imp.body.rows[0].month, "2026-07");
  assert.equal(imp.body.updated, 0, "impact — dry-run, нічого не пише");

  const rec = await request(app).post("/api/svodni/factory-rules/recompute").set("Cookie", owner).set(H)
    .send({ factoryId: f.id, fromMonth: "2026-06" });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.updated, 1);

  const [june] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, juneRow.id));
  assert.equal(june!.konto, 2535, "червень не зачеплений");
  const [july] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, julyRow.id));
  assert.equal(july!.konto, 1267.5, "конто = 50 год × 25,35");
  assert.equal(july!.hoursDeclared, 50);
  assert.equal(july!.gotowka, 1267.5, "решта готівкою");
});

test("recompute: готівковий бонус — дельта до ставки + facBonus, залочена вкладка пропускається", opts, async () => {
  const f = await seedFactory();
  const w = await seedWorker({ agramCashBonus: true });
  const row7 = await seedSvodniRow(f.id, w.id, "2026-07");
  const row8 = await seedSvodniRow(f.id, w.id, "2026-08");
  await db.insert(svodniLocksTable).values({ periodMonth: "2026-08", city: "Люблін", factoryLabel: "TESTOWA" } as any);
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  await request(app).post("/api/svodni/factory-rules").set("Cookie", owner).set(H)
    .send({ factoryId: f.id, effectiveFrom: "2026-07-01", cashBonus: 2 });

  const rec = await request(app).post("/api/svodni/factory-rules/recompute").set("Cookie", owner).set(H)
    .send({ factoryId: f.id, fromMonth: "2026-07" });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.updated, 1, "оновлено лише незалочений липень");
  assert.equal(rec.body.skippedLocked, 1, "залочений серпень пропущено");

  const [july] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, row7.id));
  assert.equal(july!.rateNetto, 27.35, "ставка = база 25,35 + бонус 2");
  assert.equal((july!.extras as any).facBonus, 2);
  assert.equal(july!.doWyplaty, 2735, "100 год × 27,35");
  assert.equal(july!.konto, 2535, "конто по księgowій парі — бонус готівкою");
  assert.equal(july!.gotowka, 200, "бонус 2 × 100 год налом");
  const [aug] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, row8.id));
  assert.equal(aug!.rateNetto, 25.35, "залочений рядок не змінено");
});
