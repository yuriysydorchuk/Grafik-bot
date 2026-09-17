// Джерела знять сводної (бадання, одяг, штрафи, пропуски, залічки) несуть
// позначку «знято у сводній місяця M». Коли рядок сводної видаляється або
// вкладку очищають — суми зникають разом із рядком, тож позначки мусять
// повернутись у «не знято» (інакше зняття «зависає»: ні в сводній, ні в черзі).
// При відновленні знімка позначки повертаються з тими самими датами/сумами.
//
// Матчинг джерела до рядка: працівник + місяць; фабрика — коли є в джерелі і
// в рядку; і колонка рядка непорожня (суму реально сюди переносили). Бадання
// й одяг фабрики не мають (apply кладе їх у рядок з найбільшими годинами), тож
// якщо в людини ЛИШАЄТЬСЯ інший рядок місяця з тією ж непорожньою колонкою —
// не зрозуміло, чиє зняття, і позначку НЕ чіпаємо (рахуємо в ambiguous).
//
// Довіз (transport_deductions) і хостел (hostel_deductions) — реєстри без
// позначки: їх apply/from-hours перечитує з нуля, скидати нічого.
// Усі функції приймають виконавця (db або tx) — виклики йдуть у транзакції
// разом із видаленням/вставкою рядків.
import { db, workerBadaniaTable, clothingItemsTable, penaltiesTable, scheduleEntriesTable, advanceRequestsTable, svodniRowsTable, workersTable } from "@workspace/db";
import { and, eq, inArray, isNull, isNotNull, notInArray } from "drizzle-orm";

type SvodniRow = typeof svodniRowsTable.$inferSelect;
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ReleasedSources = {
  badania: { id: number; deductedAt: string | null; deductedMonth: string }[];
  clothing: { id: number; deductedMonth: string; deductedAmount: number | null }[];
  penalties: { id: number; deductedAt: string | null; deductedMonth: string }[];
  absences: { entryId: number; month: string; at: string | null; amount: number | null }[];
  advances: { id: number; svodniMonth: string; svodniAppliedAt: string | null }[];
  ambiguous?: number; // позначки, які лишили «знято» через інший рядок людини в місяці
};
export const emptyReleased = (): ReleasedSources => ({ badania: [], clothing: [], penalties: [], absences: [], advances: [], ambiguous: 0 });
export const releasedCount = (r: Partial<ReleasedSources> | null | undefined): number =>
  (r?.badania?.length ?? 0) + (r?.clothing?.length ?? 0) + (r?.penalties?.length ?? 0) + (r?.absences?.length ?? 0) + (r?.advances?.length ?? 0);

const nz = (v: number | null | undefined) => typeof v === "number" && Math.abs(v) > 0.005;

export async function releaseSourcesForRows(exec: Executor, rows: SvodniRow[]): Promise<ReleasedSources> {
  const out = emptyReleased();
  const parents = rows.filter(r => r.segmentOf == null && r.workerId != null);
  if (!parents.length) return out;
  const deletedIds = rows.map(r => r.id);
  const byMonth = new Map<string, SvodniRow[]>();
  for (const r of parents) (byMonth.get(r.periodMonth) ?? byMonth.set(r.periodMonth, []).get(r.periodMonth)!).push(r);
  for (const [month, mrows] of byMonth) {
    const workerIds = [...new Set(mrows.map(r => r.workerId!))];
    // рядки цих людей у місяці, які ЛИШАЮТЬСЯ (не видаляються) — для неоднозначності
    const remaining = await exec.select().from(svodniRowsTable).where(and(
      eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf),
      inArray(svodniRowsTable.workerId, workerIds), notInArray(svodniRowsTable.id, deletedIds)));
    const facOk = (r: SvodniRow, factoryId: number | null) => factoryId == null || r.factoryId == null || r.factoryId === factoryId;
    const has = (list: SvodniRow[], workerId: number, factoryId: number | null, col: keyof SvodniRow) =>
      list.some(r => r.workerId === workerId && facOk(r, factoryId) && nz(r[col] as number | null));
    // true = знімати позначку; null = неоднозначно (лишаємо)
    const decide = (workerId: number, factoryId: number | null, col: keyof SvodniRow): boolean | null => {
      if (!has(mrows, workerId, factoryId, col)) return false;
      if (has(remaining, workerId, factoryId, col)) { out.ambiguous!++; return null; }
      return true;
    };

    const bad = await exec.select().from(workerBadaniaTable).where(and(
      eq(workerBadaniaTable.deducted, true), eq(workerBadaniaTable.deductedMonth, month), inArray(workerBadaniaTable.workerId, workerIds)));
    const badIds = bad.filter(b => decide(b.workerId, null, "zaliczkaBd") === true).map(b => b.id);
    if (badIds.length) {
      out.badania = bad.filter(b => badIds.includes(b.id)).map(b => ({ id: b.id, deductedAt: b.deductedAt, deductedMonth: month }));
      await exec.update(workerBadaniaTable).set({ deducted: false, deductedAt: null, deductedMonth: null }).where(inArray(workerBadaniaTable.id, badIds));
    }

    const clo = await exec.select().from(clothingItemsTable).where(and(
      eq(clothingItemsTable.deducted, true), eq(clothingItemsTable.deductedMonth, month), inArray(clothingItemsTable.workerId, workerIds)));
    const cloIds = clo.filter(c => c.workerId != null && decide(c.workerId, null, "odziez") === true).map(c => c.id);
    if (cloIds.length) {
      out.clothing = clo.filter(c => cloIds.includes(c.id)).map(c => ({ id: c.id, deductedMonth: month, deductedAmount: c.deductedAmount }));
      await exec.update(clothingItemsTable).set({ deducted: false, deductedMonth: null, deductedAmount: null }).where(inArray(clothingItemsTable.id, cloIds));
    }

    const pen = await exec.select().from(penaltiesTable).where(and(
      eq(penaltiesTable.deducted, true), eq(penaltiesTable.deductedMonth, month), inArray(penaltiesTable.workerId, workerIds)));
    const penIds = pen.filter(p => decide(p.workerId, p.factoryId, "kara") === true).map(p => p.id);
    if (penIds.length) {
      out.penalties = pen.filter(p => penIds.includes(p.id)).map(p => ({ id: p.id, deductedAt: p.deductedAt, deductedMonth: month }));
      await exec.update(penaltiesTable).set({ deducted: false, deductedAt: null, deductedMonth: null }).where(inArray(penaltiesTable.id, penIds));
    }

    const abs = await exec.select().from(scheduleEntriesTable).where(and(
      eq(scheduleEntriesTable.absenceDeductedMonth, month), inArray(scheduleEntriesTable.workerId, workerIds)));
    const absIds = abs.filter(e => decide(e.workerId, e.factoryId, "kara") === true).map(e => e.id);
    if (absIds.length) {
      out.absences = abs.filter(e => absIds.includes(e.id)).map(e => ({ entryId: e.id, month, at: e.absenceDeductedAt, amount: e.absenceDeductedAmount }));
      await exec.update(scheduleEntriesTable).set({ absenceDeductedMonth: null, absenceDeductedAt: null, absenceDeductedAmount: null }).where(inArray(scheduleEntriesTable.id, absIds));
    }

    const adv = await exec.select().from(advanceRequestsTable).where(and(
      eq(advanceRequestsTable.svodniMonth, month), inArray(advanceRequestsTable.workerId, workerIds)));
    const advIds = adv.filter(a => decide(a.workerId, a.factoryId ?? null, "zaliczka") === true).map(a => a.id);
    if (advIds.length) {
      out.advances = adv.filter(a => advIds.includes(a.id)).map(a => ({ id: a.id, svodniMonth: month, svodniAppliedAt: a.svodniAppliedAt }));
      await exec.update(advanceRequestsTable).set({ svodniMonth: null, svodniAppliedAt: null }).where(inArray(advanceRequestsTable.id, advIds));
    }
  }
  return out;
}

// Джерела знімка, які тим часом перенесли деінде (позначка вже стоїть).
// Відновлювати такий знімок не можна: суми лягли б у дві сводні одразу —
// спершу відмінити те перенесення (undo-ендпойнти) або видалити той рядок.
export async function findSourceConflicts(exec: Executor, src: Partial<ReleasedSources> | null | undefined): Promise<string[]> {
  if (!src) return [];
  const names = new Map<number, string>();
  const nameOf = async (workerId: number) => {
    if (!names.has(workerId)) {
      const [w] = await exec.select({ n: workersTable.fullName }).from(workersTable).where(eq(workersTable.id, workerId));
      names.set(workerId, w?.n ?? `#${workerId}`);
    }
    return names.get(workerId)!;
  };
  const out: string[] = [];
  const badIds = (src.badania ?? []).map(b => b.id);
  if (badIds.length) for (const b of await exec.select().from(workerBadaniaTable).where(and(inArray(workerBadaniaTable.id, badIds), eq(workerBadaniaTable.deducted, true))))
    out.push(`бадання ${await nameOf(b.workerId)} → ${b.deductedMonth ?? "вручну"}`);
  const cloIds = (src.clothing ?? []).map(c => c.id);
  if (cloIds.length) for (const c of await exec.select().from(clothingItemsTable).where(and(inArray(clothingItemsTable.id, cloIds), eq(clothingItemsTable.deducted, true))))
    out.push(`одяг ${c.workerId != null ? await nameOf(c.workerId) : "?"} → ${c.deductedMonth ?? "вручну"}`);
  const penIds = (src.penalties ?? []).map(p => p.id);
  if (penIds.length) for (const p of await exec.select().from(penaltiesTable).where(and(inArray(penaltiesTable.id, penIds), eq(penaltiesTable.deducted, true))))
    out.push(`штраф ${await nameOf(p.workerId)} → ${p.deductedMonth ?? "вручну"}`);
  const absIds = (src.absences ?? []).map(e => e.entryId);
  if (absIds.length) for (const e of await exec.select().from(scheduleEntriesTable).where(and(inArray(scheduleEntriesTable.id, absIds), isNotNull(scheduleEntriesTable.absenceDeductedMonth))))
    out.push(`пропуск ${await nameOf(e.workerId)} → ${e.absenceDeductedMonth}`);
  const advIds = (src.advances ?? []).map(a => a.id);
  if (advIds.length) for (const a of await exec.select().from(advanceRequestsTable).where(and(inArray(advanceRequestsTable.id, advIds), isNotNull(advanceRequestsTable.svodniMonth))))
    out.push(`залічка ${await nameOf(a.workerId)} → ${a.svodniMonth}`);
  return out;
}

// Повернути позначки після відновлення знімка (конфлікти перевірено раніше —
// findSourceConflicts; гард «лише незняте» лишається на випадок гонки).
export async function remarkSources(exec: Executor, src: Partial<ReleasedSources> | null | undefined): Promise<{ remarked: number; skipped: number }> {
  if (!src) return { remarked: 0, skipped: 0 };
  let remarked = 0, skipped = 0;
  const tick = (r: unknown[]) => { r.length ? remarked++ : skipped++; };
  for (const b of src.badania ?? []) tick(await exec.update(workerBadaniaTable).set({ deducted: true, deductedAt: b.deductedAt, deductedMonth: b.deductedMonth })
    .where(and(eq(workerBadaniaTable.id, b.id), eq(workerBadaniaTable.deducted, false))).returning({ id: workerBadaniaTable.id }));
  for (const c of src.clothing ?? []) tick(await exec.update(clothingItemsTable).set({ deducted: true, deductedMonth: c.deductedMonth, deductedAmount: c.deductedAmount })
    .where(and(eq(clothingItemsTable.id, c.id), eq(clothingItemsTable.deducted, false))).returning({ id: clothingItemsTable.id }));
  for (const p of src.penalties ?? []) tick(await exec.update(penaltiesTable).set({ deducted: true, deductedAt: p.deductedAt, deductedMonth: p.deductedMonth })
    .where(and(eq(penaltiesTable.id, p.id), eq(penaltiesTable.deducted, false))).returning({ id: penaltiesTable.id }));
  for (const e of src.absences ?? []) tick(await exec.update(scheduleEntriesTable).set({ absenceDeductedMonth: e.month, absenceDeductedAt: e.at, absenceDeductedAmount: e.amount })
    .where(and(eq(scheduleEntriesTable.id, e.entryId), isNull(scheduleEntriesTable.absenceDeductedMonth))).returning({ id: scheduleEntriesTable.id }));
  for (const a of src.advances ?? []) tick(await exec.update(advanceRequestsTable).set({ svodniMonth: a.svodniMonth, svodniAppliedAt: a.svodniAppliedAt })
    .where(and(eq(advanceRequestsTable.id, a.id), isNull(advanceRequestsTable.svodniMonth))).returning({ id: advanceRequestsTable.id }));
  return { remarked, skipped };
}
