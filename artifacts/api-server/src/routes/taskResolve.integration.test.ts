// «Як вирішити» (services/taskResolve): контекст і дії для автозадач — перевірка файлу
// (verify/reject), запит скану, зміна виплат (dismiss), перерахунок, повідомлення працівнику,
// дефолтний чекліст при auto-run, Excel-експорт списку, нагадування про зустрічі.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  hasTestDb, resetDb, closeDb, db, app, seedAdmin, seedRole, workersTable, factoriesTable, workerDocumentsTable, documentTypesTable,
  workerChangesTable, tasksTable, taskEventsTable, adminsTable, rolesTable,
} from "../test/harness.ts";
import { invalidateRolesCache } from "../lib/auth.ts";
import { createTask } from "../services/tasks.ts";
import { buildTaskResolution, runTaskAction, defaultChecklist } from "../services/taskResolve.ts";
import { sendMeetingReminders } from "../services/taskDigest.ts";
import { sent, resetSent } from "../test/botHarness.ts";
import { addDaysStr } from "../lib/dates.ts";
import { applyWorkerDocumentUpload } from "../services/workerDocuments.ts";
import { ensureUploadDirs } from "../lib/uploads.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const H = { "X-Requested-With": "grafik" };

test("pending_doc: контекст показує файл, дія verify_doc підтверджує документ і пише журнал задачі", opts, async () => {
  const { cookie, adminId } = await seedAdmin();
  const [f] = await db.insert(factoriesTable).values({ name: "AGRAM", shiftCount: 2 }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Ivan Kovalenko", factoryId: f!.id, isActive: true, telegramId: "77001" }).returning();
  const [ty] = await db.insert(documentTypesTable).values({ name: "Paszport", code: "passport" }).returning();
  const [doc] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: ty!.id, title: "Paszport UA", status: "pending", filePath: "x/p.pdf", fileName: "p.pdf", fileMime: "application/pdf", expiresAt: addDaysStr(today, 300) }).returning();
  const t = await createTask({ title: "Перевірити завантажений документ: Paszport", workerId: w!.id, factoryId: f!.id, documentId: doc!.id, source: "auto:pending_doc", sourceKey: `pending:${doc!.id}`, autoParams: { workerName: w!.fullName }, assigneeAdminId: adminId, notify: false }, null);

  const r = await request(app).get(`/api/tasks/${t.id}`).set("Cookie", cookie);
  assert.equal(r.status, 200);
  const res = r.body.resolution;
  assert.equal(res.context.rule, "pending_doc");
  assert.equal(res.context.document.id, doc!.id); assert.equal(res.context.document.fileUrl, `/api/worker-documents/${doc!.id}/file`);
  assert.deepEqual(res.actions.map((a: any) => a.code).slice(0, 2), ["verify_doc", "reject_doc"]);
  assert.match(res.context.why, /Створено системою/); assert.match(res.context.closesWhen, /підтверджено або відхилено/);

  const a = await request(app).post(`/api/tasks/${t.id}/action/verify_doc`).set("Cookie", cookie).set(H).send({});
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.match(a.body.message, /підтверджено/);
  const [d2] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, doc!.id));
  assert.equal(d2?.status, "present"); assert.equal(d2?.verifiedBy, adminId);
  const ev = await db.select().from(taskEventsTable).where(eq(taskEventsTable.taskId, t.id));
  assert.ok(ev.some(e => e.kind === "action" && (e.payload as any)?.code === "verify_doc"));
  // після підтвердження дій verify/reject уже нема
  const r2 = await request(app).get(`/api/tasks/${t.id}`).set("Cookie", cookie);
  assert.ok(!r2.body.resolution.actions.some((x: any) => x.code === "verify_doc"));

  // reject без причини — 400
  const [doc2] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: ty!.id, title: "Другий", status: "pending" }).returning();
  const t2 = await createTask({ title: "Перевірити", workerId: w!.id, documentId: doc2!.id, source: "auto:pending_doc", sourceKey: `pending:${doc2!.id}`, assigneeAdminId: adminId, notify: false }, null);
  assert.equal((await request(app).post(`/api/tasks/${t2.id}/action/reject_doc`).set("Cookie", cookie).set(H).send({})).status, 400);
  const rj = await request(app).post(`/api/tasks/${t2.id}/action/reject_doc`).set("Cookie", cookie).set(H).send({ note: "нечитабельно" });
  assert.equal(rj.status, 200);
  assert.equal((await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, doc2!.id)))[0]?.reviewNote, "нечитабельно");
});

test("doc_expiring: request_doc ставить requestedAt і шле лінк у бот; message_worker; чужа задача → 403", opts, async () => {
  const { cookie, adminId } = await seedAdmin();
  const [w] = await db.insert(workersTable).values({ fullName: "Olena Bondar", isActive: true, telegramId: "77002", language: "uk" }).returning();
  const [ty] = await db.insert(documentTypesTable).values({ name: "Karta pobytu czasowego", code: "trc" }).returning();
  const [doc] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: ty!.id, title: "TRC", status: "present", expiresAt: addDaysStr(today, 20) }).returning();
  const t = await createTask({ title: "Karta pobytu czasowego спливає", workerId: w!.id, documentId: doc!.id, source: "auto:doc_expiring", sourceKey: "x", autoParams: { docTypeCode: "trc", workerName: w!.fullName }, assigneeAdminId: adminId, notify: false, checklist: defaultChecklist("doc_expiring", { docTypeCode: "trc" }) }, null);
  const { context, actions } = await buildTaskResolution(t);
  assert.equal(context.document?.typeCode, "trc");
  assert.ok(actions.some(a => a.code === "scan_card" && a.href === `/workers/${w!.id}?open=scan-card`));
  assert.ok(actions.some(a => a.code === "request_doc" && a.primary && !a.done));
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, t.id)))[0]?.checklist.length, 4, "дефолтний чекліст для картки");

  resetSent();
  const a = await request(app).post(`/api/tasks/${t.id}/action/request_doc`).set("Cookie", cookie).set(H).send({});
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const [d2] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, doc!.id));
  assert.ok(d2?.requestedAt, "requested_at виставлено"); assert.equal(d2?.requestedBy, adminId);
  const { actions: a2 } = await buildTaskResolution(t);
  assert.ok(a2.find(x => x.code === "request_doc")?.done, "повторно — позначка «запитано»");

  resetSent();
  const m = await request(app).post(`/api/tasks/${t.id}/action/message_worker`).set("Cookie", cookie).set(H).send({ note: "Привіт, потрібен скан" });
  assert.equal(m.status, 200);
  assert.ok(sent.some(s => String(s.chatId) === "77002" && /потрібен скан/.test(s.text ?? "")), "працівник отримав повідомлення");

  await seedRole("office", ["editData"], ["/tasks"]);
  const other = await seedAdmin({ role: "office", name: "Other" });
  assert.equal((await request(app).post(`/api/tasks/${t.id}/action/request_doc`).set("Cookie", other.cookie).set(H).send({})).status, 403);
});

test("файл з бота: сповіщення виконавцю з кнопкою «Підтвердити», файл видно в задачі, авто-чекліст requested→uploaded→verified", opts, async () => {
  await ensureUploadDirs();
  const { cookie, adminId } = await seedAdmin();
  await db.update(adminsTable).set({ telegramId: "77500" }).where(eq(adminsTable.id, adminId));
  await seedRole("owner", [], ["/tasks"], ["tasks"]);
  await db.update(rolesTable).set({ notify: ["tasks"] }).where(eq(rolesTable.key, "owner"));
  invalidateRolesCache();
  const [w] = await db.insert(workersTable).values({ fullName: "Maria Shevchenko", isActive: true, telegramId: "77003", language: "uk" }).returning();
  const [ty] = await db.insert(documentTypesTable).values({ name: "Paszport", code: "passport" }).returning();
  const [doc] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: ty!.id, title: "Paszport", status: "present", expiresAt: addDaysStr(today, 15) }).returning();
  const t = await createTask({ title: "Paszport спливає", workerId: w!.id, documentId: doc!.id, source: "auto:doc_expiring", sourceKey: "p", autoParams: { docTypeCode: "passport", workerName: w!.fullName }, assigneeAdminId: adminId, notify: false, checklist: defaultChecklist("doc_expiring", { docTypeCode: "passport" }) }, null);
  const keys = (list: any[]) => list.filter(c => c.done).map(c => c.auto);
  assert.deepEqual(keys((await buildTaskResolution(t)).context && (await db.select().from(tasksTable).where(eq(tasksTable.id, t.id)))[0]!.checklist as any[]), [], "спочатку нічого не відмічено");

  // 1) запит скану → крок «requested» відмічено системою
  await request(app).post(`/api/tasks/${t.id}/action/request_doc`).set("Cookie", cookie).set(H).send({});
  let row = (await db.select().from(tasksTable).where(eq(tasksTable.id, t.id)))[0]!;
  assert.deepEqual(keys(row.checklist as any[]), ["requested"]);
  assert.equal((row.checklist as any[])[0].doneBy, null, "відмітила система");

  // 2) працівник надіслав файл через бот → сповіщення виконавцю з кнопками, файл у контексті, крок «uploaded»
  resetSent();
  const PNG = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "latin1");
  await applyWorkerDocumentUpload(w!.id, ty!.id, PNG, "scan.png");
  const n = sent.find(s => String(s.chatId) === "77500");
  assert.ok(n && /надіслав\(ла\) файл: \*Paszport\*/.test(n.text ?? ""), "виконавець отримав сповіщення");
  const kb = (n!.extra.reply_markup.inline_keyboard as any[]).flat().map(b => b.callback_data);
  assert.ok(kb.some((c: string) => c === `tska:verify_doc.${doc!.id}:${t.id}`), `кнопка підтвердити: ${kb.join(",")}`);
  const r = await request(app).get(`/api/tasks/${t.id}`).set("Cookie", cookie);
  assert.equal(r.body.resolution.context.uploads.length, 1);
  assert.equal(r.body.resolution.context.uploads[0].fileUrl, `/api/worker-documents/${doc!.id}/file`);
  assert.equal(r.body.resolution.context.uploads[0].isImage, true);
  assert.equal(r.body.resolution.actions[0].code, `verify_doc.${doc!.id}`, "підтвердити — перша дія");
  assert.deepEqual(keys(r.body.checklist), ["requested", "uploaded"]);

  // 3) підтвердження з задачі → документ present, крок «verified»
  const v = await request(app).post(`/api/tasks/${t.id}/action/verify_doc.${doc!.id}`).set("Cookie", cookie).set(H).send({});
  assert.equal(v.status, 200, JSON.stringify(v.body));
  row = (await db.select().from(tasksTable).where(eq(tasksTable.id, t.id)))[0]!;
  assert.deepEqual(keys(row.checklist as any[]), ["requested", "uploaded", "verified"]);
  assert.equal((await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, doc!.id)))[0]?.status, "present");
  // чужий документ через параметр — відмова
  const [other] = await db.insert(workersTable).values({ fullName: "Інший", isActive: true }).returning();
  const [od] = await db.insert(workerDocumentsTable).values({ workerId: other!.id, docTypeId: ty!.id, title: "X", status: "pending", filePath: "x/y.png" }).returning();
  assert.equal((await request(app).post(`/api/tasks/${t.id}/action/verify_doc.${od!.id}`).set("Cookie", cookie).set(H).send({})).status, 400);
});

test("payroll_change: контекст показує було→стало, dismiss_change закриває зміну; review_required → recompute", opts, async () => {
  const { cookie, adminId } = await seedAdmin();
  const [w] = await db.insert(workersTable).values({ fullName: "Petro Melnyk", isActive: true, nationality: "PL" }).returning();
  const [ch] = await db.insert(workerChangesTable).values({ workerId: w!.id, field: "effectiveLegalStatus", oldValue: null, newValue: "polak", effectiveDate: today, adminId }).returning();
  const t = await createTask({ title: "Прийняти зміну статусу виплат", workerId: w!.id, source: "auto:payroll_change", sourceKey: "c", autoParams: { changeId: ch!.id, workerName: w!.fullName }, assigneeAdminId: adminId, notify: false }, null);
  const r = await request(app).get(`/api/tasks/${t.id}`).set("Cookie", cookie);
  assert.equal(r.body.resolution.context.change.newValue, "polak");
  assert.deepEqual(r.body.resolution.actions.filter((a: any) => a.code.endsWith("_change")).map((a: any) => a.kind), ["modal", "api"]);
  const d = await request(app).post(`/api/tasks/${t.id}/action/dismiss_change`).set("Cookie", cookie).set(H).send({});
  assert.equal(d.status, 200);
  assert.ok((await db.select().from(workerChangesTable).where(eq(workerChangesTable.id, ch!.id)))[0]?.reviewDismissedAt);
  assert.ok(!(await buildTaskResolution(t)).actions.some(a => a.code === "dismiss_change"));

  const t2 = await createTask({ title: "Перевірити легалізацію", workerId: w!.id, source: "auto:review_required", sourceKey: "r", autoParams: { reasons: ["nationality_conflict"], workerName: w!.fullName }, assigneeAdminId: adminId, notify: false }, null);
  const rc = await request(app).post(`/api/tasks/${t2.id}/action/recompute`).set("Cookie", cookie).set(H).send({});
  assert.equal(rc.status, 200, JSON.stringify(rc.body)); assert.match(rc.body.message, /Перераховано/);
});

test("Excel-експорт списку і нагадування про зустріч за годину / за день", opts, async () => {
  const { cookie, adminId } = await seedAdmin();
  await seedRole("office", ["editData"], ["/tasks"], ["tasks"]);
  const [p] = await db.insert(adminsTable).values({ name: "Part", role: "office", telegramId: "77100" }).returning();
  await createTask({ title: "Ручна", dueAt: today, assigneeAdminId: adminId, notify: false }, adminId);
  const x = await request(app).get(`/api/tasks/export.xlsx?scope=all&status=all`).set("Cookie", cookie)
    .buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
  assert.equal(x.status, 200); assert.match(x.headers["content-type"], /spreadsheetml/); assert.ok((x.body as Buffer).length > 1000);

  // зустріч через ~62 хв від «зараз» у Варшаві
  const nowW = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
  const plus = new Date(nowW.getTime() + 62 * 60000);
  const hm = `${String(plus.getHours()).padStart(2, "0")}:${String(plus.getMinutes()).padStart(2, "0")}`;
  const sameDay = plus.toLocaleDateString("sv-SE") === nowW.toLocaleDateString("sv-SE");
  const m = await createTask({ kind: "meeting", title: "Збори", dueAt: today, dueTime: hm, place: "офіс", assigneeIds: [p!.id], notify: false }, adminId);
  resetSent();
  const n = await sendMeetingReminders(new Date(), today);
  if (sameDay) {
    assert.equal(n, 1, "за годину — учаснику");
    assert.ok(sent.some(s => String(s.chatId) === "77100" && /Через годину/.test(s.text ?? "")));
    resetSent(); assert.equal(await sendMeetingReminders(new Date(), today), 0, "дедуп");
  }
  // за день: зустріч завтра, тік у час вечірнього підсумку (17:30)
  const m2 = await createTask({ kind: "meeting", title: "Планерка", dueAt: addDaysStr(today, 1), dueTime: "09:00", assigneeIds: [p!.id], notify: false }, adminId);
  resetSent();
  const at = (h: number, mi: number) => { const d = new Date(); const w = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Warsaw" })); const off = d.getTime() - w.getTime(); const x2 = new Date(w); x2.setHours(h, mi, 0, 0); return new Date(x2.getTime() + off); };
  await sendMeetingReminders(at(17, 31), today);
  assert.ok(sent.some(s => String(s.chatId) === "77100" && /Завтра: \*Планерка\*/.test(s.text ?? "")), "за день");
  void m; void m2;
});
