import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapApiTxn, apiDedupHashes, matchHolderCompany, isInternalTransfer, isKomornik,
  normAccount, type ApiTransaction,
} from "./enableBanking.ts";

const CREDIT: ApiTransaction = {
  entry_reference: "REF123",
  transaction_amount: { currency: "PLN", amount: "90789.07" },
  credit_debit_indicator: "CRDT",
  status: "BOOK",
  booking_date: "2026-07-08",
  value_date: "2026-07-08",
  debtor: { name: "Klinex Sp. z o.o. ul. Wieniawska 8" },
  debtor_account: { iban: "PL61 1090 0000 0000 0000 0000 0001" },
  remittance_information: ["Faktura nr A2/7/2026, Kwota VAT: 16976.82"],
  bank_transaction_code: { description: "PRZELEW OTRZYMANY" },
};

// ── mapApiTxn ─────────────────────────────────────────────────────────────────

test("mapApiTxn: credit → in, counterparty is the debtor, IBAN despaced", () => {
  const m = mapApiTxn(CREDIT)!;
  assert.equal(m.direction, "in");
  assert.equal(m.amount, 90789.07);
  assert.equal(m.valueDate, "2026-07-08");
  assert.equal(m.counterparty, "Klinex Sp. z o.o. ul. Wieniawska 8");
  assert.equal(m.counterpartyAccount, "PL61109000000000000000000001");
  assert.equal(m.title, "Faktura nr A2/7/2026, Kwota VAT: 16976.82");
  assert.equal(m.bankRef, "REF123");
});

test("mapApiTxn: debit → out, counterparty is the creditor", () => {
  const m = mapApiTxn({
    ...CREDIT,
    credit_debit_indicator: "DBIT",
    creditor: { name: "ROMANCHUK LIUDMYLA" },
    debtor: null,
  })!;
  assert.equal(m.direction, "out");
  assert.equal(m.counterparty, "ROMANCHUK LIUDMYLA");
});

test("mapApiTxn: pending and malformed rows are skipped", () => {
  assert.equal(mapApiTxn({ ...CREDIT, status: "PDNG" }), null);
  assert.equal(mapApiTxn({ ...CREDIT, transaction_amount: { amount: "abc" } }), null);
  assert.equal(mapApiTxn({ ...CREDIT, credit_debit_indicator: "XXX" }), null);
  assert.equal(mapApiTxn({ ...CREDIT, value_date: null, booking_date: null }), null);
});

test("mapApiTxn: no status means booked (some banks omit it)", () => {
  assert.ok(mapApiTxn({ ...CREDIT, status: null }));
});

// ── dedup hashes ──────────────────────────────────────────────────────────────

test("apiDedupHashes: entry_reference rows are stable regardless of order", () => {
  const m = mapApiTxn(CREDIT)!;
  const [a] = apiDedupHashes("PL68160014461740104860000001", [m]);
  const [b] = apiDedupHashes("PL68 1600 1446 1740 1048 6000 0001", [m]);
  assert.equal(a, b); // account normalization
});

test("apiDedupHashes: identical rows without reference get distinct ordinals, stable across batches", () => {
  const m = { ...mapApiTxn(CREDIT)!, bankRef: null };
  const twice = apiDedupHashes("PL68", [m, m]);
  assert.notEqual(twice[0], twice[1]);
  const again = apiDedupHashes("PL68", [m, m]);
  assert.deepEqual(twice, again);
});

test("normAccount strips spaces and lowercases nothing", () => {
  assert.equal(normAccount(" pl68 1600-1446 "), "PL6816001446");
});

// ── holder → company ──────────────────────────────────────────────────────────

const COMPANIES = [
  { id: 1, name: "Klinex", legalName: "Klinex" },
  { id: 2, name: "ES", legalName: "Eurosupport Group" },
  { id: 3, name: "ESO", legalName: "Eurosupport Outsourcing" },
];

test("matchHolderCompany: full legal names, most specific wins", () => {
  assert.equal(matchHolderCompany("KLINEX SP. Z O.O.", COMPANIES), 1);
  assert.equal(matchHolderCompany("EUROSUPPORT GROUP SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ", COMPANIES), 2);
  assert.equal(matchHolderCompany("EUROSUPPORT OUTSOURCING SP. Z O.O.", COMPANIES), 3);
  // банківське написання з зайвим пробілом — фолбек без пробілів
  assert.equal(matchHolderCompany("EURO SUPPORT OUTSOURCING", COMPANIES), 3);
  assert.equal(matchHolderCompany("EURO SUPPORT GROUP SP Z O O", COMPANIES), 2);
  // сам «EUROSUPPORT» без другого токена — ні GROUP, ні OUTSOURCING не матчаться повністю
  assert.equal(matchHolderCompany("EUROSUPPORT", COMPANIES), null);
  assert.equal(matchHolderCompany("AGRAM S.A.", COMPANIES), null);
  assert.equal(matchHolderCompany(null, COMPANIES), null);
});

// ── alert classification ──────────────────────────────────────────────────────

const OWN = ["Klinex", "Eurosupport"];
const base = { valueDate: "2026-07-08", bookingDate: null, direction: "in" as const, amount: 100, currency: "PLN", counterparty: null, counterpartyAccount: null, title: null, txType: null, bankRef: null };

test("isInternalTransfer: own-name counterparty and własny/VAT titles", () => {
  assert.ok(isInternalTransfer({ ...base, counterparty: "EUROSUPPORT GROUP SPÓŁKA Z" }, OWN));
  assert.ok(isInternalTransfer({ ...base, title: "Przelew własny UZNANIE" }, OWN));
  assert.ok(isInternalTransfer({ ...base, title: "Pszelew wlasny UZNANIE" }, OWN)); // банківська одруківка, бачена в Erste
  assert.ok(isInternalTransfer({ ...base, title: "PRZEKSIEGOWANIE VAT MPP" }, OWN));
  assert.ok(!isInternalTransfer({ ...base, counterparty: "AGRAM S.A.", title: "Faktura 1/2026" }, OWN));
});

test("isKomornik: komornik/egzekucja in any text field", () => {
  assert.ok(isKomornik({ ...base, counterparty: "Komornik Sądowy przy Sądzie" }));
  assert.ok(isKomornik({ ...base, title: "OPŁATA-REALIZACJA EGZEKUCJI" }));
  assert.ok(isKomornik({ ...base, title: "PROWIZJA ZA PRZYJĘCIE DO REALIZACJI ZAJĘCIA Z.166" }));
  assert.ok(!isKomornik({ ...base, title: "WYNAGRODZENIE 07/2026" }));
});
