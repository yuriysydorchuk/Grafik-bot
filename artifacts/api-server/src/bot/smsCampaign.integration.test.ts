// Бот: ?start=sms<токен> → кандидат у воронці «SMS-кампанії» без питань, кнопки «Хочу на роботу»
// (лінк на анкету через passport-scan токен) і «Не зараз»; невалідний токен; повторний вхід не дублює.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, sendStart, pressButton, resetSent, sentText, sent } from "../test/botHarness.ts";
import { candidatesTable, factoriesTable, funnelsTable, smsRecipientsTable, smsEventsTable, passportScanTokensTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { createCampaign, importRecipients } from "../services/sms/campaigns.ts";

const opts = { skip: !hasTestDb };
beforeEach(async () => { if (hasTestDb) await resetDb(); resetSent(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function seed() {
  const [fac] = await db.insert(factoriesTable).values({ name: "ANDROS", city: "Lublin" } as any).returning();
  const c = await createCampaign({ name: "Хвиля 1", texts: { uk: "{імʼя}: {лінк}" }, offer: { factoryId: fac!.id, rate: "31 zl/год", housing: "від 450 zl", startDate: "27.10", phone: "+48 731 000 000" } }, null);
  await importRecipients(c.id, [{ phone: "+48573000214", name: "Oksana Melnychenko", lang: "uk", year: 2025 }]);
  const [rec] = await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.campaignId, c.id));
  return { c, rec: rec!, fac: fac! };
}

test("sms<токен>: кандидат створюється з імені/телефону/мови отримувача, привітання з пропозицією і кнопками", opts, async () => {
  const { c, rec } = await seed();
  await sendStart("700300", `sms${rec.token}`);
  assert.match(sentText(), /Вітаємо, \*Oksana\*/);
  assert.match(sentText(), /ANDROS/);
  assert.match(sentText(), /31 zl\/год/);
  const kb = sent.at(-1)?.extra?.reply_markup?.inline_keyboard?.flat().map((b: any) => b.callback_data) ?? [];
  assert.deepEqual(kb, [`sms:job:${rec.id}`, `sms:ref:${rec.id}`, `sms:later:${rec.id}`]);

  const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.telegramId, "700300"));
  assert.ok(cand);
  assert.equal(cand!.fullName, "Oksana Melnychenko");
  assert.equal(cand!.phone, "+48573000214");
  assert.equal(cand!.source, "sms");
  assert.equal(cand!.campaignId, c.id);
  assert.equal(cand!.language, "uk");
  assert.equal(cand!.stage, "new");
  const [f] = await db.select().from(funnelsTable).where(eq(funnelsTable.id, cand!.funnelId!));
  assert.equal(f?.kind, "sms");
  const r1 = (await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.id, rec.id)))[0]!;
  assert.equal(r1.status, "bot"); assert.equal(r1.candidateId, cand!.id); assert.ok(r1.botAt);
  assert.ok((await db.select().from(smsEventsTable).where(eq(smsEventsTable.recipientId, rec.id))).some((e) => e.kind === "bot_start"));

  // повторний /start тим самим лінком — кандидат не дублюється
  resetSent();
  await sendStart("700300", `sms${rec.token}`);
  assert.equal((await db.select().from(candidatesTable).where(eq(candidatesTable.telegramId, "700300"))).length, 1);

  // «Хочу на роботу» → passport-scan токен з candidateId і фабрикою кампанії
  resetSent();
  await pressButton("700300", `sms:job:${rec.id}`);
  assert.match(sentText(), /анкету/);
  const [tok] = await db.select().from(passportScanTokensTable).where(eq(passportScanTokensTable.telegramId, "700300"));
  assert.ok(tok);
  assert.equal(tok!.candidateId, cand!.id);
  assert.equal(tok!.purpose, "self");
  assert.equal(tok!.language, "uk");

  // «Не зараз»
  resetSent();
  await pressButton("700300", `sms:later:${rec.id}`);
  assert.match(sentText(), /Добре, \*Oksana\*/);
  // «Приведу друга» без worker_id → пропонує спершу оформитись
  resetSent();
  await pressButton("700300", `sms:ref:${rec.id}`);
  assert.match(sentText(), /Реферальний бонус/);
});

test("sms<токен>: невалідний токен — двомовна відмова, нічого не створюється", opts, async () => {
  await sendStart("700301", "smsNOPE");
  assert.match(sentText(), /недійсне/);
  assert.match(sentText(), /Invalid link/);
  assert.equal((await db.select().from(candidatesTable)).length, 0);
});

test("sms<токен>: мова ru/en — привітання відповідною мовою", opts, async () => {
  const [fac] = await db.insert(factoriesTable).values({ name: "LST", city: "Lublin" } as any).returning();
  const c = await createCampaign({ name: "Хвиля EN", texts: { en: "{name}: {link}" }, offer: { factoryId: fac!.id } }, null);
  await importRecipients(c.id, [{ phone: "+48573000215", name: "Blessing Moyo", lang: "en", year: 2025 }]);
  const [rec] = await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.campaignId, c.id));
  await sendStart("700302", `sms${rec!.token}`);
  assert.match(sentText(), /Hi \*Blessing\*/);
  const labels = sent.at(-1)?.extra?.reply_markup?.inline_keyboard?.flat().map((b: any) => b.text) ?? [];
  assert.ok(labels.includes("✅ I want the job"), labels.join("|"));
});
