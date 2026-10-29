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

test("restoreWorker: без фабрики, але є чинна додаткова → вона стає основною, рядок worker_factories зникає", opts, async () => {
  const { workerFactoriesTable } = await import("@workspace/db");
  const [f1] = await db.insert(factoriesTable).values({ name: "Dawtona" } as any).returning();
  const [f2] = await db.insert(factoriesTable).values({ name: "Agro" } as any).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "N H", workerCode: "00003", factoryId: f1!.id, isActive: false, status: "fired", firedAt: new Date() }).returning();
  await db.insert(workerFactoriesTable).values({ workerId: w!.id, factoryId: f2!.id });
  const r = await restoreWorker({ workerId: w!.id, adminId: null });
  assert.equal(r.ok, true);
  const [row] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(row!.factoryId, f2!.id, "додаткова стала основною");
  assert.equal((await db.select().from(workerFactoriesTable).where(eq(workerFactoriesTable.workerId, w!.id))).length, 0, "основна й додаткова не збігаються");
  const fj = (await db.select().from(workerChangesTable).where(eq(workerChangesTable.field, "factoryId")))[0]!;
  assert.equal(fj.oldValue, String(f1!.id)); assert.equal(fj.newValue, String(f2!.id));

  // явна фабрика, що збігається з додатковою — теж прибирає рядок; явна стара — додаткову не чіпає
  const [w2] = await db.insert(workersTable).values({ fullName: "P Q", workerCode: "00004", factoryId: f1!.id, isActive: false, status: "fired" }).returning();
  await db.insert(workerFactoriesTable).values({ workerId: w2!.id, factoryId: f2!.id });
  assert.equal((await restoreWorker({ workerId: w2!.id, factoryId: f1!.id, adminId: null })).ok, true);
  const [row2] = await db.select().from(workersTable).where(eq(workersTable.id, w2!.id));
  assert.equal(row2!.factoryId, f1!.id);
  assert.equal((await db.select().from(workerFactoriesTable).where(eq(workerFactoriesTable.workerId, w2!.id))).length, 1);
});
