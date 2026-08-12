// Правила фабричних ставок для резолюції (пара посади людини → найдешевша
// посада фабрики → базова пара фабрики) — спільне джерело для сводної і
// «Обліку годин»: обидва рахують ставку через resolveBaseRates(профіль, rules).
import { db, factoriesTable, factoryPositionsTable, positionsTable } from "@workspace/db";
import type { RateRules } from "./svodni";

export async function loadRateRules(): Promise<(factoryId: number | null, positionId: number | null) => RateRules> {
  const [facs, fps, poss] = await Promise.all([
    db.select().from(factoriesTable),
    db.select().from(factoryPositionsTable),
    db.select().from(positionsTable),
  ]);
  const facById = new Map(facs.map(f => [f.id, f]));
  const posName = new Map(poss.map(p => [p.id, p.name]));
  const pair = (b: number | null | undefined, n: number | null | undefined) =>
    b != null ? { brutto: b, netto: n ?? null } : null;
  const posPair = new Map<string, { brutto: number; netto: number | null }>();
  const cheapest = new Map<number, { brutto: number; netto: number | null; positionId: number }>();
  // тай-брейк при однаковій ставці — алфавіт назв (pl), не порядок вставки:
  // у Sushi три посади по 31,40 — «звичайним працівником» має бути Pracownik,
  // а не випадковий Reepack (секція безпосадних рядків будується звідси)
  const collator = new Intl.Collator("pl");
  for (const fp of fps) {
    const p = pair(fp.rate, fp.rateNetto);
    if (!p) continue;
    posPair.set(`${fp.factoryId}|${fp.positionId}`, p as any);
    const cur = cheapest.get(fp.factoryId);
    if (!cur || p.brutto! < cur.brutto
      || (p.brutto! === cur.brutto && collator.compare(posName.get(fp.positionId) ?? "", posName.get(cur.positionId) ?? "") < 0)) {
      cheapest.set(fp.factoryId, { ...p, positionId: fp.positionId } as any);
    }
  }
  return (factoryId, positionId) => {
    if (factoryId == null) return {};
    const fac = facById.get(factoryId);
    const cheap = cheapest.get(factoryId);
    return {
      position: positionId != null ? posPair.get(`${factoryId}|${positionId}`) ?? null : null,
      cheapestPosition: cheap ? { brutto: cheap.brutto, netto: cheap.netto } : null,
      cheapestPositionId: cheap?.positionId ?? null,
      factory: fac ? pair(fac.rateBrutto, fac.rateNetto) : null,
    };
  };
}
