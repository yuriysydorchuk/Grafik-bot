import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, bankTransactionsTable, expenseCategoriesTable, counterpartyRulesTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";

// Route-level coverage for owner-editable expense categories: CRUD, the delete
// fallback to «Інше», batch re-categorization and counterparty-rule editing.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

let owner = "";
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  owner = (await seedAdmin({ role: "owner" })).cookie;
});
after(async () => { if (hasTestDb) await closeDb(); });

let seq = 0;
async function insertTx(tx: { direction?: "in" | "out"; counterparty?: string; title?: string; manualCategory?: string }): Promise<number> {
  const [row] = await db.insert(bankTransactionsTable).values({
    valueDate: "2026-06-10", direction: tx.direction ?? "out", amount: 100,
    counterparty: tx.counterparty ?? null, title: tx.title ?? null,
    manualCategory: tx.manualCategory ?? null, dedupHash: `cat-${seq++}`,
  }).returning({ id: bankTransactionsTable.id });
  return row!.id;
}
const manualCatOf = async (id: number) => (await db.select({ mc: bankTransactionsTable.manualCategory }).from(bankTransactionsTable).where(eq(bankTransactionsTable.id, id)))[0]!.mc;

test("POST /bank/categories creates a category; GET lists it with counts; PATCH edits", opts, async () => {
  const created = await request(app).post("/api/bank/categories").set("Cookie", owner).set(H)
    .send({ label: "Subscriptions", pattern: "NETFLIX|SPOTIFY" });
  assert.equal(created.status, 200);
  assert.equal(created.body.key, "subscriptions", "latin label becomes the slug");
  await insertTx({ title: "NETFLIX.COM" });

  const list = await request(app).get("/api/bank/categories").set("Cookie", owner);
  assert.equal(list.status, 200);
  const mine = list.body.categories.find((c: any) => c.key === "subscriptions");
  assert.ok(mine, "created category must be listed");
  assert.equal(mine.txCount, 1, "pattern-matched transaction is counted");

  const bad = await request(app).patch(`/api/bank/categories/${created.body.id}`).set("Cookie", owner).set(H)
    .send({ pattern: "BROKEN[" });
  assert.equal(bad.status, 400, "invalid regex must be rejected");

  const renamed = await request(app).patch(`/api/bank/categories/${created.body.id}`).set("Cookie", owner).set(H)
    .send({ label: "Підписки" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.label, "Підписки");
});

test("cyrillic label gets a generated cat_<n> key", opts, async () => {
  const created = await request(app).post("/api/bank/categories").set("Cookie", owner).set(H)
    .send({ label: "Канцелярія" });
  assert.equal(created.status, 200);
  assert.match(created.body.key, /^cat_\d+$/);
});

test("DELETE /bank/categories moves manual overrides to «other» and drops its rules", opts, async () => {
  const created = await request(app).post("/api/bank/categories").set("Cookie", owner).set(H)
    .send({ label: "Temp cat" });
  const key = created.body.key as string;
  const pinned = await insertTx({ title: "COKOLWIEK", manualCategory: key });
  await db.insert(counterpartyRulesTable).values({ pattern: "COKOLWIEK", category: key });

  const del = await request(app).delete(`/api/bank/categories/${created.body.id}`).set("Cookie", owner).set(H);
  assert.equal(del.status, 200);
  assert.equal(await manualCatOf(pinned), "other", "manual override falls back to other");
  const rules = await db.select().from(counterpartyRulesTable).where(eq(counterpartyRulesTable.category, key));
  assert.equal(rules.length, 0, "rules targeting the deleted category are removed");
  const cats = await db.select().from(expenseCategoriesTable).where(eq(expenseCategoriesTable.key, key));
  assert.equal(cats.length, 0);
});

test("PATCH /bank/transactions/:id/category rejects an unknown key", opts, async () => {
  const id = await insertTx({ title: "X" });
  const res = await request(app).patch(`/api/bank/transactions/${id}/category`).set("Cookie", owner).set(H)
    .send({ category: "no_such_cat" });
  assert.equal(res.status, 400);
});

test("POST /bank/transactions/recategorize moves only expense rows", opts, async () => {
  const out1 = await insertTx({ title: "A" });
  const out2 = await insertTx({ title: "B" });
  const inc = await insertTx({ direction: "in", title: "C" });
  const res = await request(app).post("/api/bank/transactions/recategorize").set("Cookie", owner).set(H)
    .send({ ids: [out1, out2, inc], category: "office_rent" });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 2, "both out-rows re-categorized");
  assert.equal(res.body.skipped, 1, "the incoming row is skipped");
  assert.equal(await manualCatOf(out1), "office_rent");
  assert.equal(await manualCatOf(inc), null);
});

test("PATCH /bank/counterparty-rules re-targets: old matches reset, new applied", opts, async () => {
  const orange = await insertTx({ counterparty: "Orange Sp z o.o", title: "FV 1/26" });
  const created = await request(app).post("/api/bank/counterparty-rules").set("Cookie", owner).set(H)
    .send({ pattern: "Orange", category: "services" });
  assert.equal(created.status, 200);
  assert.equal(created.body.updated, 1);
  assert.equal(await manualCatOf(orange), "services");

  const patched = await request(app).patch(`/api/bank/counterparty-rules/${created.body.rule.id}`).set("Cookie", owner).set(H)
    .send({ category: "office_rent" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.updated, 1);
  assert.equal(await manualCatOf(orange), "office_rent", "existing matches follow the rule's new category");
});

test("expense-categories breakdown reflects a freshly added pattern category", opts, async () => {
  await insertTx({ title: "NETFLIX.COM" });
  await request(app).post("/api/bank/categories").set("Cookie", owner).set(H)
    .send({ label: "Subs", pattern: "NETFLIX" });
  const res = await request(app).get("/api/bank/expense-categories?year=2026").set("Cookie", owner);
  assert.equal(res.status, 200);
  const subs = res.body.categories.find((c: any) => c.key === "subs");
  assert.ok(subs, "new category appears in the breakdown");
  assert.equal(subs.n, 1);
});

test("a rule with an IBAN pattern matches by counterparty account", opts, async () => {
  const [row] = await db.insert(bankTransactionsTable).values({
    valueDate: "2026-06-11", direction: "out", amount: 50,
    counterparty: "JAKAS FIRMA", counterpartyAccount: "PL61 1090 1014 0000 0712 1981 2874",
    dedupHash: `cat-acct-${seq++}`,
  }).returning({ id: bankTransactionsTable.id });
  const res = await request(app).post("/api/bank/counterparty-rules").set("Cookie", owner).set(H)
    .send({ pattern: "PL61109010140000071219812874", category: "services" });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 1, "IBAN pattern must match the account (spaces ignored)");
  assert.equal(await manualCatOf(row!.id), "services");
});
