import { test } from "node:test";
import assert from "node:assert/strict";
import { factoryShiftStart, shiftAnchor, factoryShiftHours, minutesUntilShift, pickupAssignmentSlot } from "./time.ts";

test("factoryShiftStart resolves shifts positionally, falls back to the default", () => {
  // prefers the `shifts` JSON over legacy columns
  const js = {
    shifts: [{ start: "05:45", end: "13:30" }, { start: "13:30", end: "21:15" }],
    shift1Start: "07:00", shift2Start: null, shift3Start: null,
  };
  assert.equal(factoryShiftStart(js, "1"), "05:45");
  assert.equal(factoryShiftStart(js, "2"), "13:30");

  // legacy columns are compacted: the only configured time becomes shift 1
  const f = { shift1Start: null, shift2Start: "13:30", shift3Start: null };
  assert.equal(factoryShiftStart(f, "1"), "13:30"); // first (and only) shift
  assert.equal(factoryShiftStart(f, "2"), "06:00"); // not configured → default

  assert.equal(factoryShiftStart(undefined, "1"), "06:00");
  // malformed value ignored
  assert.equal(factoryShiftStart({ shift1Start: "oops", shift2Start: null, shift3Start: null }, "1"), "06:00");
});

test("shiftAnchor subtracts the offset (pickup 1h before, factory 15m before)", () => {
  const base = new Date(2026, 5, 1, 12, 0, 0);
  const pickup = shiftAnchor(base, "06:00", 60);
  assert.equal(pickup.getHours(), 5);
  assert.equal(pickup.getMinutes(), 0);

  const factory = shiftAnchor(base, "14:00", 15);
  assert.equal(factory.getHours(), 13);
  assert.equal(factory.getMinutes(), 45);

  const wrap = shiftAnchor(base, "06:10", 15);
  assert.equal(wrap.getHours(), 5);
  assert.equal(wrap.getMinutes(), 55);
});

test("factoryShiftHours: day, overnight and fractional shifts; default 8", () => {
  const f = {
    shifts: [
      { start: "06:00", end: "14:00" },  // plain 8h
      { start: "22:00", end: "06:00" },  // overnight 8h
      { start: "05:45", end: "13:30" },  // 7h45 = 7.75
    ],
  };
  assert.equal(factoryShiftHours(f, "1"), 8);
  assert.equal(factoryShiftHours(f, "2"), 8);
  assert.equal(factoryShiftHours(f, "3"), 7.75);
  assert.equal(factoryShiftHours(f, "4"), 8);        // not configured → default
  assert.equal(factoryShiftHours(undefined, "1"), 8);
});

test("minutesUntilShift: same day, midnight wrap, and recently-started shifts", () => {
  const at = (h: number, m: number) => new Date(2026, 6, 6, h, m, 0, 0).getTime();
  assert.equal(minutesUntilShift(at(14, 0), "16:00"), 120);   // 2h before
  assert.equal(minutesUntilShift(at(23, 30), "01:15"), 105);  // next-day shift over midnight
  assert.equal(minutesUntilShift(at(10, 0), "08:00"), -120);  // started 2h ago — NOT wrapped
  assert.equal(minutesUntilShift(at(10, 0), "07:59"), 1319);  // >2h ago → treated as tomorrow's
});

test("pickupAssignmentSlot: overnight shift lives on the day it STARTED", () => {
  // day shift → same day, same week
  assert.deepEqual(pickupAssignmentSlot("tue", "2026-07-06", "06:00", "14:00"),
    { day: "tue", weekStart: "2026-07-06" });
  // overnight (22:00–06:00), reminder fires on Tuesday → assignment is Monday's row
  assert.deepEqual(pickupAssignmentSlot("tue", "2026-07-06", "22:00", "06:00"),
    { day: "mon", weekStart: "2026-07-06" });
  // overnight ending Monday morning → Sunday of the PREVIOUS week
  assert.deepEqual(pickupAssignmentSlot("mon", "2026-07-06", "22:00", "06:00"),
    { day: "sun", weekStart: "2026-06-29" });
  // end == start counts as crossing midnight (24h edge)
  assert.equal(pickupAssignmentSlot("wed", "2026-07-06", "06:00", "06:00").day, "tue");
  // no start time known → treated as a day shift
  assert.deepEqual(pickupAssignmentSlot("mon", "2026-07-06", null, "06:00"),
    { day: "mon", weekStart: "2026-07-06" });
});
