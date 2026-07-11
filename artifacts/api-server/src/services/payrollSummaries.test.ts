import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkbookTitle, factoryCost, cleanName, nameTokens, mergeWorkers, fuzzyScore,
  parseFactoryTab, parseLodzTab, EMPLOYER_ZUS_RATE, type WorkerRow,
} from "./payrollSummaries.ts";

const near = (actual: number | null, expected: number, msg?: string) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 0.01, msg ?? `${actual} ≉ ${expected}`);

// ── назви файлів сводних ───────────────────────────────────────────────────────
test("parseWorkbookTitle: місячні сводні Любліна/Познані", () => {
  assert.deepEqual(parseWorkbookTitle("05.2026 Люблін Сводна"), { periodMonth: "2026-05", region: "Люблін", firm: null });
  assert.deepEqual(parseWorkbookTitle("06.2026 Познань сводна"), { periodMonth: "2026-06", region: "Познань", firm: null });
});

test("parseWorkbookTitle: лодзькі файли по фірмах (у т.ч. .xlsx і «Сводная»)", () => {
  assert.deepEqual(parseWorkbookTitle("Фабрик 06.2026 KLINEX"), { periodMonth: "2026-06", region: "Лодзь", firm: "Klinex" });
  assert.deepEqual(parseWorkbookTitle("Фабрик 05.2026 EUROSUPP.OUTS..xlsx"), { periodMonth: "2026-05", region: "Лодзь", firm: "ESO" });
  assert.deepEqual(parseWorkbookTitle("Сводная Фабрик 01.2026 EUROSUPPORT"), { periodMonth: "2026-01", region: "Лодзь", firm: "ES" });
});

test("parseWorkbookTitle: сторонні файли не реєструються", () => {
  assert.equal(parseWorkbookTitle("Ewidencja godzin 2026.xlsx"), null);
  assert.equal(parseWorkbookTitle("WYPŁATA GOTÓWKĄ KLINEX"), null);
});

// ── формула собівартості ──────────────────────────────────────────────────────
const baseRow = {
  doZaplaty: null, mainBrutto: null, mainNetto: null, mainTaxedBrutto: null,
  blockBrutto: null, blockNetto: null, blockTaxedBrutto: null, gotowka: null,
  zaliczki: null, zaliczkaBd: null, hostel: null,
};

test("factoryCost: блок є — податки від задекларованого, аванси/хостел додаються", () => {
  const c = factoryCost({
    ...baseRow, doZaplaty: 90514.43, zaliczki: 3107.54, hostel: 2300,
    blockBrutto: 37000, blockNetto: 31812.48, blockTaxedBrutto: 37000, gotowka: 24008.5,
  });
  near(c.netto, 90514.43);
  near(c.zaliczki, 3107.54);
  near(c.hostel, 2300);
  near(c.workerTax, 37000 - 31812.48);
  near(c.employerZus, 37000 * EMPLOYER_ZUS_RATE);
  near(c.total, c.netto + c.zaliczki + c.hostel + c.workerTax + c.employerZus);
});

test("factoryCost: без блоку — головна таблиця і є задеклароване", () => {
  const c = factoryCost({ ...baseRow, doZaplaty: 96112.88, mainBrutto: 114091.9, mainNetto: 96112.88, mainTaxedBrutto: 91217 });
  near(c.workerTax, 114091.9 - 96112.88);
  near(c.employerZus, 91217 * EMPLOYER_ZUS_RATE);
});

test("factoryCost: нема даних про податки — тільки netto", () => {
  const c = factoryCost({ ...baseRow, doZaplaty: 4783.92 });
  near(c.total, 4783.92);
  assert.equal(c.workerTax, 0);
  assert.equal(c.employerZus, 0);
});

// ── чистка імен і злиття рядків ────────────────────────────────────────────────
test("cleanName: анотації, ролі, зірочки", () => {
  assert.equal(cleanName("PAVLENKO IRYNA *( 2000 zl na kartu)"), "PAVLENKO IRYNA");
  assert.equal(cleanName("KALCHUK VITALII - wózkowy"), "KALCHUK VITALII");
  assert.equal(cleanName("MAMMADLI KHAYAL Lider"), "MAMMADLI KHAYAL");
  assert.equal(cleanName("MAMMADLI KHAYAL Pracownik"), "MAMMADLI KHAYAL");
});

test("mergeWorkers: блок зливається по точному ключу і по ≥2 токенах (одруки)", () => {
  const main: WorkerRow[] = [
    { name: "CHINGORA TATENDA DENIS", hoursActual: 161, hoursDeclared: null, brutto: 5055.4, netto: 4081.35, gotowka: null, fullNetto: 4081.35, konto: 4081.35 },
    { name: "NYONI NGQABUTHO", hoursActual: 246, hoursDeclared: null, brutto: 7724.4, netto: 7724.4, gotowka: null, fullNetto: 7724.4, konto: 7724.4 },
  ];
  const merged = mergeWorkers(main, [
    // скорочене імʼя в блоці — має злитись з CHINGORA TATENDA DENIS
    { name: "CHINGORA DENIS", hoursActual: 161, hoursDeclared: 60, brutto: 1884, netto: 1521, gotowka: 2560.35 },
  ]);
  assert.equal(merged.length, 2);
  const ch = merged.find(w => w.name.includes("CHINGORA"))!;
  assert.equal(ch.hoursDeclared, 60);
  assert.equal(ch.konto, 1521);       // на рахунок іде задеклароване
  assert.equal(ch.fullNetto, 4081.35); // повна виплата лишається з головної таблиці
  const ny = merged.find(w => w.name.includes("NYONI"))!;
  assert.equal(ny.konto, 7724.4); // без блоку — все офіційно
});

// ── м'який матчинг банк ↔ сводні ──────────────────────────────────────────────
test("fuzzyScore: одрук в одному токені (BOBYK STANISLAW/V)", () => {
  assert.ok(fuzzyScore(nameTokens("BOBYK STANISLAW"), ["BOBYK", "STANISLAV", "JOZEFA", "MACKIEWICZA"]) >= 2);
});

test("fuzzyScore: склеєні/розірвані токени (INYANG-UDO ↔ INYANGUDO)", () => {
  assert.ok(fuzzyScore(nameTokens("LINUS INYANGUDO"), ["INYANG", "UDO", "LINUS", "NNAH"]) >= 2);
});

test("fuzzyScore: чужа людина не матчиться", () => {
  assert.ok(fuzzyScore(nameTokens("KOWALSKI JAN"), ["NOWAK", "PIOTR", "LUBLIN"]) < 2);
});

// ── парсер вкладок: мінімальні фікстури реальних форматів ─────────────────────
test("parseFactoryTab: люблінський формат (студент + оподаткований + нижній блок)", () => {
  const rows: unknown[][] = [
    ["5.2026", "Ilość godz w powiadomieniu", "Ilość godzin", "Stawka brutto", "Stawka netto", "Zaliczka", "Zaliczka BD", "Hostel", "komornik", "Kara", "Do wypłaty Netto", "Brutto"],
    ["NIE OPODATKOWANE"],
    ["STUDENT ANNA", "STUD", 100, 31.4, 31.4, "", "", "", "", "", 3140, 3140],
    ["TAXED IVAN", "40", 144, 31.4, 25.35, "", "", "", "", "", 2694.4, 4521.6],
    ["Suma Godzin", "", 244],
    [],
    ["", "godz fakt", "godz ksiegowosc", "brutto", "netto", "gotowka suma"],
    ["TAXED IVAN", 144, 80, 2512, 2028, 666.4],
  ];
  const s = parseFactoryTab(rows)!;
  assert.ok(s, "розпарсилось");
  near(s.mainNetto, 3140 + 2694.4);
  near(s.mainBrutto, 3140 + 4521.6);
  near(s.mainTaxedBrutto, 4521.6);
  assert.ok(s.block, "блок знайдено");
  near(s.block!.gotowka, 666.4);
  assert.equal(s.workers.length, 2);
  const ivan = s.workers.find(w => w.name === "TAXED IVAN")!;
  assert.equal(ivan.konto, 2028);
  assert.equal(ivan.gotowka, 666.4);
});

test("parseFactoryTab: познанський формат (фірма в колонці, зсунуті імена)", () => {
  const rows: unknown[][] = [
    ["Nr Osobowy", "Firma", "5.2026", "ilość godz w powiadomieniu", "Ilość godzin", "Premia", "Stawka brutto", "Stawka netto", "x", "x", "x", "x", "x", "x", "x", "x", "x", "x", "Do wypłaty Netto", "Godzin Faktycznie", "BRUTTO"],
    [4718, "ES Outsourcing", "CHIPAK MAKSYM", "STUD", 199.25, 400, 33.5, 33.5, "", "", "", "", "", "", "", "", "", "", 6674.88, 0, 6674.88],
    ["", "", "Suma Godzin", "", 199.25],
  ];
  const s = parseFactoryTab(rows)!;
  assert.ok(s);
  assert.equal(s.firmGuess, "ESO");
  assert.equal(s.workers[0]!.name, "CHIPAK MAKSYM");
  near(s.mainNetto, 6674.88);
});

test("parseLodzTab: повний формат з Ew. (Klinex) — задеклароване і готівка", () => {
  const rows: unknown[][] = [
    [],
    ["Nazwisko/Imię", "Status", "Godzin", "Stawka/brutto", "Stawka/netto", "Premia", "Hostel", "Potrącenia", "Zaliczki", "Migawka", "RAZEM", "NA KONTO \"h\"", "Ew.", "h.", "zł.", "Dopłata ES"],
    ["LIVAK YULIIA", "Nie stud.", 240, 31.4, 25.35, 400, "", "", "", 50, 6534, 257.75, 168, 72, 1.5, 108],
  ];
  const s = parseLodzTab(rows)!;
  assert.ok(s);
  const w = s.workers[0]!;
  near(w.netto, 168 * 25.35);          // задекл. netto
  near(w.brutto, 168 * 31.4);          // база ZUS
  near(w.gotowka!, 6534 - 168 * 25.35 + 108); // na rękę = RAZEM − Ew×netto + dopłata
  near(w.fullNetto!, 6534);
});

test("parseLodzTab: обмежений формат без Ew. (ESO/ESG) — все вважається офіційним", () => {
  const rows: unknown[][] = [
    ["Nazwisko/Imię", "Status", "Godzin", "Stawka/brutto", "Stawka/netto", "Hostel", "Premia", "Dojazd", "Dokumenty", "Zaliczki", "Odzież", "Migawki", "Potrącenia", "RAZEM", "NA KONTO \"h\""],
    ["ZHURAVSKYI OLEG", "Nie Stud.", 241, 31.4, 25.35, "", 400, "", "", "", "", 50, "", 6559.35, 258.75],
  ];
  const s = parseLodzTab(rows)!;
  assert.ok(s);
  const w = s.workers[0]!;
  assert.equal(w.konto, 6559.35);           // поки WYPŁATA GOTÓWKĄ не скаже інакше
  assert.equal(w.gotowka, null);
  near(w.brutto!, 6559.35 * (31.4 / 25.35)); // оцінка brutto за особистою ставкою
});
