// «Зарплата по фабриках» у профілі працівника (01.10.2026, роль «Офіс-менеджер»).
//
// Лише ЧИТАННЯ сводної: рядок = місяць × фабрика з відкритого шару (години, ставка нетто,
// нарахування, потрачення, до виплати) + деталі джерел, з яких потрачення прийшли в рядок
// (аванси/штрафи/пропуски/бадання/одяг — за маркером місяця перенесення; доїзд/хостел — за
// місяцем). Розбивка рахується тією ж формулою, що computePayout; різниця зі збереженим
// doWyplaty (ручні правки, імпорт таблиць) — окремим рядком «коригування», щоб картка
// завжди сходилась із сумою сводної. Закритий шар (konto/готівка, księgowość) не віддаємо.
// Доступ: svodni АБО workerPay; адмін зі скоупом бачить лише рядки своїх фабрик.
import { Router, type IRouter } from "express";
import { db, svodniRowsTable, svodniLocksTable, advanceRequestsTable, penaltiesTable, scheduleEntriesTable,
  scheduleWeeksTable, workerBadaniaTable, clothingItemsTable, transportDeductionsTable, hostelDeductionsTable } from "@workspace/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { requireAnyCap, type AuthedRequest } from "../lib/auth";
import { factoryInScope } from "../lib/scope";
import { computePayout } from "../services/svodni";
import { isLocked } from "./svodni";
import { entryDateStr } from "../lib/dates";

const router: IRouter = Router();
const r2 = (n: number) => Math.round(n * 100) / 100;
const MONTHS = 24;

type Line = { key: string; amount: number; qty?: number; per?: number };

router.get("/workers/:id/pay", requireAnyCap("svodni", "workerPay"), async (req: AuthedRequest, res) => {
  const workerId = Number(req.params.id);
  if (!Number.isInteger(workerId)) return res.status(400).json({ error: "bad id" });
  const scope = req.admin?.scope ?? null;
  const inScope = (factoryId: number | null) => factoryInScope(scope, factoryId);

  const all = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, workerId))
    .orderBy(desc(svodniRowsTable.periodMonth), svodniRowsTable.factoryLabel);
  const months = [...new Set(all.map(r => r.periodMonth))].slice(0, MONTHS);
  const rowsAll = all.filter(r => months.includes(r.periodMonth) && inScope(r.factoryId));
  const parents = rowsAll.filter(r => r.segmentOf == null);
  const segsOf = new Map<number, typeof rowsAll>();
  for (const s of rowsAll) if (s.segmentOf != null) (segsOf.get(s.segmentOf) ?? segsOf.set(s.segmentOf, []).get(s.segmentOf)!).push(s);

  const locks = months.length ? await db.select().from(svodniLocksTable).where(inArray(svodniLocksTable.periodMonth, months)) : [];

  const rows = parents.map(r => {
    const ex = (k: string) => (typeof (r.extras as any)?.[k] === "number" ? (r.extras as any)[k] as number : 0);
    const segs = (segsOf.get(r.id) ?? []).sort((a, b) => String(a.segmentFrom).localeCompare(String(b.segmentFrom)));
    const segments = segs.map(s => ({
      label: s.segmentLabel, from: s.segmentFrom, to: s.segmentTo, hours: s.hours, rateNetto: s.rateNetto,
      base: s.hours != null && s.rateNetto != null ? r2(s.hours * s.rateNetto) : null,
    }));
    const base = segments.length
      ? (segments.every(s => s.base != null) ? r2(segments.reduce((a, s) => a + (s.base ?? 0), 0)) : null)
      : (r.hours != null && r.rateNetto != null ? r2(r.hours * r.rateNetto) : null);
    const lodz = r.city === "Лодзь";
    const add: Line[] = [];
    const ded: Line[] = [];
    const push = (arr: Line[], key: string, amount: number | null | undefined, extra?: Partial<Line>) => {
      if (amount != null && Math.abs(amount) >= 0.005) arr.push({ key, amount: r2(amount), ...extra });
    };
    // Порядок і склад — дзеркало computePayout (services/svodni.ts)
    if (lodz) {
      push(add, "migawka", ex("migawka"));
      push(add, "premia", r.premia);
      push(add, "dojazdPlus", r.dojazd); // у Лодзі dojazd — доплата за доїзд
      push(ded, "zaliczka", r.zaliczka); push(ded, "potracenia", r.potracenia);
      push(ded, "hostel", r.hostel); push(ded, "odziez", r.odziez); push(ded, "dokumenty", ex("dokumenty"));
    } else {
      push(add, "nocne", ex("nocneH") * ex("doplataNocna"), { qty: ex("nocneH"), per: ex("doplataNocna") });
      push(add, "premiaEs", ex("premiaEs") * (r.hours ?? 0), { qty: r.hours ?? 0, per: ex("premiaEs") });
      push(add, "premia", r.premia);
      push(add, "oplataKierowcy", ex("oplataKierowcy"));
      push(add, "doplataEs", ex("doplataEs"));
      push(add, "zwrotKosztow", ex("zwrotKosztow"));
      for (const k of ["zaliczka", "zaliczkaBd", "hostel", "odziez", "dojazd", "kara", "komornik", "kaucja", "potracenia"] as const) push(ded, k, r[k]);
      for (const k of ["badania", "kartaPobytu", "karaKlient", "karaEs", "zadluzenie"]) push(ded, k, ex(k));
    }
    const computed = base != null ? computePayout(r as any, (lodz ? "Лодзь" : r.city === "Познань" ? "Познань" : "Люблін"), segments.length ? base : undefined) : null;
    const adjust = r.doWyplaty != null && computed != null ? r2(r.doWyplaty - computed) : null;
    const debtIn = (r.extras as any)?.debtIn as { from?: string; cols?: Record<string, number> } | undefined;
    return {
      id: r.id, month: r.periodMonth, factoryId: r.factoryId, factoryLabel: r.factoryLabel, city: r.city, firm: r.firm,
      locked: isLocked(locks, r.city, r.factoryLabel),
      hours: r.hours, shifts: r.shifts, rateNetto: r.rateNetto,
      facBonus: ex("facBonus") || null, // вшитий у ставку нетто бонус фабрики, зл/год
      segments, base, additions: add, deductions: ded,
      adjust: adjust != null && Math.abs(adjust) >= 0.01 ? adjust : null,
      debtIn: debtIn?.cols && Object.keys(debtIn.cols).length ? { from: debtIn.from ?? null, cols: debtIn.cols } : null,
      doWyplaty: r.doWyplaty,
    };
  });

  // ── деталі джерел потрачень ────────────────────────────────────────────────
  const mset = months.length ? months : ["—"];
  const advances = (await db.select({
      id: advanceRequestsTable.id, month: advanceRequestsTable.svodniMonth, factoryId: advanceRequestsTable.factoryId,
      amount: advanceRequestsTable.amount, paidAt: advanceRequestsTable.paidAt, paidMethod: advanceRequestsTable.paidMethod,
      createdAt: advanceRequestsTable.createdAt,
    }).from(advanceRequestsTable)
    .where(and(eq(advanceRequestsTable.workerId, workerId), inArray(advanceRequestsTable.svodniMonth, mset))))
    .filter(a => inScope(a.factoryId));
  const penalties = (await db.select({
      id: penaltiesTable.id, month: penaltiesTable.deductedMonth, factoryId: penaltiesTable.factoryId,
      amount: penaltiesTable.amount, note: penaltiesTable.note, periodMonth: penaltiesTable.periodMonth,
    }).from(penaltiesTable)
    .where(and(eq(penaltiesTable.workerId, workerId), inArray(penaltiesTable.deductedMonth, mset))))
    .filter(p => inScope(p.factoryId));
  const absences = (await db.select({
      id: scheduleEntriesTable.id, month: scheduleEntriesTable.absenceDeductedMonth, factoryId: scheduleEntriesTable.factoryId,
      amount: scheduleEntriesTable.absenceDeductedAmount, weekStart: scheduleWeeksTable.weekStart, dayOfWeek: scheduleEntriesTable.dayOfWeek,
    }).from(scheduleEntriesTable).innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(eq(scheduleEntriesTable.workerId, workerId), inArray(scheduleEntriesTable.absenceDeductedMonth, mset))))
    .filter(a => inScope(a.factoryId))
    .map(({ weekStart, dayOfWeek, ...a }) => ({ ...a, date: entryDateStr(String(weekStart), dayOfWeek) }));
  // бадання й одяг фабрики не мають — показуються під рядком із відповідною колонкою
  const badania = await db.select({
      id: workerBadaniaTable.id, month: workerBadaniaTable.deductedMonth, amount: workerBadaniaTable.amount,
      enteredAt: workerBadaniaTable.enteredAt, note: workerBadaniaTable.note,
    }).from(workerBadaniaTable)
    .where(and(eq(workerBadaniaTable.workerId, workerId), inArray(workerBadaniaTable.deductedMonth, mset)));
  const clothing = await db.select({
      id: clothingItemsTable.id, month: clothingItemsTable.deductedMonth, itemType: clothingItemsTable.itemType,
      size: clothingItemsTable.size, issuedAt: clothingItemsTable.issuedAt,
      amount: clothingItemsTable.deductedAmount, price: clothingItemsTable.price,
    }).from(clothingItemsTable)
    .where(and(eq(clothingItemsTable.workerId, workerId), isNotNull(clothingItemsTable.deductedMonth), inArray(clothingItemsTable.deductedMonth, mset)));
  const transport = (await db.select({
      id: transportDeductionsTable.id, month: transportDeductionsTable.periodMonth, factoryId: transportDeductionsTable.factoryId,
      trips: transportDeductionsTable.tripsCount, amount: transportDeductionsTable.amount, note: transportDeductionsTable.note,
    }).from(transportDeductionsTable)
    .where(and(eq(transportDeductionsTable.workerId, workerId), inArray(transportDeductionsTable.periodMonth, mset))))
    .filter(t => inScope(t.factoryId));
  const hostel = (await db.select({
      id: hostelDeductionsTable.id, month: hostelDeductionsTable.periodMonth, factoryId: hostelDeductionsTable.factoryId,
      amount: hostelDeductionsTable.amount, note: hostelDeductionsTable.note,
    }).from(hostelDeductionsTable)
    .where(and(eq(hostelDeductionsTable.workerId, workerId), inArray(hostelDeductionsTable.periodMonth, mset))))
    .filter(h => inScope(h.factoryId));

  return res.json({
    months, rows,
    details: {
      zaliczka: advances.map(a => ({ ...a, amount: r2(a.amount) })),
      kara: penalties, absences,
      badania: badania.map(b => ({ ...b, factoryId: null })),
      odziez: clothing.map(c => ({ ...c, amount: c.amount ?? c.price ?? 0, factoryId: null })),
      dojazd: transport, hostel,
    },
  });
});

export default router;
