import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mondayOf, weekDates, weeksOverlappingMonth, monthsOfWeek, isoMonthOfWeek, splitWeekByMonth,
  hoursBetween, flattenWeekDays, weekLabel,
} from "./weekMath.ts";

test("mondayOf / weekDates — тиждень завжди Пн–Нд", () => {
  assert.equal(mondayOf("2026-10-26"), "2026-10-26"); // понеділок
  assert.equal(mondayOf("2026-11-01"), "2026-10-26"); // неділя → той самий тиждень
  assert.equal(mondayOf("2026-10-31"), "2026-10-26");
  assert.deepEqual(weekDates("2026-10-26"), [
    "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01",
  ]);
  assert.equal(weekLabel("2026-10-26"), "26.10–01.11");
});

test("weeksOverlappingMonth — усі тижні, що мають хоч один день місяця", () => {
  // жовтень 2026: 1.10 — четвер (тиждень від 28.09), 31.10 — субота (тиждень від 26.10)
  assert.deepEqual(weeksOverlappingMonth("2026-10"), ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  // лютий 2027: 1.02 — понеділок, 28.02 — неділя: рівно 4 тижні
  assert.deepEqual(weeksOverlappingMonth("2027-02"), ["2027-02-01", "2027-02-08", "2027-02-15", "2027-02-22"]);
  assert.deepEqual(monthsOfWeek("2026-10-26"), ["2026-10", "2026-11"]);
  assert.deepEqual(monthsOfWeek("2026-10-19"), ["2026-10"]);
  assert.equal(isoMonthOfWeek("2026-10-26"), "2026-10"); // четвер 29.10
  assert.equal(isoMonthOfWeek("2026-11-30"), "2026-12"); // четвер 3.12
});

test("splitWeekByMonth — по датах, тотал масштабує дні, без днів — місяць четверга", () => {
  const days = { "2026-10-30": 8, "2026-10-31": 8, "2026-11-01": 8 };
  assert.deepEqual(splitWeekByMonth("2026-10-26", days, null), { byMonth: { "2026-10": 16, "2026-11": 8 }, straddle: false });
  // вписаний тотал 30 при сумі днів 24 → пропорційно 20/10
  assert.deepEqual(splitWeekByMonth("2026-10-26", days, 30), { byMonth: { "2026-10": 20, "2026-11": 10 }, straddle: false });
  // лише тотал на межі місяця → увесь у жовтень (четвер 29.10), прапорець straddle
  assert.deepEqual(splitWeekByMonth("2026-10-26", null, 40), { byMonth: { "2026-10": 40 }, straddle: true });
  // лише тотал усередині місяця → без прапорця
  assert.deepEqual(splitWeekByMonth("2026-10-19", {}, 40), { byMonth: { "2026-10": 40 }, straddle: false });
  // дні поза тижнем ігноруються
  assert.deepEqual(splitWeekByMonth("2026-10-26", { "2026-10-20": 8, "2026-10-27": 4 }, null), { byMonth: { "2026-10": 4 }, straddle: false });
  assert.deepEqual(splitWeekByMonth("2026-10-26", null, null), { byMonth: {}, straddle: false });
  // тотал 0 при вибраних змінах — нуль, а не сума змін
  assert.deepEqual(splitWeekByMonth("2026-10-26", days, 0), { byMonth: {}, straddle: false });
  // округлення зберігає суму: 0.25 на два місяці → 0.12 + 0.13
  assert.deepEqual(splitWeekByMonth("2026-10-26", { "2026-10-31": 4, "2026-11-01": 4 }, 0.25), { byMonth: { "2026-10": 0.13, "2026-11": 0.12 }, straddle: false });
});

test("hoursBetween — округлення 0.25, нічна зміна через північ", () => {
  assert.equal(hoursBetween(new Date("2026-10-26T20:00:00Z"), new Date("2026-10-27T04:10:00Z")), 8.25);
  assert.equal(hoursBetween(new Date("2026-10-26T20:00:00Z"), new Date("2026-10-26T19:00:00Z")), 0);
  assert.equal(hoursBetween(new Date("2026-10-26T06:00:00Z"), new Date("2026-10-26T14:07:00Z")), 8);
});

test("flattenWeekDays — позмінні значення зводяться до годин дня", () => {
  assert.deepEqual(flattenWeekDays("2026-10-26", { "2026-10-26": { "1": 8, "2": 2 }, "2026-10-27": 6, "2026-10-20": 8 }), {
    "2026-10-26": 10, "2026-10-27": 6,
  });
});
