// Номер паспорта у формі ≠ номер вкладеного скану → подача блокується (Koshmak Kira 21.10.2026:
// у формі номер з анкети, у вкладенні — інший паспорт); правка номера на екрані анкети знімає блок.
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingOf, applyOverrides, type UaFormPayload } from "./payload.ts";

const base = (): UaFormPayload => ({
  workerId: 1, workerName: "Koshmak Kira", companyId: 2, companyName: "ES", factoryId: 3,
  contextPattern: "EURO", miejscowosc: "Łódź", kraz: "", email: "", telefon: "",
  cudzoziemiec: {
    imie: "Kira", kolejneImiona: "", nazwisko: "Koshmak", obywatelstwo: "Ukraina",
    dokRodzaj: "Paszport", panstwoWydania: "Ukraina", seriaNr: "GM123354", dataWydania: "2025-07-14", dataWaznosci: "2035-07-14",
    pesel: "", dataUrodzenia: "2000-01-01", plec: "Kobieta", tytulPobytu: "OCHRONA CZASOWA",
  },
  praca: {
    dataPodjecia: "2026-10-20", pkdVersion: "PKD_2025", pkd: "7820Z", stanowisko: "Pracownik produkcji", zawodKod: "932101",
    miejsce: { kodPocztowy: "90-001", wojewodztwo: "łódzkie", powiat: "Łódź", gmina: "Łódź", miejscowosc: "Łódź", ulica: "", nrDomu: "", nrLokalu: "" },
    infoDodatkowe: "", rodzajUmowy: "Umowa zlecenie", godzinMiesiac: "160", stawkaGodz: "31,40", stawkaMies: "5024,00",
  },
  liczby: { umowaOPrace: "1", cywilne: "10" },
  warnings: [], podpis: { funkcja: "Prezes", pelnomocnik: false }, zalaczniki: [],
});

test("missingOf: номер паспорта у формі ≠ вкладений скан → блок; збіг (регістр/пробіли) → ок", () => {
  assert.deepEqual(missingOf(base()), []);
  const bad = { ...base(), passportScanNo: "GM123354" };
  bad.cudzoziemiec = { ...bad.cudzoziemiec, seriaNr: "WR999667" };
  assert.ok(missingOf(bad).some(m => m.includes("вкладений скан паспорта")));
  // правка номера на екрані анкети (override) — блок знято
  const fixed = applyOverrides(bad, { cudzoziemiec: { seriaNr: "gm 123354" } });
  assert.deepEqual(missingOf(fixed), []);
  // скану без номера немає з чим звіряти — не блокує
  assert.deepEqual(missingOf({ ...bad, passportScanNo: null }), []);
});
