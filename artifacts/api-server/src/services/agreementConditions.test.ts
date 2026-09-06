import { test } from "node:test";
import assert from "node:assert/strict";
import { nextMonth, monthRange, inAgreementRange } from "./agreementConditions.ts";

test("nextMonth: within a year", () => {
  assert.equal(nextMonth("2026-01"), "2026-02");
  assert.equal(nextMonth("2026-08"), "2026-09");
});

test("nextMonth: crosses a year boundary", () => {
  assert.equal(nextMonth("2026-12"), "2027-01");
});

test("monthRange: inclusive of both ends", () => {
  assert.deepEqual(monthRange("2026-06", "2026-08"), ["2026-06", "2026-07", "2026-08"]);
});

test("monthRange: single month when from === to", () => {
  assert.deepEqual(monthRange("2026-06", "2026-06"), ["2026-06"]);
});

test("monthRange: empty when from > to", () => {
  assert.deepEqual(monthRange("2026-08", "2026-06"), []);
});

test("monthRange: crosses a year boundary", () => {
  assert.deepEqual(monthRange("2026-11", "2027-02"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
});

test("inAgreementRange: inactive condition is never in range", () => {
  assert.equal(inAgreementRange({ active: false, startMonth: "2026-01", endMonth: null }, "2026-06"), false);
});

test("inAgreementRange: one_time-style condition (startMonth === endMonth)", () => {
  const c = { active: true, startMonth: "2026-06", endMonth: "2026-06" };
  assert.equal(inAgreementRange(c, "2026-05"), false);
  assert.equal(inAgreementRange(c, "2026-06"), true);
  assert.equal(inAgreementRange(c, "2026-07"), false);
});

test("inAgreementRange: fixed_term — before start / within / after end", () => {
  const c = { active: true, startMonth: "2026-06", endMonth: "2026-08" };
  assert.equal(inAgreementRange(c, "2026-05"), false);
  assert.equal(inAgreementRange(c, "2026-06"), true);
  assert.equal(inAgreementRange(c, "2026-08"), true);
  assert.equal(inAgreementRange(c, "2026-09"), false);
});

test("inAgreementRange: indefinite (endMonth null) — open-ended into the future", () => {
  const c = { active: true, startMonth: "2026-06", endMonth: null };
  assert.equal(inAgreementRange(c, "2026-06"), true);
  assert.equal(inAgreementRange(c, "2030-01"), true);
  assert.equal(inAgreementRange(c, "2026-05"), false);
});

test("inAgreementRange: early termination (endMonth patched into the past)", () => {
  const c = { active: true, startMonth: "2026-01", endMonth: "2026-03" };
  assert.equal(inAgreementRange(c, "2026-03"), true);
  assert.equal(inAgreementRange(c, "2026-04"), false);
});
