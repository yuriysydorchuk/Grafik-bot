import { test } from "node:test";
import assert from "node:assert/strict";
import { listaRecords, exportNameOf, type ListaSourceRow } from "./gratyfikantExport.ts";

const row = (over: Partial<ListaSourceRow>): ListaSourceRow => ({
  id: 1, rawName: "Kowalski Jan", workerName: "Kowalski Jan", gratyfikantName: null,
  pesel: "90010112345", factoryLabel: "SUPERDROB", firm: "ES",
  ksiegBrutto: 3140, konto: 2500, segmentOf: null, ...over,
});

test("ліста: базовий запис — імʼя/PESEL/дата/сума, критерій konto>0", () => {
  const recs = listaRecords([row({}), row({ id: 2, konto: 0, rawName: "Bez Konta" })],
    { firm: "ES", payDate: "2026-08-25" });
  assert.deepEqual(recs, [{ rowId: 1, name: "Kowalski Jan", pesel: "90010112345", data: "2026-08-25", kwota: 3140 }]);
});

test("ліста: пріоритет імені gratyfikant_name → профіль → raw; PESEL порожній = «»", () => {
  const recs = listaRecords([
    row({ id: 1, gratyfikantName: "KOWALSKI JAN", pesel: null }),
    row({ id: 2, workerName: null, rawName: "Tylko Raw", factoryLabel: "AGRAM" }),
  ], { firm: "ES", payDate: "2026-08-25" });
  assert.equal(recs[0]!.name, "Tylko Raw");      // AGRAM сортується перед SUPERDROB
  assert.equal(recs[1]!.name, "KOWALSKI JAN");
  assert.equal(recs[1]!.pesel, "");
});

test("ліста: фільтри — фірма, вибрані фабрики (normLabel), офісні вкладки, сегменти", () => {
  const recs = listaRecords([
    row({ id: 1 }),
    row({ id: 2, firm: "ESO", rawName: "Chuzha Firma" }),
    row({ id: 3, factoryLabel: "Офис Люблін", rawName: "Office" }),
    row({ id: 4, segmentOf: 9, rawName: "Segment" }),
    row({ id: 5, factoryLabel: "Scandic Food", rawName: "Inna Fabryka" }),
  ], { firm: "ES", payDate: "2026-08-25", factoryLabels: ["SUPERDROB"] });
  assert.deepEqual(recs.map(r => r.rowId), [1]);
});

test("ліста: скоуп «всі фабрики» = порожній factoryLabels; копійки округлюються", () => {
  const recs = listaRecords([
    row({ id: 1, ksiegBrutto: 1234.5678 }),
    row({ id: 2, factoryLabel: "Scandic Food", rawName: "Inna Osoba" }),
  ], { firm: "ES", payDate: "2026-08-25" });
  assert.equal(recs.length, 2);
  assert.equal(recs.find(r => r.rowId === 1)!.kwota, 1234.57);
});

test("exportNameOf: зайві пробіли колапсують", () => {
  assert.equal(exportNameOf({ gratyfikantName: null, workerName: null, rawName: "  Nowak   Anna " }), "Nowak Anna");
});
