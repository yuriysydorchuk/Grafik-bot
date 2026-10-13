import { test } from "node:test";
import assert from "node:assert/strict";
import { splitAmount, monthPlus, installmentRows, parseInstallments, dueBy } from "./installments";

test("splitAmount — рівні частини до копійки, залишок у першу", () => {
  assert.deepEqual(splitAmount(100, 3), [33.34, 33.33, 33.33]);
  assert.deepEqual(splitAmount(100, 2), [50, 50]);
  assert.deepEqual(splitAmount(0.05, 4), [0.02, 0.01, 0.01, 0.01]);
  assert.deepEqual(splitAmount(199.99, 1), [199.99]);
  for (const [t, n] of [[123.45, 7], [1000, 12], [0.1, 3]] as const) {
    const sum = splitAmount(t, n).reduce((a, b) => a + b, 0);
    assert.equal(Math.round(sum * 100), Math.round(t * 100));
  }
});

test("monthPlus — перехід через рік", () => {
  assert.equal(monthPlus("2026-10", 0), "2026-10");
  assert.equal(monthPlus("2026-11", 2), "2027-01");
  assert.equal(monthPlus("2026-12", 12), "2027-12");
});

test("installmentRows — одна частина без due_month, N частин по місяцях", () => {
  assert.deepEqual(installmentRows(150, { parts: 1, firstMonth: "2026-10" }), [{ amount: 150, dueMonth: null, partNo: null, partsTotal: null }]);
  assert.deepEqual(installmentRows(100, { parts: 3, firstMonth: "2026-11" }), [
    { amount: 33.34, dueMonth: "2026-11", partNo: 1, partsTotal: 3 },
    { amount: 33.33, dueMonth: "2026-12", partNo: 2, partsTotal: 3 },
    { amount: 33.33, dueMonth: "2027-01", partNo: 3, partsTotal: 3 },
  ]);
});

test("parseInstallments — валідація", () => {
  assert.deepEqual(parseInstallments({ parts: 3, firstMonth: "2026-11" }), { parts: 3, firstMonth: "2026-11" });
  assert.equal((parseInstallments({}) as any).parts, 1);
  assert.equal(typeof parseInstallments({ parts: 0 }), "string");
  assert.equal(typeof parseInstallments({ parts: 13 }), "string");
  assert.equal(typeof parseInstallments({ parts: 2.5 }), "string");
  assert.equal(typeof parseInstallments({ parts: 2, firstMonth: "2026-13" }), "string");
});

test("dueBy", () => {
  assert.equal(dueBy(null, "2026-10"), true);
  assert.equal(dueBy("2026-10", "2026-10"), true);
  assert.equal(dueBy("2026-11", "2026-10"), false);
});
