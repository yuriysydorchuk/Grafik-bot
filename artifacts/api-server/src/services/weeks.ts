import { db, scheduleWeeksTable, scheduleApprovalsTable, scheduleEntriesTable } from "@workspace/db";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

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

// When did this factory's schedule for the week go "into work" — the earliest of
// its approval (schedule_approvals row) and the first Telegram send to workers
// (min sent_at of the factory's entries). null = nothing approved/sent yet.
// The week's own status is NOT a factory-level signal: approving one factory
// marks the whole week approved, so it's used only as a fallback when the
// caller has no factory (worker without factory_id).
export async function factoryWeekReleaseAt(weekStart: string, factoryId: number | null): Promise<Date | null> {
  const week = await resolveWeekRow(weekStart);
  if (!week) return null;
  if (factoryId == null) return week.status === "approved" ? week.approvedAt ?? new Date(0) : null;
  const times: number[] = [];
  const [appr] = await db.select({ at: scheduleApprovalsTable.approvedAt }).from(scheduleApprovalsTable)
    .where(and(eq(scheduleApprovalsTable.weekId, week.id), eq(scheduleApprovalsTable.factoryId, factoryId)));
  if (appr?.at) times.push(new Date(appr.at).getTime());
  const [sent] = await db.select({ at: sql<Date | string | null>`min(${scheduleEntriesTable.sentAt})` })
    .from(scheduleEntriesTable)
    .where(and(
      eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.factoryId, factoryId),
      isNotNull(scheduleEntriesTable.sentAt),
    ));
  if (sent?.at) times.push(new Date(sent.at).getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

// Resolve-or-create: assigning drivers ahead of schedule generation needs a
// week row to hang assignments on (mirrors PUT /schedule/driver-assignments).
export async function ensureWeekRow(weekStart: string): Promise<WeekRow> {
  const existing = await resolveWeekRow(weekStart);
  if (existing) return existing;
  const [row] = await db.insert(scheduleWeeksTable).values({ weekStart, status: "draft" }).returning();
  return row!;
}
