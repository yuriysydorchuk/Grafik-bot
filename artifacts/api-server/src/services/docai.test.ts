import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { sanitizeAmount, normDate, normNip, entitiesToDraft, detectOurCompany, parsePassportMrz, mrzToPassportDraft, toVisionCompatible, normalizeForOcr, mrzNationalityToCatalog } from "./docai.ts";

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

// ── parsePassportMrz (ICAO 9303 TD3) ────────────────────────────────────────────
// Класичний приклад з ICAO Doc 9303 Part 4 (Anna Maria Eriksson) — усі чек-суми валідні.
const MRZ_L1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
const MRZ_L2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";

test("parsePassportMrz: канонічний приклад — усі поля й чек-суми валідні", () => {
  const r = parsePassportMrz(`${MRZ_L1}\n${MRZ_L2}`);
  assert.ok(r);
  assert.equal(r!.documentNumber, "L898902C3");
  assert.equal(r!.issuingCountry, "UTO");
  assert.equal(r!.nationality, "UTO");
  assert.equal(r!.surname, "ERIKSSON");
  assert.equal(r!.givenNames, "ANNA MARIA");
  assert.equal(r!.sex, "F");
  assert.equal(r!.birthDate, "1974-08-12");
  assert.equal(r!.expiryDate, "2012-04-15");
  assert.equal(r!.documentNumberValid, true);
  assert.equal(r!.birthDateValid, true);
  assert.equal(r!.expiryDateValid, true);
  assert.equal(r!.compositeValid, true);
});

test("parsePassportMrz: підроблений номер документа ловиться чек-сумою", () => {
  // остання цифра номера документа змінена (C3 → C4), чек-цифра лишилась стара
  const tampered = MRZ_L2.replace("L898902C36", "L898902C46");
  const r = parsePassportMrz(`${MRZ_L1}\n${tampered}`);
  assert.ok(r);
  assert.equal(r!.documentNumberValid, false);
  assert.equal(r!.compositeValid, false, "композитна чек-сума теж падає — номер входить у її формулу");
});

test("parsePassportMrz: текст без MRZ-зони → null", () => {
  assert.equal(parsePassportMrz("Просто текст без машинозчитуваної зони паспорта."), null);
});

// ── mrzToPassportDraft (Vision API + MRZ замінили Document AI Identity processor) ─

test("mrzToPassportDraft: канонічний приклад → повна чернетка, passportIssuedAt завжди null (MRZ не кодує дату видачі)", () => {
  const mrz = parsePassportMrz(`${MRZ_L1}\n${MRZ_L2}`);
  const d = mrzToPassportDraft(mrz);
  assert.equal(d.passportNumber, "L898902C3");
  assert.equal(d.passportCountry, "UTO");
  assert.equal(d.passportIssuedAt, null);
  assert.equal(d.passportExpiresAt, "2012-04-15");
  assert.equal(d.citizenship, "UTO");
  assert.equal(d.sex, "F");
  assert.equal(d.birthDate, "1974-08-12");
  assert.equal(d.fullName, "ANNA MARIA ERIKSSON");
  assert.equal(d.firstName, "ANNA", "перше слово givenNames");
  assert.equal(d.middleName, "MARIA", "друге (і подальші) слово givenNames — по-батькові/друге ім'я");
  assert.equal(d.lastName, "ERIKSSON", "surname як є");
});

test("mrzToPassportDraft: одне ім'я в givenNames → middleName null", () => {
  const oneNameL1 = "P<UTOERIKSSON<<ANNA<<<<<<<<<<<<<<<<<<<<<<<<<";
  const mrz = parsePassportMrz(`${oneNameL1}\n${MRZ_L2}`);
  const d = mrzToPassportDraft(mrz);
  assert.equal(d.firstName, "ANNA");
  assert.equal(d.middleName, null);
  assert.equal(d.lastName, "ERIKSSON");
});

test("mrzToPassportDraft: null (MRZ не знайдено) → усі поля null", () => {
  assert.deepEqual(mrzToPassportDraft(null), {
    passportNumber: null, passportCountry: null, passportIssuedAt: null, passportExpiresAt: null,
    citizenship: null, sex: null, birthDate: null, fullName: null,
    firstName: null, middleName: null, lastName: null,
  });
});

// ── mrzNationalityToCatalog (створення працівника з паспорта) ──────────────────

test("mrzNationalityToCatalog: відомі ICAO3-коди мапляться на каталог NATIONALITIES", () => {
  assert.equal(mrzNationalityToCatalog("UKR"), "ukraine");
  assert.equal(mrzNationalityToCatalog("blr"), "belarus", "регістр не має значення");
  assert.equal(mrzNationalityToCatalog("POL"), "poland");
  assert.equal(mrzNationalityToCatalog("ROU"), "romania");
  assert.equal(mrzNationalityToCatalog("ROM"), "romania", "старий і новий ICAO-код Румунії — обидва");
});

test("mrzNationalityToCatalog: невідомий код або null → null (офіс доставить вручну)", () => {
  assert.equal(mrzNationalityToCatalog("USA"), null);
  assert.equal(mrzNationalityToCatalog(null), null);
});

// ── toVisionCompatible (HEIC→JPEG перед відправкою в Vision) ───────────────────
// Реального round-trip-декодування HEIC тут немає (валідний файл — не тривіальна
// фікстура), але маршрутизація за магічними байтами (не заявленим mimeType) —
// та сама логіка, що sniffDocMime у lib/uploads.ts — перевіряється повністю.

test("toVisionCompatible: не-HEIC (JPEG) — повертає буфер без змін, конвертер не викликається", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const out = await toVisionCompatible(jpeg);
  assert.equal(out, jpeg, "той самий буфер, не копія");
});

test("toVisionCompatible: HEIC-сигнатура (ftyp heic) — розпізнається й іде в конвертер", async () => {
  // валідні магічні байти HEIC-контейнера (ftyp box, brand "heic"), але не
  // справжнє зображення — конвертер має впасти з помилкою декодування, а не
  // мовчки пропустити непридатні байти в Vision API як JPEG.
  const fakeHeic = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]), // box size
    Buffer.from("ftyp", "latin1"),
    Buffer.from("heic", "latin1"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from("heicmif1", "latin1"),
  ]);
  await assert.rejects(() => toVisionCompatible(fakeHeic));
});

// ── normalizeForOcr (авто-поворот EXIF + масштаб перед Vision) ─────────────────
// Спостережуваний баг: фото паспорта, читабельне для людини, давало в Vision
// самі короткі уривки MRZ без жодного рядка "P<..." — телефон зберіг JPEG
// «лежачи» з EXIF-тегом орієнтації, який Vision не завжди застосовує сам.

test("normalizeForOcr: EXIF-поворот застосовується фізично (ширина/висота міняються місцями), тег знімається", async () => {
  const raw = await sharp({ create: { width: 20, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .withMetadata({ orientation: 6 }) // «поверни на 90° за годинниковою» — телефон, що лежав боком
    .jpeg()
    .toBuffer();
  const inMeta = await sharp(raw).metadata();
  assert.equal(inMeta.orientation, 6, "вхідний файл — сирі пікселі не повернуті, лише тег-підказка");

  const out = await normalizeForOcr(raw);
  const outMeta = await sharp(out).metadata();
  assert.equal(outMeta.width, 10, "після фізичного повороту на 90° сторони міняються місцями");
  assert.equal(outMeta.height, 20);
  assert.ok(!outMeta.orientation || outMeta.orientation === 1, "тег орієнтації знято — пікселі вже вирівняні, повторний поворот не потрібен");
});

test("normalizeForOcr: задовга сторона масштабується до ліміту, коротша — пропорційно", async () => {
  const raw = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: { r: 0, g: 0, b: 255 } } }).jpeg().toBuffer();
  const out = await normalizeForOcr(raw);
  const outMeta = await sharp(out).metadata();
  assert.equal(outMeta.width, 2200);
  assert.equal(outMeta.height, 1100);
});

test("normalizeForOcr: зображення менше за ліміт — розмір НЕ збільшується (withoutEnlargement)", async () => {
  const raw = await sharp({ create: { width: 100, height: 50, channels: 3, background: { r: 0, g: 255, b: 0 } } }).jpeg().toBuffer();
  const out = await normalizeForOcr(raw);
  const outMeta = await sharp(out).metadata();
  assert.equal(outMeta.width, 100);
  assert.equal(outMeta.height, 50);
});

test("normalizeForOcr: биті байти — не падає, повертає оригінал", async () => {
  const garbage = Buffer.from("зовсім не зображення");
  const out = await normalizeForOcr(garbage);
  assert.equal(out, garbage);
});
