// Pure date-string helpers. The production server runs in Europe/Berlin, so building a
// YYYY-MM-DD via `new Date(...).toISOString()` truncates to the wrong day near midnight —
// every function here formats from the LOCAL date parts instead. Kept dependency-free
// (type-only DB import) so it is trivially unit-testable.
import type { DayOfWeek } from "@workspace/db";

export const DAYS: DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// Format a Date as YYYY-MM-DD from its local calendar parts (never via toISOString).
function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Actual calendar date (YYYY-MM-DD) of a schedule entry = its week's Monday + day offset.
// Month-scoped reports must attribute each shift to the month of its real date, not the
// week's Monday — otherwise a week straddling the boundary (e.g. Mon 29 Jun–Sun 5 Jul)
// counts entirely under June and July shows empty until the next full week.
// A null/unknown day falls back to the Monday (offset 0).
export function entryDateStr(weekStart: string, day: string | null): string {
  const d = new Date(String(weekStart) + "T00:00:00");
  d.setDate(d.getDate() + Math.max(0, DAYS.indexOf(day as DayOfWeek)));
  return fmt(d);
}

// Lower bound for the week filter: any week whose Monday is up to 6 days before the month
// start can still contain days that fall inside the month.
export function weekFromForMonth(monthStart: string): string {
  const d = new Date(monthStart + "T00:00:00");
  d.setDate(d.getDate() - 6);
  return fmt(d);
}

// Add (or subtract) whole days to a YYYY-MM-DD string, returning a YYYY-MM-DD string.
export function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return fmt(d);
}
