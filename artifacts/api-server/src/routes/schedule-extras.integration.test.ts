import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import ExcelJS from "exceljs";
import {
  app, hasTestDb, resetDb, seedAdmin, closeDb, db,
  factoriesTable, workersTable, scheduleWeeksTable, scheduleEntriesTable,
  factoryShiftOverridesTable, monthlyReportsTable, factoryHoursTable,
} from "../test/harness.ts";
import { eq, and } from "drizzle-orm";

// Разові зміни (factory_shift_overrides), Excel обліку годин з вибором колонок
// і виправдання/штрафи відсутностей — регресійні тести на реальні звіти власника.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

// Гарантований понеділок у майбутньому (entryCellForDate рахує понеділок від дати)
const WEEK = (() => {
  const d = new Date("2099-02-01T00:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
const MONTH = WEEK.slice(0, 7);

let cookie = "";
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  cookie = (await seedAdmin({ role: "owner" })).cookie;
});
after(async () => { if (hasTestDb) await closeDb(); });

async function mkFactory(): Promise<number> {
  const [f] = await db.insert(factoriesTable).values({
    name: "F", shiftCount: 2,
    shifts: [{ start: "06:00", end: "14:00" }, { start: "14:00", end: "22:00" }],
  }).returning({ id: factoriesTable.id });
  return f!.id;
}
async function mkWorker(factoryId: number, name = "W"): Promise<number> {
  const [w] = await db.insert(workersTable).values({ fullName: name, factoryId }).returning({ id: workersTable.id });
  return w!.id;
}
async function mkApprovedWeek(): Promise<number> {
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: WEEK, status: "approved" }).returning({ id: scheduleWeeksTable.id });
  return wk!.id;
}
async function mkEntry(weekId: number, workerId: number, factoryId: number, shift: string, status = "scheduled"): Promise<number> {
  const [e] = await db.insert(scheduleEntriesTable).values({
    weekId, workerId, factoryId, dayOfWeek: "mon" as any, shift: shift as any, status: status as any,
  }).returning({ id: scheduleEntriesTable.id });
  return e!.id;
}

// ─── Разова зміна (shift-override) ────────────────────────────────────────────

test("POST /schedule/shift-override створює override, ставить hoursOverride явкам клітинки; GET /schedule віддає його; DELETE прибирає", opts, async () => {
  const f = await mkFactory(), w = await mkWorker(f), wk = await mkApprovedWeek();
  const e = await mkEntry(wk, w, f, "3"); // зміна поза shiftCount=2

  // 22:00–04:00 = 6 год (через північ)
  const create = await request(app).post("/api/schedule/shift-override").set("Cookie", cookie).set(H)
    .send({ factoryId: f, date: WEEK, shift: "3", start: "22:00", end: "04:00" });
  assert.equal(create.status, 200, JSON.stringify(create.body));

  const ovRows = await db.select().from(factoryShiftOverridesTable).where(eq(factoryShiftOverridesTable.factoryId, f));
  assert.equal(ovRows.length, 1);
  assert.equal(ovRows[0]!.start, "22:00");

  const [entry] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, e));
  assert.equal(entry!.hoursOverride, 6, "тривалість override має піти в hoursOverride явки");

  const sched = await request(app).get(`/api/schedule?weekStart=${WEEK}&factoryId=${f}`).set("Cookie", cookie);
  assert.equal(sched.status, 200);
  assert.deepEqual(sched.body.shiftOverrides["mon-3"], { start: "22:00", end: "04:00" });

  // Новий запис у клітинку з override теж отримує тривалість
  const w2 = await mkWorker(f, "W2");
  const add = await request(app).post("/api/schedule/entry").set("Cookie", cookie).set(H)
    .send({ weekStart: WEEK, workerId: w2, factoryId: f, day: "mon", shift: "3" });
  assert.equal(add.status, 200);
  assert.equal(add.body.hoursOverride, 6);

  // DELETE: override зникає, проставлені ним години очищаються
  const del = await request(app).delete(`/api/schedule/shift-override?factoryId=${f}&date=${WEEK}&shift=3`)
    .set("Cookie", cookie).set(H);
  assert.equal(del.status, 200);
  assert.equal((await db.select().from(factoryShiftOverridesTable)).length, 0);
  const cleared = await db.select().from(scheduleEntriesTable)
    .where(and(eq(scheduleEntriesTable.weekId, wk), eq(scheduleEntriesTable.shift, "3" as any)));
  for (const c of cleared) assert.equal(c.hoursOverride, null);
});

test("POST /schedule/shift-override відхиляє невалідні дані", opts, async () => {
  const f = await mkFactory();
  const bad = await request(app).post("/api/schedule/shift-override").set("Cookie", cookie).set(H)
    .send({ factoryId: f, date: "not-a-date", shift: "3", start: "22:00", end: "04:00" });
  assert.equal(bad.status, 400);
  const badShift = await request(app).post("/api/schedule/shift-override").set("Cookie", cookie).set(H)
    .send({ factoryId: f, date: WEEK, shift: "9", start: "22:00", end: "04:00" });
  assert.equal(badShift.status, 400);
});

// ─── Excel обліку годин: вибір колонок + errorsOnly ───────────────────────────

async function excelHeaderAndRows(buf: Buffer): Promise<{ header: string[]; dataRows: any[][] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0]!;
  const header = (ws.getRow(2).values as any[]).slice(1).map(v => String(v ?? ""));
  const dataRows: any[][] = [];
  for (let r = 3; r <= ws.rowCount; r++) dataRows.push((ws.getRow(r).values as any[]).slice(1));
  return { header, dataRows };
}

test("GET /hours/report-excel: cols обмежує колонки, errorsOnly лишає тільки розбіжності", opts, async () => {
  const f = await mkFactory();
  const mismatch = await mkWorker(f, "Mismatch Person");
  const okW = await mkWorker(f, "Match Person");
  await db.insert(monthlyReportsTable).values([
    { workerId: mismatch, month: MONTH, factoryId: f, hoursReported: 100 },
    { workerId: okW, month: MONTH, factoryId: f, hoursReported: 80 },
  ]);
  await db.insert(factoryHoursTable).values([
    { workerId: mismatch, month: MONTH, factoryId: f, hours: 90 },
    { workerId: okW, month: MONTH, factoryId: f, hours: 80 },
  ]);

  // Вибрані колонки — саме ті, що просили, у тому ж порядку каталогу
  const res = await request(app)
    .get(`/api/hours/report-excel?month=${MONTH}&factoryId=${f}&cols=name,report,factoryHours,diff`)
    .set("Cookie", cookie).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(res.status, 200);
  const { header, dataRows } = await excelHeaderAndRows(res.body as Buffer);
  assert.deepEqual(header, ["Imię i nazwisko", "Godziny (raport)", "Godziny (fabryka)", "Różnica"]);
  // 2 працівники + рядок Razem
  assert.equal(dataRows.length, 3);
  const mm = dataRows.find(r => r[0] === "Mismatch Person")!;
  assert.equal(mm[3], 10, "різниця 100-90");

  // errorsOnly: match-рядок випадає, лишається лише розбіжність (+Razem)
  const errRes = await request(app)
    .get(`/api/hours/report-excel?month=${MONTH}&factoryId=${f}&cols=name,report,factoryHours,diff&errorsOnly=1`)
    .set("Cookie", cookie).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(errRes.status, 200);
  const err = await excelHeaderAndRows(errRes.body as Buffer);
  assert.equal(err.dataRows.length, 2, "1 розбіжність + Razem");
  assert.equal(err.dataRows[0]![0], "Mismatch Person");
});

// Регресія 04.08.2026: експорт ішов лише по активних працівниках — рапорти
// звільнених і явки переведених зникали з файлу (у файлі було менше людей і
// годин, ніж на сторінці /hours). Рядки файлу мусять збігатися зі сторінкою.
test("GET /hours/report-excel: звільнені з рапортом і переведені з явками не губляться; колонка годин графіку", opts, async () => {
  const f = await mkFactory();
  const fired = await mkWorker(f, "Fired Person");
  const moved = await mkWorker(f, "Moved Person");
  const wk = await mkApprovedWeek();
  await mkEntry(wk, moved, f, "1", "present"); // затверджена явка: зміна 06–14 → 8 год
  await db.insert(monthlyReportsTable).values([{ workerId: fired, month: MONTH, factoryId: f, hoursReported: 120 }]);
  await db.update(workersTable).set({ isActive: false }).where(eq(workersTable.id, fired));
  const f2 = await mkFactory(); // «переведений»: поточна фабрика вже інша, явки місяця — на f
  await db.update(workersTable).set({ factoryId: f2 }).where(eq(workersTable.id, moved));

  const res = await request(app)
    .get(`/api/hours/report-excel?month=${MONTH}&factoryId=${f}&cols=name,hours,report`)
    .set("Cookie", cookie).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(res.status, 200);
  const { header, dataRows } = await excelHeaderAndRows(res.body as Buffer);
  assert.deepEqual(header, ["Imię i nazwisko", "Godziny (grafik)", "Godziny (raport)"]);
  const names = dataRows.map(r => r[0]);
  assert.ok(names.includes("Fired Person"), "звільнений з рапортом присутній у файлі");
  assert.ok(names.includes("Moved Person"), "переведений з явками присутній у файлі");
  assert.equal(dataRows.find(r => r[0] === "Fired Person")![2], 120);
  assert.equal(dataRows.find(r => r[0] === "Moved Person")![1], 8, "8 год із затвердженої явки");
  const razem = dataRows[dataRows.length - 1]!;
  assert.equal(razem[0], "Razem");
  assert.equal(razem[2], 120, "Razem рахує і рапорт звільненого");
});

// ─── Відсутності: виправдання і штрафи ────────────────────────────────────────

test("GET /absences рахує штрафи (стандарт 200); PATCH правки штрафу і виправдання виключають з підсумків", opts, async () => {
  const f = await mkFactory(), w = await mkWorker(f), wk = await mkApprovedWeek();
  const e = await mkEntry(wk, w, f, "1", "absent");

  let res = await request(app).get(`/api/absences?month=${MONTH}`).set("Cookie", cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.absences[0].penalty, 200);
  assert.equal(res.body.penaltyTotal, 200);

  // Свій розмір штрафу
  const p = await request(app).patch(`/api/absences/${e}`).set("Cookie", cookie).set(H).send({ penalty: 150 });
  assert.equal(p.status, 200);
  res = await request(app).get(`/api/absences?month=${MONTH}`).set("Cookie", cookie);
  assert.equal(res.body.absences[0].penalty, 150);
  assert.equal(res.body.penaltyTotal, 150);

  // Виправдання: не рахується в кількість, штраф 0
  const j = await request(app).patch(`/api/absences/${e}`).set("Cookie", cookie).set(H).send({ justified: true });
  assert.equal(j.status, 200);
  res = await request(app).get(`/api/absences?month=${MONTH}`).set("Cookie", cookie);
  assert.equal(res.body.total, 0);
  assert.equal(res.body.justified, 1);
  assert.equal(res.body.penaltyTotal, 0);
  assert.equal(res.body.absences[0].penalty, 0);

  // Зняти виправдання → повертається override 150
  await request(app).patch(`/api/absences/${e}`).set("Cookie", cookie).set(H).send({ justified: false });
  res = await request(app).get(`/api/absences?month=${MONTH}`).set("Cookie", cookie);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.penaltyTotal, 150);
});

test("PATCH /absences/:entryId відхиляє не-пропуск і невалідний штраф", opts, async () => {
  const f = await mkFactory(), w = await mkWorker(f), wk = await mkApprovedWeek();
  const scheduled = await mkEntry(wk, w, f, "1", "scheduled");
  const notAbsent = await request(app).patch(`/api/absences/${scheduled}`).set("Cookie", cookie).set(H).send({ justified: true });
  assert.equal(notAbsent.status, 400);

  const w2 = await mkWorker(f, "W2");
  const absent = await mkEntry(wk, w2, f, "2", "absent");
  const badPenalty = await request(app).patch(`/api/absences/${absent}`).set("Cookie", cookie).set(H).send({ penalty: -5 });
  assert.equal(badPenalty.status, 400);
  const missing = await request(app).patch(`/api/absences/999999`).set("Cookie", cookie).set(H).send({ justified: true });
  assert.equal(missing.status, 404);
});
