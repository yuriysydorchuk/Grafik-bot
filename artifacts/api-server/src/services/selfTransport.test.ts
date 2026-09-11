// Чисті юніти «доїжджає сам» по фабриці й поденно: інтервали [since, until),
// перевірка дня, наявності в діапазоні і повного покриття діапазону.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSelfOn, hasSelfInRange, isSelfWholeRange, selfIntervalOn, intervalsOfWorker, type SelfTransportMap } from "./selfTransport";

const map: SelfTransportMap = new Map([
  ["1|10", [{ id: 1, since: "2026-08-20", until: null }]],                              // відкритий з 20.08
  ["1|11", [{ id: 2, since: "2026-06-01", until: "2026-07-01" }]],                      // лише червень
  ["2|10", [{ id: 3, since: "2026-08-01", until: "2026-08-10" }, { id: 4, since: "2026-08-10", until: null }]], // стик без дірки
]);

test("isSelfOn: межі інтервалу — since включно, until виключно; інша фабрика — ні", () => {
  assert.equal(isSelfOn(map, 1, 10, "2026-08-19"), false);
  assert.equal(isSelfOn(map, 1, 10, "2026-08-20"), true);
  assert.equal(isSelfOn(map, 1, 10, "2027-01-01"), true);
  assert.equal(isSelfOn(map, 1, 11, "2026-06-30"), true);
  assert.equal(isSelfOn(map, 1, 11, "2026-07-01"), false);
  assert.equal(isSelfOn(map, 1, 12, "2026-06-15"), false, "фабрика без запису — возить фірма");
  assert.equal(isSelfOn(map, null, 10, "2026-08-25"), false);
});

test("hasSelfInRange / isSelfWholeRange: серпень для переходу 20.08 — є self-дні, але не весь місяць", () => {
  assert.equal(hasSelfInRange(map, 1, 10, "2026-08-01", "2026-09-01"), true);
  assert.equal(isSelfWholeRange(map, 1, 10, "2026-08-01", "2026-09-01"), false);
  assert.equal(hasSelfInRange(map, 1, 10, "2026-07-01", "2026-08-01"), false, "липень — ще возили");
  assert.equal(isSelfWholeRange(map, 1, 10, "2026-09-01", "2026-10-01"), true, "вересень — весь сам");
  assert.equal(hasSelfInRange(map, 1, 11, "2026-07-01", "2026-08-01"), false, "закритий 01.07 — липня не торкається");
  assert.equal(isSelfWholeRange(map, 2, 10, "2026-08-01", "2026-09-01"), true, "два інтервали встик покривають місяць");
  assert.equal(isSelfWholeRange(map, 3, 10, "2026-08-01", "2026-09-01"), false);
});

test("selfIntervalOn / intervalsOfWorker", () => {
  assert.equal(selfIntervalOn(map, 2, 10, "2026-08-05")?.id, 3);
  assert.equal(selfIntervalOn(map, 2, 10, "2026-08-10")?.id, 4);
  assert.deepEqual([...intervalsOfWorker(map, 1).keys()], [10, 11]);
});
