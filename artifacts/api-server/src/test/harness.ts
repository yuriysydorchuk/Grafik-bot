import "./env.ts"; // MUST be first — sets DATABASE_URL before @workspace/db evaluates
import { randomBytes } from "node:crypto";
import {
  db, adminsTable, adminSessionsTable, loginEventsTable, rolesTable, driversTable, workersTable,
  factoriesTable, positionsTable, factoryOrdersTable, availabilityTable, absenceRequestsTable,
  scheduleWeeksTable, scheduleEntriesTable, bankTransactionsTable, pnlEntriesTable,
  companiesTable, documentTypesTable, vehiclesTable, workerDocumentsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import app from "../app.ts";
import { createToken, SESSION_COOKIE, invalidateRolesCache, hashPassword } from "../lib/auth.ts";

// Re-exported so integration tests import ONLY from the harness — this guarantees env.ts
// runs before @workspace/db is evaluated (import order within a test file is otherwise fragile).
export {
  db, adminsTable, adminSessionsTable, loginEventsTable, rolesTable,
  driversTable, workersTable, factoriesTable, positionsTable, factoryOrdersTable,
  availabilityTable, absenceRequestsTable, scheduleWeeksTable, scheduleEntriesTable,
  bankTransactionsTable, pnlEntriesTable, companiesTable, documentTypesTable, vehiclesTable, workerDocumentsTable,
};
export { hashPassword, SESSION_COOKIE };

// Integration tests are opt-in: they need a real, disposable Postgres pointed to by
// TEST_DATABASE_URL. `pnpm test` without it runs only the pure unit tests.
export const hasTestDb = !!process.env.TEST_DATABASE_URL;

export { app };

// Wipe the tables the integration tests touch. Guarded so it can NEVER run against a
// database whose name doesn't clearly mark it as a test DB.
export async function resetDb(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? "";
  if (!/test/i.test(url)) throw new Error("resetDb refused: TEST_DATABASE_URL is not a *test* database");
  await db.execute(sql.raw(
    "TRUNCATE admins, admin_sessions, login_events, workers, drivers, roles, " +
    "factories, positions, factory_orders, availability, absence_requests, " +
    "schedule_weeks, schedule_entries, bank_transactions, pnl_entries, " +
    "companies, document_types, vehicles RESTART IDENTITY CASCADE",
  ));
}

// Insert a role with the given capabilities/pages, then invalidate the auth role cache so
// authRequired resolves it on the next request.
export async function seedRole(key: string, caps: string[] = [], pages: string[] = []): Promise<void> {
  await db.insert(rolesTable).values({ key, label: key, caps, pages }).onConflictDoNothing();
  invalidateRolesCache();
}

// Insert an admin (optionally under a seeded role) plus a tracked session, and return a
// ready-to-send Cookie header carrying a valid signed token bound to that session.
export async function seedAdmin(opts: { role?: string; isMain?: boolean; name?: string } = {}): Promise<{ adminId: number; cookie: string }> {
  const name = opts.name ?? "Test Admin";
  const role = opts.role ?? "owner";
  const [admin] = await db.insert(adminsTable).values({
    name,
    username: `u_${randomBytes(4).toString("hex")}`,
    passwordHash: hashPassword("irrelevant"),
    role,
    isMain: opts.isMain ?? false,
    telegramId: randomBytes(6).toString("hex"),
    tokenVersion: 0,
  }).returning({ id: adminsTable.id });

  const sid = randomBytes(24).toString("hex");
  await db.insert(adminSessionsTable).values({ id: sid, adminId: admin!.id });

  const token = createToken(admin!.id, name, role, 0, sid);
  return { adminId: admin!.id, cookie: `${SESSION_COOKIE}=${token}` };
}

// Close the pool so `node --test` exits cleanly after the suite.
export async function closeDb(): Promise<void> {
  const { pool } = await import("@workspace/db");
  await pool.end().catch(() => {});
}
