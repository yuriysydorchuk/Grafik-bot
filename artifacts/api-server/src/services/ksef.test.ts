import { test } from "node:test";
import assert from "node:assert/strict";
import { revenueMonthFor, mapBuyerToClient, segmentForBuyer } from "./ksef.ts";

test("revenueMonthFor: фактура за попередній місяць (акруал M−1)", () => {
  assert.equal(revenueMonthFor("2026-06-08"), "2026-05");
  assert.equal(revenueMonthFor("2026-01-05"), "2025-12"); // межа року
  assert.equal(revenueMonthFor("2026-12-31"), "2026-11");
});

test("mapBuyerToClient: покупці KSeF → наші клієнти з P&L", () => {
  assert.equal(mapBuyerToClient("SERWIS PLUS SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ"), "Dezynfekcja");
  assert.equal(mapBuyerToClient('"KUŹNIA MATRYCOWA" SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ'), "Kuźnia");
  assert.equal(mapBuyerToClient('"EUROCASH" SPÓŁKA AKCYJNA'), "Eurocash");
  assert.equal(mapBuyerToClient("TOP 2 FABRYKA CHUSTECZEK SPÓŁKA Z O.O."), "TOP-2");
  assert.equal(mapBuyerToClient("AGRAM SPÓŁKA AKCYJNA"), "Agram");
  assert.equal(mapBuyerToClient("INPOST SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ"), "InPost");
  assert.equal(mapBuyerToClient("SUSHI&FOOD FACTOR SP. Z O.O."), "Sushi&Food Factory");
  assert.equal(mapBuyerToClient("LST-POLSKA SP. Z O.O."), "LST");
});

test("mapBuyerToClient: невідомий покупець — чистка правових форм", () => {
  const label = mapBuyerToClient("NIEZNANA FIRMA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ");
  assert.equal(label, "NIEZNANA FIRMA");
});

test("segmentForBuyer: wspólnoty і Galej — прибирання, решта — основний", () => {
  assert.equal(segmentForBuyer("WSPÓLNOTA MIESZKANIOWA ZYGMUNTA AUGUSTA 31"), "cleaning");
  assert.equal(segmentForBuyer("OFFICE CENTER WSPOLNOTA LOKALOWA"), "cleaning");
  assert.equal(segmentForBuyer("GALEY KRZYSZTOF GALEJ"), "cleaning");
  assert.equal(segmentForBuyer("AGRAM SPÓŁKA AKCYJNA"), "main");
  assert.equal(segmentForBuyer(null), "main");
});
