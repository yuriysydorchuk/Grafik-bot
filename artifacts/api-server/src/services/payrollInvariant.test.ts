// C12 — golden-знімок payroll-інваріанту (звіт фази 0 «Легалізація», §3.6/§7.3).
// Для 9 значень legal_status (8 канонічних + NULL) × notify_hours 0/100 ×
// студент≤26 так/ні × force так/ні фіксуємо konto/gotówka/hoursDeclared/ksiegBrutto/
// ksiegNetto з applyLegalDefaults, пару ksiegRatesOf і сегментний розклад
// computeSegmented. Знімок зроблено ДО фази 1 модуля легалізації; будь-яка
// розбіжність = зміна listy płac, яка потребує окремого рішення власника.
//
// Оновити знімок свідомо: UPDATE_PAYROLL_GOLDEN=1 pnpm --filter @workspace/api-server run test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseLublinTab, computePayout, applyLegalDefaults, ksiegRatesOf, computeSegmented } from "./svodni.ts";

const GOLDEN = path.join(import.meta.dirname, "fixtures", "payroll-invariant.golden.json");
const STATUSES = [null, "student", "dyplom", "powiadomienie", "zus", "oczekuje", "karta_pobytu", "staly_pobyt", "polak"] as const;

const mkRow = (over: Record<string, unknown> = {}) => {
  const p = parseLublinTab("INWARIANT", [
    [46174, "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Do wypłaty Netto", "Księgowość"],
    ["OSOBA TESTOWA", "", 160, 31.4, 25.35, null, ""],
  ])!.rows[0]!;
  Object.assign(p, over);
  p.doWyplaty = computePayout(p, "Люблін");
  return p;
};
const pick = (r: any) => ({ konto: r.konto ?? null, gotowka: r.gotowka ?? null, hoursDeclared: r.hoursDeclared ?? null, ksiegBrutto: r.ksiegBrutto ?? null, ksiegNetto: r.ksiegNetto ?? null });

function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const status of STATUSES) {
    for (const notify of [null, 100]) {
      for (const stud of [false, true]) {
        for (const force of [true, false]) {
          const key = `${status ?? "NULL"}|notify=${notify ?? 0}|stud26=${stud}|force=${force}`;
          const row = mkRow({ hoursNotified: notify, isStudent: stud, under26: stud });
          applyLegalDefaults(row, force, { profileLegal: status as any, factoryLabel: "INWARIANT" });
          out[key] = { ...pick(row), rates: ksiegRatesOf(row, status as any) };
        }
        // сегменти: два вікна по 80 год з тим самим статусом
        const segKey = `SEG|${status ?? "NULL"}|notify=${notify ?? 0}|stud26=${stud}`;
        const seg = computeSegmented(
          { city: "Люблін", factoryLabel: "INWARIANT", hoursNotified: notify, premia: null, zaliczka: null, zaliczkaBd: null, hostel: null, odziez: null, dojazd: null, kara: null, komornik: null, kaucja: null, potracenia: null, extras: {} },
          [
            { hours: 80, rateNetto: 25.35, rateBrutto: 31.4, isStudent: stud, under26: stud, legal: status },
            { hours: 80, rateNetto: 25.35, rateBrutto: 31.4, isStudent: stud, under26: stud, legal: status },
          ],
          null,
        );
        out[segKey] = { parent: pick(seg.parent), segs: seg.segs.map(s => ({ ...pick(s), hoursNotified: s.hoursNotified })) };
      }
    }
  }
  return out;
}

test("golden: розклад konto/готівки по 9 статусах незмінний (інваріант listy płac)", () => {
  const actual = snapshot();
  if (process.env.UPDATE_PAYROLL_GOLDEN) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 1) + "\n");
    return;
  }
  assert.ok(fs.existsSync(GOLDEN), `нема знімка ${GOLDEN} — згенеруй: UPDATE_PAYROLL_GOLDEN=1 … run test`);
  const expected = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  for (const key of Object.keys(expected)) {
    assert.deepEqual(actual[key], expected[key], `payroll-розклад змінився для ${key} — це зміна listy płac, потрібне окреме рішення власника`);
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), "набір сценаріїв знімка змінився");
});

test("golden: класи еквівалентності — 6 статусів «оформлений» дають однакові гроші", () => {
  const classC = ["dyplom", "powiadomienie", "zus", "karta_pobytu", "staly_pobyt", "polak"];
  for (const notify of [null, 100]) {
    const results = classC.map(s => { const r = mkRow({ hoursNotified: notify }); applyLegalDefaults(r, true, { profileLegal: s as any }); return pick(r); });
    for (const r of results.slice(1)) assert.deepEqual(r, results[0], `клас C розійшовся (notify=${notify})`);
    const cash = mkRow({ hoursNotified: notify }); applyLegalDefaults(cash, true, { profileLegal: "oczekuje" });
    assert.equal(cash.konto, 0, "oczekuje → konto 0");
    const none = mkRow({ hoursNotified: notify }); applyLegalDefaults(none, true, { profileLegal: null });
    assert.equal(none.konto, 0, "NULL + force → konto 0");
  }
});
