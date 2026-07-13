import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, svodniRowsTable, workersTable } from "../test/harness.ts";

// Гейти сводних: сторінка — capability `svodni`; закритий шар (księgowość,
// готівка, конто) віддається ЛИШЕ з `svodniSensitive` — перевіряємо фільтрацію
// в самій відповіді API, не в UI. Плюс ручна привʼязка людини до працівника.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function seedRow(over: Record<string, unknown> = {}) {
  await db.insert(svodniRowsTable).values({
    periodMonth: "2026-06", city: "Люблін", firm: "ES", factoryLabel: "TESTOWA",
    rawName: "KOWALSKI JAN", linkStatus: "unmatched",
    hours: 160, rateBrutto: 31.4, rateNetto: 25.35, doWyplaty: 4056,
    hoursDeclared: 100, ksiegBrutto: 3140, ksiegNetto: 2535, gotowka: 1521, konto: 2535,
    extras: {}, hr: {}, sheetValues: {},
    ...over,
  } as any);
}

test("без capability svodni — 403; з нею — 200", opts, async () => {
  await seedRow();
  await seedRole("editor", ["editData"], ["/workers"]);
  const editor = (await seedAdmin({ role: "editor" })).cookie;
  assert.equal((await request(app).get("/api/svodni?month=2026-06").set("Cookie", editor)).status, 403);

  await seedRole("svodniBase", ["svodni"], ["/svodni"]);
  const base = (await seedAdmin({ role: "svodniBase", name: "Base" })).cookie;
  const res = await request(app).get("/api/svodni?month=2026-06").set("Cookie", base);
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 1);
});

test("закритий шар: базовий кап НЕ бачить готівку/księgowość, sensitive і owner — бачать", opts, async () => {
  await seedRow();
  await seedRole("svodniBase", ["svodni"], ["/svodni"]);
  await seedRole("svodniFull", ["svodni", "svodniSensitive"], ["/svodni"]);
  const base = (await seedAdmin({ role: "svodniBase", name: "Base" })).cookie;
  const full = (await seedAdmin({ role: "svodniFull", name: "Full" })).cookie;
  const owner = (await seedAdmin({ role: "owner", name: "Own" })).cookie;

  const rBase = (await request(app).get("/api/svodni?month=2026-06").set("Cookie", base)).body;
  assert.equal(rBase.sensitive, false);
  assert.equal(rBase.rows[0].gotowka, undefined, "готівка не має віддаватись без svodniSensitive");
  assert.equal(rBase.rows[0].ksiegNetto, undefined);
  assert.equal(rBase.rows[0].konto, undefined);
  assert.equal(rBase.rows[0].hours, 160, "відкритий шар (фактичні години) — видно");
  assert.equal(rBase.rows[0].doWyplaty, 4056);

  const rFull = (await request(app).get("/api/svodni?month=2026-06").set("Cookie", full)).body;
  assert.equal(rFull.sensitive, true);
  assert.equal(rFull.rows[0].gotowka, 1521);
  assert.equal(rFull.rows[0].ksiegNetto, 2535);

  const rOwner = (await request(app).get("/api/svodni?month=2026-06").set("Cookie", owner)).body;
  assert.equal(rOwner.rows[0].gotowka, 1521, "owner завжди бачить усе");
});

test("редагування: перерахунок до виплати, manual, sensitive-гейт і фільтрація відповіді", opts, async () => {
  await seedRow();
  await seedRole("svodniBase", ["svodni"], ["/svodni"]);
  await seedRole("svodniFull", ["svodni", "svodniSensitive"], ["/svodni"]);
  const base = (await seedAdmin({ role: "svodniBase", name: "Base" })).cookie;
  const full = (await seedAdmin({ role: "svodniFull", name: "Full" })).cookie;
  const [row] = await db.select().from(svodniRowsTable);

  // базовий кап: редагує години → do wypłaty перераховано (150×25.35 = 3802.5)
  const r1 = await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", base).set(H)
    .send({ field: "hours", value: 150 });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.hours, 150);
  assert.equal(r1.body.doWyplaty, 3802.5);
  assert.equal(r1.body.manual, true);
  assert.equal(r1.body.gotowka, undefined, "відповідь PATCH теж фільтрує закритий шар");

  // чутливе поле без svodniSensitive — 403; з ним — ок
  assert.equal((await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", base).set(H)
    .send({ field: "gotowka", value: 1000 })).status, 403);
  const r2 = await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", full).set(H)
    .send({ field: "ksiegNetto", value: 2000 });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.gotowka, 1802.5, "готівка = до виплати − конто");

  // księgowe години: netto/brutto зі ставок, konto, готівка — як формули таблиці
  const r3 = await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", full).set(H)
    .send({ field: "hoursDeclared", value: 100 });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.ksiegNetto, 2535, "ksiegNetto = 100 × 25.35");
  assert.equal(r3.body.ksiegBrutto, 3140, "ksiegBrutto = 100 × 31.4");
  assert.equal(r3.body.konto, 2535);
  assert.equal(r3.body.gotowka, 1267.5, "готівка = 3802.5 − 2535");

  // невідоме поле не редагується
  assert.equal((await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", full).set(H)
    .send({ field: "workerId", value: 1 })).status, 400);
});

test("реімпорт не перезаписує ручні рядки", opts, async () => {
  const { importSvodniGrids } = await import("../services/svodniSync.ts");
  const grid = new Map<string, unknown[][]>([["TESTOWA", [
    ["", "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto"],
    ["KOWALSKI JAN", "", 160, 31.4, 25.35, 4056],
    ["NOWAK ANNA", "", 100, 31.4, 31.4, 3140],
    ["Suma Godzin", "", 260, "", "", 7196],
  ]]]);
  await importSvodniGrids({ sourceId: null, periodMonth: "2026-06", city: "Люблін", firm: null, grids: grid });
  // ручна правка Kowalski
  const [kowalski] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.rawName, "KOWALSKI JAN"));
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  await request(app).patch(`/api/svodni/rows/${kowalski!.id}`).set("Cookie", owner).set(H)
    .send({ field: "hours", value: 200 });
  // реімпорт: Kowalski (manual) лишається з 200 год, Nowak оновлюється
  await importSvodniGrids({ sourceId: null, periodMonth: "2026-06", city: "Люблін", firm: null, grids: grid });
  const rows = await db.select().from(svodniRowsTable);
  const k = rows.find(r => r.rawName === "KOWALSKI JAN")!;
  assert.equal(rows.filter(r => r.rawName === "KOWALSKI JAN").length, 1, "без дублікатів");
  assert.equal(k.hours, 200, "ручні години пережили реімпорт");
  assert.equal(k.manual, true);
  assert.ok(rows.some(r => r.rawName === "NOWAK ANNA" && !r.manual));
});

test("додавання людини: префіл із профілю; новий — авто-створення профілю; правки синхронізуються назад", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  // наявний працівник із властивостями в профілі
  const [w] = await db.insert(workersTable).values({
    fullName: "Duda Piotr", hourlyRate: 32.9, hourlyRateNetto: 26.55, isStudent: false, birthDate: "2003-05-10",
  }).returning();
  const r1 = await request(app).post("/api/svodni/rows").set("Cookie", owner).set(H)
    .send({ periodMonth: "2026-06", city: "Люблін", factoryLabel: "TESTOWA", workerId: w!.id });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.rawName, "Duda Piotr");
  assert.equal(r1.body.rateBrutto, 32.9, "ставка брутто префілиться з профілю");
  assert.equal(r1.body.rateNetto, 26.55);
  assert.equal(r1.body.under26, true, "до-26 виводиться з дати народження");
  assert.equal(r1.body.manual, true);

  // формули на доданому рядку: години → до виплати
  const r2 = await request(app).patch(`/api/svodni/rows/${r1.body.id}`).set("Cookie", owner).set(H)
    .send({ field: "hours", value: 100 });
  assert.equal(r2.body.doWyplaty, 2655, "100 × 26.55");

  // правка ставки в таблиці → профіль оновлюється (підтягнеться в наступні місяці)
  await request(app).patch(`/api/svodni/rows/${r1.body.id}`).set("Cookie", owner).set(H)
    .send({ field: "rateNetto", value: 27 });
  const [wAfter] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(wAfter!.hourlyRateNetto, 27, "профіль синхронізовано зі сводною");

  // новий працівник: створюється профіль
  const r3 = await request(app).post("/api/svodni/rows").set("Cookie", owner).set(H)
    .send({ periodMonth: "2026-06", city: "Люблін", factoryLabel: "TESTOWA", newWorkerName: "Nowicki Adam" });
  assert.equal(r3.status, 200);
  assert.ok(r3.body.workerId, "новому створено профіль");
  const [nw] = await db.select().from(workersTable).where(eq(workersTable.id, r3.body.workerId));
  assert.equal(nw!.fullName, "Nowicki Adam");
  assert.ok(nw!.workerCode, "код призначено автоматично");

  // видалення рядка
  const r4 = await request(app).delete(`/api/svodni/rows/${r3.body.id}`).set("Cookie", owner).set(H);
  assert.equal(r4.status, 200);
});

test("привʼязка: POST /svodni/link підвʼязує всі рядки імені в місті", opts, async () => {
  await seedRow();
  await seedRow({ periodMonth: "2026-05" }); // та сама людина, інший місяць
  const [w] = await db.insert(workersTable).values({ fullName: "Kowalski Jan" }).returning();
  const owner = (await seedAdmin({ role: "owner" })).cookie;

  const un = (await request(app).get("/api/svodni/unmatched").set("Cookie", owner)).body;
  assert.equal(un.people.length, 1);
  assert.deepEqual(un.people[0].months, ["2026-05", "2026-06"]);

  const link = await request(app).post("/api/svodni/link").set("Cookie", owner).set(H)
    .send({ rawName: "KOWALSKI JAN", city: "Люблін", workerId: w!.id, status: "confirmed" });
  assert.equal(link.status, 200);
  assert.equal(link.body.updated, 2, "обидва місяці підвʼязано");

  const rows = await db.select().from(svodniRowsTable);
  assert.ok(rows.every(r => r.workerId === w!.id && r.linkStatus === "confirmed"));
});
