import { db } from "@workspace/db";
import {
  workersTable, factoryOrdersTable, availabilityTable,
  scheduleWeeksTable, scheduleEntriesTable, factoriesTable,
  type DayOfWeek, type Shift,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { normalizeFullName } from "./sheets";
import { DAYS } from "./sheets";

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

export async function generateSchedule(weekStart: string): Promise<ScheduleGenerationResult> {
  // Check if draft already exists for this week → delete it
  const existingWeeks = await db.select().from(scheduleWeeksTable)
    .where(and(eq(scheduleWeeksTable.weekStart, weekStart), eq(scheduleWeeksTable.status, "draft")));
  if (existingWeeks.length > 0) {
    await db.delete(scheduleEntriesTable).where(eq(scheduleEntriesTable.weekId, existingWeeks[0]!.id));
    await db.delete(scheduleWeeksTable).where(eq(scheduleWeeksTable.id, existingWeeks[0]!.id));
  }

  // Create new schedule week
  const [newWeek] = await db.insert(scheduleWeeksTable).values({ weekStart, status: "draft" }).returning();
  const weekId = newWeek!.id;

  // Load all active workers
  const allWorkers = await db.select().from(workersTable).where(eq(workersTable.isActive, true));

  // Load all availability for this week
  const allAvailability = await db.select().from(availabilityTable)
    .where(eq(availabilityTable.weekStart, weekStart));

  // Load all factory orders for this week
  const allOrders = await db
    .select({ id: factoryOrdersTable.id, factoryId: factoryOrdersTable.factoryId, factoryName: factoriesTable.name, day: factoryOrdersTable.dayOfWeek, shift: factoryOrdersTable.shift, needed: factoryOrdersTable.workersNeeded })
    .from(factoryOrdersTable)
    .leftJoin(factoriesTable, eq(factoryOrdersTable.factoryId, factoriesTable.id))
    .where(eq(factoryOrdersTable.weekStart, weekStart));

  const shortages: ShortageInfo[] = [];
  const warnings: string[] = [];

  // Track per worker: days assigned this week, shifts per day
  const workerDaysAssigned: Map<number, Set<DayOfWeek>> = new Map();
  const workerDayShifts: Map<string, Shift> = new Map(); // key: workerId-day

  allWorkers.forEach(w => workerDaysAssigned.set(w.id, new Set()));

  // Match availability entries to worker IDs
  function findWorkerByName(fullNameRaw: string): typeof allWorkers[0] | undefined {
    const normalized = normalizeFullName(fullNameRaw);
    return allWorkers.find(w =>
      normalizeFullName(w.fullName) === normalized ||
      normalized.includes(normalizeFullName(w.fullName)) ||
      normalizeFullName(w.fullName).includes(normalized)
    );
  }

  // Build availability index: day+shift → list of worker IDs
  const availIndex: Map<string, number[]> = new Map();
  for (const av of allAvailability) {
    const worker = findWorkerByName(av.fullNameRaw);
    if (!worker) continue;
    const key = `${av.dayOfWeek}-${av.shift}`;
    if (!availIndex.has(key)) availIndex.set(key, []);
    availIndex.get(key)!.push(worker.id);
  }

  let totalAssigned = 0;

  // Process orders day by day, shift by shift
  for (const day of DAYS) {
    for (const shift of ["1", "2", "3"] as Shift[]) {
      const dayOrders = allOrders.filter(o => o.day === day && o.shift === shift && o.needed > 0);
      if (dayOrders.length === 0) continue;

      const availKey = `${day}-${shift}`;
      const availableWorkerIds = (availIndex.get(availKey) ?? []).filter(wid => {
        // Filter: max 6 days, no 2 shifts in same day
        const days = workerDaysAssigned.get(wid);
        if (!days) return false;
        if (days.size >= 6) return false;
        if (workerDayShifts.has(`${wid}-${day}`)) return false;
        return true;
      });

      // Sort by fewest days assigned (fairness)
      availableWorkerIds.sort((a, b) => {
        const daysA = workerDaysAssigned.get(a)?.size ?? 0;
        const daysB = workerDaysAssigned.get(b)?.size ?? 0;
        return daysA - daysB;
      });

      // Assign to each factory order for this day+shift
      let workerPool = [...availableWorkerIds];

      for (const order of dayOrders) {
        if (order.needed === 0) continue;

        const toAssign = workerPool.splice(0, order.needed);

        if (toAssign.length < order.needed) {
          shortages.push({
            factoryName: order.factoryName ?? "Unknown",
            day,
            shift,
            needed: order.needed,
            available: toAssign.length,
            shortage: order.needed - toAssign.length,
          });
        }

        for (const workerId of toAssign) {
          await db.insert(scheduleEntriesTable).values({
            weekId,
            workerId,
            factoryId: order.factoryId,
            dayOfWeek: day,
            shift,
            status: "scheduled",
          });
          workerDaysAssigned.get(workerId)!.add(day);
          workerDayShifts.set(`${workerId}-${day}`, shift);
          totalAssigned++;
        }
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

export function getNextMonday(): string {
  const today = new Date();
  const day = today.getDay();
  const diff = day === 0 ? 1 : 8 - day;
  const next = new Date(today);
  next.setDate(today.getDate() + diff);
  return next.toISOString().split("T")[0]!;
}

export function getCurrentMonday(): string {
  const today = new Date();
  const day = today.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(today);
  mon.setDate(today.getDate() + diff);
  return mon.toISOString().split("T")[0]!;
}
