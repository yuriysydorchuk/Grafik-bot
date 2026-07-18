import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, bankTransactionsTable } from "../test/harness.ts";
import { sql } from "drizzle-orm";
import { BUCKET, catCondition as catConditionRaw, getExpenseCats, invalidateExpenseCats, patternCondition } from "./bankClassify.ts";
import { expenseCategoriesTable } from "../test/harness.ts";

// categories now live in the DB (seeded by resetDb) — resolve the list per call
async function catCondition(key: string): Promise<string> {
  const cond = catConditionRaw(key, await getExpenseCats());
  if (!cond) throw new Error(`no condition for category ${key}`);
  return cond;
}

// The classification patterns are the single source of truth and rely on POSTGRES regex
// semantics (\y word boundary, Polish stems) that a JS unit test cannot reproduce. These
// tests insert real rows and evaluate the actual predicate strings against the database.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

let seq = 0;
type Tx = { direction: "in" | "out"; counterparty?: string; title?: string; txType?: string; account?: string; manualCategory?: string };
async function insertTx(tx: Tx): Promise<number> {
  const [row] = await db.insert(bankTransactionsTable).values({
    valueDate: "2026-05-10",
    direction: tx.direction,
    amount: 100,
    counterparty: tx.counterparty ?? null,
    title: tx.title ?? null,
    txType: tx.txType ?? null,
    account: tx.account ?? null,
    manualCategory: tx.manualCategory ?? null,
    dedupHash: `test-${seq++}-${Math.random().toString(36).slice(2)}`,
  }).returning({ id: bankTransactionsTable.id });
  return row!.id;
}

// Does the row with `id` satisfy the given raw SQL boolean predicate?
async function matches(id: number, predicate: string): Promise<boolean> {
  const res: any = await db.execute(sql.raw(`SELECT 1 AS ok FROM bank_transactions WHERE id = ${id} AND (${predicate})`));
  const rows = res.rows ?? res;
  return (rows?.length ?? 0) > 0;
}

test("income: a normal client credit is income; an internal EUROSUPPORT transfer is excluded", opts, async () => {
  const client = await insertTx({ direction: "in", counterparty: "FABRYKA XYZ SP Z OO", title: "FV 12/2026" });
  const internal = await insertTx({ direction: "in", counterparty: "EUROSUPPORT SP Z OO", title: "Przelew" });
  assert.equal(await matches(client, BUCKET.income!), true);
  assert.equal(await matches(internal, BUCKET.income!), false);
});

test("owner payout vs. a card fee mentioning the owner's name", opts, async () => {
  const payout = await insertTx({ direction: "out", counterparty: "SYDORCZUK ROMAN", title: "Wynagrodzenie" });
  // A monthly card-service fee names the cardholder but is a cost, not a payout.
  const fee = await insertTx({ direction: "out", title: "MIESIECZNA OPLATA ZA OBSLUGE KARTY YURIY SYDORCHUK" });
  assert.equal(await matches(payout, BUCKET.owner_roman!), true);
  assert.equal(await matches(payout, BUCKET.expenses!), false, "owner payout must NOT be an expense");
  assert.equal(await matches(fee, BUCKET.owner_yuriy!), false, "a fee is not an owner payout");
  assert.equal(await matches(fee, BUCKET.expenses!), true, "the fee stays in expenses");
});

test("cash withdrawal (Polish stem BANKOMA) is cash, not an expense; its commission is not cash", opts, async () => {
  const withdrawal = await insertTx({ direction: "out", title: "WYPLATA W BANKOMACIE", txType: "GOTOWKA" });
  const commission = await insertTx({ direction: "out", title: "PROWIZJA ZA WYPLATE GOTOWKI" });
  assert.equal(await matches(withdrawal, BUCKET.cash!), true);
  assert.equal(await matches(withdrawal, BUCKET.expenses!), false);
  assert.equal(await matches(commission, BUCKET.cash!), false, "PROWIZJA excludes it from cash");
  assert.equal(await matches(commission, BUCKET.expenses!), true);
});

test("credit account rows are excluded from operating buckets entirely", opts, async () => {
  const onCredit = await insertTx({ direction: "in", counterparty: "FABRYKA XYZ", account: "PL75109025900000000158258415" });
  assert.equal(await matches(onCredit, BUCKET.income!), false);
});

test("expense category: first match wins — an ORLEN card payment is fuel, not card", opts, async () => {
  const id = await insertTx({ direction: "out", title: "PLATNOSC KARTA ORLEN STACJA 123", txType: "KART. DEBET" });
  assert.equal(await matches(id, await catCondition("fuel")), true);
  assert.equal(await matches(id, await catCondition("card")), false, "fuel precedes card in the list");
});

test("\\y word boundary: ULAN matches clothing but ULANOWSKI does not", opts, async () => {
  const clothes = await insertTx({ direction: "out", counterparty: "ULAN" });
  const surname = await insertTx({ direction: "out", counterparty: "ULANOWSKI JAN" });
  assert.equal(await matches(clothes, await catCondition("clothing")), true);
  assert.equal(await matches(surname, await catCondition("clothing")), false, "\\y must not match inside a longer word");
  // The surname payment is still a valid expense, just not 'clothing'.
  assert.equal(await matches(surname, await catCondition("other")), true);
});

test("manual_category override wins over the automatic pattern", opts, async () => {
  // A fuel-looking payment manually re-tagged as 'other'.
  const id = await insertTx({ direction: "out", title: "ORLEN", manualCategory: "other" });
  assert.equal(await matches(id, await catCondition("other")), true);
  assert.equal(await matches(id, await catCondition("fuel")), false, "manual override moves it out of fuel");
});

test("salary transfers land in the salary category", opts, async () => {
  const wage = await insertTx({ direction: "out", counterparty: "KOWALSKI JAN", title: "WYNAGRODZENIE ZA 05.2026" });
  assert.equal(await matches(wage, await catCondition("salary")), true);
  assert.equal(await matches(wage, BUCKET.expenses!), true, "salary is part of expenses");
});

test("custom DB category with a pattern joins auto-classification; without — manual-only", opts, async () => {
  await db.insert(expenseCategoriesTable).values([
    { key: "subs", label: "Підписки", pattern: "NETFLIX|SPOTIFY", sortOrder: 300 },
    { key: "manualcat", label: "Ручна", pattern: null, sortOrder: 310 },
  ]);
  invalidateExpenseCats();
  const sub = await insertTx({ direction: "out", title: "NETFLIX.COM" });
  assert.equal(await matches(sub, await catCondition("subs")), true);
  assert.equal(await matches(sub, await catCondition("other")), false, "pattern-matched row must leave 'other'");
  // the pattern-less category holds only manual overrides
  const pinned = await insertTx({ direction: "out", title: "COKOLWIEK", manualCategory: "manualcat" });
  const stray = await insertTx({ direction: "out", title: "COKOLWIEK INNE" });
  assert.equal(await matches(pinned, await catCondition("manualcat")), true);
  assert.equal(await matches(stray, await catCondition("manualcat")), false);
  assert.equal(await matches(stray, await catCondition("other")), true);
});

test("pattern DSL: ' + ' means AND within a line, newline means OR", opts, async () => {
  const cond = `direction='out' AND ${patternCondition("AAA + BBB\nCCC")}`;
  const both = await insertTx({ direction: "out", title: "AAA BBB" });
  const one = await insertTx({ direction: "out", title: "AAA" });
  const alt = await insertTx({ direction: "out", title: "CCC" });
  assert.equal(await matches(both, cond), true);
  assert.equal(await matches(one, cond), false, "single AND term must not match");
  assert.equal(await matches(alt, cond), true, "second OR line matches on its own");
});
