import { db } from "@workspace/db";
import { adminsTable, workersTable, driversTable } from "@workspace/db";
import type { Worker, Driver } from "@workspace/db";
import { eq, and } from "drizzle-orm";

export async function isAdmin(tid: string): Promise<boolean> {
  const rows = await db.select().from(adminsTable).where(eq(adminsTable.telegramId, tid));
  return rows.length > 0;
}

export async function getAdmin(tid: string) {
  const rows = await db.select().from(adminsTable).where(eq(adminsTable.telegramId, tid));
  return rows[0];
}

// Only ACTIVE workers/drivers keep their bot role — a fired worker or deleted
// driver immediately loses their menu/functionality.
export async function getWorker(tid: string): Promise<Worker | undefined> {
  const rows = await db.select().from(workersTable)
    .where(and(eq(workersTable.telegramId, tid), eq(workersTable.isActive, true)));
  return rows[0];
}

export async function getDriver(tid: string): Promise<Driver | undefined> {
  const rows = await db.select().from(driversTable)
    .where(and(eq(driversTable.telegramId, tid), eq(driversTable.isActive, true)));
  return rows[0];
}
