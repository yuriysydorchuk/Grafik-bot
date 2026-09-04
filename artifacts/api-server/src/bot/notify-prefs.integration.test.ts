import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, sent, sendText, pressButton, resetSent } from "../test/botHarness.ts";
import { workersTable, adminsTable, rolesTable, absenceRequestsTable } from "../test/harness.ts";
import { invalidateRolesCache } from "../lib/auth.ts";
import { setState } from "./state.ts";
import { notifyAdmins, notifyAdminsFile, notifyRoles } from "./notify.ts";

// Офісні сповіщення бота мусять поважати roles.notify: адмін отримує подію лише якщо
// її тип увімкнений у його ролі. Регресія 09.2026: notifyAdmins слав усім адмінам
// незалежно від налаштувань, тож «вимкнені» сповіщення далі доходили.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const TID = "830200";
const ALL_ON = "990001";   // роль з усіма типами
const MUTED = "990002";    // роль з порожнім notify (усе вимкнено)
const ONLY_ADV = "990003"; // роль лише з "advance"
const DRIVER = "990004";   // веб-роль driver — офісних сповіщень не отримує ніколи

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

// resetDb truncates roles, so the seed is a plain insert (owner/driver are the system keys).
async function seedAdmins() {
  await db.insert(rolesTable).values([
    { key: "owner", label: "owner", caps: [], pages: [], notify: ["no_show", "cancellation", "hours_correction", "advance", "substitution", "availability_change"] },
    { key: "muted", label: "muted", caps: ["editData"], pages: ["/schedule"], notify: [] },
    { key: "advonly", label: "advonly", caps: ["editData"], pages: ["/advances"], notify: ["advance"] },
    // навіть з увімкненими типами: driver — не офіс, adminWantsNotify відсікає роль
    { key: "driver", label: "driver", caps: [], pages: ["/driver-shifts"], notify: ["no_show", "advance"] },
  ]);
  invalidateRolesCache();
  await db.insert(adminsTable).values([
    { name: "AllOn", role: "owner", telegramId: ALL_ON },
    { name: "Muted", role: "muted", telegramId: MUTED },
    { name: "AdvOnly", role: "advonly", telegramId: ONLY_ADV },
    { name: "Drv", role: "driver", telegramId: DRIVER },
  ]);
}
const to = (tid: string) => sent.filter(s => String(s.chatId) === tid);

test("notifyAdmins: only roles with the type enabled receive it; driver never does", opts, async () => {
  await seedAdmins();
  await notifyAdmins("no_show", "⚠️ test no_show");
  assert.equal(to(ALL_ON).length, 1);
  assert.equal(to(MUTED).length, 0, "role with everything unchecked gets nothing");
  assert.equal(to(ONLY_ADV).length, 0, "type not in the role's list");
  assert.equal(to(DRIVER).length, 0, "web driver role is never office staff");

  resetSent();
  await notifyAdmins("advance", "💰 test advance");
  assert.equal(to(ALL_ON).length, 1);
  assert.equal(to(ONLY_ADV).length, 1, "the one type it opted into");
  assert.equal(to(MUTED).length, 0);
  assert.equal(to(DRIVER).length, 0);
});

test("notifyAdminsFile: same gating as notifyAdmins", opts, async () => {
  await seedAdmins();
  await notifyAdminsFile("no_show", "FILE1", "photo", "📎 doc");
  assert.equal(to(ALL_ON).filter(s => s.method === "sendPhoto").length, 1);
  assert.equal(to(MUTED).length, 0);
  assert.equal(to(ONLY_ADV).length, 0);
  assert.equal(to(DRIVER).length, 0);
});

test("notifyRoles: adminsNotified suppresses the Telegram duplicate but keeps the bell", opts, async () => {
  await seedAdmins();
  const { notificationsTable } = await import("@workspace/db");
  await notifyRoles("scheduler", { type: "advance", title: "💰 short", adminsNotified: true });
  assert.equal(sent.length, 0, "no Telegram at all — detailed message was already sent via notifyAdmins");
  assert.equal((await db.select().from(notificationsTable)).length, 1, "on-site bell row is still written");

  // without the flag (events that have no detailed twin) Telegram still goes by prefs
  await notifyRoles("scheduler", { type: "advance", title: "💰 short" });
  assert.equal(to(ALL_ON).length, 1);
  assert.equal(to(ONLY_ADV).length, 1);
  assert.equal(to(MUTED).length, 0);
});

// Наскрізь через реальні хендлери: запит на аванс і відміна зміни працівником.
test("worker advance request: one message per admin, only where 'advance' is enabled", opts, async () => {
  await seedAdmins();
  await db.insert(workersTable).values({ fullName: "Jan", telegramId: TID, isActive: true });
  await pressButton(TID, "adv:new");
  await sendText(TID, "200");
  resetSent();
  await sendText(TID, "-");
  assert.equal(to(ALL_ON).filter(s => /Запит на аванс/.test(s.text ?? "")).length, 1, "exactly one (no duplicate short+detailed)");
  assert.equal(to(ONLY_ADV).filter(s => /Запит на аванс/.test(s.text ?? "")).length, 1);
  assert.equal(to(MUTED).length, 0);
  assert.equal(to(DRIVER).length, 0);
});

test("worker shift cancellation: goes only to roles with 'cancellation'", opts, async () => {
  await seedAdmins();
  const [w] = await db.insert(workersTable).values({ fullName: "Jan", telegramId: TID, isActive: true }).returning({ id: workersTable.id });
  setState(TID, "absence:enter_reason", { workerId: w!.id, lang: "uk", weekStart: "2099-06-01", weekId: null, day: "mon", shift: null, entryId: null, dateLabel: "01.06" });
  resetSent();
  await sendText(TID, "wesele");
  assert.equal((await db.select().from(absenceRequestsTable)).length, 1);
  assert.equal(to(ALL_ON).filter(s => /вихідний/i.test(s.text ?? "")).length, 1, "one message, with buttons");
  assert.ok(to(ALL_ON)[0]!.extra?.reply_markup?.inline_keyboard, "the detailed one with approve/reject buttons");
  assert.equal(to(ONLY_ADV).length, 0, "'advance'-only role does not get cancellations");
  assert.equal(to(MUTED).length, 0);
  assert.equal(to(DRIVER).length, 0);
});
