// Поточний фінансовий стан працівника (read-only) — довідка для рішення про
// аванс: ЖИВІ зміни (approved-тижні, явка present; рапорти свідомо НЕ беруться —
// рішення Yuriy 03.09.2026) за поточний місяць і, у перші 15 днів місяця, ще й за
// попередній окремим рядком (ЗП за нього ще не виплачена); нетто-ставка за
// конвенцією сводної (resolveBaseRates + бонус фабрики), незняті залічки/kary/
// badania, борг з M−1. НЕ пише в БД і НЕ замінює сводну (routes/svodni.ts
// from-hours) — лише оцінка «≈ до виплати на сьогодні». Показувати тільки тим,
// хто має доступ до розділу «Аванси» (bot/index.ts запит авансу, GET /advances/:id/balance).
import { db } from "@workspace/db";
import {
  workersTable, factoriesTable, scheduleEntriesTable, scheduleWeeksTable,
  advanceRequestsTable, penaltiesTable, workerBadaniaTable, svodniRowsTable,
  hostelDeductionsTable, transportDeductionsTable, clothingItemsTable,
  type Shift,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { factoryShiftHours, nowWarsaw } from "../bot/time";
import { entryDateStr, weekFromForMonth } from "../lib/dates";
import { absencePenaltyOf } from "../lib/absences";
import { resolveBaseRates, factoryBonusPerHour, debtCarryFromRow, KSIEG_STD_NETTO } from "./svodni";
import { loadRateRules } from "./rateRules";
import { PayoutRules } from "./factoryRules";
import { isUnder26 } from "./svodniSync";

const r2 = (n: number) => Math.round(n * 100) / 100;

export type BalanceMonth = {
  month: string;                       // YYYY-MM
  hours: number;                       // живі зміни (present) по парі працівник+фабрика
  shifts: number;
  rateNetto: number | null;            // нетто/год з урахуванням бонусу фабрики (бонус залежить від годин місяця)
  earned: number | null;               // hours × rateNetto
};
export type WorkerBalance = {
  factoryId: number | null;            // фабрика, за ставками якої рахуємо
  factoryName: string | null;
  months: BalanceMonth[];              // [попередній (лише 1–15 число), поточний]
  stud26: boolean;
  earnedTotal: number | null;          // Σ earned по місяцях
  advances: { id: number; amount: number; status: string; createdAt: Date | null }[]; // незняті (approved/paid без svodni_month)
  advancesTotal: number;
  pendingAdvances: number;             // інші запити pending (крім поточного), сума
  penaltiesTotal: number;              // penalties.deducted=false
  absencePenaltiesTotal: number;       // штрафи за пропуски, ще не перенесені в Kara
  absencePenaltiesCount: number;
  badaniaTotal: number;                // worker_badania.deducted=false
  debtPrev: { month: string; total: number } | null; // мінус з M−1 (debtCarryFromRow)
  // Інші зняття показаних місяців: рядок сводної (potrącenia/hostel/dojazd/odzież/
  // komornik/kaucja/extras.*), а для місяця без рядка сводної — таблиці знять
  // (hostel_deductions, transport_deductions, clothing_items не зняті). Лише > 0.
  other: { month: string; label: string; amount: number }[];
  otherTotal: number;
  estimate: number | null;             // earned − усі відрахування
};

export async function computeWorkerBalance(
  workerId: number,
  opts: { factoryId?: number | null; month?: string; excludeAdvanceId?: number } = {},
): Promise<WorkerBalance | null> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return null;
  const now = nowWarsaw();
  const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const curMonth = opts.month ?? ym(now);
  // у перші 15 днів місяця ЗП за попередній ще не виплачена → показуємо його окремим рядком
  const monthsToShow: string[] = [];
  if (!opts.month && now.getDate() <= 15) monthsToShow.push(ym(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
  monthsToShow.push(curMonth);
  const factoryId = opts.factoryId ?? w.factoryId ?? null;
  const fac = factoryId != null ? (await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)))[0] ?? null : null;

  // 1) живі зміни по парі: approved-тижні із запасом (тиждень перетинає межу місяця),
  //    статус present, фільтр по фактичній даті зміни
  const rows = await db.select({
    day: scheduleEntriesTable.dayOfWeek, shift: scheduleEntriesTable.shift, hoursOverride: scheduleEntriesTable.hoursOverride,
    factoryId: scheduleEntriesTable.factoryId, weekStart: scheduleWeeksTable.weekStart,
    shifts: factoriesTable.shifts, s1: factoriesTable.shift1Start, s2: factoriesTable.shift2Start, s3: factoriesTable.shift3Start,
  }).from(scheduleEntriesTable)
    .innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .leftJoin(factoriesTable, eq(scheduleEntriesTable.factoryId, factoriesTable.id))
    .where(and(
      eq(scheduleEntriesTable.workerId, workerId), eq(scheduleEntriesTable.status, "present"),
      eq(scheduleWeeksTable.status, "approved"), gte(scheduleWeeksTable.weekStart, weekFromForMonth(`${monthsToShow[0]}-01`)),
      ...(factoryId != null ? [eq(scheduleEntriesTable.factoryId, factoryId)] : []),
    ));
  const hoursBy = new Map<string, { hours: number; shifts: number }>(monthsToShow.map(m => [m, { hours: 0, shifts: 0 }]));
  for (const r of rows) {
    const m = entryDateStr(String(r.weekStart), r.day).slice(0, 7);
    const acc = hoursBy.get(m);
    if (!acc) continue;
    acc.hours += r.hoursOverride ?? factoryShiftHours({ shifts: r.shifts ?? [], shift1Start: r.s1, shift2Start: r.s2, shift3Start: r.s3 }, r.shift as Shift);
    acc.shifts += 1;
  }

  // 2) нетто-ставка за конвенцією сводної: профіль → правила фабрики; студент до 26 —
  //    нетто = брутто; бонусні фабрики (Agram/LST) — бонус поверх нетто (стажевий
  //    бонус залежить від годин місяця, тому ставка рахується помісячно)
  const under26 = w.birthDate ? isUnder26(String(w.birthDate)) : !!w.under26;
  const stud26 = (!!w.isStudent || w.legalStatus === "student") && under26;
  const ruleOf = await loadRateRules();
  const base = resolveBaseRates(w, ruleOf(factoryId, w.positionId), stud26);
  const payoutRules = await PayoutRules.load(factoryId != null ? [factoryId] : []);
  const months: BalanceMonth[] = monthsToShow.map(month => {
    const { hours: h, shifts } = hoursBy.get(month)!;
    const hours = r2(h);
    const bonus = factoryId != null && !stud26 ? factoryBonusPerHour(w, payoutRules.for(factoryId, fac?.name ?? null, month), month, hours) : 0;
    const netBase = stud26 ? base.brutto : (base.netto ?? (bonus > 0 ? KSIEG_STD_NETTO() : null));
    const rateNetto = netBase != null ? r2(netBase + bonus) : null;
    return { month, hours, shifts, rateNetto, earned: rateNetto != null ? r2(hours * rateNetto) : null };
  });
  const earnedTotal = months.some(m => m.earned == null) ? null : r2(months.reduce((s, m) => s + (m.earned ?? 0), 0));

  // 3) відрахування, ще не знятi зі сводної
  const advRows = await db.select({
    id: advanceRequestsTable.id, amount: advanceRequestsTable.amount, status: advanceRequestsTable.status, createdAt: advanceRequestsTable.createdAt,
  }).from(advanceRequestsTable).where(and(
    eq(advanceRequestsTable.workerId, workerId), isNull(advanceRequestsTable.svodniMonth),
    inArray(advanceRequestsTable.status, ["approved", "paid", "pending"]),
    ...(opts.excludeAdvanceId != null ? [ne(advanceRequestsTable.id, opts.excludeAdvanceId)] : []),
  )).orderBy(advanceRequestsTable.createdAt);
  const advances = advRows.filter(a => a.status !== "pending");
  const advancesTotal = r2(advances.reduce((s, a) => s + a.amount, 0));
  const pendingAdvances = r2(advRows.filter(a => a.status === "pending").reduce((s, a) => s + a.amount, 0));

  const [pen] = await db.select({ total: sql<number>`coalesce(sum(${penaltiesTable.amount}), 0)` }).from(penaltiesTable)
    .where(and(eq(penaltiesTable.workerId, workerId), eq(penaltiesTable.deducted, false)));
  const absRows = await db.select({ absenceExcused: scheduleEntriesTable.absenceExcused, absencePenalty: scheduleEntriesTable.absencePenalty })
    .from(scheduleEntriesTable).where(and(
      eq(scheduleEntriesTable.workerId, workerId), eq(scheduleEntriesTable.status, "absent"),
      eq(scheduleEntriesTable.absenceExcused, false), isNull(scheduleEntriesTable.absenceDeductedMonth),
    ));
  const absencePenaltiesTotal = r2(absRows.reduce((s, e) => s + (absencePenaltyOf(e) ?? 0), 0));
  const [bad] = await db.select({ total: sql<number>`coalesce(sum(${workerBadaniaTable.amount}), 0)` }).from(workerBadaniaTable)
    .where(and(eq(workerBadaniaTable.workerId, workerId), eq(workerBadaniaTable.deducted, false)));

  // 4) борг з M−1 (відносно найранішого показаного місяця): рядок сводної з мінусовою виплатою
  const [y, m] = monthsToShow[0]!.split("-").map(Number);
  const prevMonth = m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, "0")}`;
  const prevRows = await db.select().from(svodniRowsTable).where(and(
    eq(svodniRowsTable.periodMonth, prevMonth), eq(svodniRowsTable.workerId, workerId), isNull(svodniRowsTable.segmentOf),
    sql`${svodniRowsTable.doWyplaty} < 0`,
  ));
  let debtTotal = 0;
  for (const pr of prevRows) {
    const carry = debtCarryFromRow(pr as any, pr.city);
    if (carry) debtTotal += Object.values(carry).reduce((a, b) => a + b, 0);
  }
  const debtPrev = debtTotal > 0.005 ? { month: prevMonth, total: r2(debtTotal) } : null;

  const penaltiesTotal = r2(Number(pen?.total ?? 0));
  const badaniaTotal = r2(Number(bad?.total ?? 0));

  // 5) інші зняття показаних місяців (рішення Yuriy 03.09.2026): є рядок сводної
  //    (незалочений чи ні) → беремо його колонки; нема — таблиці знять місяця.
  //    У Лодзі dojazd — доплата, не зняття (як у DEBT_DEDUCTION_ORDER). Zaliczka/
  //    kara/badania сюди НЕ входять — вони вже вище (з таблиць, без дублю).
  const other: WorkerBalance["other"] = [];
  const svRows = await db.select().from(svodniRowsTable).where(and(
    eq(svodniRowsTable.workerId, workerId), isNull(svodniRowsTable.segmentOf), inArray(svodniRowsTable.periodMonth, monthsToShow),
  ));
  const monthsWithSvodni = new Set(svRows.map(r => r.periodMonth));
  const push = (month: string, label: string, v: unknown) => { if (typeof v === "number" && v > 0.005) other.push({ month, label, amount: r2(v) }); };
  for (const r of svRows) {
    const ex = (r.extras ?? {}) as Record<string, unknown>;
    push(r.periodMonth, "Potrącenia", r.potracenia);
    push(r.periodMonth, "Hostel", r.hostel);
    if (r.city !== "Лодзь") push(r.periodMonth, "Dojazd", r.dojazd);
    push(r.periodMonth, "Odzież", r.odziez);
    push(r.periodMonth, "Komornik", r.komornik);
    push(r.periodMonth, "Kaucja", r.kaucja);
    push(r.periodMonth, "Karta pobytu", ex.kartaPobytu);
    push(r.periodMonth, "Kara klient", ex.karaKlient);
    push(r.periodMonth, "Kara ES", ex.karaEs);
    push(r.periodMonth, "Dokumenty", ex.dokumenty);
    push(r.periodMonth, "Zadłużenie", ex.zadluzenie);
  }
  const noSvodni = monthsToShow.filter(m => !monthsWithSvodni.has(m));
  if (noSvodni.length) {
    const hostel = await db.select({ month: hostelDeductionsTable.periodMonth, total: sql<number>`coalesce(sum(${hostelDeductionsTable.amount}), 0)` })
      .from(hostelDeductionsTable).where(and(eq(hostelDeductionsTable.workerId, workerId), inArray(hostelDeductionsTable.periodMonth, noSvodni)))
      .groupBy(hostelDeductionsTable.periodMonth);
    for (const h of hostel) push(h.month, "Hostel", Number(h.total));
    const transport = await db.select({ month: transportDeductionsTable.periodMonth, total: sql<number>`coalesce(sum(${transportDeductionsTable.amount}), 0)` })
      .from(transportDeductionsTable).where(and(eq(transportDeductionsTable.workerId, workerId), inArray(transportDeductionsTable.periodMonth, noSvodni)))
      .groupBy(transportDeductionsTable.periodMonth);
    for (const tr of transport) if (fac?.city !== "Лодзь") push(tr.month, "Dojazd", Number(tr.total));
    // одяг: «маємо зняти», ще не знято — до поточного місяця
    const [cloth] = await db.select({ total: sql<number>`coalesce(sum(${clothingItemsTable.price}), 0)` })
      .from(clothingItemsTable).where(and(eq(clothingItemsTable.workerId, workerId), eq(clothingItemsTable.deducted, false)));
    push(curMonth, "Odzież (не знято)", Number(cloth?.total ?? 0));
  }
  const otherTotal = r2(other.reduce((s, o) => s + o.amount, 0));

  const estimate = earnedTotal != null
    ? r2(earnedTotal - advancesTotal - penaltiesTotal - absencePenaltiesTotal - badaniaTotal - (debtPrev?.total ?? 0) - otherTotal)
    : null;

  return {
    factoryId, factoryName: fac?.name ?? null, months, stud26, earnedTotal,
    advances, advancesTotal, pendingAdvances, penaltiesTotal,
    absencePenaltiesTotal, absencePenaltiesCount: absRows.length, badaniaTotal, debtPrev, other, otherTotal, estimate,
  };
}

const zl = (n: number) => `${n.toLocaleString("pl-PL", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} zł`;

// Компактний блок для Telegram (Markdown; без імен — mdSafe не потрібен)
export function formatWorkerBalanceMd(b: WorkerBalance): string {
  const lines: string[] = [];
  if (b.factoryName) lines.push(`🏭 ${b.factoryName} · живі зміни`);
  for (const m of b.months) {
    const rate = m.rateNetto != null ? ` × ${m.rateNetto} zł/год нетто${b.stud26 ? " (студент)" : ""}` : "";
    lines.push(`⏱ ${m.month}: *${m.hours} год* (${m.shifts} зм.)${rate} = *${m.earned != null ? zl(m.earned) : "—"}*`);
  }
  if (b.earnedTotal == null) lines.push("💵 Нараховано: — (ставка не задана)");
  else if (b.months.length > 1) lines.push(`💵 Нараховано разом: *${zl(b.earnedTotal)}*`);
  if (b.advancesTotal > 0) lines.push(`➖ Залічки незняті: ${zl(b.advancesTotal)} (${b.advances.length})`);
  if (b.pendingAdvances > 0) lines.push(`⏳ Інші запити на розгляді: ${zl(b.pendingAdvances)}`);
  if (b.penaltiesTotal > 0) lines.push(`➖ Kary: ${zl(b.penaltiesTotal)}`);
  if (b.absencePenaltiesTotal > 0) lines.push(`➖ Штрафи за пропуски: ${zl(b.absencePenaltiesTotal)} (${b.absencePenaltiesCount})`);
  if (b.badaniaTotal > 0) lines.push(`➖ Залічка на badania: ${zl(b.badaniaTotal)}`);
  if (b.debtPrev) lines.push(`➖ Борг з ${b.debtPrev.month}: ${zl(b.debtPrev.total)}`);
  for (const o of b.other) lines.push(`➖ ${o.label} ${o.month}: ${zl(o.amount)}`);
  if (b.estimate != null) lines.push(`≈ *До виплати на сьогодні: ${zl(b.estimate)}*`);
  return lines.join("\n");
}
