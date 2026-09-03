// Анкета → профіль: поля-двійники (nationality ← citizenship MRZ, gender ← sex) підтягуються
// при збереженні/верифікації анкети; ручне значення профілю не затирається, якщо поле
// анкети не змінювали; is_student анкети НЕ синкається (payroll-інваріант).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, workerLegalityTable } from "../test/harness.ts";
import { seedLegalizationCatalog } from "../services/legalizationSeed.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); await seedLegalizationCatalog(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const H = { "X-Requested-With": "grafik" };

test("PUT questionnaire: citizenship P0L (OCR) → nationality poland, sex M → gender male; легальність перерахована", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [w] = await db.insert(workersTable).values({ fullName: "Sydorchuk Test", isActive: true }).returning();
  const r = await request(app).put(`/api/workers/${w!.id}/questionnaire`).set("Cookie", owner.cookie).set(H).send({ citizenship: "P0L", sex: "M" });
  assert.equal(r.status, 200);
  const [after1] = await db.select({ nationality: workersTable.nationality, gender: workersTable.gender, isStudent: workersTable.isStudent }).from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(after1?.nationality, "poland"); assert.equal(after1?.gender, "male");
  const [lg] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, w!.id));
  assert.equal(lg?.overall, "legal", "громадянин PL → легально одразу після збереження анкети");

  // ручна правка профілю живе, поки саме це поле анкети не змінили
  await db.update(workersTable).set({ nationality: "ukraine" }).where(eq(workersTable.id, w!.id));
  await request(app).put(`/api/workers/${w!.id}/questionnaire`).set("Cookie", owner.cookie).set(H).send({ birthPlace: "Lublin" });
  const [after2] = await db.select({ nationality: workersTable.nationality }).from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(after2?.nationality, "ukraine", "збереження інших полів анкети не затирає ручну національність");
  await request(app).put(`/api/workers/${w!.id}/questionnaire`).set("Cookie", owner.cookie).set(H).send({ citizenship: "UKR" });
  const [after3] = await db.select({ nationality: workersTable.nationality }).from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(after3?.nationality, "ukraine");
  await request(app).put(`/api/workers/${w!.id}/questionnaire`).set("Cookie", owner.cookie).set(H).send({ citizenship: "POL" });
  const [after4] = await db.select({ nationality: workersTable.nationality }).from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(after4?.nationality, "poland", "явна зміна громадянства в анкеті виграє");

  // номер і строк паспорта з анкети → рядок документа «Paszport»
  const { documentTypesTable, workerDocumentsTable } = await import("../test/harness.ts");
  const [pt] = await db.select({ id: documentTypesTable.id }).from(documentTypesTable).where(eq(documentTypesTable.code, "passport"));
  const [pdoc] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: pt!.id, title: "Paszport", status: "present" }).returning();
  await request(app).put(`/api/workers/${w!.id}/questionnaire`).set("Cookie", owner.cookie).set(H).send({ passportNumber: "FE1234567", passportExpiresAt: "2033-05-11" });
  const [pAfter] = await db.select({ number: workerDocumentsTable.number, expiresAt: workerDocumentsTable.expiresAt }).from(workerDocumentsTable).where(eq(workerDocumentsTable.id, pdoc!.id));
  assert.equal(pAfter?.number, "FE1234567"); assert.equal(pAfter?.expiresAt, "2033-05-11");

  // isStudent анкети не чіпає payroll-поле профілю
  await request(app).put(`/api/workers/${w!.id}/questionnaire`).set("Cookie", owner.cookie).set(H).send({ isStudent: true });
  const [after5] = await db.select({ isStudent: workersTable.isStudent }).from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(after5?.isStudent, false);
});
