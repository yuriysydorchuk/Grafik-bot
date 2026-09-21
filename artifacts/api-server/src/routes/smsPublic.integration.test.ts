// Публічний SMS-лінк /api/r/:token: дані сторінки + подія «переглянув», кнопки → події, невалідний токен → 404.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { resetDb, db, app, closeDb, factoriesTable, smsRecipientsTable, smsEventsTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { createCampaign, importRecipients } from "../services/sms/campaigns.ts";

const SKIP = !process.env.TEST_DATABASE_URL;
before(async () => { if (!SKIP) await resetDb(); });
beforeEach(async () => { if (!SKIP) await resetDb(); });
after(async () => { if (!SKIP) await closeDb(); });

test("GET /api/r/:token — сторінка, подія view, кнопки → cta; без сесії", { skip: SKIP }, async () => {
  process.env.TELEGRAM_BOT_USERNAME = "ES_test_bot";
  const [fac] = await db.insert(factoriesTable).values({ name: "AGRAM LUBLIN", city: "Lublin" } as any).returning();
  const c = await createCampaign({ name: "Хвиля 1", texts: { uk: "{імʼя}: {лінк}" }, offer: { factoryId: fac!.id, rate: "31 zł/год", housing: "від 450 zł", phone: "+48 731 000 000" } }, null);
  await importRecipients(c.id, [{ phone: "+48573000214", name: "Oksana Melnychenko", lang: "uk", year: 2025 }]);
  const [rec] = await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.campaignId, c.id));

  const r = await request(app).get(`/api/r/${rec!.token}`).set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
  assert.equal(r.status, 200);
  assert.equal(r.body.firstName, "Oksana");
  assert.equal(r.body.lang, "uk");
  assert.equal(r.body.offer.factoryName, "AGRAM LUBLIN");
  assert.equal(r.body.offer.city, "Lublin");
  assert.equal(r.body.offer.phone, "+48 731 000 000");
  assert.equal(r.body.telegram, `https://t.me/ES_test_bot?start=sms${rec!.token}`);
  assert.equal(r.body.closed, false);
  assert.equal(JSON.stringify(r.body).includes("+48573000214"), false); // телефон отримувача на сторінку не віддаємо

  const after1 = (await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.id, rec!.id)))[0]!;
  assert.equal(after1.status, "viewed"); assert.ok(after1.viewedAt);

  const e = await request(app).get(`/api/r/${rec!.token}/e?k=cta_bot`);
  assert.equal(e.status, 204);
  const after2 = (await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.id, rec!.id)))[0]!;
  assert.equal(after2.status, "cta");
  const kinds = (await db.select().from(smsEventsTable).where(eq(smsEventsTable.recipientId, rec!.id))).map((x) => x.kind);
  assert.deepEqual(kinds, ["view", "cta_bot"]);
  const ev = (await db.select().from(smsEventsTable).where(eq(smsEventsTable.recipientId, rec!.id)))[0]!;
  assert.match(ev.device ?? "", /iPhone|iOS|Mobile/i);

  // невідома подія і поганий токен — тихо 204/404
  assert.equal((await request(app).get(`/api/r/${rec!.token}/e?k=hack`)).status, 204);
  assert.equal((await request(app).get(`/api/r/NOPE`)).status, 404);
  assert.equal((await request(app).get(`/api/r/${"A".repeat(24)}`)).status, 404);
  // токен у нижньому регістрі теж працює (людина набрала руками)
  assert.equal((await request(app).get(`/api/r/${rec!.token.toLowerCase()}`)).status, 200);
});
