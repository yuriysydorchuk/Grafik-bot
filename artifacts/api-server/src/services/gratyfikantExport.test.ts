import { test } from "node:test";
import assert from "node:assert/strict";
import { gratyfikantRecords, GRATYFIKANT_SKLADNIK, type GratyfikantSource } from "./gratyfikantExport.ts";

const row = (over: Partial<GratyfikantSource>): GratyfikantSource => ({
  rawName: "Kowalski Jan",
  factoryLabel: "EUROCASH",
  firm: "ES",
  ksiegBrutto: 3140,
  segmentOf: null,
  ...over,
});

test("gratyfikant: базовий запис — naliczenie «Rachunki - kwota rachunku» з księg. brutto", () => {
  const recs = gratyfikantRecords([row({})], { firm: "ES", date: "2026-08-14" });
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0], {
    pracownik: "Kowalski Jan",
    data: "2026-08-14",
    rodzaj: "naliczenie",
    skladnik: GRATYFIKANT_SKLADNIK,
    wartosc: 3140,
  });
});

test("gratyfikant: людина на 2 фабриках = 2 окремі записи (окремі rachunki)", () => {
  const recs = gratyfikantRecords([
    row({ factoryLabel: "EUROCASH", ksiegBrutto: 2000 }),
    row({ factoryLabel: "AGRAM", ksiegBrutto: 1500 }),
  ], { firm: "ES", date: "2026-08-14" });
  assert.equal(recs.length, 2);
  // сортування по фабриці (pl), потім по імені
  assert.deepEqual(recs.map(r => r.wartosc), [1500, 2000]);
});

test("gratyfikant: фільтр фірми — чужа фірма і рядки без фірми не входять", () => {
  const recs = gratyfikantRecords([
    row({ firm: "ES" }),
    row({ firm: "ESO", rawName: "Nowak Anna" }),
    row({ firm: null, rawName: "Bez Firmy" }),
  ], { firm: "ESO", date: "2026-08-14" });
  assert.deepEqual(recs.map(r => r.pracownik), ["Nowak Anna"]);
});

test("gratyfikant: сегменти, нульове/відсутнє brutto, офісні вкладки і «Додаткові студенти» — пропускаються", () => {
  const recs = gratyfikantRecords([
    row({}),
    row({ segmentOf: 7, rawName: "Segment Child" }),
    row({ ksiegBrutto: 0, rawName: "Zero Brutto" }),
    row({ ksiegBrutto: null, rawName: "Null Brutto" }),
    row({ factoryLabel: "Офис Люблін", rawName: "Office Person" }),
    row({ factoryLabel: "Додаткові студенти", rawName: "Extra Student" }),
  ], { firm: "ES", date: "2026-08-14" });
  assert.deepEqual(recs.map(r => r.pracownik), ["Kowalski Jan"]);
});

test("gratyfikant: фільтр фабрики нечутливий до регістру/розділювачів (normLabel)", () => {
  const recs = gratyfikantRecords([
    row({ factoryLabel: "Scandic Food" }),
    row({ factoryLabel: "EUROCASH", rawName: "Inna Osoba" }),
  ], { firm: "ES", date: "2026-08-14", factoryLabel: "SCANDIC FOOD" });
  assert.deepEqual(recs.map(r => r.pracownik), ["Kowalski Jan"]);
});

test("gratyfikant: копійки округлюються, зайві пробіли в імені колапсують", () => {
  const recs = gratyfikantRecords(
    [row({ ksiegBrutto: 1234.5678, rawName: "  Kowalski   Jan " })],
    { firm: "ES", date: "2026-08-14" });
  assert.equal(recs[0]!.wartosc, 1234.57);
  assert.equal(recs[0]!.pracownik, "Kowalski Jan");
});
