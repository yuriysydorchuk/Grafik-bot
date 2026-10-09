// Чисті юніти правил веб-анкети (без БД). Останній тест — guard: копія у
// web/src/lib має бути побайтово тією самою (веб не імпортує api-server).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isLatin, isLatinName, peselChecksumOk, peselBirthDate, peselSex, nipOk, normalizeNrb, formatNrb, normalizePhone, normalizePostal, POSTAL_RE,
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

test("рахунок: польський NRB → 26 цифр; іноземний IBAN → з кодом країни; довжина + mod-97", () => {
  assert.equal(normalizeNrb("PL61109010140000071219812874"), "61109010140000071219812874");
  assert.equal(normalizeNrb("61 1090 1014 0000 0712 1981 2874"), "61109010140000071219812874");
  assert.equal(normalizeNrb("pl61 1090 1014 0000 0712 1981 2874"), "61109010140000071219812874");
  assert.equal(normalizeNrb("61109010140000071219812875"), null, "зіпсована контрольна");
  assert.equal(normalizeNrb("DE89 3704 0044 0532 0130 00"), "DE89370400440532013000", "німецький IBAN");
  assert.equal(normalizeNrb("lt12 1000 0111 0100 1000"), "LT121000011101001000", "Revolut LT, малі літери");
  assert.equal(normalizeNrb("GB29 NWBK 6016 1331 9268 19"), "GB29NWBK60161331926819", "літери в BBAN");
  assert.equal(normalizeNrb("UA21 3223 1300 0002 6007 2335 6600 1"), "UA213223130000026007233566001");
  assert.equal(normalizeNrb("DE89370400440532013001"), null, "іноземний — зіпсована контрольна");
  assert.equal(normalizeNrb("DE8937040044053201300"), null, "іноземний — не та довжина");
  assert.equal(normalizeNrb("XX89370400440532013000"), null, "невідома країна");
  assert.equal(normalizeNrb("PL61109010140000071219812874"), "61109010140000071219812874");
  assert.equal(normalizeNrb("6110901014"), null);
  assert.equal(formatNrb("61109010140000071219812874"), "61 1090 1014 0000 0712 1981 2874");
});

test("телефон: нормалізація", () => {
  assert.equal(normalizePhone("+48 600 000 000"), "+48600000000");
  assert.equal(normalizePhone("(71) 365-24-00"), "713652400", "дужки/дефіси прибираються");
  assert.equal(normalizePhone("12345"), null, "замало цифр");
  assert.equal(normalizePhone("600000000"), "600000000");
  assert.equal(normalizePhone("abc"), null);
  assert.equal(normalizePhone("+7 (701) 234-56-78"), "+77012345678", "Казахстан");
  assert.equal(normalizePhone("00380 67 300 02 14"), "+380673000214", "00 → +");
  assert.equal(normalizePhone("\u2068+380\u00a067 300 02 14\u2069"), "+380673000214", "невидимі символи iOS");
  assert.equal(normalizePhone("+48+600000000"), null, "плюс не на початку");
  assert.equal(normalizePhone("+48abc123456789"), null, "літери — не зрізаємо мовчки");
});

test("індекс: польський, закордонний, авто-дефіс для воєводства", () => {
  for (const ok of ["20-076", "20142", "050000", "SW1A 1AA", "1000", "L-1234"]) assert.ok(POSTAL_RE.test(ok), ok);
  for (const bad of ["1", "20--076", "20-076-1-2", "12345678901", "20 07 6"]) assert.ok(!POSTAL_RE.test(bad), bad);
  assert.equal(normalizePostal("20076", "lubelskie"), "20-076");
  assert.equal(normalizePostal("20076", "Woj. Łódzkie"), "20-076", "діакритики/префікс");
  assert.equal(normalizePostal("20142", "Lwowska"), "20142", "не польське воєводство — як є");
  assert.equal(normalizePostal("050000", "mazowieckie"), "050000", "6 цифр — не чіпаємо");
  assert.equal(normalizePostal(" 20-076 ", "lubelskie"), "20-076");
  assert.equal(normalizePostal("20076", " Mazowieckie "), "20-076", "крайові пробіли у воєводстві");
  const pl = validateQuestionnaire({ ...fullAnketa(), regWojewodztwo: "mazowieckie", regKodPocztowy: "ABC" }, { birthDate: "1944-05-14" });
  assert.equal(pl.errors.regKodPocztowy, "format", "польське воєводство → лише XX-XXX");
  const pl6 = validateQuestionnaire({ ...fullAnketa(), regWojewodztwo: "mazowieckie", regKodPocztowy: "050000" }, { birthDate: "1944-05-14" });
  assert.equal(pl6.errors.regKodPocztowy, "format");
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
  const ua = validateQuestionnaire({ ...fullAnketa(), regWojewodztwo: "Lwowska", regKodPocztowy: "79000", zamSame: false,
    zamWojewodztwo: "lubelskie", zamPowiat: "Lublin", zamGmina: "Lublin", zamMiejscowosc: "Lublin", zamUlica: "Nowa", zamNumerDomu: "1", zamKodPocztowy: "20076",
  }, { birthDate: "1944-05-14" });
  assert.deepEqual(ua.errors, {});
  assert.equal(ua.values.reg.KodPocztowy, "79000", "закордонний індекс — як є");
  assert.equal(ua.values.zam.KodPocztowy, "20-076", "польське воєводство + 5 цифр → дефіс");
  assert.equal(ua.values.postalCode, "20-076");
  assert.equal(ua.values.addressPl, "Nowa 1, 20-076 Lublin");
});

test("validateQuestionnaire: пропуски/формати/кирилиця/згоди/умовні поля", () => {
  const r = validateQuestionnaire({
    ...fullAnketa(), pesel: "44051401359", motherName: "Марія", bankIban: "DE89370400440532013001", phone: "12",
    email: "nope", taxOffice: "щось", regKodPocztowy: "2", zamSame: false, zamUlica: "Nowa",
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
