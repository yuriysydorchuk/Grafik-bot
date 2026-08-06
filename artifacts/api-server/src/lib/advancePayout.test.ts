import { test } from "node:test";
import assert from "node:assert/strict";
import { payoutFor } from "./advancePayout.ts";

test("payoutFor: 1–14 → група 15-го цього місяця", () => {
  assert.deepEqual(payoutFor("2026-08-01"), { payoutMonth: "2026-08", payoutGroup: "15" });
  assert.deepEqual(payoutFor("2026-08-14"), { payoutMonth: "2026-08", payoutGroup: "15" });
});

test("payoutFor: 15–29 → група 30-го цього місяця", () => {
  assert.deepEqual(payoutFor("2026-08-15"), { payoutMonth: "2026-08", payoutGroup: "30" });
  assert.deepEqual(payoutFor("2026-08-29"), { payoutMonth: "2026-08", payoutGroup: "30" });
});

test("payoutFor: 30–31 → група 15-го наступного місяця", () => {
  assert.deepEqual(payoutFor("2026-08-30"), { payoutMonth: "2026-09", payoutGroup: "15" });
  assert.deepEqual(payoutFor("2026-08-31"), { payoutMonth: "2026-09", payoutGroup: "15" });
  // межа року
  assert.deepEqual(payoutFor("2026-12-30"), { payoutMonth: "2027-01", payoutGroup: "15" });
});

test("payoutFor: лютий — 28/29 лишаються в групі 30-го свого місяця", () => {
  assert.deepEqual(payoutFor("2026-02-28"), { payoutMonth: "2026-02", payoutGroup: "30" });
  assert.deepEqual(payoutFor("2028-02-29"), { payoutMonth: "2028-02", payoutGroup: "30" });
});

test("payoutFor: некоректна дата — кидає", () => {
  assert.throws(() => payoutFor("31.08.2026"));
  assert.throws(() => payoutFor(""));
});
