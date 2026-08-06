// Група виплати авансу «як у таблиці залічок»: дата затвердження (Warsaw wall clock)
// визначає, коли працівник отримає гроші — 1–14 → виплата 15-го цього місяця,
// 15–29 → 30-го цього місяця, 30–31 → 15-го наступного місяця.
// Групу можна перенести вручну (PATCH /advances/:id).
export type AdvancePayout = { payoutMonth: string; payoutGroup: "15" | "30" };

// dateStr — "YYYY-MM-DD" за Варшавою (bot/time.ts warsawDateStr)
export function payoutFor(dateStr: string): AdvancePayout {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error(`payoutFor: bad date "${dateStr}"`);
  const [, y, mo, d] = m;
  const day = Number(d);
  if (day <= 14) return { payoutMonth: `${y}-${mo}`, payoutGroup: "15" };
  if (day <= 29) return { payoutMonth: `${y}-${mo}`, payoutGroup: "30" };
  const next = Number(mo) === 12 ? `${Number(y) + 1}-01` : `${y}-${String(Number(mo) + 1).padStart(2, "0")}`;
  return { payoutMonth: next, payoutGroup: "15" };
}
