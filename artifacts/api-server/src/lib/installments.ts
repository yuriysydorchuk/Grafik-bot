// Зняття частинами (залічки за бадання, одяг): сума ділиться на N рівних частин
// до копійки (залишок копійок — у першу), частина k належить місяцю
// firstMonth + (k−1). Чисті функції без БД — спільні для admin-api/clothing;
// веб-превʼю — дзеркало в web/src/lib/installments.ts (тримати синхронно).
export const MAX_PARTS = 12;

export type InstallmentPlan = { parts: number; firstMonth: string };

const r2 = (n: number) => Math.round(n * 100) / 100;

export const warsawMonth = (): string =>
  new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" }).slice(0, 7);

export const isMonth = (v: unknown): v is string => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

export function monthPlus(month: string, k: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y! * 12 + (m! - 1) + k;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

// 100 / 3 → [33.34, 33.33, 33.33]; сума частин завжди = сумі
export function splitAmount(total: number, parts: number): number[] {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / parts);
  const rest = cents - base * parts;
  return Array.from({ length: parts }, (_, i) => r2((base + (i < rest ? 1 : 0)) / 100));
}

// body.parts (1..MAX_PARTS, типово 1 = зразу) + body.firstMonth (YYYY-MM, типово
// поточний місяць Варшави). Повертає рядок помилки замість плану, якщо ввід поганий.
export function parseInstallments(body: any): InstallmentPlan | string {
  const raw = body?.parts;
  const parts = raw === undefined || raw === null || raw === "" ? 1 : Number(raw);
  if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) return `Кількість частин — ціле число 1..${MAX_PARTS}`;
  const fm = body?.firstMonth;
  if (fm !== undefined && fm !== null && fm !== "" && !isMonth(fm)) return "firstMonth=YYYY-MM";
  return { parts, firstMonth: isMonth(fm) ? fm : warsawMonth() };
}

// Рядки-частини для вставки: amount/dueMonth/partNo/partsTotal. Одна частина =
// due_month NULL («зразу», поведінка до фічі).
export function installmentRows(total: number, plan: InstallmentPlan): { amount: number; dueMonth: string | null; partNo: number | null; partsTotal: number | null }[] {
  if (plan.parts <= 1) return [{ amount: r2(total), dueMonth: null, partNo: null, partsTotal: null }];
  return splitAmount(total, plan.parts).map((amount, i) => ({
    amount, dueMonth: monthPlus(plan.firstMonth, i), partNo: i + 1, partsTotal: plan.parts,
  }));
}

// Чи частина вже «настала» для сводної місяця month (NULL = завжди)
export const dueBy = (dueMonth: string | null | undefined, month: string): boolean => dueMonth == null || dueMonth <= month;
