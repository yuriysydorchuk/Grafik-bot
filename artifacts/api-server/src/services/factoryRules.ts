// Фабричні правила konto/готівки сводної: завантаження версій з БД
// (factory_payout_rules) і резолюція «правило фабрики на місяць». Версія діє на
// сводну МІСЯЦЯ ЦІЛКОМ, у який потрапляє effective_from (найсвіжіша з
// effective_from ≤ кінець місяця). Фабрика без записів — legacyPayoutRule
// (колишній хардкод у services/svodni.ts); сідити БД свідомо не стали через
// розʼїзд id фабрик між локальною і прод-базами.
import { db, factoryPayoutRulesTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { legacyPayoutRule, monthEndStr, type PayoutRule } from "./svodni";

export type PayoutRuleRow = typeof factoryPayoutRulesTable.$inferSelect;

/** Сходинки стажу з jsonb — санітизація довільного вмісту БД. */
export function stazStepsOf(raw: unknown): { days: number; add: number }[] {
  if (!Array.isArray(raw)) return [];
  const steps: { days: number; add: number }[] = [];
  for (const s of raw) {
    const days = Number((s as any)?.days), add = Number((s as any)?.add);
    if (Number.isFinite(days) && days >= 0 && Number.isFinite(add)) steps.push({ days, add });
  }
  return steps.sort((a, z) => a.days - z.days);
}

export function ruleOfRow(row: PayoutRuleRow): PayoutRule {
  return {
    capH: row.capH, capHighH: row.capHighH, capThresholdH: row.capThresholdH, capFirm: row.capFirm,
    cashBonus: row.cashBonus, stazBonus: row.stazBonus, stazMinHours: row.stazMinHours,
    stazSteps: stazStepsOf(row.stazSteps), premiaCash: row.premiaCash,
  };
}

/**
 * Набір правил, завантажений раз на запит: `for(...)` — синхронна резолюція
 * для будь-якої пари фабрика+місяць (рядки сводної одного запиту гуляють по
 * місяцях/фабриках). null factoryId → legacy по label (рядки без привʼязки).
 */
export class PayoutRules {
  private byFactory = new Map<number, PayoutRuleRow[]>();
  constructor(rows: PayoutRuleRow[]) {
    for (const r of rows) {
      const list = this.byFactory.get(r.factoryId) ?? [];
      list.push(r);
      this.byFactory.set(r.factoryId, list);
    }
    for (const list of this.byFactory.values()) list.sort((a, z) => a.effectiveFrom.localeCompare(z.effectiveFrom));
  }

  /** Версійний рядок, чинний для місяця (без legacy-фолбеку); null = версій ще нема. */
  rowFor(factoryId: number | null | undefined, month: string): PayoutRuleRow | null {
    if (factoryId == null) return null;
    const list = this.byFactory.get(factoryId);
    if (!list?.length) return null;
    const end = monthEndStr(month);
    let hit: PayoutRuleRow | null = null;
    for (const r of list) {
      if (r.effectiveFrom <= end) hit = r;
      else break;
    }
    return hit;
  }

  /** Правило фабрики на місяць: версія з БД або legacy-фолбек. */
  for(factoryId: number | null | undefined, factoryLabel: string | null | undefined, month: string): PayoutRule {
    const row = this.rowFor(factoryId, month);
    return row ? ruleOfRow(row) : legacyPayoutRule(factoryId ?? null, factoryLabel ?? null);
  }

  /** Чи має фабрика хоч одну збережену версію (для UI «спадкові правила»). */
  hasRows(factoryId: number | null | undefined): boolean {
    return factoryId != null && (this.byFactory.get(factoryId)?.length ?? 0) > 0;
  }

  static async load(factoryIds?: number[]): Promise<PayoutRules> {
    if (factoryIds && !factoryIds.length) return new PayoutRules([]);
    const rows = factoryIds
      ? await db.select().from(factoryPayoutRulesTable).where(inArray(factoryPayoutRulesTable.factoryId, factoryIds))
      : await db.select().from(factoryPayoutRulesTable);
    return new PayoutRules(rows);
  }
}
