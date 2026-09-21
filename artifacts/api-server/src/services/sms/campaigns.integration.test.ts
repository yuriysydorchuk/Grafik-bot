// Інтеграційні тести SMS-кампаній: імпорт з дедупом і відокремленням активних працівників,
// відправка батчем з мок-провайдером у вікні/поза вікном, денний ліміт, статуси доставки.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { resetDb, db, workersTable, workerQuestionnairesTable, smsRecipientsTable, smsEventsTable, funnelsTable, closeDb } from "../../test/harness.ts";
import { eq } from "drizzle-orm";
import { createCampaign, importRecipients, campaignStats, ensureSmsFunnel, renderForRecipient, findRecipientByToken, advanceRecipient } from "./campaigns.ts";
import { sendCampaignBatch, pollSmsStatuses, inSendWindow, setSmsProviderForTests } from "./index.ts";
import type { SmsProvider, SendItem } from "./provider.ts";

const SKIP = !process.env.TEST_DATABASE_URL;

function mockProvider(opts: { failPhones?: string[]; delivered?: string[] } = {}): SmsProvider & { sent: SendItem[] } {
  const sent: SendItem[] = [];
  return {
    name: "smsapi", sent,
    configured: () => true,
    price: (p) => (p.startsWith("+48") ? 0.1 : 0.85),
    async send(items) { sent.push(...items); return items.map((it) => opts.failPhones?.includes(it.phone) ? { recipientId: it.recipientId, ok: false, error: "invalid number" } : { recipientId: it.recipientId, ok: true, msgId: `m-${it.recipientId}`, parts: 2 }); },
    async status(ids) { return ids.map((id) => ({ msgId: id, status: (opts.delivered ?? []).includes(id) ? "delivered" : "pending" } as const)); },
  };
}

before(async () => { if (!SKIP) await resetDb(); });
beforeEach(async () => { if (!SKIP) await resetDb(); });
after(async () => { setSmsProviderForTests(null); if (!SKIP) await closeDb(); });

test("inSendWindow: дні тижня і години Варшави", () => {
  const sched = { days: [2, 3, 4], from: "10:00", to: "14:00", dailyLimit: 1500, batchSize: 200 };
  assert.equal(inSendWindow(sched, new Date("2026-10-20T09:30:00Z")), true);  // вт 11:30 Warsaw (UTC+2)
  assert.equal(inSendWindow(sched, new Date("2026-10-20T12:30:00Z")), false); // вт 14:30
  assert.equal(inSendWindow(sched, new Date("2026-10-19T09:30:00Z")), false); // пн
  assert.equal(inSendWindow({ ...sched, days: [] }, new Date("2026-10-19T09:30:00Z")), true); // без обмеження днів
});

test("імпорт: дедуп, невалідні, активні працівники → skipped, UA лише від 2024", { skip: SKIP }, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Anna Kravets", status: "active" }).returning();
  await db.insert(workerQuestionnairesTable).values({ workerId: w!.id, phone: "+48 536 000 703" });
  const [w2] = await db.insert(workersTable).values({ fullName: "Bohdan Tkachenko", status: "active" }).returning();
  const c = await createCampaign({ name: "Тест", texts: { uk: "{імʼя}, робота: {лінк}" } }, null);
  const sum = await importRecipients(c.id, [
    { phone: "573 000 214", name: "Oksana Melnychenko", lang: "uk", year: 2025 },
    { phone: "+48573000214", name: "Oksana M." },                          // дубль
    { phone: "12345", name: "Junk" },                                       // невалідний
    { phone: "+48814632323", name: "Biuro Firmy" },                         // стаціонарний
    { phone: "+48536000703", name: "Anna K." },                             // активна за телефоном анкети
    { phone: "+48729000880", name: "Tkachenko Bohdan" },                    // активний за іменем (порядок слів)
    { phone: "+380671239567", name: "Іван Петренко", lang: "uk", year: 2021 }, // UA старий → виключено
    { phone: "+380671239568", name: "Марія Коваль", lang: "uk?", year: 2025 }, // UA свіжий → ок
    { phone: "+971527730372", name: "Shamroz", lang: "en" },                // закордон
  ]);
  assert.equal(sum.added, 2);
  assert.equal(sum.activeWorkers, 2);
  assert.equal(sum.skipped.duplicate, 1);
  assert.equal(sum.skipped.ua_excluded, 1);
  assert.equal(sum.skipped.foreign, 1);
  assert.equal(sum.skipped.invalid, 2);
  const rows = await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.campaignId, c.id));
  const anna = rows.find((r) => r.phone === "+48536000703")!;
  assert.equal(anna.status, "skipped"); assert.equal(anna.skippedReason, "active_worker"); assert.equal(anna.workerId, w!.id);
  assert.equal(rows.find((r) => r.phone === "+48729000880")!.workerId, w2!.id);
  const oks = rows.find((r) => r.phone === "+48573000214")!;
  assert.equal(oks.status, "queued"); assert.equal(oks.firstName, "Oksana"); assert.equal(oks.token.length, 24);
  assert.equal(rows.find((r) => r.phone === "+380671239568")!.lang, "uk");
  const st = await campaignStats(c);
  assert.equal(st.recipients, 2); assert.equal(st.queued, 2); assert.equal(st.skipped, 5); assert.equal(st.activeWorkers, 2); // дубль і номер без цифр не вставляються
  const f = (await db.select().from(funnelsTable).where(eq(funnelsTable.kind, "sms")))[0];
  assert.ok(f); assert.equal(await ensureSmsFunnel(), f!.id);
});

test("відправка: поза вікном нічого, у вікні батч з лімітом, помилка → failed, статуси → delivered", { skip: SKIP }, async () => {
  process.env.SMS_LINK_BASE = "https://es-job.pl";
  const prov = mockProvider({ failPhones: ["+48573000299"], delivered: ["m-1", "m-2"] });
  setSmsProviderForTests(prov);
  const c = await createCampaign({ name: "Хвиля", texts: { uk: "{імʼя}, робота: {лінк}", en: "{name}, job: {link}" }, schedule: { days: [2], from: "10:00", to: "14:00", dailyLimit: 3, batchSize: 2 } }, null);
  await importRecipients(c.id, [
    { phone: "+48573000201", name: "Oksana One", lang: "uk" }, { phone: "+48573000202", name: "Two Person", lang: "en" },
    { phone: "+48573000203", name: "Three Person", lang: "uk" }, { phone: "+48573000299", name: "Bad Number", lang: "uk" },
  ]);
  await db.update(smsRecipientsTable).set({ status: "queued" }).where(eq(smsRecipientsTable.campaignId, c.id));
  const cSending = { ...c, status: "sending" as const };
  // поза вікном (понеділок)
  assert.deepEqual(await sendCampaignBatch(cSending, { now: new Date("2026-10-19T09:30:00Z") }), { sent: 0, failed: 0, remaining: -1 });
  assert.equal(prov.sent.length, 0);
  // вівторок у вікні: батч 2
  const r1 = await sendCampaignBatch(cSending, { now: new Date("2026-10-20T09:30:00Z") });
  assert.equal(r1.sent, 2); assert.equal(r1.remaining, 2);
  assert.match(prov.sent[0]!.text, /^Oksana, робота: https:\/\/es-job\.pl\/r\/[0-9A-Z]{24}$/);
  assert.equal(prov.sent[1]!.text.startsWith("Two, job: "), true);
  // денний ліміт 3 → лише 1 у наступному батчі; один з них падає
  const r2 = await sendCampaignBatch(cSending, { now: new Date("2026-10-20T10:30:00Z") });
  assert.equal(r2.sent + r2.failed, 1);
  const r3 = await sendCampaignBatch(cSending, { now: new Date("2026-10-20T11:30:00Z") });
  assert.equal(r3.sent, 0); // ліміт вичерпано
  const rows = await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.campaignId, c.id));
  assert.equal(rows.filter((r) => r.status === "sent").length + rows.filter((r) => r.status === "failed").length, 3);
  assert.equal(rows.filter((r) => r.parts === 2).length >= 2, true);
  // статуси доставки
  const st = await pollSmsStatuses();
  assert.equal(st.delivered, 2);
  const events = await db.select().from(smsEventsTable);
  assert.ok(events.some((e) => e.kind === "sent") && events.some((e) => e.kind === "delivered"));
  const stats = await campaignStats(c);
  assert.equal(stats.delivered, 2); assert.equal(stats.costEstimate, 0.6); // 3 відправки × 2 частини × 0,10 — одна failed без parts
  // токен → отримувач, просування воронки лише вперед
  const tok = rows[0]!.token;
  const found = await findRecipientByToken(tok);
  assert.equal(found?.campaign.id, c.id);
  await advanceRecipient(rows[0]!.id, "viewed", { viewedAt: new Date() });
  await advanceRecipient(rows[0]!.id, "delivered");
  assert.equal((await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.id, rows[0]!.id)))[0]!.status, "viewed");
  // текст для отримувача без імені
  const t = renderForRecipient(c, { lang: "uk", firstName: null, name: null, token: "X".repeat(24) });
  assert.equal(t.text.startsWith("робота: "), true);
});
