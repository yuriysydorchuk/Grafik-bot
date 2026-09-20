// Виповідзення (workers.termination_date, опційно по одній фабриці termination_factory_id):
// до самої дати людина активна, але СТАВИТИ її в графік на дату ≥ дати звільнення
// не можна (інцидент 15.09.2026: Oleksiiuk R. зі звільненням з 17.09 спокійно
// ставився на 17 і 18). Єдиний предикат для генератора, POST /schedule/entry,
// «заповнити як цей день» і веб-пікерів (дзеркало — web/src/lib/termination.ts).
export interface TerminationLike { terminationDate: string | Date | null; terminationFactoryId: number | null }

const dateOf = (d: string | Date | null): string | null => (d == null ? null : String(d).slice(0, 10));

/** true — на цю дату людина вже не працює на цій фабриці (звільнення з усіх або саме з цієї). */
export function terminatedOn(w: TerminationLike, factoryId: number | null, date: string): boolean {
  const td = dateOf(w.terminationDate);
  if (!td || td > date) return false;
  return w.terminationFactoryId == null || factoryId == null || w.terminationFactoryId === factoryId;
}
