// Умови (агрименти) на /cost-invoices — щомісячна генерація agreement_charges
// (одноразова/на термін/безстрокова). Сума завжди брутто (кшєнгова вписує, як
// є на документі) — жодного розрахунку net→gross, vat_rate лише тег ставки.
// Ідемпотентно: рядок (agreementId, month) створюється лише якщо його ще нема —
// байдуже, active чи deleted (щоб видалений вручну місяць не воскресав).
import { db, agreementConditionsTable, agreementChargesTable, type AgreementCondition } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger";

export const VAT_RATES = ["23", "8", "zw"] as const;
export type VatRate = (typeof VAT_RATES)[number];

// «сьогодні» за локальним часом сервера (Europe/Berlin) — не toISOString
export function currentMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y!, mo!, 1); // mo вже 1-based наступний місяць (mo-1+1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// список YYYY-MM від from до to включно (захист від аномально довгого діапазону)
export function monthRange(from: string, to: string): string[] {
  if (from > to) return [];
  const out: string[] = [];
  let m = from;
  while (m <= to && out.length < 600) {
    out.push(m);
    m = nextMonth(m);
  }
  return out;
}

// чи діє умова в цьому місяці (чиста перевірка меж — без БД, зручно юніт-тестити)
export function inAgreementRange(condition: Pick<AgreementCondition, "active" | "startMonth" | "endMonth">, month: string): boolean {
  if (!condition.active) return false;
  if (month < condition.startMonth) return false;
  if (condition.endMonth != null && month > condition.endMonth) return false;
  return true;
}

export interface MaterializeResult { created: boolean; reason?: "inactive" | "out-of-range" | "exists" }

export async function materializeAgreementMonth(condition: AgreementCondition, month: string): Promise<MaterializeResult> {
  if (!inAgreementRange(condition, month)) {
    return { created: false, reason: !condition.active ? "inactive" : "out-of-range" };
  }
  const [existing] = await db.select({ id: agreementChargesTable.id }).from(agreementChargesTable)
    .where(and(eq(agreementChargesTable.agreementId, condition.id), eq(agreementChargesTable.month, month)));
  if (existing) return { created: false, reason: "exists" };
  await db.insert(agreementChargesTable).values({
    agreementId: condition.id, month, amount: condition.amount, source: "auto", status: "active",
  });
  return { created: true };
}

// Заднім числом при створенні умови кшєнгова сама обирає, які місяці зарахувати
// (POST /agreements {backfillMonths}) — на відміну від backfillCondition() це
// НЕ автоматичний повний діапазон, лише явно перелічені місяці в межах умови.
export async function materializeSelectedMonths(condition: AgreementCondition, months: string[]): Promise<number> {
  let created = 0;
  for (const month of months) {
    const res = await materializeAgreementMonth(condition, month);
    if (res.created) created++;
  }
  return created;
}

// Бекфіл після створення/продовження умови: усі місяці від startMonth до
// min(endMonth ?? поточний, поточний) — покриває одноразові (один місяць) і
// заднім числом заведені умови на термін.
export async function backfillCondition(condition: AgreementCondition): Promise<number> {
  const nowM = currentMonthStr();
  const to = condition.endMonth != null && condition.endMonth < nowM ? condition.endMonth : nowM;
  let created = 0;
  for (const month of monthRange(condition.startMonth, to)) {
    const res = await materializeAgreementMonth(condition, month);
    if (res.created) created++;
  }
  return created;
}

// Крон/ручний тригер за конкретний місяць — проходить усі активні умови.
export async function materializeMonth(month: string): Promise<{ processed: number; created: number }> {
  const conditions = await db.select().from(agreementConditionsTable).where(eq(agreementConditionsTable.active, true));
  let created = 0;
  for (const c of conditions) {
    const res = await materializeAgreementMonth(c, month);
    if (res.created) created++;
  }
  logger.info({ month, processed: conditions.length, created }, "agreement charges materialized");
  return { processed: conditions.length, created };
}
