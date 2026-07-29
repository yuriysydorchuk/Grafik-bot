// Правила фабричних ставок для резолюції (пара посади людини → найдешевша
// посада фабрики → базова пара фабрики) — спільне джерело для сводної і
// «Обліку годин»: обидва рахують ставку через resolveBaseRates(профіль, rules).
import { db, factoriesTable, factoryPositionsTable } from "@workspace/db";
import type { RateRules } from "./svodni";

export async function loadRateRules(): Promise<(factoryId: number | null, positionId: number | null) => RateRules> {
  const [facs, fps] = await Promise.all([
    db.select().from(factoriesTable),
    db.select().from(factoryPositionsTable),
  ]);
  const facById = new Map(facs.map(f => [f.id, f]));
  const pair = (b: number | null | undefined, n: number | null | undefined) =>
    b != null ? { brutto: b, netto: n ?? null } : null;
  const posPair = new Map<string, { brutto: number; netto: number | null }>();
  const cheapest = new Map<number, { brutto: number; netto: number | null }>();
  for (const fp of fps) {
    const p = pair(fp.rate, fp.rateNetto);
    if (!p) continue;
    posPair.set(`${fp.factoryId}|${fp.positionId}`, p as any);
    const cur = cheapest.get(fp.factoryId);
    if (!cur || p.brutto! < cur.brutto) cheapest.set(fp.factoryId, p as any);
  }
  return (factoryId, positionId) => {
    if (factoryId == null) return {};
    const fac = facById.get(factoryId);
    return {
      position: positionId != null ? posPair.get(`${factoryId}|${positionId}`) ?? null : null,
      cheapestPosition: cheapest.get(factoryId) ?? null,
      factory: fac ? pair(fac.rateBrutto, fac.rateNetto) : null,
    };
  };
}
