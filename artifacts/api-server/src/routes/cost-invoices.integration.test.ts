import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, seedRole, db, companiesTable } from "../test/harness.ts";
import { invoicesTable, ksefInvoicesTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// Фактури коштові: спосіб оплати (переказ/готівка, ручний ?? авто), «рапорт
// готівковий», термін оплати KSeF-рядків, протерміновані в підсумках, гейт
// costInvoices, «хто вніс» на локальних рядках.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const MONTH = "2026-08";
const PAST_DUE = "2026-08-01"; // раніше за будь-яке «сьогодні» цих тестів

let buch = "";
let companyId = 0;
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  // invoices/ksef_invoices не входять у стандартний resetDb — чистимо самі
  await db.execute(sql.raw("TRUNCATE invoices, ksef_invoices RESTART IDENTITY CASCADE"));
  await seedRole("buch", ["costInvoices"], ["/cost-invoices"]);
  buch = (await seedAdmin({ role: "buch", name: "Кшєнгова" })).cookie;
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning({ id: companiesTable.id });
  companyId = co!.id;
});
after(async () => { if (hasTestDb) await closeDb(); });

async function insertKsef(over: Partial<typeof ksefInvoicesTable.$inferInsert> = {}): Promise<number> {
  const [row] = await db.insert(ksefInvoicesTable).values({
    companyId, kind: "purchase", ksefNumber: `KSEF-${Math.random().toString(36).slice(2)}`,
    invoiceNumber: "FZ 7/08/2026", issueDate: "2026-08-05", net: 100, vat: 23, gross: 123,
    revenueMonth: MONTH, ...over,
  }).returning({ id: ksefInvoicesTable.id });
  return row!.id;
}

test("GET: термін/прострочення KSeF-рядка, авто-метод з XML, addedBy на локальних", opts, async () => {
  await insertKsef({ dueDate: PAST_DUE, paymentMethodXml: "przelew" });
  const created = await request(app).post("/api/cost-invoices").set("Cookie", buch).set(H)
    .send({ companyId, issueDate: "2026-08-06", number: "FV 1/08/2026", amount: "200", dueDate: PAST_DUE });
  assert.equal(created.status, 200);

  const r = await request(app).get(`/api/cost-invoices?month=${MONTH}`).set("Cookie", buch);
  assert.equal(r.status, 200);
  const ksefRow = r.body.rows.find((x: any) => x.origin === "ksef");
  const localRow = r.body.rows.find((x: any) => x.origin === "local");
  assert.equal(ksefRow.dueDate, PAST_DUE);
  assert.equal(ksefRow.overdue, true, "неоплачена з минулим терміном — прострочена");
  assert.equal(ksefRow.paymentMethod, "przelew");
  assert.equal(ksefRow.paymentMethodSource, "auto", "метод з XML — авто, не ручний");
  assert.equal(localRow.addedBy, "Кшєнгова");
  assert.ok(localRow.addedAt, "час внесення віддається");
  assert.equal(localRow.overdue, true);
  // підсумки: обидві протерміновані; переказ — лише KSeF-рядок (123)
  assert.equal(r.body.totals.overdueCount, 2);
  assert.equal(r.body.totals.overdueGross, 323);
  assert.equal(r.body.totals.przelewGross, 123);
  assert.equal(r.body.totals.gotowkaCount, 0);
  assert.ok("ksefSync" in r.body, "статус останнього синку присутній у відповіді");
});

test("PATCH: ручний метод/рапорт на обох типах рядків, термін KSeF правиться", opts, async () => {
  const kid = await insertKsef({ paymentMethodXml: "przelew" });
  const created = await request(app).post("/api/cost-invoices").set("Cookie", buch).set(H)
    .send({ companyId, issueDate: "2026-08-06", number: "FV 2/08/2026", amount: "50" });

  // локальний: готівка + рапорт готівковий
  const lp = await request(app).patch(`/api/cost-invoices/${created.body.id}`).set("Cookie", buch).set(H)
    .send({ paymentMethod: "gotowka", cashReport: true });
  assert.equal(lp.status, 200);
  // ksef: ручний метод перекриває XML; термін оплати вписується
  const kp = await request(app).patch(`/api/cost-invoices/ksef/${kid}`).set("Cookie", buch).set(H)
    .send({ paymentMethod: "gotowka", cashReport: true, dueDate: "2026-08-30" });
  assert.equal(kp.status, 200);

  const r = await request(app).get(`/api/cost-invoices?month=${MONTH}`).set("Cookie", buch);
  const ksefRow = r.body.rows.find((x: any) => x.origin === "ksef");
  const localRow = r.body.rows.find((x: any) => x.origin === "local");
  assert.equal(ksefRow.paymentMethod, "gotowka");
  assert.equal(ksefRow.paymentMethodSource, "manual");
  assert.equal(ksefRow.cashReport, true);
  assert.equal(ksefRow.dueDate, "2026-08-30");
  assert.equal(ksefRow.overdue, false, "термін у майбутньому — не прострочена");
  assert.equal(localRow.paymentMethod, "gotowka");
  assert.equal(localRow.cashReport, true);
  assert.equal(r.body.totals.gotowkaGross, 173);

  // скидання на авто: null повертає метод з XML
  await request(app).patch(`/api/cost-invoices/ksef/${kid}`).set("Cookie", buch).set(H).send({ paymentMethod: null });
  const r2 = await request(app).get(`/api/cost-invoices?month=${MONTH}`).set("Cookie", buch);
  const k2 = r2.body.rows.find((x: any) => x.origin === "ksef");
  assert.equal(k2.paymentMethod, "przelew");
  assert.equal(k2.paymentMethodSource, "auto");
});

test("гейт: роль без costInvoices не бачить модуль; хибний метод — 400", opts, async () => {
  await seedRole("plain", [], ["/"]);
  const plain = (await seedAdmin({ role: "plain" })).cookie;
  const denied = await request(app).get(`/api/cost-invoices?month=${MONTH}`).set("Cookie", plain);
  assert.equal(denied.status, 403);

  const kid = await insertKsef();
  const bad = await request(app).patch(`/api/cost-invoices/ksef/${kid}`).set("Cookie", buch).set(H)
    .send({ paymentMethod: "karta" });
  assert.equal(bad.status, 400);
});
