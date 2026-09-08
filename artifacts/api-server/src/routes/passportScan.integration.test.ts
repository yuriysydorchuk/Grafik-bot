import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, db,
  workersTable, workerQuestionnairesTable, workerDocumentsTable, factoriesTable, passportScanTokensTable, documentTypesTable,
  candidatesTable,
} from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { ensureUploadDirs, PASSPORT_SCAN_TMP_DIR, UPLOADS_ROOT } from "../lib/uploads.ts";
import { createAnketaToken } from "./passportScan.ts";

// Публічна сторінка сканування паспорта (/passport-scan/:token, камера в
// браузері замість фото в Telegram, §1 плану worker-docs-signing). Живий
// Vision API в тестовому середовищі не налаштований — analyze() (реальний
// OCR) перевіряється лише на гейтах; confirm() симулюємо, вставляючи
// tempFilePath/draftJson напряму в БД, ніби analyze() уже відпрацював —
// той самий трюк, що інші токен-флоу в цьому наборі тестів.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const PNG = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "latin1");

before(() => { if (hasTestDb) ensureUploadDirs(); });
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function mkFactory(): Promise<number> {
  const [f] = await db.insert(factoriesTable).values({ name: "Fabryka Testowa" }).returning({ id: factoriesTable.id });
  return f!.id;
}

// Вставляє токен так, ніби analyze() уже успішно відпрацював — реальний
// файл на диску (потрібен для rename() у confirm()) + чернетка з OCR.
async function mkAnalyzedToken(opts: { purpose: "office" | "self" | "anketa"; factoryId?: number | null; telegramId?: string | null; createdBy?: number | null; workerId?: number | null; candidateId?: number | null }): Promise<string> {
  const token = `TESTPSTOK${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const storedName = `${Date.now()}-test.jpg`;
  await fs.promises.writeFile(path.join(PASSPORT_SCAN_TMP_DIR, storedName), PNG);
  await db.insert(passportScanTokensTable).values({
    token, purpose: opts.purpose, factoryId: opts.factoryId ?? null, telegramId: opts.telegramId ?? null,
    language: "uk", createdBy: opts.createdBy ?? null, workerId: opts.workerId ?? null, candidateId: opts.candidateId ?? null,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    tempFilePath: path.join("passport-scan-tmp", storedName), tempFileName: "passport.jpg", tempFileMime: "image/jpeg",
    draftJson: { draft: { fullName: "JAN KOWALSKI", birthDate: "1990-01-01" }, mrz: null },
  });
  return token;
}

// Повні валідні payload-и (08.09.2026: усі поля обов'язкові, лише латиниця, формати — lib/questionnaireRules)
const PASSPORT_OK = {
  birthDate: "1995-05-05", passportNumber: "AB1234567", passportCountry: "POL", passportExpiresAt: "2030-01-01", citizenship: "POL", sex: "M",
};
const CONSENTS_OK = { rodo_info: true, processing: true, storage: true, sharing: true, e_comm: true };
const ANKETA_OK = {
  birthPlace: "Warszawa", pesel: "95050512346", motherName: "Maria", fatherName: "Piotr", bankName: "PKO BP",
  bankIban: "PL61109010140000071219812874", phone: "+48123456789", email: "jan@example.com",
  taxOffice: "Urząd Skarbowy w Lublinie", nfzBranch: "Lubelski Oddział Narodowego Funduszu Zdrowia w Lublinie",
  regWojewodztwo: "mazowieckie", regPowiat: "Warszawa", regGmina: "Warszawa", regMiejscowosc: "Warszawa", regUlica: "Testowa", regNumerDomu: "1", regKodPocztowy: "00-001",
  zamSame: true, consents: CONSENTS_OK,
};

test("GET /api/passport-scan/:token: невідомий токен — 404", opts, async () => {
  const res = await request(app).get("/api/passport-scan/NOPE");
  assert.equal(res.status, 404);
});

test("GET /api/passport-scan/:token: валідний — повертає purpose/factoryName/language, БЕЗ сесії", opts, async () => {
  const factoryId = await mkFactory();
  const token = await mkAnalyzedToken({ purpose: "self", factoryId });
  const res = await request(app).get(`/api/passport-scan/${token}`); // без Cookie
  assert.equal(res.status, 200);
  assert.equal(res.body.purpose, "self");
  assert.equal(res.body.factoryName, "Fabryka Testowa");
});

test("протермінований токен відхиляється", opts, async () => {
  const token = await mkAnalyzedToken({ purpose: "self" });
  await db.update(passportScanTokensTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(passportScanTokensTable.token, token));
  const res = await request(app).get(`/api/passport-scan/${token}`);
  assert.equal(res.status, 404);
});

test("POST .../analyze: без файлу — 400; невалідний тип — 400", opts, async () => {
  const token = await mkAnalyzedToken({ purpose: "self" });
  const noFile = await request(app).post(`/api/passport-scan/${token}/analyze`).set(H);
  assert.equal(noFile.status, 400);

  const badMime = await request(app).post(`/api/passport-scan/${token}/analyze`).set(H)
    .attach("file", Buffer.from("<html></html>"), { filename: "evil.pdf", contentType: "application/pdf" });
  assert.equal(badMime.status, 400);
});

test("POST .../confirm: без попереднього analyze() — 400 «Спершу відскануй паспорт»", opts, async () => {
  const token = `TESTPSTOK${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  await db.insert(passportScanTokensTable).values({ token, purpose: "self", expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
  const res = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Jan", lastName: "Kowalski" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /відскануй/);
});

test("POST .../confirm: ім'я/прізвище не латиницею — 400, нічого не створюється", opts, async () => {
  const token = await mkAnalyzedToken({ purpose: "self" });
  const before = (await db.select().from(workersTable)).length;
  const res = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Іван", lastName: "Петров" });
  assert.equal(res.status, 400);
  const after = (await db.select().from(workersTable)).length;
  assert.equal(after, before);
});

test("POST .../confirm: без прізвища (лише firstName) — 400", opts, async () => {
  const token = await mkAnalyzedToken({ purpose: "self" });
  const res = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Jan" });
  assert.equal(res.status, 400);
  assert.equal(res.body.fields.lastName, "required");
});

test("POST .../confirm: щасливий шлях (self) — створює працівника з окремих firstName/middleName/lastName + factoryId/telegramId/language з ТОКЕНА, файл переїжджає в worker-documents, токен стає використаним", opts, async () => {
  const factoryId = await mkFactory();
  const token = await mkAnalyzedToken({ purpose: "self", factoryId, telegramId: "999888777" });

  const res = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({
    firstName: "Jan", middleName: "Paweł", lastName: "Kowalski",
    birthDate: "1995-05-05", passportNumber: "AB1234567",
    passportCountry: "POL", passportExpiresAt: "2030-01-01", citizenship: "POL", sex: "M",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.worker.fullName, "Jan Kowalski", "fullName — канонічний, компонується з firstName+lastName (без middleName)");

  const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, res.body.worker.id));
  assert.equal(worker!.firstName, "Jan");
  assert.equal(worker!.middleName, "Paweł");
  assert.equal(worker!.lastName, "Kowalski");
  assert.equal(worker!.factoryId, factoryId, "фабрика — з токена, не з тіла запиту");
  assert.equal(worker!.telegramId, "999888777");
  assert.equal(worker!.gender, "male");
  assert.equal(worker!.nationality, "poland");

  const [doc] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.workerId, worker!.id));
  assert.ok(doc, "документ «Paszport» має створитись");
  assert.ok(fs.existsSync(path.join(UPLOADS_ROOT, doc!.filePath!)), "файл має переїхати в постійне сховище");

  const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, worker!.id));
  assert.equal(q!.passportNumber, "AB1234567");

  const [tokenRow] = await db.select().from(passportScanTokensTable).where(eq(passportScanTokensTable.token, token));
  assert.ok(tokenRow!.usedAt);
  assert.equal(tokenRow!.workerId, worker!.id);

  const again = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Jan", lastName: "Kowalski" });
  assert.equal(again.status, 404, "використаний токен більше не діє");
});

test("POST .../confirm: office purpose — factoryId/telegramId лишаються null (призначаються пізніше в панелі)", opts, async () => {
  const { adminId } = await seedAdmin({ role: "owner" });
  const token = await mkAnalyzedToken({ purpose: "office", createdBy: adminId });

  const res = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Anna", lastName: "Nowak" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, res.body.worker.id));
  assert.equal(worker!.factoryId, null);
  assert.equal(worker!.telegramId, null);
});

// ── /questionnaire (решта анкети одразу після скану, §1 плану) ─────────────
test("POST .../questionnaire: без попереднього confirm() — 400", opts, async () => {
  const token = await mkAnalyzedToken({ purpose: "self" }); // analyze() пройшов, confirm() — ще ні
  const res = await request(app).post(`/api/passport-scan/${token}/questionnaire`).set(H).send(ANKETA_OK);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /відскануй/);
});

test("POST .../questionnaire: після confirm() зберігає поля, status → submitted", opts, async () => {
  const token = await mkAnalyzedToken({ purpose: "self" });
  const confirmed = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Jan", lastName: "Kowalski" });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  const res = await request(app).post(`/api/passport-scan/${token}/questionnaire`).set(H).send({
    ...ANKETA_OK, motherName: "Maria Kowalska", fatherName: "Jan Kowalski",
    isStudent: true, schoolName: "Uniwersytet Warszawski", hasOtherEmployment: false,
    isRegisteredUnemployed: true, emergencyContact: "Anna, +48123456789",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, confirmed.body.worker.id));
  assert.equal(q!.addressPl, "Testowa 1, 00-001 Warszawa", "вільнотекстова адреса — похідна від структурованої");
  assert.equal(q!.addressRegistered, "Testowa 1, 00-001 Warszawa");
  assert.equal(q!.zamUlica, "Testowa", "zamSame → адреса проживання = zameldowania");
  assert.equal(q!.motherName, "Maria Kowalska");
  assert.equal(q!.fatherName, "Jan Kowalski");
  assert.equal(q!.bankName, "PKO BP");
  assert.equal(q!.bankIban, "61109010140000071219812874", "рахунок нормалізується до 26 цифр (без PL/пробілів)");
  assert.equal(q!.phone, "+48123456789");
  assert.deepEqual(q!.consents, CONSENTS_OK);
  assert.ok(q!.consentsAt, "час згоди фіксується");
  assert.equal(q!.consentsVersion, "2026-09-08");
  assert.equal(q!.email, "jan@example.com");
  assert.equal(q!.isStudent, true);
  assert.equal(q!.schoolName, "Uniwersytet Warszawski");
  assert.equal(q!.isRegisteredUnemployed, true);
  assert.equal(q!.status, "submitted", "офіс іще має підтвердити — не verified одразу");
  assert.ok(q!.submittedAt);

  // PESEL — канонічне поле на workersTable, не дублюється в анкеті.
  const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, confirmed.body.worker.id));
  assert.equal(worker!.pesel, "95050512346");
});

test("POST .../questionnaire: невалідні поля — 400 з мапою fields, нічого не пишеться (08.09.2026: без мовчазного ігнорування)", opts, async () => {
  const token = await mkAnalyzedToken({ purpose: "self" });
  const confirmed = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Jan", lastName: "Kowalski" });
  const res = await request(app).post(`/api/passport-scan/${token}/questionnaire`).set(H).send({
    ...ANKETA_OK, pesel: "123", motherName: "Марія", bankIban: "DE89370400440532013000", regKodPocztowy: "00001", consents: { rodo_info: true },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.fields.pesel, "format");
  assert.equal(res.body.fields.motherName, "latin");
  assert.equal(res.body.fields.bankIban, "format");
  assert.equal(res.body.fields.regKodPocztowy, "format");
  assert.equal(res.body.fields["consents.processing"], "consent");
  const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, confirmed.body.worker.id));
  assert.equal(worker!.pesel, null);
  const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, confirmed.body.worker.id));
  assert.equal(q!.status, "draft", "статус не міняється, поки анкета невалідна");
});

test("POST .../questionnaire: PESEL не збігається з датою народження зі скану — 400 pesel=date", opts, async () => {
  const token = await mkAnalyzedToken({ purpose: "self" });
  await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Jan", lastName: "Kowalski", birthDate: "1990-01-01" });
  const res = await request(app).post(`/api/passport-scan/${token}/questionnaire`).set(H).send(ANKETA_OK); // PESEL на 1995-05-05
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.fields.pesel, "date");
});

// ── /student-cert (довідка студента одразу з анкети, §1 плану) ─────────────
test("POST .../student-cert: без попереднього confirm() — 400", opts, async () => {
  const token = await mkAnalyzedToken({ purpose: "self" });
  const res = await request(app).post(`/api/passport-scan/${token}/student-cert`).set(H)
    .attach("file", PNG, { filename: "cert.png", contentType: "image/png" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /відскануй/);
});

test("POST .../student-cert: після confirm() створює документ типу «Довідка студента» (icon=student), статус pending", opts, async () => {
  const token = await mkAnalyzedToken({ purpose: "self" });
  const confirmed = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Jan", lastName: "Kowalski" });
  const workerId = confirmed.body.worker.id;

  const res = await request(app).post(`/api/passport-scan/${token}/student-cert`).set(H)
    .attach("file", PNG, { filename: "cert.png", contentType: "image/png" });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // Працівник уже має паспорт з confirm() — беремо саме тип student_cert
  // (02.09.2026: типи резолвляться по стабільному code, назва — польська з сіду).
  const [docType] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.code, "student_cert"));
  assert.ok(docType, "тип student_cert має створитись через ensureDocumentType");
  assert.equal(docType!.icon, "student");
  const docs = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.workerId, workerId));
  const doc = docs.find(d => d.docTypeId === docType!.id);
  assert.ok(doc, "документ типу student_cert має створитись");
  assert.equal(doc!.status, "pending");
  assert.equal(doc!.source, "worker_bot");
  assert.ok(fs.existsSync(path.join(UPLOADS_ROOT, doc!.filePath!)));
});

// ── purpose=anketa (бот «📄 Документи → заповнити анкету», §31.08.2026) ────
// Дозаповнення/редагування анкети ІСНУЮЧИМ працівником — без кроку сканування
// паспорта, лінк одразу відкриває крок анкети з уже збереженими відповідями.
test("GET .../<anketa-токен>: покаже purpose=anketa, questionnaire+pesel — з уже збережених даних", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski", pesel: "12345678901" }).returning({ id: workersTable.id });
  await db.insert(workerQuestionnairesTable).values({ workerId: w!.id, addressPl: "ul. Stara 1", isStudent: true });

  const token = await createAnketaToken(w!.id);
  const res = await request(app).get(`/api/passport-scan/${token}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.purpose, "anketa");
  assert.equal(res.body.pesel, "12345678901");
  assert.equal(res.body.questionnaire.addressPl, "ul. Stara 1");
  assert.equal(res.body.questionnaire.isStudent, true);
});

test("POST .../questionnaire з anketa-токеном — працює одразу, БЕЗ попереднього confirm()", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski" }).returning({ id: workersTable.id });
  const token = await createAnketaToken(w!.id);

  const res = await request(app).post(`/api/passport-scan/${token}/questionnaire`).set(H).send({ ...ANKETA_OK, regUlica: "Nowa", regNumerDomu: "2", isStudent: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, w!.id));
  assert.equal(q!.addressPl, "Nowa 2, 00-001 Warszawa");
  assert.equal(q!.status, "submitted");
});

test("POST .../questionnaire з anketa-токеном — пише firstName/middleName/lastName на workersTable, fullName НЕ чіпає; невалідне ім'я — 400", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski" }).returning({ id: workersTable.id });
  const token = await createAnketaToken(w!.id);

  const res = await request(app).post(`/api/passport-scan/${token}/questionnaire`).set(H).send({ ...ANKETA_OK, firstName: "Jan", middleName: "Paweł", lastName: "Kowalski" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [updated] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(updated!.firstName, "Jan");
  assert.equal(updated!.middleName, "Paweł");
  assert.equal(updated!.lastName, "Kowalski");
  assert.equal(updated!.fullName, "Jan Kowalski", "fullName лишається як був, не перекомпоновується");

  const bad = await request(app).post(`/api/passport-scan/${token}/questionnaire`).set(H).send({ ...ANKETA_OK, firstName: "Іван", lastName: "Kowalski" });
  assert.equal(bad.status, 400, "невалідне ім'я — 400 (08.09.2026: нічого не ігнорується мовчки)");
  assert.equal(bad.body.fields.firstName, "latin");
  const [afterBad] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(afterBad!.firstName, "Jan", "невалідне значення не записалось");
});

test("anketa-токен НЕ одноразовий — можна дозаповнити анкету кілька разів у межах TTL", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski" }).returning({ id: workersTable.id });
  const token = await createAnketaToken(w!.id);

  const first = await request(app).post(`/api/passport-scan/${token}/questionnaire`).set(H).send({ ...ANKETA_OK, phone: "+48111111111" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await request(app).post(`/api/passport-scan/${token}/questionnaire`).set(H).send({ ...ANKETA_OK, phone: "+48222222222" });
  assert.equal(second.status, 200, "той самий токен — ще раз, не «використано»");

  const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, w!.id));
  assert.equal(q!.phone, "+48222222222");
});

// ── Запрошення ІСНУЮЧОГО працівника на скан+анкету (needsPassportScan) ─────
test("GET .../<anketa-токен>: needsPassportScan=true без паспорта на файлі, false — якщо є", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski" }).returning({ id: workersTable.id });
  const noDocsToken = await createAnketaToken(w!.id);
  const r1 = await request(app).get(`/api/passport-scan/${noDocsToken}`);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.needsPassportScan, true);

  const [docType] = await db.insert(documentTypesTable).values({ name: "Paszport", code: "passport", category: "identity", required: true, hasExpiry: true }).returning({ id: documentTypesTable.id });
  await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: docType!.id, title: "Paszport", status: "present" });
  const withDocToken = await createAnketaToken(w!.id);
  const r2 = await request(app).get(`/api/passport-scan/${withDocToken}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.needsPassportScan, false);
});

test("POST .../confirm з anketa-токеном (ІСНУЮЧИЙ workerId) — ОНОВЛЮЄ профіль, не створює дубль; firstName/lastName добираються (fill-if-missing), fullName НЕ чіпається", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski", workerCode: "00042" }).returning();
  const before = (await db.select().from(workersTable)).length;
  const token = await mkAnalyzedToken({ purpose: "anketa", workerId: w!.id });

  const res = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({
    ...PASSPORT_OK, firstName: "Piotr", lastName: "Zima", birthDate: "1995-05-05", sex: "M", citizenship: "POL",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.worker.id, w!.id, "жодного нового working — той самий id");
  assert.equal(res.body.worker.fullName, "Jan Kowalski", "fullName НЕ перезаписується з тіла запиту");
  assert.equal(res.body.worker.workerCode, "00042");

  const after = (await db.select().from(workersTable)).length;
  assert.equal(after, before, "жодного нового рядка в workers");

  const [updated] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(updated!.firstName, "Piotr", "firstName був null — заповнюється з тіла");
  assert.equal(updated!.lastName, "Zima", "lastName був null — заповнюється з тіла");
  assert.equal(updated!.birthDate, "1995-05-05");
  assert.equal(updated!.gender, "male");

  const [doc] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.workerId, w!.id));
  assert.ok(doc, "паспорт-документ прикріплюється до ІСНУЮЧОГО працівника");

  const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, w!.id));
  assert.ok(q, "анкета створюється (upsert), якщо ще не було рядка");
});

test("POST .../confirm з anketa-токеном — firstName/lastName УЖЕ заповнені → НЕ перезаписуються", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski", firstName: "Jan", lastName: "Kowalski" }).returning({ id: workersTable.id });
  const token = await mkAnalyzedToken({ purpose: "anketa", workerId: w!.id });

  const res = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Inny", lastName: "Ktos" });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const [updated] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(updated!.firstName, "Jan", "вже було заповнено — новий скан не перетирає");
  assert.equal(updated!.lastName, "Kowalski");
});

test("POST .../confirm з anketa-токеном — UPSERT анкети, не дубль, якщо рядок уже існував", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski" }).returning({ id: workersTable.id });
  await db.insert(workerQuestionnairesTable).values({ workerId: w!.id, phone: "+48111111111" });
  const token = await mkAnalyzedToken({ purpose: "anketa", workerId: w!.id });

  const res = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Jan", lastName: "Kowalski" });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const rows = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, w!.id));
  assert.equal(rows.length, 1, "жодного дубля рядка анкети");
  assert.equal(rows[0]!.phone, "+48111111111", "поле, не зачеплене confirm(), лишається як було");
});

// ── candidateId на токені — рекрутинг (§POST /candidates/:id/convert) ──────
test("POST .../confirm з candidateId на токені — прив'язує кандидата (workerId+stage) після сканування", opts, async () => {
  const { adminId } = await seedAdmin({ role: "owner" });
  const [c] = await db.insert(candidatesTable).values({ fullName: "Anna Nowak", stage: "interview" }).returning({ id: candidatesTable.id });
  const token = await mkAnalyzedToken({ purpose: "office", createdBy: adminId, candidateId: c!.id });

  const res = await request(app).post(`/api/passport-scan/${token}/confirm`).set(H).send({ ...PASSPORT_OK, firstName: "Anna", lastName: "Nowak" });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const [candidate] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, c!.id));
  assert.equal(candidate!.workerId, res.body.worker.id);
  assert.equal(candidate!.stage, "hired");
});
