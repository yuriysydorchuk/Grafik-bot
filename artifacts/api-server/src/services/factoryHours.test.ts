import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { hhmmToHours, parseHoursValue, parseFactoryHoursWorkbook, parseFactoryHoursText, dedupeDoubledName } from "./factoryHours.ts";

const wbBuf = (aoa: unknown[][], sheetName = "Sheet"): Buffer => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
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
