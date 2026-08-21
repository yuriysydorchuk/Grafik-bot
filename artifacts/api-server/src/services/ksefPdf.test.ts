import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFaInvoice, ksefVerificationUrl, buildKsefInvoicePdf } from "./ksefPdf.ts";

// Фікстура за мотивами реальної візуалізації PGE (FA(2)/FA(3)-поля)
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2023/06/29/12648/">
  <Podmiot1>
    <PrefiksPodatnika>PL</PrefiksPodatnika>
    <DaneIdentyfikacyjne><NIP>8130268082</NIP><Nazwa>PGE Obrót S.A.</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>UL. 8 MARCA 6</AdresL1><AdresL2>35-959 RZESZÓW</AdresL2></Adres>
  </Podmiot1>
  <Podmiot2>
    <DaneIdentyfikacyjne><NIP>9462698100</NIP><Nazwa>EUROSUPPORT GROUP SP.Z O.O.</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>KRAKOWSKIE PRZEDMIEŚCIE 55</AdresL1><AdresL2>20-076 LUBLIN</AdresL2></Adres>
    <NrKlienta>10855234</NrKlienta>
  </Podmiot2>
  <Fa>
    <KodWaluty>PLN</KodWaluty>
    <P_1>2026-07-23</P_1>
    <P_1M>RZESZÓW</P_1M>
    <P_2>03/2607/10855234/00000002</P_2>
    <OkresFa><P_6_Od>2026-05-01</P_6_Od><P_6_Do>2026-05-31</P_6_Do></OkresFa>
    <P_13_1>66.23</P_13_1><P_14_1>15.24</P_14_1>
    <P_15>81.47</P_15>
    <RodzajFaktury>VAT</RodzajFaktury>
    <DodatkowyOpis><Klucz>Zużycie i akcyza</Klucz><Wartosc>akcyza od 76 kWh energii 0,38 zł</Wartosc></DodatkowyOpis>
    <FaWiersz>
      <NrWierszaFa>1</NrWierszaFa>
      <P_7>Energia całodobowa; Grupa taryfowa G11</P_7>
      <P_8A>kWh</P_8A><P_8B>31</P_8B><P_9A>0.5032</P_9A><P_11>15.60</P_11><P_12>23</P_12>
    </FaWiersz>
    <FaWiersz>
      <NrWierszaFa>2</NrWierszaFa>
      <P_7>Opłata sieciowa stała (ukł. 3-faz)</P_7>
      <P_8A>mc</P_8A><P_8B>1</P_8B><P_9A>9.98</P_9A><P_11>9.98</P_11><P_11A>12.28</P_11A><P_12>23</P_12>
    </FaWiersz>
    <Rozliczenie>
      <Odliczenia><Powod>Rozliczenie depozytu prosumenckiego</Powod><Kwota>19.19</Kwota></Odliczenia>
      <DoZaplaty>62.28</DoZaplaty>
    </Rozliczenie>
    <Platnosc>
      <TerminPlatnosci><Termin>2026-08-06</Termin></TerminPlatnosci>
      <FormaPlatnosci>6</FormaPlatnosci>
      <RachunekBankowy><NrRB>35124069609563031085523459</NrRB><NazwaBanku>Bank Polska Kasa Opieki SA</NazwaBanku></RachunekBankowy>
    </Platnosc>
  </Fa>
  <Stopka>
    <Informacje><StopkaFaktury>PGE OBRÓT S.A. informuje o zmianie rachunku.</StopkaFaktury></Informacje>
    <Rejestry><PelnaNazwa>PGE OBRÓT SPÓŁKA AKCYJNA</PelnaNazwa><KRS>0000030499</KRS><REGON>690254559</REGON></Rejestry>
  </Stopka>
</Faktura>`;

test("parseFaInvoice: сторони, szczegóły, позиції з дорахунком VAT", () => {
  const inv = parseFaInvoice(XML);
  assert.equal(inv.invoiceNumber, "03/2607/10855234/00000002");
  assert.equal(inv.issueDate, "2026-07-23");
  assert.equal(inv.place, "RZESZÓW");
  assert.equal(inv.kindLabel, "Faktura podstawowa");
  assert.equal(inv.deliveryPeriod, "od 01.05.2026 do 31.05.2026");
  assert.equal(inv.seller.nip, "8130268082");
  assert.equal(inv.seller.prefix, "PL");
  assert.deepEqual(inv.seller.address, ["UL. 8 MARCA 6", "35-959 RZESZÓW", "Polska"]);
  assert.equal(inv.buyer.name, "EUROSUPPORT GROUP SP.Z O.O.");
  assert.equal(inv.buyer.clientNo, "10855234");
  assert.equal(inv.lines.length, 2);
  // рядок без P_11A: vat = netto×23%, brutto = netto+vat
  assert.equal(inv.lines[0]!.vat, 3.59);
  assert.equal(inv.lines[0]!.gross, 19.19);
  // рядок з P_11A: brutto з XML, vat = різниця
  assert.equal(inv.lines[1]!.gross, 12.28);
  assert.equal(inv.lines[1]!.vat, 2.3);
  assert.equal(inv.total, 81.47);
  assert.deepEqual(inv.vatSummary, [{ rate: "23% lub 22%", net: 66.23, vat: 15.24, gross: 81.47 }]);
  assert.equal(inv.toPay, 62.28);
  assert.deepEqual(inv.deductions, [{ reason: "Rozliczenie depozytu prosumenckiego", amount: 19.19 }]);
  assert.equal(inv.paymentForm, "Przelew");
  assert.deepEqual(inv.paymentTerms, ["06.08.2026"]);
  assert.equal(inv.bankName, "Bank Polska Kasa Opieki SA");
  assert.equal(inv.footer, "PGE OBRÓT S.A. informuje o zmianie rachunku.");
  assert.equal(inv.registries[0]!.krs, "0000030499");
});

test("ksefVerificationUrl: NIP / дата dd-mm-yyyy / SHA-256 base64url", () => {
  const url = ksefVerificationUrl(XML, "8130268082", "2026-07-23");
  assert.match(url, /^https:\/\/qr\.ksef\.mf\.gov\.pl\/invoice\/8130268082\/23-07-2026\/[A-Za-z0-9_-]{43}$/);
});

test("buildKsefInvoicePdf: рендериться валідний PDF з польськими знаками", async () => {
  const pdf = await buildKsefInvoicePdf(XML, { ksefNumber: "8130268082-20260723-3E286CC00004-11", invoicingDate: "2026-07-23" });
  assert.ok(pdf.length > 10_000, "PDF не порожній");
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString("latin1"), "%PDF-");
});
