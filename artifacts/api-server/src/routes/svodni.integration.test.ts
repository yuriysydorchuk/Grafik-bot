import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, svodniRowsTable, workersTable, monthlyReportsTable, factoriesTable, companiesTable, positionsTable, factoryPositionsTable, payrollSourcesTable, payrollFactoryMonthsTable, advanceRequestsTable, workerChangesTable } from "../test/harness.ts";

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

// Місто фабрики from-hours бере з історії сводних або з регіону «Зарплат» —
// сідимо мінімальний рядок payroll_factory_months (реєстр + зведення вкладки)
async function seedPayrollRegion(factory: string, region: string) {
  const [src] = await db.insert(payrollSourcesTable).values({
    periodMonth: "2026-05", region, spreadsheetId: `test-${factory}-${region}`,
  } as any).returning();
  await db.insert(payrollFactoryMonthsTable).values({
    sourceId: src!.id, periodMonth: "2026-05", region, factory,
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
  await seedRow({ extras: { kontoH: 100, workListHours: 180 }, hr: { kontoNr: "12 3456 7890", stanowisko: "Lider" } });
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
  assert.equal(rBase.rows[0].extras.kontoH, undefined, "чутливі extras фільтруються");
  assert.equal(rBase.rows[0].extras.workListHours, 180, "відкриті extras — видно");
  assert.equal(rBase.rows[0].hr.kontoNr, undefined, "номер рахунку — лише з sensitive");
  assert.equal(rBase.rows[0].hr.stanowisko, "Lider", "відкриті hr-поля — видно");

  const rFull = (await request(app).get("/api/svodni?month=2026-06").set("Cookie", full)).body;
  assert.equal(rFull.sensitive, true);
  assert.equal(rFull.rows[0].gotowka, 1521);
  assert.equal(rFull.rows[0].ksiegNetto, 2535);
  assert.equal(rFull.rows[0].extras.kontoH, 100);
  assert.equal(rFull.rows[0].hr.kontoNr, "12 3456 7890");

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
  assert.equal((await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", base).set(H)
    .send({ field: "extras.kontoH", value: 50 })).status, 403, "чутливий extra — теж під гейтом");
  assert.equal((await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", base).set(H)
    .send({ field: "hr.kontoNr", value: "11 2222" })).status, 403, "номер рахунку — теж під гейтом");
  const rHr = await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", base).set(H)
    .send({ field: "hr.stanowisko", value: "Brygadzista" });
  assert.equal(rHr.status, 200, "фабричні hr-колонки (Stanowisko/Linia/…) редагуються базовим капом");
  assert.equal(rHr.body.hr.stanowisko, "Brygadzista");
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

test("офісні вкладки і «Додаткові студенти» — лише з svodniSensitive", opts, async () => {
  await seedRow({ factoryLabel: "OFFICE ES", rawName: "OFFICE PERSON", linkStatus: "office" });
  await seedRow({ factoryLabel: "Додаткові студенти", rawName: "OPT STUDENT" });
  await seedRow(); // звичайна фабрика TESTOWA
  await seedRole("svodniBase", ["svodni"], ["/svodni"]);
  await seedRole("svodniFull", ["svodni", "svodniSensitive"], ["/svodni"]);
  const base = (await seedAdmin({ role: "svodniBase", name: "Base" })).cookie;
  const full = (await seedAdmin({ role: "svodniFull", name: "Full" })).cookie;

  const rBase = (await request(app).get("/api/svodni?month=2026-06").set("Cookie", base)).body;
  assert.deepEqual([...new Set(rBase.rows.map((r: any) => r.factoryLabel))], ["TESTOWA"], "спецвкладки приховані без sensitive");

  const rFull = (await request(app).get("/api/svodni?month=2026-06").set("Cookie", full)).body;
  const labels = new Set(rFull.rows.map((r: any) => r.factoryLabel));
  assert.ok(labels.has("OFFICE ES") && labels.has("Додаткові студенти"));

  // додавання в спецвкладку без sensitive — 403
  const deny = await request(app).post("/api/svodni/rows").set("Cookie", base).set(H)
    .send({ periodMonth: "2026-06", city: "Люблін", factoryLabel: "Додаткові студенти", newWorkerName: "X Y" });
  assert.equal(deny.status, 403);
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

test("«Години підтверджені → до сводної»: рядок із профільними даними і формулами; повтор — оновлення", opts, async () => {
  await seedRole("svodniFull", ["svodni", "svodniSensitive"], ["/svodni"]);
  const full = (await seedAdmin({ role: "svodniFull", name: "Full" })).cookie;
  const [w] = await db.insert(workersTable).values({
    fullName: "Kowalski Jan", workerCode: "00001", hourlyRate: 31.4, hourlyRateNetto: 31.4,
    isStudent: true, under26: true, legalStatus: "student", notifyHours: 40, birthDate: "2004-05-05",
  }).returning();
  // місто фабрики відоме із «Зарплат» (регіон вкладки) — сводних ще нема
  const [fac] = await db.insert(factoriesTable).values({ name: "ZAKLAD T" } as any).returning();
  await seedPayrollRegion("ZAKLAD T", "Люблін");
  await db.insert(monthlyReportsTable).values({ workerId: w!.id, month: "2026-05", factoryId: fac!.id, hoursReported: 100 });

  const r1 = await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.created, 1);

  const [row] = await db.select().from(svodniRowsTable);
  assert.equal(row!.workerId, w!.id);
  assert.equal(row!.hours, 100);
  assert.equal(row!.rateNetto, 31.4, "ставка з профілю");
  assert.equal(row!.hoursNotified, 40, "год. повідомлення з профілю");
  assert.equal(row!.doWyplaty, 3140, "формула: години × ставка нетто");
  assert.equal(row!.konto, 3140, "студент до 26 → все на конто");
  assert.equal(row!.gotowka, 0);
  assert.equal(row!.manual, true, "сайт — джерело: синк не перезапише");
  assert.equal((row!.hr as any).dataUrodzenia, "05.05.2004");

  // повторне підтвердження з новими годинами → update, не дубль
  await db.update(monthlyReportsTable).set({ hoursReported: 120 }).where(eq(monthlyReportsTable.workerId, w!.id));
  const r2 = await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });
  assert.equal(r2.body.updated, 1);
  assert.equal(r2.body.created, 0);
  const rows = await db.select().from(svodniRowsTable);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hours, 120);
  assert.equal(rows[0]!.doWyplaty, 3768);
});

test("залічки: from-hours Zaliczka НЕ пише; масове перенесення цілить у фабрику запиту, відміна віднімає", opts, async () => {
  await seedRole("svodniFull", ["svodni", "svodniSensitive"], ["/svodni"]);
  const full = (await seedAdmin({ role: "svodniFull", name: "Full" })).cookie;
  const [w] = await db.insert(workersTable).values({ fullName: "Dwie Fabryki", hourlyRate: 25, hourlyRateNetto: 25 }).returning();
  const [facA] = await db.insert(factoriesTable).values({ name: "FAB A" } as any).returning();
  const [facB] = await db.insert(factoriesTable).values({ name: "FAB B" } as any).returning();
  await seedPayrollRegion("FAB A", "Люблін");
  await seedPayrollRegion("FAB B", "Люблін");
  // A — основна (більше годин), B — друга
  await db.insert(monthlyReportsTable).values([
    { workerId: w!.id, month: "2026-05", factoryId: facA!.id, hoursReported: 120 },
    { workerId: w!.id, month: "2026-05", factoryId: facB!.id, hoursReported: 40 },
  ] as any);
  // виплачені аванси: 400 просили з FAB B (factory_id), 100 — легасі без привʼязки
  const [advB] = await db.insert(advanceRequestsTable).values(
    { workerId: w!.id, factoryId: facB!.id, amount: 400, status: "paid", paidAt: new Date("2026-05-20T12:00:00Z") } as any).returning();
  const [advLegacy] = await db.insert(advanceRequestsTable).values(
    { workerId: w!.id, amount: 100, status: "paid", paidAt: new Date("2026-05-22T12:00:00Z") } as any).returning();

  const r = await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 2);

  // from-hours залічки не чіпає — переносяться окремою масовою дією
  let rows = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w!.id));
  assert.equal(rows.find(x => x.factoryLabel === "FAB A")?.zaliczka, null);
  assert.equal(rows.find(x => x.factoryLabel === "FAB B")?.zaliczka, null);

  const ap = await request(app).post("/api/svodni/apply-zaliczki").set("Cookie", full).set(H).send({ month: "2026-05" });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.updated, 2);
  assert.equal(ap.body.itemsMarked, 2);
  assert.equal(ap.body.verifyMismatches.length, 0);

  rows = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w!.id));
  assert.equal(rows.find(x => x.factoryLabel === "FAB B")?.zaliczka, 400, "аванс із фабрикою запиту — у її рядок");
  assert.equal(rows.find(x => x.factoryLabel === "FAB A")?.zaliczka, 100, "легасі-аванс без привʼязки — у основну фабрику");

  // аванси позначені перенесеними; повторний прогін не задвоює
  const marked = await db.select().from(advanceRequestsTable).where(eq(advanceRequestsTable.workerId, w!.id));
  assert.ok(marked.every(a => a.svodniMonth === "2026-05"));
  const again = await request(app).post("/api/svodni/apply-zaliczki").set("Cookie", full).set(H).send({ month: "2026-05" });
  assert.equal(again.status, 400, "без непереннесених залічок — 400");

  // відміна легасі-авансу: 100 знімається з рядка основної фабрики (A), позначка чиста
  const undo = await request(app).post("/api/svodni/undo-zaliczka").set("Cookie", full).set(H).send({ id: advLegacy!.id });
  assert.equal(undo.status, 200);
  assert.equal(undo.body.subtracted.factoryLabel, "FAB A");
  assert.equal(undo.body.subtracted.newValue, null, "100 − 100 = 0 → клітинка порожня");
  rows = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w!.id));
  assert.equal(rows.find(x => x.factoryLabel === "FAB A")?.zaliczka, null);
  assert.equal(rows.find(x => x.factoryLabel === "FAB B")?.zaliczka, 400, "перенесення B не зачеплене");
  const [legacyFresh] = await db.select().from(advanceRequestsTable).where(eq(advanceRequestsTable.id, advLegacy!.id));
  assert.equal(legacyFresh!.svodniMonth, null);
  void advB;
});

test("from-hours: мінусова виплата M−1 авто-переноситься в ту ж колонку M; ідемпотентно; мінус зник — борг знято", opts, async () => {
  await seedRole("svodniFull", ["svodni", "svodniSensitive"], ["/svodni"]);
  const full = (await seedAdmin({ role: "svodniFull", name: "Full" })).cookie;
  const [w] = await db.insert(workersTable).values({ fullName: "Minusowy Adam", hourlyRate: 31.4, hourlyRateNetto: 25.35, legalStatus: "zus" }).returning();
  const [fac] = await db.insert(factoriesTable).values({ name: "FAB MINUS" } as any).returning();
  await seedPayrollRegion("FAB MINUS", "Люблін");
  // квітень: заробив 20 × 25,35 = 507, аванс 800 → до виплати −293
  const [apr] = await db.insert(svodniRowsTable).values({
    periodMonth: "2026-04", city: "Люблін", factoryLabel: "FAB MINUS", factoryId: fac!.id,
    sortIdx: 0, rawName: "Minusowy Adam", workerId: w!.id, linkStatus: "confirmed", manual: true,
    hours: 20, rateNetto: 25.35, zaliczka: 800, doWyplaty: -293,
    extras: {}, hr: {}, sheetValues: {},
  } as any).returning();
  await db.insert(monthlyReportsTable).values({ workerId: w!.id, month: "2026-05", factoryId: fac!.id, hoursReported: 100 });

  const r = await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });
  assert.equal(r.status, 200);
  assert.equal(r.body.debtCarried?.length, 1, "борг у звіті перенесених");
  const may1 = (await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.periodMonth, "2026-05")))[0]!;
  assert.equal(may1.zaliczka, 293, "борг — у ту ж колонку (Zaliczka)");
  assert.equal(may1.doWyplaty, 100 * 25.35 - 293);
  assert.deepEqual((may1.extras as any).debtIn, { from: "2026-04", cols: { zaliczka: 293 } });
  const aprAfter = (await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, apr!.id)))[0]!;
  assert.deepEqual((aprAfter.extras as any).debtOut, { to: "2026-05", amount: 293 }, "маркер на джерелі");

  // повторний прогін — не задвоює
  await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });
  const may2 = (await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.periodMonth, "2026-05")))[0]!;
  assert.equal(may2.zaliczka, 293, "ідемпотентність: борг не задвоївся");

  // мінус джерела виправили → наступний прогін знімає борг і маркери
  await db.update(svodniRowsTable).set({ zaliczka: 300, doWyplaty: 207 }).where(eq(svodniRowsTable.id, apr!.id));
  await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });
  const may3 = (await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.periodMonth, "2026-05")))[0]!;
  assert.equal(may3.zaliczka, null, "борг знято разом із маркером");
  assert.equal((may3.extras as any).debtIn, undefined);
  const apr3 = (await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, apr!.id)))[0]!;
  assert.equal((apr3.extras as any).debtOut, undefined, "маркер джерела знято");
});

test("from-hours після перейменування фабрики оновлює стару вкладку, не плодить дублікат", opts, async () => {
  await seedRole("svodniFull", ["svodni", "svodniSensitive"], ["/svodni"]);
  const full = (await seedAdmin({ role: "svodniFull", name: "Full" })).cookie;
  const [w] = await db.insert(workersTable).values({
    fullName: "Nowak Piotr", workerCode: "00002", hourlyRate: 31.4, hourlyRateNetto: 25.35,
  }).returning();
  const [fac] = await db.insert(factoriesTable).values({ name: "Scandic Food" } as any).returning();
  await seedPayrollRegion("Scandic Food", "Люблін");
  await db.insert(monthlyReportsTable).values({ workerId: w!.id, month: "2026-05", factoryId: fac!.id, hoursReported: 12 });

  const r1 = await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });
  assert.equal(r1.body.created, 1);

  // фабрику перейменували (КАПС) уже ПІСЛЯ заповнення сводної — кейс Scandic
  // Food → SCANDIC FOOD (08.2026): матч лише по label плодив другу вкладку
  await db.update(factoriesTable).set({ name: "SCANDIC FOOD" }).where(eq(factoriesTable.id, fac!.id));
  await db.update(monthlyReportsTable).set({ hoursReported: 20 }).where(eq(monthlyReportsTable.workerId, w!.id));
  const r2 = await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });
  assert.equal(r2.body.updated, 1);
  assert.equal(r2.body.created, 0, "дублю вкладки немає");
  assert.equal(r2.body.verifyMismatches.length, 0, "самозвірка знаходить рядок під фактичним label");
  const rows = await db.select().from(svodniRowsTable);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hours, 20);
  assert.equal(rows[0]!.factoryLabel, "Scandic Food", "вкладка лишається під своєю назвою");
});

test("from-hours: multi_firm — ОДНА вкладка, фірма в рядку; Sushi ES — конто максимум 80 год", opts, async () => {
  await seedRole("svodniFull", ["svodni", "svodniSensitive"], ["/svodni"]);
  const full = (await seedAdmin({ role: "svodniFull", name: "Full" })).cookie;
  const [es] = await db.insert(companiesTable).values({ name: "ES" } as any).returning();
  const [eso] = await db.insert(companiesTable).values({ name: "ESO" } as any).returning();
  const [fac] = await db.insert(factoriesTable).values({ name: "Sushi&Food Factory", multiFirm: true, usesPositions: true } as any).returning();
  await seedPayrollRegion("Sushi&Food Factory", "Познань");
  // три посади з ОДНАКОВОЮ мінімальною ставкою (Reepack вставлений першим):
  // секція безпосадних — «найдешевша» посада, тай-брейк — алфавіт → Pracownik
  for (const name of ["Reepack", "Skoczek", "Pracownik"]) {
    const [pos] = await db.insert(positionsTable).values({ name }).returning();
    await db.insert(factoryPositionsTable).values({ factoryId: fac!.id, positionId: pos!.id, rate: 31.4, rateNetto: 25.35 });
  }
  const [wEs] = await db.insert(workersTable).values({
    fullName: "Esowy Adam", workerCode: "00011", hourlyRate: 31.4, hourlyRateNetto: 25.35,
    legalStatus: "zus", companyId: es!.id,
  }).returning();
  const [wEso] = await db.insert(workersTable).values({
    fullName: "Esowa Ewa", workerCode: "00012", hourlyRate: 31.4, hourlyRateNetto: 25.35,
    legalStatus: "zus", companyId: eso!.id,
  }).returning();
  await db.insert(monthlyReportsTable).values([
    { workerId: wEs!.id, month: "2026-05", factoryId: fac!.id, hoursReported: 227 },
    { workerId: wEso!.id, month: "2026-05", factoryId: fac!.id, hoursReported: 200 },
  ]);

  const r = await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 2);
  const rows = await db.select().from(svodniRowsTable);
  assert.deepEqual([...new Set(rows.map(x => x.factoryLabel))], ["Sushi&Food Factory"], "вкладка одна, без фірмових суфіксів");
  const rEs = rows.find(x => x.workerId === wEs!.id)!;
  const rEso = rows.find(x => x.workerId === wEso!.id)!;
  assert.equal(rEs.firm, "ES");
  assert.equal(rEso.firm, "ESO");
  assert.equal(rEs.section, "Pracownik", "безпосадний → найдешевша посада, тай-брейк за алфавітом (не Reepack)");
  assert.equal(rEso.section, "Pracownik");
  // ES: конто максимум 80 год × 25.35, решта готівкою
  assert.equal(rEs.hoursDeclared, 80);
  assert.equal(rEs.konto, 2028);
  assert.equal(rEs.gotowka, Math.round((227 * 25.35 - 2028) * 100) / 100);
  // ESO: без стелі — все на конто
  assert.equal(rEso.hoursDeclared, 200);
  assert.equal(rEso.gotowka, 0);

  // legacy-рядок під старою суфіксованою вкладкою: оновлюється, дубля немає
  await db.update(svodniRowsTable).set({ factoryLabel: "Sushi&Food Factory EURO SUPORT" })
    .where(eq(svodniRowsTable.id, rEs.id));
  await db.update(monthlyReportsTable).set({ hoursReported: 100 }).where(eq(monthlyReportsTable.workerId, wEs!.id));
  const r2 = await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });
  assert.equal(r2.body.created, 0, "legacy-вкладка не плодить дубль");
  assert.equal(r2.body.updated, 2);
  const [rEs2] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, rEs.id));
  assert.equal(rEs2!.hours, 100);
  assert.equal(rEs2!.factoryLabel, "Sushi&Food Factory EURO SUPORT", "рядок лишає свій label (переносить міграція)");
  assert.equal(rEs2!.hoursDeclared, 80, "стеля діє й під legacy-назвою (фірма з рядка)");
});

test("from-hours: лок вкладки під СТАРОЮ назвою фабрики теж блокує оновлення", opts, async () => {
  await seedRole("svodniFull", ["svodni", "svodniSensitive"], ["/svodni"]);
  const full = (await seedAdmin({ role: "svodniFull", name: "Full" })).cookie;
  const [w] = await db.insert(workersTable).values({
    fullName: "Wojcik Adam", workerCode: "00003", hourlyRate: 31.4, hourlyRateNetto: 25.35,
  }).returning();
  const [fac] = await db.insert(factoriesTable).values({ name: "Stara Nazwa" } as any).returning();
  await seedPayrollRegion("Stara Nazwa", "Люблін");
  await db.insert(monthlyReportsTable).values({ workerId: w!.id, month: "2026-05", factoryId: fac!.id, hoursReported: 12 });
  await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });

  // лок вкладки, потім повне перейменування фабрики (не лише регістр) —
  // лок-фільтр по поточній назві його не бачить, гард у циклі мусить
  const lock = await request(app).post("/api/svodni/lock").set("Cookie", full).set(H)
    .send({ month: "2026-05", city: "Люблін", factoryLabel: "Stara Nazwa" });
  assert.equal(lock.body.locked, true);
  await db.update(factoriesTable).set({ name: "CALKIEM NOWA" }).where(eq(factoriesTable.id, fac!.id));
  await db.update(monthlyReportsTable).set({ hoursReported: 20 }).where(eq(monthlyReportsTable.workerId, w!.id));
  const r = await request(app).post("/api/svodni/from-hours").set("Cookie", full).set(H).send({ month: "2026-05" });
  assert.equal(r.body.updated, 0, "залочений рядок не оновлюється");
  assert.equal(r.body.created, 0, "і дубль поруч не створюється");
  assert.equal(r.body.skippedLocked, 1);
  const rows = await db.select().from(svodniRowsTable);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hours, 12, "години під локом недоторкані");
});

test("правка «Год. повід.» розписує конто/готівку правилом oświadczenia", opts, async () => {
  // зі статусом Powiadomienie: notify-години йдуть на конто, решта готівкою
  await seedRow({ hoursDeclared: null, ksiegBrutto: null, ksiegNetto: null, gotowka: null, konto: null, isStudent: false, under26: false, extras: { zusStatus: "Zgłoszony, Powiadomienie, Wyżej 26" } });
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const [row] = await db.select().from(svodniRowsTable);
  // 160 год факту, ставка 25.35, до виплати 4056; oświadczenie 100 год
  const r = await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", owner).set(H)
    .send({ field: "hoursNotified", value: 100 });
  assert.equal(r.status, 200);
  assert.equal(r.body.hoursDeclared, 100, "офіційно — години oświadczenia");
  assert.equal(r.body.ksiegNetto, 2535, "конто = 100 × 25.35");
  assert.equal(r.body.konto, 2535);
  assert.equal(r.body.gotowka, 1521, "решта готівкою: 4056 − 2535");
});

test("«Год. повід.» БЕЗ статусу легалізації конто не відкривають — усе готівкою", opts, async () => {
  // правило з червневої звірки: не оформлений/без статусу → все готівкою,
  // навіть якщо колись вписані notify-години
  await seedRow({ hoursDeclared: null, ksiegBrutto: null, ksiegNetto: null, gotowka: null, konto: null, isStudent: false, under26: false });
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const [row] = await db.select().from(svodniRowsTable);
  const r = await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", owner).set(H)
    .send({ field: "hoursNotified", value: 100 });
  assert.equal(r.status, 200);
  assert.equal(r.body.konto, 0, "без статусу конто не відкривається");
  assert.equal(r.body.hoursDeclared, 0);
  assert.equal(r.body.gotowka, 4056, "усе готівкою");
});

test("зміна легалізації оживляє рядок без ставки: нетто з бази фабрики, до виплати і розклад перераховано", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const [fac] = await db.insert(factoriesTable).values({ name: "TESTOWA", rateBrutto: 31.4, rateNetto: 25.35 } as any).returning();
  // профіль без ставок і без форми легалізації; рядок доданий вручну, поки
  // людина була «не оформлена» — нетто-ставки і «до виплати» в ньому нема
  const [w] = await db.insert(workersTable).values({ fullName: "Songe Oscar", isStudent: false, under26: false }).returning();
  await seedRow({
    workerId: w!.id, linkStatus: "confirmed", factoryId: fac!.id,
    hours: 30, rateBrutto: 31.4, rateNetto: null, brutto: 942, doWyplaty: null,
    hoursDeclared: null, ksiegBrutto: null, ksiegNetto: null, gotowka: null, konto: null,
  });
  const [row] = await db.select().from(svodniRowsTable);

  const ap = await request(app).post("/api/svodni/profile-apply").set("Cookie", owner).set(H)
    .send({ workerId: w!.id, from: "2026-06-01", rowIds: [row!.id], changes: { legalStatus: "dyplom" } });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.applied, 1);

  const [r] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, row!.id));
  assert.equal(r!.rateNetto, 25.35, "нетто підставлено з базової пари фабрики");
  assert.equal(r!.doWyplaty, 760.5, "30 × 25.35");
  // dyplom без powiadomienia-годин → усе на конто
  assert.equal(r!.konto, 760.5);
  assert.equal(r!.ksiegNetto, 760.5);
  assert.equal(r!.ksiegBrutto, 942, "конто ÷ нетто × брутто");
  assert.equal(r!.hoursDeclared, 30);
  assert.equal(r!.gotowka, 0);
});

test("затвердження (лок): фабрика і місто блокують правки, toggle знімає", opts, async () => {
  await seedRow();
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const [row] = await db.select().from(svodniRowsTable);

  // лок фабрики → PATCH/DELETE 409
  let r = await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA" });
  assert.equal(r.status, 200);
  assert.equal(r.body.locked, true);
  r = await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", owner).set(H)
    .send({ field: "hours", value: 100 });
  assert.equal(r.status, 409, "правка залоченої фабрики має відхилятись");
  assert.equal((await request(app).delete(`/api/svodni/rows/${row!.id}`).set("Cookie", owner).set(H)).status, 409);
  // GET віддає лок
  const g = await request(app).get("/api/svodni?month=2026-06").set("Cookie", owner);
  assert.deepEqual(g.body.locks, [{ city: "Люблін", factoryLabel: "TESTOWA" }]);

  // повторний виклик — розлочує, правка проходить
  r = await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA" });
  assert.equal(r.body.locked, false);
  r = await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", owner).set(H)
    .send({ field: "hours", value: 100 });
  assert.equal(r.status, 200);

  // лок цілого міста ("" = місто) блокує будь-яку фабрику міста
  await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін" });
  r = await request(app).patch(`/api/svodni/rows/${row!.id}`).set("Cookie", owner).set(H)
    .send({ field: "hours", value: 120 });
  assert.equal(r.status, 409, "лок міста накриває всі його фабрики");
  // додавання людини в залочену фабрику — теж 409
  r = await request(app).post("/api/svodni/rows").set("Cookie", owner).set(H)
    .send({ periodMonth: "2026-06", city: "Люблін", factoryLabel: "TESTOWA", newWorkerName: "Nowak Piotr", force: true });
  assert.equal(r.status, 409);
});

test("ревʼю при розблокуванні: lock-pending бачить зміни під локом, unlock застосовує прийняті", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const [w] = await db.insert(workersTable).values({
    fullName: "Kowalski Jan", hourlyRate: 31.4, hourlyRateNetto: 25.35, isStudent: false, under26: false,
  }).returning();
  await seedRow({ workerId: w!.id, linkStatus: "confirmed", isStudent: false, under26: false });

  // затвердили вкладку → зміна профілю (студент + дата народження) в неї не потрапляє
  await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA" });
  const ap = await request(app).post("/api/svodni/profile-apply").set("Cookie", owner).set(H)
    .send({ workerId: w!.id, from: "2026-06-01", rowIds: [], changes: { legalStatus: "student", birthDate: "2004-05-05" } });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.skippedLocked.length, 1, "залочена область зафіксована в журналі");
  const [rowBefore] = await db.select().from(svodniRowsTable);
  assert.equal(rowBefore!.isStudent, false, "залочений рядок не змінився");

  // lock-pending: обидві зміни в списку, з дифами по нашому рядку
  const p = await request(app).post("/api/svodni/lock-pending").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA" });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.changes.map((c: any) => c.field).sort(), ["birthDate", "legalStatus"]);
  assert.ok(p.body.changes.every((c: any) => c.propagatable && c.workerName === "Kowalski Jan"));
  assert.ok(p.body.changes.some((c: any) => c.items?.some((it: any) => it.diffs.length)), "превʼю має дифи рядка");

  // розблокування з прийняттям обох змін → рядок перерахований як студент до 26
  const ids = p.body.changes.map((c: any) => c.id);
  const un = await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA", applyChangeIds: ids });
  assert.equal(un.status, 200);
  assert.equal(un.body.locked, false);
  assert.equal(un.body.applied, 1, "один рядок області оновлено");
  const [row] = await db.select().from(svodniRowsTable);
  assert.equal(row!.isStudent, true);
  assert.equal(row!.under26, true);
  assert.equal(row!.rateNetto, 31.4, "студент до 26: нетто = брутто");
  assert.equal(row!.doWyplaty, 5024, "160 × 31.4");
  assert.equal(row!.konto, 5024, "студент до 26 → все на конто");
  assert.equal(row!.gotowka, 0);
  // журнал: прийнята зміна отримала appliedRows, скоуп зник зі skippedLocked
  const changes = await db.select().from(workerChangesTable);
  assert.ok(changes.every(c => (c.appliedRows as any[])?.length === 1 && c.skippedLocked == null));
});

test("ревʼю при розблокуванні: відхилення лишає рядок як є; повторний лок не докучає старими змінами", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const [w] = await db.insert(workersTable).values({
    fullName: "Nowak Anna", hourlyRate: 31.4, hourlyRateNetto: 25.35, isStudent: false, under26: false,
  }).returning();
  await seedRow({ workerId: w!.id, linkStatus: "confirmed", isStudent: false, under26: false });
  await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA" });
  await request(app).post("/api/svodni/profile-apply").set("Cookie", owner).set(H)
    .send({ workerId: w!.id, from: "2026-06-01", rowIds: [], changes: { legalStatus: "student", birthDate: "2004-05-05" } });

  // розблокування БЕЗ прийняття (усі відхилені) → рядок недоторканий
  const un = await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA", applyChangeIds: [] });
  assert.equal(un.body.applied, 0);
  const [row] = await db.select().from(svodniRowsTable);
  assert.equal(row!.isStudent, false, "відхилена зміна рядок не чіпає");
  assert.equal(row!.rateNetto, 25.35);

  // повторний лок → у ревʼю лише зміни ПІСЛЯ нового локу (старі відхилені не вертаються)
  await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA" });
  const p2 = await request(app).post("/api/svodni/lock-pending").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA" });
  assert.equal(p2.body.changes.length, 0, "старі відхилені зміни не показуються знову");
  // незалочена область — 400
  const bad = await request(app).post("/api/svodni/lock-pending").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "INNA" });
  assert.equal(bad.status, 400);
});

test("ревʼю при розблокуванні: незастосовані зміни, зроблені ДО поточного лока, теж у списку (дірка перелочування)", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const [w] = await db.insert(workersTable).values({
    fullName: "Sadovyi Kyryl", hourlyRate: 31.4, hourlyRateNetto: 25.35, isStudent: false, under26: false,
  }).returning();
  await seedRow({ workerId: w!.id, linkStatus: "confirmed", isStudent: false, under26: false });

  // зміна профілю БЕЗ застосування до рядків, поки область ще НЕ залочена
  // (аналог бекфілу: журнал є, appliedRows порожній) → потім область лочать
  await request(app).post("/api/svodni/profile-apply").set("Cookie", owner).set(H)
    .send({ workerId: w!.id, from: "2026-06-01", rowIds: [], changes: { legalStatus: "student", birthDate: "2004-05-05" } });
  await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA" });

  // старий критерій (createdAt > lockedAt) дав би 0 — зміни старіші за лок.
  // birthDate у списку НЕМАЄ свідомо: freezeUnder26AtLock при встановленні
  // лока вже проставив рядку under26 — залишкового ефекту нуль, показувати
  // нічого; весь грошовий ефект (студентська ставка) несе legalStatus.
  const p = await request(app).post("/api/svodni/lock-pending").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA" });
  assert.deepEqual(p.body.changes.map((c: any) => c.field), ["legalStatus"],
    "незастосована до-локова зміна з реальним дифом показується");
  assert.ok(p.body.changes.every((c: any) => c.items?.some((it: any) => it.diffs.length)), "лише з реальними дифами");

  // прийняття при розлоку → рядок студентський, журнал накритий appliedRows
  const un = await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA", applyChangeIds: p.body.changes.map((c: any) => c.id) });
  assert.equal(un.body.applied, 1);
  const [row] = await db.select().from(svodniRowsTable);
  assert.equal(row!.isStudent, true);
  assert.equal(row!.rateNetto, 31.4, "студент до 26: нетто = брутто");

  // повторний цикл лок→ревʼю: застосоване в цю область більше не вертається
  await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA" });
  const p2 = await request(app).post("/api/svodni/lock-pending").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "TESTOWA" });
  assert.equal(p2.body.changes.length, 0);
});

test("from-hours пропускає залочену фабрику і рахує skippedLocked", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  // працівник з рапортом за місяць — джерело годин для from-hours
  const [w] = await db.insert(workersTable).values({
    fullName: "Testowy Adam", hourlyRate: 31.4, hourlyRateNetto: 25.35, isStudent: false, under26: false,
  } as any).returning();
  const facRes = await request(app).post("/api/factories").set("Cookie", owner).set(H)
    .send({ name: "ZAKLAD X" });
  const facId = facRes.body.id ?? (facRes.body.factory?.id);
  await seedPayrollRegion("ZAKLAD X", "Люблін"); // місто — з регіону «Зарплат»
  await db.insert(monthlyReportsTable).values({ workerId: w!.id, month: "2026-06", factoryId: facId, hoursReported: 100 } as any);

  // без лока — рядок створюється
  let r = await request(app).post("/api/svodni/from-hours").set("Cookie", owner).set(H)
    .send({ month: "2026-06", factoryId: facId });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 1);

  // лок фабрики → повторний from-hours цієї фабрики не проходить
  await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "ZAKLAD X" });
  r = await request(app).post("/api/svodni/from-hours").set("Cookie", owner).set(H)
    .send({ month: "2026-06", factoryId: facId });
  assert.equal(r.status, 400, "усе вибране залочено → 400 з поясненням");
});

test("from-hours: фабрика без міста (нема ні в сводних, ні в Зарплатах) — пропуск і чесний звіт, не Люблін", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const [w] = await db.insert(workersTable).values({
    fullName: "Nowak Piotr", hourlyRate: 31.4, hourlyRateNetto: 25.35, isStudent: false, under26: false,
  } as any).returning();
  const [known] = await db.insert(factoriesTable).values({ name: "ZNANA" } as any).returning();
  const [unknown] = await db.insert(factoriesTable).values({ name: "TAJEMNICZA" } as any).returning();
  await seedPayrollRegion("ZNANA", "Познань");
  await db.insert(monthlyReportsTable).values({ workerId: w!.id, month: "2026-06", factoryId: known!.id, hoursReported: 50 } as any);

  // лише невідома фабрика → 400 зі списком, рядки не створюються
  const [w2] = await db.insert(workersTable).values({
    fullName: "Wisniewski Adam", hourlyRate: 31.4, hourlyRateNetto: 25.35, isStudent: false, under26: false,
  } as any).returning();
  await db.insert(monthlyReportsTable).values({ workerId: w2!.id, month: "2026-06", factoryId: unknown!.id, hoursReported: 60 } as any);
  const solo = await request(app).post("/api/svodni/from-hours").set("Cookie", owner).set(H)
    .send({ month: "2026-06", factoryId: unknown!.id });
  assert.equal(solo.status, 400);
  assert.match(solo.body.error, /TAJEMNICZA/, "помилка називає фабрику без міста");

  // весь місяць: відома створюється з містом із Зарплат, невідома — у noCity
  const r = await request(app).post("/api/svodni/from-hours").set("Cookie", owner).set(H)
    .send({ month: "2026-06" });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 1);
  assert.deepEqual(r.body.noCity, ["TAJEMNICZA"]);
  const rows = await db.select().from(svodniRowsTable);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.city, "Познань", "місто взято з регіону «Зарплат», не фолбек-Люблін");
});

test("from-hours: вибір джерела годин (reports/factory) і самозвірка verified", opts, async () => {
  const { factoryHoursTable } = await import("../test/harness.ts");
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const [w] = await db.insert(workersTable).values({
    fullName: "Nowak Piotr", workerCode: "00002", hourlyRate: 30, hourlyRateNetto: 25,
  }).returning();
  const [fac] = await db.insert(factoriesTable).values({ name: "ZAKLAD Z" } as any).returning();
  await seedPayrollRegion("ZAKLAD Z", "Люблін");
  // рапорт працівника: 100 год; години з фабрики (евіденція): 90 год
  await db.insert(monthlyReportsTable).values({ workerId: w!.id, month: "2026-05", factoryId: fac!.id, hoursReported: 100 });
  await db.insert(factoryHoursTable).values({ workerId: w!.id, month: "2026-05", factoryId: fac!.id, hours: 90, source: "excel" });

  // джерело «години з фабрики» → у сводній РІВНО 90, самозвірка чиста
  const rf = await request(app).post("/api/svodni/from-hours").set("Cookie", owner).set(H)
    .send({ month: "2026-05", source: "factory" });
  assert.equal(rf.status, 200);
  assert.equal(rf.body.created, 1);
  assert.equal(rf.body.verified, 1, "самозвірка перевірила записаний рядок");
  assert.deepEqual(rf.body.verifyMismatches, [], "передані години = години в сводній");
  let rows = await db.select().from(svodniRowsTable);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hours, 90, "узято години фабрики, не рапорт");

  // рапорт із НУЛЕМ: джерело авторитетне — у сводну їде РІВНО 0 год
  // (кейс Samushonga 06.2026; модалка попереджає про такі рядки до перенесення)
  const [wz] = await db.insert(workersTable).values({ fullName: "Zerowy Raport", workerCode: "00003" }).returning();
  await db.insert(monthlyReportsTable).values({ workerId: wz!.id, month: "2026-05", factoryId: fac!.id, hoursReported: 0 });

  // джерело «рапорти працівників» (дефолт) → оновлення тим самим рядком на 100
  const rr = await request(app).post("/api/svodni/from-hours").set("Cookie", owner).set(H)
    .send({ month: "2026-05", source: "reports" });
  assert.equal(rr.body.updated, 1);
  assert.deepEqual(rr.body.verifyMismatches, []);
  rows = await db.select().from(svodniRowsTable);
  assert.equal(rows.length, 2, "0-рапорт теж переноситься — окремим рядком");
  const main = rows.find(r => r.workerId === w!.id)!;
  assert.equal(main.hours, 100, "узято рапорт працівника");
  assert.equal(main.doWyplaty, 2500, "виплата перерахована: 100 × 25 нетто");
  const zero = rows.find(r => r.workerId === wz!.id)!;
  assert.equal(zero.hours, 0, "джерело авторитетне: 0 з рапорту = 0 у сводній");
  assert.deepEqual(rr.body.verifyMismatches, [], "самозвірка бачить і 0-рядок");

  // workerIds звужує скоуп до людей видимої вкладки (фірмові вкладки, сміттєві
  // пари поза списком) — переноситься лише хто в списку
  const rw = await request(app).post("/api/svodni/from-hours").set("Cookie", owner).set(H)
    .send({ month: "2026-05", source: "reports", workerIds: [w!.id] });
  assert.equal(rw.body.workers, 1, "лише людина зі списку workerIds");
});
