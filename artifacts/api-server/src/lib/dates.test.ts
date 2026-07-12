import { test } from "node:test";
import assert from "node:assert/strict";
import { entryDateStr, weekFromForMonth, addDaysStr, DAYS } from "./dates.ts";

// These helpers must format from LOCAL calendar parts, not toISOString (the prod server runs
// in Europe/Berlin, where a UTC-based YYYY-MM-DD would be off by a day near midnight).

test("entryDateStr: Monday is the week start (offset 0)", () => {
  assert.equal(entryDateStr("2026-07-06", "mon"), "2026-07-06");
});

test("entryDateStr: mid-week and Sunday offsets", () => {
  assert.equal(entryDateStr("2026-07-06", "thu"), "2026-07-09");
  assert.equal(entryDateStr("2026-07-06", "sun"), "2026-07-12");
});

test("entryDateStr: a week straddling the month boundary attributes days to their real month", () => {
  // Week starting Mon 29 Jun 2026 — Mon–Tue are June, Wed onward are July.
  assert.equal(entryDateStr("2026-06-29", "mon"), "2026-06-29");
  assert.equal(entryDateStr("2026-06-29", "wed"), "2026-07-01");
  assert.equal(entryDateStr("2026-06-29", "sun"), "2026-07-05");
});

test("entryDateStr: null/unknown day falls back to the Monday", () => {
  assert.equal(entryDateStr("2026-07-06", null), "2026-07-06");
  assert.equal(entryDateStr("2026-07-06", "zzz"), "2026-07-06");
});

test("entryDateStr: crosses a year boundary correctly", () => {
  // Mon 28 Dec 2026 + Sunday(6) = 3 Jan 2027.
  assert.equal(entryDateStr("2026-12-28", "sun"), "2027-01-03");
});

test("weekFromForMonth: lower bound is 6 days before the month start", () => {
  assert.equal(weekFromForMonth("2026-07-01"), "2026-06-25");
});

test("weekFromForMonth: backs across a year boundary", () => {
  assert.equal(weekFromForMonth("2026-01-01"), "2025-12-26");
});

test("addDaysStr: forward and backward, across month and year boundaries", () => {
  assert.equal(addDaysStr("2026-07-06", 3), "2026-07-09");
  assert.equal(addDaysStr("2026-07-31", 1), "2026-08-01");
  assert.equal(addDaysStr("2026-01-01", -1), "2025-12-31");
  assert.equal(addDaysStr("2026-07-06", 0), "2026-07-06");
});

test("DAYS is Mon-first and complete", () => {
  assert.deepEqual(DAYS, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
});
