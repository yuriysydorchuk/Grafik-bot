// Рішення власника 10.09.2026: (1) wniosek chorobowe — у сталому пакеті лише за прапорцем анкети;
// подієві kind-и в автонабір не входять; (2) кінець умови → задача-рішення contract_end (не документ);
// (3) звільнення → zaświadczenie (з печаткою, approved) + wypowiedzenie (від працівника), якщо раніше
// кінця умови; (4) аннекс → документ на підпис, після фіналізації date_to оригіналу подовжується.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  hasTestDb, resetDb, closeDb, seedAdmin, db,
  workersTable, factoriesTable, companiesTable, workerQuestionnairesTable, contractsTable, contractFilesTable, documentTemplatesTable, tasksTable,
} from "../test/harness.ts";
import { ensureUploadDirs } from "../lib/uploads.ts";
import { closeBrowser, resolveDocumentSet, applyWorkerSignature, finalizeContractSignature } from "./contracts.ts";
import { collectContractEndCandidates, issueTerminationDocs, createContractAnnex } from "./contractEndDocs.ts";
import { runAutoTasks } from "./taskAutoRules.ts";
import { fireWorker } from "./workerFire.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const PNG_SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

before(() => { if (hasTestDb) ensureUploadDirs(); });
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) { await closeBrowser(); await closeDb(); } });

async function seedTemplates() {
  const sig = (k: string) => `<div style="width:200px;height:60px;border:1px dashed #999;">{%${k}%}</div>`;
  const rows = await db.insert(documentTemplatesTable).values([
    { kind: "zus", title: "ZUS", isBase: true, scope: "all", body: { pl: "<p>ZUS {%Imię%}</p>" } },
    { kind: "wniosek_chorobowe", title: "Chorobowe", isBase: true, scope: "all", body: { pl: `<p>Chorobowe {%Imię%} od {%Data rozpoczęcia pracy%}</p>${sig("Podpis odręczny pracownika")}` } },
    { kind: "zaswiadczenie", title: "Zaświadczenie", isBase: true, scope: "all", body: { pl: `<p>Zaświadczenie {%Nazwisko%} {%Data rozpoczęcia pracy%}–{%Data zakończenia pracy%} {%Nazwa firmy%}</p>${sig("Podpis odręczny pracodawcy")}${sig("Podpis odręczny pracownika")}` } },
    { kind: "wypowiedzenie", title: "Wypowiedzenie", isBase: true, scope: "all", body: { pl: `<p>Wypowiadam umowę z dnia {%Data zawarcia umowy%} ze skutkiem {%Data zakończenia pracy%}</p>${sig("Podpis odręczny pracownika")}` } },
    { kind: "aneks", title: "Aneks", isBase: true, scope: "all", body: { pl: `<p>Aneks do umowy z {%Data zawarcia umowy%}: do {%Poprzednia data zakończenia%} → do {%Data zakończenia pracy%}</p>${sig("Podpis odręczny pracodawcy")}${sig("Podpis odręczny pracownika")}` } },
    { kind: "swiadectwo", title: "Świadectwo", isBase: true, scope: "all", body: { pl: "<p>Świadectwo {%Imię%}</p>" } },
  ]).returning({ id: documentTemplatesTable.id, kind: documentTemplatesTable.kind });
  return Object.fromEntries(rows.map(r => [r.kind, r.id]));
}
async function seedWorker(dateTo: string | null, dateFrom = addDays(today, -200)) {
  await seedAdmin({ role: "owner", name: "Main", isMain: true });
  const [co] = await db.insert(companiesTable).values({ name: "ESO", legalName: "Euro Support Outsourcing Sp. z o.o." } as any).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "LST", companyId: co!.id }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Erik Abovyan", firstName: "Erik", lastName: "Abovyan", factoryId: fa!.id, companyId: co!.id, isActive: true } as any).returning();
  const [c] = await db.insert(contractsTable).values({ workerId: w!.id, factoryId: fa!.id, companyId: co!.id, status: "signed", dateFrom, dateTo, data: {} }).returning();
  return { co: co!, fa: fa!, w: w!, c: c! };
}

test("сталий пакет: chorobowe лише за прапорцем анкети; подієві шаблони в автонабір не входять", opts, async () => {
  await seedTemplates();
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski", companyId: co!.id, isActive: true }).returning();
  const kinds = async () => (await resolveDocumentSet(w!.id, null)).map(t => t.kind).sort();
  assert.deepEqual(await kinds(), ["zus"], "без анкети — лише базові; ні chorobowe, ні свідоцтв/аннексів");
  await db.insert(workerQuestionnairesTable).values({ workerId: w!.id, status: "verified", ankietaSkladkaChorobowa: true } as any);
  assert.deepEqual(await kinds(), ["wniosek_chorobowe", "zus"]);
});

test("кінець умови → задача contract_end графіковій (не документ); нова умова на фабрику знімає кандидата → auto_resolved", opts, async () => {
  await seedTemplates();
  const { w, fa, co, c } = await seedWorker(addDays(today, -1));
  const cand = await collectContractEndCandidates(today);
  assert.equal(cand.length, 1); assert.equal(cand[0]!.contractId, c.id);
  await runAutoTasks(today);
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.sourceKey, `contract_end:${c.id}:${c.dateTo}`));
  assert.ok(task, "задача-рішення"); assert.equal(task!.source, "auto:contract_end"); assert.equal(task!.contractId, c.id);
  assert.equal((await db.select().from(contractsTable).where(eq(contractsTable.workerId, w.id))).length, 1, "жодного документа не згенеровано");
  // нова підписана умова на ту саму фабрику → кандидат зникає → задача закривається
  await db.insert(contractsTable).values({ workerId: w.id, factoryId: fa.id, companyId: co.id, status: "signed", dateFrom: today, dateTo: addDays(today, 100), data: {} });
  assert.equal((await collectContractEndCandidates(today)).length, 0);
  await runAutoTasks(today);
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, task!.id)))[0]!.status, "auto_resolved");
});

test("звільнення раніше кінця умови → zaświadczenie (approved, з маркерами) + wypowiedzenie від працівника; повторно — нічого; świadectwo не видається", opts, async () => {
  const tpl = await seedTemplates();
  const { w, c } = await seedWorker(addDays(today, 60));
  const r = await fireWorker({ workerId: w.id, date: today, adminId: null, source: "web" });
  assert.ok(r.ok && r.closedContracts === 1);
  // ланцюжок звільнення — best-effort у фоні (import().then) → дочекатись
  const ready = async () => (await db.select().from(tasksTable)).filter(t => t.source === "auto:termination_doc" && t.contractId).length >= 2;
  for (let i = 0; i < 80 && !(await ready()); i++) await new Promise(res => setTimeout(res, 250));
  const tasks = (await db.select().from(tasksTable)).filter(t => t.source === "auto:termination_doc");
  const kinds = tasks.map(t => (t.autoParams as any).docKind).sort();
  assert.deepEqual(kinds, ["wypowiedzenie", "zaswiadczenie"], JSON.stringify(tasks.map(t => t.title)));
  assert.ok(tasks.every(t => (t.autoParams as any).signRequired === true && t.contractId));
  const docs = await db.select().from(contractsTable).where(eq(contractsTable.workerId, w.id));
  const zasw = docs.find(d => (d.data as any)._forContractId === String(c.id) && d.id === tasks.find(t => (t.autoParams as any).docKind === "zaswiadczenie")!.contractId)!;
  const wyp = docs.find(d => d.id === tasks.find(t => (t.autoParams as any).docKind === "wypowiedzenie")!.contractId)!;
  assert.equal(zasw.status, "approved"); assert.equal((zasw.data as any)._autoFinalize, "1"); assert.equal(zasw.dateTo, today, "zaświadczenie — по фактичний останній день (умову закрито датою звільнення)");
  assert.equal(wyp.status, "approved"); assert.equal(wyp.dateTo, today, "wypowiedzenie — датою звільнення"); assert.equal((wyp.data as any)["Data zawarcia umowy"], c.dateFrom);
  assert.ok(!(await db.select().from(contractFilesTable)).some(f => f.templateId === tpl.swiadectwo), "świadectwo не генерується");
  // ідемпотентно
  const again = await issueTerminationDocs({ id: w.id, fullName: w.fullName }, today, [c.id], null);
  assert.deepEqual(again, { zaswiadczenie: 0, wypowiedzenie: 0 });
});

test("аннекс: документ на підпис одразу (sent); після підпису працівника + фіналізації date_to умови подовжено; другий аннекс паралельно — 400", opts, async () => {
  await seedTemplates();
  const { w, c } = await seedWorker(addDays(today, -1));
  const newTo = addDays(today, 90);
  const annex = await createContractAnnex(c.id, newTo, null);
  assert.equal(annex.status, "sent"); assert.equal(annex.dateTo, newTo); assert.equal((annex.data as any)._extendsContractId, String(c.id));
  await assert.rejects(createContractAnnex(annex.id, addDays(today, 200), null), /підписаної умови|подієвий документ/);
  await assert.rejects(createContractAnnex(c.id, addDays(today, 120), null), /вже надіслано/);
  await assert.rejects(createContractAnnex(c.id, addDays(today, -5), null), /пізніша/);
  // працівник підписує → фінал (автофіналізацію робить routes/sign.ts; тут — напряму) → оригінал подовжено
  await applyWorkerSignature(annex.id, PNG_SIG);
  await finalizeContractSignature(annex.id, null);
  const [orig] = await db.select().from(contractsTable).where(eq(contractsTable.id, c.id));
  assert.equal(orig!.dateTo, newTo, "date_to оригінальної умови подовжено");
  assert.equal((await collectContractEndCandidates(today)).length, 0, "кандидата contract_end більше нема");
  assert.equal((await db.select().from(tasksTable)).length, 0, "жодних документних задач від аннексу");
  void w;
});
