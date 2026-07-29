import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeAmount, normDate, normNip, entitiesToDraft, detectOurCompany } from "./docai.ts";

// ── sanitizeAmount ────────────────────────────────────────────────────────────

test("sanitizeAmount: польські і міжнародні формати", () => {
  assert.equal(sanitizeAmount("12 345,67"), 12345.67);
  assert.equal(sanitizeAmount("12.345,67"), 12345.67);
  assert.equal(sanitizeAmount("12,345.67"), 12345.67);
  assert.equal(sanitizeAmount("1234.5"), 1234.5);
  assert.equal(sanitizeAmount("857 489,70 PLN"), 857489.7);
  assert.equal(sanitizeAmount("zł 0"), null);
  assert.equal(sanitizeAmount(null), null);
});

test("normDate: dd.mm.yyyy, dd/mm/yyyy, ISO", () => {
  assert.equal(normDate("31.07.2026"), "2026-07-31");
  assert.equal(normDate("5.7.2026"), "2026-07-05");
  assert.equal(normDate("2026-07-31"), "2026-07-31");
  assert.equal(normDate("31/07/2026"), "2026-07-31");
  assert.equal(normDate("липень"), null);
});

// ── entitiesToDraft ───────────────────────────────────────────────────────────

const ENTITIES = [
  { type: "supplier_name", mentionText: "HOUSE POLAND SP. Z O.O.", confidence: 0.9 },
  { type: "supplier_tax_id", mentionText: "PL 527-27-79-057", confidence: 0.8 },
  { type: "invoice_id", mentionText: "2026/07/HOUSE/000031", confidence: 0.95 },
  { type: "invoice_date", mentionText: "23.07.2026", normalizedValue: { text: "2026-07-23" }, confidence: 0.9 },
  { type: "total_amount", mentionText: "23 370,00", confidence: 0.9 },
  { type: "net_amount", mentionText: "19 000,00", confidence: 0.85 },
  { type: "receiver", mentionText: "EURO SUPPORT OUTSOURCING", confidence: 0.7, properties: [
    { type: "tax_id", mentionText: "7123441567", confidence: 0.75 },
  ] },
];

test("entitiesToDraft: повна чернетка з сутностей інвойс-процесора", () => {
  const d = entitiesToDraft(ENTITIES as any);
  assert.equal(d.seller, "HOUSE POLAND SP. Z O.O.");
  assert.equal(d.sellerNip, "5272779057");
  assert.equal(d.customerNip, "7123441567");
  assert.equal(d.number, "2026/07/HOUSE/000031");
  assert.equal(d.issueDate, "2026-07-23");
  assert.equal(d.gross, 23370);
  assert.equal(d.net, 19000);
});

test("entitiesToDraft: фолбеки з повного тексту (номер і дата)", () => {
  const d = entitiesToDraft([], "FAKTURA VAT nr FV 160/2026\nData wystawienia: 23.07.2026\nRazem brutto: 10 455,00");
  assert.equal(d.number, "FV 160/2026");
  assert.equal(d.issueDate, "2026-07-23");
});

// ── detectOurCompany ──────────────────────────────────────────────────────────

const COMPANIES = [
  { id: 1, nip: "7123438022" }, // Klinex
  { id: 2, nip: "9462698100" }, // ES
  { id: 3, nip: "7123441567" }, // ESO
];

test("detectOurCompany: NIP покупця з сутностей — пріоритет", () => {
  const d = entitiesToDraft(ENTITIES as any);
  assert.equal(detectOurCompany(d, "", COMPANIES), 3);
});

test("detectOurCompany: фолбек — наш NIP у тексті (не постачальника)", () => {
  const d = { seller: "X", sellerNip: "5272779057", customerNip: null, number: null, issueDate: null, gross: null, net: null };
  assert.equal(detectOurCompany(d, "Nabywca: Klinex Sp. z o.o. NIP: 712-343-80-22", COMPANIES), 1);
  // два наші NIP-и в тексті = неоднозначно
  assert.equal(detectOurCompany(d, "NIP 7123438022 oraz NIP 9462698100", COMPANIES), null);
});
