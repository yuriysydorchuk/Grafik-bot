// «Доїжджає сам» — по фабриці й поденно (worker_self_transport, інтервали
// [since, until) для пари працівник+фабрика). Єдине місце, де резолвиться,
// чи людину возить фірма на конкретну фабрику в конкретний день. Усі водійські
// поверхні (список посадки в боті, driver-board, pickupGaps, пресмінні пуші,
// графік водію) і генерація знять за довіз (routes/transport.ts) беруть режим
// звідси, а не з legacy workers.self_transport.
import { db, workerSelfTransportTable, workerChangesTable, transportDeductionsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

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

/** Чи перекриваються два інтервали [since, until) (until null = відкритий). */
export function intervalsOverlap(a: { since: string; until: string | null }, b: { since: string; until: string | null }): boolean {
  return a.since < (b.until ?? "9999-12-31") && b.since < (a.until ?? "9999-12-31");
}

/** Підпис інтервалу для журналу: `self 2026-08-20..2026-09-03` / `self 2026-08-20..` */
export const selfLabel = (iv: { since: string; until: string | null } | null | undefined): string =>
  iv ? `self ${iv.since}..${iv.until ?? ""}` : "firma";

/**
 * Журнал worker_changes, поле `selfTransport`: значення — `self <since>..<until>` або
 * `firma`, з суфіксом ` @<factoryId>` (як terminationDate; веб підставляє назву фабрики).
 * Запис не відкочується через «Видалити зміну» — лише правкою інтервалів.
 */
export async function journalSelfTransport(workerId: number, factoryId: number, oldV: string, newV: string, effectiveDate: string, adminId: number | null): Promise<void> {
  if (oldV === newV) return;
  await db.insert(workerChangesTable).values({
    workerId, field: "selfTransport", oldValue: `${oldV} @${factoryId}`, newValue: `${newV} @${factoryId}`, effectiveDate, adminId,
  }).catch(err => logger.error({ err }, "self-transport journal failed"));
}

/** Місяці (YYYY-MM) з уже розрахованими зняттями за довіз по парах працівника — для попередження при правці минулого. */
export async function deductedMonthsOf(workerId: number): Promise<{ month: string; factoryId: number | null }[]> {
  const { eq } = await import("drizzle-orm");
  const rows = await db.selectDistinct({ month: transportDeductionsTable.periodMonth, factoryId: transportDeductionsTable.factoryId })
    .from(transportDeductionsTable).where(eq(transportDeductionsTable.workerId, workerId));
  return rows.sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Додати інтервал у довільному місці (вкл. минуле): перекриття з наявними
 * інтервалами пари — помилка (рядок для 400). Повертає id нового рядка.
 */
export async function addSelfInterval(workerId: number, factoryId: number, since: string, until: string | null): Promise<{ id: number } | { error: string }> {
  const { and, eq } = await import("drizzle-orm");
  if (until != null && until <= since) return { error: "«до» має бути пізніше за «з»" };
  return withPairLock(workerId, async tx => {
    const siblings = await tx.select().from(workerSelfTransportTable)
      .where(and(eq(workerSelfTransportTable.workerId, workerId), eq(workerSelfTransportTable.factoryId, factoryId)));
    if (siblings.some(s => intervalsOverlap({ since: String(s.since), until: s.until ? String(s.until) : null }, { since, until })))
      return { error: "Період перекривається з іншим записом цієї фабрики" };
    const [row] = await tx.insert(workerSelfTransportTable).values({ workerId, factoryId, since, until }).returning({ id: workerSelfTransportTable.id });
    return { id: row!.id };
  });
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

const PAIR_LOCK_NS = 7231003; // простір pg_advisory_xact_lock(ns, workerId) для записів worker_self_transport пари

/** Мутації інтервалів пари — лише під транзакційним advisory-локом працівника (паралельні
 *  «Підтвердити»/подвійний клік інакше дають два відкриті інтервали — exclusion constraint у схемі нема). */
async function withPairLock<T>(workerId: number, fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>): Promise<T> {
  const { sql } = await import("drizzle-orm");
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PAIR_LOCK_NS}, ${workerId})`);
    return fn(tx);
  });
}

/**
 * Подія «з дати D — сам» / «з дати D — возить фірма» для пари (веб-профіль, 13.10.2026).
 * На відміну від setSelfTransport, МАЙБУТНЄ не затирає: self відкриває інтервал від D
 * до початку наступного (або безстроково; інтервал, що закінчується рівно в D, —
 * подовжується, без стику); firma закриває інтервал, що покриває D (D == since →
 * інтервал зноситься). Повертає помилку-рядок, якщо подія нічого не змінює.
 */
export async function applySelfEvent(workerId: number, factoryId: number, self: boolean, date: string): Promise<{ ok: true } | { error: string }> {
  const { and, eq } = await import("drizzle-orm");
  return withPairLock(workerId, async tx => {
    const rows = (await tx.select().from(workerSelfTransportTable)
      .where(and(eq(workerSelfTransportTable.workerId, workerId), eq(workerSelfTransportTable.factoryId, factoryId))))
      .map(r => ({ id: r.id, since: String(r.since), until: r.until ? String(r.until) : null }))
      .sort((a, b) => a.since.localeCompare(b.since));
    const covering = rows.find(r => r.since <= date && (r.until == null || r.until > date));
    if (self) {
      if (covering) return { error: "На цю дату вже «доїжджає сам»" };
      const next = rows.find(r => r.since > date);
      const prev = rows.find(r => r.until === date);
      if (prev) await tx.update(workerSelfTransportTable).set({ until: next?.since ?? null }).where(eq(workerSelfTransportTable.id, prev.id));
      else await tx.insert(workerSelfTransportTable).values({ workerId, factoryId, since: date, until: next?.since ?? null });
    } else {
      if (!covering) return { error: "На цю дату й так возить фірма" };
      if (covering.since === date) await tx.delete(workerSelfTransportTable).where(eq(workerSelfTransportTable.id, covering.id));
      else await tx.update(workerSelfTransportTable).set({ until: date }).where(eq(workerSelfTransportTable.id, covering.id));
    }
    return { ok: true };
  });
}

/**
 * Прибрати подію «з нами» (кінець інтервалу): «сам» триває далі — наступний інтервал
 * пари (якщо є) поглинається в один суцільний. Повертає старий/новий until.
 */
export async function reopenSelfInterval(workerId: number, rowId: number): Promise<{ since: string; oldUntil: string | null; until: string | null } | undefined> {
  const { and, eq, gt } = await import("drizzle-orm");
  return withPairLock(workerId, async tx => {
    const [row] = await tx.select().from(workerSelfTransportTable).where(and(eq(workerSelfTransportTable.id, rowId), eq(workerSelfTransportTable.workerId, workerId)));
    if (!row) return undefined;
    const since = String(row.since);
    const later = (await tx.select({ id: workerSelfTransportTable.id, since: workerSelfTransportTable.since, until: workerSelfTransportTable.until }).from(workerSelfTransportTable)
      .where(and(eq(workerSelfTransportTable.workerId, workerId), eq(workerSelfTransportTable.factoryId, row.factoryId), gt(workerSelfTransportTable.since, since))))
      .map(r => ({ id: r.id, since: String(r.since), until: r.until ? String(r.until) : null }))
      .sort((a, b) => a.since.localeCompare(b.since))[0];
    const oldUntil = row.until ? String(row.until) : null;
    if (later) {
      // без події «з нами» режим «сам» триває до кінця наступного інтервалу — зливаємо в один рядок
      await tx.delete(workerSelfTransportTable).where(eq(workerSelfTransportTable.id, later.id));
      await tx.update(workerSelfTransportTable).set({ until: later.until }).where(eq(workerSelfTransportTable.id, rowId));
      return { since, oldUntil, until: later.until };
    }
    await tx.update(workerSelfTransportTable).set({ until: null }).where(eq(workerSelfTransportTable.id, rowId));
    return { since, oldUntil, until: null };
  });
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
