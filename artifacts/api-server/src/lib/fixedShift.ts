// Закріплена зміна працівника на конкретний тиждень (23.10.2026).
// Без чергування — завжди fixedShift. З чергуванням (fixedShiftAlt + fixedShiftAnchor): у тиждень
// якоря і кожен другий від нього — fixedShift, у проміжні — fixedShiftAlt («цей тиждень у 2-гу,
// наступний у 1-шу, потім знов у 2-гу»). Єдине місце, де рахується парність: генератор графіку,
// профіль («цього тижня — …»). Дати — рядки YYYY-MM-DD, арифметика в UTC (без зсувів TZ).
export type FixedShiftFields = { fixedShift: string | null; fixedShiftAlt?: string | null; fixedShiftAnchor?: string | null };

const utcMs = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const WEEK_MS = 7 * 86_400_000;

/** Понеділок тижня, в який потрапляє дата (рядок → рядок). */
export function mondayOf(dateStr: string): string {
  const ms = utcMs(dateStr);
  const wd = (new Date(ms).getUTCDay() + 6) % 7; // пн=0 … нд=6
  return new Date(ms - wd * 86_400_000).toISOString().slice(0, 10);
}

/** Зміна людини на тиждень weekStart: "1".."6" або null (гнучка). */
export function fixedShiftForWeek(w: FixedShiftFields, weekStart: string): string | null {
  if (!w.fixedShift) return null;
  if (!w.fixedShiftAlt || !w.fixedShiftAnchor) return w.fixedShift;
  const weeks = Math.round((utcMs(mondayOf(weekStart)) - utcMs(mondayOf(w.fixedShiftAnchor))) / WEEK_MS);
  return ((weeks % 2) + 2) % 2 === 0 ? w.fixedShift : w.fixedShiftAlt;
}
