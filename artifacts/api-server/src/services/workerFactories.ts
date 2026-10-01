// Фабрика в профілі працівника (рішення власника 01.10.2026): людина потрапляє в графік /
// посадку ЧУЖОЇ фабрики → фабрика додається в профіль як додаткова (worker_factories), щоб
// движок легальності вимагав на неї умову (вісь «умова» по кожному роботодавцю), задача
// contract пішла графіковій, а рядок сводної цієї фабрики рахувався «по фабриці». Веб питає
// підтвердження (409 factory_not_in_profile → addFactory: true), водій у боті — додає мовчки
// (людина вже відпрацювала там), офіс дістає сповіщення. Єдина точка: прямих INSERT у
// worker_factories з графіку не робимо.
import { db, workersTable, workerFactoriesTable, factoriesTable, companiesTable, workerChangesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { workerLegalityChanged } from "./documentEvents";
import { logger } from "../lib/logger";

const dateStr = (d: unknown): string | null => d == null ? null : String(d).slice(0, 10);

export interface FactoryBrief { factoryId: number; factoryName: string; companyId: number | null; companyName: string | null }

export async function factoryBrief(factoryId: number): Promise<FactoryBrief | null> {
  const [f] = await db.select({ id: factoriesTable.id, name: factoriesTable.name, companyId: factoriesTable.companyId, companyName: companiesTable.name })
    .from(factoriesTable).leftJoin(companiesTable, eq(factoriesTable.companyId, companiesTable.id)).where(eq(factoriesTable.id, factoryId));
  return f ? { factoryId: f.id, factoryName: f.name, companyId: f.companyId, companyName: f.companyName } : null;
}

// Чи фабрика «своя» на дату: основна в профілі або чинний рядок worker_factories
// (valid_from ≤ date < valid_to; порожні межі — без обмеження).
export async function factoryInProfile(workerId: number, factoryId: number, date: string): Promise<boolean> {
  const [w] = await db.select({ factoryId: workersTable.factoryId }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return false;
  if (w.factoryId === factoryId) return true;
  const [row] = await db.select().from(workerFactoriesTable).where(and(eq(workerFactoriesTable.workerId, workerId), eq(workerFactoriesTable.factoryId, factoryId)));
  if (!row) return false;
  const from = dateStr(row.validFrom), to = dateStr(row.validTo);
  return (!from || from <= date) && (!to || to > date);
}

// Додати фабрику в профіль як додаткову (ідемпотентно). Рядок, закритий раніше (valid_to у минулому —
// людину «виповіли» з цієї фабрики), відкривається знову. Фірма роботодавця не вгадується:
// одноконтрактна фабрика — фірма фабрики (движок бере сам), мультифірмова — движок попросить
// уточнити в профілі. Журнал worker_changes.factoryAdded + перерахунок легальності.
export async function ensureWorkerFactory(
  workerId: number, factoryId: number,
  opts: { date: string; adminId?: number | null; source: "web" | "driver" | "link" },
): Promise<{ added: boolean; brief: FactoryBrief | null }> {
  const brief = await factoryBrief(factoryId);
  if (!brief) return { added: false, brief: null };
  if (await factoryInProfile(workerId, factoryId, opts.date)) return { added: false, brief };
  const [existing] = await db.select().from(workerFactoriesTable).where(and(eq(workerFactoriesTable.workerId, workerId), eq(workerFactoriesTable.factoryId, factoryId)));
  if (existing) {
    const from = dateStr(existing.validFrom);
    await db.update(workerFactoriesTable).set({ validTo: null, validFrom: from && from > opts.date ? opts.date : existing.validFrom })
      .where(eq(workerFactoriesTable.id, existing.id));
  } else {
    await db.insert(workerFactoriesTable).values({ workerId, factoryId, validFrom: opts.date, note: opts.source === "web" ? "з графіку" : "з посадки водія" });
  }
  await db.insert(workerChangesTable).values({ workerId, field: "factoryAdded", oldValue: null, newValue: String(factoryId), effectiveDate: opts.date, adminId: opts.adminId ?? null })
    .catch(err => logger.error({ err }, "worker change journal (factoryAdded) failed"));
  await workerLegalityChanged(workerId);
  logger.info({ workerId, factoryId, source: opts.source, date: opts.date }, "factory added to worker profile from schedule");
  return { added: true, brief };
}
