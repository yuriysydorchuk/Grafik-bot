import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, bankTransactionsTable } from "../test/harness.ts";

// Route-level money endpoints: viewFinance gate on the pnl router, pnl entry validation,
// and /bank/transactions bucket/month filtering (the SQL predicates themselves are covered
// in bankClassify.integration — here we prove the route wires them correctly).
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
async function insertTx(tx: { direction: "in" | "out"; date: string; counterparty?: string; title?: string; amount?: number; account?: string; counterpartyAccount?: string }) {
  await db.insert(bankTransactionsTable).values({
    valueDate: tx.date, direction: tx.direction, amount: tx.amount ?? 100,
    counterparty: tx.counterparty ?? null, title: tx.title ?? null,
    account: tx.account ?? null, counterpartyAccount: tx.counterpartyAccount ?? null,
    dedupHash: `fin-${seq++}`,
  });
}

test("pnl router is viewFinance-gated: editData role gets 403", opts, async () => {
  await seedRole("editor", ["editData"], ["/workers"]);
  const { cookie } = await seedAdmin({ role: "editor" });
  const res = await request(app).get("/api/pnl?month=2026-05").set("Cookie", cookie);
  assert.equal(res.status, 403);
});

test("POST /pnl/entries validates month, section and amount", opts, async () => {
  const good = await request(app).post("/api/pnl/entries").set("Cookie", owner).set(H)
    .send({ periodMonth: "2026-05", section: "revenue", label: "Faktura X", amount: "1200,50" });
  assert.equal(good.status, 200);
  assert.equal(good.body.amount, 1200.5, "comma decimal must be parsed");
  assert.equal(good.body.segment, "main", "unknown segment defaults to main");

  for (const bad of [
    { periodMonth: "2026-13", section: "revenue", label: "x", amount: 1 },   // bad month
    { periodMonth: "2026-05", section: "banana", label: "x", amount: 1 },    // bad section
    { periodMonth: "2026-05", section: "cogs", label: "x", amount: "abc" },  // bad amount
    { periodMonth: "2026-05", section: "cogs", label: "  ", amount: 1 },     // empty label
  ]) {
    const res = await request(app).post("/api/pnl/entries").set("Cookie", owner).set(H).send(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test("GET /bank/transactions?bucket=income returns client credits, not internal transfers", opts, async () => {
  await insertTx({ direction: "in", date: "2026-05-05", counterparty: "FABRYKA XYZ", title: "FV 1/2026" });
  await insertTx({ direction: "in", date: "2026-05-06", counterparty: "EUROSUPPORT SP Z OO", title: "Przelew" });
  await insertTx({ direction: "out", date: "2026-05-07", counterparty: "ORLEN" });

  const res = await request(app).get("/api/bank/transactions?bucket=income&month=2026-05").set("Cookie", owner);
  assert.equal(res.status, 200);
  const rows = res.body.rows ?? res.body;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].counterparty, "FABRYKA XYZ");
});

test("GET /bank/transactions month filter excludes neighbouring months", opts, async () => {
  await insertTx({ direction: "in", date: "2026-04-30", counterparty: "APRIL" });
  await insertTx({ direction: "in", date: "2026-05-01", counterparty: "MAY" });
  await insertTx({ direction: "in", date: "2026-06-01", counterparty: "JUNE" });

  const res = await request(app).get("/api/bank/transactions?month=2026-05&direction=in").set("Cookie", owner);
  const rows = res.body.rows ?? res.body;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].counterparty, "MAY");
});

test("GET /bank/transactions?q= matches account numbers, ignoring spaces", opts, async () => {
  await insertTx({ direction: "out", date: "2026-05-05", counterparty: "JAKAS FIRMA",
    counterpartyAccount: "PL61109010140000071219812874" });
  await insertTx({ direction: "out", date: "2026-05-06", counterparty: "INNA FIRMA",
    account: "PL27114020040000300201355387" });
  await insertTx({ direction: "out", date: "2026-05-07", counterparty: "TRZECIA" });

  // IBAN контрагента, вставлений із пробілами як у банківському UI
  const byCp = await request(app).get("/api/bank/transactions").set("Cookie", owner)
    .query({ month: "2026-05", q: "PL61 1090 1014 0000 0712 1981 2874" });
  assert.equal(byCp.status, 200);
  assert.equal(byCp.body.rows.length, 1);
  assert.equal(byCp.body.rows[0].counterparty, "JAKAS FIRMA");

  // фрагмент власного рахунку (:25:)
  const byOwn = await request(app).get("/api/bank/transactions").set("Cookie", owner)
    .query({ month: "2026-05", q: "1140 2004" });
  assert.equal(byOwn.body.rows.length, 1);
  assert.equal(byOwn.body.rows[0].counterparty, "INNA FIRMA");
});

test("GET /bank/transactions?bucket=cat:fuel wires catCondition into the route", opts, async () => {
  await insertTx({ direction: "out", date: "2026-05-05", title: "PLATNOSC KARTA ORLEN" });
  await insertTx({ direction: "out", date: "2026-05-06", counterparty: "BIEDRONKA" });

  const res = await request(app).get("/api/bank/transactions?bucket=cat:fuel&month=2026-05").set("Cookie", owner);
  const rows = res.body.rows ?? res.body;
  assert.equal(rows.length, 1);
  assert.match(rows[0].title ?? "", /ORLEN/);
});
