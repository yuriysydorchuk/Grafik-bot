import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, seedRole, db, companiesTable } from "../test/harness.ts";
import { ksefInvoicesTable, invoiceAuditTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

// Ручний статус оплати фактури доходу на /cleaning: та сама семантика
// перекриття, що й /ksef (збіг з авто = назад на авто), гейт — капа cleaning,
// лише продажі сегмента cleaning, кожна зміна — в журнал фактур.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

let cleaner = "";
let klinex = 0;
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  await db.execute(sql.raw("TRUNCATE ksef_invoices, invoice_audit RESTART IDENTITY CASCADE"));
  await seedRole("cleaner", ["cleaning"], ["/cleaning"]);
  cleaner = (await seedAdmin({ role: "cleaner", name: "Прибирання" })).cookie;
  const [co] = await db.insert(companiesTable).values({ name: "Klinex" }).returning({ id: companiesTable.id });
  klinex = co!.id;
});
after(async () => { if (hasTestDb) await closeDb(); });

async function sale(over: Partial<typeof ksefInvoicesTable.$inferInsert> = {}): Promise<number> {
  const [row] = await db.insert(ksefInvoicesTable).values({
    companyId: klinex, kind: "sale", ksefNumber: `7123438022-20260630-${Math.random().toString(16).slice(2, 14).padEnd(12, "0").toUpperCase()}-AA`,
    invoiceNumber: "B2/6/2026", issueDate: "2026-06-30", buyerNip: "9462635737", net: 5470.41, vat: 1258.19, gross: 6728.6,
    revenueMonth: "2026-06", segment: "cleaning", ...over,
  }).returning({ id: ksefInvoicesTable.id });
  return row!.id;
}

async function incomeRow(id: number) {
  const r = await request(app).get("/api/cleaning/income?month=2026-06").set("Cookie", cleaner);
  assert.equal(r.status, 200);
  return r.body.rows.find((x: any) => x.id === id);
}

test("неоплачена → вручну оплачена з датою → назад на авто; журнал пише обидві зміни", opts, async () => {
  const id = await sale();
  assert.equal((await incomeRow(id)).paid, false);

  const r1 = await request(app).patch(`/api/cleaning/income/${id}/paid`).set("Cookie", cleaner).set(H).send({ paid: true, paidDate: "2026-07-09" });
  assert.equal(r1.status, 200);
  const row = await incomeRow(id);
  assert.equal(row.paid, true);
  assert.equal(row.paidDate, "2026-07-09");
  assert.equal(row.paidSource, "manual");

  const r2 = await request(app).patch(`/api/cleaning/income/${id}/paid`).set("Cookie", cleaner).set(H).send({ paid: false });
  assert.equal(r2.status, 200);
  const back = await incomeRow(id);
  assert.equal(back.paid, false);
  assert.equal(back.paidSource, null);

  const audit = await db.select().from(invoiceAuditTable).where(eq(invoiceAuditTable.invoiceId, id));
  assert.equal(audit.length, 2);
});

test("авто-оплачену (витяг) можна перекрити «не оплачена», повторний клік — назад на авто", opts, async () => {
  const id = await sale({ paidDate: "2026-07-09", paidVia: "bank" });
  assert.equal((await incomeRow(id)).paidSource, "bank");
  await request(app).patch(`/api/cleaning/income/${id}/paid`).set("Cookie", cleaner).set(H).send({ paid: false });
  const over = await incomeRow(id);
  assert.equal(over.paid, false);
  assert.equal(over.paidSource, "manual");
  await request(app).patch(`/api/cleaning/income/${id}/paid`).set("Cookie", cleaner).set(H).send({ paid: true });
  const auto = await incomeRow(id);
  assert.equal(auto.paid, true);
  assert.equal(auto.paidSource, "bank");
});

test("ручна «оплачено», а потім матчер знайшов переказ: paid:null повертає на авто, а не робить неоплаченою", opts, async () => {
  const id = await sale();
  await request(app).patch(`/api/cleaning/income/${id}/paid`).set("Cookie", cleaner).set(H).send({ paid: true, paidDate: "2026-07-09" });
  await db.update(ksefInvoicesTable).set({ paidDate: "2026-07-10", paidVia: "bank" }).where(eq(ksefInvoicesTable.id, id));
  assert.equal((await incomeRow(id)).paidSource, "manual");
  const r = await request(app).patch(`/api/cleaning/income/${id}/paid`).set("Cookie", cleaner).set(H).send({ paid: null });
  assert.equal(r.status, 200);
  const row = await incomeRow(id);
  assert.equal(row.paid, true);
  assert.equal(row.paidSource, "bank");
  assert.equal(row.paidDate, "2026-07-10");
});

test("гейт і межі: без капи cleaning — 403, фабрична фактура — 404, хибне тіло — 400", opts, async () => {
  const id = await sale();
  const main = await sale({ segment: "main", invoiceNumber: "A1/6/2026" });
  await seedRole("plain", [], ["/workers"]);
  const plain = (await seedAdmin({ role: "plain", name: "Без доступу" })).cookie;
  assert.equal((await request(app).patch(`/api/cleaning/income/${id}/paid`).set("Cookie", plain).set(H).send({ paid: true })).status, 403);
  assert.equal((await request(app).patch(`/api/cleaning/income/${main}/paid`).set("Cookie", cleaner).set(H).send({ paid: true })).status, 404);
  assert.equal((await request(app).patch(`/api/cleaning/income/${id}/paid`).set("Cookie", cleaner).set(H).send({ paid: "yes" })).status, 400);
  assert.equal((await request(app).patch(`/api/cleaning/income/${id}/paid`).set("Cookie", cleaner).set(H).send({ paid: true, paidDate: "09.07.2026" })).status, 400);
});
