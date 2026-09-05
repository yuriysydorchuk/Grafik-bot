import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { PDFDocument } from "pdf-lib";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, seedRole, db,
  workersTable, factoriesTable, companiesTable, workerQuestionnairesTable, contractFilesTable,
  documentTemplatesTable, positionsTable, factoryPositionsTable,
} from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { ensureUploadDirs } from "../lib/uploads.ts";
import { seedTestDocumentTemplates } from "../services/testTemplateFixtures.ts";
import { closeBrowser, resolveContractDuties, buildContractData } from "../services/contracts.ts";

// Генерація пакета документів з бібліотеки шаблонів (§4/§12 Етап 3 плану
// worker-docs-signing): повнота даних (анкета verified + всі плейсхолдери
// обраних шаблонів), реальний HTML→PDF раунд-тріп (Puppeteer), гейт workerDocs.
// factoryId заданий ⇒ факторі-пакет (тут: umowa+regulamin, 2 файли — тестові
// фікстури scope="all"); factoryId=null ⇒ сталий пакет (zus+ppk).
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

let owner = "";
before(() => { if (hasTestDb) ensureUploadDirs(); });
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  owner = (await seedAdmin({ role: "owner" })).cookie;
  await seedTestDocumentTemplates();
});
after(async () => { if (hasTestDb) { await closeBrowser(); await closeDb(); } });

// {%Czynności%}: посада на фабриці → поле фабрики → назва посади (рішення 05.09.2026)
test("Czynności: factory_positions.contract_duties > factories.contract_duties > назва посади; GET /contract-duties показує джерело", opts, async () => {
  const { factoryId, companyId } = await mkFactoryAndCompany();
  const workerId = await mkVerifiedWorker(companyId);
  const [pos] = await db.insert(positionsTable).values({ name: "Sortowacz" }).returning({ id: positionsTable.id });
  await db.update(workersTable).set({ positionId: pos!.id, factoryId }).where(eq(workersTable.id, workerId));

  assert.deepEqual(await resolveContractDuties(pos!.id, factoryId), { text: "Sortowacz", source: "position_name" });
  await db.update(factoriesTable).set({ contractDuties: "prace pomocnicze" }).where(eq(factoriesTable.id, factoryId));
  assert.deepEqual(await resolveContractDuties(pos!.id, factoryId), { text: "prace pomocnicze", source: "factory" });
  await db.insert(factoryPositionsTable).values({ factoryId, positionId: pos!.id, contractDuties: "sortowanie owoców" });
  assert.deepEqual(await resolveContractDuties(pos!.id, factoryId), { text: "sortowanie owoców", source: "position" });
  assert.deepEqual(await resolveContractDuties(null, null), { text: "", source: "none" });

  const data = await buildContractData(workerId, factoryId);
  assert.equal(data["Czynności"], "sortowanie owoców");
  const r = await request(app).get(`/api/workers/${workerId}/contract-duties?factoryId=${factoryId}`).set("Cookie", owner);
  assert.equal(r.status, 200); assert.equal(r.body.source, "position");

  // збереження позицій фабрики через PATCH не губить обов'язки і приймає нові
  const p = await request(app).patch(`/api/factories/${factoryId}`).set("Cookie", owner).set(H)
    .send({ positions: [{ positionId: pos!.id, contractDuties: "pakowanie" }] });
  assert.equal(p.status, 200);
  assert.deepEqual(await resolveContractDuties(pos!.id, factoryId), { text: "pakowanie", source: "position" });
});

async function mkFactoryAndCompany(): Promise<{ factoryId: number; companyId: number }> {
  const [co] = await db.insert(companiesTable).values({ name: "Euro Support", legalName: "Euro Support Sp. z o.o.", nip: "9462698100" }).returning({ id: companiesTable.id });
  const [fa] = await db.insert(factoriesTable).values({ name: "Fabryka Testowa", address: "Poznań", companyId: co!.id }).returning({ id: factoriesTable.id });
  return { factoryId: fa!.id, companyId: co!.id };
}

async function mkVerifiedWorker(companyId: number): Promise<number> {
  const [w] = await db.insert(workersTable).values({
    fullName: "JAN KOWALSKI", pesel: "90010112345", birthDate: "1990-01-01", hourlyRate: 28.5, companyId,
  }).returning({ id: workersTable.id });
  await db.insert(workerQuestionnairesTable).values({
    workerId: w!.id, status: "verified",
    passportNumber: "AB1234567", addressPl: "ul. Testowa 1, Warszawa",
    taxOffice: "US Poznań", nfzBranch: "Wielkopolski",
  });
  return w!.id;
}

test("POST /workers/:id/contracts (з factoryId): draft-пакет — umowa+regulamin, 2 файли", opts, async () => {
  const { factoryId, companyId } = await mkFactoryAndCompany();
  const workerId = await mkVerifiedWorker(companyId);

  const res = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId, dateFrom: "2026-09-01", dateTo: "2026-11-30" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "draft");
  assert.equal(res.body.workerId, workerId);
  assert.equal(res.body.data["Imię"], "JAN");
  assert.equal(res.body.data["Nazwisko"], "KOWALSKI");
  assert.equal(res.body.data["Data rozpoczęcia pracy"], "2026-09-01");

  const detail = await request(app).get(`/api/contracts/${res.body.id}`).set("Cookie", owner);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.files.length, 2, "факторі-пакет: umowa+regulamin");
  for (const f of detail.body.files) assert.ok(f.unsignedSha256, `${f.title}: має бути sha256`);
});

test("POST /workers/:id/contracts (без factoryId): сталий пакет — zus+ppk, 2 файли", opts, async () => {
  const { companyId } = await mkFactoryAndCompany();
  const workerId = await mkVerifiedWorker(companyId);

  const res = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H).send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.factoryId, null);

  const detail = await request(app).get(`/api/contracts/${res.body.id}`).set("Cookie", owner);
  assert.equal(detail.body.files.length, 2, "сталий пакет: zus+ppk");
});

test("GET /contracts/:id/files/:fileId: віддає реальний PDF (nosniff, без AcroForm-полів)", opts, async () => {
  const { factoryId, companyId } = await mkFactoryAndCompany();
  const workerId = await mkVerifiedWorker(companyId);
  const gen = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId, dateFrom: "2026-09-01" });
  const [file] = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, gen.body.id));

  const res = await request(app).get(`/api/contracts/${gen.body.id}/files/${file!.id}`).set("Cookie", owner);
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["content-type"], "application/pdf");
  assert.ok((res.body as Buffer).toString("latin1", 0, 4) === "%PDF");

  const doc = await PDFDocument.load(res.body as Buffer);
  assert.equal(doc.getForm().getFields().length, 0, "HTML→PDF рендер не створює AcroForm-полів");
});

test("генерація блокується, поки анкета не verified", opts, async () => {
  const { factoryId, companyId } = await mkFactoryAndCompany();
  const [w] = await db.insert(workersTable).values({ fullName: "W", companyId }).returning({ id: workersTable.id });
  await db.insert(workerQuestionnairesTable).values({ workerId: w!.id, status: "draft" });

  const res = await request(app).post(`/api/workers/${w!.id}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId, dateFrom: "2026-09-01" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /verified/);
});

test("генерація допускає легітимно порожні поля анкети (напр. без паспорта — лише PESEL)", opts, async () => {
  const { factoryId, companyId } = await mkFactoryAndCompany();
  const [w] = await db.insert(workersTable).values({ fullName: "W W", pesel: "1", companyId }).returning({ id: workersTable.id });
  await db.insert(workerQuestionnairesTable).values({ workerId: w!.id, status: "verified", addressPl: "x" });

  const res = await request(app).post(`/api/workers/${w!.id}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId, dateFrom: "2026-09-01" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test("генерація блокується, якщо шаблон посилається на плейсхолдер, якого buildContractData не знає", opts, async () => {
  const { factoryId, companyId } = await mkFactoryAndCompany();
  const workerId = await mkVerifiedWorker(companyId);

  const [broken] = await db.insert(documentTemplatesTable).values({
    kind: "umowa", title: "Broken template", scope: "all",
    body: { pl: "<p>{%Nieznane pole z realnego szablonu%}</p>" },
  }).returning({ id: documentTemplatesTable.id });

  const res = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId, templateIds: [broken!.id], dateFrom: "2026-09-01" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Бракує даних.*Nieznane pole z realnego szablonu/);
});

test("генерація БЕЗ dateFrom — 200, dateFrom null, «Data rozpoczęcia pracy» порожня (пакет можна готувати заздалегідь)", opts, async () => {
  const { factoryId, companyId } = await mkFactoryAndCompany();
  const workerId = await mkVerifiedWorker(companyId);

  const res = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "draft");
  assert.equal(res.body.dateFrom, null);
  assert.equal(res.body.data["Data rozpoczęcia pracy"], "");
});

test("гейт: роль без workerDocs — 403 на генерацію і перегляд", opts, async () => {
  const { factoryId, companyId } = await mkFactoryAndCompany();
  const workerId = await mkVerifiedWorker(companyId);
  await seedRole("plain3", [], ["/"]);
  const plain = (await seedAdmin({ role: "plain3" })).cookie;

  const gen = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", plain).set(H)
    .send({ factoryId, dateFrom: "2026-09-01" });
  assert.equal(gen.status, 403);

  const list = await request(app).get(`/api/workers/${workerId}/contracts`).set("Cookie", plain);
  assert.equal(list.status, 403);
});
