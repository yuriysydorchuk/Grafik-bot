// ZUS ZCNA (рішення власника 10.09.2026): запрошення → публічна анкета (валідація, заміна списку) →
// генерація документа (печатка, sent, маркери) + задача виконавцю ZUS → задача живе, поки нема
// підтвердження zus_zcna, внесеного після неї → auto_resolved.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, db,
  workersTable, companiesTable, documentTemplatesTable, tasksTable, contractsTable, workerDocumentsTable, documentTypesTable, passportScanTokensTable,
} from "../test/harness.ts";
import { ensureUploadDirs } from "../lib/uploads.ts";
import { seedLegalizationCatalog } from "../services/legalizationSeed.ts";
import { closeBrowser, resolveDocumentSet } from "./contracts.ts";
import { createZcnaInvite, listFamily, generateZcnaDocument, validateMember } from "./zcna.ts";
import { runAutoTasks } from "./taskAutoRules.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });

before(() => { if (hasTestDb) ensureUploadDirs(); });
beforeEach(async () => { if (hasTestDb) { await resetDb(); await seedLegalizationCatalog(); } });
after(async () => { if (hasTestDb) { await closeBrowser(); await closeDb(); } });

const VALID = { lastName: "Kowalska", firstName: "Anna", relationCode: "01", pesel: "44051401359", sharedHousehold: true };

test("validateMember: PESEL з контрольною сумою або документ; латиниця; код спорідненості", () => {
  assert.equal(validateMember({ ...VALID }), null);
  assert.equal(validateMember({ ...VALID, pesel: "44051401358" }), "pesel");
  assert.equal(validateMember({ ...VALID, pesel: "", docKind: "2", docNumber: "AB123", birthDate: "2015-02-03" }), null);
  assert.equal(validateMember({ ...VALID, pesel: "", docKind: "", docNumber: "" }), "document");
  assert.equal(validateMember({ ...VALID, lastName: "Ковальська" }), "lastName");
  assert.equal(validateMember({ ...VALID, relationCode: "99" }), "relationCode");
  assert.equal(validateMember({ ...VALID, addressDiffers: true, city: "" }), "city");
});

test("анкета → документ на підпис + задача ZUS → підтвердження закриває задачу; zcna не в автонаборі", opts, async () => {
  const owner = await seedAdmin({ role: "owner", name: "Main", isMain: true });
  const [co] = await db.insert(companiesTable).values({ name: "ES", legalName: "Eurosupport Group Sp. z o.o.", nip: "1111111111" } as any).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Ivan Petrenko", firstName: "Ivan", lastName: "Petrenko", companyId: co!.id, isActive: true, telegramId: "555", pesel: "90010112345" } as any).returning();
  const sig = (k: string) => `<div style="width:200px;height:60px;border:1px dashed #999;">{%${k}%}</div>`;
  await db.insert(documentTemplatesTable).values([
    { kind: "zus", title: "ZUS", isBase: true, scope: "all", body: { pl: "<p>ZUS {%Imię%}</p>" } },
    { kind: "zcna", title: "ZCNA", isBase: true, scope: "all", body: { pl: `<p>ZCNA {%Nazwisko%} {%Liczba członków rodziny%}</p>{%Członkowie rodziny format:html%}${sig("Podpis odręczny pracodawcy")}${sig("Podpis odręczny pracownika")}` } },
  ]);
  assert.deepEqual((await resolveDocumentSet(w!.id, null)).map(t => t.kind), ["zus"], "zcna — подієвий, не в пакеті");

  // 1) запрошення → токен purpose=zcna; публічна анкета: невалідне → 400 з полем/індексом, валідне → список
  const inv = await createZcnaInvite(w!.id, owner.adminId);
  assert.ok(inv.token);
  const [tok] = await db.select().from(passportScanTokensTable).where(eq(passportScanTokensTable.token, inv.token));
  assert.equal(tok?.purpose, "zcna"); assert.equal(tok?.workerId, w!.id);
  const g = await request(app).get(`/api/zcna/${inv.token}`);
  assert.equal(g.status, 200); assert.equal(g.body.workerName, "Ivan Petrenko"); assert.ok(g.body.relationCodes.length >= 10);
  const bad = await request(app).post(`/api/zcna/${inv.token}`).set(H).send({ members: [VALID, { ...VALID, firstName: "", lastName: "X" }] });
  assert.equal(bad.status, 400); assert.equal(bad.body.field, "firstName"); assert.equal(bad.body.index, 1);
  const ok = await request(app).post(`/api/zcna/${inv.token}`).set(H).send({ members: [VALID, { lastName: "Kowalski", firstName: "Jan", relationCode: "11", pesel: "", docKind: "2", docNumber: "FA1", birthDate: "2018-05-06", addressDiffers: true, city: "Lublin", postalCode: "20-000" }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const fam = await listFamily(w!.id);
  assert.equal(fam.length, 2); assert.equal(fam[1]!.city, "Lublin"); assert.equal(fam[0]!.source, "worker");
  assert.equal((await request(app).get(`/api/zcna/nope`)).status, 404);

  // 2) генерація: документ sent (печатка best-effort), маркери; задача виконавцю ZUS
  const r = await generateZcnaDocument(w!.id, owner.adminId);
  const [doc] = await db.select().from(contractsTable).where(eq(contractsTable.id, r.contractId));
  assert.equal(doc!.status, "sent"); assert.equal((doc!.data as any)._zcna, "1"); assert.equal((doc!.data as any)._autoFinalize, "1");
  assert.ok(String((doc!.data as any)["Członkowie rodziny"]).includes("Kowalska"), "таблиця членів у даних документа");
  assert.ok(r.taskId);
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, r.taskId!));
  assert.equal(task!.source, "auto:zcna_file"); assert.equal(task!.sourceKey, `zcna:w${w!.id}`); assert.equal(task!.contractId, doc!.id);
  await assert.rejects(generateZcnaDocument(w!.id, owner.adminId), /уже надіслано|вже в роботі/);

  // 3) нічний прогін: задача живе (кандидат з відкритої задачі); підтвердження zus_zcna після задачі → auto_resolved
  await runAutoTasks(today);
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, task!.id)))[0]!.status, "open");
  const [ty] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.code, "zus_zcna"));
  assert.ok(ty, "тип zus_zcna у каталозі");
  await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: ty!.id, title: ty!.name, status: "present" });
  await runAutoTasks(today);
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, task!.id)))[0]!.status, "auto_resolved");
});
