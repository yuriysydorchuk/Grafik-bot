// Автоматика SMS-кампаній (батч 4): групова автозадача sms_no_bot (вікно lead…lead+7 дн,
// auto_resolved коли нікого), нагадування через 24 год без анкети (одне), денний звіт у бот
// за типом `sms` (лише ролям з увімкненим типом), «приведи друга» активним через бот.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, sent, resetSent, sentText } from "../../test/botHarness.ts";
import { seedAdmin, seedRole, workersTable, candidatesTable, smsRecipientsTable, smsEventsTable, tasksTable } from "../../test/harness.ts";
import { and, eq } from "drizzle-orm";
import { createCampaign, importRecipients, setCampaignStatus } from "./campaigns.ts";
import { smsNoBotCandidates, sendSmsReminders, sendSmsDailyReport, notifyActiveWorkersReferral, pendingActiveWorkers } from "./automation.ts";
import { runAutoTasks } from "../taskAutoRules.ts";

const opts = { skip: !hasTestDb };
beforeEach(async () => { if (hasTestDb) await resetDb(); resetSent(); });
after(async () => { if (hasTestDb) await closeDb(); });

const ago = (h: number) => new Date(Date.now() - h * 3600_000);

async function seed() {
  const c = await createCampaign({ name: "Хвиля 1", texts: { uk: "{імʼя}: {лінк}" }, offer: { rate: "31 zl/год" } }, null);
  await setCampaignStatus(c.id, "sending");
  await importRecipients(c.id, [
    { phone: "+48573000214", name: "Oksana Melnychenko", lang: "uk", year: 2025 },
    { phone: "+48729000880", name: "Dmytro Shevchuk", lang: "ru", year: 2024 },
    { phone: "+48501000336", name: "Nazar Bondar", lang: "uk", year: 2023 },
  ]);
  const recs = await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.campaignId, c.id)).orderBy(smsRecipientsTable.id);
  return { c, recs };
}

test("sms_no_bot: групова задача на кампанію з людьми у вікні 2–9 днів, auto_resolved коли вікно спорожніло", opts, async () => {
  const { c, recs } = await seed();
  const [a, b, d] = recs;
  // a — відкрив 3 дні тому (у вікні), b — вчора (ще рано), d — зайшов у бот (не рахується)
  await db.update(smsRecipientsTable).set({ status: "viewed", sentAt: ago(80), viewedAt: ago(72) }).where(eq(smsRecipientsTable.id, a!.id));
  await db.update(smsRecipientsTable).set({ status: "cta", sentAt: ago(30), viewedAt: ago(20) }).where(eq(smsRecipientsTable.id, b!.id));
  await db.update(smsRecipientsTable).set({ status: "bot", sentAt: ago(80), viewedAt: ago(75), botAt: ago(70) }).where(eq(smsRecipientsTable.id, d!.id));
  const cands = await smsNoBotCandidates("2026-09-21", 2);
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.sourceKey, `smsnb:${c.id}`);
  assert.match(cands[0]!.title, /1 відкрили сторінку/);
  assert.match(cands[0]!.description, /Oksana Melnychenko · \+48573000214 · uk/);
  assert.doesNotMatch(cands[0]!.description, /Dmytro/);

  // нічний прогін створює задачу; коли людина зайшла в бот — задача auto_resolved
  await runAutoTasks("2026-09-21");
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.sourceKey, `smsnb:${c.id}`));
  assert.ok(task); assert.equal(task!.status, "open"); assert.equal(task!.source, "auto:sms_no_bot");
  assert.match(task!.description ?? "", /\/r\/[0-9A-Z]{8}/);
  await db.update(smsRecipientsTable).set({ status: "bot", botAt: new Date() }).where(eq(smsRecipientsTable.id, a!.id));
  await runAutoTasks("2026-09-22");
  const [after1] = await db.select().from(tasksTable).where(eq(tasksTable.id, task!.id));
  assert.equal(after1!.status, "auto_resolved");
});

test("нагадування через 24 год: лише статус bot 24–72 год, є Telegram кандидата, одне на людину", opts, async () => {
  const { c, recs } = await seed();
  const [a, b, d] = recs;
  const mk = async (rec: typeof a, tid: string, botAt: Date, status = "bot") => {
    const [cand] = await db.insert(candidatesTable).values({ funnelId: c.funnelId!, fullName: rec!.name!, telegramId: tid, phone: rec!.phone, stage: "new", source: "sms", campaignId: c.id, language: rec!.lang }).returning();
    await db.update(smsRecipientsTable).set({ status, sentAt: ago(100), botAt, candidateId: cand!.id }).where(eq(smsRecipientsTable.id, rec!.id));
  };
  await mk(a, "9001", ago(30));           // нагадати
  await mk(b, "9002", ago(5));            // ще рано
  await mk(d, "9003", ago(40), "form");   // анкету вже заповнив
  assert.equal(await sendSmsReminders(), 1);
  assert.equal(sent.length, 1);
  assert.equal(String(sent[0]!.chatId), "9001");
  assert.match(sentText(), /Oksana/);
  const kb = sent[0]!.extra?.reply_markup?.inline_keyboard?.flat().map((x: any) => x.callback_data);
  assert.deepEqual(kb, [`sms:job:${a!.id}`, `sms:later:${a!.id}`]);
  const ev = await db.select().from(smsEventsTable).where(and(eq(smsEventsTable.recipientId, a!.id), eq(smsEventsTable.kind, "remind")));
  assert.equal(ev.length, 1);
  resetSent();
  assert.equal(await sendSmsReminders(), 0); // повторно не шле
});

test("денний звіт: іде адмінам, у ролі яких увімкнено тип sms; кампанії без відправок сьогодні — не згадуються", opts, async () => {
  const { c, recs } = await seed();
  await seedRole("owner", [], [], ["sms"]);
  await seedRole("scheduler", ["editData"], ["/sms-campaigns"], ["tasks"]);
  await seedAdmin({ role: "owner", isMain: true });
  await seedAdmin({ role: "scheduler" });
  const [a, b] = recs;
  await db.update(smsRecipientsTable).set({ status: "delivered", sentAt: new Date(), deliveredAt: new Date() }).where(eq(smsRecipientsTable.id, a!.id));
  await db.update(smsRecipientsTable).set({ status: "viewed", sentAt: new Date(), deliveredAt: new Date(), viewedAt: new Date() }).where(eq(smsRecipientsTable.id, b!.id));
  const other = await createCampaign({ name: "Стара", texts: { uk: "x {лінк}" } }, null);
  await importRecipients(other.id, [{ phone: "+48601000777", name: "Old Guy", lang: "uk", year: 2020 }]);
  await db.update(smsRecipientsTable).set({ status: "sent", sentAt: ago(50) }).where(eq(smsRecipientsTable.campaignId, other.id));
  assert.equal(await sendSmsDailyReport(), 1);
  assert.equal(sent.length, 1, "лише owner (роль з типом sms)");
  assert.match(sentText(), /Хвиля 1/);
  assert.match(sentText(), /відправлено 2, не доставлено 0, доставлено 2 \(100%\), відкрили 1 \(50%\)/);
  assert.doesNotMatch(sentText(), /Стара/);
  assert.equal(c.name, "Хвиля 1");
});

test("«приведи друга» активним: лише пропущені active_worker з worker_id, через бот, один раз", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Anna Kravets", status: "active", telegramId: "5005", language: "uk" } as any).returning();
  const c = await createCampaign({ name: "Хвиля 1", texts: { uk: "{імʼя}: {лінк}" } }, null);
  const sum = await importRecipients(c.id, [{ phone: "+48573000214", name: "Anna Kravets", lang: "uk", year: 2025 }, { phone: "+48729000880", name: "Dmytro Shevchuk", lang: "ru", year: 2024 }]);
  assert.equal(sum.activeWorkers, 1);
  assert.equal(await pendingActiveWorkers(c.id), 1);
  const r = await notifyActiveWorkersReferral(c.id);
  assert.equal(r.notified, 1); assert.equal(r.pending, 1);
  assert.equal(String(sent.at(-1)!.chatId), "5005");
  assert.equal(await pendingActiveWorkers(c.id), 0);
  assert.equal((await notifyActiveWorkersReferral(c.id)).notified, 0);
  assert.ok(w);
});
