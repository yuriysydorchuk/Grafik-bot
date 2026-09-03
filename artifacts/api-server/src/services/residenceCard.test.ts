import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTd1Mrz, parseResidenceCardText } from "./residenceCard.ts";
import { mrzCheckDigit } from "./docai.ts";

// Синтетична TD1 MRZ з правильними чек-сумами (справжню карту в репо не кладемо — RODO).
function td1(opts: { number: string; birth: string; sex: "M" | "F"; expiry: string; nat: string; surname: string; given: string; country?: string }) {
  const num = opts.number.padEnd(9, "<");
  const l1 = ("I<" + (opts.country ?? "POL") + num + mrzCheckDigit(num) + "".padEnd(15, "<")).slice(0, 30);
  const opt2 = "".padEnd(11, "<");
  const l2core = opts.birth + mrzCheckDigit(opts.birth) + opts.sex + opts.expiry + mrzCheckDigit(opts.expiry) + opts.nat + opt2;
  const composite = l1.slice(5, 30) + l2core.slice(0, 7) + l2core.slice(8, 15) + l2core.slice(18, 29);
  const l2 = l2core + mrzCheckDigit(composite);
  const l3 = (opts.surname + "<<" + opts.given.replace(/ /g, "<")).padEnd(30, "<").slice(0, 30);
  return [l1, l2, l3].join("\n");
}

test("TD1 MRZ: номер, дати, стать, громадянство, чек-суми", () => {
  const text = "KARTA POBYTU\nRZECZPOSPOLITA POLSKA\n" + td1({ number: "ZUV123456", birth: "950412", sex: "F", expiry: "280315", nat: "UKR", surname: "KOVALENKO", given: "OLENA MARIA" });
  const m = parseTd1Mrz(text);
  assert.ok(m);
  assert.equal(m.documentNumber, "ZUV123456");
  assert.equal(m.issuingCountry, "POL");
  assert.equal(m.nationality, "UKR");
  assert.equal(m.birthDate, "1995-04-12");
  assert.equal(m.expiryDate, "2028-03-15");
  assert.equal(m.sex, "F");
  assert.equal(m.surname, "KOVALENKO");
  assert.equal(m.givenNames, "OLENA MARIA");
  assert.ok(m.documentNumberValid && m.birthDateValid && m.expiryDateValid && m.compositeValid);
});

test("TD1 MRZ: OCR-плутанина P0L/UKR і зіпсована чек-сума → *Valid=false, але поля є", () => {
  const good = td1({ number: "ZUV123456", birth: "950412", sex: "M", expiry: "280315", nat: "BLR", surname: "IVANOU", given: "ALEH" });
  const lines = good.split("\n");
  lines[0] = lines[0]!.replace("I<POL", "I<P0L").slice(0, 14) + "9" + lines[0]!.slice(15); // країна з нулем + зламаний чек номера
  const m = parseTd1Mrz(lines.join("\n"));
  assert.ok(m);
  assert.equal(m.issuingCountry, "POL");
  assert.equal(m.documentNumberValid, false);
  assert.equal(m.expiryDateValid, true);
});

test("текст карти: rodzaj zezwolenia → тип, dostęp do rynku pracy → true", () => {
  const front = "RZECZPOSPOLITA POLSKA\nKARTA POBYTU\nRODZAJ ZEZWOLENIA / TYPE OF PERMIT\nPOBYT CZASOWY\nDATA WAŻNOŚCI / DATE OF EXPIRY\n15.03.2028";
  const back = "ADNOTACJE / REMARKS\nDOSTĘP DO RYNKU PRACY\n" + td1({ number: "ZUV123456", birth: "950412", sex: "F", expiry: "280315", nat: "UKR", surname: "KOVALENKO", given: "OLENA" });
  const mrz = parseTd1Mrz(back);
  const d = parseResidenceCardText(front + "\n" + back, mrz);
  assert.equal(d.typeCode, "trc");
  assert.equal(d.laborMarketAccess, true);
  assert.equal(d.expiresAt, "2028-03-15");
  assert.equal(d.cardNumber, "ZUV123456");
  assert.equal(d.nationality, "UKR");
  assert.equal(d.isResidenceCard, true);
  assert.equal(d.mrzValid, true);
});

test("текст карти: stały / rezydent / uchodźca / rodzina UE; без MRZ — строк з тексту; без анотацій → null", () => {
  assert.equal(parseResidenceCardText("KARTA POBYTU\nPOBYT STAŁY", null).typeCode, "karta_stalego_pobytu");
  assert.equal(parseResidenceCardText("POBYT REZYDENTA DŁUGOTERMINOWEGO UE", null).typeCode, "rezydent_ue");
  assert.equal(parseResidenceCardText("STATUS UCHODŹCY", null).typeCode, "refugee_status");
  assert.equal(parseResidenceCardText("CZŁONEK RODZINY OBYWATELA UE", null).typeCode, "eu_family_member_card");
  assert.equal(parseResidenceCardText("OCHRONA UZUPEŁNIAJĄCA", null).typeCode, "subsidiary_protection");
  const d = parseResidenceCardText("KARTA POBYTU\nPOBYT CZASOWY\nWAŻNA DO / DATE OF EXPIRY: 01.02.2027", null);
  assert.equal(d.expiresAt, "2027-02-01");
  assert.equal(d.laborMarketAccess, null, "лицьова без блоку анотацій — невідомо");
  const back = parseResidenceCardText("ADNOTACJE / REMARKS\n-", null);
  assert.equal(back.laborMarketAccess, false, "блок анотацій є, доступу нема → false");
  assert.equal(parseResidenceCardText("faktura VAT nr 12/2026", null).isResidenceCard, false);
});
