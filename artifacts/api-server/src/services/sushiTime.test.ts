import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTime,
  roundStartTime,
  roundStopTime,
  calcIntervalHours,
  validateTimeInterval,
  mergeSushiIntervals,
  type SushiIntervalData,
} from "./sushiTime.ts";

test("normalizeTime: standard strings", () => {
  assert.equal(normalizeTime("06:00"), "06:00");
  assert.equal(normalizeTime("6:5"), "06:05");
  assert.equal(normalizeTime("14:30:00"), "14:30");
  assert.equal(normalizeTime("  22:15  "), "22:15");
});

test("normalizeTime: Excel fractional numbers", () => {
  // 0.25 = 6 hours = 06:00
  assert.equal(normalizeTime(0.25), "06:00");
  // 0.5 = 12 hours = 12:00
  assert.equal(normalizeTime(0.5), "12:00");
  assert.equal(normalizeTime("0.25"), "06:00");
});

test("normalizeTime: invalid inputs", () => {
  assert.equal(normalizeTime(null), null);
  assert.equal(normalizeTime(undefined), null);
  assert.equal(normalizeTime(""), null);
  assert.equal(normalizeTime("abc"), null);
  assert.equal(normalizeTime("25:00"), null);
});

test("roundStartTime: 15-minute Round UP rule", () => {
  assert.equal(roundStartTime("06:00"), "06:00");
  assert.equal(roundStartTime("06:01"), "06:15");
  assert.equal(roundStartTime("06:14"), "06:15");
  assert.equal(roundStartTime("06:15"), "06:15");
  assert.equal(roundStartTime("06:16"), "06:30");
  assert.equal(roundStartTime("06:29"), "06:30");
  assert.equal(roundStartTime("06:30"), "06:30");
  assert.equal(roundStartTime("06:45"), "06:45");
  assert.equal(roundStartTime("06:46"), "07:00");
  assert.equal(roundStartTime("23:46"), "00:00");
});

test("roundStopTime: 15-minute Round DOWN rule", () => {
  assert.equal(roundStopTime("14:00"), "14:00");
  assert.equal(roundStopTime("14:14"), "14:00");
  assert.equal(roundStopTime("14:15"), "14:15");
  assert.equal(roundStopTime("14:29"), "14:15");
  assert.equal(roundStopTime("14:30"), "14:30");
  assert.equal(roundStopTime("14:44"), "14:30");
  assert.equal(roundStopTime("14:45"), "14:45");
  assert.equal(roundStopTime("14:59"), "14:45");
});

test("calcIntervalHours: same-day shifts", () => {
  // 06:15 to 14:00 = 7h 45m = 7.75h
  assert.equal(calcIntervalHours("06:15", "14:00"), 7.75);
  // 06:00 to 18:00 = 12.0h
  assert.equal(calcIntervalHours("06:00", "18:00"), 12.0);
  // 08:00 to 16:30 = 8.5h
  assert.equal(calcIntervalHours("08:00", "16:30"), 8.5);
});

test("calcIntervalHours: night shifts across 00:00", () => {
  // 22:00 to 06:00 = 8.0h
  assert.equal(calcIntervalHours("22:00", "06:00"), 8.0);
  // 17:00 to 05:00 = 12.0h
  assert.equal(calcIntervalHours("17:00", "05:00"), 12.0);
  // 20:00 to 04:15 = 8h 15m = 8.25h
  assert.equal(calcIntervalHours("20:00", "04:15"), 8.25);
});

test("validateTimeInterval: valid inputs and rounding", () => {
  const res = validateTimeInterval("06:01", "14:14");
  assert.equal(res.valid, true);
  assert.equal(res.normalizedStart, "06:01");
  assert.equal(res.normalizedStop, "14:14");
  assert.equal(res.roundedStart, "06:15");
  assert.equal(res.roundedStop, "14:00");
  assert.equal(res.hours, 7.75);
});

test("validateTimeInterval: missing start or stop", () => {
  const missingStart = validateTimeInterval(null, "14:00");
  assert.equal(missingStart.valid, false);
  assert.equal(missingStart.error, "MISSING_START");

  const missingStop = validateTimeInterval("06:00", "");
  assert.equal(missingStop.valid, false);
  assert.equal(missingStop.error, "MISSING_STOP");
});

test("validateTimeInterval: zero duration after rounding", () => {
  // 06:05 -> 06:15, 06:10 -> 06:00 => zero
  const zeroDur = validateTimeInterval("06:05", "06:10");
  assert.equal(zeroDur.valid, false);
  assert.equal(zeroDur.error, "ZERO_DURATION");
});

test("mergeSushiIntervals: handles duplicates", () => {
  const existing: SushiIntervalData[] = [
    { workerId: 1, date: "2026-09-01", startTime: "06:00", stopTime: "14:00", clothingDeduction: false },
  ];
  const duplicate: SushiIntervalData = {
    workerId: 1, date: "2026-09-01", startTime: "06:00", stopTime: "14:00", clothingDeduction: true,
  };

  const merged = mergeSushiIntervals(existing, duplicate);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.clothingDeduction, true); // Odzież збережено
});

test("mergeSushiIntervals: handles overlapping intervals", () => {
  const existing: SushiIntervalData[] = [
    { workerId: 1, date: "2026-09-01", startTime: "06:00", stopTime: "14:00", clothingDeduction: true },
  ];
  const extended: SushiIntervalData = {
    workerId: 1, date: "2026-09-01", startTime: "06:00", stopTime: "16:00", clothingDeduction: false,
  };

  const merged = mergeSushiIntervals(existing, extended);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.roundedStartTime, "06:00");
  assert.equal(merged[0]!.roundedStopTime, "16:00");
  assert.equal(merged[0]!.hours, 10.0);
  assert.equal(merged[0]!.clothingDeduction, true);
});

test("mergeSushiIntervals: handles separate shifts on the same day", () => {
  const existing: SushiIntervalData[] = [
    { workerId: 1, date: "2026-09-01", startTime: "06:00", stopTime: "11:00" },
  ];
  const secondShift: SushiIntervalData = {
    workerId: 1,
    date: "2026-09-01",
    startTime: "14:00",
    stopTime: "22:00",
  };

  const merged = mergeSushiIntervals(existing, secondShift);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.hours, 5.0);
  assert.equal(merged[1]!.hours, 8.0);
});
