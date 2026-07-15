import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { hasTestDb, resetDb, closeDb, db, workersTable, monthlyReportsTable, svodniRowsTable } from "../test/harness.ts";
import { mergeWorkers } from "./workerMerge.ts";

// Злиття дублікатних профілів: Telegram/порожні поля/звʼязані записи
// переїжджають на keep, конфліктні рапорти не дублюються, drop зникає.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("mergeWorkers: telegram і записи переносяться, дублікат зникає", opts, async () => {
  const [keep] = await db.insert(workersTable).values({ fullName: "Kowalski Jan", workerCode: "00001" }).returning();
  const [drop] = await db.insert(workersTable).values({ fullName: "KOWALSKI JAN", workerCode: "00002", telegramId: "777", legalStatus: "student" }).returning();
  await db.insert(monthlyReportsTable).values([
    { workerId: keep!.id, month: "2026-05", factoryId: null, hoursReported: 100 },
    { workerId: drop!.id, month: "2026-06", factoryId: null, hoursReported: 50 },
  ]);
  await db.insert(svodniRowsTable).values({
    periodMonth: "2026-05", city: "Люблін", factoryLabel: "TEST", rawName: "KOWALSKI JAN",
    workerId: drop!.id, linkStatus: "auto", extras: {}, hr: {}, sheetValues: {},
  } as any);

  const r = await mergeWorkers(keep!.id, drop!.id);
  assert.deepEqual(r, { ok: true });

  const [merged] = await db.select().from(workersTable).where(eq(workersTable.id, keep!.id));
  assert.equal(merged!.telegramId, "777", "Telegram переїхав на keep");
  assert.equal(merged!.legalStatus, "student", "порожнє поле keep заповнилось із drop");
  assert.equal((await db.select().from(workersTable).where(eq(workersTable.id, drop!.id))).length, 0, "drop видалено");
  const reports = await db.select().from(monthlyReportsTable).where(eq(monthlyReportsTable.workerId, keep!.id));
  assert.equal(reports.length, 2, "рапорти обох профілів у keep");
  const [sv] = await db.select().from(svodniRowsTable);
  assert.equal(sv!.workerId, keep!.id, "рядок сводної перепривʼязано");
});

test("mergeWorkers: два АКТИВНІ профілі з різними Telegram — відмова без змін", opts, async () => {
  const [a] = await db.insert(workersTable).values({ fullName: "A B", workerCode: "00001", telegramId: "1" }).returning();
  const [b] = await db.insert(workersTable).values({ fullName: "A B", workerCode: "00002", telegramId: "2" }).returning();
  const r = await mergeWorkers(a!.id, b!.id);
  assert.equal(r.ok, false);
  assert.equal((await db.select().from(workersTable)).length, 2);
});

test("mergeWorkers: звільнений дубль з іншим Telegram — зливається, tg активного лишається", opts, async () => {
  const [a] = await db.insert(workersTable).values({ fullName: "A B", workerCode: "00001", telegramId: "1" }).returning();
  const [b] = await db.insert(workersTable).values({ fullName: "A B", workerCode: "00002", telegramId: "2", isActive: false, status: "fired" }).returning();
  const r = await mergeWorkers(a!.id, b!.id);
  assert.deepEqual(r, { ok: true });
  const [merged] = await db.select().from(workersTable).where(eq(workersTable.id, a!.id));
  assert.equal(merged!.telegramId, "1", "Telegram активного профілю не зачеплено");
  assert.equal((await db.select().from(workersTable)).length, 1);
});
