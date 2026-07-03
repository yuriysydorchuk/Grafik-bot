// Driver roster housekeeping shared by the web API and the bot.
import { db } from "@workspace/db";
import { driversTable, driverShiftAssignmentsTable, scheduleWeeksTable } from "@workspace/db";
import { eq, and, gte, inArray } from "drizzle-orm";
import { getCurrentMonday } from "./scheduleGenerator";

// Soft-delete a driver the same way the web panel does: keep the row (history,
// trips, mileage) but free the Telegram id / invite code and drop head status.
export async function deactivateDriver(driverId: number) {
  await db.update(driversTable)
    .set({ isActive: false, telegramId: null, inviteCode: null, isHeadDriver: false })
    .where(eq(driversTable.id, driverId));
}

// A removed driver must disappear from the schedule: delete their assignments
// for the current and future weeks (past weeks stay for history/stats).
export async function removeDriverUpcomingAssignments(driverId: number): Promise<number> {
  const weeks = await db.select({ id: scheduleWeeksTable.id }).from(scheduleWeeksTable)
    .where(gte(scheduleWeeksTable.weekStart, getCurrentMonday()));
  if (weeks.length === 0) return 0;
  const gone = await db.delete(driverShiftAssignmentsTable).where(and(
    eq(driverShiftAssignmentsTable.driverId, driverId),
    inArray(driverShiftAssignmentsTable.weekId, weeks.map(w => w.id)),
  )).returning({ id: driverShiftAssignmentsTable.id });
  return gone.length;
}
