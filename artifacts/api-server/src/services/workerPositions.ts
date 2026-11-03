// Посада людини ПО ФАБРИЦІ (зголошення #12, рішення власника 03.11.2026). Єдине місце, де резолвиться
// «яка посада в людини на цій фабриці»: рядок worker_factory_positions пари → workers.position_id
// (профільна посада — діє на всіх фабриках без власного значення, як було до 03.11).
// Від посади на фабриці: секція й ставка сводної, ставка в обліку годин/P&L/балансі, {%Stanowisko%}
// і {%Czynności%} в умові, KZiS/Stanowisko powiadomienia, посада в графіку й Excel клієнту.
// Голий w.positionId у таких місцях — регресія для людей з різними посадами на фабриках.
import { db, workerFactoryPositionsTable } from "@workspace/db";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

/** factoryId → positionId (лише явно задані для пари) */
export type PositionByFactory = Map<number, number>;

/** workerId → (factoryId → positionId); без аргументу — усі. */
export async function loadFactoryPositions(workerIds?: Iterable<number>): Promise<Map<number, PositionByFactory>> {
  const ids = workerIds ? [...new Set(workerIds)] : null;
  if (ids && !ids.length) return new Map();
  const rows = await db.select({ workerId: workerFactoryPositionsTable.workerId, factoryId: workerFactoryPositionsTable.factoryId, positionId: workerFactoryPositionsTable.positionId })
    .from(workerFactoryPositionsTable).where(ids ? inArray(workerFactoryPositionsTable.workerId, ids) : undefined);
  const out = new Map<number, PositionByFactory>();
  for (const r of rows) (out.get(r.workerId) ?? out.set(r.workerId, new Map()).get(r.workerId)!).set(r.factoryId, r.positionId);
  return out;
}

/** Посада для пари людина × фабрика: свій рядок фабрики → профільна посада. */
export function resolvePositionId(profilePositionId: number | null | undefined, byFactory: PositionByFactory | undefined, factoryId: number | null | undefined): number | null {
  if (factoryId != null && byFactory?.has(factoryId)) return byFactory.get(factoryId)!;
  return profilePositionId ?? null;
}

/** Одна пара (поодинокі місця: генерація умови, payload powiadomienia). */
export async function positionForFactory(workerId: number, profilePositionId: number | null | undefined, factoryId: number | null | undefined): Promise<number | null> {
  if (factoryId == null) return profilePositionId ?? null;
  const [r] = await db.select({ positionId: workerFactoryPositionsTable.positionId }).from(workerFactoryPositionsTable)
    .where(and(eq(workerFactoryPositionsTable.workerId, workerId), eq(workerFactoryPositionsTable.factoryId, factoryId)));
  return r?.positionId ?? profilePositionId ?? null;
}

/** SQL-вираз ефективної посади для запитів з join-ом людини й фабрики (графік, Excel, фінанси, лічильники). */
export function effectivePositionSql(workerIdCol: AnyColumn | SQL, factoryIdCol: AnyColumn | SQL, profilePositionCol: AnyColumn | SQL): SQL<number | null> {
  return sql<number | null>`coalesce((select wfp.position_id from worker_factory_positions wfp where wfp.worker_id = ${workerIdCol} and wfp.factory_id = ${factoryIdCol}), ${profilePositionCol})`;
}

/** Записати посаду людини на фабриці; null = прибрати (назад до профільної). */
export async function setFactoryPosition(workerId: number, factoryId: number, positionId: number | null, adminId: number | null): Promise<void> {
  if (positionId == null) {
    await db.delete(workerFactoryPositionsTable).where(and(eq(workerFactoryPositionsTable.workerId, workerId), eq(workerFactoryPositionsTable.factoryId, factoryId)));
    return;
  }
  const set = { positionId, updatedBy: adminId, updatedAt: new Date() };
  await db.insert(workerFactoryPositionsTable).values({ workerId, factoryId, ...set })
    .onConflictDoUpdate({ target: [workerFactoryPositionsTable.workerId, workerFactoryPositionsTable.factoryId], set });
}
