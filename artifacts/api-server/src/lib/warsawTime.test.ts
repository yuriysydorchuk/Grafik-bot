// Конвенція часу БД (lib/db/src/warsawTime.ts): `timestamp` = настінний час Europe/Warsaw.
// Чисті юніти без БД: обидва напрямки, DST-переходи 2026 (29.03 02:00→03:00, 25.10 03:00→02:00),
// формати Postgres (мікросекунди, без секунд), round-trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toWarsawWall, fromWarsawWall } from "@workspace/db";

test("toWarsawWall: літо +2, зима +1, мілісекунди", () => {
  assert.equal(toWarsawWall(new Date("2026-07-01T10:00:00.250Z")), "2026-07-01 12:00:00.250");
  assert.equal(toWarsawWall(new Date("2026-01-15T23:30:00.000Z")), "2026-01-16 00:30:00.000");
  assert.equal(toWarsawWall(new Date("2026-10-09T13:39:25.566Z")), "2026-10-09 15:39:25.566");
});

test("fromWarsawWall: формати Postgres і зворотний мапінг", () => {
  assert.equal(fromWarsawWall("2026-10-09 15:39:25.566").toISOString(), "2026-10-09T13:39:25.566Z");
  assert.equal(fromWarsawWall("2026-10-09 15:39:25").toISOString(), "2026-10-09T13:39:25.000Z");
  assert.equal(fromWarsawWall("2026-10-09 15:39:25.123456").toISOString(), "2026-10-09T13:39:25.123Z"); // мікросекунди → мс
  assert.equal(fromWarsawWall("2026-10-09 15:39:25.123999").toISOString(), "2026-10-09T13:39:25.123Z"); // відкидання, не округлення
  assert.equal(fromWarsawWall("2026-10-25 01:59:59.999999").toISOString(), "2026-10-24T23:59:59.999Z"); // ревʼю codex: .999999 не перекидає в двозначну годину
  assert.equal(fromWarsawWall("2026-01-16 00:30").toISOString(), "2026-01-15T23:30:00.000Z");
  assert.equal(fromWarsawWall("2026-10-09T15:39:25.566").toISOString(), "2026-10-09T13:39:25.566Z"); // ISO-розділювач
});

test("DST: весняний стрибок і осіння двозначність", () => {
  // 29.03.2026 02:00 CET → 03:00 CEST: 01:59:59 ще +1, 03:00:00 уже +2
  assert.equal(fromWarsawWall("2026-03-29 01:59:59").toISOString(), "2026-03-29T00:59:59.000Z");
  assert.equal(fromWarsawWall("2026-03-29 03:00:00").toISOString(), "2026-03-29T01:00:00.000Z");
  // неіснуюча година (02:30) не падає й лягає в межі [00:59:59Z, 01:30:00Z]
  const gap = fromWarsawWall("2026-03-29 02:30:00").getTime();
  assert.ok(gap >= Date.parse("2026-03-29T00:59:59Z") && gap <= Date.parse("2026-03-29T01:30:00Z"), new Date(gap).toISOString());
  // 25.10.2026 03:00 CEST → 02:00 CET: 02:30 двозначне — беремо першу (літню) годину, детерміновано
  assert.equal(fromWarsawWall("2026-10-25 02:30:00").toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(fromWarsawWall("2026-10-25 01:59:59").toISOString(), "2026-10-24T23:59:59.000Z");
  assert.equal(fromWarsawWall("2026-10-25 03:00:00").toISOString(), "2026-10-25T02:00:00.000Z");
  assert.equal(toWarsawWall(new Date("2026-10-25T00:30:00Z")), "2026-10-25 02:30:00.000"); // ще CEST
  assert.equal(toWarsawWall(new Date("2026-10-25T01:30:00Z")), "2026-10-25 02:30:00.000"); // уже CET
  assert.equal(toWarsawWall(new Date("2026-10-25T02:30:00Z")), "2026-10-25 03:30:00.000");
});

test("round-trip по всьому 2026 з кроком 7 год", () => {
  // єдиний виняток round-trip — друга (зимова) копія двозначної години 25.10 02:00–03:00 CET,
  // яку naive timestamp принципово не розрізняє
  const ambFrom = Date.parse("2026-10-25T01:00:00Z"), ambTo = Date.parse("2026-10-25T02:00:00Z");
  for (let t = Date.parse("2026-01-01T00:00:00Z"); t < Date.parse("2027-01-01T00:00:00Z"); t += 7 * 3600_000 + 123) {
    if (t >= ambFrom && t < ambTo) continue;
    const d = new Date(t);
    assert.equal(fromWarsawWall(toWarsawWall(d)).getTime(), t, d.toISOString());
  }
});

test("не настінний рядок (ISO з Z) — як є; Invalid Date — помилка", () => {
  assert.equal(fromWarsawWall("2026-10-09T13:39:25.566Z").toISOString(), "2026-10-09T13:39:25.566Z");
  assert.throws(() => toWarsawWall(new Date("nope")), RangeError);
});
