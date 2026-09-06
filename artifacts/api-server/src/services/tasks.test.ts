// Чисті юніти модуля «Задачі»: повторення, пріоритет за днями, різниця дат.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOccurrence, priorityForDays, diffDays, normalizeChecklist } from "./taskUtils.ts";

test("nextOccurrence: daily/weekly/monthly з кінцем місяця", () => {
  assert.equal(nextOccurrence("2026-09-07", { freq: "daily" }), "2026-09-08");
  assert.equal(nextOccurrence("2026-09-07", { freq: "daily", interval: 3 }), "2026-09-10");
  assert.equal(nextOccurrence("2026-09-07", { freq: "weekly" }), "2026-09-14");
  assert.equal(nextOccurrence("2026-09-07", { freq: "weekly", weekday: 1 }), "2026-09-14", "щопонеділка з понеділка → наступний понеділок");
  assert.equal(nextOccurrence("2026-09-09", { freq: "weekly", weekday: 1 }), "2026-09-14", "зі середи → найближчий понеділок");
  assert.equal(nextOccurrence("2026-01-31", { freq: "monthly" }), "2026-02-28", "31-го → останній день лютого");
  assert.equal(nextOccurrence("2026-09-05", { freq: "monthly", monthday: 5 }), "2026-10-05");
  assert.equal(nextOccurrence("2026-12-05", { freq: "monthly" }), "2027-01-05", "перехід року");
});

test("priorityForDays: ≤7 терміново, ≤14 високий, далі звичайний, прострочене — терміново", () => {
  assert.equal(priorityForDays(-3), "urgent");
  assert.equal(priorityForDays(0), "urgent");
  assert.equal(priorityForDays(7), "urgent");
  assert.equal(priorityForDays(8), "high");
  assert.equal(priorityForDays(14), "high");
  assert.equal(priorityForDays(15), "normal");
  assert.equal(priorityForDays(null), "normal");
});

test("diffDays рядковою арифметикою (без toISOString)", () => {
  assert.equal(diffDays("2026-09-13", "2026-09-06"), 7);
  assert.equal(diffDays("2026-09-01", "2026-09-06"), -5);
  assert.equal(diffDays("2027-03-01", "2026-12-01"), 90);
});

test("normalizeChecklist: рядки → пункти з id, готові пункти лишаються", () => {
  const out = normalizeChecklist(["a", { id: "x", text: "b", done: true }]);
  assert.equal(out.length, 2); assert.equal(out[0]!.done, false); assert.ok(out[0]!.id); assert.equal(out[1]!.id, "x"); assert.equal(out[1]!.done, true);
});
