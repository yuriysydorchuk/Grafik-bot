// Чисті юніти правил веб-анкети (без БД). Останній тест — guard: копія у
// web/src/lib має бути побайтово тією самою (веб не імпортує api-server).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isLatin, isLatinName, peselChecksumOk, peselBirthDate, peselSex, nipOk, normalizeNrb, formatNrb, normalizePhone,
  validatePassport, validateQuestionnaire, CONSENT_KEYS,
} from "./questionnaireRules";

test("isLatin: латиниця з польськими літерами — ок, кирилиця — ні", () => {
  assert.equal(isLatin("ul. Długa 5/12, Łódź"), true);
  assert.equal(isLatin("Kraków-Podgórze 'A'"), true);
  assert.equal(isLatin("Львів"), false);
  assert.equal(isLatin("Jan Иванов"), false);
  assert.equal(isLatinName("Anna-Maria O'Neil"), true);
  assert.equal(isLatinName("Anna 2"), false);
  assert.equal(isLatinName("Ганна"), false);
});

test("PESEL: контрольна сума, дата, стать", () => {
  // 44051401359 — класичний валідний приклад (14.05.1944, M)
  assert.equal(peselChecksumOk("44051401359"), true);
  assert.equal(peselChecksumOk("44051401358"), false);
  assert.equal(peselBirthDate("44051401359"), "1944-05-14");
  assert.equal(peselSex("44051401359"), "M");
  // 2000-і: місяць +20 → 02.03.2002
  assert.equal(peselBirthDate("02230200000"), "2002-03-02");
  assert.equal(peselBirthDate("02990200000"), null, "невалідний місяць");
  assert.equal(peselBirthDate("123"), null);
});

test("NIP: контрольна сума", () => {
  assert.equal(nipOk("9462698100"), true); // NIP фірми з умов
  assert.equal(nipOk("946-269-81-00"), true);
  assert.equal(nipOk("9462698101"), false);
  assert.equal(nipOk("123"), false);
});

test("NRB: 26 цифр або PL+26, mod-97, пробіли; іноземний IBAN — ні", () => {
  assert.equal(normalizeNrb("PL61109010140000071219812874"), "61109010140000071219812874");
  assert.equal(normalizeNrb("61 1090 1014 0000 0712 1981 2874"), "61109010140000071219812874");
  assert.equal(normalizeNrb("pl61 1090 1014 0000 0712 1981 2874"), "61109010140000071219812874");
  assert.equal(normalizeNrb("61109010140000071219812875"), null, "зіпсована контрольна");
  assert.equal(normalizeNrb("DE89370400440532013000"), null, "не польський");
  assert.equal(normalizeNrb("6110901014"), null);
  assert.equal(formatNrb("61109010140000071219812874"), "61 1090 1014 0000 0712 1981 2874");
});

test("телефон: нормалізація", () => {
  assert.equal(normalizePhone("+48 600 000 000"), "+48600000000");
  assert.equal(normalizePhone("(71) 365-24-00"), "713652400", "дужки/дефіси прибираються");
  assert.equal(normalizePhone("12345"), null, "замало цифр");
  assert.equal(normalizePhone("600000000"), "600000000");
  assert.equal(normalizePhone("abc"), null);
});

test("validatePassport: обов'язкові поля, вік, термін дії, формат номера", () => {
  const today = "2026-09-08";
  const ok = validatePassport({
    firstName: "Jan", lastName: "Kowalski", birthDate: "1995-05-05", passportNumber: "fc 1234567",
    passportCountry: "Ukraina", passportExpiresAt: "2030-01-01", citizenship: "UKR", sex: "M",
  }, today);
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.passportNumber, "FC1234567", "великі літери без пробілів");

  const bad = validatePassport({ firstName: "Іван", lastName: "", birthDate: "2015-01-01", passportNumber: "12", passportExpiresAt: "2020-01-01", citizenship: "Україна" }, today);
  assert.equal(bad.errors.firstName, "latin");
  assert.equal(bad.errors.lastName, "required");
  assert.equal(bad.errors.birthDate, "age");
  assert.equal(bad.errors.passportNumber, "format");
  assert.equal(bad.errors.passportCountry, "required");
  assert.equal(bad.errors.passportExpiresAt, "expired");
  assert.equal(bad.errors.citizenship, "latin");
  assert.equal(bad.errors.sex, "required");
});

const fullAnketa = () => ({
  birthPlace: "Lwów", pesel: "44051401359", motherName: "Maria", fatherName: "Piotr", bankName: "PKO BP",
  bankIban: "PL61 1090 1014 0000 0712 1981 2874", phone: "+48 600 000 000", email: "jan@example.com",
  taxOffice: "Urząd Skarbowy w Lublinie", nfzBranch: "Lubelski Oddział Narodowego Funduszu Zdrowia w Lublinie",
  regWojewodztwo: "lubelskie", regPowiat: "Lublin", regGmina: "Lublin", regMiejscowosc: "Lublin", regUlica: "Długa", regNumerDomu: "5/12", regKodPocztowy: "20-076",
  zamSame: true,
  consents: Object.fromEntries(CONSENT_KEYS.map(k => [k, true])),
});

test("validateQuestionnaire: повна анкета — без помилок, похідні адреси, нормалізація", () => {
  const r = validateQuestionnaire(fullAnketa(), { birthDate: "1944-05-14" });
  assert.deepEqual(r.errors, {});
  assert.equal(r.values.bankIban, "61109010140000071219812874");
  assert.equal(r.values.phone, "+48600000000");
  assert.equal(r.values.addressRegistered, "Długa 5/12, 20-076 Lublin");
  assert.equal(r.values.addressPl, "Długa 5/12, 20-076 Lublin", "zamSame → та сама");
  assert.equal(r.values.postalCode, "20-076");
  assert.equal(r.values.city, "Lublin");
  assert.equal(r.values.zam.Ulica, "Długa");
});

test("validateQuestionnaire: пропуски/формати/кирилиця/згоди/умовні поля", () => {
  const r = validateQuestionnaire({
    ...fullAnketa(), pesel: "44051401359", motherName: "Марія", bankIban: "DE89370400440532013000", phone: "12",
    email: "nope", taxOffice: "щось", regKodPocztowy: "20076", zamSame: false, zamUlica: "Nowa",
    isStudent: true, hasOtherEmployment: true, nip: "1234567890", consents: { rodo_info: true },
  }, { birthDate: "1990-01-01" });
  assert.equal(r.errors.pesel, "date", "PESEL не збігається з датою народження");
  assert.equal(r.errors.motherName, "latin");
  assert.equal(r.errors.bankIban, "format");
  assert.equal(r.errors.phone, "format");
  assert.equal(r.errors.email, "format");
  assert.equal(r.errors.taxOffice, "list");
  assert.equal(r.errors.regKodPocztowy, "format");
  assert.equal(r.errors.zamWojewodztwo, "required", "zamSame=false → друга адреса обов'язкова");
  assert.equal(r.errors.zamUlica, undefined);
  assert.equal(r.errors.schoolName, "required");
  assert.equal(r.errors.otherEmploymentNote, "required");
  assert.equal(r.errors.nip, "checksum");
  assert.equal(r.errors["consents.processing"], "consent");
  assert.equal(r.errors["consents.rodo_info"], undefined);
});

test("validateQuestionnaire: список urzędów/NFZ з контексту — значення поза списком відхиляється", () => {
  const r = validateQuestionnaire(fullAnketa(), { taxOffices: ["Urząd Skarbowy w Poznaniu"], nfzBranches: ["X"] });
  assert.equal(r.errors.taxOffice, "list");
  assert.equal(r.errors.nfzBranch, "list");
});

test("guard: web/src/lib/questionnaireRules.ts — побайтова копія серверного файлу", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const server = fs.readFileSync(path.join(here, "questionnaireRules.ts"), "utf8");
  const webPath = path.resolve(here, "../../../web/src/lib/questionnaireRules.ts");
  assert.ok(fs.existsSync(webPath), `нема копії у вебі: ${webPath}`);
  assert.equal(fs.readFileSync(webPath, "utf8"), server, "правила розійшлися — скопіюй серверний файл у web/src/lib");
});
