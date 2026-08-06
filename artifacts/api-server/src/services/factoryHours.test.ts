import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { hhmmToHours, parseHoursValue, parseFactoryHoursWorkbook, parseFactoryHoursText, dedupeDoubledName, monthFromPolishFilename } from "./factoryHours.ts";

const wbBuf = (aoa: unknown[][], sheetName = "Sheet"): Buffer => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
};

const wbBufMulti = (sheets: [string, unknown[][]][]): Buffer => {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
};

// ── значення годин ────────────────────────────────────────────────────────────

test("hhmmToHours: HH:MM → десяткові", () => {
  assert.equal(hhmmToHours("136:00"), 136);
  assert.equal(hhmmToHours("93:52"), 93.87);
  assert.equal(hhmmToHours("00:00"), 0);
  assert.equal(hhmmToHours("8"), null);
  assert.equal(hhmmToHours("12:71"), null);
});

test("parseHoursValue: десяткові з крапкою/комою та HH:MM", () => {
  assert.equal(parseHoursValue("216.5"), 216.5);
  assert.equal(parseHoursValue("216,5"), 216.5);
  assert.equal(parseHoursValue("143:30"), 143.5);
  assert.equal(parseHoursValue("W"), null);
  assert.equal(parseHoursValue(""), null);
});

test("dedupeDoubledName: здубльоване RCP-ім'я згортається, звичайне — ні", () => {
  assert.equal(dedupeDoubledName("Petrenko Oleksii Petrenko Oleksii"), "Petrenko Oleksii");
  assert.equal(dedupeDoubledName("Volokitin Vladyslav  Volokitin Vladyslav "), "Volokitin Vladyslav");
  assert.equal(dedupeDoubledName("Kolotok Olech"), "Kolotok Olech");
  // 4 різні токени (подвійне прізвище/ім'я) — не чіпаємо
  assert.equal(dedupeDoubledName("Anna Maria Kowalska Nowak"), "Anna Maria Kowalska Nowak");
});

// ── формат A: матриця (EUROSUPPORT CZERWIEC) ─────────────────────────────────

const MATRIX = [
  [null, "06.2026"],
  [null, "Imię i nazwisko", "1", "2", "3", "Razem godziny"],
  ["1", "Abovtan Erick", "8", "8", "8.5", "24.5"],
  ["2", "Admire  Kufakunesu", "NN", "W", "8", "8"],
  ["3", "Bez Godzin", "W", "W", "W", ""], // порожній підсумок → пропускається
  [null, null, null, null, null, "32.5"], // підсумковий рядок без імені
];

test("matrix: імена + Razem godziny + розбивка по днях, місяць з MM.YYYY", () => {
  const f = parseFactoryHoursWorkbook(wbBuf(MATRIX));
  assert.equal(f.format, "matrix");
  assert.equal(f.monthDetected, "2026-06");
  assert.deepEqual(f.rows, [
    { name: "Abovtan Erick", hours: 24.5, days: { 1: 8, 2: 8, 3: 8.5 } },
    { name: "Admire Kufakunesu", hours: 8, days: { 3: 8 } }, // подвійний пробіл згорнутий; W/NN — не робочі дні
  ]);
});

// ── формат B: lista dni szczegółowo (Lublin/Motycz) ──────────────────────────

const LISTA = [
  [" Chinakitzwa Mitchell  [1082] Czas i obecności - lista dni szczegółowo (2026-06-01 - 2026-06-30)"],
  ["Data", "Kolor", null, null, "Nazwa dnia pracy", null, null, "Zdarzenie RCP", "Rejestrator", "Komentarz", null, null, "Czas łączny", null, "Czas zaliczony"],
  ["01.06.2026", null, null, null, "Agencja pracy i Zlecenie", null, null, null, null, "Suma:", null, null, "08:27", null, "08:00"],
  [],
  ["Podsumowanie (2026-06-01 - 2026-06-30) "],
  ["Nazwa", null, null, null, null, null, null, null, null, null, "Wartość"],
  ["Godzin do wypracowania", null, null, null, null, null, null, null, null, null, "00:00"],
  ["Godzin zaliczonych", null, null, null, null, null, null, null, null, null, "136:00"],
  ["Bilans", null, null, null, null, null, null, null, null, null, "00:00"],
  ["Artem  Yudin [771] Czas i obecności - lista dni szczegółowo (2026-06-01 - 2026-06-30)"],
  ["Podsumowanie (2026-06-01 - 2026-06-30) "],
  ["Godzin zaliczonych", null, null, null, null, null, null, null, null, null, "93:52"],
  ["Zerowy  Pracownik [900] Czas i obecności - lista dni szczegółowo (2026-06-01 - 2026-06-30)"],
  ["Podsumowanie (2026-06-01 - 2026-06-30) "],
  ["Godzin zaliczonych", null, null, null, null, null, null, null, null, null, "00:00"],
];

test("lista: секції по людині, сума «Godzin zaliczonych», денні рядки, місяць із заголовка", () => {
  const f = parseFactoryHoursWorkbook(wbBuf(LISTA));
  assert.equal(f.format, "lista");
  assert.equal(f.monthDetected, "2026-06");
  assert.deepEqual(f.rows, [
    { name: "Chinakitzwa Mitchell", hours: 136, days: { 1: 8 } }, // денний рядок 01.06 → 08:00 zaliczony
    { name: "Artem Yudin", hours: 93.87 },
    { name: "Zerowy Pracownik", hours: 0 }, // нульові — теж рядок (адмін вирішує в превʼю)
  ]);
});

test("невідомий формат → помилка", () => {
  assert.throws(() => parseFactoryHoursWorkbook(wbBuf([["Random"], ["stuff", "42"]])));
});

// ── формат D: ewidencja зі змінами I/II/III (ANDROS) ─────────────────────────
// День = 3 підколонки (merge номера дня над першою), підсумок — SUMA,
// premia окремо (в години не входить), останнім — UMOWY (дата договору).

const EW_HEADER = [
  ["SUMA", "premia", "Imię Nazwisko", "1", null, null, "2", null, null, "UMOWY"],
  [null, null, null, "I", "II", "III", "I", "II", "III", null],
];
const EW_KOBIETY = [
  ...EW_HEADER,
  ["16.00", "8.00", "ARISTOVA MARIIA", "8.00", null, null, null, null, "8.00", "21.07"],
  ["8.00", null, "BIBET TOMIRIS - KJ", null, "4.00", "4.00", null, null, null, "10.06"],
  ["", null, "BEZ SUMY", null, null, null, "8.00", null, null, null], // без підсумку → пропуск
];
const EW_MEZCZYZNI = [
  ...EW_HEADER,
  ["12.00", null, "BATSAN SERHII - WÓZ", "8.00", null, null, "4.00", null, null, "3.06"],
];

test("ewidencja: SUMA + зміни I/II/III, аркуші зливаються, суфікс посади зрізається", () => {
  const f = parseFactoryHoursWorkbook(wbBufMulti([["KOBIETY", EW_KOBIETY], ["MĘŻCZYZNI", EW_MEZCZYZNI]]));
  assert.equal(f.format, "ewidencja");
  assert.equal(f.monthDetected, null); // дати в аркуші немає — місяць з імені файла
  assert.deepEqual(f.rows, [
    // дні — ПО ЗМІНАХ (№ зміни з римської I/II/III); premia не в годинах; UMOWY не день
    { name: "ARISTOVA MARIIA", hours: 16, days: { 1: { "1": 8 }, 2: { "3": 8 } } },
    { name: "BIBET TOMIRIS", hours: 8, days: { 1: { "2": 4, "3": 4 } } }, // зміни дня — окремо
    { name: "BATSAN SERHII", hours: 12, days: { 1: { "1": 8 }, 2: { "1": 4 } } }, // «- WÓZ» зрізано
  ]);
});

// ── формат E: розрахунковий файл Eurocash (EUROSUPPORT LIPIEC 2026) ─────────
// Лівий блок по працівнику + (правіше в тих самих рядках і нижче) сирі денні
// дані без імені в колонці «Nazwisko i Imię» — вони не мають потрапити в рядки.

const EUROCASH = [
  ["NUMER ZRFM", "NR OSOBOWY", "Nazwisko i Imię", "Zatrud.", "Suma z Wyk. [h]", "Suma z Wyk. [h] AMBIENT", "Suma z Nocne [h]",
    "Produktywność kartonowa", "Produktywność punktowa", "Stawka H NEW AGENCJA", "TOTAL DLA AGENCJI",
    "POTRĄCENIA ZA POMYŁKOWOŚĆ - SUMA", "KOREKTA", "KOŃCOWE ROZLICZENIE", null, "Dzień", "Pracownik (Kod)"],
  ["5855", "565469", "THABO NKOMO CRAIG", "2025-06-26", "159.5", "159.5", "44",
    "154.68", "162.54544200626958", "50.83097882465875", "8330.62", "510", null, "7820.62", null, "2026-07-01", "565573"],
  ["5903", "565573", "ZHAKATA BYRON TINAYEISHE", "2025-09-16", "143", "143", "29",
    "150.69", "158.61837062937073", "50.83097882465875", "7415.86", "130", null, "7285.86", null, "2026-07-01", "565469"],
  // сирий денний рядок правого блоку — без імені, пропускається
  [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, "2026-07-08", "565469"],
];

test("eurocash: години + extras (нічні/продуктивність/ставка/потроненя), правий блок ігнорується", () => {
  const f = parseFactoryHoursWorkbook(wbBuf(EUROCASH));
  assert.equal(f.format, "eurocash");
  assert.equal(f.monthDetected, null); // місяць — з імені файла (EUROSUPPORT LIPIEC 2026)
  assert.deepEqual(f.rows, [
    { name: "THABO NKOMO CRAIG", hours: 159.5, extras: {
      nocneH: 44, produktywnosc: 162.54544200626958, stawkaAgencji: 50.83097882465875,
      potracenia: 510, koncowe: 7820.62, nrOsobowy: "565469" } },
    { name: "ZHAKATA BYRON TINAYEISHE", hours: 143, extras: {
      nocneH: 29, produktywnosc: 158.61837062937073, stawkaAgencji: 50.83097882465875,
      potracenia: 130, koncowe: 7285.86, nrOsobowy: "565573" } },
  ]);
});

test("monthFromPolishFilename: польський місяць + рік з імені файла", () => {
  assert.equal(monthFromPolishFilename("EWIDENCJA KLINEX 2026 LIPIEC.xlsx"), "2026-07");
  assert.equal(monthFromPolishFilename("ewidencja ES styczeń 2027.xlsx"), "2027-01");
  assert.equal(monthFromPolishFilename("PAŹDZIERNIK 2026.xlsx"), "2026-10");
  assert.equal(monthFromPolishFilename("EWIDENCJA KLINEX LIPIEC.xlsx"), null); // без року
  assert.equal(monthFromPolishFilename("raport 2026-07.xlsx"), null);          // без назви місяця
});

// ── формат C: вставлений текст ───────────────────────────────────────────────

test("текст: десяткові, HH:MM, нумерація, таби і тире", () => {
  const rows = parseFactoryHoursText([
    "Abovtan Erick 216.5",
    "2. Admire Kufakunesu\t104",
    "Artemiev Oleksandr — 152:30",
    "Jebet Sandra - 140,25",
    "",
    "тільки імʼя без годин",
  ].join("\n"));
  assert.deepEqual(rows, [
    { name: "Abovtan Erick", hours: 216.5 },
    { name: "Admire Kufakunesu", hours: 104 },
    { name: "Artemiev Oleksandr", hours: 152.5 },
    { name: "Jebet Sandra", hours: 140.25 },
  ]);
});
