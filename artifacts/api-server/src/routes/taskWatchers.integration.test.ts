// Звірка з макетом, блок A+B: спостерігачі (бачать хід, отримують сповіщення, не в «Моїх»),
// «Нагадати всім» для групової, вкладення в коментарях, порядок денний зустрічі в запрошенні,
// підсумок зустрічі, привʼязки документ/умова/кандидат у відповіді.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  hasTestDb, resetDb, closeDb, db, app, seedAdmin, seedRole, adminsTable, workersTable, workerDocumentsTable, taskCommentsTable, tasksTable,
} from "../test/harness.ts";
import { sent, resetSent } from "../test/botHarness.ts";
import { createTask } from "../services/tasks.ts";
import { ensureUploadDirs } from "../lib/uploads.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const H = { "X-Requested-With": "grafik" };
const PNG = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "latin1");

test("спостерігачі: не в «Моїх», є в «Спостерігаю», отримують сповіщення про завершення і коментарі; додати/зняти через PATCH", opts, async () => {
  await seedRole("office", ["editData"], ["/tasks"], ["tasks"]);
  const me = await seedAdmin({ role: "office", name: "Me" });
  const wsess = await seedAdmin({ role: "office", name: "Watcher" });
  await db.update(adminsTable).set({ telegramId: "830101" }).where(eq(adminsTable.id, wsess.adminId));
  const r = await request(app).post("/api/tasks").set("Cookie", me.cookie).set(H).send({ title: "Звірити ставки", watcherIds: [wsess.adminId] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.watchers.map((x: any) => x.name), ["Watcher"]);
  assert.match(sent.find(s => String(s.chatId) === "830101")?.text ?? "", /спостерігачем/);
  // спостерігач не бачить задачу в «Моїх», але бачить у «Спостерігаю»
  assert.equal((await request(app).get("/api/tasks?scope=mine").set("Cookie", wsess.cookie)).body.length, 0);
  assert.equal((await request(app).get("/api/tasks?scope=watching").set("Cookie", wsess.cookie)).body.length, 1);
  // коментар → спостерігач отримує
  resetSent();
  const c = await request(app).post(`/api/tasks/${r.body.id}/comments`).set("Cookie", me.cookie).set(H).send({ body: "Перевірив, усе гаразд" });
  assert.equal(c.status, 200);
  assert.ok(sent.some(s => String(s.chatId) === "830101" && /усе гаразд/.test(s.text ?? "")), "спостерігач отримав коментар");
  // завершення → спостерігач отримує
  resetSent();
  await request(app).post(`/api/tasks/${r.body.id}/status`).set("Cookie", me.cookie).set(H).send({ status: "done" });
  assert.ok(sent.some(s => String(s.chatId) === "830101" && /виконано/.test(s.text ?? "")));
  // зняти спостерігача
  const p = await request(app).patch(`/api/tasks/${r.body.id}`).set("Cookie", me.cookie).set(H).send({ watcherIds: [] });
  assert.equal(p.status, 200);
  const d = await request(app).get(`/api/tasks/${r.body.id}`).set("Cookie", me.cookie);
  assert.equal(d.body.watchers.length, 0);
});

test("групова: «Нагадати всім» шле лише тим, хто ще не відмітив; прогрес без спостерігачів", opts, async () => {
  await seedRole("office", ["editData", "tasksGroup"], ["/tasks"], ["tasks"]);
  const lead = await seedAdmin({ role: "office", name: "Lead" });
  const [p1] = await db.insert(adminsTable).values({ name: "P1", role: "office", telegramId: "830201" }).returning();
  const [p2] = await db.insert(adminsTable).values({ name: "P2", role: "office", telegramId: "830202" }).returning();
  const [wt] = await db.insert(adminsTable).values({ name: "Wt", role: "office", telegramId: "830203" }).returning();
  const t = await createTask({ kind: "group", title: "Здати звіти", assigneeIds: [p1!.id, p2!.id], watcherIds: [wt!.id], notify: false }, lead.adminId);
  const { respondAssignee } = await import("../services/tasks.ts");
  await respondAssignee(t, p1!.id, "done");
  resetSent();
  const r = await request(app).post(`/api/tasks/${t.id}/remind`).set("Cookie", lead.cookie).set(H).send({});
  assert.equal(r.status, 200); assert.equal(r.body.reminded, 1, "лише P2");
  assert.ok(sent.some(s => String(s.chatId) === "830202" && /нагадує/.test(s.text ?? "")));
  assert.ok(!sent.some(s => String(s.chatId) === "830201"), "P1 уже відмітив");
  const d = await request(app).get(`/api/tasks/${t.id}`).set("Cookie", lead.cookie);
  assert.equal(d.body.assignees.length, 2, "спостерігач не серед учасників"); assert.equal(d.body.watchers.length, 1);
  await respondAssignee(t, p2!.id, "done");
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, t.id)))[0]?.status, "done", "усі учасники (без спостерігача) відмітили → виконано");
});

test("коментар із файлом: multipart → вкладення, стрім файлу; згадка → сповіщення згаданому", opts, async () => {
  await ensureUploadDirs();
  await seedRole("office", ["editData"], ["/tasks"], ["tasks"]);
  const me = await seedAdmin({ role: "office", name: "Me" });
  const [m] = await db.insert(adminsTable).values({ name: "Viktoriia", role: "office", telegramId: "830300" }).returning();
  const t = await createTask({ title: "Спецодяг", assigneeAdminId: me.adminId, notify: false }, me.adminId);
  resetSent();
  const up = await request(app).post(`/api/tasks/${t.id}/comments/upload`).set("Cookie", me.cookie).set(H)
    .field("body", "@Viktoriia глянь фото").field("mentions", JSON.stringify([m!.id])).attach("files", PNG, "photo.png");
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const [c] = await db.select().from(taskCommentsTable).where(eq(taskCommentsTable.taskId, t.id));
  assert.equal(c?.attachments.length, 1); assert.equal(c?.attachments[0]?.mime, "image/png"); assert.deepEqual(c?.mentions, [m!.id]);
  assert.ok(sent.some(s => String(s.chatId) === "830300" && /глянь фото/.test(s.text ?? "")), "згаданий отримав");
  const f = await request(app).get(`/api/tasks/${t.id}/attachments/${c!.id}/0`).set("Cookie", me.cookie);
  assert.equal(f.status, 200); assert.match(f.headers["content-type"], /image\/png/);
  // HTML під виглядом файлу — відмова
  const bad = await request(app).post(`/api/tasks/${t.id}/comments/upload`).set("Cookie", me.cookie).set(H).field("body", "x").attach("files", Buffer.from("<html></html>"), "evil.pdf");
  assert.equal(bad.status, 400);
});

test("зустріч: порядок денний у запрошенні, підсумок через PATCH; привʼязки документ/умова у відповіді", opts, async () => {
  await seedRole("office", ["editData", "tasksGroup"], ["/tasks"], ["tasks"]);
  const lead = await seedAdmin({ role: "office", name: "Lead" });
  const [p] = await db.insert(adminsTable).values({ name: "Part", role: "office", telegramId: "830400" }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Ivan Kovalenko", isActive: true }).returning();
  const [doc] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, title: "Paszport", status: "present" }).returning();
  resetSent();
  const r = await request(app).post("/api/tasks").set("Cookie", lead.cookie).set(H).send({ kind: "meeting", title: "Збори", dueAt: "2030-01-10", dueTime: "15:00", assigneeIds: [p!.id], agenda: ["Прострочені документи", "Паперові умови"], workerId: w!.id, documentId: doc!.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.agenda, ["Прострочені документи", "Паперові умови"]);
  assert.equal(r.body.documentTitle, "Paszport");
  const inv = sent.find(s => String(s.chatId) === "830400")?.text ?? "";
  assert.match(inv, /1\. Прострочені документи/); assert.match(inv, /2\. Паперові умови/);
  await request(app).post(`/api/tasks/${r.body.id}/status`).set("Cookie", lead.cookie).set(H).send({ status: "done" });
  const s = await request(app).patch(`/api/tasks/${r.body.id}`).set("Cookie", lead.cookie).set(H).send({ summary: "Вирішили: Viktoriia подає до пʼятниці" });
  assert.equal(s.status, 200); assert.equal(s.body.summary, "Вирішили: Viktoriia подає до пʼятниці");
});
