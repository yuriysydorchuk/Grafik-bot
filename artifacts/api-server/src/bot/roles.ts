import { db } from "@workspace/db";
import { adminsTable, workersTable, driversTable } from "@workspace/db";
import type { Worker, Driver } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";

// The web-panel role "driver" grants site access only — it must NOT give the
// office/admin experience in the bot. Such people live in the drivers table
// (possibly as head driver), and that row governs their bot functionality.
export async function isAdmin(tid: string): Promise<boolean> {
  return (await getAdmin(tid)) !== undefined;
}

export async function getAdmin(tid: string) {
  const rows = await db.select().from(adminsTable)
    .where(and(eq(adminsTable.telegramId, tid), ne(adminsTable.role, "driver")));
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
