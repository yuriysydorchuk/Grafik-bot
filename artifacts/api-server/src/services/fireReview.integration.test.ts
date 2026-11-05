// Звільнення з обліку годин — задачею графіковому (рішення власника 05.11.2026): POST /hours/fire-review
// нікого не звільняє, ховає людей з місяця й ставить групову задачу графіковому фабрики; у задачі по
// кожній людині — останній слід і дії (звільнити з дати / працює далі / відпустка); уже звільнені —
// перевірка дати (changeFireDate оновлює задачу ZWUA й перегенеровує ще не надіслані документи).
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, seedRole, db,
  workersTable, factoriesTable, companiesTable, scheduleWeeksTable, scheduleEntriesTable, factoryHoursTable, monthlyReportsTable,
  tasksTable, workerChangesTable, contractsTable, documentTemplatesTable, hoursMonthExclusionsTable,
} from "../test/harness.ts";
import { ensureUploadDirs } from "../lib/uploads.ts";
import { closeBrowser } from "./contracts.ts";
import { requestFireReview } from "./fireReview.ts";
import { fireWorker, changeFireDate } from "./workerFire.ts";
import { runAutoTasks } from "./taskAutoRules.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" };
before(() => { if (hasTestDb) ensureUploadDirs(); });
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) { await closeBrowser(); await closeDb(); } });

const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 20000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error(`не дочекались: ${what}`); await new Promise(r => setTimeout(r, 150)); }
};

test("POST /hours/fire-review: нікого не звільняє, задача графіковому, останній слід, дії по кожній людині, закриття", opts, async () => {
  const owner = await seedAdmin({ role: "owner", isMain: true, name: "Roman" });
  await seedRole("scheduler", ["editData"], ["/tasks"], ["tasks"]);
  const sched = await seedAdmin({ role: "scheduler", name: "Grafikowy" });
  const [f] = await db.insert(factoriesTable).values({ name: "SUSHI", schedulerAdminId: sched.adminId } as any).returning();
  // employmentStartDate до місяця обліку — інакше людина «приступила після місяця» і в облік не потрапляє
  const mk = async (fullName: string) => (await db.insert(workersTable).values({ fullName, factoryId: f!.id, isActive: true, employmentStartDate: "2026-08-01" } as any).returning())[0]!;
  const a = await mk("Aaa Yavka"), b = await mk("Bbb Bezslidu"), c = await mk("Ccc Raport"), d = await mk("Ddd Vidpustka");
  // A: остання явка 16.09.2026 (ср тижня 14.09) + години фабрики з днями до 12.09 → точний слід 16.09
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-09-14", status: "approved" }).returning();
  await db.insert(scheduleEntriesTable).values({ weekId: wk!.id, workerId: a.id, factoryId: f!.id, dayOfWeek: "wed", shift: "1", status: "present" } as any);
  await db.insert(factoryHoursTable).values({ workerId: a.id, month: "2026-09", factoryId: f!.id, hours: 40, days: { "2026-09-11": 8, "2026-09-12": 8 } } as any);
  // C: лише рапорт за вересень (місячний слід) + точна явка 03.09
  const [wk2] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-08-31", status: "approved" }).returning();
  await db.insert(scheduleEntriesTable).values({ weekId: wk2!.id, workerId: c.id, factoryId: f!.id, dayOfWeek: "thu", shift: "1", status: "present" } as any);
  await db.insert(monthlyReportsTable).values({ workerId: c.id, month: "2026-09", factoryId: f!.id, hoursReported: 120 });

  const send = await request(app).post("/api/hours/fire-review").set("Cookie", owner.cookie).set(H)
    .send({ month: "2026-10", items: [a, b, c, d].map(w => ({ workerId: w.id, factoryId: f!.id })) });
  assert.equal(send.status, 200, send.text);
  assert.equal(send.body.tasks.length, 1);
  const info = send.body.tasks[0];
  assert.deepEqual([info.assigneeAdminId, info.added, info.mine, info.assigneeName], [sched.adminId, 4, false, "Grafikowy"]);
  assert.equal((await db.select().from(workersTable).where(eq(workersTable.isActive, true))).length, 4, "нікого не звільнено");
  const excl = await db.select().from(hoursMonthExclusionsTable);
  assert.deepEqual(excl.map(e => e.reason).sort(), ["fire_pending", "fire_pending", "fire_pending", "fire_pending"]);
  // з місяця людей прибрано (рядків немає), у «прихованих» — з причиною
  const hrs = await request(app).get("/api/hours?month=2026-10").set("Cookie", owner.cookie);
  assert.equal(hrs.body.workers.filter((x: any) => [a.id, b.id, c.id, d.id].includes(x.workerId)).length, 0);
  assert.equal(hrs.body.excluded.filter((x: any) => x.reason === "fire_pending").length, 4);

  // повторна передача тих самих людей задачу не дублює
  const again = await request(app).post("/api/hours/fire-review").set("Cookie", owner.cookie).set(H).send({ month: "2026-10", items: [{ workerId: a.id, factoryId: f!.id }] });
  assert.deepEqual([again.body.tasks[0].taskId, again.body.tasks[0].added], [info.taskId, 0]);

  const detail = async () => (await request(app).get(`/api/tasks/${info.taskId}`).set("Cookie", sched.cookie)).body;
  let t = await detail();
  assert.equal(t.source, "auto:fire_review"); assert.equal(t.assigneeAdminId, sched.adminId); assert.equal(t.creatorAdminId, owner.adminId);
  const rows = t.resolution.context.fireReview.rows as any[];
  const rowOf = (id: number) => rows.find(r => r.id === id);
  assert.deepEqual([rowOf(a.id).last.date, rowOf(a.id).last.source, rowOf(a.id).last.exact], ["2026-09-16", "явка", true]);
  assert.equal(rowOf(b.id).last, null, "без слідів — дати немає");
  assert.deepEqual([rowOf(c.id).last.date, rowOf(c.id).last.exact, rowOf(c.id).last.lastExact.date], ["2026-09-30", false, "2026-09-03"], "рапорт — лише місяць; точна дата окремо");

  const act = (code: string, body: object = {}) => request(app).post(`/api/tasks/${info.taskId}/action/${code}`).set("Cookie", sched.cookie).set(H).send(body);
  assert.equal((await act(`fr_fire.${a.id}`)).status, 400, "без дати не звільняємо");
  assert.equal((await act(`fr_fire.${a.id}`, { date: "2999-01-01" })).status, 400, "майбутня дата");
  const fired = await act(`fr_fire.${a.id}`, { date: "2026-09-16" });
  assert.equal(fired.status, 200, fired.text);
  const [wa] = await db.select().from(workersTable).where(eq(workersTable.id, a.id));
  assert.equal(wa!.isActive, false);
  const [fj] = await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, a.id), eq(workerChangesTable.field, "fired")));
  assert.deepEqual([String(fj!.effectiveDate), fj!.adminId], ["2026-09-16", sched.adminId], "звільнено перевіреною датою, автор — графіковий");

  // ту саму людину передали ще й за листопад, поки рішення немає: рядок один, прихована в обох місяцях
  const nov = await request(app).post("/api/hours/fire-review").set("Cookie", owner.cookie).set(H).send({ month: "2026-11", items: [{ workerId: b.id, factoryId: f!.id }] });
  assert.deepEqual([nov.body.tasks[0].taskId, nov.body.tasks[0].added], [info.taskId, 0]);
  assert.deepEqual((await db.select().from(hoursMonthExclusionsTable).where(eq(hoursMonthExclusionsTable.workerId, b.id))).map(e => e.month).sort(), ["2026-10", "2026-11"]);
  assert.equal((await act(`fr_keep.${b.id}`)).status, 200);
  assert.equal((await db.select().from(hoursMonthExclusionsTable).where(eq(hoursMonthExclusionsTable.workerId, b.id))).length, 0, "«працює далі» повертає в облік обох місяців");
  assert.equal((await act(`fr_vacation.${d.id}`)).status, 200);
  assert.equal((await db.select().from(hoursMonthExclusionsTable).where(eq(hoursMonthExclusionsTable.workerId, d.id)))[0]!.reason, "vacation");
  t = await detail();
  assert.equal(t.status, "open"); assert.equal(t.resolution.context.fireReview.rows.length, 1);

  // нічний прогін задачу зі списком не закриває («причина зникла» — не про неї)
  await runAutoTasks();
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, info.taskId)))[0]!.status, "open");

  assert.equal((await act(`fr_not_started.${c.id}`)).status, 200);
  const [done] = await db.select().from(tasksTable).where(eq(tasksTable.id, info.taskId));
  assert.deepEqual([done!.status, done!.completedById], ["done", sched.adminId]);
  assert.match(done!.resolutionNote ?? "", /звільнено 1.*працюють далі 1.*відпустка \/ не приступили 2/);
  assert.equal((await act(`fr_keep.${c.id}`)).status, 400, "людини вже немає у списку");

  // нова передача після закриття — нова задача (ключ із суфіксом, unique не падає)
  const e = await mk("Eee Nova");
  const next = await request(app).post("/api/hours/fire-review").set("Cookie", owner.cookie).set(H).send({ month: "2026-10", items: [{ workerId: e.id, factoryId: f!.id }] });
  assert.equal(next.status, 200, next.text); assert.notEqual(next.body.tasks[0].taskId, info.taskId);
  // задачу закрили вручну з людиною без рішення → вона повертається в облік місяця
  const g = await mk("Ggg Rucne");
  const man = await request(app).post("/api/hours/fire-review").set("Cookie", owner.cookie).set(H).send({ month: "2026-10", items: [{ workerId: g.id, factoryId: f!.id }, { workerId: e.id, factoryId: f!.id }] });
  assert.equal(man.body.tasks[0].taskId, next.body.tasks[0].taskId, "та сама відкрита задача доповнюється"); assert.equal(man.body.tasks[0].added, 1);
  assert.equal((await request(app).post(`/api/tasks/${next.body.tasks[0].taskId}/action/fr_keep.${g.id}`).set("Cookie", sched.cookie).set(H).send({})).status, 200);
  const h = await mk("Hhh Zakryto");
  const solo = await requestFireReview({ items: [{ workerId: h.id, factoryId: f!.id }], month: "2026-10", actorAdminId: owner.adminId });
  assert.equal(solo[0]!.taskId, next.body.tasks[0].taskId);
  // людину звільнили з профілю → рядок зникає сам, порожня задача закривається
  assert.equal((await fireWorker({ workerId: e.id, date: "2026-10-02", adminId: owner.adminId, source: "web" })).ok, true);
  await runAutoTasks();
  const [afterNight] = await db.select().from(tasksTable).where(eq(tasksTable.id, next.body.tasks[0].taskId));
  assert.equal(afterNight!.status, "open", "звільненого прибрано, але в списку ще Hhh");
  assert.deepEqual((afterNight!.autoParams as any).workerIds, [h.id]);
  const closeManually = await request(app).post(`/api/tasks/${afterNight!.id}/status`).set("Cookie", sched.cookie).set(H).send({ status: "done" });
  assert.equal(closeManually.status, 200, closeManually.text);
  assert.equal((await db.select().from(hoursMonthExclusionsTable).where(eq(hoursMonthExclusionsTable.workerId, h.id))).length, 0, "ручне закриття повертає людину в облік місяця");
  assert.equal((await db.select().from(workersTable).where(eq(workersTable.id, h.id)))[0]!.isActive, true);
});

test("графіковий сам передає на звільнення → mine=true; людина на двох фабриках знімається лише з однієї", opts, async () => {
  await seedAdmin({ role: "owner", isMain: true });
  await seedRole("scheduler", ["editData"], ["/tasks"], ["tasks"]);
  const sched = await seedAdmin({ role: "scheduler", name: "Grafikowy" });
  const [f1] = await db.insert(factoriesTable).values({ name: "LST", schedulerAdminId: sched.adminId } as any).returning();
  const [f2] = await db.insert(factoriesTable).values({ name: "AGRAM" }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Dwie Fabryki", factoryId: f1!.id, isActive: true }).returning();
  const { workerFactoriesTable } = await import("@workspace/db");
  await db.insert(workerFactoriesTable).values({ workerId: w!.id, factoryId: f2!.id } as any);
  const send = await request(app).post("/api/hours/fire-review").set("Cookie", sched.cookie).set(H).send({ month: "2026-10", items: [{ workerId: w!.id, factoryId: f1!.id }] });
  assert.equal(send.status, 200, send.text);
  assert.equal(send.body.tasks[0].mine, true);
  const id = send.body.tasks[0].taskId;
  const t = (await request(app).get(`/api/tasks/${id}`).set("Cookie", sched.cookie)).body;
  assert.equal(t.resolution.context.fireReview.rows[0].otherFactories, 1);
  const r = await request(app).post(`/api/tasks/${id}/action/fr_fire.${w!.id}`).set("Cookie", sched.cookie).set(H).send({ date: "2026-09-30" });
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.message, /знято з фабрики/);
  const [ww] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.deepEqual([ww!.isActive, ww!.factoryId], [true, f2!.id], "активний, основною стала друга фабрика");
  assert.equal((await db.select().from(hoursMonthExclusionsTable).where(eq(hoursMonthExclusionsTable.workerId, w!.id))).length, 0, "активний на іншій фабриці — з місяця більше не прихований");

  // автор зі скоупом лише на AGRAM: людина з основною LST і додатковою AGRAM → задача на AGRAM, не на LST;
  // людина лише з LST — пропускається
  const [x] = await db.insert(workersTable).values({ fullName: "Skoup Dwie", factoryId: f1!.id, isActive: true }).returning();
  await db.insert(workerFactoriesTable).values({ workerId: x!.id, factoryId: f2!.id } as any);
  const [y] = await db.insert(workersTable).values({ fullName: "Skoup Obca", factoryId: f1!.id, isActive: true }).returning();
  const scoped = await requestFireReview({ items: [{ workerId: x!.id, factoryId: f1!.id }, { workerId: y!.id, factoryId: f1!.id }], month: "2026-10", actorAdminId: sched.adminId, factoryAllowed: fid => fid === f2!.id });
  assert.deepEqual(scoped.map(t => [t.factoryId, t.added]), [[f2!.id, 1]]);
  assert.equal((await db.select().from(hoursMonthExclusionsTable).where(eq(hoursMonthExclusionsTable.workerId, y!.id))).length, 0, "чужу людину не чіпаємо");

  // два одночасні передавання на ту саму фабрику → одна задача, обидві людини в списку
  const [p1] = await db.insert(workersTable).values({ fullName: "Par Odyn", factoryId: f2!.id, isActive: true }).returning();
  const [p2] = await db.insert(workersTable).values({ fullName: "Par Dva", factoryId: f2!.id, isActive: true }).returning();
  const [ra, rb] = await Promise.all([
    requestFireReview({ items: [{ workerId: p1!.id }], month: "2026-10", actorAdminId: sched.adminId }),
    requestFireReview({ items: [{ workerId: p2!.id }], month: "2026-10", actorAdminId: sched.adminId }),
  ]);
  assert.equal(ra[0]!.taskId, rb[0]!.taskId, "одна задача на фабрику");
  const [both] = await db.select().from(tasksTable).where(eq(tasksTable.id, ra[0]!.taskId));
  assert.deepEqual([...(both!.autoParams as any).workerIds].sort((m: number, n: number) => m - n), [x!.id, p1!.id, p2!.id].sort((m, n) => m - n));
});

test("перевірка дати вже звільненого: changeFireDate оновлює задачу ZWUA і перегенеровує ненадіслані документи; надіслані — у staleDocs", opts, async () => {
  const owner = await seedAdmin({ role: "owner", isMain: true, name: "Main" });
  const sig = (k: string) => `<div style="width:200px;height:60px;border:1px dashed #999;">{%${k}%}</div>`;
  await db.insert(documentTemplatesTable).values([
    { kind: "zaswiadczenie", title: "Zaświadczenie", isBase: true, scope: "all", body: { pl: `<p>Zaświadczenie {%Nazwisko%} {%Data rozpoczęcia pracy%}–{%Data zakończenia pracy%}</p>${sig("Podpis odręczny pracodawcy")}${sig("Podpis odręczny pracownika")}` } },
    { kind: "wypowiedzenie", title: "Wypowiedzenie", isBase: true, scope: "all", body: { pl: `<p>Wypowiadam umowę z dnia {%Data zawarcia umowy%} ze skutkiem {%Data zakończenia pracy%}</p>${sig("Podpis odręczny pracownika")}` } },
  ] as any);
  const [co] = await db.insert(companiesTable).values({ name: "ESO", legalName: "Euro Support Outsourcing Sp. z o.o." } as any).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "LST", companyId: co!.id }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Erik Abovyan", firstName: "Erik", lastName: "Abovyan", factoryId: fa!.id, companyId: co!.id, isActive: true } as any).returning();
  const [c] = await db.insert(contractsTable).values({ workerId: w!.id, factoryId: fa!.id, companyId: co!.id, status: "signed", dateFrom: "2026-08-01", dateTo: "2026-12-31", data: {} }).returning();

  assert.equal((await fireWorker({ workerId: w!.id, date: "2026-10-01", adminId: owner.adminId, source: "hours" })).ok, true);
  // ланцюжок звільнення асинхронний: ZWUA-задача + zaświadczenie + wypowiedzenie
  const docTasks = await waitFor(async () => {
    const ts = await db.select().from(tasksTable).where(and(eq(tasksTable.workerId, w!.id), eq(tasksTable.source, "auto:termination_doc")));
    return ts.length === 2 && ts.every(t => t.contractId != null) ? ts : null;
  }, "документи звільнення");
  const zasw = docTasks.find(t => t.sourceKey === `zaswiadczenie:${c!.id}`)!, wyp = docTasks.find(t => t.sourceKey === `wypowiedzenie:${c!.id}`)!;
  const [zwua] = await db.select().from(tasksTable).where(and(eq(tasksTable.workerId, w!.id), eq(tasksTable.source, "auto:termination_zus")));
  assert.match(zwua!.description ?? "", /Дата звільнення: 01\.10\.2026/); assert.match(zwua!.description ?? "", /ZWUA\): 02\.10\.2026/);
  // wypowiedzenie вже надіслано працівнику — його не чіпаємо
  await db.update(contractsTable).set({ status: "sent", sentAt: new Date() }).where(eq(contractsTable.id, wyp.contractId!));

  // задача «перевірити дату» для вже звільненого
  const [info] = await requestFireReview({ items: [{ workerId: w!.id }], month: null, actorAdminId: owner.adminId, check: true });
  assert.ok(info, "задача створена"); assert.equal(info!.mine, true, "фабрика без графікового → головний");
  const t = (await request(app).get(`/api/tasks/${info!.taskId}`).set("Cookie", owner.cookie)).body;
  assert.deepEqual([t.resolution.context.fireReview.rows[0].check, t.resolution.context.fireReview.rows[0].firedDate], [true, "2026-10-01"]);
  assert.match(t.title, /Перевірити дату звільнення/);

  const r = await request(app).post(`/api/tasks/${info!.taskId}/action/fr_date.${w!.id}`).set("Cookie", owner.cookie).set(H).send({ date: "2026-09-12" });
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.message, /01\.10\.2026 → 12\.09\.2026/);
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, info!.taskId)))[0]!.status, "done");

  const [c2] = await db.select().from(contractsTable).where(eq(contractsTable.id, c!.id));
  assert.equal(String(c2!.dateTo), "2026-09-12");
  const [zwua2] = await db.select().from(tasksTable).where(eq(tasksTable.id, zwua!.id));
  assert.match(zwua2!.description ?? "", /Дата звільнення: 12\.09\.2026/); assert.match(zwua2!.description ?? "", /ZWUA\): 13\.09\.2026/);
  assert.equal(String(zwua2!.dueAt), "2026-09-19"); assert.equal((zwua2!.autoParams as any).fireDate, "2026-09-12");

  const [zaswTask] = await db.select().from(tasksTable).where(eq(tasksTable.id, zasw.id));
  assert.notEqual(zaswTask!.contractId, zasw.contractId, "zaświadczenie перегенеровано — у задачі новий пакет");
  const [oldDoc] = await db.select().from(contractsTable).where(eq(contractsTable.id, zasw.contractId!));
  const [newDoc] = await db.select().from(contractsTable).where(eq(contractsTable.id, zaswTask!.contractId!));
  assert.equal(oldDoc!.status, "cancelled"); assert.deepEqual([String(newDoc!.dateTo), newDoc!.status], ["2026-09-12", "approved"]);
  const [wypDoc] = await db.select().from(contractsTable).where(eq(contractsTable.id, wyp.contractId!));
  assert.deepEqual([wypDoc!.status, String(wypDoc!.dateTo)], ["sent", "2026-10-01"], "надісланий документ лишився як був");

  // повторна зміна дати повертає надісланий документ у staleDocs
  const again = await changeFireDate(w!.id, "2026-09-10", owner.adminId);
  assert.ok(again.ok);
  if (again.ok) { assert.equal(again.docsRegenerated, 1); assert.deepEqual(again.staleDocs.map(s => [s.kind, s.status]), [["wypowiedzenie", "sent"]]); }

  // підписаний документ зі старою датою: поле dateTo не «підтягується» мовчки, документ іде у staleDocs
  const [zCur] = await db.select().from(tasksTable).where(eq(tasksTable.id, zasw.id));
  await db.update(contractsTable).set({ status: "signed" }).where(eq(contractsTable.id, zCur!.contractId!));
  const third = await changeFireDate(w!.id, "2026-09-08", owner.adminId);
  assert.ok(third.ok);
  if (third.ok) { assert.equal(third.contracts, 1, "переноситься лише сама умова"); assert.deepEqual(third.staleDocs.map(s => `${s.kind}:${s.status}`).sort(), ["wypowiedzenie:sent", "zaswiadczenie:signed"]); }
  assert.equal(String((await db.select().from(contractsTable).where(eq(contractsTable.id, zCur!.contractId!)))[0]!.dateTo), "2026-09-10", "підписаний PDF несе стару дату — і поле теж");
  // повтор з тією самою датою — без помилки, похідне перевіряється ще раз
  const same = await changeFireDate(w!.id, "2026-09-08", owner.adminId);
  assert.ok(same.ok); if (same.ok) assert.equal(same.staleDocs.length, 2);
});
