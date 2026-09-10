// Нотатка власника 10.09.2026: (1) wniosek chorobowe — у сталому пакеті лише за прапорцем анкети;
// подієві kind-и (zaświadczenie/wypowiedzenie/świadectwo) в автонабір не входять;
// (2) кінець умови → zaświadczenie з печаткою (approved) + задача «на підпис», один раз на умову.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  hasTestDb, resetDb, closeDb, seedAdmin, db,
  workersTable, factoriesTable, companiesTable, workerQuestionnairesTable, contractsTable, contractFilesTable, documentTemplatesTable, tasksTable,
} from "../test/harness.ts";
import { ensureUploadDirs } from "../lib/uploads.ts";
import { closeBrowser, resolveDocumentSet } from "./contracts.ts";
import { generateContractEndCertificates } from "./contractEndDocs.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

before(() => { if (hasTestDb) ensureUploadDirs(); });
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) { await closeBrowser(); await closeDb(); } });

async function seedTemplates() {
  const sig = (k: string) => `<div style="width:200px;height:60px;border:1px dashed #999;">{%${k}%}</div>`;
  const rows = await db.insert(documentTemplatesTable).values([
    { kind: "zus", title: "ZUS", isBase: true, scope: "all", body: { pl: "<p>ZUS {%Imię%}</p>" } },
    { kind: "wniosek_chorobowe", title: "Chorobowe", isBase: true, scope: "all", body: { pl: `<p>Chorobowe {%Imię%} od {%Data rozpoczęcia pracy%}</p>${sig("Podpis odręczny pracownika")}` } },
    { kind: "zaswiadczenie", title: "Zaświadczenie", isBase: true, scope: "all", body: { pl: `<p>Zaświadczenie {%Nazwisko%} {%Imię%} {%Data rozpoczęcia pracy%}–{%Data zakończenia pracy%} {%Nazwa firmy%}</p>${sig("Podpis odręczny pracodawcy")}${sig("Podpis odręczny pracownika")}` } },
    { kind: "swiadectwo", title: "Świadectwo", isBase: true, scope: "all", body: { pl: "<p>Świadectwo {%Imię%}</p>" } },
  ]).returning({ id: documentTemplatesTable.id, kind: documentTemplatesTable.kind });
  return Object.fromEntries(rows.map(r => [r.kind, r.id]));
}

test("сталий пакет: chorobowe лише за прапорцем анкети; подієві шаблони в автонабір не входять", opts, async () => {
  await seedTemplates();
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski", companyId: co!.id, isActive: true }).returning();
  const kinds = async () => (await resolveDocumentSet(w!.id, null)).map(t => t.kind).sort();
  assert.deepEqual(await kinds(), ["zus"], "без анкети — лише базові; ні chorobowe, ні свідоцтв");
  await db.insert(workerQuestionnairesTable).values({ workerId: w!.id, status: "verified", ankietaSkladkaChorobowa: true } as any);
  assert.deepEqual(await kinds(), ["wniosek_chorobowe", "zus"], "прапорець chorobowe → wniosek у пакеті");
  await db.update(workerQuestionnairesTable).set({ ankietaSkladkaChorobowa: false } as any).where(eq(workerQuestionnairesTable.workerId, w!.id));
  assert.deepEqual(await kinds(), ["zus"]);
});

test("кінець умови → zaświadczenie (approved, печатка best-effort) + задача «на підпис»; повторний прогін — нічого; подієві умови не породжують нових", opts, async () => {
  const tpl = await seedTemplates();
  await seedAdmin({ role: "owner", name: "Main", isMain: true });
  const [co] = await db.insert(companiesTable).values({ name: "ESO", legalName: "Euro Support Outsourcing Sp. z o.o." } as any).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "LST", companyId: co!.id }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Erik Abovyan", firstName: "Erik", lastName: "Abovyan", factoryId: fa!.id, companyId: co!.id, isActive: true } as any).returning();
  // умова закінчилась учора; друга — ще чинна (не має породити документ)
  const [ended] = await db.insert(contractsTable).values({ workerId: w!.id, factoryId: fa!.id, companyId: co!.id, status: "signed", dateFrom: addDays(today, -200), dateTo: addDays(today, -1), data: {} }).returning();
  await db.insert(contractsTable).values({ workerId: w!.id, factoryId: fa!.id, companyId: co!.id, status: "signed", dateFrom: today, dateTo: addDays(today, 100), data: {} });

  const r1 = await generateContractEndCertificates(today);
  assert.equal(r1.created, 1, JSON.stringify(r1));
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.sourceKey, `zasw:${ended!.id}`));
  assert.ok(task, "задача на підпис"); assert.equal(task!.source, "auto:termination_doc"); assert.equal((task!.autoParams as any).signRequired, true);
  const [doc] = await db.select().from(contractsTable).where(eq(contractsTable.id, task!.contractId!));
  assert.equal(doc!.status, "approved", "печатка фірми ставиться одразу → approved (готово до відправки)");
  assert.equal((doc!.data as any)._forContractId, String(ended!.id)); assert.equal((doc!.data as any)._autoFinalize, "1");
  assert.equal(doc!.dateFrom, ended!.dateFrom); assert.equal(doc!.dateTo, ended!.dateTo);
  const files = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, doc!.id));
  assert.equal(files.length, 1); assert.equal(files[0]!.templateId, tpl.zaswiadczenie); assert.ok(files[0]!.unsignedPath);

  // ідемпотентно: та сама умова вдруге не породжує документ; сам подієвий документ (dateTo в минулому,
  // після підпису став би signed) — теж ні
  await db.update(contractsTable).set({ status: "signed" }).where(eq(contractsTable.id, doc!.id));
  const r2 = await generateContractEndCertificates(today);
  assert.equal(r2.created, 0, JSON.stringify(r2));
  assert.equal((await db.select().from(contractsTable).where(and(eq(contractsTable.workerId, w!.id)))).length, 3);
});
