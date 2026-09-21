// Панельний API SMS-кампаній: створення, імпорт xlsx (dry-run → запис, мапінг колонок, фільтри),
// список отримувачів, запуск лише головним адміном, пауза, експорт, прев'ю тексту.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import ExcelJS from "exceljs";
import { resetDb, db, app, closeDb, workersTable, smsRecipientsTable, seedAdmin, seedRole } from "../test/harness.ts";
import { setSmsProviderForTests } from "../services/sms/provider.ts";

const SKIP = !process.env.TEST_DATABASE_URL;
before(async () => { if (!SKIP) await resetDb(); });
beforeEach(async () => { if (!SKIP) await resetDb(); });
after(async () => { setSmsProviderForTests(null); if (!SKIP) await closeDb(); });

async function xlsx(rows: Record<string, unknown>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Перевірені номери");
  const cols = Object.keys(rows[0]!); ws.addRow(cols); for (const r of rows) ws.addRow(cols.map((c) => r[c]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("кампанія: створити → імпорт dry/real → отримувачі → запуск (owner) → пауза → експорт", { skip: SKIP }, async () => {
  await seedRole("scheduler", ["editData"], ["/sms-campaigns"]);
  const owner = await seedAdmin({ role: "owner", isMain: true });
  const sched = await seedAdmin({ role: "scheduler", isMain: false });
  await db.insert(workersTable).values({ fullName: "Anna Kravets", status: "active" });

  const created = await request(app).post("/api/sms-campaigns").set("Cookie", sched.cookie).set("X-Requested-With", "grafik")
    .send({ name: "Хвиля 1", texts: { uk: "{імʼя}, робота: {лінк}" }, offer: { rate: "31 zl" }, schedule: { days: [2], dailyLimit: 10 } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id;
  assert.equal(created.body.status, "draft"); assert.equal(created.body.stats.recipients, 0);

  const file = await xlsx([
    { "Телефон (E.164)": "+48573000214", "Імʼя": "Oksana", "Прізвище": "Melnychenko", "Мова (оцінка)": "uk (укр. імʼя)", "Хто це": "кандидат ES (Польща)", "Рік": "2025" },
    { "Телефон (E.164)": "+48729000880", "Імʼя": "Anna", "Прізвище": "Kravets", "Мова (оцінка)": "uk", "Хто це": "працівник ES", "Рік": "2020" },
    { "Телефон (E.164)": "+380671239567", "Імʼя": "Іван", "Прізвище": "Петренко", "Мова (оцінка)": "uk", "Хто це": "кандидат ES (Польща)", "Рік": "2021" },
    { "Телефон (E.164)": "+48814632323", "Імʼя": "Biuro", "Прізвище": "Firmy", "Мова (оцінка)": "pl", "Хто це": "кандидат ES (Польща)", "Рік": "2025" },
  ]);
  const dry = await request(app).post(`/api/sms-campaigns/${id}/import`).set("Cookie", sched.cookie).set("X-Requested-With", "grafik").field("dry", "1").attach("file", file, "contacts.xlsx");
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.sheet, "Перевірені номери");
  assert.equal(dry.body.guessed.phone, "Телефон (E.164)"); assert.equal(dry.body.guessed.lastName, "Прізвище"); assert.equal(dry.body.guessed.year, "Рік");
  assert.equal(dry.body.summary.added, 1); assert.equal(dry.body.summary.activeWorkers, 1); assert.equal(dry.body.summary.skipped.ua_excluded, 1); assert.equal(dry.body.summary.skipped.invalid, 1);
  assert.equal((await db.select().from(smsRecipientsTable)).length, 0); // dry — нічого не записано

  const real = await request(app).post(`/api/sms-campaigns/${id}/import`).set("Cookie", sched.cookie).set("X-Requested-With", "grafik").field("dry", "0").field("includeUa", "1").attach("file", file, "contacts.xlsx");
  assert.equal(real.body.summary.added, 2); // UA увімкнено
  const list = await request(app).get(`/api/sms-campaigns/${id}/recipients?status=queued`).set("Cookie", sched.cookie);
  assert.equal(list.body.total, 2);
  const oks = list.body.rows.find((r: any) => r.phone === "+48573000214");
  assert.equal(oks.name, "Oksana Melnychenko"); assert.equal(oks.firstName, "Oksana"); assert.match(oks.link, /\/r\/[0-9A-Z]{24}$/);

  // запуск: графікова — 403, owner без ключа провайдера — 400, з мок-провайдером — 200
  assert.equal((await request(app).post(`/api/sms-campaigns/${id}/start`).set("Cookie", sched.cookie).set("X-Requested-With", "grafik").send({})).status, 403);
  process.env.SMS_SMSAPI_TOKEN = "";
  const noKey = await request(app).post(`/api/sms-campaigns/${id}/start`).set("Cookie", owner.cookie).set("X-Requested-With", "grafik").send({});
  assert.equal(noKey.status, 400);
  setSmsProviderForTests({ name: "smsapi", configured: () => true, price: () => 0.1, async send(items) { return items.map((it) => ({ recipientId: it.recipientId, ok: true, msgId: `m${it.recipientId}`, parts: 1 })); }, async status() { return []; } });
  const started = await request(app).post(`/api/sms-campaigns/${id}/start`).set("Cookie", owner.cookie).set("X-Requested-With", "grafik").send({ mode: "sending" });
  assert.equal(started.status, 200, JSON.stringify(started.body)); assert.equal(started.body.status, "sending");
  const batch = await request(app).post(`/api/sms-campaigns/${id}/send-batch`).set("Cookie", owner.cookie).set("X-Requested-With", "grafik").send({});
  assert.equal(batch.body.sent, 2);
  const paused = await request(app).post(`/api/sms-campaigns/${id}/pause`).set("Cookie", sched.cookie).set("X-Requested-With", "grafik").send({});
  assert.equal(paused.body.status, "paused"); assert.equal(paused.body.stats.sent, 2); assert.equal(paused.body.stats.costEstimate, 0.2);

  const xl = await request(app).get(`/api/sms-campaigns/${id}/export.xlsx`).set("Cookie", sched.cookie);
  assert.equal(xl.status, 200); assert.match(xl.headers["content-type"], /spreadsheetml/);
  const prev = await request(app).post("/api/sms-campaigns/preview-text").set("Cookie", sched.cookie).set("X-Requested-With", "grafik").send({ text: "{імʼя}, робота: {лінк}", name: "Oksana" });
  assert.equal(prev.body.encoding, "UCS-2"); assert.ok(prev.body.rendered.startsWith("Oksana, робота: "));
  const all = await request(app).get("/api/sms-campaigns").set("Cookie", sched.cookie);
  assert.equal(all.body.campaigns.length, 1); assert.equal(typeof all.body.summary.queued, "number");
  const settings = await request(app).get("/api/sms-campaigns/settings").set("Cookie", sched.cookie);
  assert.equal(settings.body.providers.length, 2);
});
