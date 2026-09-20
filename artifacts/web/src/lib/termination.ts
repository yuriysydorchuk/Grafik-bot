// Дзеркало api-server/src/lib/termination.ts: людину з виповідзенням не пропонуємо
// у графік на дату ≥ дати звільнення (з усіх фабрик або саме з цієї).
export interface TerminationLike { terminationDate?: string | null; terminationFactoryId?: number | null }

export function terminatedOn(w: TerminationLike, factoryId: number | null, date: string): boolean {
  const td = w.terminationDate ? w.terminationDate.slice(0, 10) : null;
  if (!td || td > date) return false;
  return w.terminationFactoryId == null || factoryId == null || w.terminationFactoryId === factoryId;
}
