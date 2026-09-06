// «Календар працівників»: збір подій (документ, умова, обовʼязок, відпрошування, ДН,
// початок/кінець на фабриці, задача), фільтри фабрика/працівник/kinds, гейт сторінки.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  hasTestDb, resetDb, closeDb, db, app, seedAdmin, seedRole, workersTable, factoriesTable, workerDocumentsTable, documentTypesTable,
  contractsTable, workerLegalityTable, absenceRequestsTable,
} from "../test/harness.ts";
import { workerFactoriesTable } from "@workspace/db";
import { createTask } from "../services/tasks.ts";
import { addDaysStr } from "../lib/dates.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const H = { "X-Requested-With": "grafik" };

test("календар: усі джерела подій, фільтри й гейт сторінки", opts, async () => {
  const { cookie, adminId } = await seedAdmin();
  const [f1] = await db.insert(factoriesTable).values({ name: "AGRAM", shiftCount: 2 }).returning();
  const [f2] = await db.insert(factoriesTable).values({ name: "LST", shiftCount: 2 }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Ivan Kovalenko", factoryId: f1!.id, isActive: true, birthDate: "1990-" + addDaysStr(today, 3).slice(5) }).returning();
  const [w2] = await db.insert(workersTable).values({ fullName: "Olena Bondar", factoryId: f2!.id, isActive: true }).returning();
  const [dt] = await db.insert(documentTypesTable).values({ name: "Paszport", code: "passport" }).returning();
  await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: dt!.id, title: "Paszport UA", status: "present", expiresAt: addDaysStr(today, 10) });
  await db.insert(workerDocumentsTable).values({ workerId: w!.id, title: "Стара карта", status: "expired", expiresAt: addDaysStr(today, 1) }); // expired не показуємо
  await db.insert(contractsTable).values({ workerId: w!.id, factoryId: f1!.id, status: "signed", dateFrom: addDaysStr(today, -100), dateTo: addDaysStr(today, 20) });
  await db.insert(workerLegalityTable).values({ workerId: w!.id, stay: "legal", work: "legal", overall: "legal", obligations: [{ code: "obligation.ua_notification", dueAt: addDaysStr(today, 5), overdue: false }], computedAt: new Date() });
  const monday = addDaysStr(today, -((new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7));
  await db.insert(absenceRequestsTable).values({ workerId: w!.id, weekStart: monday, dayOfWeek: "fri", status: "accepted", reason: "лікар" });
  await db.insert(workerFactoriesTable).values({ workerId: w2!.id, factoryId: f2!.id, validFrom: addDaysStr(today, 2), validTo: addDaysStr(today, 40) });
  const task = await createTask({ title: "Подзвонити", dueAt: addDaysStr(today, 1), workerId: w2!.id, notify: false }, adminId);

  const from = addDaysStr(today, -7), to = addDaysStr(today, 45);
  const r = await request(app).get(`/api/workers-calendar?from=${from}&to=${to}`).set("Cookie", cookie);
  assert.equal(r.status, 200);
  const kinds = r.body.events.map((e: any) => e.kind).sort();
  assert.deepEqual(kinds, ["absence", "birthday", "contract", "doc", "end", "obligation", "start", "task"]);
  const doc = r.body.events.find((e: any) => e.kind === "doc");
  assert.equal(doc.title, "Paszport спливає"); assert.equal(doc.severity, "warn"); assert.equal(doc.workerName, "Ivan Kovalenko");
  assert.equal(r.body.events.find((e: any) => e.kind === "obligation").title, "Powiadomienie PUP (UA)");
  assert.equal(r.body.events.find((e: any) => e.kind === "absence").date, addDaysStr(monday, 4));
  assert.match(r.body.events.find((e: any) => e.kind === "birthday").title, /36 р\./);
  assert.equal(r.body.events.find((e: any) => e.kind === "task").taskId, task.id);
  // сортування за датою
  const dates = r.body.events.map((e: any) => e.date);
  assert.deepEqual(dates, [...dates].sort());

  // фільтри
  const byFactory = await request(app).get(`/api/workers-calendar?from=${from}&to=${to}&factoryId=${f2!.id}`).set("Cookie", cookie);
  assert.ok(byFactory.body.events.every((e: any) => e.workerId === w2!.id));
  const byKinds = await request(app).get(`/api/workers-calendar?from=${from}&to=${to}&kinds=doc,birthday`).set("Cookie", cookie);
  assert.deepEqual(byKinds.body.events.map((e: any) => e.kind).sort(), ["birthday", "doc"]);
  const byWorker = await request(app).get(`/api/workers-calendar?from=${from}&to=${to}&workerId=${w!.id}`).set("Cookie", cookie);
  assert.equal(byWorker.body.events.length, 5);
  assert.equal((await request(app).get(`/api/workers-calendar?from=bad&to=${to}`).set("Cookie", cookie)).status, 400);

  // гейт: роль без сторінки → 403
  await seedRole("noaccess", ["editData"], ["/workers"]);
  const { cookie: c2 } = await seedAdmin({ role: "noaccess", name: "NoAccess" });
  assert.equal((await request(app).get(`/api/workers-calendar?from=${from}&to=${to}`).set("Cookie", c2)).status, 403);
  void H;
});
