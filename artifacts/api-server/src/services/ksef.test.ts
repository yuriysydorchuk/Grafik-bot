import { test } from "node:test";
import assert from "node:assert/strict";
import { revenueMonthFor, mapBuyerToClient, segmentForBuyer, parseKsefXmlMeta } from "./ksef.ts";

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

test("parseKsefXmlMeta: термін оплати і форма з XML FA", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2023/06/29/12648/">
  <Fa><P_1>2026-08-03</P_1><P_2>FV 12/08/2026</P_2>
    <Platnosc>
      <FormaPlatnosci>6</FormaPlatnosci>
      <TerminPlatnosci><Termin>2026-08-17</Termin></TerminPlatnosci>
    </Platnosc>
  </Fa>
</Faktura>`;
  assert.deepEqual(parseKsefXmlMeta(xml), { dueDate: "2026-08-17", paymentMethod: "przelew" });
});

test("parseKsefXmlMeta: кілька термінів → найпізніший; готівка; namespace-префікси", () => {
  const xml = `<ns:Faktura xmlns:ns="urn:x"><ns:Fa><ns:Platnosc>
    <ns:FormaPlatnosci>1</ns:FormaPlatnosci>
    <ns:TerminPlatnosci><ns:Termin>2026-09-01</ns:Termin></ns:TerminPlatnosci>
    <ns:TerminPlatnosci><ns:Termin>2026-08-15</ns:Termin></ns:TerminPlatnosci>
  </ns:Platnosc></ns:Fa></ns:Faktura>`;
  assert.deepEqual(parseKsefXmlMeta(xml), { dueDate: "2026-09-01", paymentMethod: "gotowka" });
});

test("parseKsefXmlMeta: без блоку оплати — нулі; невідома форма — null", () => {
  assert.deepEqual(parseKsefXmlMeta("<Faktura><Fa><P_2>X</P_2></Fa></Faktura>"), { dueDate: null, paymentMethod: null });
  assert.deepEqual(
    parseKsefXmlMeta("<Fa><Platnosc><FormaPlatnosci>2</FormaPlatnosci></Platnosc></Fa>"),
    { dueDate: null, paymentMethod: null },
  );
});
