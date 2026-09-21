import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, phoneCheck, smsParts, renderSmsText } from "./phone.ts";

test("normalizePhone: PL local / with code / spaces / UA local", () => {
  assert.equal(normalizePhone("573 000 214"), "+48573000214");
  assert.equal(normalizePhone("+48 573-000-214"), "+48573000214");
  assert.equal(normalizePhone("48573000214"), "+48573000214");
  assert.equal(normalizePhone("0673000214"), "+380673000214");
  assert.equal(normalizePhone("380673000214"), "+380673000214");
  assert.equal(normalizePhone("0048573000214"), "+48573000214");
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone("02291508988"), null); // PESEL-подібне
});

test("phoneCheck: мобільні vs стаціонарні vs підозрілі", () => {
  assert.deepEqual(phoneCheck("+48573000214"), { type: "мобільний PL", smsOk: "так" });
  assert.deepEqual(phoneCheck("+48814632323"), { type: "стаціонарний PL", smsOk: "ні" });
  assert.deepEqual(phoneCheck("+48700987321"), { type: "PL преміум 70x", smsOk: "ні" });
  assert.equal(phoneCheck("+48500000000").smsOk, "ні");
  assert.deepEqual(phoneCheck("+380673000214"), { type: "мобільний UA", smsOk: "так" });
  assert.deepEqual(phoneCheck("+380443000214"), { type: "стаціонарний UA", smsOk: "ні" });
  assert.deepEqual(phoneCheck("+375291239567"), { type: "мобільний BY", smsOk: "так" });
  assert.equal(phoneCheck("+971527730372").smsOk, "закордон");
});

test("smsParts: GSM-7 vs UCS-2, польська літера ламає GSM", () => {
  assert.deepEqual(smsParts("Oksana, factory job in Lublin"), { encoding: "GSM-7", chars: 29, parts: 1 });
  assert.equal(smsParts("a".repeat(160)).parts, 1);
  assert.equal(smsParts("a".repeat(161)).parts, 2);
  assert.equal(smsParts("Робота в Любліні").encoding, "UCS-2");
  assert.equal(smsParts("Р".repeat(70)).parts, 1);
  assert.equal(smsParts("Р".repeat(71)).parts, 2);
  assert.equal(smsParts("Р".repeat(134)).parts, 2);
  assert.equal(smsParts("31 zł/h").encoding, "UCS-2");
  assert.equal(smsParts("31 zl/h").encoding, "GSM-7");
  assert.equal(smsParts("a{b}").chars, 6); // розширені знаки по 2
});

test("renderSmsText: імʼя та лінк, без імені — без звертання", () => {
  const tpl = "{імʼя}, робота в Любліні: 31 zl/год. Запис: {лінк}";
  assert.equal(renderSmsText(tpl, { name: "Oksana", link: "es-job.pl/r/ABC" }), "Oksana, робота в Любліні: 31 zl/год. Запис: es-job.pl/r/ABC");
  assert.equal(renderSmsText(tpl, { name: "", link: "es-job.pl/r/ABC" }), "робота в Любліні: 31 zl/год. Запис: es-job.pl/r/ABC");
  assert.equal(renderSmsText("{name}, job: {link}", { name: "Ann", link: "x" }), "Ann, job: x");
});
