import { test } from "node:test";
import assert from "node:assert/strict";
import iconv from "iconv-lite";
import { decodeStatement, parseMt940, matchCompanyName } from "./mt940.ts";

// ── decodeStatement ───────────────────────────────────────────────────────────

test("decodeStatement: valid UTF-8 passes through unchanged", () => {
  const s = "PRZELEW ZAŻÓŁĆ GĘŚLĄ JAŹŃ";
  assert.equal(decodeStatement(Buffer.from(s, "utf8")), s);
});

test("decodeStatement: cp1250 bytes are decoded back to Polish", () => {
  const s = "WYNAGRODZENIE ZAŻÓŁĆ GĘŚLĄ";
  assert.equal(decodeStatement(iconv.encode(s, "win1250")), s);
});

test("decodeStatement: cp852 (DOS) bytes are decoded back to Polish", () => {
  const s = "OPŁATA ZAŻÓŁĆ GĘŚLĄ JAŹŃ ŚĆŻŹ";
  assert.equal(decodeStatement(iconv.encode(s, "cp852")), s);
});

// ── parseMt940 ────────────────────────────────────────────────────────────────

const FIXTURE = [
  ":20:ST060126CYC/1",
  ":25:PL27114020040000300201355387",
  ":28C:6/2026",
  ":60F:C260601PLN15000,00",
  ":61:2606020602D450,00N152//REF123",
  ":86:020^00PRZELEW KRAJOWY^20FAKTURA 12/2026",
  "^21 ZA USLUGI^32JAN KOWALSKI",
  "^33 FIRMA^38PL61109010140000071219812874",
  ":61:2606030603C2500,50N051//REF124",
  ":86:051^00PRZELEW PRZYCHODZACY^20WYNAGRODZENIE UMOWA^32FABRYKA SP Z O O",
  ":61:2606040604C100,00N195//REF125",
  ":86:/VAT/23,00/IDC/1234567890/TXT/Przelew podzielony MPP",
  ":62F:C260630PLN17150,50",
  "",
  ":20:ST060126CYC/2",
  ":25:PL75000000000000000000008415",
  ":28C:7/2026",
  ":60F:D260601PLN1000,00",
  ":61:260615D250,00N152//REF200",
  ":86:020^00SPLATA KREDYTU^32BANK",
].join("\r\n");

test("parseMt940: header, balances and transaction fields of a structured statement", () => {
  const [st] = parseMt940(FIXTURE);
  assert.equal(st!.account, "PL27114020040000300201355387");
  assert.equal(st!.statementNo, "6/2026");
  assert.equal(st!.openingDate, "2026-06-01");
  assert.equal(st!.openingBalance, 15000);
  assert.equal(st!.closingDate, "2026-06-30");
  assert.equal(st!.closingBalance, 17150.5);
  assert.equal(st!.closingDerived, undefined);
  assert.equal(st!.txns.length, 3);

  const [t1, t2] = st!.txns;
  assert.equal(t1!.valueDate, "2026-06-02");
  assert.equal(t1!.bookingDate, "2026-06-02");
  assert.equal(t1!.direction, "out");
  assert.equal(t1!.amount, 450);
  assert.equal(t1!.txType, "152 020 PRZELEW KRAJOWY");
  assert.equal(t1!.bankRef, "REF123");
  // ^20/^21 join into the title; ^32/^33 (multi-line continuation) into counterparty
  assert.equal(t1!.title, "FAKTURA 12/2026 ZA USLUGI");
  assert.equal(t1!.counterparty, "JAN KOWALSKI FIRMA");
  assert.equal(t1!.counterpartyAccount, "PL61109010140000071219812874");

  assert.equal(t2!.direction, "in");
  assert.equal(t2!.amount, 2500.5);
  assert.equal(t2!.counterparty, "FABRYKA SP Z O O");
});

test("parseMt940: flat /TXT/ (split-payment) :86: puts the purpose into the title", () => {
  const [st] = parseMt940(FIXTURE);
  const mpp = st!.txns[2]!;
  assert.equal(mpp.title, "Przelew podzielony MPP");
  assert.equal(mpp.counterparty, null);
});

test("parseMt940: second statement, negative opening (D), no :62F: → closing derived", () => {
  const sts = parseMt940(FIXTURE);
  assert.equal(sts.length, 2);
  const credit = sts[1]!;
  assert.equal(credit.openingBalance, -1000);
  // one outgoing 250.00 without booking date
  assert.equal(credit.txns.length, 1);
  assert.equal(credit.txns[0]!.bookingDate, null);
  // derived closing = -1000 - 250
  assert.equal(credit.closingBalance, -1250);
  assert.equal(credit.closingDerived, true);
  assert.equal(credit.closingDate, "2026-06-15");
});

test("parseMt940: reversal codes RD/RC flip off the R and keep the base direction", () => {
  const [st] = parseMt940([
    ":20:X", ":25:ACC", ":60F:C260601PLN100,00",
    ":61:260602RD50,00N152//R1",
    ":86:020^00KOREKTA",
    ":62F:C260630PLN50,00",
  ].join("\n"));
  assert.equal(st!.txns[0]!.direction, "out");
});

// ── matchCompanyName ──────────────────────────────────────────────────────────

test("matchCompanyName maps entity folders; Kokos and unknowns → null", () => {
  assert.equal(matchCompanyName("ESO Outsourcing"), "ESO");
  assert.equal(matchCompanyName("esg"), "ES");
  assert.equal(matchCompanyName("Euro Support GROUP"), "ES");
  assert.equal(matchCompanyName("Klinex sp. z o.o."), "Klinex");
  assert.equal(matchCompanyName("KOKOS"), null);
  assert.equal(matchCompanyName("Nieznana Firma"), null);
});
