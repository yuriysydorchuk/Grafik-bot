// Pickup-gap detection («Забрати зі зміни»): finds shifts whose workers have no
// one to take them home. Mirrors the per-cell logic in routes/admin-api.ts
// GET /driver-board (keep the rules in sync):
//   - a shift with workers is covered when a pickup assignment exists for it, OR
//     delivery drivers arrive for the shift that STARTS when it ends (same day;
//     the next day when the shift crosses midnight) with enough seats;
//   - exact capacities aren't tracked (vehicles rotate; the fleet is 9- and
//     20-seat buses) → an unknown vehicle counts as 20 seats, so a capacity gap
//     fires only when the headcount can't fit even into the largest buses.
import { db } from "@workspace/db";
import {
  driversTable, factoriesTable, scheduleEntriesTable, driverShiftAssignmentsTable, workersTable,
  shiftCancellationsTable, scheduleWeeksTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";
import { factoryShifts } from "../bot/time";
import { loadWeekShiftOverrides, overrideFor, type ShiftOverrideMap } from "./shiftOverrides";

export type PickupGap = {
  factoryId: number;
  factoryName: string;
  day: DayOfWeek;
  shift: Shift;
  end: string | null;       // when the shift ends (pickup time)
  people: number;
  seats: number | null;     // known seat total of the covering delivery (capacity gaps)
  reason: "none" | "capacity";
};

const DAY_ORDER: DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h! * 60 + m!; };

export async function detectPickupGaps(weekId: number, day: DayOfWeek): Promise<PickupGap[]> {
  // No agency transport → nobody to pick anyone up, a "gap" there is noise.
  const factories = await db.select().from(factoriesTable).where(eq(factoriesTable.usesTransport, true));
  // One-off per-day shift times (extra shifts / changed hours for a single date)
  const [weekRow] = await db.select({ weekStart: scheduleWeeksTable.weekStart })
    .from(scheduleWeeksTable).where(eq(scheduleWeeksTable.id, weekId));
  const weekStart = weekRow ? String(weekRow.weekStart) : null;
  const ov: ShiftOverrideMap = weekStart ? await loadWeekShiftOverrides(weekStart) : new Map();
  const drivers = await db.select({ id: driversTable.id, seats: driversTable.seats })
    .from(driversTable).where(eq(driversTable.isActive, true));
  const seatsOf = new Map(drivers.map(d => [d.id, d.seats]));

  const nextDay = DAY_ORDER[(DAY_ORDER.indexOf(day) + 1) % 7]!;
  // Self-transport workers get to work on their own → not counted toward pickup gaps.
  const entries = await db
    .select({ factoryId: scheduleEntriesTable.factoryId, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .where(and(eq(scheduleEntriesTable.weekId, weekId), ne(workersTable.selfTransport, true)));
  const assigns = await db
    .select({ factoryId: driverShiftAssignmentsTable.factoryId, day: driverShiftAssignmentsTable.dayOfWeek, shift: driverShiftAssignmentsTable.shift, driverId: driverShiftAssignmentsTable.driverId, kind: driverShiftAssignmentsTable.kind })
    .from(driverShiftAssignmentsTable).where(eq(driverShiftAssignmentsTable.weekId, weekId));
  // Cancelled cells have no run at all → no pickup to cover.
  const cancelledRows = await db
    .select({ factoryId: shiftCancellationsTable.factoryId, day: shiftCancellationsTable.dayOfWeek, shift: shiftCancellationsTable.shift })
    .from(shiftCancellationsTable).where(eq(shiftCancellationsTable.weekId, weekId));
  const cancelled = new Set(cancelledRows.map(c => `${c.factoryId}-${c.day}-${c.shift}`));

  const gaps: PickupGap[] = [];
  for (const f of factories) {
    const fShifts = factoryShifts(f);
    const n = Math.min(6, Math.max(1, f.shiftCount ?? fShifts.length ?? 1));
    const headcount = (d: string, sc: string) => entries.filter(e => e.factoryId === f.id && e.day === d && e.shift === sc).length;
    const assignsAt = (d: string, sc: string, kind: string) => assigns.filter(a => a.factoryId === f.id && a.day === d && a.shift === sc && a.kind === kind);
    // Effective time of a shift on a given day: one-off override first, then factory config.
    const effTime = (d: string, s: number) =>
      (weekStart ? overrideFor(ov, f.id, weekStart, d, s) : undefined) ?? fShifts[s - 1];

    // Shifts to check: the configured ones PLUS any shift that actually has entries
    // today (one-off shifts / entries outside the current shiftCount).
    const shiftNums = new Set<number>();
    for (let s = 1; s <= n; s++) shiftNums.add(s);
    for (const e of entries) if (e.factoryId === f.id && e.day === day) shiftNums.add(Number(e.shift));

    for (const s of [...shiftNums].sort((a, b) => a - b)) {
      const st = effTime(day, s);
      const sc = String(s) as Shift;
      const people = headcount(day, sc);
      if (!st || people === 0) continue;
      if (cancelled.has(`${f.id}-${day}-${sc}`)) continue;
      if (assignsAt(day, sc, "pickup").length > 0) continue; // explicitly covered
      const crossesMidnight = toMin(st.end) <= toMin(st.start);
      const coverDay = crossesMidnight ? nextDay : day;
      let coverShift = 0;
      for (let s2 = 1; s2 <= 6; s2++) { if (effTime(coverDay, s2)?.start === st.end) { coverShift = s2; break; } }
      const covering = coverShift > 0 && headcount(coverDay, String(coverShift)) > 0
        ? assignsAt(coverDay, String(coverShift), "delivery") : [];
      if (covering.length === 0) {
        gaps.push({ factoryId: f.id, factoryName: f.name, day, shift: sc, end: st.end ?? null, people, seats: null, reason: "none" });
        continue;
      }
      const seats = covering.reduce<number>((a, x) => a + (seatsOf.get(x.driverId) ?? 20), 0);
      if (seats < people) gaps.push({ factoryId: f.id, factoryName: f.name, day, shift: sc, end: st.end ?? null, people, seats, reason: "capacity" });
    }
  }
  return gaps;
}
