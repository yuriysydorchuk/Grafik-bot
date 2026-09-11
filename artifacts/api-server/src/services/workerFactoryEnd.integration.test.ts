// Виповідзення ПО ФАБРИЦІ (11.09.2026): людина йде з однієї фабрики/фірми, на решті лишається.
// Закриваються лише умови/графік/worker_factories цієї фабрики; документи (zaświadczenie +
// wypowiedzenie) — лише по її умовах; ZUS ZWUA — по фірмі й лише якщо чинної умови з нею не лишилось;
// contract_end мовчить (маркер _endedAtFactory); з основної — основною стає додаткова; остання → fireWorker.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  hasTestDb, resetDb, closeDb, seedAdmin, db, app,
  workersTable, factoriesTable, companiesTable, contractsTable, documentTemplatesTable, tasksTable, workerChangesTable, scheduleWeeksTable, scheduleEntriesTable,
} from "../test/harness.ts";
import { workerFactoriesTable } from "@workspace/db";
import { ensureUploadDirs } from "../lib/uploads.ts";
import { closeBrowser } from "./contracts.ts";
import { collectContractEndCandidates } from "./contractEndDocs.ts";
import { endWorkerAtFactory, setTerminationDate, fireDueTerminations, liveFactoriesOf } from "./workerFire.ts";
import { ensureAutoRules } from "./taskAutoRules.ts";
import { addDaysStr } from "../lib/dates.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const H = { "X-Requested-With": "grafik" };
const mondayOf = (d: string) => { const x = new Date(`${d}T12:00:00Z`); const wd = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - wd); return x.toISOString().slice(0, 10); };
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const dayOf = (d: string) => DAYS[((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7)]!;

before(() => { if (hasTestDb) ensureUploadDirs(); });
beforeEach(async () => { if (hasTestDb) { await resetDb(); await ensureAutoRules(); } });
after(async () => { if (hasTestDb) { await closeBrowser(); await closeDb(); } });

async function seed(sameCompany = false) {
  const sig = (k: string) => `<div style="width:200px;height:60px;border:1px dashed #999;">{%${k}%}</div>`;
  await db.insert(documentTemplatesTable).values([
    { kind: "zaswiadczenie", title: "Zaświadczenie", isBase: true, scope: "all", body: { pl: `<p>Zaświadczenie {%Nazwisko%} {%Data rozpoczęcia pracy%}–{%Data zakończenia pracy%}</p>${sig("Podpis odręczny pracownika")}` } },
    { kind: "wypowiedzenie", title: "Wypowiedzenie", isBase: true, scope: "all", body: { pl: `<p>Wypowiadam umowę z dnia {%Data zawarcia umowy%} ze skutkiem {%Data zakończenia pracy%}</p>${sig("Podpis odręczny pracownika")}` } },
  ]);
  const { cookie } = await seedAdmin({ role: "owner", name: "Main", isMain: true });
  const [es] = await db.insert(companiesTable).values({ name: "ES", legalName: "Euro Support Sp. z o.o." } as any).returning();
  const [eso] = sameCompany ? [es] : await db.insert(companiesTable).values({ name: "ESO", legalName: "Euro Support Outsourcing Sp. z o.o." } as any).returning();
  const [agram] = await db.insert(factoriesTable).values({ name: "AGRAM", companyId: es!.id, shiftCount: 2 }).returning();
  const [sushi] = await db.insert(factoriesTable).values({ name: "SUSHI", companyId: eso!.id, shiftCount: 2 }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Erik Abovyan", firstName: "Erik", lastName: "Abovyan", factoryId: agram!.id, companyId: es!.id, isActive: true } as any).returning();
  const [wf] = await db.insert(workerFactoriesTable).values({ workerId: w!.id, factoryId: sushi!.id, validFrom: addDaysStr(today, -100) }).returning();
  const from = addDaysStr(today, -200), to = addDaysStr(today, 60);
  const [cA] = await db.insert(contractsTable).values({ workerId: w!.id, factoryId: agram!.id, companyId: es!.id, status: "signed", dateFrom: from, dateTo: to, data: {} }).returning();
  const [cS] = await db.insert(contractsTable).values({ workerId: w!.id, factoryId: sushi!.id, companyId: eso!.id, status: "signed", dateFrom: from, dateTo: to, data: {} }).returning();
  // нерозісланий графік на обох фабриках після дати (той самий день — щоб не перескочити межу тижня)
  const d = addDaysStr(today, 2);
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: mondayOf(d), status: "draft" }).returning();
  await db.insert(scheduleEntriesTable).values([
    { weekId: wk!.id, workerId: w!.id, factoryId: agram!.id, dayOfWeek: dayOf(d), shift: "1", status: "scheduled" },
    { weekId: wk!.id, workerId: w!.id, factoryId: sushi!.id, dayOfWeek: dayOf(d), shift: "2", status: "scheduled" },
  ]);
  return { cookie, es: es!, eso: eso!, agram: agram!, sushi: sushi!, w: w!, wf: wf!, cA: cA!, cS: cS! };
}
const docTasks = async (workerId: number) => (await db.select().from(tasksTable)).filter(t => t.source === "auto:termination_doc" && t.workerId === workerId);
const waitFor = async (cond: () => Promise<boolean>) => { for (let i = 0; i < 80 && !(await cond()); i++) await new Promise(r => setTimeout(r, 250)); };

test("йде з додаткової фабрики: лише її умова/графік/worker_factories; документи тільки по ній; ZWUA по фірмі; contract_end мовчить; остання фабрика → звільнення", opts, async () => {
  const { cookie, w, agram, sushi, eso, wf, cA, cS } = await seed();
  assert.deepEqual((await liveFactoriesOf(w, today)).map(f => f.factoryId), [agram.id, sushi.id]);
  // API: чужа фабрика — 400
  const bad = await request(app).post(`/api/workers/${w.id}/termination`).set("Cookie", cookie).set(H).send({ date: today, factoryId: 99999 });
  assert.equal(bad.status, 400);
  // майбутня дата по фабриці — чекає крону
  const fut = addDaysStr(today, 5);
  const r0 = await setTerminationDate(w.id, fut, null, sushi.id);
  assert.ok(r0.ok && !r0.firedNow);
  let [row] = await db.select().from(workersTable).where(eq(workersTable.id, w.id));
  assert.equal(String(row?.terminationDate), fut); assert.equal(row?.terminationFactoryId, sushi.id);
  assert.equal(await fireDueTerminations(today), 0);
  // дата настала (через API) — закінчено одразу, профіль активний
  const api = await request(app).post(`/api/workers/${w.id}/termination`).set("Cookie", cookie).set(H).send({ date: today, factoryId: sushi.id });
  assert.equal(api.status, 200, JSON.stringify(api.body)); assert.equal(api.body.firedNow, true);
  [row] = await db.select().from(workersTable).where(eq(workersTable.id, w.id));
  assert.equal(row?.isActive, true); assert.equal(row?.factoryId, agram.id); assert.equal(row?.terminationDate, null); assert.equal(row?.terminationFactoryId, null);
  const [wfRow] = await db.select().from(workerFactoriesTable).where(eq(workerFactoriesTable.id, wf.id));
  assert.equal(String(wfRow?.validTo), today, "додаткова фабрика закрита датою");
  assert.deepEqual((await liveFactoriesOf(row!, today)).map(f => f.factoryId), [agram.id]);
  const [a] = await db.select().from(contractsTable).where(eq(contractsTable.id, cA.id));
  const [s] = await db.select().from(contractsTable).where(eq(contractsTable.id, cS.id));
  assert.equal(String(a?.dateTo), addDaysStr(today, 60), "умова AGRAM не чіпається");
  assert.equal(String(s?.dateTo), today); assert.equal((s?.data as any)._endedAtFactory, today);
  const entries = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.workerId, w.id));
  assert.deepEqual(entries.map(e => e.factoryId), [agram.id], "нерозісланий графік SUSHI після дати прибрано, AGRAM лишився");
  assert.ok((await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, w.id), eq(workerChangesTable.field, "factoryEnded")))).some(c => c.oldValue === String(sushi.id) && c.newValue === today));
  assert.ok(!(await collectContractEndCandidates()).some(c => c.contractId === cS.id), "умова з маркером — не кандидат contract_end");

  await waitFor(async () => (await docTasks(w.id)).length >= 2);
  const tasks = await docTasks(w.id);
  assert.deepEqual(tasks.map(t => (t.autoParams as any).docKind).sort(), ["wypowiedzenie", "zaswiadczenie"], JSON.stringify(tasks.map(t => t.title)));
  assert.ok(tasks.every(t => (t.autoParams as any).forContractId === cS.id), "документи лише по умові SUSHI");
  const zwua = (await db.select().from(tasksTable)).filter(t => t.source === "auto:termination_zus");
  assert.equal(zwua.length, 1); assert.equal(zwua[0]!.sourceKey, `zwua:${w.id}:${eso.id}`);

  // остання фабрика → звичайне звільнення
  const r2 = await endWorkerAtFactory({ workerId: w.id, factoryId: agram.id, date: today, adminId: null, source: "web" });
  assert.ok(r2.ok && r2.firedWhole);
  [row] = await db.select().from(workersTable).where(eq(workersTable.id, w.id));
  assert.equal(row?.isActive, false);
});

test("йде з ОСНОВНОЇ фабрики: основною стає додаткова (фірма фабрики, рядок worker_factories знято, її «до» → виповідзення по ній, журнал factoryId); та сама фірма на решті → ZWUA нема", opts, async () => {
  const { w, agram, sushi, es, wf, cA } = await seed(true);
  const sushiTo = addDaysStr(today, 20);
  await db.update(workerFactoriesTable).set({ validTo: sushiTo }).where(eq(workerFactoriesTable.id, wf.id));
  const r = await endWorkerAtFactory({ workerId: w.id, factoryId: agram.id, date: today, adminId: null, source: "web" });
  assert.ok(r.ok && !r.firedWhole && r.promotedFactoryId === sushi.id && r.closedContracts === 1);
  const [row] = await db.select().from(workersTable).where(eq(workersTable.id, w.id));
  assert.equal(row?.isActive, true); assert.equal(row?.factoryId, sushi.id); assert.equal(row?.companyId, es.id);
  assert.equal(String(row?.terminationDate), sushiTo, "строк «до» додаткової не губиться — стає виповідзенням по ній"); assert.equal(row?.terminationFactoryId, sushi.id);
  assert.equal((await db.select().from(workerFactoriesTable).where(eq(workerFactoriesTable.id, wf.id))).length, 0, "рядок додаткової знято — вона тепер основна");
  assert.ok((await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, w.id), eq(workerChangesTable.field, "factoryId")))).some(c => c.oldValue === String(agram.id) && c.newValue === String(sushi.id)));
  assert.equal(String((await db.select().from(contractsTable).where(eq(contractsTable.id, cA.id)))[0]?.dateTo), today);
  await waitFor(async () => (await docTasks(w.id)).length >= 2);
  assert.ok((await docTasks(w.id)).every(t => (t.autoParams as any).forContractId === cA.id));
  await new Promise(r => setTimeout(r, 500));
  assert.equal((await db.select().from(tasksTable)).filter(t => t.source === "auto:termination_zus").length, 0, "з ES ще є чинна умова на SUSHI — ZWUA не потрібна");
});

test("ZWUA: умова тієї ж фірми, що почнеться пізніше, не рахується чинною — задача ZWUA створюється", opts, async () => {
  const { w, sushi, eso, cA } = await seed();
  // ще одна умова ESO на іншій фабриці, але з майбутнім початком
  const [f3] = await db.insert(factoriesTable).values({ name: "LST", companyId: eso.id, shiftCount: 2 }).returning();
  await db.insert(workerFactoriesTable).values({ workerId: w.id, factoryId: f3!.id, validFrom: addDaysStr(today, 30) });
  await db.insert(contractsTable).values({ workerId: w.id, factoryId: f3!.id, companyId: eso.id, status: "signed", dateFrom: addDaysStr(today, 30), dateTo: null, data: {} });
  const r = await endWorkerAtFactory({ workerId: w.id, factoryId: sushi.id, date: today, adminId: null, source: "web" });
  assert.ok(r.ok && !r.firedWhole, JSON.stringify(r));
  await waitFor(async () => (await db.select().from(tasksTable)).some(t => t.source === "auto:termination_zus"));
  const zwua = (await db.select().from(tasksTable)).filter(t => t.source === "auto:termination_zus");
  assert.equal(zwua.length, 1); assert.equal(zwua[0]!.sourceKey, `zwua:${w.id}:${eso.id}`);
  assert.equal(String((await db.select().from(contractsTable).where(eq(contractsTable.id, cA.id)))[0]?.dateTo), addDaysStr(today, 60), "AGRAM не чіпається");
});
