// Зголошення нового працівника (services/hireRegistration.ts): імпорт підписаної умови →
// задача виконавцю ZUS; студент до 26 → варіант «лише Gratyfikant» без ZUS; внесення ZUA
// через API → задача закривається одразу (documentEvents); нічний синк не плодить дублів.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, factoriesTable, companiesTable, documentTypesTable, tasksTable } from "../test/harness.ts";
import { ensureUploadDirs } from "../lib/uploads.ts";
import { startHireRegistrationFlow, openHireTasksStillPending, resolveHireTasksNow, HIRE_SOURCE } from "./hireRegistration.ts";
import { workerDocumentsTable, contractsTable, taskAutoRulesTable } from "../test/harness.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");

let owner = "";
beforeEach(async () => { if (!hasTestDb) return; await resetDb(); ensureUploadDirs(); owner = (await seedAdmin({ role: "owner", isMain: true })).cookie; });
after(async () => { if (hasTestDb) await closeDb(); });

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const hireTasks = (workerId: number) => db.select().from(tasksTable).where(and(eq(tasksTable.source, HIRE_SOURCE), eq(tasksTable.workerId, workerId)));

async function importContract(workerId: number, factoryId: number, companyId: number) {
  const r = await request(app).post(`/api/workers/${workerId}/contracts/import`).set("Cookie", owner).set(H)
    .field("factoryId", String(factoryId)).field("companyId", String(companyId)).field("dateFrom", "2026-10-05").attach("file", PDF, "umowa.pdf");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await wait(300); // хук best-effort, після відповіді
  return r.body.id as number;
}

test("підписана умова → задача «зголосити» з ZUA; ZUA в профілі закриває її одразу; синк без дублів", opts, async () => {
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "LST", companyId: co!.id }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Erik A", factoryId: fa!.id, companyId: co!.id, isActive: true, nationality: "ukraine", birthDate: "1990-05-05" }).returning();
  const [zua] = await db.insert(documentTypesTable).values({ code: "zus_zua", name: "ZUS ZUA", required: false, hasExpiry: false }).returning();

  const contractId = await importContract(w!.id, fa!.id, co!.id);
  let tasks = await hireTasks(w!.id);
  assert.equal(tasks.length, 1, "одна задача на працівник×фірма");
  const t = tasks[0]!;
  assert.match(t.title, /Зголосити нового працівника \(ZUS ZUA, ES\)/);
  assert.equal(t.status, "open"); assert.equal(t.contractId, contractId); assert.equal(t.sourceKey, `hire:${w!.id}:${co!.id}`);
  const p = t.autoParams as Record<string, unknown>;
  assert.equal(p.companyId, co!.id); assert.equal(p.student26, false); assert.equal(p.docTypeCode, "zus_zua");
  const steps = (t.checklist as { text: string; auto?: string }[]).map(s => s.text);
  assert.ok(steps.some(s => /Зголосити до ZUS \(ZUA, ES\)/.test(s)), steps.join(" | "));
  assert.ok(steps.some(s => /Gratyfikant/.test(s)));
  assert.ok((t.checklist as { auto?: string }[]).some(s => s.auto === "entered"));

  // повторний виклик по тій самій умові — дубля нема; нічний синк тримає задачу відкритою
  assert.equal(await startHireRegistrationFlow([contractId], null), 0);
  assert.equal((await openHireTasksStillPending()).length, 1);

  // ZUA внесено (API → documentChanged → resolveHireTasksNow) → auto_resolved
  const d = await request(app).post(`/api/workers/${w!.id}/documents`).set("Cookie", owner).set(H).send({ docTypeId: zua!.id, issuedAt: "2026-10-06" });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  tasks = await hireTasks(w!.id);
  assert.equal(tasks[0]!.status, "auto_resolved", "ZUA в профілі закриває задачу");
  assert.match(tasks[0]!.resolutionNote ?? "", /ZUA/);
  assert.equal((await openHireTasksStillPending()).length, 0);
});

test("студент до 26 → задача «лише Gratyfikant», без кроку ZUS і без авто-закриття документом", opts, async () => {
  const [co] = await db.insert(companiesTable).values({ name: "ESO" }).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "Andros", companyId: co!.id }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Stud B", factoryId: fa!.id, companyId: co!.id, isActive: true, nationality: "ukraine", isStudent: true, birthDate: "2004-01-15" }).returning();
  const [zua] = await db.insert(documentTypesTable).values({ code: "zus_zua", name: "ZUS ZUA", required: false, hasExpiry: false }).returning();

  await importContract(w!.id, fa!.id, co!.id);
  const [t] = await hireTasks(w!.id);
  assert.ok(t, "задача створена");
  assert.match(t!.title, /студент до 26, лише Gratyfikant \(ESO\)/);
  const p = t!.autoParams as Record<string, unknown>;
  assert.equal(p.student26, true); assert.equal(p.docTypeCode, undefined);
  const steps = (t!.checklist as { text: string; auto?: string }[]);
  assert.ok(steps.some(s => /до ZUS НЕ зголошувати/.test(s.text)));
  assert.ok(!steps.some(s => /Зголосити до ZUS/.test(s.text)));
  assert.ok(!steps.some(s => s.auto), "без auto-кроку — закриває офіс вручну");
  assert.match(t!.description ?? "", /Студент до 26: ТАК/);

  // документ ZUA студенту задачу не закриває (вона про Gratyfikant)
  await request(app).post(`/api/workers/${w!.id}/documents`).set("Cookie", owner).set(H).send({ docTypeId: zua!.id, issuedAt: "2026-10-06" });
  assert.equal((await hireTasks(w!.id))[0]!.status, "open");
  assert.equal((await openHireTasksStillPending()).length, 1);
});

test("ZUA цієї фірми вже в профілі до підпису → крок «перевірити», без повторної подачі", opts, async () => {
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "LST", companyId: co!.id }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Old C", factoryId: fa!.id, companyId: co!.id, isActive: true, nationality: "ukraine", birthDate: "1988-02-02" }).returning();
  const [zua] = await db.insert(documentTypesTable).values({ code: "zus_zua", name: "ZUS ZUA", required: false, hasExpiry: false }).returning();
  await request(app).post(`/api/workers/${w!.id}/documents`).set("Cookie", owner).set(H).send({ docTypeId: zua!.id, issuedAt: "2026-01-10" });

  await importContract(w!.id, fa!.id, co!.id);
  const [t] = await hireTasks(w!.id);
  assert.ok(t);
  const steps = (t!.checklist as { text: string; auto?: string }[]);
  assert.ok(steps.some(s => /ZUA вже в профілі \(10\.01\.2026\)/.test(s.text)), steps.map(s => s.text).join(" | "));
  assert.ok(!steps.some(s => s.auto));
  assert.equal((t!.autoParams as Record<string, unknown>).docTypeCode, undefined);
});

test("ревʼю codex: missing-рядок ZUA, заповнений після задачі, закриває її; вимкнене правило — без задачі; скасована умова A при чинній B — задача лишається", opts, async () => {
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "LST", companyId: co!.id }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Miss D", factoryId: fa!.id, companyId: co!.id, isActive: true, nationality: "ukraine", birthDate: "1991-03-03" }).returning();
  const [zua] = await db.insert(documentTypesTable).values({ code: "zus_zua", name: "ZUS ZUA", required: false, hasExpiry: false }).returning();
  // запрошений раніше порожній рядок (missing) — створений ДО задачі
  const [miss] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: zua!.id, title: "ZUS ZUA", status: "missing" }).returning();
  await wait(50);
  const a = await importContract(w!.id, fa!.id, co!.id);
  const b = await importContract(w!.id, fa!.id, co!.id);
  let tasks = await hireTasks(w!.id);
  assert.equal(tasks.length, 1, "дві умови однієї фірми — одна задача"); assert.equal(tasks[0]!.contractId, a);
  // умову A скасовано → задача перепривʼязується до чинної B, не закривається
  await db.update(contractsTable).set({ status: "cancelled" }).where(eq(contractsTable.id, a));
  const pending = await openHireTasksStillPending();
  assert.equal(pending.length, 1); assert.equal((await hireTasks(w!.id))[0]!.contractId, b);
  // missing-рядок заповнили після задачі → закривається (критерій без часових міток)
  await db.update(workerDocumentsTable).set({ status: "present", issuedAt: "2026-10-07", updatedAt: new Date() }).where(eq(workerDocumentsTable.id, miss!.id));
  assert.equal(await resolveHireTasksNow(w!.id), 1);
  assert.equal((await hireTasks(w!.id))[0]!.status, "auto_resolved");
  // закрита задача звільняє ключ: нова умова → нова задача з тим самим ключем
  const c = await importContract(w!.id, fa!.id, co!.id);
  tasks = await hireTasks(w!.id);
  assert.equal(tasks.length, 2); assert.equal(tasks.find(t => t.status === "open")?.contractId, c);
  assert.equal(tasks.find(t => t.status === "open")?.sourceKey, `hire:${w!.id}:${co!.id}`);
  // вимкнене правило — задача не створюється
  await db.insert(taskAutoRulesTable).values({ code: "hire_zus", enabled: false, leadDays: 7, params: {} });
  const [w2] = await db.insert(workersTable).values({ fullName: "Off E", factoryId: fa!.id, companyId: co!.id, isActive: true, nationality: "ukraine", birthDate: "1991-03-03" }).returning();
  await importContract(w2!.id, fa!.id, co!.id);
  assert.equal((await hireTasks(w2!.id)).length, 0);
});
