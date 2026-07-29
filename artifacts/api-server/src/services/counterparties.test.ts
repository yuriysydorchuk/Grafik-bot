import { test } from "node:test";
import assert from "node:assert/strict";
import { normAlias, normIban, extractForeignNip, matchWorkerByName } from "./counterparties.ts";

// ── normAlias / normIban ──────────────────────────────────────────────────────

test("normAlias: upper, польська діакритика знята, пробіли сквошнуті", () => {
  assert.equal(normAlias("  Aunde  Poland sp. z o.o. "), "AUNDE POLAND SP. Z O.O.");
  assert.equal(normAlias("Komornik Sądowy przy Sądzie"), "KOMORNIK SADOWY PRZY SADZIE");
  assert.equal(normAlias("ZAŻÓŁĆ GĘŚLĄ JAŹŃ"), "ZAZOLC GESLA JAZN");
});

test("normIban: пробіли й сміття геть", () => {
  assert.equal(normIban("PL61 1090 0000 0000 0001"), "PL611090000000000001");
});

// ── extractForeignNip ─────────────────────────────────────────────────────────

const OWN = new Set(["7123438022", "9462698100", "7123441567"]);

test("extractForeignNip: один чужий NIP — береться, свій — ігнорується", () => {
  assert.equal(extractForeignNip("Faktura 1/2026 NIP: 5250008318 zaplata", OWN), "5250008318");
  // свій NIP у титулі (Id płatnika) — не привід чіпляти рахунок контрагенту
  assert.equal(extractForeignNip("Kwota VAT: 16976.82, Id płatnika: 7123438022", OWN), null);
  assert.equal(extractForeignNip("NIP/2090001167/IDP/5330025/TXT/Moja Firma", OWN), "2090001167");
});

test("extractForeignNip: два різні чужі NIP-и = неоднозначно → null", () => {
  assert.equal(extractForeignNip("NIP: 5250008318 oraz NIP: 1132456789", OWN), null);
  assert.equal(extractForeignNip("без ніпу тут", OWN), null);
  // той самий чужий NIP двічі — однозначно
  assert.equal(extractForeignNip("NIP: 5250008318 ... NIP.5250008318", OWN), "5250008318");
});

// ── matchWorkerByName ─────────────────────────────────────────────────────────

const WORKERS = [
  { id: 1, fullName: "Romanchuk Liudmyla" },
  { id: 2, fullName: "Smagzan Kerimbek" },
  { id: 3, fullName: "Kadi Zhuldyz" },
  { id: 4, fullName: "Pavlenko Bohdan" },
  { id: 5, fullName: "Pavlenko Bohdan" }, // повний тезка — неоднозначно
];

test("matchWorkerByName: повне ім'я в будь-якому порядку, з адресою в хвості", () => {
  assert.equal(matchWorkerByName("ROMANCHUK LIUDMYLA", WORKERS), 1);
  assert.equal(matchWorkerByName("LIUDMYLA ROMANCHUK UL. KRAKOWSKA 5", WORKERS), 1);
  assert.equal(matchWorkerByName("SMAGZAN KERIMBEK", WORKERS), 2);
});

test("matchWorkerByName: частковий збіг чи тезки — не матчимо", () => {
  assert.equal(matchWorkerByName("ROMANCHUK OLENA", WORKERS), null);      // інше ім'я
  assert.equal(matchWorkerByName("PAVLENKO BOHDAN", WORKERS), null);      // два кандидати
  assert.equal(matchWorkerByName("BIEDRONKA SP Z O O", WORKERS), null);
  assert.equal(matchWorkerByName(null, WORKERS), null);
});
