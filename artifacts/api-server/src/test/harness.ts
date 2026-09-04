import "./env.ts"; // MUST be first — sets DATABASE_URL before @workspace/db evaluates
import { randomBytes } from "node:crypto";
import {
  db, adminsTable, adminSessionsTable, loginEventsTable, rolesTable, driversTable, workersTable,
  factoriesTable, positionsTable, factoryOrdersTable, availabilityTable, absenceRequestsTable,
  scheduleWeeksTable, scheduleEntriesTable, scheduleApprovalsTable, notificationsTable, bankTransactionsTable, pnlEntriesTable,
  companiesTable, documentTypesTable, vehiclesTable, workerDocumentsTable, advanceRequestsTable,
  funnelsTable, candidatesTable, candidateActivityTable, driverWorkdaysTable,
  driverShiftAssignmentsTable, svodniRowsTable, svodniTabChecksTable, svodniTabMetaTable, monthlyReportsTable,
  expenseCategoriesTable, counterpartyRulesTable, payrollSourcesTable, payrollFactoryMonthsTable,
  factoryHoursTable, factoryShiftOverridesTable, shiftCancellationsTable,
  transportDeductionsTable, svodniLocksTable, factoryPositionsTable, factoryPayoutRulesTable,
  clothingItemsTable, clothingStockTable, clothingTypesTable, workerBadaniaTable,
  workerChangesTable, penaltiesTable,
  agreementConditionsTable, agreementChargesTable, agreementAuditTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import app from "../app.ts";
import { createToken, SESSION_COOKIE, invalidateRolesCache, hashPassword } from "../lib/auth.ts";
import { DEFAULT_EXPENSE_CATS, invalidateExpenseCats } from "../services/bankClassify.ts";

// Re-exported so integration tests import ONLY from the harness — this guarantees env.ts
// runs before @workspace/db is evaluated (import order within a test file is otherwise fragile).
export {
  db, adminsTable, adminSessionsTable, loginEventsTable, rolesTable,
  driversTable, workersTable, factoriesTable, positionsTable, factoryOrdersTable,
  availabilityTable, absenceRequestsTable, scheduleWeeksTable, scheduleEntriesTable, scheduleApprovalsTable, notificationsTable,
  bankTransactionsTable, pnlEntriesTable, companiesTable, documentTypesTable, vehiclesTable,
  workerDocumentsTable, advanceRequestsTable, funnelsTable, candidatesTable, candidateActivityTable,
  driverWorkdaysTable, driverShiftAssignmentsTable, svodniRowsTable, svodniTabChecksTable, svodniTabMetaTable, monthlyReportsTable,
  expenseCategoriesTable, counterpartyRulesTable, payrollSourcesTable, payrollFactoryMonthsTable,
  factoryHoursTable, factoryShiftOverridesTable, shiftCancellationsTable,
  transportDeductionsTable, svodniLocksTable, factoryPositionsTable, factoryPayoutRulesTable,
  clothingItemsTable, clothingStockTable, clothingTypesTable, workerBadaniaTable,
  workerChangesTable, penaltiesTable,
  agreementConditionsTable, agreementChargesTable, agreementAuditTable,
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
    "schedule_weeks, schedule_entries, schedule_approvals, notifications, factory_shift_overrides, bank_transactions, pnl_entries, " +
    "svodni_rows, svodni_tab_checks, svodni_tab_meta, svodni_locks, factory_payout_rules, monthly_reports, factory_hours, hours_notes, worker_changes, " +
    "transport_deductions, clothing_items, clothing_stock, clothing_types, " +
    "agreement_conditions, agreement_charges, agreement_audit, " +
    "companies, document_types, vehicles, advance_requests, " +
    "funnels, candidates, candidate_activity, " +
    "expense_categories, counterparty_rules, " +
    "payroll_sources, payroll_factory_months RESTART IDENTITY CASCADE",
  ));
  // classification queries need the category rows — restore the default seed
  await db.insert(expenseCategoriesTable).values(
    DEFAULT_EXPENSE_CATS.map((c, i) => ({ ...c, sortOrder: (i + 1) * 10 })),
  );
  invalidateExpenseCats();
  // базові типи одягу — дзеркало сіду міграції (валідація itemType іде по довіднику)
  await db.insert(clothingTypesTable).values([
    { key: "boots", label: "Взуття", sortOrder: 10 }, { key: "coverall", label: "Комбінезон", sortOrder: 20 },
    { key: "jacket", label: "Куртка", sortOrder: 30 }, { key: "hat", label: "Шапка", sortOrder: 40 },
    { key: "tshirt", label: "Футболка", sortOrder: 50 }, { key: "set", label: "Комплект", sortOrder: 60 },
    { key: "other", label: "Інше", sortOrder: 70 },
  ]);
}

// Insert a role with the given capabilities/pages, then invalidate the auth role cache so
// authRequired resolves it on the next request.
// `notify` — bot notification types the role opts into (bot notifyAdmins/notifyRoles are gated by it).
export async function seedRole(key: string, caps: string[] = [], pages: string[] = [], notify: string[] = []): Promise<void> {
  await db.insert(rolesTable).values({ key, label: key, caps, pages, notify }).onConflictDoNothing();
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
