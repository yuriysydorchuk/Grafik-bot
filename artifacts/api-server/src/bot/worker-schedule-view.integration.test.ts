import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, sendText, pressButton, resetSent, sentText } from "../test/botHarness.ts";
import {
  workersTable, adminsTable, factoriesTable, scheduleWeeksTable, scheduleEntriesTable,
  scheduleApprovalsTable, availabilityTable, notificationsTable, rolesTable,
} from "../test/harness.ts";
import { invalidateRolesCache } from "../lib/auth.ts";
import { getCurrentMonday, getNextMonday } from "../services/scheduleGenerator.ts";
import { setState } from "./state.ts";
import { eq } from "drizzle-orm";

// «Мій графік» працівника: день без розісланого запису фабрики — це «⏳ ще не
// затверджено», а НЕ «вихідний» (затвердження дня = розсилка, слід — sent_at).
// Догруз диспозиційності після першого подання / після затвердження тижня має
// пінгувати графікову (notifyRoles → дзвіночок + Telegram).
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

const TID = "800300";

async function seedWorkerWithFactory() {
  const [f] = await db.insert(factoriesTable).values({ name: "SchedFab" }).returning({ id: factoriesTable.id });
  const [w] = await db.insert(workersTable)
    .values({ fullName: "Jan Testowy", telegramId: TID, isActive: true, factoryId: f!.id })
    .returning({ id: workersTable.id });
  return { factoryId: f!.id, workerId: w!.id };
}

test("draft week with unsent entries → «ще не затверджено», not «вихідний»", opts, async () => {
  const { factoryId, workerId } = await seedWorkerWithFactory();
  const [wk] = await db.insert(scheduleWeeksTable)
    .values({ weekStart: getCurrentMonday(), status: "draft" })
    .returning({ id: scheduleWeeksTable.id });
  await db.insert(scheduleEntriesTable)
    .values({ weekId: wk!.id, workerId, factoryId, dayOfWeek: "mon", shift: "1", status: "scheduled" });

  await sendText(TID, "📅 Мій графік на тиждень");

  assert.match(sentText(), /ще не затверджений/, "unapproved week says so explicitly");
  assert.doesNotMatch(sentText(), /вихідний/, "no day reads as a day off before approval");
});

test("per-day: sent day → shift, released empty day → day off, unsent day → pending", opts, async () => {
  const { factoryId, workerId } = await seedWorkerWithFactory();
  const [other] = await db.insert(workersTable)
    .values({ fullName: "Inny Pracownik", isActive: true, factoryId })
    .returning({ id: workersTable.id });
  const [wk] = await db.insert(scheduleWeeksTable)
    .values({ weekStart: getCurrentMonday(), status: "approved", approvedAt: new Date() })
    .returning({ id: scheduleWeeksTable.id });
  await db.insert(scheduleApprovalsTable).values({ weekId: wk!.id, factoryId });
  // Пн — розісланий запис працівника; Вт — запис іншої людини БЕЗ розсилки;
  // Ср — записів фабрики нема взагалі (фабрика не працює → вихідний).
  await db.insert(scheduleEntriesTable).values([
    { weekId: wk!.id, workerId, factoryId, dayOfWeek: "mon", shift: "1", status: "scheduled", sentAt: new Date() },
    { weekId: wk!.id, workerId: other!.id, factoryId, dayOfWeek: "tue", shift: "1", status: "scheduled" },
  ]);

  await sendText(TID, "📅 Мій графік на тиждень");
  const txt = sentText();

  assert.match(txt, /1 зміна — 🏭 SchedFab/, "sent Monday entry shows the shift");
  assert.match(txt, /ще не затверджено/, "Tuesday with only unsent entries is pending");
  assert.match(txt, /вихідний/, "empty Wednesday on a released week is a day off");
});

test("availability top-up after first submission pings the scheduler", opts, async () => {
  const { factoryId, workerId } = await seedWorkerWithFactory();
  await db.insert(adminsTable).values({ name: "Owner", role: "owner", telegramId: "999888" });
  // Telegram-пінг іде лише ролям, у чиїх notify-префах є цей тип (bba28e1)
  await db.insert(rolesTable).values({ key: "owner", label: "owner", caps: [], pages: [], notify: ["availability_change"] }).onConflictDoNothing();
  invalidateRolesCache();
  const weekStart = getNextMonday();
  // тиждень уже затверджений для фабрики працівника
  const [wk] = await db.insert(scheduleWeeksTable)
    .values({ weekStart, status: "approved", approvedAt: new Date() })
    .returning({ id: scheduleWeeksTable.id });
  await db.insert(scheduleApprovalsTable).values({ weekId: wk!.id, factoryId });
  // перше подання вже було (tue зм1) — воно «locked» у стані діалогу
  await db.insert(availabilityTable).values({
    fullNameRaw: "Jan Testowy", workerId, source: "telegram", weekStart,
    dayOfWeek: "tue", shift: "1", submittedAt: new Date(Date.now() - 3600_000),
  });
  setState(TID, "avail:filling", {
    weekStart, shiftCount: 3, lang: "uk", locked: ["tue-1"],
    responses: { mon: ["2"], tue: ["1"], wed: null, thu: null, fri: null, sat: null, sun: null },
  });

  await pressButton(TID, `avail_save_${weekStart}`);

  const rows = await db.select().from(availabilityTable).where(eq(availabilityTable.workerId, workerId));
  assert.equal(rows.length, 2, "only the NEW pair was inserted");
  const notifs = await db.select().from(notificationsTable);
  assert.equal(notifs.length, 1, "scheduler bell notification stored");
  assert.equal(notifs[0]!.type, "availability_change");
  assert.match(sentText(), /Диспозиційність/, "Telegram ping about the change went out");
  assert.match(sentText(), /затверджений\/розісланий/, "warning that the schedule is already in work");
});

// ── Мінімум днів доступності (factories.min_days_per_week) ────────────────────
test("availability confirm below the factory's min days is rejected and nothing is saved", opts, async () => {
  const { factoryId, workerId } = await seedWorkerWithFactory();
  await db.update(factoriesTable).set({ minDaysPerWeek: 3 }).where(eq(factoriesTable.id, factoryId));
  const weekStart = getNextMonday();
  setState(TID, "avail:filling", {
    weekStart, shiftCount: 3, lang: "uk", locked: [], minDays: 3, factoryName: "SchedFab",
    responses: { mon: ["1"], tue: ["2"], wed: null, thu: null, fri: null, sat: null, sun: null },
  });
  await pressButton(TID, `avail_confirm_${weekStart}`);
  assert.match(sentText(), /мінімум на \*3\* дні/, "explains the factory rule");
  assert.match(sentText(), /Ви обрали: \*2\*/, "shows how many days were picked");
  const rows = await db.select().from(availabilityTable).where(eq(availabilityTable.workerId, workerId));
  assert.equal(rows.length, 0, "nothing saved");
  // достатньо днів → зберігається (Ср..Нд вихідні → екран підтвердження вихідних → зберегти)
  resetSent();
  setState(TID, "avail:filling", {
    weekStart, shiftCount: 3, lang: "uk", locked: [], minDays: 3, factoryName: "SchedFab",
    responses: { mon: ["1"], tue: ["2"], wed: ["1"], thu: null, fri: null, sat: null, sun: null },
  });
  await pressButton(TID, `avail_confirm_${weekStart}`);
  assert.doesNotMatch(sentText(), /Замало днів/);
  await pressButton(TID, `avail_save_${weekStart}`);
  assert.equal((await db.select().from(availabilityTable).where(eq(availabilityTable.workerId, workerId))).length, 3);
});

test("availability toggle accepts shifts 4–6 (factory with 6 shifts)", opts, async () => {
  await seedWorkerWithFactory();
  const weekStart = getNextMonday();
  setState(TID, "avail:filling", {
    weekStart, shiftCount: 6, lang: "uk", locked: [],
    responses: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
  });
  await pressButton(TID, "avail_mon_5");
  const { getState } = await import("./state.ts");
  assert.deepEqual(getState(TID)?.data.responses.mon, ["5"]);
});
