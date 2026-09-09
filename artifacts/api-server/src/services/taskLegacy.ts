// «Старі» працівники для автозадач (рішення власника 10.09.2026): модуль легалізації
// запустився 08.09.2026 з порожньою базою документів і умов. Працівник, доданий ДО
// дати запуску (settings.legacyBefore), у якого в системі досі немає жодного документа
// й жодної умови, — не «прострочений», а просто ще не заведений у модуль. Для нього
// движкові автозадачі (умова / бракує підстав / обовʼязки / review / powiadomienie) не
// створюються; щойно зʼявляється перший документ або умова — він у модулі, як усі.
// Події після запуску (звільнення, старт) гейт не зачіпає: ZWUA бере звільнених від дати
// запуску (taskAutoRules), а пропуски без пояснення — операційне правило без гейту.
import { and, inArray, ne } from "drizzle-orm";
import { db, workersTable, workerDocumentsTable, contractsTable } from "@workspace/db";
import { dateStr } from "./taskUtils";

export interface LegacyInput { createdAt: Date | string | null; hasDocs: boolean; hasContract: boolean }

// Чиста перевірка (юніт без БД): доданий до legacyBefore і без слідів у модулі.
export function isLegacyWorker(w: LegacyInput, legacyBefore: string | null | undefined): boolean {
  if (!legacyBefore) return false;
  const created = dateStr(w.createdAt);
  if (!created || created >= legacyBefore) return false;
  return !w.hasDocs && !w.hasContract;
}

// Множина id «старих» серед переданих (документи зі статусом ≠ missing та будь-яка умова = слід у модулі).
export async function loadLegacyWorkerIds(workerIds: number[], legacyBefore: string | null | undefined): Promise<Set<number>> {
  const out = new Set<number>();
  if (!legacyBefore || !workerIds.length) return out;
  const ws = await db.select({ id: workersTable.id, createdAt: workersTable.createdAt }).from(workersTable).where(inArray(workersTable.id, workerIds));
  const withDocs = new Set((await db.select({ workerId: workerDocumentsTable.workerId }).from(workerDocumentsTable)
    .where(and(inArray(workerDocumentsTable.workerId, workerIds), ne(workerDocumentsTable.status, "missing")))).map(d => d.workerId));
  const withContract = new Set((await db.select({ workerId: contractsTable.workerId }).from(contractsTable)
    .where(inArray(contractsTable.workerId, workerIds))).map(c => c.workerId));
  for (const w of ws) if (isLegacyWorker({ createdAt: w.createdAt, hasDocs: withDocs.has(w.id), hasContract: withContract.has(w.id) }, legacyBefore)) out.add(w.id);
  return out;
}
