// Шаблони задач з тригерами (при реєстрації / при звільненні) + «💬 Відповісти» у боті
// (коментар до задачі текстом) + колонки «Відповідальний»/«Задача» на дашборді легалізації.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq, like } from "drizzle-orm";
import {
  hasTestDb, resetDb, closeDb, db, app, seedAdmin, seedRole, workersTable, factoriesTable, tasksTable, taskTemplatesTable, taskCommentsTable, adminsTable, workerLegalityTable,
} from "../test/harness.ts";
import { sendStart, pressButton, sendText, sent, resetSent } from "../test/botHarness.ts";
import { createTask } from "../services/tasks.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const H = { "X-Requested-With": "grafik" };

test("шаблон «при реєстрації» створює задачу з чеклістом при POST /workers; «при звільненні» — при fire; без дублів", opts, async () => {
  const main = await seedAdmin({ isMain: true });
  const resp = await seedAdmin({ role: "owner", name: "Resp" });
  const [f] = await db.insert(factoriesTable).values({ name: "AGRAM", shiftCount: 2, responsibleAdminId: resp.adminId }).returning();
  await db.insert(taskTemplatesTable).values({ name: "Онбординг", titleTemplate: "Онбординг: {worker}", checklist: ["Анкета", "Умова", "Одяг"], dueInDays: 7, trigger: "worker_created" });
  await db.insert(taskTemplatesTable).values({ name: "Звільнення", titleTemplate: "Звільнення: {worker}", checklist: ["Закрити умову"], dueInDays: 5, trigger: "worker_fired", reviewRequired: true, defaultAssigneeAdminId: main.adminId });
  await db.insert(taskTemplatesTable).values({ name: "Вимкнений", titleTemplate: "X {worker}", trigger: "worker_created", isActive: false });

  const r = await request(app).post("/api/workers").set("Cookie", main.cookie).set(H).send({ fullName: "Ivan Kovalenko", factoryId: f!.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await new Promise(res => setTimeout(res, 300)); // тригер best-effort у фоні
  const created = await db.select().from(tasksTable).where(like(tasksTable.source, "template"));
  assert.equal(created.length, 1, "лише активний шаблон");
  assert.equal(created[0]!.title, "Онбординг: Ivan Kovalenko"); assert.equal(created[0]!.checklist.length, 3);
  assert.equal(created[0]!.assigneeAdminId, resp.adminId, "виконавець — відповідальний фабрики");
  assert.equal(created[0]!.workerId, r.body.id);

  const fire = await request(app).post(`/api/workers/${r.body.id}/fire`).set("Cookie", main.cookie).set(H).send({});
  assert.equal(fire.status, 200, JSON.stringify(fire.body));
  await new Promise(res => setTimeout(res, 300));
  const all = await db.select().from(tasksTable).where(like(tasksTable.source, "template"));
  const fired = all.find(t => t.title.startsWith("Звільнення:"));
  assert.ok(fired); assert.equal(fired!.assigneeAdminId, main.adminId, "дефолт шаблону"); assert.equal(fired!.reviewRequired, true);
  // повторний тригер не дублює
  const { applyTemplateTriggers } = await import("../services/tasks.ts");
  assert.equal(await applyTemplateTriggers("worker_fired", { id: r.body.id, fullName: "Ivan Kovalenko", factoryId: f!.id }), 0);
});

test("бот «💬 Відповісти» під сповіщенням: наступний текст стає коментарем до задачі", opts, async () => {
  await seedRole("office", ["editData"], ["/tasks"], ["tasks"]);
  const [a] = await db.insert(adminsTable).values({ name: "Office", role: "office", telegramId: "820100" }).returning();
  const [b] = await db.insert(adminsTable).values({ name: "Boss", role: "office", telegramId: "820200" }).returning();
  await sendStart("820100");
  resetSent();
  const t = await createTask({ title: "Замовити одяг", assigneeAdminId: a!.id }, b!.id);
  const n = sent.find(s => String(s.chatId) === "820100");
  const kb = (n!.extra.reply_markup.inline_keyboard as any[]).flat().map(x => x.callback_data);
  assert.ok(kb.includes(`tsk:reply:${t.id}`), kb.join(","));
  resetSent(); await pressButton("820100", `tsk:reply:${t.id}`);
  assert.match(sent.at(-1)?.text ?? "", /Напишіть коментар/);
  resetSent(); await sendText("820100", "Постачальник підтвердив на четвер");
  assert.match(sent.find(s => String(s.chatId) === "820100")?.text ?? "", /Коментар додано/);
  const [c] = await db.select().from(taskCommentsTable).where(eq(taskCommentsTable.taskId, t.id));
  assert.equal(c?.body, "Постачальник підтвердив на четвер"); assert.equal(c?.adminId, a!.id);
  assert.ok(sent.some(s => String(s.chatId) === "820200" && /Постачальник/.test(s.text ?? "")), "автор отримав коментар");
});

test("дашборд легалізації: колонки відповідальний і відкрита автозадача", opts, async () => {
  await seedRole("legal", ["legalization"], ["/legalization"]);
  const { cookie } = await seedAdmin({ role: "legal", name: "Viktoriia" });
  const resp = await seedAdmin({ role: "legal", name: "Resp" });
  const [f] = await db.insert(factoriesTable).values({ name: "AGRAM", shiftCount: 2, responsibleAdminId: resp.adminId }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Ivan Kovalenko", factoryId: f!.id, isActive: true }).returning();
  await db.insert(workerLegalityTable).values({ workerId: w!.id, stay: "legal", work: "legal", overall: "legal", computedAt: new Date() });
  const t = await createTask({ title: "Paszport спливає", workerId: w!.id, source: "auto:doc_expiring", sourceKey: "x", assigneeAdminId: resp.adminId, notify: false }, null);
  const r = await request(app).get("/api/legalization").set("Cookie", cookie);
  assert.equal(r.status, 200);
  const row = r.body.rows.find((x: any) => x.id === w!.id);
  assert.equal(row.responsibleName, "Resp");
  assert.equal(row.task.id, t.id); assert.equal(row.task.assigneeName, "Resp"); assert.equal(row.task.count, 1);
});
