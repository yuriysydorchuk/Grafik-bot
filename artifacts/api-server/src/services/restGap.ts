// Відпочинок між змінами одного працівника. Дві зміни в один день (1+2) або
// нічна → ранкова наступного дня — дозволені, але якщо пауза між кінцем однієї
// та стартом іншої менша за MIN_REST_HOURS, графікова бачить помаранчеве
// попередження (веб дублює цю ж логіку для підсвітки картки — Schedule.tsx).
import type { ShiftTime } from "./shiftOverrides";

export const MIN_REST_HOURS = 5;

export type MinInterval = { start: number; end: number }; // хвилини від Пн 00:00 тижня

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

// Інтервал зміни у хвилинах від початку тижня; нічна (end <= start) — через північ.
export function shiftIntervalMin(dayIndex: number, time: ShiftTime): MinInterval {
  const start = dayIndex * 24 * 60 + toMin(time.start);
  let dur = toMin(time.end) - toMin(time.start);
  if (dur <= 0) dur += 24 * 60;
  return { start, end: start + dur };
}

// Найменша пауза (год) між target та будь-якою з others; відʼємна = перетин.
// null — інших змін у радіусі доби немає (жодного попередження).
export function minRestGapHours(target: MinInterval, others: MinInterval[]): number | null {
  let min: number | null = null;
  for (const o of others) {
    // пауза між двома інтервалами (відʼємна при перетині)
    const gap = Math.max(o.start - target.end, target.start - o.end);
    if (gap > 24 * 60) continue;
    if (min === null || gap < min) min = gap;
  }
  return min === null ? null : Math.round((min / 60) * 10) / 10;
}
