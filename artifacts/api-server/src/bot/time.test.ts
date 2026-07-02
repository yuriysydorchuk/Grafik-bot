import { test } from "node:test";
import assert from "node:assert/strict";
import { factoryShiftStart, shiftAnchor } from "./time.ts";

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
