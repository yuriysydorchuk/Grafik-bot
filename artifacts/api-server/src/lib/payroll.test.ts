import { test } from "node:test";
import assert from "node:assert/strict";
import { calcPayroll, round2, DEFAULT_RATES } from "./payroll.ts";

const near = (actual: number, expected: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) < 0.005, msg ?? `${actual} ≉ ${expected}`);

test("student under 26 is fully exempt: net = gross, no employer cost on top", () => {
  const r = calcPayroll(5000, true, true);
  assert.equal(r.net, 5000);
  assert.equal(r.eeSocial, 0);
  assert.equal(r.eeHealth, 0);
  assert.equal(r.erTotal, 0);
  assert.equal(r.laborCost, 5000);
});

test("student 26+ is NOT exempt — both flags are required", () => {
  const r = calcPayroll(5000, true, false);
  assert.ok(r.eeTotal > 0);
  assert.ok(r.net < 5000);
});

test("regular worker: social, then health on (gross − social), PIT = 0", () => {
  const gross = 1000;
  const r = calcPayroll(gross, false, false);
  // social = 9.76% + 1.5% + 0% = 11.26%
  near(r.eeSocial, 112.6);
  // health = 9% of (1000 − 112.60) = 79.866
  near(r.eeHealth, 79.87);
  near(r.eeTotal, r.eeSocial + r.eeHealth);
  near(r.net, gross - r.eeTotal);
  // employer ZUS = 9.76 + 6.5 + 1.67 + 2.45 + 0.10 = 20.48%
  near(r.erTotal, 204.8);
  near(r.laborCost, gross + r.erTotal);
});

test("voluntary sickness rate joins employee social when configured", () => {
  const r = calcPayroll(1000, false, false, { ...DEFAULT_RATES, eeSickness: 2.45 });
  near(r.eeSocial, 137.1); // 9.76 + 1.5 + 2.45 = 13.71%
});

test("zero and negative gross produce an all-zero result", () => {
  for (const gross of [0, -50]) {
    const r = calcPayroll(gross, false, false);
    assert.deepEqual(r, { gross: 0, eeSocial: 0, eeHealth: 0, eeTotal: 0, net: 0, erTotal: 0, laborCost: 0 });
  }
});

test("round2 rounds to two decimals", () => {
  assert.equal(round2(79.866), 79.87);
  assert.equal(round2(204.804), 204.8);
  assert.equal(round2(112.6), 112.6);
});
