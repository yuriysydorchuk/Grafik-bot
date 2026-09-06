// Модуль «Задачі» наскрізь: API (створення/статуси/контроль автора/групова/зустріч/
// права), генератор автозадач (документ спливає → задача відповідальному фабрики →
// заміна документа → auto_resolved → повернення причини → reopen), нагадування.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, seedRole, db,
  adminsTable, workersTable, factoriesTable, companiesTable, documentTypesTable, workerDocumentsTable,
  tasksTable, taskAssigneesTable, taskEventsTable, taskAutoRulesTable,
} from "../test/harness.ts";
import { seedLegalizationCatalog } from "../services/legalizationSeed.ts";
import { runAutoTasks, sendReminders } from "../services/taskAutoRules.ts";
import { rolloverPlanned } from "../services/tasks.ts";
import { addDaysStr } from "../lib/dates.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); await seedLegalizationCatalog(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const H = { "X-Requested-With": "grafik" };
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });

test("звичайна задача: створити колезі → в роботу → контроль автора (review) → прийняти; журнал і права", opts, async () => {
  await seedRole("office", ["editData"], ["/workers", "/tasks"]);
  const author = await seedAdmin({ role: "office", name: "Author" });
  const doer = await seedAdmin({ role: "office", name: "Doer" });
  const other = await seedAdmin({ role: "office", name: "Other" });
  const c = await request(app).post("/api/tasks").set("Cookie", author.cookie).set(H)
    .send({ title: "Замовити спецодяг", assigneeAdminId: doer.adminId, dueAt: addDaysStr(today, 3), priority: "high", reviewRequired: true, checklist: ["порахувати", "замовити"] });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.id;
  assert.equal(c.body.assigneeName, "Doer"); assert.equal(c.body.checklistTotal, 2);

  // чужий не може перепризначити, виконавець — так само ні; автор може
  assert.equal((await request(app).patch(`/api/tasks/${id}`).set("Cookie", other.cookie).set(H).send({ assigneeAdminId: other.adminId })).status, 403);
  assert.equal((await request(app).patch(`/api/tasks/${id}`).set("Cookie", doer.cookie).set(H).send({ assigneeAdminId: other.adminId })).status, 403);

  // «Мої» у виконавця містить задачу, у чужого — ні
  const mine = await request(app).get("/api/tasks?scope=mine").set("Cookie", doer.cookie);
  assert.equal(mine.body.length, 1);
  assert.equal((await request(app).get("/api/tasks?scope=mine").set("Cookie", other.cookie)).body.length, 0);

  const s1 = await request(app).post(`/api/tasks/${id}/status`).set("Cookie", doer.cookie).set(H).send({ status: "in_progress" });
  assert.equal(s1.body.status, "in_progress");
  const s2 = await request(app).post(`/api/tasks/${id}/status`).set("Cookie", doer.cookie).set(H).send({ status: "done", note: "замовлено" });
  assert.equal(s2.body.status, "review", "reviewRequired + виконавець ≠ автор → на перевірку");
  assert.equal((await request(app).post(`/api/tasks/${id}/status`).set("Cookie", doer.cookie).set(H).send({ status: "done" })).status, 403, "прийняти може лише автор");
  const s3 = await request(app).post(`/api/tasks/${id}/status`).set("Cookie", author.cookie).set(H).send({ status: "done" });
  assert.equal(s3.body.status, "done"); assert.ok(s3.body.completedAt);
  const d = await request(app).get(`/api/tasks/${id}`).set("Cookie", author.cookie);
  assert.ok(d.body.events.some((e: any) => e.kind === "created") && d.body.events.filter((e: any) => e.kind === "status").length === 3);
});

test("групова задача і зустріч: право tasksGroup; кожен відмічає свою частину → done; учасник відповідає на зустріч", opts, async () => {
  await seedRole("office", ["editData"], ["/tasks"]);
  await seedRole("lead", ["editData", "tasksGroup"], ["/tasks"]);
  const clerk = await seedAdmin({ role: "office", name: "Clerk" });
  const lead = await seedAdmin({ role: "lead", name: "Lead" });
  const a = await seedAdmin({ role: "office", name: "A" });
  const b = await seedAdmin({ role: "office", name: "B" });
  assert.equal((await request(app).post("/api/tasks").set("Cookie", clerk.cookie).set(H).send({ kind: "group", title: "Здати звіти", assigneeIds: [a.adminId, b.adminId] })).status, 403, "без tasksGroup групову для інших не можна");
  const g = await request(app).post("/api/tasks").set("Cookie", lead.cookie).set(H).send({ kind: "group", title: "Здати звіти", assigneeIds: [a.adminId, b.adminId], dueAt: today });
  assert.equal(g.status, 200, JSON.stringify(g.body)); assert.equal(g.body.assignees.length, 2);
  await request(app).post(`/api/tasks/${g.body.id}/respond`).set("Cookie", a.cookie).set(H).send({ status: "done" });
  let [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, g.body.id));
  assert.equal(t?.status, "open", "поки не всі");
  await request(app).post(`/api/tasks/${g.body.id}/respond`).set("Cookie", b.cookie).set(H).send({ status: "done" });
  [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, g.body.id));
  assert.equal(t?.status, "done", "усі відмітили → виконано");

  const m = await request(app).post("/api/tasks").set("Cookie", lead.cookie).set(H).send({ kind: "meeting", title: "Збори", assigneeIds: [a.adminId], dueAt: addDaysStr(today, 1), dueTime: "15:00", durationMin: 45, place: "Офіс" });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal((await request(app).post("/api/tasks").set("Cookie", lead.cookie).set(H).send({ kind: "meeting", title: "Без часу", assigneeIds: [a.adminId] })).status, 400);
  await request(app).post(`/api/tasks/${m.body.id}/respond`).set("Cookie", a.cookie).set(H).send({ status: "declined", note: "у рейсі" });
  const [pa] = await db.select().from(taskAssigneesTable).where(eq(taskAssigneesTable.taskId, m.body.id));
  assert.equal(pa?.status, "declined");
  assert.equal((await request(app).post(`/api/tasks/${m.body.id}/respond`).set("Cookie", b.cookie).set(H).send({ status: "accepted" })).status, 403, "не учасник");
  // календар команди бачить зустріч; «мій» у B — ні
  const cal = await request(app).get(`/api/tasks/calendar?from=${today}&to=${addDaysStr(today, 7)}&scope=team`).set("Cookie", b.cookie);
  assert.ok(cal.body.some((x: any) => x.id === m.body.id));
  assert.ok(!(await request(app).get(`/api/tasks/calendar?from=${today}&to=${addDaysStr(today, 7)}`).set("Cookie", b.cookie)).body.some((x: any) => x.id === m.body.id));
});

test("автозадачі: документ спливає → задача відповідальному фабрики; заміна → auto_resolved; повернення → reopen; нагадування за драбиною", opts, async () => {
  await seedRole("office", ["editData", "tasksManage"], ["/tasks"]);
  const resp = await seedAdmin({ role: "office", name: "Resp" });
  const main = await seedAdmin({ role: "owner", name: "Main", isMain: true });
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "AGRAM", companyId: co!.id, responsibleAdminId: resp.adminId }).returning();
  const [fb] = await db.insert(factoriesTable).values({ name: "NOWOPAK", companyId: co!.id }).returning(); // без відповідального → головний
  const [w1] = await db.insert(workersTable).values({ fullName: "Jan A", factoryId: fa!.id, isActive: true, nationality: "ukraine" }).returning();
  const [w2] = await db.insert(workersTable).values({ fullName: "Ola B", factoryId: fb!.id, isActive: true, nationality: "poland" }).returning();
  const [trc] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.code, "trc"));
  const [pass] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.code, "passport"));
  const [d1] = await db.insert(workerDocumentsTable).values({ workerId: w1!.id, docTypeId: trc!.id, title: "TRC", status: "present", expiresAt: addDaysStr(today, 10) }).returning();
  await db.insert(workerDocumentsTable).values({ workerId: w2!.id, docTypeId: pass!.id, title: "Paszport", status: "present", expiresAt: addDaysStr(today, -3) });
  await db.insert(workerDocumentsTable).values({ workerId: w2!.id, docTypeId: trc!.id, title: "TRC далеко", status: "present", expiresAt: addDaysStr(today, 200) });

  const s1 = await runAutoTasks(today);
  assert.ok(s1.created >= 2, JSON.stringify(s1));
  const t1 = (await db.select().from(tasksTable).where(eq(tasksTable.sourceKey, `doc:${d1!.id}`)))[0];
  assert.ok(t1); assert.equal(t1!.assigneeAdminId, resp.adminId, "відповідальний фабрики"); assert.equal(t1!.priority, "high", "10 днів → високий"); assert.equal(t1!.source, "auto:doc_expiring");
  const t2 = (await db.select().from(tasksTable).where(eq(tasksTable.workerId, w2!.id)))
    .find(t => t.source === "auto:doc_expired");
  assert.ok(t2, "прострочений паспорт"); assert.equal(t2!.assigneeAdminId, main.adminId, "без відповідального → головний"); assert.equal(t2!.priority, "urgent");
  assert.ok(!(await db.select().from(tasksTable)).some(t => t.title.includes("TRC далеко")), "далекий строк — без задачі");
  // нагадування: TRC за 10 днів → крок 14 драбини надіслано (60/30/14 ≥ 10)
  const t1b = (await db.select().from(tasksTable).where(eq(tasksTable.id, t1!.id)))[0]!;
  assert.deepEqual([...(t1b.remindersSent as number[])].sort((a, b) => b - a), [60, 30, 14]);
  const evs = await db.select().from(taskEventsTable).where(eq(taskEventsTable.taskId, t1!.id));
  assert.ok(evs.some(e => e.kind === "reminder"));

  // повторний прогін — ідемпотентний, нових нема; ближче строк → пріоритет росте
  const s2 = await runAutoTasks(today);
  assert.equal(s2.created, 0);
  const s2b = await runAutoTasks(addDaysStr(today, 5));
  assert.equal(s2b.created, 0);
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, t1!.id)))[0]?.priority, "urgent", "5 днів до строку → терміново");

  // офіс продовжив TRC (новий документ того ж типу) → стара задача auto_resolved
  await db.insert(workerDocumentsTable).values({ workerId: w1!.id, docTypeId: trc!.id, title: "TRC новий", status: "present", expiresAt: addDaysStr(today, 400) });
  const s3 = await runAutoTasks(today);
  assert.ok(s3.resolved >= 1);
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, t1!.id)))[0]?.status, "auto_resolved");
  // новий документ видалили → та сама задача оживає (reopen), не дубль
  await db.delete(workerDocumentsTable).where(eq(workerDocumentsTable.title, "TRC новий"));
  const s4 = await runAutoTasks(today);
  assert.equal(s4.reopened, 1); assert.equal(s4.created, 0);
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, t1!.id)))[0]?.status, "open");
  // закрита людиною — не воскрешається
  await db.update(tasksTable).set({ status: "done" }).where(eq(tasksTable.id, t1!.id));
  await runAutoTasks(today);
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, t1!.id)))[0]?.status, "done");

  // правило вимкнено → нових задач цього джерела нема
  await db.update(taskAutoRulesTable).set({ enabled: false }).where(eq(taskAutoRulesTable.code, "doc_expired"));
  await db.update(tasksTable).set({ status: "cancelled" }).where(eq(tasksTable.id, t2!.id));
  await db.insert(workerDocumentsTable).values({ workerId: w1!.id, docTypeId: pass!.id, title: "Paszport", status: "present", expiresAt: addDaysStr(today, -1) });
  const s5 = await runAutoTasks(today);
  assert.ok(!(await db.select().from(tasksTable)).some(t => t.source === "auto:doc_expired" && t.workerId === w1!.id), JSON.stringify(s5));

  // API налаштувань: перелік правил і settings, ескалація
  const r = await request(app).get("/api/task-auto-rules").set("Cookie", resp.cookie);
  assert.equal(r.status, 200); assert.ok(r.body.rules.length >= 10); assert.deepEqual(r.body.settings.ladder, [60, 30, 14, 7, 0]);
  const p = await request(app).patch("/api/task-auto-rules/settings").set("Cookie", resp.cookie).set(H).send({ escalationDays: 1 });
  assert.equal(p.body.escalationDays, 1);
});

test("масові випадки згортаються в одну задачу на фабрику (поріг groupAbove), малі — по одному", opts, async () => {
  const { workerLegalityTable } = await import("../test/harness.ts");
  await seedAdmin({ role: "owner", name: "Main", isMain: true });
  const [fa] = await db.insert(factoriesTable).values({ name: "SUSHI" }).returning();
  const [fb] = await db.insert(factoriesTable).values({ name: "SMALL" }).returning();
  const ws = await db.insert(workersTable).values([...Array(7)].map((_, i) => ({ fullName: `W${i}`, factoryId: fa!.id, isActive: true }))).returning();
  const small = await db.insert(workersTable).values([{ fullName: "S1", factoryId: fb!.id, isActive: true }, { fullName: "S2", factoryId: fb!.id, isActive: true }]).returning();
  for (const w of [...ws, ...small]) await db.insert(workerLegalityTable).values({ workerId: w.id, stay: "illegal", work: "illegal", overall: "illegal", reasons: [], requiredMissing: ["stay_basis"], obligations: [], computedAt: new Date() });
  const st = await runAutoTasks(today);
  const all = await db.select().from(tasksTable);
  const grouped = all.filter(t => t.sourceKey === `required_missing:factory:${fa!.id}`);
  assert.equal(grouped.length, 1, "7 випадків на SUSHI → одна задача"); assert.equal((grouped[0]!.autoParams as any).count, 7);
  assert.equal(all.filter(t => t.source === "auto:required_missing" && t.factoryId === fb!.id).length, 2, "2 випадки на SMALL — по одному");
  assert.equal(st.created, 3);
});

test("Мій день: план, перенос невиконаного, лічильники, ескалація простроченого головному", opts, async () => {
  await seedRole("office", ["editData"], ["/tasks"]);
  const me = await seedAdmin({ role: "office", name: "Me" });
  const main = await seedAdmin({ role: "owner", name: "Main", isMain: true });
  const t1 = await request(app).post("/api/tasks").set("Cookie", me.cookie).set(H).send({ title: "Сьогодні", dueAt: today, durationMin: 30 });
  const t2 = await request(app).post("/api/tasks").set("Cookie", me.cookie).set(H).send({ title: "Прострочене", dueAt: addDaysStr(today, -5) });
  const t3 = await request(app).post("/api/tasks").set("Cookie", me.cookie).set(H).send({ title: "Потім", dueAt: addDaysStr(today, 10) });
  await request(app).post(`/api/tasks/${t3.body.id}/plan`).set("Cookie", me.cookie).set(H).send({ date: today, time: "14:00" });
  const md = await request(app).get("/api/tasks/my-day").set("Cookie", me.cookie);
  assert.equal(md.status, 200);
  assert.deepEqual(md.body.overdue.map((x: any) => x.id), [t2.body.id]);
  assert.ok(md.body.today.some((x: any) => x.id === t1.body.id) && md.body.today.some((x: any) => x.id === t3.body.id), "заплановане на сьогодні теж у «сьогодні»");
  assert.equal(md.body.planned[0]?.plannedTime, "14:00");
  assert.equal(md.body.counters.overdue, 1); assert.equal(md.body.counters.today, 1);
  // перенос: план на вчора → сьогодні, лічильник
  await db.update(tasksTable).set({ plannedFor: addDaysStr(today, -1) }).where(eq(tasksTable.id, t3.body.id));
  assert.equal(await rolloverPlanned(today), 1);
  const [r3] = await db.select().from(tasksTable).where(eq(tasksTable.id, t3.body.id));
  assert.equal(r3?.rolloverCount, 1);
  // відкласти → зникає з мого дня до дати
  await request(app).post(`/api/tasks/${t1.body.id}/snooze`).set("Cookie", me.cookie).set(H).send({ days: 2 });
  const md2 = await request(app).get("/api/tasks/my-day").set("Cookie", me.cookie);
  assert.ok(!md2.body.today.some((x: any) => x.id === t1.body.id));
  // ескалація: прострочене > 3 днів → головному (escalatedAt), ручна драбина [1,0] → нагадування один раз
  const rem = await sendReminders(today);
  assert.ok(rem.escalated >= 1);
  const [r2] = await db.select().from(tasksTable).where(eq(tasksTable.id, t2.body.id));
  assert.ok(r2?.escalatedAt); assert.deepEqual(r2?.remindersSent, [1, 0]);
  void main;
  // контроль — лише tasksManage
  assert.equal((await request(app).get("/api/tasks/control").set("Cookie", me.cookie)).status, 403);
  const ctl = await request(app).get("/api/tasks/control").set("Cookie", main.cookie);
  assert.equal(ctl.status, 200); assert.ok(ctl.body.admins.some((a: any) => a.name === "Me" && a.overdue === 1));
});

test("сторінка /tasks гейтить доступ; фабрика зберігає відповідального і графікову", opts, async () => {
  await seedRole("noaccess", ["editData"], ["/workers"]);
  const x = await seedAdmin({ role: "noaccess" });
  assert.equal((await request(app).get("/api/tasks").set("Cookie", x.cookie)).status, 403);
  const owner = await seedAdmin({ role: "owner" });
  const [fa] = await db.insert(factoriesTable).values({ name: "F" }).returning();
  const p = await request(app).patch(`/api/factories/${fa!.id}`).set("Cookie", owner.cookie).set(H).send({ responsibleAdminId: owner.adminId, schedulerAdminId: x.adminId });
  assert.equal(p.status, 200);
  const [f] = await db.select().from(factoriesTable).where(eq(factoriesTable.id, fa!.id));
  assert.equal(f?.responsibleAdminId, owner.adminId); assert.equal(f?.schedulerAdminId, x.adminId);
  void adminsTable;
});
