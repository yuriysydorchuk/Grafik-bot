import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, companiesTable } from "../test/harness.ts";
import { bankTransactionsTable, ksefInvoicesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { matchKsefPayments } from "./ksef.ts";

// Матчинг оплат KSeF-продажів: якір — номер фактури АБО її KSeF-номер у
// призначенні (адміністратори вспульнот з 10.2026 пишуть «<KSeF>… B7_9_2026»);
// повна коректа продажу закриває пару без грошей, коректа на 0 zł — сама.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

let klinex = 0;
let seq = 0;
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  await db.execute(sql.raw("TRUNCATE ksef_invoices, bank_transactions RESTART IDENTITY CASCADE"));
  const [co] = await db.insert(companiesTable).values({ name: "Klinex" }).returning({ id: companiesTable.id });
  klinex = co!.id;
});
after(async () => { if (hasTestDb) await closeDb(); });

const ksefNo = () => `7123438022-20260930-${String(++seq).padStart(12, "0")}-9D`;

async function sale(over: Partial<typeof ksefInvoicesTable.$inferInsert> = {}): Promise<number> {
  const [row] = await db.insert(ksefInvoicesTable).values({
    companyId: klinex, kind: "sale", ksefNumber: ksefNo(), invoiceNumber: "B7/9/2026",
    issueDate: "2026-09-30", buyerNip: "9462635737", net: 2262.12, vat: 520.29, gross: 2782.41,
    invoiceType: "Vat", revenueMonth: "2026-09", segment: "cleaning", ...over,
  }).returning({ id: ksefInvoicesTable.id });
  return row!.id;
}

async function incoming(title: string, amount: number, valueDate = "2026-10-06"): Promise<number> {
  const [row] = await db.insert(bankTransactionsTable).values({
    companyId: klinex, valueDate, direction: "in", amount, title, source: "api", dedupHash: `h${++seq}`,
  }).returning({ id: bankTransactionsTable.id });
  return row!.id;
}

async function state(id: number) {
  const [r] = await db.select({ paidDate: ksefInvoicesTable.paidDate, paidVia: ksefInvoicesTable.paidVia, paidTxnId: ksefInvoicesTable.paidTxnId })
    .from(ksefInvoicesTable).where(eq(ksefInvoicesTable.id, id));
  return r!;
}

test("KSeF-номер у призначенні закриває фактуру, коли номер записаний з «_» замість «/»", opts, async () => {
  const id = await sale();
  const [inv] = await db.select({ k: ksefInvoicesTable.ksefNumber }).from(ksefInvoicesTable).where(eq(ksefInvoicesTable.id, id));
  const txn = await incoming(`${inv!.k}201100 ___________ B7_9_2026 PRZELEW ZEWNĘTRZNY PRZYCHODZĄCY`, 2782.41);
  await matchKsefPayments();
  assert.deepEqual(await state(id), { paidDate: "2026-10-06", paidVia: "bank", paidTxnId: txn });
});

test("номер з «_» без KSeF-номера не матчиться (якір лише точний ідентифікатор)", opts, async () => {
  const id = await sale();
  await incoming("B7_9_2026 PRZELEW ZEWNĘTRZNY PRZYCHODZĄCY", 2782.41);
  await matchKsefPayments();
  assert.equal((await state(id)).paidDate, null);
});

test("нестандартний ksef_number не збігається підрядком з будь-яким призначенням", opts, async () => {
  const id = await sale({ ksefNumber: "1" });
  await incoming("PRZELEW 1 ZA USŁUGI", 2782.41);
  await matchKsefPayments();
  assert.equal((await state(id)).paidDate, null);
});

test("повна коректа продажу закриває пару датою коректи; оплачену фактуру не чіпає", opts, async () => {
  const inv = await sale({ invoiceNumber: "C2/8/2026", issueDate: "2026-08-31", gross: 123, net: 100, vat: 23 });
  const kor = await sale({ invoiceNumber: "K1/9/2026", issueDate: "2026-09-04", gross: -123, net: -100, vat: -23, invoiceType: "Kor" });
  // інший покупець: фактуру оплачено переказом — її повна коректа лишається боргом
  const paid = await sale({ invoiceNumber: "A4/3/2026", issueDate: "2026-03-31", buyerNip: "7122222222", gross: 500 });
  await incoming("A4/3/2026", 500, "2026-04-05");
  const refund = await sale({ invoiceNumber: "K1/4/2026", issueDate: "2026-04-10", buyerNip: "7122222222", gross: -500, invoiceType: "Kor" });
  await matchKsefPayments();
  assert.deepEqual(await state(inv), { paidDate: "2026-09-04", paidVia: "korekta", paidTxnId: null });
  assert.deepEqual(await state(kor), { paidDate: "2026-09-04", paidVia: "korekta", paidTxnId: null });
  assert.equal((await state(paid)).paidVia, "bank");
  assert.equal((await state(refund)).paidDate, null);
});

test("неоднозначна пара (дві відкриті фактури на ту саму суму) лишається вручну", opts, async () => {
  const a = await sale({ invoiceNumber: "B1/8/2026", issueDate: "2026-08-31", gross: 300 });
  const b = await sale({ invoiceNumber: "B2/8/2026", issueDate: "2026-08-31", gross: 300 });
  const kor = await sale({ invoiceNumber: "K1/9/2026", issueDate: "2026-09-04", gross: -300, invoiceType: "Kor" });
  await matchKsefPayments();
  for (const id of [a, b, kor]) assert.equal((await state(id)).paidDate, null);
});

test("коректа до оплаченої фактури не закриває іншу відкриту на ту саму суму", opts, async () => {
  const paid = await sale({ invoiceNumber: "B1/7/2026", issueDate: "2026-07-31", gross: 100 });
  await incoming("B1/7/2026", 100, "2026-08-05");
  const open = await sale({ invoiceNumber: "B1/8/2026", issueDate: "2026-08-31", gross: 100 });
  const kor = await sale({ invoiceNumber: "K1/9/2026", issueDate: "2026-09-04", gross: -100, invoiceType: "Kor" });
  await matchKsefPayments();
  assert.equal((await state(paid)).paidVia, "bank");
  assert.equal((await state(open)).paidDate, null);
  assert.equal((await state(kor)).paidDate, null);
});

test("часткова оплата з KSeF-номером (сума інша) не закриває фактуру", opts, async () => {
  const id = await sale();
  const [inv] = await db.select({ k: ksefInvoicesTable.ksefNumber }).from(ksefInvoicesTable).where(eq(ksefInvoicesTable.id, id));
  await incoming(`${inv!.k} ___ B7_9_2026 1 RATA`, 1000);
  await matchKsefPayments();
  assert.equal((await state(id)).paidDate, null);
});

test("коректа на 0 zł закривається сама; звичайна фактура на 0 — ні", opts, async () => {
  const zeroKor = await sale({ invoiceNumber: "K1/6/2026", issueDate: "2026-06-30", gross: 0, net: 0, vat: 0, invoiceType: "Kor" });
  const zeroVat = await sale({ invoiceNumber: "B9/6/2026", issueDate: "2026-06-30", gross: 0, net: 0, vat: 0 });
  await matchKsefPayments();
  assert.deepEqual(await state(zeroKor), { paidDate: "2026-06-30", paidVia: "korekta", paidTxnId: null });
  assert.equal((await state(zeroVat)).paidDate, null);
});
