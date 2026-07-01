import type { DayOfWeek, Shift } from "@workspace/db";

// Drivers/workers operate in Polish time.
export const DRIVER_TZ = "Europe/Warsaw";

// "now" as a wall-clock Date in Warsaw time (getHours()/getDay() reflect Warsaw)
export function nowWarsaw(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: DRIVER_TZ }));
}

// Today's date in Warsaw as YYYY-MM-DD
export function warsawDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: DRIVER_TZ });
}

// The month (YYYY-MM) a monthly report currently belongs to. Reports are collected in a
// window around the month boundary: in the first 7 days of a month the report is still for
// the PREVIOUS month; otherwise it's for the current month. Shared by the bot report flow
// and the office "remind about report" action so they never disagree.
export function reportMonthFor(now: Date = nowWarsaw()): string {
  const base = now.getDate() <= 7
    ? new Date(now.getFullYear(), now.getMonth() - 1, 1)
    : now;
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}`;
}

// Today's weekday in Warsaw as our DayOfWeek code
export function warsawDayName(): DayOfWeek {
  const short = new Date().toLocaleDateString("en-US", { timeZone: DRIVER_TZ, weekday: "short" });
  const map: Record<string, DayOfWeek> = { Sun: "sun", Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat" };
  return map[short] ?? "mon";
}

export const DEFAULT_SHIFT_START = "06:00";

// Build a Warsaw-wall-clock Date for today at (shiftStart − offsetMin)
export function shiftAnchor(now: Date, shiftStart: string, offsetMin: number): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(shiftStart);
  const h = m ? Number(m[1]) : 6;
  const min = m ? Number(m[2]) : 0;
  const dt = new Date(now);
  dt.setHours(h, min - offsetMin, 0, 0);
  return dt;
}

type ShiftTime = { start: string; end: string };
type FactoryShiftInfo = {
  shifts?: ShiftTime[] | null;
  shift1Start?: string | null; shift2Start?: string | null; shift3Start?: string | null;
};
const isTime = (v: unknown): v is string => typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v);

// Minutes since midnight for "HH:MM"
function toMin(t: string): number { const [h, m] = t.split(":").map(Number); return (h! * 60) + m!; }

// Resolved per-shift times for a factory: prefers the `shifts` JSON, falls back to
// legacy shift1/2/3 start columns (end = next shift's start, or +8h for the last).
export function factoryShifts(factory?: FactoryShiftInfo): ShiftTime[] {
  const js = factory?.shifts;
  if (Array.isArray(js) && js.length) return js.filter(s => isTime(s?.start) && isTime(s?.end));
  const starts = [factory?.shift1Start, factory?.shift2Start, factory?.shift3Start].filter(isTime);
  return starts.map((s, i) => ({ start: s, end: starts[i + 1] ?? `${String((toMin(s) / 60 + 8) % 24 | 0).padStart(2, "0")}:00` }));
}

export function factoryShiftStart(factory: FactoryShiftInfo | undefined, shift: Shift): string {
  return factoryShifts(factory)[Number(shift) - 1]?.start ?? DEFAULT_SHIFT_START;
}

// Duration of a shift in hours (handles overnight, e.g. 22:00–06:00 = 8h). Default 8.
export function factoryShiftHours(factory: FactoryShiftInfo | undefined, shift: Shift): number {
  const s = factoryShifts(factory)[Number(shift) - 1];
  if (!s) return 8;
  let diff = toMin(s.end) - toMin(s.start);
  if (diff <= 0) diff += 24 * 60; // crosses midnight
  return Math.round((diff / 60) * 100) / 100;
}
