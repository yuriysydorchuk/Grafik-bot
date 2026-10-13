// Зняття частинами (бадання/одяг) — превʼю розбивки у формах. Дзеркало
// api-server/src/lib/installments.ts (ділення до копійки, залишок у першу).
export const MAX_PARTS = 12;
export type InstallmentPlan = { parts: number; firstMonth: string };

export const curMonthWarsaw = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" }).slice(0, 7);

export function monthPlus(month: string, k: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y! * 12 + (m! - 1) + k;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function splitAmount(total: number, parts: number): number[] {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / parts);
  const rest = cents - base * parts;
  return Array.from({ length: parts }, (_, i) => Math.round(base + (i < rest ? 1 : 0)) / 100);
}

// «2026-11» → «11.26» для бейджів
export const fmtMonthShort = (m: string) => `${m.slice(5, 7)}.${m.slice(2, 4)}`;
