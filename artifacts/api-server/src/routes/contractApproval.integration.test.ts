import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, db,
  workersTable, factoriesTable, companiesTable, workerQuestionnairesTable, contractsTable, contractFilesTable,
} from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { ensureUploadDirs } from "../lib/uploads.ts";
import { seedTestDocumentTemplates } from "../services/testTemplateFixtures.ts";
import { closeBrowser } from "../services/contracts.ts";

// Workflow затвердження пакета документів (§12 Етап 4 плану worker-docs-signing):
// переходи статусів (submit/approve/cancel), інбокс /contracts з фільтром,
// supersedes-прапорець на PATCH /workers/:id при зміні фабрики.
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

async function mkFactory(name = "Fabryka Testowa"): Promise<{ factoryId: number; companyId: number }> {
  const [co] = await db.insert(companiesTable).values({ name: "Euro Support", legalName: "Euro Support Sp. z o.o.", nip: "9462698100" }).returning({ id: companiesTable.id });
  const [fa] = await db.insert(factoriesTable).values({ name, address: "Poznań", companyId: co!.id }).returning({ id: factoriesTable.id });
  return { factoryId: fa!.id, companyId: co!.id };
}

async function mkVerifiedWorker(companyId: number, factoryId?: number): Promise<number> {
  const [w] = await db.insert(workersTable).values({
    fullName: "JAN KOWALSKI", pesel: "90010112345", birthDate: "1990-01-01", hourlyRate: 28.5, companyId, factoryId,
  }).returning({ id: workersTable.id });
  await db.insert(workerQuestionnairesTable).values({
    workerId: w!.id, status: "verified",
    passportNumber: "AB1234567", addressPl: "ul. Testowa 1, Warszawa",
    taxOffice: "US Poznań", nfzBranch: "Wielkopolski",
  });
  return w!.id;
}

async function generate(workerId: number, factoryId: number): Promise<number> {
  const res = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId, dateFrom: "2026-09-01" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id;
}

// Пакет можна згенерувати заздалегідь без дат (чекаємо документи) — цей
// хелпер саме для того сценарію: dateFrom НЕ передається.
async function generateWithoutDate(workerId: number, factoryId: number): Promise<number> {
  const res = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.dateFrom, null);
  return res.body.id;
}

test("submit: draft → pending_approval; повторний submit — 400", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const id = await generate(workerId, factoryId);

  const sub = await request(app).post(`/api/contracts/${id}/submit`).set("Cookie", owner).set(H);
  assert.equal(sub.status, 200);
  assert.equal(sub.body.status, "pending_approval");

  const again = await request(app).post(`/api/contracts/${id}/submit`).set("Cookie", owner).set(H);
  assert.equal(again.status, 400);
});

test("approve: працює і з draft, і з pending_approval — суто робочий статус, БЕЗ печатки компанії (та ставиться лише після підпису працівника, finalize)", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const id = await generate(workerId, factoryId);

  const approved = await request(app).post(`/api/contracts/${id}/approve`).set("Cookie", owner).set(H);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "approved");
  assert.equal(approved.body.stamp, undefined, "approve більше не накладає печатку — це /finalize, після підпису працівника");
  assert.ok(approved.body.approvedAt);

  const reapprove = await request(app).post(`/api/contracts/${id}/approve`).set("Cookie", owner).set(H);
  assert.equal(reapprove.status, 400, "з approved далі approve вже не можна");
});

test("submit/approve дозволені БЕЗ dateFrom — дозвіл на роботу часто оформлюють уже маючи підписану умову, дата відома лише постфактум", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const id = await generateWithoutDate(workerId, factoryId);

  const sub = await request(app).post(`/api/contracts/${id}/submit`).set("Cookie", owner).set(H);
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal(sub.body.status, "pending_approval");

  const appr = await request(app).post(`/api/contracts/${id}/approve`).set("Cookie", owner).set(H);
  assert.equal(appr.status, 200, JSON.stringify(appr.body));
  assert.equal(appr.body.status, "approved");
});

test("PATCH /contracts/:id/dates: draft без дати → дата з'являється, PDF-файли перегенеровано (sha256 змінюється)", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const id = await generateWithoutDate(workerId, factoryId);
  const [fileBefore] = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, id));

  const patched = await request(app).patch(`/api/contracts/${id}/dates`).set("Cookie", owner).set(H)
    .send({ dateFrom: "2026-10-01", dateTo: "2026-12-31" });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.dateFrom, "2026-10-01");
  assert.equal(patched.body.dateTo, "2026-12-31");
  assert.equal(patched.body.data["Data rozpoczęcia pracy"], "2026-10-01");

  const [fileAfter] = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, id));
  assert.notEqual(fileAfter!.unsignedSha256, fileBefore!.unsignedSha256, "файл мусить перегенеруватись під нову дату");

  // тепер дата є — submit більше не блокується
  const sub = await request(app).post(`/api/contracts/${id}/submit`).set("Cookie", owner).set(H);
  assert.equal(sub.status, 200);
});

// З f8ee0db дописані дати потрапляють у документ до підпису фірми: поза draft
// unsigned-файл перерендерюється (sha256 міняється), статус не рухається.
test("PATCH /contracts/:id/dates: поза draft (напр. pending_approval) — дописує дати в БД І перерендерює unsigned-файл (sha256 міняється), статус лишається", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const id = await generateWithoutDate(workerId, factoryId);
  await request(app).post(`/api/contracts/${id}/submit`).set("Cookie", owner).set(H);
  const [fileBefore] = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, id));

  const res = await request(app).patch(`/api/contracts/${id}/dates`).set("Cookie", owner).set(H).send({ dateFrom: "2026-10-01" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.dateFrom, "2026-10-01");
  assert.equal(res.body.status, "pending_approval", "статус не змінюється — це просто дописування дати");

  const [fileAfter] = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, id));
  assert.notEqual(fileAfter!.unsignedSha256, fileBefore!.unsignedSha256, "unsigned-файл перерендерено з новою датою (f8ee0db)");
});

test("PATCH /contracts/:id/dates: термінальний статус (cancelled) — 400", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const id = await generateWithoutDate(workerId, factoryId);
  await request(app).post(`/api/contracts/${id}/cancel`).set("Cookie", owner).set(H);

  const res = await request(app).patch(`/api/contracts/${id}/dates`).set("Cookie", owner).set(H).send({ dateFrom: "2026-10-01" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /термінальному статусі/);
});

test("cancel: нетермінальний статус → cancelled з причиною; повторний cancel — 400", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const id = await generate(workerId, factoryId);

  const cancelled = await request(app).post(`/api/contracts/${id}/cancel`).set("Cookie", owner).set(H).send({ reason: "помилка в даних" });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(cancelled.body.declineReason, "помилка в даних");

  const again = await request(app).post(`/api/contracts/${id}/cancel`).set("Cookie", owner).set(H);
  assert.equal(again.status, 400);
});

test("GET /contracts: інбокс з фільтром за статусом + workerName/factoryName", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const id = await generate(workerId, factoryId);
  await request(app).post(`/api/contracts/${id}/submit`).set("Cookie", owner).set(H);

  const pending = await request(app).get("/api/contracts?status=pending_approval").set("Cookie", owner);
  assert.equal(pending.status, 200);
  assert.equal(pending.body.length, 1);
  assert.equal(pending.body[0].workerName, "JAN KOWALSKI");
  assert.equal(pending.body[0].factoryName, "Fabryka Testowa");

  const drafts = await request(app).get("/api/contracts?status=draft").set("Cookie", owner);
  assert.equal(drafts.body.length, 0, "умова вже не в draft — не мусить світитись у цьому фільтрі");
});

test("GET /workers/:id/document-set: factoryId → факторі-пакет (umowa+regulamin), без factoryId → сталий (zus+ppk)", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);

  const factoryChecklist = await request(app).get(`/api/workers/${workerId}/document-set?factoryId=${factoryId}`).set("Cookie", owner);
  assert.equal(factoryChecklist.status, 200);
  assert.deepEqual(factoryChecklist.body.map((t: any) => t.kind).sort(), ["regulamin", "umowa"]);

  const standardChecklist = await request(app).get(`/api/workers/${workerId}/document-set`).set("Cookie", owner);
  assert.equal(standardChecklist.status, 200);
  assert.deepEqual(standardChecklist.body.map((t: any) => t.kind).sort(), ["ppk", "zus"]);
});

test("PATCH /workers/:id: supersedeContractId заповнюється лише коли на СТАРІЙ фабриці була SIGNED умова", opts, async () => {
  const { factoryId: oldFactoryId, companyId } = await mkFactory("Stara Fabryka");
  const { factoryId: newFactoryId } = await mkFactory("Nowa Fabryka");
  const workerId = await mkVerifiedWorker(companyId, oldFactoryId);

  // без жодної умови — прапорець null
  const noContract = await request(app).patch(`/api/workers/${workerId}`).set("Cookie", owner).set(H).send({ factoryId: newFactoryId });
  assert.equal(noContract.status, 200);
  assert.equal(noContract.body.supersedeContractId, null);

  // повертаємо на стару фабрику, підписуємо (напряму в БД — Етап 5 ще не готовий) умову на ній
  await request(app).patch(`/api/workers/${workerId}`).set("Cookie", owner).set(H).send({ factoryId: oldFactoryId });
  const [signed] = await db.insert(contractsTable).values({
    workerId, factoryId: oldFactoryId, status: "signed", dateFrom: "2026-01-01",
  }).returning({ id: contractsTable.id });

  const withSigned = await request(app).patch(`/api/workers/${workerId}`).set("Cookie", owner).set(H).send({ factoryId: newFactoryId });
  assert.equal(withSigned.status, 200);
  assert.equal(withSigned.body.supersedeContractId, signed!.id);
});
