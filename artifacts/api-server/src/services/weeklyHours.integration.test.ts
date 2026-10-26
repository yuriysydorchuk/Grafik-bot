// Тижневий облік годин (26.10.2026): відмітки зміни в боті (пуш → приступив → закінчив,
// відсутній, протухання, авто-закриття, нічна зміна через північ), запит рапорту за
// тиждень і його флоу, виведення місячних рядків з тижнів і API вкладки тижня.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, closeDb, db, workersTable, factoriesTable, scheduleWeeksTable, scheduleEntriesTable, monthlyReportsTable, factoryHoursTable } from "../test/harness.ts";
import { sent, resetSent, sentText, pressButton, sendText } from "../test/botHarness.ts";
import { workerShiftLogsTable, weeklyReportsTable, fromWarsawWall } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { promptShiftStarts, expireStaleLogs, startLog, endLog, wallHHMM } from "./shiftLogs.ts";
import { sendWeeklyRequests, saveWeeklyReport, ensureWeeklyReport, buildWeekRows } from "./weeklyHours.ts";
import { warsawDateStr, nowWarsaw } from "../bot/time.ts";
import { mondayOf } from "../lib/weekMath.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const TID = "1001";
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

let owner = "";
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  resetSent();
  owner = (await seedAdmin({ role: "owner" })).cookie;
});
after(async () => { if (hasTestDb) await closeDb(); });

const hhmm = (d: Date) => wallHHMM(d);
const plusH = (t: string, h: number) => { const [hh, mm] = t.split(":").map(Number); return `${String((hh! + h) % 24).padStart(2, "0")}:${String(mm).padStart(2, "0")}`; };

async function seedWeeklyFactory(shift1Start?: string) {
  const s1 = shift1Start ?? hhmm(new Date());
  const [f] = await db.insert(factoriesTable).values({
    name: "Sezonowa", weeklyHours: true, shiftCount: 3,
    shifts: [{ start: s1, end: plusH(s1, 8) }, { start: "14:00", end: "22:00" }, { start: "22:00", end: "06:00" }],
  }).returning({ id: factoriesTable.id });
  const [w] = await db.insert(workersTable).values({ fullName: "Kowalski Jan", factoryId: f!.id, telegramId: TID, language: "uk" }).returning({ id: workersTable.id });
  return { factoryId: f!.id, workerId: w!.id };
}

// розісланий запис графіку на СЬОГОДНІ (поточний тиждень Warsaw)
async function seedTodayEntry(workerId: number, factoryId: number, shift: "1" | "2" | "3" = "1") {
  const today = warsawDateStr();
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: mondayOf(today), status: "approved" }).returning({ id: scheduleWeeksTable.id });
  const [e] = await db.insert(scheduleEntriesTable).values({
    weekId: wk!.id, workerId, factoryId, dayOfWeek: DOW[nowWarsaw().getDay()]!, shift, status: "scheduled", sentAt: new Date(),
  }).returning({ id: scheduleEntriesTable.id });
  return { entryId: e!.id, today };
}

test("пуш на старті зміни → приступив (зараз) → закінчив (зараз): лог закрито, запис графіку present", opts, async () => {
  const { factoryId, workerId } = await seedWeeklyFactory();
  const { entryId } = await seedTodayEntry(workerId, factoryId);
  const n = await promptShiftStarts(new Date());
  assert.equal(n, 1);
  assert.equal(await promptShiftStarts(new Date()), 0, "повторний тік не дублює пуш (unique entry)");
  const [log] = await db.select().from(workerShiftLogsTable).where(eq(workerShiftLogsTable.entryId, entryId));
  assert.ok(log); assert.equal(log!.status, "pending"); assert.equal(log!.promptMessageId, 1);
  assert.match(sentText(), /Приступив до роботи/);
  const kb = sent[0]!.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.deepEqual(kb, [`wsl:start:${log!.id}`, `wsl:absent:${log!.id}`]);

  resetSent();
  await pressButton(TID, `wsl:start:${log!.id}`);   // вибір «зараз / раніше»
  await pressButton(TID, `wsl:snow:${log!.id}`);    // зараз
  const [open] = await db.select().from(workerShiftLogsTable).where(eq(workerShiftLogsTable.id, log!.id));
  assert.equal(open!.status, "open"); assert.equal(open!.startSource, "now"); assert.ok(open!.startedAt);
  assert.match(sentText(), /Початок роботи/);
  assert.ok(open!.endMessageId, "повідомлення з кнопкою «Закінчив» запамʼятовано");

  resetSent();
  await pressButton(TID, `wsl:end:${log!.id}`);
  await pressButton(TID, `wsl:enow:${log!.id}`);
  const [closed] = await db.select().from(workerShiftLogsTable).where(eq(workerShiftLogsTable.id, log!.id));
  assert.equal(closed!.status, "closed"); assert.equal(closed!.hours, 0.25, "мінімум 0.25 год при миттєвому закритті");
  assert.match(sentText(), /Зміну закрито/);
  const [entry] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, entryId));
  assert.equal(entry!.status, "present"); assert.equal(entry!.hoursOverride, 0.25);
  // повторне натискання — вже недійсне
  resetSent();
  await pressButton(TID, `wsl:enow:${log!.id}`);
  const [again] = await db.select().from(workerShiftLogsTable).where(eq(workerShiftLogsTable.id, log!.id));
  assert.equal(again!.hours, 0.25);
});

test("«Відсутній» → лог absent, запис графіку absent, офісу сповіщення", opts, async () => {
  const { factoryId, workerId } = await seedWeeklyFactory();
  const { entryId } = await seedTodayEntry(workerId, factoryId);
  await promptShiftStarts(new Date());
  const [log] = await db.select().from(workerShiftLogsTable).where(eq(workerShiftLogsTable.entryId, entryId));
  resetSent();
  await pressButton(TID, `wsl:absent:${log!.id}`);
  const [l] = await db.select().from(workerShiftLogsTable).where(eq(workerShiftLogsTable.id, log!.id));
  assert.equal(l!.status, "absent");
  const [entry] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, entryId));
  assert.equal(entry!.status, "absent");
  assert.match(sentText(), /відсутні/);
});

test("протухання: пуш без відповіді > 24 год → expired; відкрита > 24 год → auto 1 год + запис графіку", opts, async () => {
  const { factoryId, workerId } = await seedWeeklyFactory("06:00");
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-10-19", status: "approved" }).returning({ id: scheduleWeeksTable.id });
  const [e1] = await db.insert(scheduleEntriesTable).values({ weekId: wk!.id, workerId, factoryId, dayOfWeek: "mon", shift: "1", sentAt: new Date() }).returning({ id: scheduleEntriesTable.id });
  const [e2] = await db.insert(scheduleEntriesTable).values({ weekId: wk!.id, workerId, factoryId, dayOfWeek: "tue", shift: "1", sentAt: new Date() }).returning({ id: scheduleEntriesTable.id });
  const now = new Date();
  const old = new Date(now.getTime() - 25 * 3_600_000);
  await db.insert(workerShiftLogsTable).values([
    { workerId, factoryId, entryId: e1!.id, workDate: "2026-10-19", shift: "1", status: "pending", promptSentAt: old, promptChatId: TID, promptMessageId: 7 },
    { workerId, factoryId, entryId: e2!.id, workDate: "2026-10-20", shift: "1", status: "open", startedAt: old, startSource: "now", endChatId: TID, endMessageId: 8 },
  ]);
  const r = await expireStaleLogs(now);
  assert.deepEqual(r, { expired: 1, auto: 1 });
  const logs = await db.select().from(workerShiftLogsTable).where(eq(workerShiftLogsTable.workerId, workerId));
  const p = logs.find(l => l.entryId === e1!.id)!, o = logs.find(l => l.entryId === e2!.id)!;
  assert.equal(p.status, "expired");
  assert.equal(o.status, "auto"); assert.equal(o.hours, 1); assert.equal(o.endSource, "auto");
  const [entry] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, e2!.id));
  assert.equal(entry!.status, "present"); assert.equal(entry!.hoursOverride, 1);
  assert.match(sentText(), /не закрито протягом 24 годин/);
  // кнопки знято з обох повідомлень
  assert.ok(sent.some(s => s.method === "editMessageReplyMarkup" && s.extra.message_id === 7));
  assert.ok(sent.some(s => s.method === "editMessageReplyMarkup" && s.extra.message_id === 8));
});

test("нічна зміна 22:00–06:00: закриття після опівночі лягає на день старту, 8.25 год", opts, async () => {
  const { factoryId, workerId } = await seedWeeklyFactory("06:00");
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-10-26", status: "approved" }).returning({ id: scheduleWeeksTable.id });
  const [e] = await db.insert(scheduleEntriesTable).values({ weekId: wk!.id, workerId, factoryId, dayOfWeek: "mon", shift: "3", sentAt: new Date() }).returning({ id: scheduleEntriesTable.id });
  const prompt = fromWarsawWall("2026-10-26 21:50:00");
  const [log] = await db.insert(workerShiftLogsTable).values({ workerId, factoryId, entryId: e!.id, workDate: "2026-10-26", shift: "3", status: "pending", promptSentAt: prompt }).returning();
  const startAt = fromWarsawWall("2026-10-26 22:05:00");
  const s = await startLog(log!.id, startAt, "manual", fromWarsawWall("2026-10-26 22:30:00"));
  assert.ok(s.ok);
  // раніше за (старт зміни − 2 год) — відхиляється
  const tooEarly = await startLog(log!.id, fromWarsawWall("2026-10-26 10:00:00"), "manual", fromWarsawWall("2026-10-26 22:30:00"));
  assert.ok(!tooEarly.ok && tooEarly.reason === "state"); // уже open
  const endAt = fromWarsawWall("2026-10-27 06:20:00");
  const bad = await endLog(log!.id, fromWarsawWall("2026-10-26 21:00:00"), "manual", endAt);
  assert.ok(!bad.ok && bad.reason === "early");
  const en = await endLog(log!.id, endAt, "now", endAt);
  assert.ok(en.ok);
  const [l] = await db.select().from(workerShiftLogsTable).where(eq(workerShiftLogsTable.id, log!.id));
  assert.equal(String(l!.workDate), "2026-10-26"); assert.equal(l!.hours, 8.25); assert.equal(l!.status, "closed");
  const [entry] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, e!.id));
  assert.equal(entry!.hoursOverride, 8.25);
});

test("новий пуш гасить попередній без відповіді", opts, async () => {
  const { factoryId, workerId } = await seedWeeklyFactory();
  const { entryId } = await seedTodayEntry(workerId, factoryId);
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-09-07", status: "approved" }).returning({ id: scheduleWeeksTable.id });
  const [eOld] = await db.insert(scheduleEntriesTable).values({ weekId: wk!.id, workerId, factoryId, dayOfWeek: "mon", shift: "1", sentAt: new Date() }).returning({ id: scheduleEntriesTable.id });
  await db.insert(workerShiftLogsTable).values({ workerId, factoryId, entryId: eOld!.id, workDate: "2026-09-07", shift: "1", status: "pending", promptSentAt: new Date(Date.now() - 3_600_000), promptChatId: TID, promptMessageId: 3 });
  await promptShiftStarts(new Date());
  const logs = await db.select().from(workerShiftLogsTable).where(eq(workerShiftLogsTable.workerId, workerId));
  assert.equal(logs.find(l => l.entryId === eOld!.id)!.status, "expired");
  assert.equal(logs.find(l => l.entryId === entryId)!.status, "pending");
});

test("запит рапорту тижня → «не працював увесь тиждень» → подано з 0 год без фото", opts, async () => {
  const { factoryId, workerId } = await seedWeeklyFactory("06:00");
  const r = await sendWeeklyRequests({ weekStart: "2026-10-19", factoryId });
  assert.deepEqual(r, { notified: 1, skipped: 0 });
  assert.match(sentText(), /Години за тиждень 19\.10–25\.10/);
  const [rep] = await db.select().from(weeklyReportsTable).where(eq(weeklyReportsTable.workerId, workerId));
  assert.ok(rep!.requestSentAt); assert.equal(rep!.submittedAt, null);
  resetSent();
  await pressButton(TID, `wkr:go:${rep!.id}`);
  assert.match(sentText(), /Пн 19\.10/);
  await pressButton(TID, `wkr:c:${rep!.id}`); // нічого не вибрано (змін у графіку не було) → тотал
  await sendText(TID, "0");
  const [done] = await db.select().from(weeklyReportsTable).where(eq(weeklyReportsTable.id, rep!.id));
  assert.ok(done!.submittedAt); assert.equal(done!.hoursReported, 0);
  assert.match(sentText(), /не працювали/);
  // нагадування вже поданому не йде
  const r2 = await sendWeeklyRequests({ weekStart: "2026-10-19", factoryId, remind: true });
  assert.deepEqual(r2, { notified: 0, skipped: 1 });
});

test("флоу по днях: 7 змін → тотал текстом → чекає фото; тотал поза межами — помилка", opts, async () => {
  const { factoryId, workerId } = await seedWeeklyFactory("06:00");
  const rep = await ensureWeeklyReport(workerId, factoryId, "2026-10-19");
  await pressButton(TID, `wkr:go:${rep.id}`);
  await pressButton(TID, `wkr:g:${rep.id + 1}:0:1`); // чужий рапорт — ігнорується
  for (let i = 0; i < 5; i++) await pressButton(TID, `wkr:g:${rep.id}:${i}:1`);
  assert.match(sentText(), /Разом по змінах: \*40 год\*/);
  await pressButton(TID, `wkr:c:${rep.id}`);
  assert.match(sentText(), /Разом по змінах: \*40 год\*/);
  resetSent();
  await sendText(TID, "500");
  assert.match(sentText(), /від 0 до 120/);
  resetSent();
  await sendText(TID, "42,5");
  assert.match(sentText(), /надішліть \*фото\*/);
  const [row] = await db.select().from(weeklyReportsTable).where(eq(weeklyReportsTable.id, rep.id));
  assert.equal(row!.submittedAt, null, "без фото рапорт не подано");
});

test("місячні рядки виводяться з тижнів по датах: тиждень на межі місяця ділиться, тотал масштабує", opts, async () => {
  const { factoryId, workerId } = await seedWeeklyFactory("06:00");
  const rep = await ensureWeeklyReport(workerId, factoryId, "2026-10-26");
  await saveWeeklyReport(rep.id, {
    days: { "2026-10-30": { shift: "1", hours: 8 }, "2026-10-31": { shift: "1", hours: 8 }, "2026-11-01": { shift: "1", hours: 8 } },
    hoursReported: 30, photoLink: "https://drive.google.com/file/d/x/view",
  });
  const oct = await db.select().from(monthlyReportsTable).where(and(eq(monthlyReportsTable.workerId, workerId), eq(monthlyReportsTable.month, "2026-10")));
  const nov = await db.select().from(monthlyReportsTable).where(and(eq(monthlyReportsTable.workerId, workerId), eq(monthlyReportsTable.month, "2026-11")));
  assert.equal(oct[0]!.hoursReported, 20); assert.equal(nov[0]!.hoursReported, 10);
  assert.equal(oct[0]!.photoLink, "https://drive.google.com/file/d/x/view");

  // години фабрики за тиждень без днів → місяць четверга (жовтень), з днями — по датах
  let res = await request(app).post("/api/hours/weeks/factory").set("Cookie", owner).set(H).send({ factoryId, workerId, weekStart: "2026-10-26", hours: "40" });
  assert.equal(res.status, 200);
  let fh = await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.workerId, workerId));
  assert.equal(fh.length, 1); assert.equal(fh[0]!.month, "2026-10"); assert.equal(fh[0]!.hours, 40); assert.equal(fh[0]!.source, "weekly");
  res = await request(app).post("/api/hours/weeks/factory").set("Cookie", owner).set(H).send({ factoryId, workerId, weekStart: "2026-10-26", days: { "2026-10-30": 8, "2026-11-01": 6 } });
  assert.equal(res.status, 200);
  fh = await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.workerId, workerId));
  assert.deepEqual(Object.fromEntries(fh.map(r => [r.month, r.hours])), { "2026-10": 8, "2026-11": 6 });
  // GET /hours бачить похідні значення
  const hours = await request(app).get("/api/hours?month=2026-10").set("Cookie", owner);
  const row = hours.body.workers.find((w: any) => w.workerId === workerId);
  assert.equal(row.reportHours, 20); assert.equal(row.factoryHours, 8);
  assert.deepEqual(hours.body.weeklyFactoryIds, [factoryId]);
  // прибрати тиждень → похідний місячний рядок зникає
  res = await request(app).post("/api/hours/weeks/factory").set("Cookie", owner).set(H).send({ factoryId, workerId, weekStart: "2026-10-26", hours: null });
  fh = await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.workerId, workerId));
  assert.equal(fh.length, 0);
});

test("GET /hours/weeks: тижні місяця з рядками, імпорт тижня, «все ок» скидається при зміні годин", opts, async () => {
  const { factoryId, workerId } = await seedWeeklyFactory("06:00");
  let res = await request(app).post("/api/hours/weeks/factory-apply").set("Cookie", owner).set(H)
    .send({ factoryId, weekStart: "2026-10-19", source: "paste", rows: [{ workerId, name: "Kowalski Jan", hours: 16, days: { "2026-10-19": 8, "2026-10-20": 8 } }, { workerId, name: "KOWALSKI J", hours: 8, days: { "2026-10-21": 8 } }] });
  assert.equal(res.status, 200); assert.equal(res.body.saved, 1); assert.equal(res.body.merged.length, 1);
  res = await request(app).post("/api/hours/weeks/confirm").set("Cookie", owner).set(H).send({ factoryId, workerId, weekStart: "2026-10-19", confirmed: true });
  assert.equal(res.status, 200);
  res = await request(app).get(`/api/hours/weeks?factoryId=${factoryId}&month=2026-10`).set("Cookie", owner);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.weeks.map((w: any) => w.weekStart), ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  const wk = res.body.weeks.find((w: any) => w.weekStart === "2026-10-19");
  const row = wk.rows.find((r: any) => r.workerId === workerId);
  assert.equal(row.factory.hours, 24); assert.equal(row.factory.confirmed, true); assert.equal(row.days["2026-10-21"].factory, 8);
  res = await request(app).post("/api/hours/weeks/factory").set("Cookie", owner).set(H).send({ factoryId, workerId, weekStart: "2026-10-19", hours: "30" });
  const { rows } = await buildWeekRows(factoryId, "2026-10-19");
  assert.equal(rows[0]!.factory!.confirmed, false, "зміна годин скидає «все ок»");
  // парсер тижневого списку: 7 чисел → дати
  res = await request(app).post("/api/hours/factory-parse").set("Cookie", owner).set(H)
    .send({ month: "2026-10", factoryId, weekStart: "2026-10-26", text: "Kowalski Jan; 8; 8; 8; 0; 8; 10; -\nNowak Anna; 42,5" });
  assert.equal(res.status, 200);
  assert.equal(res.body.rows[0].hours, 42);
  assert.deepEqual(res.body.rows[0].days, { "2026-10-26": 8, "2026-10-27": 8, "2026-10-28": 8, "2026-10-30": 8, "2026-10-31": 10 });
  assert.equal(res.body.rows[1].hours, 42.5); assert.equal(res.body.rows[1].days, null);
});
