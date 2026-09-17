import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, sendStart, sendText, pressButton, resetSent, sentText, sent } from "../test/botHarness.ts";
import { workersTable, candidatesTable, factoriesTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { ensureReferralCode, normalizeReferralCode } from "../lib/referral.ts";

// Реферальний deep-link по коду ES-XXXXX (кампанія «приведи друга», 17.09.2026):
// звільнений реферер теж запрошує; старий числовий ?start=ref<id> лишається робочим.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

async function seedReferrer(isActive: boolean) {
  const [f] = await db.insert(factoriesTable).values({ name: "Fabryka R" }).returning({ id: factoriesTable.id });
  const [w] = await db.insert(workersTable).values({
    fullName: "Anna Referent", telegramId: "700100", factoryId: f!.id, isActive, status: isActive ? "active" : "fired",
    firedAt: isActive ? null : new Date(),
  } as any).returning({ id: workersTable.id });
  const code = await ensureReferralCode(w!.id);
  return { id: w!.id, code };
}

async function applyAsFriend(startPayload: string) {
  await sendStart("700200", startPayload);
  resetSent();
  await pressButton("700200", "setlang:uk");
  assert.match(sentText(), /Вас запросив\(ла\) \*Anna Referent\*/);
  resetSent();
  await sendText("700200", "Piotr Nowy");
  assert.match(sentText(), /номер телефону/i);
  resetSent();
  await sendText("700200", "+48 600 000 000");
  assert.match(sentText(), /Дякуємо, \*Piotr Nowy\*/);
}

test("ref<код>: звільнений реферер — кандидат створюється з referrer, бонусом 200 і сповіщенням рефереру", opts, async () => {
  const r = await seedReferrer(false);
  assert.match(r.code, /^ES-[0-9A-HJKMNP-TV-Z]{5}$/);
  await applyAsFriend(`ref${r.code}`);
  const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.telegramId, "700200"));
  assert.equal(c?.referrerWorkerId, r.id);
  assert.equal(c?.fullName, "Piotr Nowy");
  assert.equal(c?.phone, "+48 600 000 000");
  assert.equal(c?.bonusAmount, 200);
  // реферер (звільнений, без меню) все одно отримує сповіщення в свій чат
  assert.ok(sent.some(s => String(s.chatId) === "700100" && /зареєструвався/.test(s.text ?? "")), "referrer notified");
});

test("ref<код>: регістр і пробіли в коді не заважають", opts, async () => {
  const r = await seedReferrer(true);
  await applyAsFriend(`ref${r.code.toLowerCase()}`);
  const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.telegramId, "700200"));
  assert.equal(c?.referrerWorkerId, r.id);
});

test("ref<id> (старий числовий лінк) далі працює", opts, async () => {
  const r = await seedReferrer(true);
  await applyAsFriend(`ref${r.id}`);
  const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.telegramId, "700200"));
  assert.equal(c?.referrerWorkerId, r.id);
});

test("ref<невідомий код>: відмова без стану", opts, async () => {
  await seedReferrer(true);
  await sendStart("700200", "refES-ZZZZZ");
  assert.match(sentText(), /недійсне/);
  assert.equal((await db.select().from(candidatesTable)).length, 0);
});

test("camp:submit — працівник (звільнений) сам подає кандидата: імʼя → телефон → кандидат з реферером і бонусом", opts, async () => {
  const r = await seedReferrer(false);
  await pressButton("700100", "camp:submit");
  assert.match(sentText(), /імʼя та прізвище/i);
  resetSent();
  await sendText("700100", "Олег Тест");
  assert.match(sentText(), /латиницею/i);
  resetSent();
  await sendText("700100", "Oleh Test");
  assert.match(sentText(), /номер телефону/i);
  resetSent();
  await sendText("700100", "123");
  assert.match(sentText(), /кодом країни/i);
  resetSent();
  await sendText("700100", "+48 601 000 000");
  assert.match(sentText(), /додано як вашого кандидата/);
  const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.phone, "+48 601 000 000"));
  assert.equal(c?.referrerWorkerId, r.id);
  assert.equal(c?.fullName, "Oleh Test");
  assert.equal(c?.bonusAmount, 200);
  // повторна подача того ж номера — дубль не створюється
  resetSent();
  await pressButton("700100", "camp:submit");
  await sendText("700100", "Oleh Test");
  await sendText("700100", "48601000000");
  assert.match(sentText(), /уже є в списку/);
  assert.equal((await db.select().from(candidatesTable)).length, 1);
});

test("друг, поданий працівником, потім реєструється сам з тим же номером → одна картка з Telegram", opts, async () => {
  const r = await seedReferrer(true);
  await pressButton("700100", "camp:submit");
  await sendText("700100", "Oleh Test");
  await sendText("700100", "+48 601 000 000");
  await applyAsFriend(`ref${r.code}`); // applyAsFriend вводить "+48 600 000 000" — інший номер → друга картка
  assert.equal((await db.select().from(candidatesTable)).length, 2);
  // а той самий номер (інше форматування) — привʼязка до наявної картки
  await sendStart("700300", `ref${r.code}`);
  await pressButton("700300", "setlang:uk");
  await sendText("700300", "Oleh Test");
  resetSent();
  await sendText("700300", "48-601-000-000");
  assert.match(sentText(), /Дякуємо/);
  const all = await db.select().from(candidatesTable);
  assert.equal(all.length, 2);
  assert.equal(all.find(c => c.phone === "+48 601 000 000")?.telegramId, "700300");
});

test("camp:friend — текст для друга приходить окремим повідомленням з URL-кнопкою на deep-link", opts, async () => {
  const r = await seedReferrer(true);
  await pressButton("700100", "camp:friend");
  const friend = sent.find(s => /Euro Support/.test(s.text ?? ""));
  assert.ok(friend, "friend message sent");
  const url = friend!.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.url ?? "";
  assert.match(url, new RegExp(`start=ref${r.code}$`));
});

test("normalizeReferralCode: телефонні варіанти написання", () => {
  assert.equal(normalizeReferralCode(" es 7k3mx "), "ES-7K3MX");
  assert.equal(normalizeReferralCode("ES-7K3MX"), "ES-7K3MX");
  assert.equal(normalizeReferralCode("7K3MX"), "ES-7K3MX");
  assert.equal(normalizeReferralCode("ES123"), "ES-ES123"); // код, що сам починається з ES, без префікса
  assert.equal(normalizeReferralCode("es-es123"), "ES-ES123");
  assert.equal(normalizeReferralCode(""), "");
});
