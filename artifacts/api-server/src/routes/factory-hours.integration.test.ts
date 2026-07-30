import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, closeDb, db, workersTable, factoriesTable, scheduleWeeksTable, scheduleEntriesTable, monthlyReportsTable, factoryHoursTable } from "../test/harness.ts";
import { and, eq } from "drizzle-orm";

// Години з фабрики (звірка з рапортами): ручна клітинка, розбір вставленого
// списку з матчингом імен, масовий upsert із розбивкою по днях, і позмінна
// звірка day-compare (лише коли рапорт = наші підтверджені явки).
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const MONTH = "2026-06"; // 2026-06-01 — понеділок: тиждень цілком у місяці

let owner = "";
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  owner = (await seedAdmin({ role: "owner" })).cookie;
});
after(async () => { if (hasTestDb) await closeDb(); });

async function seedFactoryWorker(name = "Kowalski Jan"): Promise<{ factoryId: number; workerId: number }> {
  const [f] = await db.insert(factoriesTable).values({ name: "TestFab" }).returning({ id: factoriesTable.id });
  const [w] = await db.insert(workersTable).values({ fullName: name, factoryId: f!.id }).returning({ id: workersTable.id });
  return { factoryId: f!.id, workerId: w!.id };
}

// Затверджений тиждень 01–07.06 + present-явки з hoursOverride (щоб не залежати
// від конфігурації змін фабрики): понеділок 8 год + вівторок 8 год = 16.
async function seedAttendance(workerId: number, factoryId: number): Promise<void> {
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-06-01", status: "approved" }).returning({ id: scheduleWeeksTable.id });
  await db.insert(scheduleEntriesTable).values([
    { weekId: wk!.id, workerId, factoryId, dayOfWeek: "mon", shift: "1", status: "present", hoursOverride: 8 },
    { weekId: wk!.id, workerId, factoryId, dayOfWeek: "tue", shift: "1", status: "present", hoursOverride: 8 },
  ]);
}

test("ручна клітинка: set → видно в GET /hours, порожнє значення чистить", opts, async () => {
  const { factoryId, workerId } = await seedFactoryWorker();
  const set = await request(app).post("/api/hours/factory").set("Cookie", owner).set(H)
    .send({ workerId, factoryId, month: MONTH, hours: "123,5" });
  assert.equal(set.status, 200);
  assert.equal(set.body.hours, 123.5);

  const hours = await request(app).get(`/api/hours?month=${MONTH}`).set("Cookie", owner);
  const row = hours.body.workers.find((w: any) => w.workerId === workerId && w.factoryId === factoryId);
  assert.ok(row, "рядок працівник+фабрика має бути в обліку");
  assert.equal(row.factoryHours, 123.5);
  assert.equal(hours.body.totalFactoryHours, 123.5);

  const clear = await request(app).post("/api/hours/factory").set("Cookie", owner).set(H)
    .send({ workerId, factoryId, month: MONTH, hours: null });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.cleared, true);
  const rows = await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.workerId, workerId));
  assert.equal(rows.length, 0);
});

test("factory-parse (текст): імена матчаться по базі, години з комою і HH:MM", opts, async () => {
  const { workerId } = await seedFactoryWorker("Kowalski Jan");
  const res = await request(app).post("/api/hours/factory-parse").set("Cookie", owner).set(H)
    .send({ month: MONTH, text: "Kowalski Jan 168\nNieznany Czlowiek — 40:30" });
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 2);
  const [a, b] = res.body.rows;
  assert.equal(a.workerId, workerId);
  assert.equal(a.hours, 168);
  assert.equal(b.workerId, null); // немає в базі
  assert.equal(b.hours, 40.5);
});

test("factory-apply: upsert із днями → дати YYYY-MM-DD у factoryDays; повторний apply перезаписує", opts, async () => {
  const { factoryId, workerId } = await seedFactoryWorker();
  const apply = await request(app).post("/api/hours/factory-apply").set("Cookie", owner).set(H)
    .send({ month: MONTH, factoryId, source: "excel", rows: [{ workerId, hours: 12, days: { 1: 8, 2: 4 } }] });
  assert.equal(apply.status, 200);
  assert.equal(apply.body.saved, 1);

  const hours = await request(app).get(`/api/hours?month=${MONTH}`).set("Cookie", owner);
  const row = hours.body.workers.find((w: any) => w.workerId === workerId);
  assert.equal(row.factoryHours, 12);
  assert.deepEqual(row.factoryDays, { "2026-06-01": 8, "2026-06-02": 4 });

  // повторний імпорт тієї ж пари — оновлення, не дубль
  const again = await request(app).post("/api/hours/factory-apply").set("Cookie", owner).set(H)
    .send({ month: MONTH, factoryId, source: "paste", rows: [{ workerId, hours: 16, days: { 1: 8, 2: 8 } }] });
  assert.equal(again.body.saved, 1);
  const rows = await db.select().from(factoryHoursTable)
    .where(and(eq(factoryHoursTable.workerId, workerId), eq(factoryHoursTable.month, MONTH)));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hours, 16);
  assert.equal(rows[0]!.source, "paste");
});

test("ручна правка тоталу затирає денну розбивку (вона більше не відповідає сумі)", opts, async () => {
  const { factoryId, workerId } = await seedFactoryWorker();
  await request(app).post("/api/hours/factory-apply").set("Cookie", owner).set(H)
    .send({ month: MONTH, factoryId, rows: [{ workerId, hours: 12, days: { 1: 8, 2: 4 } }] });
  await request(app).post("/api/hours/factory").set("Cookie", owner).set(H)
    .send({ workerId, factoryId, month: MONTH, hours: 20 });
  const [row] = await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.workerId, workerId));
  assert.equal(row!.hours, 20);
  assert.equal(row!.days, null);
});

test("day-compare: рапорт = явки → віддає розбіжні дні; рапорт ≠ явки → мовчить", opts, async () => {
  const { factoryId, workerId } = await seedFactoryWorker();
  await seedAttendance(workerId, factoryId); // явки: 01.06 = 8, 02.06 = 8 (разом 16)
  // рапорт 16 = явки; фабрика каже 12 (02.06 лише 4) → mismatch тоталів + день 02.06
  await db.insert(monthlyReportsTable).values({ workerId, month: MONTH, factoryId, hoursReported: 16 });
  await request(app).post("/api/hours/factory-apply").set("Cookie", owner).set(H)
    .send({ month: MONTH, factoryId, rows: [{ workerId, hours: 12, days: { 1: 8, 2: 4 } }] });

  const cmp = await request(app).get(`/api/hours/day-compare?month=${MONTH}&factoryId=${factoryId}`).set("Cookie", owner);
  assert.equal(cmp.status, 200);
  assert.equal(cmp.body.workers.length, 1);
  assert.equal(cmp.body.workers[0].workerId, workerId);
  assert.deepEqual(cmp.body.workers[0].days, [
    { date: "2026-06-02", our: 8, ourShifts: ["1"], factory: 4 },
  ]);

  // рапорт більше не збігається з явками → днями не аргументуємо
  await db.update(monthlyReportsTable).set({ hoursReported: 20 }).where(eq(monthlyReportsTable.workerId, workerId));
  const cmp2 = await request(app).get(`/api/hours/day-compare?month=${MONTH}&factoryId=${factoryId}`).set("Cookie", owner);
  assert.equal(cmp2.body.workers.length, 0);
});

test("day-compare: збіг тоталів (рапорт = фабрика) → без розбіжностей навіть з днями", opts, async () => {
  const { factoryId, workerId } = await seedFactoryWorker();
  await seedAttendance(workerId, factoryId);
  await db.insert(monthlyReportsTable).values({ workerId, month: MONTH, factoryId, hoursReported: 16 });
  await request(app).post("/api/hours/factory-apply").set("Cookie", owner).set(H)
    .send({ month: MONTH, factoryId, rows: [{ workerId, hours: 16, days: { 1: 8, 2: 8 } }] });
  const cmp = await request(app).get(`/api/hours/day-compare?month=${MONTH}&factoryId=${factoryId}`).set("Cookie", owner);
  assert.equal(cmp.body.workers.length, 0);
});

test("студент до 26 на /hours: вік з дати народження і legalStatus, а не застарілі прапорці", opts, async () => {
  const [f] = await db.insert(factoriesTable).values({ name: "StudFab" }).returning({ id: factoriesTable.id });
  const y = new Date().getFullYear();
  // 23-річний з legalStatus=student, але з НЕвиставленими чекбоксами → пільга діє (нетто = брутто)
  const [young] = await db.insert(workersTable).values({
    fullName: "Young Student", factoryId: f!.id, hourlyRate: 30,
    isStudent: false, under26: false, legalStatus: "student", birthDate: `${y - 23}-01-15`,
  }).returning({ id: workersTable.id });
  // 27-річний із застарілими прапорцями «студент до 26» → пільги вже НЕМАЄ
  const [old] = await db.insert(workersTable).values({
    fullName: "Old Student", factoryId: f!.id, hourlyRate: 30,
    isStudent: true, under26: true, legalStatus: "student", birthDate: `${y - 27}-01-15`,
  }).returning({ id: workersTable.id });
  for (const workerId of [young!.id, old!.id]) {
    await db.insert(monthlyReportsTable).values({ workerId, month: MONTH, factoryId: f!.id, hoursReported: 100 });
  }
  const res = await request(app).get(`/api/hours?month=${MONTH}`).set("Cookie", owner);
  const rowYoung = res.body.workers.find((w: any) => w.workerId === young!.id);
  const rowOld = res.body.workers.find((w: any) => w.workerId === old!.id);
  assert.equal(rowYoung.reportNet, rowYoung.reportGross); // звільнений від внесків
  assert.ok(rowOld.reportNet < rowOld.reportGross, "після 26 внески мають зніматись попри прапорці");
});

test("discrepancy-email: валідація адреси і полів (до SMTP не доходить)", opts, async () => {
  const { factoryId } = await seedFactoryWorker();
  const bad = await request(app).post("/api/hours/discrepancy-email").set("Cookie", owner).set(H)
    .send({ month: MONTH, factoryId, to: "not-an-email", subject: "s", body: "b" });
  assert.equal(bad.status, 400);
  const noSubj = await request(app).post("/api/hours/discrepancy-email").set("Cookie", owner).set(H)
    .send({ month: MONTH, factoryId, to: "client@fab.pl", subject: "", body: "b" });
  assert.equal(noSubj.status, 400);
  // валідний запит без SMTP у тест-оточенні → 500 з людською помилкою, не краш
  const noSmtp = await request(app).post("/api/hours/discrepancy-email").set("Cookie", owner).set(H)
    .send({ month: MONTH, factoryId, to: "client@fab.pl", subject: "s", body: "b", attachWorkerIds: [] });
  assert.equal(noSmtp.status, 500);
  assert.match(noSmtp.body.error ?? "", /SMTP/);
});
