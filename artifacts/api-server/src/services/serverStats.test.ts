import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trimSamples, aggregateSamples, serverVerdict, fmtGb, fmtUptime,
  type StatSample,
} from "./serverStats.ts";

const NOW = 1_800_000_000; // епоха в секундах, довільна точка
const sample = (agoSec: number, l: number, ma: number, mt = 4096): StatSample =>
  ({ t: NOW - agoSec, l, ma, mt });

test("trimSamples: тримає вікно 7 днів, ріже старе і майбутнє", () => {
  const eightDays = 8 * 24 * 3600;
  const samples = [
    sample(eightDays, 0.5, 2000),        // застаріле — геть
    sample(3600, 0.5, 2000),             // годину тому — лишається
    { t: NOW + 3600, l: 0.5, ma: 2000, mt: 4096 }, // «з майбутнього» (збитий годинник) — геть
    { t: NaN, l: 0.5, ma: 2000, mt: 4096 },        // сміття — геть
  ];
  const kept = trimSamples(samples, NOW);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.t, NOW - 3600);
});

test("trimSamples: капить кількість, лишаючи найсвіжіші", () => {
  const many = Array.from({ length: 900 }, (_, i) => sample(900 - i, 0.1, 2000));
  const kept = trimSamples(many, NOW);
  assert.equal(kept.length, 800);
  assert.equal(kept[kept.length - 1]!.t, NOW - 1); // найсвіжіший вижив
});

test("aggregateSamples: load у % від ядер, RAM used із MemAvailable", () => {
  // 2 ядра: load 1.0 = 50%, load 2.0 = 100%; RAM 4096: available 1024 → used 75%
  const agg = aggregateSamples([sample(60, 1.0, 2048), sample(30, 2.0, 1024)], 2);
  assert.ok(agg);
  assert.equal(agg.count, 2);
  assert.equal(agg.avgLoadPct, 75);
  assert.equal(agg.maxLoadPct, 100);
  assert.equal(agg.avgMemUsedPct, 63); // (50 + 75) / 2 = 62.5 → 63
  assert.equal(agg.maxMemUsedPct, 75);
  assert.equal(agg.memTotalMb, 4096);
});

test("aggregateSamples: порожньо або лише биті семпли → null", () => {
  assert.equal(aggregateSamples([], 2), null);
  assert.equal(aggregateSamples([{ t: NOW, l: -1, ma: 0, mt: 0 }], 2), null);
});

test("serverVerdict: усе в нормі → ok без причин", () => {
  const agg = aggregateSamples([sample(60, 0.2, 3000)], 2)!;
  assert.deepEqual(serverVerdict(48, agg), { level: "ok", reasons: [] });
  assert.deepEqual(serverVerdict(null, null), { level: "ok", reasons: [] });
});

test("serverVerdict: пороги диска — 80 warn, 90 crit", () => {
  assert.equal(serverVerdict(80, null).level, "warn");
  assert.equal(serverVerdict(90, null).level, "crit");
  assert.equal(serverVerdict(79, null).level, "ok");
});

test("serverVerdict: стабільний load ≥70% — crit; пік ≥90% — warn", () => {
  const hot = aggregateSamples([sample(60, 1.5, 3000)], 2)!;   // 75% стабільно
  assert.equal(serverVerdict(10, hot).level, "crit");
  const spiky = aggregateSamples([sample(60, 0.2, 3000), sample(30, 1.9, 3000)], 2)!; // сер. 53%... пік 95%
  assert.equal(serverVerdict(10, spiky).level, "warn");
});

test("serverVerdict: RAM — сер. 80% warn, 90% crit; crit-причини попереду", () => {
  const ram85 = aggregateSamples([sample(60, 0.1, 614)], 2)!;  // used 85%
  assert.equal(serverVerdict(10, ram85).level, "warn");
  const ram95 = aggregateSamples([sample(60, 0.1, 205)], 2)!;  // used 95%
  const v = serverVerdict(85, ram95); // диск warn + RAM crit
  assert.equal(v.level, "crit");
  assert.match(v.reasons[0]!, /RAM/);
  assert.match(v.reasons[1]!, /диск/);
});

test("fmtGb / fmtUptime: людські формати", () => {
  assert.equal(fmtGb(38.25 * 1024 ** 3), "38.3 GB");
  assert.equal(fmtGb(120 * 1024 ** 3), "120 GB");
  assert.equal(fmtGb(512 * 1024 ** 2), "512 MB");
  assert.equal(fmtUptime(6 * 86400 + 5 * 3600), "6 дн 5 год");
  assert.equal(fmtUptime(3 * 3600 + 20 * 60), "3 год 20 хв");
  assert.equal(fmtUptime(15 * 60), "15 хв");
});
