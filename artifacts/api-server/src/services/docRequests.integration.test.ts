// Автозапит документів: система сама просить self-service документ у бот перед строком,
// нагадує за драбиною, офісна задача лише при мовчанні / впритул до строку / без Telegram;
// файл через публічний лінк /docs/:token → pending + задача перевірки одразу.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { and, eq, like } from "drizzle-orm";
import {
  hasTestDb, resetDb, closeDb, db, app, seedAdmin, workersTable, factoriesTable, workerDocumentsTable, documentTypesTable, tasksTable, workerLegalityTable,
} from "../test/harness.ts";
import { sent, resetSent } from "../test/botHarness.ts";
import { autoRequestDocuments, sendDocumentRequest } from "./docRequests.ts";
import { runAutoTasks, ensureAutoRules, collectCandidates } from "./taskAutoRules.ts";
import { ensureUploadDirs } from "../lib/uploads.ts";
import { addDaysStr } from "../lib/dates.ts";
import { passportScanTokensTable } from "@workspace/db";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); await ensureAutoRules(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const PNG = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "latin1");
const openTasks = () => db.select().from(tasksTable).where(like(tasksTable.source, "auto:%"));
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);

test("self-service документ у вікні: запит у бот з лінком, БЕЗ задачі офісу; без Telegram — задача як раніше; не self-service — задача", opts, async () => {
  await seedAdmin();
  const [f] = await db.insert(factoriesTable).values({ name: "AGRAM", shiftCount: 2 }).returning();
  const [w1] = await db.insert(workersTable).values({ fullName: "Ivan Kovalenko", factoryId: f!.id, isActive: true, telegramId: "88001", language: "uk" }).returning();
  const [w2] = await db.insert(workersTable).values({ fullName: "Olena Bondar", factoryId: f!.id, isActive: true }).returning(); // без Telegram
  const [w3] = await db.insert(workersTable).values({ fullName: "Petro Melnyk", factoryId: f!.id, isActive: true, telegramId: "88003" }).returning();
  const [pass] = await db.insert(documentTypesTable).values({ name: "Paszport", code: "passport", selfService: true, renewalLeadDays: 30 }).returning();
  const [med] = await db.insert(documentTypesTable).values({ name: "Badania lekarskie", code: "medical_exam", selfService: false, renewalLeadDays: 30 }).returning();
  const [d1] = await db.insert(workerDocumentsTable).values({ workerId: w1!.id, docTypeId: pass!.id, title: "Paszport", status: "present", expiresAt: addDaysStr(today, 20) }).returning();
  await db.insert(workerDocumentsTable).values({ workerId: w2!.id, docTypeId: pass!.id, title: "Paszport", status: "present", expiresAt: addDaysStr(today, 20) });
  await db.insert(workerDocumentsTable).values({ workerId: w3!.id, docTypeId: med!.id, title: "Badania", status: "present", expiresAt: addDaysStr(today, 20) });

  resetSent();
  const st = await runAutoTasks(today);
  assert.equal(st.autoRequested, 1, "один автозапит (Ivan)");
  const msg = sent.find(s => String(s.chatId) === "88001");
  assert.ok(msg && /Потрібен документ: \*Paszport\*/.test(msg.text ?? "") && /\/docs\//.test(msg.text ?? ""), msg?.text);
  const [d1b] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, d1!.id));
  assert.ok(d1b?.requestedAt && d1b.requestedBy == null, "запитано системою");
  const tasks = await openTasks();
  assert.ok(!tasks.some(t => t.workerId === w1!.id && t.source === "auto:doc_expiring"), "Ivan: задачі офісу немає");
  assert.ok(tasks.some(t => t.workerId === w2!.id && t.source === "auto:doc_expiring"), "Olena без Telegram: задача офісу");
  assert.ok(tasks.some(t => t.workerId === w3!.id && t.source === "auto:doc_expiring"), "Petro badania (не self-service): задача офісу");

  // повторний прогін того ж дня — без дубля запиту і без нагадування (0 днів)
  resetSent();
  const st2 = await runAutoTasks(today);
  assert.equal(st2.autoRequested + st2.autoReminded, 0);
});

test("нагадування за драбиною 3/7, потім задача «не надіслав»; строк впритул → задача офісу навіть після запиту", opts, async () => {
  await seedAdmin();
  const [w] = await db.insert(workersTable).values({ fullName: "Ivan Kovalenko", isActive: true, telegramId: "88010", language: "pl" }).returning();
  const [pass] = await db.insert(documentTypesTable).values({ name: "Paszport", code: "passport", selfService: true, renewalLeadDays: 60 }).returning();
  const [d] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: pass!.id, title: "Paszport", status: "present", expiresAt: addDaysStr(today, 40), requestedAt: daysAgo(5), requestedBy: null }).returning();
  resetSent();
  let st = await runAutoTasks(today);
  assert.equal(st.autoReminded, 1, "5 днів після запиту → перше нагадування (крок 3)");
  assert.match(sent.find(s => String(s.chatId) === "88010")?.text ?? "", /Przypomnienie/);
  assert.equal((await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, d!.id)))[0]?.requestRemindCount, 1);
  const docTasks = async () => (await openTasks()).filter(t => t.workerId === w!.id && ["auto:doc_expiring", "auto:doc_no_response"].includes(t.source));
  assert.equal((await docTasks()).length, 0, "мовчання 5 < 7 — задачі ще нема");

  await db.update(workerDocumentsTable).set({ requestedAt: daysAgo(15) }).where(eq(workerDocumentsTable.id, d!.id));
  resetSent();
  st = await runAutoTasks(today);
  assert.equal(st.autoReminded, 1, "15 днів → друге нагадування (крок 7)");
  const nores = (await openTasks()).find(t => t.source === "auto:doc_no_response");
  assert.ok(nores, "задача офісу «не надіслав»"); assert.match(nores!.title, /Не надіслав документ: Paszport/);
  assert.equal((nores!.autoParams as any).reminders, 2);
  resetSent();
  st = await runAutoTasks(today);
  assert.equal(st.autoReminded, 0, "драбина вичерпана — більше не нагадуємо");

  // строк впритул (≤7 днів): звичайна задача офісу, хоч і запитано
  const [w2] = await db.insert(workersTable).values({ fullName: "Olena Bondar", isActive: true, telegramId: "88011" }).returning();
  await db.insert(workerDocumentsTable).values({ workerId: w2!.id, docTypeId: pass!.id, title: "Paszport", status: "present", expiresAt: addDaysStr(today, 5), requestedAt: daysAgo(2) });
  await runAutoTasks(today);
  assert.ok((await openTasks()).some(t => t.workerId === w2!.id && t.source === "auto:doc_expiring"), "≤7 днів → задача офісу");
});

test("публічний лінк /docs/:token: список запитаного, завантаження → pending, задача перевірки одразу, подяка в бот; чужий тип — 400", opts, async () => {
  await ensureUploadDirs();
  const { adminId } = await seedAdmin({ isMain: true }); // без відповідального фабрики задача йде головному
  const [w] = await db.insert(workersTable).values({ fullName: "Maria Shevchenko", isActive: true, telegramId: "88020", language: "uk" }).returning();
  const [pass] = await db.insert(documentTypesTable).values({ name: "Paszport", code: "passport", selfService: true }).returning();
  const [other] = await db.insert(documentTypesTable).values({ name: "Inny", code: "other" }).returning();
  await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: pass!.id, title: "Paszport", status: "present", expiresAt: addDaysStr(today, 10) });
  resetSent();
  const r = await sendDocumentRequest({ workerId: w!.id, docTypeId: pass!.id, kind: "auto" });
  assert.ok(r.sent && r.link);
  const token = r.link!.split("/docs/")[1]!;
  const [tok] = await db.select().from(passportScanTokensTable).where(eq(passportScanTokensTable.token, token));
  assert.equal(tok?.purpose, "docs"); assert.equal(tok?.workerId, w!.id);

  const info = await request(app).get(`/api/docs/${token}`);
  assert.equal(info.status, 200); assert.equal(info.body.language, "uk"); assert.equal(info.body.items[0].name, "Paszport"); assert.equal(info.body.focusTypeId, pass!.id);

  assert.equal((await request(app).post(`/api/docs/${token}/upload`).set("X-Requested-With", "grafik").field("docTypeId", String(other!.id)).attach("file", PNG, "x.png")).status, 400, "не запитаний тип");
  resetSent();
  const up = await request(app).post(`/api/docs/${token}/upload`).set("X-Requested-With", "grafik").field("docTypeId", String(pass!.id)).attach("file", PNG, "scan.png");
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const [doc] = await db.select().from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, w!.id), eq(workerDocumentsTable.docTypeId, pass!.id)));
  assert.equal(doc?.status, "pending"); assert.equal(doc?.source, "worker_bot");
  const task = (await openTasks()).find(t => t.source === "auto:pending_doc" && t.documentId === doc!.id);
  assert.ok(task, "задача перевірки створена одразу"); assert.equal(task!.assigneeAdminId, adminId);
  assert.ok(sent.some(s => String(s.chatId) === "88020" && /Дякуємо/.test(s.text ?? "")), "працівник отримав подяку");
  const info2 = await request(app).get(`/api/docs/${token}`);
  assert.equal(info2.body.items[0].status, "pending");
  // нічний прогін: pending → задача не дублюється, автозапит не шле повторно
  resetSent();
  const st = await runAutoTasks(today);
  assert.equal(st.autoRequested + st.autoReminded, 0);
  assert.equal((await openTasks()).filter(t => t.source === "auto:pending_doc").length, 1);
  assert.equal((await request(app).get(`/api/docs/nope`)).status, 404);
});

test("відсутній обовʼязковий документ: система НЕ просить, задача «Бракує» з усіма пунктами", opts, async () => {
  await seedAdmin();
  const [w] = await db.insert(workersTable).values({ fullName: "Ivan Kovalenko", isActive: true, telegramId: "88030" }).returning();
  await db.insert(documentTypesTable).values({ name: "Paszport", code: "passport", selfService: true });
  await db.insert(workerLegalityTable).values({ workerId: w!.id, stay: "unknown", work: "unknown", overall: "illegal", requiredMissing: ["passport", "stay_basis"], computedAt: new Date() });
  resetSent();
  const st = await autoRequestDocuments(today);
  assert.equal(st.requested, 0, "відсутні не просимо"); assert.equal(sent.length, 0);
  const cands = await collectCandidates(today);
  const req = cands.find(c => c.rule === "required_missing");
  assert.ok(req); assert.deepEqual((req!.autoParams as any).codes, ["passport", "stay_basis"]);
});
