import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  app, hasTestDb, resetDb, seedAdmin, closeDb, db,
  factoriesTable, workersTable, scheduleWeeksTable, scheduleEntriesTable,
  availabilityTable, absenceRequestsTable, factoryShiftOverridesTable, shiftCancellationsTable,
} from "../test/harness.ts";
import { and, eq } from "drizzle-orm";

// «Заповнити тиждень як цей день» (POST /schedule/copy-day): превʼю-класифікація
// (ok / noAvail / absence / skipped) і apply з force-парами, копіюванням разового
// часу зміни джерельної клітинки та hoursOverride — як у POST /schedule/entry.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

// Гарантований понеділок у майбутньому + дата i-го дня тижня
const WEEK = (() => {
  const d = new Date("2099-02-01T00:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
const dayDate = (offset: number) => {
  const d = new Date(WEEK + "T00:00:00");
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let cookie = "";
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  cookie = (await seedAdmin({ role: "owner" })).cookie;
});
after(async () => { if (hasTestDb) await closeDb(); });

async function mkFactory(usesAvailability = true): Promise<number> {
  const [f] = await db.insert(factoriesTable).values({
    name: "F", shiftCount: 2, usesAvailability,
    shifts: [{ start: "06:00", end: "14:00" }, { start: "14:00", end: "22:00" }],
  }).returning({ id: factoriesTable.id });
  return f!.id;
}
async function mkWorker(factoryId: number, name: string): Promise<number> {
  const [w] = await db.insert(workersTable).values({ fullName: name, factoryId }).returning({ id: workersTable.id });
  return w!.id;
}
async function mkWeek(): Promise<number> {
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: WEEK, status: "approved" }).returning({ id: scheduleWeeksTable.id });
  return wk!.id;
}
async function mkEntry(weekId: number, workerId: number, factoryId: number, day: string, shift: string): Promise<number> {
  const [e] = await db.insert(scheduleEntriesTable).values({
    weekId, workerId, factoryId, dayOfWeek: day as any, shift: shift as any, status: "scheduled",
  }).returning({ id: scheduleEntriesTable.id });
  return e!.id;
}
async function mkAvail(workerId: number, day: string, shift: string): Promise<void> {
  await db.insert(availabilityTable).values({
    fullNameRaw: "raw", workerId, weekStart: WEEK, dayOfWeek: day as any, shift: shift as any, submittedAt: new Date(),
  });
}

// Сід «повної» картини: A ок, B без диспо взагалі, C диспо лише на іншу зміну,
// D відпросився на вівторок, E вже має зміну у вівторок.
async function seedFull() {
  const f = await mkFactory();
  const wk = await mkWeek();
  const A = await mkWorker(f, "A Ok");
  const B = await mkWorker(f, "B NoAvail");
  const C = await mkWorker(f, "C OtherShift");
  const D = await mkWorker(f, "D Absent");
  const E = await mkWorker(f, "E Busy");
  for (const w of [A, B, C, D, E]) await mkEntry(wk, w, f, "mon", "1");
  await mkAvail(A, "tue", "1");
  await mkAvail(A, "wed", "1");
  await mkAvail(C, "tue", "2"); // диспо є, але на іншу зміну
  await db.insert(absenceRequestsTable).values({
    workerId: D, weekStart: WEEK, dayOfWeek: "tue" as any, shift: null, status: "accepted", reason: "хвороба",
  });
  await mkEntry(wk, E, f, "tue", "2"); // зайнятий у вівторок іншою зміною
  return { f, wk, A, B, C, D, E };
}

test("preview: класифікація ok / noAvail (з приміткою про іншу зміну) / absence / busy", opts, async () => {
  const { f, A, B, C, D, E } = await seedFull();
  const res = await request(app).post("/api/schedule/copy-day").set("Cookie", cookie).set(H)
    .send({ weekStart: WEEK, factoryId: f, sourceDay: "mon", targetDays: ["tue", "wed"], mode: "preview" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.usesAvailability, true);
  assert.equal(res.body.people, 5);

  const tue = res.body.days.find((d: any) => d.day === "tue");
  assert.deepEqual(tue.ok.map((p: any) => p.workerId), [A]);
  const noAvailTue = new Map(tue.noAvail.map((p: any) => [p.workerId, p.note ?? null]));
  assert.deepEqual([...noAvailTue.keys()].sort(), [B, C].sort());
  assert.equal(noAvailTue.get(B), null, "B не заповнював вівторок взагалі");
  assert.equal(noAvailTue.get(C), "other_shift", "C заповнив іншу зміну вівторка");
  assert.deepEqual(tue.absence.map((p: any) => [p.workerId, p.note]), [[D, "хвороба"]]);
  assert.deepEqual(tue.skipped.map((p: any) => [p.workerId, p.reason]), [[E, "busy"]]);

  // Середа: у D запиту нема (він лише на вівторок), E вільний — обидва просто без диспо
  const wed = res.body.days.find((d: any) => d.day === "wed");
  assert.deepEqual(wed.ok.map((p: any) => p.workerId), [A]);
  assert.deepEqual(wed.noAvail.map((p: any) => p.workerId).sort(), [B, C, D, E].sort());
  assert.equal(wed.absence.length, 0);
  assert.equal(wed.skipped.length, 0);
});

test("apply: ставить ок + force, не чіпає absence/busy без force; дублікатів немає", opts, async () => {
  const { f, wk, A, B, D, E } = await seedFull();
  const res = await request(app).post("/api/schedule/copy-day").set("Cookie", cookie).set(H)
    .send({
      weekStart: WEEK, factoryId: f, sourceDay: "mon", targetDays: ["tue", "wed"], mode: "apply",
      force: [{ day: "tue", workerId: B }],
    });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.created, 3, "tue: A+B(force), wed: A");
  assert.deepEqual(res.body.days, { tue: 2, wed: 1 });

  const tueRows = await db.select().from(scheduleEntriesTable)
    .where(and(eq(scheduleEntriesTable.weekId, wk), eq(scheduleEntriesTable.dayOfWeek, "tue" as any)));
  // E мав рядок ще до apply — новий не додався; D (absence) без force не ставиться
  assert.deepEqual(tueRows.map(r => r.workerId).sort(), [A, B, E].sort());
  for (const r of tueRows.filter(r => r.workerId !== E)) {
    assert.equal(r.shift, "1", "зміна копіюється та сама");
    assert.equal(r.status, "scheduled");
    assert.equal(r.hoursOverride, null, "стандартна зміна — без override годин");
  }
  assert.ok(!tueRows.some(r => r.workerId === D));

  const wedRows = await db.select().from(scheduleEntriesTable)
    .where(and(eq(scheduleEntriesTable.weekId, wk), eq(scheduleEntriesTable.dayOfWeek, "wed" as any)));
  assert.deepEqual(wedRows.map(r => r.workerId), [A], "force діяв лише на вівторок");

  // Повторний apply тих самих днів — усі вже busy, нічого не дублюється
  const again = await request(app).post("/api/schedule/copy-day").set("Cookie", cookie).set(H)
    .send({ weekStart: WEEK, factoryId: f, sourceDay: "mon", targetDays: ["tue", "wed"], mode: "apply", force: [] });
  assert.equal(again.body.created, 0);
});

test("apply: разовий час зміни джерельного дня копіюється на цільову дату, hoursOverride ставиться", opts, async () => {
  const f = await mkFactory();
  const wk = await mkWeek();
  const X = await mkWorker(f, "X Extra");
  await mkEntry(wk, X, f, "mon", "3"); // зміна поза shiftCount=2
  await mkAvail(X, "tue", "3");
  // 22:00–04:00 = 6 год (через північ)
  await db.insert(factoryShiftOverridesTable).values({ factoryId: f, date: WEEK, shift: "3" as any, start: "22:00", end: "04:00" });

  const res = await request(app).post("/api/schedule/copy-day").set("Cookie", cookie).set(H)
    .send({ weekStart: WEEK, factoryId: f, sourceDay: "mon", targetDays: ["tue"], mode: "apply" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.created, 1);
  assert.equal(res.body.overridesCopied, 1);

  const [ov] = await db.select().from(factoryShiftOverridesTable)
    .where(and(eq(factoryShiftOverridesTable.factoryId, f), eq(factoryShiftOverridesTable.date, dayDate(1))));
  assert.ok(ov, "разова зміна скопійована на дату вівторка");
  assert.equal(ov!.start, "22:00");
  assert.equal(ov!.end, "04:00");

  const [entry] = await db.select().from(scheduleEntriesTable)
    .where(and(eq(scheduleEntriesTable.weekId, wk), eq(scheduleEntriesTable.dayOfWeek, "tue" as any)));
  assert.equal(entry!.shift, "3");
  assert.equal(entry!.hoursOverride, 6, "тривалість разової зміни зафіксована в hoursOverride");
});

test("скасована клітинка цільового дня: preview → skipped=cancelled, apply нічого не ставить", opts, async () => {
  const f = await mkFactory();
  const wk = await mkWeek();
  const A = await mkWorker(f, "A Ok");
  await mkEntry(wk, A, f, "mon", "1");
  await mkAvail(A, "tue", "1");
  await db.insert(shiftCancellationsTable).values({ weekId: wk, factoryId: f, dayOfWeek: "tue" as any, shift: "1" as any });

  const prev = await request(app).post("/api/schedule/copy-day").set("Cookie", cookie).set(H)
    .send({ weekStart: WEEK, factoryId: f, sourceDay: "mon", targetDays: ["tue"], mode: "preview" });
  const tue = prev.body.days.find((d: any) => d.day === "tue");
  assert.deepEqual(tue.skipped.map((p: any) => [p.workerId, p.reason]), [[A, "cancelled"]]);
  assert.equal(tue.ok.length, 0);

  const res = await request(app).post("/api/schedule/copy-day").set("Cookie", cookie).set(H)
    .send({ weekStart: WEEK, factoryId: f, sourceDay: "mon", targetDays: ["tue"], mode: "apply" });
  assert.equal(res.body.created, 0);
});

test("фабрика без диспозиційності: всі ok і ставляться без force", opts, async () => {
  const f = await mkFactory(false);
  const wk = await mkWeek();
  const A = await mkWorker(f, "A"), B = await mkWorker(f, "B");
  await mkEntry(wk, A, f, "mon", "1");
  await mkEntry(wk, B, f, "mon", "2");

  const prev = await request(app).post("/api/schedule/copy-day").set("Cookie", cookie).set(H)
    .send({ weekStart: WEEK, factoryId: f, sourceDay: "mon", targetDays: ["tue"], mode: "preview" });
  assert.equal(prev.body.usesAvailability, false);
  const tue = prev.body.days.find((d: any) => d.day === "tue");
  assert.equal(tue.ok.length, 2);
  assert.equal(tue.noAvail.length, 0);

  const res = await request(app).post("/api/schedule/copy-day").set("Cookie", cookie).set(H)
    .send({ weekStart: WEEK, factoryId: f, sourceDay: "mon", targetDays: ["tue"], mode: "apply" });
  assert.equal(res.body.created, 2);
  const rows = await db.select().from(scheduleEntriesTable)
    .where(and(eq(scheduleEntriesTable.weekId, wk), eq(scheduleEntriesTable.dayOfWeek, "tue" as any)));
  assert.deepEqual(rows.map(r => [r.workerId, r.shift]).sort(), [[A, "1"], [B, "2"]].sort());
});

test("валідація: невалідні дані → 400, порожній джерельний день → 400", opts, async () => {
  const f = await mkFactory();
  await mkWeek();
  const badDay = await request(app).post("/api/schedule/copy-day").set("Cookie", cookie).set(H)
    .send({ weekStart: WEEK, factoryId: f, sourceDay: "xxx", targetDays: ["tue"], mode: "preview" });
  assert.equal(badDay.status, 400);
  const noTargets = await request(app).post("/api/schedule/copy-day").set("Cookie", cookie).set(H)
    .send({ weekStart: WEEK, factoryId: f, sourceDay: "mon", targetDays: ["mon"], mode: "preview" });
  assert.equal(noTargets.status, 400, "джерельний день не може бути єдиною ціллю");
  const empty = await request(app).post("/api/schedule/copy-day").set("Cookie", cookie).set(H)
    .send({ weekStart: WEEK, factoryId: f, sourceDay: "mon", targetDays: ["tue"], mode: "preview" });
  assert.equal(empty.status, 400, "у джерельному дні нікого немає");
});
