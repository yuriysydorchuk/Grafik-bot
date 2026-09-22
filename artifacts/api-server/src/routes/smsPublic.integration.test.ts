// Публічний SMS-лінк /api/r/:token: дані сторінки + подія «переглянув», кнопки → події, невалідний токен → 404.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { resetDb, db, app, closeDb, factoriesTable, smsRecipientsTable, smsEventsTable, candidatesTable } from "../test/harness.ts";
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
  assert.equal(r.body.offer.factoryName, undefined); assert.equal(r.body.campaign, undefined); // назва клієнта/кампанії назовні не йде
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
  // «Мені цікаво» — головна конверсія без форми: подія, статус cta, сторінка далі знає interested=true; повтор не дублює
  assert.equal((await request(app).get(`/api/r/${rec!.token}/e?k=interested&v=offer`)).status, 204);
  assert.equal((await request(app).get(`/api/r/${rec!.token}/e?k=interested&v=offer`)).status, 204);
  // «мене цікавить» = заявка: кандидат у воронці SMS зі стадією new, один на людину, повтор — активність
  const leads = await db.select().from(candidatesTable).where(eq(candidatesTable.source, "sms"));
  assert.equal(leads.length, 1); assert.equal(leads[0]!.phone, "+48573000214"); assert.equal(leads[0]!.stage, "new"); assert.equal(leads[0]!.campaignId, c.id); assert.match(leads[0]!.notes ?? "", /Робота на виробництві/); assert.ok(leads[0]!.nextActionAt);
  assert.equal((await db.select().from(smsRecipientsTable).where(eq(smsRecipientsTable.id, rec!.id)))[0]!.candidateId, leads[0]!.id);
  const page = (await request(app).get(`/api/r/${rec!.token}`)).body;
  assert.equal(page.interested, true); assert.deepEqual(page.interestedVacancies, ["offer"]);
  assert.deepEqual(page.cities, ["Lublin"]);
  assert.equal(page.vacancies.length, 1); assert.equal(page.vacancies[0].id, "offer"); assert.equal(page.vacancies[0].title.uk, "Робота на виробництві"); assert.equal(JSON.stringify(page.vacancies).includes("AGRAM"), false); // назв клієнтів на сторінці нема
  assert.match(page.contacts.maps, /google\.com\/maps/); assert.equal(page.contacts.phone, "+48 731 000 000");
  // «Порекомендувати друга»: кандидат у воронці SMS з нотаткою про рекомендувача; дубль телефону — не створюється; свій номер — 400
  const fr = await request(app).post(`/api/r/${rec!.token}/friend`).set("X-Requested-With", "grafik").send({ name: "Ivan Koval", phone: "+48 601 234 567", vacancyId: "offer" });
  assert.equal(fr.status, 200, JSON.stringify(fr.body)); assert.equal(fr.body.duplicate, undefined); // «дубль» назовні не віддаємо
  const cands = await db.select().from(candidatesTable).where(eq(candidatesTable.source, "sms_friend"));
  assert.equal(cands.length, 1); assert.equal(cands[0]!.phone, "+48601234567"); assert.equal(cands[0]!.fullName, "Ivan Koval"); assert.equal(cands[0]!.campaignId, c.id); assert.match(cands[0]!.notes ?? "", /Oksana Melnychenko/);
  const fr2 = await request(app).post(`/api/r/${rec!.token}/friend`).set("X-Requested-With", "grafik").send({ name: "Ivan Koval", phone: "48601234567" });
  assert.equal(fr2.status, 200);
  assert.equal((await db.select().from(candidatesTable).where(eq(candidatesTable.source, "sms_friend"))).length, 1);
  assert.equal((await request(app).post(`/api/r/${rec!.token}/friend`).set("X-Requested-With", "grafik").send({ name: "Me", phone: "+48573000214" })).status, 400);
  assert.deepEqual((await request(app).get(`/api/r/${rec!.token}`)).body.friends, ["Ivan Koval"]);
  const ev = (await db.select().from(smsEventsTable).where(eq(smsEventsTable.recipientId, rec!.id)))[0]!;
  assert.match(ev.device ?? "", /iPhone|iOS|Mobile/i);

  // невідома подія і поганий токен — тихо 204/404
  assert.equal((await request(app).get(`/api/r/${rec!.token}/e?k=hack`)).status, 204);
  assert.equal((await request(app).get(`/api/r/NOPE`)).status, 404);
  assert.equal((await request(app).get(`/api/r/${"A".repeat(24)}`)).status, 404);
  assert.equal((await request(app).get(`/api/r/${"A".repeat(8)}`)).status, 404);
  assert.match(rec!.token, /^[0-9A-Z]{8}$/); // короткий токен — SMS в одну частину
  // токен у нижньому регістрі теж працює (людина набрала руками)
  assert.equal((await request(app).get(`/api/r/${rec!.token.toLowerCase()}`)).status, 200);
});
