import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedShiftForWeek, mondayOf } from "./fixedShift.ts";

test("mondayOf: будь-який день тижня → його понеділок", () => {
  assert.equal(mondayOf("2026-10-23"), "2026-10-19"); // пʼятниця
  assert.equal(mondayOf("2026-10-19"), "2026-10-19"); // понеділок
  assert.equal(mondayOf("2026-10-25"), "2026-10-19"); // неділя
  assert.equal(mondayOf("2026-03-30"), "2026-03-30"); // перехід на літній час не зсуває день
});

test("fixedShiftForWeek: без чергування — завжди закріплена; гнучкий — null", () => {
  assert.equal(fixedShiftForWeek({ fixedShift: "2" }, "2026-10-19"), "2");
  assert.equal(fixedShiftForWeek({ fixedShift: "2", fixedShiftAlt: "1", fixedShiftAnchor: null }, "2026-10-19"), "2"); // alt без якоря — не чергуємо
  assert.equal(fixedShiftForWeek({ fixedShift: null, fixedShiftAlt: "1", fixedShiftAnchor: "2026-10-19" }, "2026-10-19"), null);
});

test("fixedShiftForWeek: чергування тиждень через тиждень від якоря, і назад у минуле", () => {
  const w = { fixedShift: "2", fixedShiftAlt: "1", fixedShiftAnchor: "2026-10-19" };
  assert.equal(fixedShiftForWeek(w, "2026-10-19"), "2"); // тиждень якоря
  assert.equal(fixedShiftForWeek(w, "2026-10-26"), "1");
  assert.equal(fixedShiftForWeek(w, "2026-11-02"), "2");
  assert.equal(fixedShiftForWeek(w, "2026-11-09"), "1");
  assert.equal(fixedShiftForWeek(w, "2026-10-12"), "1"); // тиждень до якоря
  assert.equal(fixedShiftForWeek(w, "2026-10-05"), "2");
  assert.equal(fixedShiftForWeek(w, "2026-10-28"), "1"); // не-понеділок усередині тижня → той самий тиждень
  assert.equal(fixedShiftForWeek({ ...w, fixedShiftAnchor: "2026-10-21" }, "2026-10-19"), "2"); // якір не-понеділком → його тиждень
});
