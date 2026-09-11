// «Доїжджає сам» — по фабриці й поденно (worker_self_transport, інтервали
// [since, until) для пари працівник+фабрика). Єдине місце, де резолвиться,
// чи людину возить фірма на конкретну фабрику в конкретний день. Усі водійські
// поверхні (список посадки в боті, driver-board, pickupGaps, пресмінні пуші,
// графік водію) і генерація знять за довіз (routes/transport.ts) беруть режим
// звідси, а не з legacy workers.self_transport.
import { db, workerSelfTransportTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

export type SelfInterval = { id: number; since: string; until: string | null };
/** `${workerId}|${factoryId}` → інтервали (упорядковані за since). */
export type SelfTransportMap = Map<string, SelfInterval[]>;

const key = (workerId: number, factoryId: number) => `${workerId}|${factoryId}`;

/** Завантажити інтервали (усі, або лише для заданих працівників). */
export async function loadSelfTransport(workerIds?: Iterable<number>): Promise<SelfTransportMap> {
  const ids = workerIds ? [...new Set(workerIds)] : null;
  if (ids && !ids.length) return new Map();
  const rows = await db.select().from(workerSelfTransportTable)
    .where(ids ? inArray(workerSelfTransportTable.workerId, ids) : undefined);
  const map: SelfTransportMap = new Map();
  for (const r of rows) {
    const k = key(r.workerId, r.factoryId);
    (map.get(k) ?? map.set(k, []).get(k)!).push({ id: r.id, since: String(r.since), until: r.until ? String(r.until) : null });
  }
  for (const list of map.values()) list.sort((a, b) => a.since.localeCompare(b.since));
  return map;
}

/** Чи доїжджає сам на цю фабрику в цей день (YYYY-MM-DD, рядкове порівняння). */
export function isSelfOn(map: SelfTransportMap, workerId: number | null | undefined, factoryId: number | null | undefined, date: string): boolean {
  if (workerId == null || factoryId == null) return false;
  const list = map.get(key(workerId, factoryId));
  if (!list) return false;
  return list.some(i => i.since <= date && (i.until == null || i.until > date));
}

/** Чинний (відкритий або такий, що охоплює день) інтервал пари. */
export function selfIntervalOn(map: SelfTransportMap, workerId: number, factoryId: number, date: string): SelfInterval | undefined {
  return map.get(key(workerId, factoryId))?.find(i => i.since <= date && (i.until == null || i.until > date));
}

/** Чи є в місяці [monthStart, monthEnd) хоч один self-день для пари. */
export function hasSelfInRange(map: SelfTransportMap, workerId: number, factoryId: number, from: string, to: string): boolean {
  const list = map.get(key(workerId, factoryId));
  return !!list?.some(i => i.since < to && (i.until == null || i.until > from));
}

/** Чи весь діапазон [from, to) покритий self-інтервалами (кожен день — сам). */
export function isSelfWholeRange(map: SelfTransportMap, workerId: number, factoryId: number, from: string, to: string): boolean {
  const list = map.get(key(workerId, factoryId));
  if (!list?.length) return false;
  // інтервали відсортовані; йдемо зліва, поки покриття не досягне to
  let cur = from;
  for (const i of list) {
    if (i.since > cur) break;
    const end = i.until ?? "9999-12-31";
    if (end > cur) cur = end;
    if (cur >= to) return true;
  }
  return cur >= to;
}

/** Мапа лише по одному працівнику: `factoryId` → інтервали (для профілю/API). */
export function intervalsOfWorker(map: SelfTransportMap, workerId: number): Map<number, SelfInterval[]> {
  const out = new Map<number, SelfInterval[]>();
  for (const [k, list] of map) {
    const [w, f] = k.split("|").map(Number);
    if (w === workerId) out.set(f!, list);
  }
  return out;
}

/**
 * Предикат для записів графіку одного тижня: (workerId, factoryId, dayOfWeek) →
 * чи в цей день людина доїжджає сама. Вантажить weekStart і мапу один раз.
 */
export async function selfPredicateForWeek(weekId: number): Promise<(workerId: number | null | undefined, factoryId: number | null | undefined, day: string | null) => boolean> {
  const { scheduleWeeksTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const { entryDateStr } = await import("../lib/dates");
  const [wk] = await db.select({ weekStart: scheduleWeeksTable.weekStart }).from(scheduleWeeksTable).where(eq(scheduleWeeksTable.id, weekId));
  const map = await loadSelfTransport();
  if (!wk || !map.size) return () => false;
  const weekStart = String(wk.weekStart);
  return (workerId, factoryId, day) => isSelfOn(map, workerId, factoryId, entryDateStr(weekStart, day));
}

/**
 * Перемкнути режим пари з дати `since`: увімкнути = відкрити інтервал (чинний
 * відкритий лишається; закритий, що покриває дату, знову відкривається);
 * вимкнути = закрити чинний інтервал датою (since ≤ його початку → інтервал
 * зноситься, він не встиг подіяти). Пізніші інтервали за датою — зносяться,
 * щоб не було «дірок у майбутньому» після ручного перемикання.
 */
export async function setSelfTransport(workerId: number, factoryId: number, self: boolean, since: string): Promise<void> {
  const { and, eq } = await import("drizzle-orm");
  const pair = and(eq(workerSelfTransportTable.workerId, workerId), eq(workerSelfTransportTable.factoryId, factoryId));
  const rows = (await db.select().from(workerSelfTransportTable).where(pair))
    .map(r => ({ ...r, since: String(r.since), until: r.until ? String(r.until) : null }))
    .sort((a, b) => a.since.localeCompare(b.since));
  // майбутні відносно дати інтервали — геть (ручне перемикання переписує майбутнє)
  for (const r of rows) if (r.since >= since) await db.delete(workerSelfTransportTable).where(eq(workerSelfTransportTable.id, r.id));
  const live = rows.filter(r => r.since < since);
  const covering = live.filter(r => r.until == null || r.until > since); // усі, що покривають дату (перекриття — на випадок ручних правок)
  if (self) {
    if (covering.length) {
      for (const c of covering) if (c.until != null) await db.update(workerSelfTransportTable).set({ until: null }).where(eq(workerSelfTransportTable.id, c.id));
      return;
    }
    await db.insert(workerSelfTransportTable).values({ workerId, factoryId, since, until: null });
  } else {
    for (const c of covering) await db.update(workerSelfTransportTable).set({ until: since }).where(eq(workerSelfTransportTable.id, c.id));
  }
}

/** Зсунути дату «діє з» чинного (відкритого) інтервалу пари. */
export async function moveSelfTransportSince(workerId: number, factoryId: number, since: string): Promise<boolean> {
  const { and, eq, isNull } = await import("drizzle-orm");
  const [open] = await db.select().from(workerSelfTransportTable)
    .where(and(eq(workerSelfTransportTable.workerId, workerId), eq(workerSelfTransportTable.factoryId, factoryId), isNull(workerSelfTransportTable.until)));
  if (!open) return false;
  await db.update(workerSelfTransportTable).set({ since }).where(eq(workerSelfTransportTable.id, open.id));
  return true;
}
