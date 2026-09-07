// Життєвий цикл працівника (08.09.2026): перший робочий день з явки, звільнення однією
// точкою (workerFire), виповідзення (крон), ланцюжок powiadomienie UA (2 ступені) і ZWUA.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  hasTestDb, resetDb, closeDb, db, app, seedAdmin, workersTable, factoriesTable, companiesTable, workerDocumentsTable,
  workerChangesTable, scheduleWeeksTable, scheduleEntriesTable, availabilityTable, contractsTable, contractFilesTable, tasksTable, taskAutoRulesTable, workerQuestionnairesTable,
  documentTemplatesTable, signatureEventsTable,
} from "../test/harness.ts";
import { seedLegalizationCatalog } from "./legalizationSeed.ts";
import { ensureDocumentType } from "./workerDocuments.ts";
import { recomputeWorkerLegality } from "./legalityRecompute.ts";
import { fireWorker, setTerminationDate, fireDueTerminations } from "./workerFire.ts";
import { computeFirstWorkDate, ensureFirstWorkDate } from "./firstWorkDate.ts";
import { syncUaNotificationTasks, uaSend, uaCard, uaUploadConfirmation, UA_SOURCE } from "./uaNotification.ts";
import { collectCandidates, ensureAutoRules } from "./taskAutoRules.ts";
import { deliverTerminationDoc } from "./terminationFlow.ts";
import { closeBrowser } from "./contracts.ts";
import { runTaskAction } from "./taskResolve.ts";
import { sent } from "../test/botHarness.ts";
import { ensureUploadDirs } from "../lib/uploads.ts";
import { resetSent } from "../test/botHarness.ts";
import { addDaysStr } from "../lib/dates.ts";
import { dateStr } from "./taskUtils.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); await seedLegalizationCatalog(); await ensureAutoRules(); resetSent(); } });
after(async () => { if (hasTestDb) { await closeBrowser(); await closeDb(); } }); // closeBrowser — headless Chrome генерації PDF, інакше процес не завершується
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const H = { "X-Requested-With": "grafik" };
// понеділок тижня, що містить дату
const mondayOf = (d: string) => { const x = new Date(`${d}T12:00:00Z`); const wd = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - wd); return x.toISOString().slice(0, 10); };
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const dayOf = (d: string) => DAYS[((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7)]!;

test("перший робочий день: лише present у ЗАТВЕРДЖЕНОМУ тижні; ручне значення не перезаписується", opts, async () => {
  const [f] = await db.insert(factoriesTable).values({ name: "AGRAM", shiftCount: 2 }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Nowak Jan", factoryId: f!.id, isActive: true }).returning();
  const d1 = addDaysStr(today, -10), d2 = addDaysStr(today, -3);
  const [wkDraft] = await db.insert(scheduleWeeksTable).values({ weekStart: mondayOf(d1), status: "draft" }).returning();
  const [wkAppr] = await db.insert(scheduleWeeksTable).values({ weekStart: mondayOf(d2), status: "approved" }).returning();
  await db.insert(scheduleEntriesTable).values([
    { weekId: wkDraft!.id, workerId: w!.id, factoryId: f!.id, dayOfWeek: dayOf(d1), shift: "1", status: "present" },   // draft — не рахується
    { weekId: wkAppr!.id, workerId: w!.id, factoryId: f!.id, dayOfWeek: dayOf(d2), shift: "1", status: "scheduled" }, // не present
  ]);
  assert.equal(await computeFirstWorkDate(w!.id), null);
  await db.update(scheduleEntriesTable).set({ status: "present" }).where(and(eq(scheduleEntriesTable.weekId, wkAppr!.id), eq(scheduleEntriesTable.workerId, w!.id)));
  assert.equal(await ensureFirstWorkDate(w!.id), d2);
  assert.equal(String((await db.select().from(workersTable).where(eq(workersTable.id, w!.id)))[0]?.firstWorkDate), d2);
  // ручне значення лишається
  await db.update(workersTable).set({ firstWorkDate: addDaysStr(today, -20) }).where(eq(workersTable.id, w!.id));
  assert.equal(await ensureFirstWorkDate(w!.id), null);
  assert.equal(String((await db.select().from(workersTable).where(eq(workersTable.id, w!.id)))[0]?.firstWorkDate), addDaysStr(today, -20));
});

test("fireWorker: журнал, закриття умов датою, нерозісланий графік після дати, звільнений зникає з доступності; повторно — помилка", opts, async () => {
  const { cookie } = await seedAdmin();
  const [f] = await db.insert(factoriesTable).values({ name: "LST", shiftCount: 2 }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Kowal Piotr", factoryId: f!.id, isActive: true }).returning();
  await db.insert(workersTable).values({ fullName: "Active Other", factoryId: f!.id, isActive: true }); // генератор кандидатів іде лише при наявності активних
  const fireDate = addDaysStr(today, -2);
  const [c] = await db.insert(contractsTable).values({ workerId: w!.id, factoryId: f!.id, status: "signed", dateFrom: addDaysStr(today, -60), dateTo: null }).returning();
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: mondayOf(addDaysStr(today, 7)), status: "draft" }).returning();
  const nextWeekDay = addDaysStr(today, 7);
  await db.insert(scheduleEntriesTable).values([
    { weekId: wk!.id, workerId: w!.id, factoryId: f!.id, dayOfWeek: dayOf(nextWeekDay), shift: "1", status: "scheduled" },                    // нерозіслане → геть
    { weekId: wk!.id, workerId: w!.id, factoryId: f!.id, dayOfWeek: dayOf(addDaysStr(nextWeekDay, 1)), shift: "1", status: "scheduled", sentAt: new Date() }, // розіслане — лишається
  ]);
  const ws = mondayOf(today);
  await db.insert(availabilityTable).values({ workerId: w!.id, fullNameRaw: w!.fullName, source: "telegram", weekStart: ws, dayOfWeek: "mon", shift: "1", submittedAt: new Date() });

  const r = await fireWorker({ workerId: w!.id, date: fireDate, adminId: null, source: "web" });
  assert.ok(r.ok); if (!r.ok) return;
  assert.equal(r.removedEntries, 1); assert.equal(r.closedContracts, 1);
  const [w2] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(w2?.isActive, false); assert.equal(w2?.status, "fired"); assert.equal(w2?.terminationDate, null);
  assert.equal(String((await db.select().from(contractsTable).where(eq(contractsTable.id, c!.id)))[0]?.dateTo), fireDate);
  const j = await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, w!.id), eq(workerChangesTable.field, "fired")));
  assert.equal(j.length, 1); assert.equal(String(j[0]?.effectiveDate), fireDate);
  assert.equal((await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.workerId, w!.id))).length, 1);
  // доступність: звільненого в списку немає
  const av = await request(app).get(`/api/availability?weekStart=${ws}`).set("Cookie", cookie);
  assert.equal(av.status, 200);
  assert.ok(!JSON.stringify(av.body).includes("Kowal Piotr"), "звільнений не показується в доступності");
  // ZWUA-задача створена ланцюжком звільнення
  await new Promise(r => setTimeout(r, 150));
  const zw = await db.select().from(tasksTable).where(eq(tasksTable.sourceKey, `zwua:${w!.id}`));
  assert.equal(zw.length, 1); assert.equal(String(zw[0]?.dueAt), addDaysStr(fireDate, 7));
  // повторне звільнення — помилка
  const again = await fireWorker({ workerId: w!.id, adminId: null, source: "bot" });
  assert.ok(!again.ok);
  // кандидат ZWUA живе, доки нема документа; з документом — зникає (auto_resolved у прогоні)
  assert.ok((await collectCandidates(today)).some(c => c.sourceKey === `zwua:${w!.id}`));
  const ty = await ensureDocumentType("zus_zwua");
  await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: ty.id, title: ty.name, status: "present" });
  assert.ok(!(await collectCandidates(today)).some(c => c.sourceKey === `zwua:${w!.id}`));
});

test("виповідзення: майбутня дата чекає крону, дата ≤ сьогодні звільняє одразу; API /termination", opts, async () => {
  const { cookie } = await seedAdmin();
  const [w] = await db.insert(workersTable).values({ fullName: "Lis Anna", isActive: true }).returning();
  const future = addDaysStr(today, 5);
  const r1 = await setTerminationDate(w!.id, future, null);
  assert.ok(r1.ok && !r1.firedNow);
  assert.equal(String((await db.select().from(workersTable).where(eq(workersTable.id, w!.id)))[0]?.terminationDate), future);
  assert.equal(await fireDueTerminations(today), 0);
  assert.equal(await fireDueTerminations(future), 1);
  const [w2] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(w2?.isActive, false); assert.equal(w2?.terminationDate, null);
  assert.equal(dateStr(w2?.firedAt), future);

  const [w3] = await db.insert(workersTable).values({ fullName: "Bak Olga", isActive: true }).returning();
  const api = await request(app).post(`/api/workers/${w3!.id}/termination`).set("Cookie", cookie).set(H).send({ date: addDaysStr(today, -1) });
  assert.equal(api.status, 200, JSON.stringify(api.body)); assert.equal(api.body.firedNow, true);
  assert.equal((await db.select().from(workersTable).where(eq(workersTable.id, w3!.id)))[0]?.isActive, false);
  // неактивному дату не ставимо
  assert.equal((await request(app).post(`/api/workers/${w3!.id}/termination`).set("Cookie", cookie).set(H).send({ date: future })).status, 400);
});

test("powiadomienie UA: ступінь 1 на 3-й день графіковій → «вислати» → ступінь 2 → підтвердження закриває", opts, async () => {
  const { adminId: schedulerId } = await seedAdmin({ name: "Grafikowa" });
  const { adminId: vladaId, cookie } = await seedAdmin({ name: "Vlada", isMain: true });
  await db.update(taskAutoRulesTable).set({ params: { stage1Days: 3, stage2AdminId: vladaId } }).where(eq(taskAutoRulesTable.code, "ua_notification"));
  const [es] = await db.insert(companiesTable).values({ name: "ES", nip: "1111111111", regon: "222", pkd: "78.10.Z", street: "Lipowa 1", postalCode: "20-000", city: "Lublin" }).returning();
  const [f] = await db.insert(factoriesTable).values({ name: "AGRAM", shiftCount: 2, schedulerAdminId: schedulerId, companyId: es!.id, address: "Motycz 1", contractDuties: "pakowanie owoców" }).returning();
  const start = addDaysStr(today, -2); // сьогодні — 3-й день роботи
  const [w] = await db.insert(workersTable).values({ fullName: "Shevchenko Taras", nationality: "ukraine", companyId: es!.id, factoryId: f!.id, isActive: true, firstWorkDate: start, gender: "male", birthDate: "1990-05-05", notifyHours: 160 }).returning();
  const [late] = await db.insert(workersTable).values({ fullName: "Melnyk Oksana", nationality: "ukraine", companyId: es!.id, factoryId: f!.id, isActive: true, firstWorkDate: today }).returning(); // 1-й день — ще рано
  await db.insert(workerDocumentsTable).values([{ workerId: w!.id, docTypeId: (await ensureDocumentType("status_ukr")).id, title: "UKR", status: "present" }, { workerId: late!.id, docTypeId: (await ensureDocumentType("status_ukr")).id, title: "UKR", status: "present" }]);
  await db.insert(workerQuestionnairesTable).values({ workerId: w!.id, status: "verified", passportNumber: "FE123456", citizenship: "UKR", addressPl: "ul. Testowa 5, 20-001 Lublin" });
  const l = await recomputeWorkerLegality(w!.id, today); await recomputeWorkerLegality(late!.id, today);
  assert.equal(l?.obligations[0]?.dueAt, addDaysStr(start, 7), "строк від першого робочого дня");

  const s1 = await syncUaNotificationTasks(today);
  assert.equal(s1.created, 1);
  const [t1] = await db.select().from(tasksTable).where(eq(tasksTable.sourceKey, `ua1:${schedulerId}`));
  assert.ok(t1); assert.equal(t1!.assigneeAdminId, schedulerId); assert.equal(t1!.source, UA_SOURCE);
  const p1 = t1!.autoParams as any;
  assert.equal(p1.stage, 1); assert.deepEqual(p1.workers.map((x: any) => x.id), [w!.id], "Melnyk ще рано (1-й день)");
  // повторний синк не дублює
  assert.equal((await syncUaNotificationTasks(today)).created, 0);
  // per-worker obligation-задача не створюється (веде ланцюжок)
  assert.ok(!(await collectCandidates(today)).some(c => c.sourceKey === `obl:${w!.id}:obligation.ua_notification`));

  // API: контекст і дія «вислати»
  const g = await request(app).get(`/api/tasks/${t1!.id}`).set("Cookie", cookie);
  assert.equal(g.status, 200); assert.equal(g.body.resolution.context.ua.stage, 1); assert.equal(g.body.resolution.context.ua.rows[0].name, "Shevchenko Taras");
  assert.ok(g.body.resolution.actions.some((a: any) => a.code === "ua_send_all"));
  const msg = await uaSend(t1!, w!.id, { adminId: schedulerId, name: "Grafikowa" });
  assert.match(msg, /Shevchenko/);
  const [t1b] = await db.select().from(tasksTable).where(eq(tasksTable.id, t1!.id));
  assert.equal(t1b?.status, "done", "список спорожнів → готово");
  const [t2] = await db.select().from(tasksTable).where(eq(tasksTable.sourceKey, `ua2:${vladaId}`));
  assert.ok(t2); assert.equal(t2!.assigneeAdminId, vladaId); assert.equal((t2!.autoParams as any).stage, 2);
  assert.ok((t2!.autoParams as any).workers[0].sentAt);

  // картка PSZ-PPWPU
  const card = await uaCard(w!.id);
  const val = (k: string) => card.groups.flatMap(g => g.fields).find(x => x.key === k)?.value;
  assert.equal(val("nip"), "1111111111"); assert.equal(val("pkd"), "78.10.Z"); assert.equal(val("passport"), "FE123456"); assert.equal(val("sex"), "mężczyzna"); assert.equal(val("start"), start); assert.equal(val("hours"), "160");
  assert.equal(card.missing.length, 0, `бракує: ${card.missing.join(", ")}`);
  const cardApi = await request(app).get(`/api/tasks/${t2!.id}/ua-card/${w!.id}`).set("Cookie", cookie);
  assert.equal(cardApi.status, 200); assert.equal(cardApi.body.name, "Shevchenko Taras");
  assert.equal((await request(app).get(`/api/tasks/${t2!.id}/ua-card/${late!.id}`).set("Cookie", cookie)).status, 400, "не в списку");

  // ступінь 2: кроки — дані ✓, подано ○, внесено ○
  const g2 = await request(app).get(`/api/tasks/${t2!.id}`).set("Cookie", cookie);
  const row = g2.body.resolution.context.ua.rows[0];
  assert.deepEqual(row.steps, { data: true, submitted: false, entered: false });
  const sub = await request(app).post(`/api/tasks/${t2!.id}/action/ua_submitted.${w!.id}`).set("Cookie", cookie).set(H).send({});
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.ok(((await db.select().from(tasksTable).where(eq(tasksTable.id, t2!.id)))[0]?.autoParams as any).workers[0].submittedAt);

  // підтвердження → документ у профілі → перерахунок → людина зникає, задача auto_resolved
  const m2 = await uaUploadConfirmation(t2!, w!.id, { relPath: "worker-documents/x.pdf", fileName: "pow.pdf", mime: "application/pdf" }, today, { adminId: vladaId });
  assert.match(m2, /внесено/);
  const docs = await db.select().from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, w!.id), eq(workerDocumentsTable.docTypeId, (await ensureDocumentType("powiadomienie_ua")).id)));
  assert.equal(docs.length, 1); assert.equal(docs[0]?.status, "present"); assert.equal(String(docs[0]?.submittedAt), today); assert.equal(docs[0]?.employerCompanyId, es!.id);
  const [t2b] = await db.select().from(tasksTable).where(eq(tasksTable.id, t2!.id));
  assert.equal(t2b?.status, "auto_resolved");
  assert.equal((await recomputeWorkerLegality(w!.id, today))?.obligations[0]?.satisfied, true);
});

test("документ звільнення: шаблон swiadectwo → PDF без анкети, задача графіковій, «надіслати» → Telegram, статус sent, задача зникає з кандидатів", opts, async () => {
  ensureUploadDirs();
  const { adminId: schedulerId, cookie } = await seedAdmin({ name: "Grafikowa" });
  const [es] = await db.insert(companiesTable).values({ name: "ES", legalName: "Eurosupport Group Sp. z o.o.", nip: "1111111111", regon: "222", pkd: "78.10.Z", street: "Lipowa", houseNumber: "1", postalCode: "20-000", city: "Lublin", representative: "Alona Kovalchuk – Prezes" }).returning();
  const [f] = await db.insert(factoriesTable).values({ name: "AGRAM", shiftCount: 2, schedulerAdminId: schedulerId, companyId: es!.id, contractDuties: "pakowanie" }).returning();
  const html = `<div><h1>ŚWIADECTWO PRACY</h1><p>{%Imię%} {%Nazwisko%}, {%Data urodzenia data:(d.m.Y)%}</p><p>{%Nazwa firmy%} REGON {%REGON firmy%}-{%PKD firmy%}</p><p>od {%Data rozpoczęcia pracy data:(d.m.Y)%} do {%Data zakończenia pracy data:(d.m.Y)%} · {%Stanowisko%} {%Czynności%} · {%Nazwa Klienta%}</p><div style="border:1px dashed #999">{%Podpis odręczny pracodawcy%}</div></div>`;
  await db.insert(documentTemplatesTable).values({ kind: "swiadectwo", title: "Świadectwo pracy", isBase: true, scope: "all", body: { pl: html } });
  const [w] = await db.insert(workersTable).values({ fullName: "Bondar Olena", firstName: "Olena", lastName: "Bondar", factoryId: f!.id, companyId: es!.id, isActive: true, telegramId: "77900", birthDate: "1991-02-03", firstWorkDate: addDaysStr(today, -40) }).returning();
  const fireDate = addDaysStr(today, -1);
  const r = await fireWorker({ workerId: w!.id, date: fireDate, adminId: schedulerId, source: "web" });
  assert.ok(r.ok);
  // генерація йде best-effort після відповіді — дочекатись
  let task: typeof tasksTable.$inferSelect | undefined;
  for (let i = 0; i < 40 && !task; i++) { await new Promise(r => setTimeout(r, 250)); [task] = await db.select().from(tasksTable).where(eq(tasksTable.sourceKey, `termdoc:${w!.id}:${fireDate}`)); }
  assert.ok(task, "задача документа звільнення створена (анкети немає — allowUnverified)");
  assert.equal(task!.assigneeAdminId, schedulerId); assert.ok(task!.contractId);
  const [c] = await db.select().from(contractsTable).where(eq(contractsTable.id, task!.contractId!));
  assert.equal(c?.status, "draft"); assert.equal(String(c?.dateTo), fireDate); assert.equal(String(c?.dateFrom), addDaysStr(today, -40));
  assert.equal((c?.data as any)["PKD firmy"], "78.10.Z");
  const files = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, c!.id));
  assert.equal(files.length, 1); assert.ok(files[0]?.unsignedPath);
  // «Як вирішити»: переглянути PDF + надіслати
  const g = await request(app).get(`/api/tasks/${task!.id}`).set("Cookie", cookie);
  assert.equal(g.status, 200);
  assert.ok(g.body.resolution.actions.some((a: any) => a.code === "deliver_doc" && a.primary));
  assert.ok(g.body.resolution.actions.some((a: any) => a.code === "view_doc" && a.href === `/api/contracts/${c!.id}/files/${files[0]!.id}`));
  assert.ok((await collectCandidates(today)).some(x => x.sourceKey === task!.sourceKey), "поки не надіслано — кандидат живе");
  const before = sent.length;
  const msg = await runTaskAction(task!, "deliver_doc", { adminId: schedulerId, name: "Grafikowa" });
  assert.match(msg, /Telegram/);
  assert.ok(sent.length > before && sent.some(x => x.method === "sendDocument"), "файл пішов у бот");
  const [c2] = await db.select().from(contractsTable).where(eq(contractsTable.id, c!.id));
  assert.equal(c2?.status, "sent"); assert.ok(c2?.sentAt);
  assert.ok((await db.select().from(signatureEventsTable).where(eq(signatureEventsTable.contractId, c!.id))).some(e => e.event === "file_sent"));
  const [t2] = await db.select().from(tasksTable).where(eq(tasksTable.id, task!.id));
  assert.ok((t2!.checklist as any[]).find(x => x.auto === "sent")?.done, "крок «надіслати» відмічено");
  assert.ok(!(await collectCandidates(today)).some(x => x.sourceKey === task!.sourceKey), "надіслано — кандидата нема (нічний прогін закриє)");
  void deliverTerminationDoc;
});
