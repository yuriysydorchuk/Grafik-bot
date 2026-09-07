import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { hasTestDb, resetDb, closeDb, db, workersTable, factoriesTable, workerChangesTable } from "../test/harness.ts";
import { restoreWorker } from "./workerRehire.ts";

// Повернення звільненого: профіль активується на місці (без нового), фабрика/
// Telegram оновлюються за потреби, кожна зміна — у журналі worker_changes.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("restoreWorker: фабрика + новий Telegram, журнал restored/factoryId/telegramId", opts, async () => {
  const [f1] = await db.insert(factoriesTable).values({ name: "Old" } as any).returning();
  const [f2] = await db.insert(factoriesTable).values({ name: "New" } as any).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "A B", workerCode: "00001", telegramId: "1", factoryId: f1!.id, isActive: false, status: "fired", firedAt: new Date() }).returning();
  const r = await restoreWorker({ workerId: w!.id, factoryId: f2!.id, telegramId: "2", adminId: null });
  assert.equal(r.ok, true);
  const [row] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(row!.isActive, true);
  assert.equal(row!.status, "active");
  assert.equal(row!.firedAt, null);
  assert.equal(row!.factoryId, f2!.id);
  assert.equal(row!.telegramId, "2");
  const fields = (await db.select().from(workerChangesTable).where(eq(workerChangesTable.workerId, w!.id))).map(c => c.field).sort();
  assert.deepEqual(fields, ["factoryId", "restored", "telegramId"]);
  const tg = (await db.select().from(workerChangesTable).where(eq(workerChangesTable.field, "telegramId")))[0]!;
  assert.equal(tg.oldValue, "1", "старий Telegram лишається в журналі (архів)");
  assert.equal(tg.newValue, "2");
});

test("restoreWorker: уже активний — відмова; Telegram активного іншого — відмова; неактивного — знімається", opts, async () => {
  const [active] = await db.insert(workersTable).values({ fullName: "C D", workerCode: "00001", telegramId: "9" }).returning();
  assert.equal((await restoreWorker({ workerId: active!.id, adminId: null })).ok, false);

  const [fired] = await db.insert(workersTable).values({ fullName: "A B", workerCode: "00002", isActive: false, status: "fired" }).returning();
  const taken = await restoreWorker({ workerId: fired!.id, telegramId: "9", adminId: null });
  assert.equal(taken.ok, false, "tg активного не переписуємо");

  const [firedOther] = await db.insert(workersTable).values({ fullName: "E F", workerCode: "00003", telegramId: "5", isActive: false, status: "fired" }).returning();
  const r = await restoreWorker({ workerId: fired!.id, telegramId: "5", adminId: null });
  assert.equal(r.ok, true);
  const [o] = await db.select().from(workersTable).where(eq(workersTable.id, firedOther!.id));
  assert.equal(o!.telegramId, null, "tg знято з неактивного власника (унікальність)");
  const [me] = await db.select().from(workersTable).where(eq(workersTable.id, fired!.id));
  assert.equal(me!.telegramId, "5");
});
