import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, sendText, pressButton, resetSent, sentText } from "../test/botHarness.ts";
import { workersTable, advanceRequestsTable, absenceRequestsTable } from "../test/harness.ts";
import { setState } from "./state.ts";
import { eq } from "drizzle-orm";

// Worker-initiated requests: salary advance (adv:new → amount → comment) and absence
// (the reason step, seeded directly to avoid the time-gated shift list).
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const TID = "830100";

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

async function seedWorker() {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan", telegramId: TID, isActive: true }).returning({ id: workersTable.id });
  return w!.id;
}
const advances = (workerId: number) => db.select().from(advanceRequestsTable).where(eq(advanceRequestsTable.workerId, workerId));

test("advance: adv:new → amount → comment creates a pending request", opts, async () => {
  const workerId = await seedWorker();
  await pressButton(TID, "adv:new");
  await sendText(TID, "300");
  await sendText(TID, "na paliwo");
  const rows = await advances(workerId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.amount, 300);
  assert.equal(rows[0]!.status, "pending");
  assert.equal(rows[0]!.comment, "na paliwo");
});

test("advance: a '-' comment stores no note", opts, async () => {
  const workerId = await seedWorker();
  await pressButton(TID, "adv:new");
  await sendText(TID, "150,50");            // comma decimal
  await sendText(TID, "-");
  const [r] = await advances(workerId);
  assert.equal(r!.amount, 150.5);
  assert.equal(r!.comment, null);
});

test("advance: an amount over the 500 cap is rejected before any request is created", opts, async () => {
  const workerId = await seedWorker();
  await pressButton(TID, "adv:new");
  resetSent();
  await sendText(TID, "999");
  assert.match(sentText(), /500|макс|max/i);
  assert.equal((await advances(workerId)).length, 0);
});

test("advance: the once-per-day limit blocks a second request", opts, async () => {
  const workerId = await seedWorker();
  // first request (full flow)
  await pressButton(TID, "adv:new");
  await sendText(TID, "100");
  await sendText(TID, "-");
  assert.equal((await advances(workerId)).length, 1);
  // second attempt the same day
  resetSent();
  await pressButton(TID, "adv:new");
  assert.match(sentText(), /день|раз на день|limit|раз|день/i);
  assert.equal((await advances(workerId)).length, 1, "no second request is created");
});

test("absence: entering a reason for a whole day creates a pending request (shift NULL)", opts, async () => {
  const workerId = await seedWorker();
  setState(TID, "absence:enter_reason", { workerId, lang: "uk", weekStart: "2099-06-01", weekId: null, day: "mon", shift: null, entryId: null, dateLabel: "01.06" });
  await sendText(TID, "wesele");
  const rows = await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.workerId, workerId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.shift, null, "whole-day request has a null shift");
  assert.equal(rows[0]!.status, "pending");
  assert.equal(rows[0]!.reason, "wesele");
});

test("absence: entering a reason for a specific shift creates a pending request", opts, async () => {
  const workerId = await seedWorker();
  setState(TID, "absence:enter_reason", { workerId, lang: "uk", weekStart: "2099-06-01", weekId: 1, day: "tue", shift: "2", entryId: 1, dateLabel: "02.06" });
  await sendText(TID, "wizyta u lekarza");
  const [r] = await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.workerId, workerId));
  assert.equal(r!.shift, "2");
  assert.equal(r!.dayOfWeek, "tue");
  assert.equal(r!.status, "pending");
});

// ── Аванс: фінансова довідка адміну (services/workerBalance.ts) ───────────────
// Блок «Стан на сьогодні» бачить лише роль зі сторінкою /advances (owner — завжди);
// адмін без неї отримує запит без цифр.
test("advance: balance block goes only to admins with the /advances page", opts, async () => {
  const { adminsTable, rolesTable, factoriesTable } = await import("../test/harness.ts");
  const { sent } = await import("../test/botHarness.ts");
  const { invalidateRolesCache } = await import("../lib/auth.ts");
  const [f] = await db.insert(factoriesTable).values({ name: "BalFab", rateBrutto: 31.4, rateNetto: 25.35 }).returning({ id: factoriesTable.id });
  const [w] = await db.insert(workersTable).values({ fullName: "Jan", telegramId: TID, isActive: true, factoryId: f!.id }).returning({ id: workersTable.id });
  // незнята виплачена залічка — має зʼявитись у довідці
  await db.insert(advanceRequestsTable).values({ workerId: w!.id, amount: 120, status: "paid", createdAt: new Date(Date.now() - 40 * 86400_000) });
  await db.insert(rolesTable).values([
    // notify — опт-ін по ролі: без "advance" запит на аванс не дійде (див. notify-prefs.integration.test.ts)
    { key: "owner", label: "owner", caps: [], pages: [], notify: ["advance"] },
    { key: "clerk", label: "clerk", caps: ["editData"], pages: ["/schedule"], notify: ["advance"] },
  ]).onConflictDoNothing();
  invalidateRolesCache();
  await db.insert(adminsTable).values([
    { name: "Owner", role: "owner", telegramId: "777001" },
    { name: "Clerk", role: "clerk", telegramId: "777002" },
  ]);
  await pressButton(TID, "adv:new");
  await sendText(TID, "200");
  await sendText(TID, "-");
  const toOwner = sent.filter(s => String(s.chatId) === "777001").map(s => s.text ?? "").join("\n");
  const toClerk = sent.filter(s => String(s.chatId) === "777002").map(s => s.text ?? "").join("\n");
  assert.match(toOwner, /Запит на аванс/);
  assert.match(toOwner, /Стан на сьогодні/, "owner sees the balance block");
  assert.match(toOwner, /Залічки незняті: 120 zł \(1\)/, "undeducted paid advance is listed");
  assert.match(toOwner, /25.35 zł\/год нетто/, "factory net rate resolved");
  assert.match(toClerk, /Запит на аванс/);
  assert.doesNotMatch(toClerk, /Стан на сьогодні/, "role without /advances gets no financial data");
});

// ── Відпрошування: мінімум 48 год до зміни (03.09.2026, було 24) ─────────────
test("absence: a whole-day request closer than 48h is refused with the rule text", opts, async () => {
  const workerId = await seedWorker();
  const { nowWarsaw } = await import("./time.ts");
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const tomorrow = new Date(nowWarsaw()); tomorrow.setDate(tomorrow.getDate() + 1);
  const in4days = new Date(nowWarsaw()); in4days.setDate(in4days.getDate() + 4);
  setState(TID, "absence:pick", { workerId, lang: "uk", factoryId: null, items: [] });
  await pressButton(TID, `absday:${ymd(tomorrow)}`);
  assert.match(sentText(), /запізно/, "tomorrow (< 48h before a 06:00 shift) is refused");
  assert.match(sentText(), /48 годин/, "worker sees the rule");
  assert.equal((await db.select().from(absenceRequestsTable)).length, 0);
  resetSent();
  setState(TID, "absence:pick", { workerId, lang: "uk", factoryId: null, items: [] });
  await pressButton(TID, `absday:${ymd(in4days)}`);
  assert.match(sentText(), /причин/i, "4 days ahead → asks for the reason");
});

test("absence: the menu text and the day picker carry the 48h rule", opts, async () => {
  await seedWorker();
  await sendText(TID, "🏖 Взяти вихідний");
  assert.match(sentText(), /за 48 годин/);
  await pressButton(TID, "absother");
  assert.match(sentText(), /≥ 48 годин/);
});

test("advance balance: other deductions come from the svodni row (prev month) and deduction tables (current month)", opts, async () => {
  const { factoriesTable, svodniRowsTable, transportDeductionsTable } = await import("../test/harness.ts");
  const { computeWorkerBalance } = await import("../services/workerBalance.ts");
  const { nowWarsaw } = await import("./time.ts");
  const [f] = await db.insert(factoriesTable).values({ name: "DedFab", city: "Люблін", rateBrutto: 31.4, rateNetto: 25.35 }).returning({ id: factoriesTable.id });
  const [w] = await db.insert(workersTable).values({ fullName: "Jan", telegramId: TID, isActive: true, factoryId: f!.id }).returning({ id: workersTable.id });
  const now = nowWarsaw();
  const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const cur = ym(now), prev = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  await db.insert(svodniRowsTable).values({ periodMonth: prev, city: "Люблін", factoryLabel: "DedFab", factoryId: f!.id, workerId: w!.id, rawName: "Jan", potracenia: 50, hostel: 300, dojazd: 40, kaucja: 100, doWyplaty: 100, extras: { karaKlient: 25 } } as any);
  await db.insert(transportDeductionsTable).values({ periodMonth: cur, workerId: w!.id, factoryId: f!.id, amount: 60 });
  const b = (await computeWorkerBalance(w!.id, { factoryId: f!.id }))!;
  const byLabel = (m: string, label: string) => b.other.find(o => o.month === m && o.label === label)?.amount;
  if (now.getDate() <= 15) {
    assert.equal(byLabel(prev, "Potrącenia"), 50);
    assert.equal(byLabel(prev, "Hostel"), 300);
    assert.equal(byLabel(prev, "Dojazd"), 40);
    assert.equal(byLabel(prev, "Kaucja"), 100);
    assert.equal(byLabel(prev, "Kara klient"), 25);
  } else {
    assert.equal(b.other.filter(o => o.month === prev).length, 0, "prev month shown only on days 1–15");
  }
  assert.equal(byLabel(cur, "Dojazd"), 60, "current month without a svodni row → transport_deductions");
  assert.equal(b.estimate, (b.earnedTotal ?? 0) - b.otherTotal, "estimate subtracts other deductions");
});
