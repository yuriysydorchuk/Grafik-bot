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

test("mergeWorkers: keep ЗВІЛЬНЕНИЙ + drop активний з іншим Telegram — keep активний, бере tg дубля", opts, async () => {
  const [keep] = await db.insert(workersTable).values({ fullName: "A B", workerCode: "00001", telegramId: "1", isActive: false, status: "fired", firedAt: new Date() }).returning();
  const [drop] = await db.insert(workersTable).values({ fullName: "A B", workerCode: "00002", telegramId: "2" }).returning();
  const r = await mergeWorkers(keep!.id, drop!.id);
  assert.deepEqual(r, { ok: true });
  const [merged] = await db.select().from(workersTable).where(eq(workersTable.id, keep!.id));
  assert.equal(merged!.telegramId, "2", "Telegram нового акаунта переїхав на старий профіль");
  assert.equal(merged!.isActive, true);
  assert.equal(merged!.status, "active");
  assert.equal(merged!.firedAt, null);
  assert.equal((await db.select().from(workersTable)).length, 1);
});

test("mergeWorkers manual (з профілю): два активні з різними Telegram — зливається, лишається tg keep; журнал merged", opts, async () => {
  const [a] = await db.insert(workersTable).values({ fullName: "A B", workerCode: "00001", telegramId: "1" }).returning();
  const [b] = await db.insert(workersTable).values({ fullName: "A B", workerCode: "00002", telegramId: "2" }).returning();
  const r = await mergeWorkers(a!.id, b!.id, { manual: true });
  assert.deepEqual(r, { ok: true });
  const [merged] = await db.select().from(workersTable).where(eq(workersTable.id, a!.id));
  assert.equal(merged!.telegramId, "1");
  const { workerChangesTable } = await import("../test/harness.ts");
  const [ch] = await db.select().from(workerChangesTable).where(eq(workerChangesTable.workerId, a!.id));
  assert.equal(ch!.field, "merged");
  assert.match(ch!.oldValue ?? "", /00002/);
});

test("mergeWorkers: рапорт БЕЗ фабрики за той самий місяць в обох — не падає (unique nofactory), лишається keep", opts, async () => {
  const [keep] = await db.insert(workersTable).values({ fullName: "C D", workerCode: "00001" }).returning();
  const [drop] = await db.insert(workersTable).values({ fullName: "C D", workerCode: "00002" }).returning();
  await db.insert(monthlyReportsTable).values([
    { workerId: keep!.id, month: "2026-07", factoryId: null, hoursReported: 100 },
    { workerId: drop!.id, month: "2026-07", factoryId: null, hoursReported: 60 },
  ]);
  assert.deepEqual(await mergeWorkers(keep!.id, drop!.id), { ok: true });
  const reports = await db.select().from(monthlyReportsTable).where(eq(monthlyReportsTable.workerId, keep!.id));
  assert.deepEqual(reports.map(r => r.hoursReported), [100]);
});

test("POST /workers/:id/merge + merge-preview: превʼю попереджає про сводну/Telegram, злиття з профілю працює", opts, async () => {
  const { app, seedAdmin } = await import("../test/harness.ts");
  const request = (await import("supertest")).default;
  const H = { "X-Requested-With": "grafik" };
  const owner = await seedAdmin({ role: "owner" });
  const [keep] = await db.insert(workersTable).values({ fullName: "E F", workerCode: "00001", telegramId: "11" }).returning();
  const [drop] = await db.insert(workersTable).values({ fullName: "E F", workerCode: "00002", telegramId: "22" }).returning();
  for (const wid of [keep!.id, drop!.id]) await db.insert(svodniRowsTable).values({
    periodMonth: "2026-08", city: "Люблін", factoryLabel: "TEST", rawName: "E F", workerId: wid, linkStatus: "auto", extras: {}, hr: {}, sheetValues: {},
  } as any);
  const pv = await request(app).get(`/api/workers/${keep!.id}/merge-preview?dropId=${drop!.id}`).set("Cookie", owner.cookie);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.drop.workerCode, "00002");
  assert.ok(pv.body.moves.some((m: any) => m.label === "Рядки сводної" && m.count === 1));
  assert.ok(pv.body.warnings.some((w: string) => w.startsWith("Різні Telegram")));
  assert.ok(pv.body.warnings.some((w: string) => w.startsWith("Сводна")));
  const m = await request(app).post(`/api/workers/${keep!.id}/merge`).set("Cookie", owner.cookie).set(H).send({ dropId: drop!.id });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal((await db.select().from(workersTable)).length, 1);
  assert.equal((await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, keep!.id))).length, 2, "рядки сводної перенесено як є");
});
