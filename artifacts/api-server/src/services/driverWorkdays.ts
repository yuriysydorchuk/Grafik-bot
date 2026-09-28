// Planned trips of a driver on a calendar date: distinct (factory, shift, kind)
// driver assignments dated that day, plus pickups of OVERNIGHT shifts assigned the
// day before (the driver actually collects those people this morning). This is the
// same set GET /mileage attaches to the day's workday rows, so the bot uses it to
// detect an OFF-PLAN run: when the driver opens more workdays today than there are
// planned trips, the extra run has no factory to inherit and the driver is asked.
import { db, driverShiftAssignmentsTable, factoriesTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { DAYS, addDaysStr } from "../lib/dates";
import { factoryShifts } from "../bot/time";
import { resolveWeekRow } from "./weeks";
import { loadDateShiftOverrides, shiftOverrideKey } from "./shiftOverrides";

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

function weekSlot(date: string): { weekStart: string; day: (typeof DAYS)[number] } {
  const idx = (new Date(date + "T00:00:00").getDay() + 6) % 7; // 0 = Monday
  return { weekStart: addDaysStr(date, -idx), day: DAYS[idx]! };
}

async function assignmentsOn(driverId: number, date: string) {
  const { weekStart, day } = weekSlot(date);
  const week = await resolveWeekRow(weekStart);
  if (!week) return [];
  return db
    .select({ factoryId: driverShiftAssignmentsTable.factoryId, shift: driverShiftAssignmentsTable.shift, kind: driverShiftAssignmentsTable.kind })
    .from(driverShiftAssignmentsTable)
    .where(and(eq(driverShiftAssignmentsTable.weekId, week.id), eq(driverShiftAssignmentsTable.dayOfWeek, day), eq(driverShiftAssignmentsTable.driverId, driverId)));
}

// Is the pickup of this assignment an overnight one (shift ends after midnight)?
// Such a pickup is done the NEXT morning — the report moves it to the next date.
async function overnightPickups(items: { factoryId: number; shift: string; kind: string }[], date: string): Promise<Set<string>> {
  const out = new Set<string>();
  const pickups = items.filter(a => a.kind === "pickup");
  if (!pickups.length) return out;
  const facs = await db.select({ id: factoriesTable.id, shifts: factoriesTable.shifts, shift1Start: factoriesTable.shift1Start, shift2Start: factoriesTable.shift2Start, shift3Start: factoriesTable.shift3Start })
    .from(factoriesTable).where(inArray(factoriesTable.id, [...new Set(pickups.map(a => a.factoryId))]));
  const facById = new Map(facs.map(f => [f.id, f]));
  const ov = await loadDateShiftOverrides(date);
  for (const a of pickups) {
    const st = ov.get(shiftOverrideKey(a.factoryId, date, a.shift)) ?? factoryShifts(facById.get(a.factoryId))[Number(a.shift) - 1];
    if (st && toMin(st.end) <= toMin(st.start)) out.add(`${a.factoryId}|${a.shift}`);
  }
  return out;
}

export async function plannedTripCount(driverId: number, date: string): Promise<number> {
  const keys = new Set<string>(); // date-qualified, so yesterday's and today's rows never collapse
  const today = await assignmentsOn(driverId, date);
  const todayOvernight = await overnightPickups(today, date);
  for (const a of today) {
    if (a.kind === "pickup" && todayOvernight.has(`${a.factoryId}|${a.shift}`)) continue; // happens tomorrow morning
    keys.add(`${date}|${a.factoryId}|${a.shift}|${a.kind}`);
  }
  const yesterday = addDaysStr(date, -1);
  const prev = await assignmentsOn(driverId, yesterday);
  for (const k of await overnightPickups(prev, yesterday)) keys.add(`${yesterday}|${k}|pickup`); // collected this morning
  return keys.size;
}
