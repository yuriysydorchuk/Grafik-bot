import { db, scheduleWeeksTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

export type WeekRow = typeof scheduleWeeksTable.$inferSelect;

// The web panel works with draft weeks (and even creates one when assigning
// drivers ahead), so an approved status no longer implies "the week in use".
// Every driver-facing surface must resolve a weekStart the same way the web
// does: prefer the approved row, else the newest row of that weekStart.
export async function resolveWeekRow(weekStart: string): Promise<WeekRow | undefined> {
  const candidates = await db.select().from(scheduleWeeksTable)
    .where(eq(scheduleWeeksTable.weekStart, weekStart))
    .orderBy(desc(scheduleWeeksTable.id));
  return candidates.find(w => w.status === "approved") ?? candidates[0];
}

// Resolve-or-create: assigning drivers ahead of schedule generation needs a
// week row to hang assignments on (mirrors PUT /schedule/driver-assignments).
export async function ensureWeekRow(weekStart: string): Promise<WeekRow> {
  const existing = await resolveWeekRow(weekStart);
  if (existing) return existing;
  const [row] = await db.insert(scheduleWeeksTable).values({ weekStart, status: "draft" }).returning();
  return row!;
}
