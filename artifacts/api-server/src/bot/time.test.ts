import { test } from "node:test";
import assert from "node:assert/strict";
import { factoryShiftStart, shiftAnchor } from "./time.ts";

test("factoryShiftStart uses factory time, falls back to defaults", () => {
  const f = { shift1Start: null, shift2Start: "13:30", shift3Start: null };
  assert.equal(factoryShiftStart(f, "1"), "06:00"); // default
  assert.equal(factoryShiftStart(f, "2"), "13:30"); // custom
  assert.equal(factoryShiftStart(f, "3"), "22:00"); // default
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
