import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, sendStart, sendText, resetSent, sentText } from "../test/botHarness.ts";
import { workersTable, driversTable, adminsTable, factoriesTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";

// Telegram deep-link binding flows, driven through the real bot handlers.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

test("emp: binds the worker and burns the single-use code", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski", inviteCode: "ABCD1234WXYZ" }).returning({ id: workersTable.id });
  await sendStart("500100", "empABCD1234WXYZ");
  const [after] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(after!.telegramId, "500100");
  assert.equal(after!.inviteCode, null, "single-use code is burned");
  assert.match(sentText(), /Jan Kowalski|прив/i);
});

test("emp: a link already claimed by another account is rejected, binding unchanged", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Anna", telegramId: "999", inviteCode: "CODECODECODE" }).returning({ id: workersTable.id });
  await sendStart("500200", "empCODECODECODE");
  const [after] = await db.select().from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(after!.telegramId, "999", "not rebound to the new account");
  assert.match(sentText(), /вже використано|іншим/i);
});

test("emp: a Telegram already bound to another worker cannot claim a second profile", opts, async () => {
  await db.insert(workersTable).values({ fullName: "Bound", telegramId: "500300" });
  const [target] = await db.insert(workersTable).values({ fullName: "Target", inviteCode: "FRESHCODE123" }).returning({ id: workersTable.id });
  await sendStart("500300", "empFRESHCODE123");
  const [after] = await db.select().from(workersTable).where(eq(workersTable.id, target!.id));
  assert.equal(after!.telegramId, null, "target profile stays unbound");
  assert.match(sentText(), /вже прив|іншого працівника/i);
});

test("emp: an unknown code is rejected", opts, async () => {
  await sendStart("500400", "empNOPENOPENOPE");
  assert.match(sentText(), /недійсне|застаріле|не знайдено/i);
});

test("drv: binds a driver by their invite code", opts, async () => {
  const [d] = await db.insert(driversTable).values({ name: "Kierowca", inviteCode: "DRIVERCODE01" }).returning({ id: driversTable.id });
  await sendStart("500500", "drvDRIVERCODE01");
  const [after] = await db.select().from(driversTable).where(eq(driversTable.id, d!.id));
  assert.equal(after!.telegramId, "500500");
});

test("adm: binds an admin and burns the invite code", opts, async () => {
  const [a] = await db.insert(adminsTable).values({ name: "Office", role: "owner", inviteCode: "ADMINCODE001" }).returning({ id: adminsTable.id });
  await sendStart("500600", "admADMINCODE001");
  const [after] = await db.select().from(adminsTable).where(eq(adminsTable.id, a!.id));
  assert.equal(after!.telegramId, "500600");
  assert.equal(after!.inviteCode, null, "admin invite code is burned");
});

test("fac: self-signup with a Latin name creates a worker; Cyrillic is rejected", opts, async () => {
  const [f] = await db.insert(factoriesTable).values({ name: "Fabryka A" }).returning({ id: factoriesTable.id });
  // Start the signup dialog, then send a name.
  await sendStart("500700", `fac${f!.id}`);
  resetSent();
  await sendText("500700", "Іван Петров"); // Cyrillic — must be refused, no worker created
  assert.equal((await db.select().from(workersTable).where(eq(workersTable.telegramId, "500700"))).length, 0);

  resetSent();
  await sendText("500700", "Jan Kowalski"); // Latin — accepted
  const rows = await db.select().from(workersTable).where(eq(workersTable.telegramId, "500700"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.factoryId, f!.id);
});
