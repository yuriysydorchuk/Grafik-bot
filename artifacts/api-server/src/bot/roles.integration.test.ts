import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db } from "../test/harness.ts";
import { adminsTable, workersTable, driversTable } from "../test/harness.ts";
import { isAdmin, getAdmin, getWorker, getDriver } from "./roles.ts";

// bot/roles.ts governs bot identity: a web-panel role "driver" must NOT count as a bot
// admin (those people are led by the drivers table); only active workers/drivers keep
// their bot role.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("getAdmin returns a real office admin", opts, async () => {
  await db.insert(adminsTable).values({ name: "Office", role: "owner", telegramId: "700100" });
  assert.ok(await getAdmin("700100"));
  assert.equal(await isAdmin("700100"), true);
});

test("getAdmin excludes a web role='driver' account (they are bot-drivers, not admins)", opts, async () => {
  await db.insert(adminsTable).values({ name: "DriverWeb", role: "driver", telegramId: "700200" });
  assert.equal(await getAdmin("700200"), undefined);
  assert.equal(await isAdmin("700200"), false);
});

test("getWorker/getDriver only return ACTIVE rows", opts, async () => {
  await db.insert(workersTable).values({ fullName: "Active", telegramId: "700300", isActive: true });
  await db.insert(workersTable).values({ fullName: "Fired", telegramId: "700400", isActive: false });
  assert.ok(await getWorker("700300"));
  assert.equal(await getWorker("700400"), undefined, "a fired worker loses their bot role");

  await db.insert(driversTable).values({ name: "ActiveDrv", telegramId: "700500", inviteCode: "DRVA", isActive: true });
  await db.insert(driversTable).values({ name: "GoneDrv", telegramId: "700600", inviteCode: "DRVB", isActive: false });
  assert.ok(await getDriver("700500"));
  assert.equal(await getDriver("700600"), undefined);
});

test("an unknown Telegram id resolves to no role", opts, async () => {
  assert.equal(await getAdmin("700999"), undefined);
  assert.equal(await getWorker("700999"), undefined);
  assert.equal(await getDriver("700999"), undefined);
});
