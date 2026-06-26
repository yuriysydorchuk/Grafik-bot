import { db } from "@workspace/db";
import {
  workersTable, factoryOrdersTable, availabilityTable,
  scheduleWeeksTable, scheduleEntriesTable, factoriesTable, absenceRequestsTable,
  type DayOfWeek, type Shift, type OrderRequirement,
} from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { normalizeFullName } from "./sheets";
import { DAYS } from "./sheets";
import { factoryShifts, nowWarsaw } from "../bot/time";

export interface ShortageInfo {
  factoryName: string;
  day: DayOfWeek;
  shift: Shift;
  needed: number;
  available: number;
  shortage: number;
}

export interface ScheduleGenerationResult {
  weekId: number;
  totalAssigned: number;
  shortages: ShortageInfo[];
  warnings: string[];
}

export async function generateSchedule(weekStart: string, factoryId?: number): Promise<ScheduleGenerationResult> {
  // If generating for a specific factory, don't delete/recreate the whole week draft
  let weekId: number;
  // A (day,shift) slot is "locked" once its shift start time has passed — already-worked
  // shifts must NOT be wiped/regenerated. Default (full regen of a fresh week): nothing locked.
  let slotLocked: (day: DayOfWeek, shift: Shift) => boolean = () => false;
  let lockedEntries: { workerId: number; dayOfWeek: DayOfWeek; shift: Shift }[] = [];
  if (factoryId) {
    // Use the SAME week row the panel displays (approved preferred, else latest) so a
    // per-factory regeneration shows up immediately — never spawn a parallel draft.
    const candidates = await db.select().from(scheduleWeeksTable)
      .where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(desc(scheduleWeeksTable.id));
    let week = candidates.find(w => w.status === "approved") ?? candidates[0];
    if (!week) { [week] = await db.insert(scheduleWeeksTable).values({ weekStart, status: "draft" }).returning(); }
    weekId = week!.id;
    // Build the lock predicate from this factory's shift times
    const fac = (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0];
    const fShifts = factoryShifts(fac);
    const now = nowWarsaw().getTime();
    slotLocked = (day, shift) => {
      const idx = Math.max(0, DAYS.indexOf(day));
      const d = new Date(weekStart + "T00:00:00"); d.setDate(d.getDate() + idx);
      const start = fShifts[Number(shift) - 1]?.start ?? "06:00";
      const [hh, mm] = start.split(":").map(Number);
      d.setHours(hh || 6, mm || 0, 0, 0);
      return d.getTime() <= now;
    };
    // Keep already-worked entries; delete only the future (unlocked) ones.
    const existing = await db.select().from(scheduleEntriesTable)
      .where(and(eq(scheduleEntriesTable.weekId, weekId), eq(scheduleEntriesTable.factoryId, factoryId)));
    lockedEntries = existing.filter(e => slotLocked(e.dayOfWeek as DayOfWeek, e.shift as Shift))
      .map(e => ({ workerId: e.workerId, dayOfWeek: e.dayOfWeek as DayOfWeek, shift: e.shift as Shift }));
    const toDelete = existing.filter(e => !slotLocked(e.dayOfWeek as DayOfWeek, e.shift as Shift)).map(e => e.id);
    if (toDelete.length) await db.delete(scheduleEntriesTable).where(inArray(scheduleEntriesTable.id, toDelete));
  } else {
    // Full regeneration — delete existing draft
    const existingWeeks = await db.select().from(scheduleWeeksTable)
      .where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "draft")));
    if (existingWeeks.length > 0) {
      await db.delete(scheduleEntriesTable).where(eq(scheduleEntriesTable.weekId, existingWeeks[0]!.id));
      await db.delete(scheduleWeeksTable).where(eq(scheduleWeeksTable.id, existingWeeks[0]!.id));
    }
    const [newWeek] = await db.insert(scheduleWeeksTable).values({ weekStart, status: "draft" }).returning();
    weekId = newWeek!.id;
  }

  // Load all active workers
  const allWorkers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));

  // Load all availability for this week
  const allAvailability = await db.select().from(availabilityTable)
    .where(eq(availabilityTable.weekStart, weekStart));

  // Load factory orders — filtered by factoryId if provided
  const ordersQuery = db
    .select({ id: factoryOrdersTable.id, factoryId: factoryOrdersTable.factoryId, factoryName: factoriesTable.name, day: factoryOrdersTable.dayOfWeek, shift: factoryOrdersTable.shift, needed: factoryOrdersTable.workersNeeded, requirements: factoryOrdersTable.requirements })
    .from(factoryOrdersTable)
    .leftJoin(factoriesTable, eq(factoryOrdersTable.factoryId, factoriesTable.id));

  const allOrders = factoryId
    ? await ordersQuery.where(and(eq(factoryOrdersTable.weekStart, weekStart), eq(factoryOrdersTable.factoryId, factoryId)))
    : await ordersQuery.where(eq(factoryOrdersTable.weekStart, weekStart));

  const shortages: ShortageInfo[] = [];
  const warnings: string[] = [];

  // Track per worker: days assigned this week, shifts per day
  const workerDaysAssigned: Map<number, Set<DayOfWeek>> = new Map();
  const workerDayShifts: Map<string, Shift> = new Map(); // key: workerId-day
  // The shift a worker is already settled into this week — used to keep someone on the
  // SAME shift for the whole week when possible (less disruption).
  const workerWeekShift: Map<number, Shift> = new Map();

  allWorkers.forEach(w => workerDaysAssigned.set(w.id, new Set()));
  // Respect already-worked (locked) shifts: count them so workers aren't double-booked
  for (const e of lockedEntries) {
    workerDaysAssigned.get(e.workerId)?.add(e.dayOfWeek);
    workerDayShifts.set(`${e.workerId}-${e.dayOfWeek}`, e.shift);
    if (!workerWeekShift.has(e.workerId)) workerWeekShift.set(e.workerId, e.shift);
  }

  // Match availability entries to worker IDs
  function findWorkerByName(fullNameRaw: string): typeof allWorkers[0] | undefined {
    const normalized = normalizeFullName(fullNameRaw);
    return allWorkers.find(w =>
      normalizeFullName(w.fullName) === normalized ||
      normalized.includes(normalizeFullName(w.fullName)) ||
      normalizeFullName(w.fullName).includes(normalized)
    );
  }

  // Factory settings (shift count + generation mode)
  const factoryRows = await db.select({ id: factoriesTable.id, usesAvailability: factoriesTable.usesAvailability, genMode: factoriesTable.genMode, shiftCount: factoriesTable.shiftCount }).from(factoriesTable);
  const factorySettings = new Map<number, typeof factoryRows[number]>(factoryRows.map(f => [f.id, f]));

  // Workers who reported an absence (not rejected) → never schedule them for that day+shift.
  const absenceRows = await db.select({ workerId: absenceRequestsTable.workerId, day: absenceRequestsTable.dayOfWeek, shift: absenceRequestsTable.shift, status: absenceRequestsTable.status })
    .from(absenceRequestsTable).where(eq(absenceRequestsTable.weekStart, weekStart));
  const absentSet = new Set<string>(); // `${workerId}-${day}-${shift}`
  for (const a of absenceRows) if (a.status !== "rejected") absentSet.add(`${a.workerId}-${a.day}-${a.shift}`);

  // Build the candidate pool PER FACTORY: factoryId → ("day-shift" → set of worker IDs).
  //  • usesAvailability: workers of that factory who reported availability for that day+shift
  //    (prefer resolved workerId; fall back to name matching for legacy rows; deduped).
  //  • manual factory: ALL active workers of the factory, for every day and every active shift.
  const workerById = new Map(allWorkers.map(w => [w.id, w]));
  const availByFactory: Map<number, Map<string, Set<number>>> = new Map();
  const poolFor = (fId: number, key: string) => {
    let m = availByFactory.get(fId);
    if (!m) { m = new Map(); availByFactory.set(fId, m); }
    let s = m.get(key);
    if (!s) { s = new Set(); m.set(key, s); }
    return s;
  };

  // Which factories do we need pools for? (the ones with orders this run)
  const targetFactoryIds = new Set<number>(allOrders.map(o => o.factoryId as number));
  for (const fId of targetFactoryIds) {
    const settings = factorySettings.get(fId);
    if (settings && settings.usesAvailability === false) {
      // manual factory → all active workers of this factory. A worker with a `fixedShift`
      // is only offered to that shift (handles "give everyone, split across shifts"); a
      // flexible worker (no fixedShift) is offered to every active shift.
      const count = settings.shiftCount ?? 3;
      const active = allWorkers.filter(w => w.factoryId === fId);
      for (const day of DAYS) {
        for (let s = 1; s <= count; s++) {
          const set = poolFor(fId, `${day}-${s}`);
          for (const w of active) {
            if (w.fixedShift && Number(w.fixedShift) !== s) continue;
            set.add(w.id);
          }
        }
      }
    }
  }
  // availability-based pools
  for (const av of allAvailability) {
    const worker = (av.workerId != null ? workerById.get(av.workerId) : undefined) ?? findWorkerByName(av.fullNameRaw);
    if (!worker || !worker.factoryId) continue;
    if (factorySettings.get(worker.factoryId)?.usesAvailability === false) continue; // manual factory ignores availability
    poolFor(worker.factoryId, `${av.dayOfWeek}-${av.shift}`).add(worker.id);
  }

  let totalAssigned = 0;

  // Process orders day by day, shift by shift — pool is resolved per factory order
  for (const day of DAYS) {
    for (const shift of ["1", "2", "3", "4", "5", "6"] as Shift[]) {
      // Never (re)generate a slot whose shift has already started — it's locked/worked.
      if (slotLocked(day, shift)) continue;
      const dayOrders = allOrders.filter(o => o.day === day && o.shift === shift && o.needed > 0);
      if (dayOrders.length === 0) continue;

      for (const order of dayOrders) {
        if (order.needed === 0) continue;

        // Split the order into requirement lines. No breakdown → one generic line for the
        // whole headcount. Process most-specific lines first (position, then gender) so
        // specialists are reserved for their slots before generic lines take "anyone".
        const lines: OrderRequirement[] = (order.requirements ?? []).length
          ? [...order.requirements!]
          : [{ positionId: null, gender: "any", count: order.needed }];
        const specificity = (l: OrderRequirement) => (l.positionId != null ? 2 : 0) + (l.gender !== "any" ? 1 : 0);
        lines.sort((a, b) => specificity(b) - specificity(a));

        const usedThisShift = new Set<number>(); // a worker fills at most one line in this shift
        let assignedHere = 0;

        for (const line of lines) {
          if (line.count <= 0) continue;
          const candidates = [...(availByFactory.get(order.factoryId)?.get(`${day}-${shift}`) ?? [])]
            .filter(wid => {
              if (usedThisShift.has(wid)) return false;
              if (absentSet.has(`${wid}-${day}-${shift}`)) return false; // reported absent
              const days = workerDaysAssigned.get(wid);
              if (!days) return false;
              if (days.size >= 6) return false;            // max 6 days
              if (workerDayShifts.has(`${wid}-${day}`)) return false; // no 2 shifts same day
              const w = workerById.get(wid);
              if (line.positionId != null && w?.positionId !== line.positionId) return false; // role must match
              if (line.gender !== "any" && w?.gender !== line.gender) return false;            // gender split
              return true;
            })
            // Prefer keeping someone on the shift they're already on this week (continuity),
            // then fairness (fewest days assigned so far).
            .sort((a, b) => {
              const ca = workerWeekShift.has(a) ? (workerWeekShift.get(a) === shift ? 0 : 2) : 1;
              const cb = workerWeekShift.has(b) ? (workerWeekShift.get(b) === shift ? 0 : 2) : 1;
              if (ca !== cb) return ca - cb;
              return (workerDaysAssigned.get(a)?.size ?? 0) - (workerDaysAssigned.get(b)?.size ?? 0);
            });

          const toAssign = candidates.slice(0, line.count);
          for (const workerId of toAssign) {
            await db.insert(scheduleEntriesTable).values({
              weekId, workerId, factoryId: order.factoryId, dayOfWeek: day, shift, status: "scheduled",
            });
            workerDaysAssigned.get(workerId)!.add(day);
            workerDayShifts.set(`${workerId}-${day}`, shift);
            if (!workerWeekShift.has(workerId)) workerWeekShift.set(workerId, shift);
            usedThisShift.add(workerId);
            assignedHere++;
            totalAssigned++;
          }
        }

        if (assignedHere < order.needed) {
          shortages.push({
            factoryName: order.factoryName ?? "Unknown",
            day, shift,
            needed: order.needed,
            available: assignedHere,
            shortage: order.needed - assignedHere,
          });
        }
      }
    }
  }

  // ── "all" mode: release EVERYONE (no orders) ───────────────────────────────────
  // Bound (fixedShift) workers go to their shift; the rest are spread to keep shifts as
  // even as possible. Absences are respected. Generates the standard Mon–Sat week.
  const ALL_DAYS: DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat"];
  const allModeFactories = factoryRows.filter(f =>
    f.genMode === "all" && (factoryId == null || f.id === factoryId));
  for (const fac of allModeFactories) {
    const count = Math.min(6, Math.max(1, fac.shiftCount ?? 3));
    const active = allWorkers.filter(w => w.factoryId === fac.id);
    for (const day of ALL_DAYS) {
      // current load per shift (1-based), seeded from already-locked/worked entries
      const load = Array.from({ length: count }, () => 0);
      for (const e of lockedEntries) {
        if (e.dayOfWeek === day) { const i = Number(e.shift) - 1; if (i >= 0 && i < count) load[i]!++; }
      }

      // 1) bound workers → their fixed shift
      for (const w of active) {
        if (workerDayShifts.has(`${w.id}-${day}`)) continue;       // already placed today
        if ((workerDaysAssigned.get(w.id)?.size ?? 0) >= 6) continue;
        const fs = w.fixedShift ? Number(w.fixedShift) : 0;
        if (!fs || fs < 1 || fs > count) continue;                 // unbound — handled below
        const shift = String(fs) as Shift;
        if (slotLocked(day, shift)) continue;
        if (absentSet.has(`${w.id}-${day}-${shift}`)) continue;    // absent that shift
        await db.insert(scheduleEntriesTable).values({ weekId, workerId: w.id, factoryId: fac.id, dayOfWeek: day, shift, status: "scheduled" });
        load[fs - 1]!++;
        workerDaysAssigned.get(w.id)!.add(day);
        workerDayShifts.set(`${w.id}-${day}`, shift);
        if (!workerWeekShift.has(w.id)) workerWeekShift.set(w.id, shift);
        totalAssigned++;
      }
      // 2) unbound workers → the least-loaded shift they're not absent for (prefer continuity)
      const unbound = active.filter(w =>
        !(w.fixedShift && Number(w.fixedShift) >= 1 && Number(w.fixedShift) <= count) &&
        !workerDayShifts.has(`${w.id}-${day}`) &&
        (workerDaysAssigned.get(w.id)?.size ?? 0) < 6);
      for (const w of unbound) {
        // candidate shifts: not locked, not absent
        const opts = Array.from({ length: count }, (_, i) => i)
          .filter(i => !slotLocked(day, String(i + 1) as Shift) && !absentSet.has(`${w.id}-${day}-${String(i + 1)}`));
        if (!opts.length) continue;
        const minLoad = Math.min(...opts.map(i => load[i]!));
        const wk = workerWeekShift.get(w.id);
        const wkIdx = wk ? Number(wk) - 1 : -1;
        // keep them on their week shift if it's still among the lightest (±0); else the lightest
        let pick = (wkIdx >= 0 && opts.includes(wkIdx) && load[wkIdx]! <= minLoad) ? wkIdx
          : opts.find(i => load[i]! === minLoad)!;
        const shift = String(pick + 1) as Shift;
        await db.insert(scheduleEntriesTable).values({ weekId, workerId: w.id, factoryId: fac.id, dayOfWeek: day, shift, status: "scheduled" });
        load[pick]!++;
        workerDaysAssigned.get(w.id)!.add(day);
        workerDayShifts.set(`${w.id}-${day}`, shift);
        if (!workerWeekShift.has(w.id)) workerWeekShift.set(w.id, shift);
        totalAssigned++;
      }
    }
  }

  return { weekId, totalAssigned, shortages, warnings };
}

// Add a manual worker to a schedule entry
export async function addManualEntry(weekId: number, workerId: number, factoryId: number, day: DayOfWeek, shift: Shift) {
  await db.insert(scheduleEntriesTable).values({
    weekId, workerId, factoryId, dayOfWeek: day, shift, status: "scheduled",
  });
}

export function formatWeekStart(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00");
  const end = new Date(d);
  end.setDate(d.getDate() + 6);
  const fmt = (date: Date) => date.toLocaleDateString("uk-UA", { day: "numeric", month: "numeric" });
  return `${fmt(d)} – ${fmt(end)}`;
}

// Local YYYY-MM-DD (never UTC — avoids off-by-one near midnight / across timezones)
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function getNextMonday(): string {
  const today = nowWarsaw();
  const day = today.getDay();
  const diff = day === 0 ? 1 : 8 - day;
  const next = new Date(today);
  next.setDate(today.getDate() + diff);
  return ymd(next);
}

export function getCurrentMonday(): string {
  const today = nowWarsaw();
  const day = today.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(today);
  mon.setDate(today.getDate() + diff);
  return ymd(mon);
}
