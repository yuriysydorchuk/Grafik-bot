// Pickup-gap detection («Забрати зі зміни»): finds shifts whose workers have no
// one to take them home. Mirrors the per-cell logic in routes/admin-api.ts
// GET /driver-board (keep the rules in sync):
//   - a shift with workers is covered when a pickup assignment exists for it, OR
//     delivery drivers arrive for the shift that STARTS when it ends (same day;
//     the next day when the shift crosses midnight) with enough known seats;
//   - unknown seat capacity → assume enough (don't guess).
import { db } from "@workspace/db";
import {
  driversTable, factoriesTable, scheduleEntriesTable, driverShiftAssignmentsTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { factoryShifts } from "../bot/time";

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
  const factories = await db.select().from(factoriesTable);
  const drivers = await db.select({ id: driversTable.id, seats: driversTable.seats })
    .from(driversTable).where(eq(driversTable.isActive, true));
  const seatsOf = new Map(drivers.map(d => [d.id, d.seats]));

  const nextDay = DAY_ORDER[(DAY_ORDER.indexOf(day) + 1) % 7]!;
  const entries = await db
    .select({ factoryId: scheduleEntriesTable.factoryId, day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift })
    .from(scheduleEntriesTable).where(eq(scheduleEntriesTable.weekId, weekId));
  const assigns = await db
    .select({ factoryId: driverShiftAssignmentsTable.factoryId, day: driverShiftAssignmentsTable.dayOfWeek, shift: driverShiftAssignmentsTable.shift, driverId: driverShiftAssignmentsTable.driverId, kind: driverShiftAssignmentsTable.kind })
    .from(driverShiftAssignmentsTable).where(eq(driverShiftAssignmentsTable.weekId, weekId));

  const gaps: PickupGap[] = [];
  for (const f of factories) {
    const fShifts = factoryShifts(f);
    const n = Math.min(6, Math.max(1, f.shiftCount ?? fShifts.length ?? 1));
    const headcount = (d: string, sc: string) => entries.filter(e => e.factoryId === f.id && e.day === d && e.shift === sc).length;
    const assignsAt = (d: string, sc: string, kind: string) => assigns.filter(a => a.factoryId === f.id && a.day === d && a.shift === sc && a.kind === kind);

    for (let s = 1; s <= n; s++) {
      const st = fShifts[s - 1];
      const sc = String(s) as Shift;
      const people = headcount(day, sc);
      if (!st || people === 0) continue;
      if (assignsAt(day, sc, "pickup").length > 0) continue; // explicitly covered
      const crossesMidnight = toMin(st.end) <= toMin(st.start);
      const coverDay = crossesMidnight ? nextDay : day;
      const coverIdx = fShifts.findIndex(x => x.start === st.end);
      const covering = coverIdx >= 0 && headcount(coverDay, String(coverIdx + 1)) > 0
        ? assignsAt(coverDay, String(coverIdx + 1), "delivery") : [];
      if (covering.length === 0) {
        gaps.push({ factoryId: f.id, factoryName: f.name, day, shift: sc, end: st.end ?? null, people, seats: null, reason: "none" });
        continue;
      }
      const seatVals = covering.map(a => seatsOf.get(a.driverId));
      if (seatVals.some(v => v == null)) continue; // unknown capacity → don't guess
      const seats = seatVals.reduce<number>((a, b) => a + (b ?? 0), 0);
      if (seats < people) gaps.push({ factoryId: f.id, factoryName: f.name, day, shift: sc, end: st.end ?? null, people, seats, reason: "capacity" });
    }
  }
  return gaps;
}
