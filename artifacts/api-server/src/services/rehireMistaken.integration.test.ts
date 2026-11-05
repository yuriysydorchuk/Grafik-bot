// Зголошення #19 (рішення власника 05.11.2026):
//  • повернення звільненого питає «новий найм / звільнили помилково»; помилкове — НЕ новий найм:
//    журнал fireUndone (не restored), перший робочий день лишається, умова, закрита звільненням,
//    повертає свій кінець, задачі звільнення скасовуються;
//  • «Вислати всіх» у ланцюжку powiadomienia бере лише людей з підтвердженим виходом (uaAttended).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, db,
  workersTable, factoriesTable, companiesTable, contractsTable, workerChangesTable, tasksTable, scheduleWeeksTable, scheduleEntriesTable, factoryHoursTable,
} from "../test/harness.ts";
import { fireWorker } from "./workerFire.ts";
import { restoredSince } from "./firstWorkDate.ts";
import { uaAttended } from "./uaNotification.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" };
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

test("відновлення «звільнили помилково»: не новий найм — перший день і кінець умови на місці, задачі звільнення скасовано; звичайне — новий найм", opts, async () => {
  const owner = await seedAdmin({ role: "owner", isMain: true });
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "LST", companyId: co!.id }).returning();
  const mk = async (fullName: string) => {
    const [w] = await db.insert(workersTable).values({ fullName, factoryId: fa!.id, companyId: co!.id, isActive: true, firstWorkDate: "2026-09-01" } as any).returning();
    const [c] = await db.insert(contractsTable).values({ workerId: w!.id, factoryId: fa!.id, companyId: co!.id, status: "signed", dateFrom: "2026-09-01", dateTo: "2026-12-31", data: { keep: "x" } }).returning();
    return { w: w!, c: c! };
  };
  const a = await mk("Pomylka Anna"), b = await mk("Powrot Borys");
  for (const x of [a, b]) assert.equal((await fireWorker({ workerId: x.w.id, date: "2026-10-23", adminId: owner.adminId, source: "web" })).ok, true);
  await wait(600); // ланцюжок звільнення (ZWUA-задача) — після відповіді
  const closed = (await db.select().from(contractsTable).where(eq(contractsTable.id, a.c.id)))[0]!;
  assert.equal(String(closed.dateTo), "2026-10-23");
  assert.deepEqual([(closed.data as any)._closedByFire, (closed.data as any)._dateToBeforeFire, (closed.data as any).keep], ["2026-10-23", "2026-12-31", "x"]);
  const zwua = (id: number) => db.select().from(tasksTable).where(and(eq(tasksTable.workerId, id), eq(tasksTable.source, "auto:termination_zus")));
  assert.equal((await zwua(a.w.id))[0]?.status, "open");

  // помилкове звільнення
  const r = await request(app).post(`/api/workers/${a.w.id}/restore`).set("Cookie", owner.cookie).set(H).send({ mistaken: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.undo.contractsReopened, r.body.undo.contractsLeftClosed, r.body.undo.tasksCancelled], [1, 0, 1]);
  const wa = (await db.select().from(workersTable).where(eq(workersTable.id, a.w.id)))[0]!;
  assert.deepEqual([wa.isActive, String(wa.firstWorkDate)], [true, "2026-09-01"], "перший робочий день лишився");
  const ca = (await db.select().from(contractsTable).where(eq(contractsTable.id, a.c.id)))[0]!;
  assert.equal(String(ca.dateTo), "2026-12-31", "умова повернула свій кінець");
  assert.deepEqual([(ca.data as any)._closedByFire, (ca.data as any).keep], [undefined, "x"]);
  const ja = (await db.select().from(workerChangesTable).where(eq(workerChangesTable.workerId, a.w.id))).map(j => j.field);
  assert.ok(ja.includes("fireUndone") && !ja.includes("restored"), ja.join(","));
  assert.equal((await restoredSince([a.w.id])).size, 0, "«повернений = новий найм» не спрацьовує");
  assert.equal((await zwua(a.w.id))[0]!.status, "cancelled");

  // звичайне повернення — новий найм, як і було
  const r2 = await request(app).post(`/api/workers/${b.w.id}/restore`).set("Cookie", owner.cookie).set(H).send({});
  assert.equal(r2.status, 200, r2.text); assert.equal(r2.body.undo, null);
  const wb = (await db.select().from(workersTable).where(eq(workersTable.id, b.w.id)))[0]!;
  assert.deepEqual([wb.isActive, wb.firstWorkDate], [true, null]);
  assert.equal(String((await db.select().from(contractsTable).where(eq(contractsTable.id, b.c.id)))[0]!.dateTo), "2026-10-23", "умова лишається закритою");
  assert.equal((await restoredSince([b.w.id])).size, 1);
});

test("uaAttended: розіслана минула зміна без явки → вихід не підтверджено; явка / день у файлі фабрики / без графіку — підтверджено", opts, async () => {
  const [fa] = await db.insert(factoriesTable).values({ name: "LST" }).returning();
  const mk = async (fullName: string) => (await db.insert(workersTable).values({ fullName, factoryId: fa!.id, isActive: true }).returning())[0]!;
  const noShow = await mk("Bez Yavky"), came = await mk("Z Yavkoyu"), manual = await mk("Bez Hrafiku"), byFile = await mk("Z Faylu"), future = await mk("Zavtra");
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-10-12", status: "approved" }).returning();
  const entry = (workerId: number, day: string, status: string, sent = true) => ({ weekId: wk!.id, workerId, factoryId: fa!.id, dayOfWeek: day, shift: "1", status, sentAt: sent ? new Date() : null });
  await db.insert(scheduleEntriesTable).values([
    entry(noShow.id, "mon", "scheduled"), entry(came.id, "mon", "scheduled"), entry(came.id, "tue", "present"),
    entry(byFile.id, "mon", "scheduled"),
  ] as any);
  await db.insert(factoryHoursTable).values({ workerId: byFile.id, month: "2026-10", factoryId: fa!.id, hours: 8, days: { "2026-10-13": 8 } } as any);
  const [wk2] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-10-19", status: "approved" }).returning();
  await db.insert(scheduleEntriesTable).values({ weekId: wk2!.id, workerId: future.id, factoryId: fa!.id, dayOfWeek: "wed", shift: "1", status: "scheduled", sentAt: new Date() } as any);
  const rows = [noShow, came, manual, byFile, future].map(w => ({ id: w.id, start: "2026-10-12" }));
  const ok = await uaAttended(rows, "2026-10-20"); // «сьогодні» — вівторок 20.10: середа 21.10 ще попереду
  assert.deepEqual([ok.has(noShow.id), ok.has(came.id), ok.has(manual.id), ok.has(byFile.id), ok.has(future.id)], [false, true, true, true, true]);
});
