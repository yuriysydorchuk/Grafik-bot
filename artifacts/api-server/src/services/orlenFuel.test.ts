// Тести парсера флотових фактур Orlen. Фікстура — реальні текстові елементи
// (з координатами) фактури №0491754068 від 17.07.2026, знято extractPdfItems-ом;
// очікувані значення звірені з pdftotext-видачею тієї ж фактури.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOrlenNum, parseOrlenInvoice, type PdfItem } from "./orlenFuel";

const r2 = (n: number) => Math.round(n * 100) / 100;

test("parseOrlenNum: формати чисел Orlen", () => {
  assert.equal(parseOrlenNum("217.68"), 217.68);          // wykaz: десяткова крапка
  assert.equal(parseOrlenNum("18 836,27"), 18836.27);     // шапка: пробіл-тисячні
  assert.equal(parseOrlenNum("17.851,00"), 17851);        // шапка: крапка-тисячні
  assert.equal(parseOrlenNum("21.770,24"), 21770.24);
  assert.equal(parseOrlenNum("98,87-"), -98.87);          // мінус у хвості
  assert.equal(parseOrlenNum("-12.50"), -12.5);
  assert.equal(parseOrlenNum("23"), 23);
  assert.equal(parseOrlenNum("ND"), null);
  assert.equal(parseOrlenNum("S-51080-0"), null);
});

test("фікстура №0491754068: шапка, підсумки, всі транзакції", () => {
  const pages = JSON.parse(
    readFileSync(new URL("./fixtures/orlen-0491754068.items.json", import.meta.url), "utf8"),
  ) as PdfItem[][];
  const inv = parseOrlenInvoice(pages);

  assert.equal(inv.number, "0491754068");
  assert.equal(inv.invoiceDate, "2026-07-17");
  assert.equal(inv.saleDate, "2026-07-15");
  assert.equal(inv.ksefNumber, "7740001454-20260717-73956A800124-41");
  assert.equal(inv.net, 16734.45);
  assert.equal(inv.vat, 3848.92);
  assert.equal(inv.gross, 20583.37);
  assert.deepEqual(inv.warnings, []);

  // рядки wykaz-у нумеровані наскрізно — жоден не загубився
  assert.equal(inv.transactions.length, 68);
  const lps = inv.transactions.map(t => t.lp).sort((a, b) => a - b);
  assert.deepEqual(lps, Array.from({ length: 68 }, (_, i) => i + 1));

  const fuel = inv.transactions.filter(t => t.isFuel);
  const goods = inv.transactions.filter(t => !t.isFuel);
  assert.equal(fuel.length, 53);
  assert.equal(goods.length, 15);
  assert.equal(r2(fuel.reduce((a, t) => a + t.qty, 0)), 2910.25);       // літри
  assert.equal(r2(fuel.reduce((a, t) => a + t.gross, 0)), 20287.92);
  assert.equal(r2(goods.reduce((a, t) => a + t.gross, 0)), 411.86);

  // паливний рядок: станція, ціна після рабату, без номера авто
  assert.deepEqual(inv.transactions[0], {
    lp: 1, cardNumber: "78971517791900164", regNumber: null, product: "EFECTA 95",
    isFuel: true, stationCity: "Lublin", stationNo: "7684",
    txDate: "2026-07-07", txTime: "17:23:27",
    qty: 12.08, unitPrice: 6.82, priceAfterRebate: 6.79, vatRate: 23,
    net: 66.68, vatAmount: 15.34, gross: 82.02,
  });

  // товарний рядок: картка злита з датою в одному елементі, номер авто є
  assert.deepEqual(goods[0], {
    lp: 54, cardNumber: "78971517791900271", regNumber: "KNS7748C",
    product: "BOSMA BULB 12V 55W H1 P14,5s", isFuel: false,
    stationCity: null, stationNo: null,
    txDate: "2026-07-09", txTime: "05:39:15",
    qty: 2, unitPrice: 12.49, priceAfterRebate: null, vatRate: 23,
    net: 20.31, vatAmount: 4.67, gross: 24.98,
  });
});

test("рядок з VAT «ND» (kaucja): порожні колонки VAT/нетто", () => {
  // мінімальна пара сторінок: шапка + один товарний рядок (геометрія з реальної фактури)
  const header: PdfItem[] = [
    { s: "Rozliczenie Nr 0400000001", x: 300, y: 700 },
    { s: "Płock, dnia: 04.02.2026", x: 400, y: 720 },
    { s: "Data sprzedaży: 31.01.2026", x: 100, y: 500 },
    { s: "Ogółem 0,50 0,00 0,50", x: 200, y: 100 },
  ];
  const row: PdfItem[] = [
    { s: "Lp", x: 22.6, y: -107 }, { s: "Pozycja faktury", x: 49.4, y: -107 },
    { s: "Nazwa produktu", x: 144.2, y: -107 }, { s: "Numer karty", x: 301.5, y: -107 },
    { s: "Data", x: 354.6, y: -107 }, { s: "Ilość sztuk", x: 382.2, y: -107 },
    { s: "VAT", x: 483.9, y: -107 }, { s: "Wartość brutto", x: 574.5, y: -107 },
    { s: "350", x: 21.8, y: -115.4 }, { s: "1120", x: 63.8, y: -115.4 },
    { s: "KAUCJA BUTELKA PET", x: 133.1, y: -115.4 }, { s: "NBR11324", x: 246.1, y: -115.4 },
    { s: "78971517791900016 2026-01-16", x: 292.8, y: -115.4 },
    { s: "19:20:39", x: 350.1, y: -122.3 },
    { s: "1", x: 394.3, y: -115.4 }, { s: "0.50", x: 434, y: -115.4 },
    { s: "ND", x: 485.9, y: -115.4 }, { s: "0.50", x: 589, y: -115.4 },
  ];
  const inv = parseOrlenInvoice([header, row]);
  assert.equal(inv.transactions.length, 1);
  assert.deepEqual(inv.transactions[0], {
    lp: 350, cardNumber: "78971517791900016", regNumber: "NBR11324",
    product: "KAUCJA BUTELKA PET", isFuel: false,
    stationCity: null, stationNo: null,
    txDate: "2026-01-16", txTime: "19:20:39",
    qty: 1, unitPrice: 0.5, priceAfterRebate: null, vatRate: null,
    net: 0.5, vatAmount: 0, gross: 0.5,
  });
});
