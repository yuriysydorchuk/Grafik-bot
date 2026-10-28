// Тижневий облік годин (26.10.2026, factories.weekly_hours): рядки вкладки тижня,
// понеділковий запит / вівторкове нагадування працівникам у бот, збереження
// тижневого рапорту і виведення МІСЯЧНИХ monthly_reports / factory_hours з тижнів.
//
// Правила власника: тиждень — завжди цілий Пн–Нд, місяць — завжди цілий 1–31 і бере
// ЛИШЕ свої дні (арифметика — lib/weekMath.ts). Місячні таблиці для тижневої фабрики
// — похідні: сводна, Excel рапорту, листи клієнту читають їх як раніше, нічого не
// знаючи про тижні. Тотал без розбивки по днях на межі місяця → місяць четверга.
import {
  db, workersTable, factoriesTable, scheduleEntriesTable, scheduleWeeksTable, workerFactoriesTable,
  weeklyReportsTable, factoryWeekHoursTable, monthlyReportsTable, factoryHoursTable, workerFactoryCodesTable,
} from "@workspace/db";
import { and, eq, gte, lte, inArray, isNull, or, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { bot } from "../bot/instance";
import { t, asLang, dayShort, type Lang } from "../bot/i18n";
import { mdSafe } from "../bot/display";
import { factoryShiftHours } from "../bot/time";
import { loadWeekShiftOverrides, overrideFor, shiftDurationHours } from "./shiftOverrides";
import { DAYS, entryDateStr } from "../lib/dates";
import {
  weekDates, weekEnd, weeksOverlappingMonth, monthsOfWeek, isoMonthOfWeek, splitWeekByMonth, flattenWeekDays, dayValueTotal, round2, weekLabel, ddmm,
  type DayHours,
} from "../lib/weekMath";
import { logsForDates, shiftLabel, wallHHMM, type ShiftLog } from "./shiftLogs";

export type WeekDayCell = {
  date: string;
  entry?: { id: number; shift: string; status: string; hours: number; weekApproved: boolean };
  log?: { id: number; status: string; startedAt: string | null; endedAt: string | null; hours: number | null; startSource: string | null; endSource: string | null };
  report?: { shift: string | null; hours: number };
  factory?: number;
};
export type WeekRow = {
  workerId: number; name: string; code: string | null; isActive: boolean; hasTelegram: boolean;
  days: Record<string, WeekDayCell>;
  hours: number;              // їх години: Σ present-записів тижня (затвердженого) — через відмітки
  hoursUnapproved: number;    // те саме, якщо тиждень ще не approved (довідково)
  report: { id: number; hoursReported: number | null; daysSum: number; photoLink: string | null; requestSentAt: string | null; remindSentAt: string | null; submittedAt: string | null } | null;
  factory: {
    id: number; hours: number; daysSum: number; hasDays: boolean; source: string; confirmed: boolean;
    // підтвердження працівником у боті (запит «На підтвердження людям» по тижню)
    askSentAt: string | null; askHours: number | null; workerResponse: string | null; workerResponseAt: string | null; workerNote: string | null;
  } | null;
};

type FacRow = typeof factoriesTable.$inferSelect;
const iso = (d: Date | null | undefined) => d ? d.toISOString() : null;

/** Кому слати запит тижня: активні на фабриці (основна або чинна додаткова) ∪ хто мав на ній зміни тижня. */
export async function weekRecipients(factoryId: number, weekStart: string): Promise<Set<number>> {
  const end = weekEnd(weekStart);
  const ids = new Set<number>();
  for (const w of await db.select({ id: workersTable.id }).from(workersTable)
    .where(and(eq(workersTable.isActive, true), eq(workersTable.factoryId, factoryId)))) ids.add(w.id);
  for (const wf of await db.select({ workerId: workerFactoriesTable.workerId }).from(workerFactoriesTable)
    .innerJoin(workersTable, eq(workerFactoriesTable.workerId, workersTable.id))
    .where(and(
      eq(workerFactoriesTable.factoryId, factoryId), eq(workersTable.isActive, true),
      or(isNull(workerFactoriesTable.validFrom), lte(workerFactoriesTable.validFrom, end)),
      or(isNull(workerFactoriesTable.validTo), gte(workerFactoriesTable.validTo, weekStart)),
    ))) ids.add(wf.workerId);
  const [week] = await db.select({ id: scheduleWeeksTable.id }).from(scheduleWeeksTable)
    .where(eq(scheduleWeeksTable.weekStart, weekStart)).orderBy(sql`(${scheduleWeeksTable.status} = 'approved') desc`, scheduleWeeksTable.id).limit(1);
  if (week) {
    for (const e of await db.select({ workerId: scheduleEntriesTable.workerId }).from(scheduleEntriesTable)
      .where(and(eq(scheduleEntriesTable.weekId, week.id), eq(scheduleEntriesTable.factoryId, factoryId)))) ids.add(e.workerId);
  }
  return ids;
}

/** Рядки вкладки тижня фабрики: по людях — дні (запис/відмітка/рапорт/фабрика), рапорт і години фабрики. */
export async function buildWeekRows(factoryId: number, weekStart: string): Promise<{ fac: FacRow | undefined; rows: WeekRow[]; weekApproved: boolean }> {
  const [fac] = await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  const dates = weekDates(weekStart);
  const byWorker = new Map<number, WeekRow>();
  const ensure = (id: number) => {
    let r = byWorker.get(id);
    if (!r) { r = { workerId: id, name: "", code: null, isActive: false, hasTelegram: false, days: {}, hours: 0, hoursUnapproved: 0, report: null, factory: null }; byWorker.set(id, r); }
    return r;
  };
  const cell = (r: WeekRow, date: string) => (r.days[date] ??= { date });

  // записи графіку тижня (будь-який статус тижня; approved — рахується в «їх години»)
  const weeks = await db.select({ id: scheduleWeeksTable.id, status: scheduleWeeksTable.status }).from(scheduleWeeksTable)
    .where(eq(scheduleWeeksTable.weekStart, weekStart));
  const weekApproved = weeks.some(w => w.status === "approved");
  const weekRow = weeks.find(w => w.status === "approved") ?? weeks.at(-1);
  if (weekRow) {
    const ov = await loadWeekShiftOverrides(weekStart, factoryId);
    const entries = await db.select().from(scheduleEntriesTable)
      .where(and(eq(scheduleEntriesTable.weekId, weekRow.id), eq(scheduleEntriesTable.factoryId, factoryId)));
    for (const e of entries) {
      const date = entryDateStr(weekStart, e.dayOfWeek);
      const o = overrideFor(ov, factoryId, weekStart, e.dayOfWeek, e.shift);
      const hours = e.hoursOverride ?? (o ? shiftDurationHours(o.start, o.end) : factoryShiftHours(fac, e.shift));
      const r = ensure(e.workerId);
      cell(r, date).entry = { id: e.id, shift: e.shift, status: e.status, hours: round2(hours), weekApproved };
      if (e.status === "present") { if (weekApproved) r.hours = round2(r.hours + hours); else r.hoursUnapproved = round2(r.hoursUnapproved + hours); }
    }
  }
  for (const l of await logsForDates(factoryId, dates)) {
    const r = ensure(l.workerId);
    cell(r, String(l.workDate)).log = {
      id: l.id, status: l.status, startedAt: iso(l.startedAt), endedAt: iso(l.endedAt), hours: l.hours,
      startSource: l.startSource, endSource: l.endSource,
    };
  }
  for (const rep of await db.select().from(weeklyReportsTable)
    .where(and(eq(weeklyReportsTable.factoryId, factoryId), eq(weeklyReportsTable.weekStart, weekStart)))) {
    const r = ensure(rep.workerId);
    let daysSum = 0;
    for (const [d, v] of Object.entries(rep.days ?? {})) { if (dates.includes(d)) { cell(r, d).report = v; daysSum += v.hours; } }
    r.report = {
      id: rep.id, hoursReported: rep.hoursReported, daysSum: round2(daysSum), photoLink: rep.photoLink,
      requestSentAt: iso(rep.requestSentAt), remindSentAt: iso(rep.remindSentAt), submittedAt: iso(rep.submittedAt),
    };
  }
  for (const fh of await db.select().from(factoryWeekHoursTable)
    .where(and(eq(factoryWeekHoursTable.factoryId, factoryId), eq(factoryWeekHoursTable.weekStart, weekStart)))) {
    const r = ensure(fh.workerId);
    const flat = flattenWeekDays(weekStart, fh.days);
    for (const [d, h] of Object.entries(flat)) cell(r, d).factory = h;
    r.factory = {
      id: fh.id, hours: fh.hours, daysSum: round2(Object.values(flat).reduce((s, h) => s + h, 0)), hasDays: Object.keys(flat).length > 0, source: fh.source, confirmed: fh.confirmed,
      askSentAt: iso(fh.askSentAt), askHours: fh.askHours, workerResponse: fh.workerResponse, workerResponseAt: iso(fh.workerResponseAt), workerNote: fh.workerNote,
    };
  }
  for (const id of await weekRecipients(factoryId, weekStart)) ensure(id);

  const ids = [...byWorker.keys()];
  if (ids.length) {
    const metas = await db.select({ id: workersTable.id, fullName: workersTable.fullName, code: workersTable.workerCode, isActive: workersTable.isActive, telegramId: workersTable.telegramId })
      .from(workersTable).where(inArray(workersTable.id, ids));
    const facCodes = await db.select({ workerId: workerFactoryCodesTable.workerId, code: workerFactoryCodesTable.code })
      .from(workerFactoryCodesTable).where(and(eq(workerFactoryCodesTable.factoryId, factoryId), inArray(workerFactoryCodesTable.workerId, ids)));
    const fcode = new Map(facCodes.map(c => [c.workerId, c.code]));
    for (const m of metas) {
      const r = byWorker.get(m.id)!;
      r.name = m.fullName; r.code = fcode.get(m.id) ?? m.code; r.isActive = m.isActive; r.hasTelegram = !!m.telegramId;
    }
  }
  const rows = [...byWorker.values()].filter(r => r.name).sort((a, b) => a.name.localeCompare(b.name, "pl"));
  return { fac, rows, weekApproved };
}

// ── Місячні таблиці — похідні від тижнів ────────────────────────────────────
/** Перерахувати monthly_reports / factory_hours пари (працівник, фабрика) за місяці з тижнів. */
export async function syncMonthsFromWeeks(workerId: number, factoryId: number, months: string[]): Promise<void> {
  for (const month of [...new Set(months)]) {
    const weeks = weeksOverlappingMonth(month);
    // рапорти
    const reps = await db.select().from(weeklyReportsTable).where(and(
      eq(weeklyReportsTable.workerId, workerId), eq(weeklyReportsTable.factoryId, factoryId),
      inArray(weeklyReportsTable.weekStart, weeks), sql`${weeklyReportsTable.submittedAt} IS NOT NULL`,
    ));
    if (reps.length) {
      let total = 0; let link: string | null = null;
      for (const r of reps) {
        const days: DayHours = {};
        for (const [d, v] of Object.entries(r.days ?? {})) if (v.hours > 0) days[d] = v.hours;
        const { byMonth } = splitWeekByMonth(String(r.weekStart), days, r.hoursReported);
        total += byMonth[month] ?? 0;
        if (r.photoLink && (byMonth[month] ?? 0) > 0) link = r.photoLink; // останній тиждень місяця з фото
      }
      total = round2(total);
      // місяць без частки годин (тиждень на межі весь пішов у сусідній місяць) — рядок не пишемо;
      // справжній 0 («не працював») — лише коли поданий тиждень лежить цілком у цьому місяці
      const explicitZero = reps.some(r => monthsOfWeek(String(r.weekStart)).length === 1);
      if (total > 0 || explicitZero) await db.insert(monthlyReportsTable).values({ workerId, month, factoryId, hoursReported: total, photoLink: link })
        .onConflictDoUpdate({
          target: [monthlyReportsTable.workerId, monthlyReportsTable.month, monthlyReportsTable.factoryId],
          set: { hoursReported: total, photoLink: sql`coalesce(${link}, ${monthlyReportsTable.photoLink})`, createdAt: new Date() },
        });
      // є подані тижні, але частки місяця вже нема (години перенесли в сусідній місяць) — похідний рядок прибрати
      else await db.delete(monthlyReportsTable).where(and(eq(monthlyReportsTable.workerId, workerId), eq(monthlyReportsTable.month, month), eq(monthlyReportsTable.factoryId, factoryId)));
    }
    // години фабрики
    const fhs = await db.select().from(factoryWeekHoursTable).where(and(
      eq(factoryWeekHoursTable.workerId, workerId), eq(factoryWeekHoursTable.factoryId, factoryId),
      inArray(factoryWeekHoursTable.weekStart, weeks),
    ));
    if (fhs.length) {
      let total = 0; const days: Record<string, number | Record<string, number>> = {}; let allConfirmed = true;
      // відповідь працівника на місяць — зведення по тижнях: усі підтверджені → confirmed,
      // хоч один «є помилка» → dispute (нотатка першого), решта → запит без відповіді/без запиту
      let asked: Date | null = null, anyDispute: typeof fhs[number] | null = null, allConfirmedByWorker = true, anyAsked = false;
      let staleDelta = 0; // Σ (години зараз − години, які людина підтверджувала): ≠0 → місяць теж «застаріле підтвердження»
      for (const r of fhs) {
        const flat = flattenWeekDays(String(r.weekStart), r.days);
        const { byMonth } = splitWeekByMonth(String(r.weekStart), flat, r.hours);
        total += byMonth[month] ?? 0;
        for (const [d, v] of Object.entries(r.days ?? {})) if (d.slice(0, 7) === month && weekDates(String(r.weekStart)).includes(d)) days[d] = v;
        if (!r.confirmed) allConfirmed = false;
        if (r.askSentAt) { anyAsked = true; if (!asked || r.askSentAt > asked) asked = r.askSentAt; }
        if (r.workerResponse === "dispute" && !anyDispute) anyDispute = r;
        if (r.askSentAt && r.workerResponse !== "confirmed") allConfirmedByWorker = false; // лише запитані тижні (ревʼю agy 28.10.2026)
        if (r.workerResponse === "confirmed" && r.askHours != null) staleDelta += r.hours - r.askHours;
      }
      const ack = anyDispute
        ? { workerResponse: "dispute", workerResponseAt: anyDispute.workerResponseAt, workerNote: anyDispute.workerNote ? `${weekLabel(String(anyDispute.weekStart))}: ${anyDispute.workerNote}` : null }
        : anyAsked && allConfirmedByWorker ? { workerResponse: "confirmed", workerResponseAt: fhs.map(r => r.workerResponseAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null, workerNote: null }
        : { workerResponse: null, workerResponseAt: null, workerNote: null };
      total = round2(total);
      const [cur] = await db.select({ hours: factoryHoursTable.hours, confirmed: factoryHoursTable.confirmed, source: factoryHoursTable.source }).from(factoryHoursTable)
        .where(and(eq(factoryHoursTable.workerId, workerId), eq(factoryHoursTable.month, month), eq(factoryHoursTable.factoryId, factoryId)));
      if (total <= 0 && !Object.keys(days).length) {
        // частки цього місяця нема (тотал без днів пішов у місяць четверга) — похідний рядок прибрати
        if (cur?.source === "weekly") await db.delete(factoryHoursTable)
          .where(and(eq(factoryHoursTable.workerId, workerId), eq(factoryHoursTable.month, month), eq(factoryHoursTable.factoryId, factoryId)));
        continue;
      }
      const confirmed = allConfirmed; // «все ок» місяця тижневої фабрики = усі її тижні підтверджені
      void cur;
      // askHours місяця = тотал мінус те, що змінили після підтвердження (ревʼю codex 28.10.2026): веб жовтить, коли ≠ hours
      const ackSet = { askSentAt: asked, askHours: anyAsked ? round2(total - staleDelta) : null, ...ack };
      await db.insert(factoryHoursTable).values({ workerId, month, factoryId, hours: total, source: "weekly", days: Object.keys(days).length ? days : null, confirmed, ...ackSet })
        .onConflictDoUpdate({
          target: [factoryHoursTable.workerId, factoryHoursTable.month, factoryHoursTable.factoryId],
          set: { hours: total, source: "weekly", days: Object.keys(days).length ? days : null, confirmed, ...ackSet, updatedAt: new Date() },
        });
    }
  }
}

export const syncWeek = (workerId: number, factoryId: number, weekStart: string) => syncMonthsFromWeeks(workerId, factoryId, monthsOfWeek(weekStart));

// ── Години фабрики за тиждень ────────────────────────────────────────────────
export async function upsertFactoryWeekHours(
  workerId: number, factoryId: number, weekStart: string,
  hours: number, source: string, days: Record<string, number | Record<string, number>> | null,
): Promise<void> {
  const [cur] = await db.select({ hours: factoryWeekHoursTable.hours, confirmed: factoryWeekHoursTable.confirmed }).from(factoryWeekHoursTable)
    .where(and(eq(factoryWeekHoursTable.workerId, workerId), eq(factoryWeekHoursTable.factoryId, factoryId), eq(factoryWeekHoursTable.weekStart, weekStart)));
  const confirmed = !!cur && cur.confirmed && Math.abs(cur.hours - hours) < 0.005; // «все ок» скидається при зміні годин
  await db.insert(factoryWeekHoursTable).values({ workerId, factoryId, weekStart, hours, source, days, confirmed })
    .onConflictDoUpdate({
      target: [factoryWeekHoursTable.workerId, factoryWeekHoursTable.factoryId, factoryWeekHoursTable.weekStart],
      set: { hours, source, days, confirmed, updatedAt: new Date() },
      // відповідь працівника лишається (askHours зберігає, що саме він підтверджував — веб жовтить, якщо число змінилось)
    });
  await syncWeek(workerId, factoryId, weekStart);
}

export async function deleteFactoryWeekHours(workerId: number, factoryId: number, weekStart: string): Promise<void> {
  await db.delete(factoryWeekHoursTable)
    .where(and(eq(factoryWeekHoursTable.workerId, workerId), eq(factoryWeekHoursTable.factoryId, factoryId), eq(factoryWeekHoursTable.weekStart, weekStart)));
  // місячний рядок: перерахувати з решти тижнів або прибрати похідний, якщо тижнів не лишилось
  for (const month of monthsOfWeek(weekStart)) {
    const rest = await db.select({ id: factoryWeekHoursTable.id }).from(factoryWeekHoursTable).where(and(
      eq(factoryWeekHoursTable.workerId, workerId), eq(factoryWeekHoursTable.factoryId, factoryId),
      inArray(factoryWeekHoursTable.weekStart, weeksOverlappingMonth(month)),
    )).limit(1);
    if (rest.length) await syncMonthsFromWeeks(workerId, factoryId, [month]);
    else await db.delete(factoryHoursTable).where(and(
      eq(factoryHoursTable.workerId, workerId), eq(factoryHoursTable.month, month), eq(factoryHoursTable.factoryId, factoryId), eq(factoryHoursTable.source, "weekly"),
    ));
  }
}

/** Очистити години фабрики за тиждень (усіх або вибраних) — рапорти працівників не чіпаються. */
export async function clearFactoryWeekHours(factoryId: number, weekStart: string, workerIds?: number[]): Promise<number> {
  if (workerIds && !workerIds.length) return 0; // явний порожній вибір — нічого не чистимо (без параметра = весь тиждень)
  const rows = await db.select({ workerId: factoryWeekHoursTable.workerId }).from(factoryWeekHoursTable)
    .where(and(eq(factoryWeekHoursTable.factoryId, factoryId), eq(factoryWeekHoursTable.weekStart, weekStart),
      ...(workerIds?.length ? [inArray(factoryWeekHoursTable.workerId, workerIds)] : [])));
  for (const r of rows) await deleteFactoryWeekHours(r.workerId, factoryId, weekStart);
  return rows.length;
}

/**
 * Очистити години фабрики за МІСЯЦЬ тижневої фабрики (кнопка «Очистити години фабрики» на вкладці
 * «Місяць»): тижні цілком у місяці — видаляються; тиждень на межі з розбивкою по днях — лишаються
 * дні сусіднього місяця (тотал перераховується); тотал без днів — належить місяцю четверга (ISO).
 */
export async function clearFactoryWeekHoursForMonth(factoryId: number, month: string, workerIds: number[]): Promise<number> {
  if (!workerIds.length) return 0;
  const weeks = weeksOverlappingMonth(month);
  const rows = await db.select().from(factoryWeekHoursTable).where(and(
    eq(factoryWeekHoursTable.factoryId, factoryId), inArray(factoryWeekHoursTable.weekStart, weeks), inArray(factoryWeekHoursTable.workerId, workerIds),
  ));
  let cleared = 0;
  for (const r of rows) {
    const ws = String(r.weekStart);
    const wholeInMonth = monthsOfWeek(ws).length === 1;
    const flat = flattenWeekDays(ws, r.days);
    if (wholeInMonth || (!Object.keys(flat).length && isoMonthOfWeek(ws) === month)) {
      await deleteFactoryWeekHours(r.workerId, factoryId, ws); cleared++; continue;
    }
    if (!Object.keys(flat).length) continue; // тотал без днів, що належить сусідньому місяцю
    const rest: Record<string, number | Record<string, number>> = {};
    for (const [d, v] of Object.entries(r.days ?? {})) if (d.slice(0, 7) !== month && weekDates(ws).includes(d)) rest[d] = v;
    if (!Object.keys(rest).length) { await deleteFactoryWeekHours(r.workerId, factoryId, ws); cleared++; continue; }
    // тотал, що лишається, = частка сусіднього місяця за тим самим правилом, що й місячний рядок
    // (тотал масштабує дні, якщо не збігається з їх сумою — ревʼю codex 28.10.2026), не сира сума днів
    const { byMonth } = splitWeekByMonth(ws, flat, r.hours);
    const total = round2(Object.entries(byMonth).filter(([m]) => m !== month).reduce((s, [, h]) => s + h, 0));
    if (total <= 0) { await deleteFactoryWeekHours(r.workerId, factoryId, ws); cleared++; continue; }
    await upsertFactoryWeekHours(r.workerId, factoryId, ws, total, r.source, rest);
    cleared++;
  }
  // похідний місячний рядок міг лишитись (тижні сусіднього місяця перерахували його) — для цього місяця прибираємо явно
  await db.delete(factoryHoursTable).where(and(
    eq(factoryHoursTable.factoryId, factoryId), eq(factoryHoursTable.month, month), eq(factoryHoursTable.source, "weekly"), inArray(factoryHoursTable.workerId, workerIds),
  ));
  return cleared;
}

/** Розсилка «підтверди свої години фабрики за тиждень» у бот (кнопки fhw:ok|no:<id>); повторна скидає відповідь. */
export async function sendWeekAckRequests(factoryId: number, weekStart: string, workerIds: number[]): Promise<{ sent: number; skipped: number }> {
  const [fac] = await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  if (!fac) throw new Error("Фабрику не знайдено");
  const rows = await db.select().from(factoryWeekHoursTable).where(and(
    eq(factoryWeekHoursTable.factoryId, factoryId), eq(factoryWeekHoursTable.weekStart, weekStart), inArray(factoryWeekHoursTable.workerId, workerIds),
  ));
  const people = rows.length ? await db.select({ id: workersTable.id, telegramId: workersTable.telegramId, language: workersTable.language })
    .from(workersTable).where(inArray(workersTable.id, rows.map(r => r.workerId))) : [];
  const byId = new Map(people.map(p => [p.id, p]));
  let sent = 0, skipped = 0;
  for (const row of rows) {
    const w = byId.get(row.workerId);
    if (!w?.telegramId) { skipped++; continue; }
    const lang = asLang(w.language);
    try {
      await bot.telegram.sendMessage(w.telegramId, t(lang, "fh.askWeek", { factory: mdSafe(fac.name), from: ddmm(weekStart), to: ddmm(weekEnd(weekStart)), hours: row.hours }), {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[
          { text: t(lang, "fh.btnOk"), callback_data: `fhw:ok:${row.id}` },
          { text: t(lang, "fh.btnNo"), callback_data: `fhw:no:${row.id}` },
        ]] },
      });
      await db.update(factoryWeekHoursTable)
        .set({ askSentAt: new Date(), askHours: row.hours, workerResponse: null, workerResponseAt: null, workerNote: null, updatedAt: new Date() })
        .where(eq(factoryWeekHoursTable.id, row.id));
      sent++;
    } catch (err) { logger.warn({ err, workerId: row.workerId }, "weekly ack request failed"); skipped++; }
    await new Promise(r => setTimeout(r, 50));
  }
  for (const r of rows) await syncWeek(r.workerId, factoryId, weekStart);
  return { sent, skipped: skipped + (workerIds.length - rows.length) };
}

/** Відповідь працівника на запит тижня (бот): ✅ / ❌ (+ нотатка окремим повідомленням). */
export async function setWeekAckResponse(id: number, response: "confirmed" | "dispute", note?: string | null): Promise<void> {
  const [row] = await db.update(factoryWeekHoursTable)
    .set(note !== undefined ? { workerResponse: response, workerNote: note, updatedAt: new Date() } : { workerResponse: response, workerResponseAt: new Date(), workerNote: null, updatedAt: new Date() })
    .where(eq(factoryWeekHoursTable.id, id)).returning({ workerId: factoryWeekHoursTable.workerId, factoryId: factoryWeekHoursTable.factoryId, weekStart: factoryWeekHoursTable.weekStart });
  if (row) await syncWeek(row.workerId, row.factoryId, String(row.weekStart));
}

// ── Запит рапорту тижня в бот (понеділок) / нагадування (вівторок) ───────────
const DOW_JS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const dayLbl = (lang: Lang, date: string) => `${dayShort(lang, DOW_JS[new Date(date + "T00:00:00").getDay()]!)} ${ddmm(date)}`;

/** Текст запиту: по днях — зміна за графіком і відмітки. */
export function weekRequestText(lang: Lang, fac: FacRow, weekStart: string, row: WeekRow | undefined, remind: boolean): string {
  const lines = weekDates(weekStart).map(date => {
    const c = row?.days[date];
    let info: string;
    if (c?.entry && c.entry.status !== "absent") {
      info = shiftLabel(lang, c.entry.shift);
      const l = c.log;
      if (l?.startedAt) {
        const s = wallHHMM(new Date(l.startedAt));
        const e = l.endedAt ? wallHHMM(new Date(l.endedAt)) : "…";
        info += ` · ${t(lang, "wkr.logged", { start: s, end: e, hours: l.hours ?? "?" })}`;
      }
    } else if (c?.entry?.status === "absent" || c?.log?.status === "absent") info = t(lang, "wkr.absent");
    else info = t(lang, "wkr.dayOff");
    return `${dayLbl(lang, date)} — ${info}`;
  });
  return (remind ? t(lang, "wkr.remindHdr") + "\n\n" : "") + t(lang, "wkr.request", {
    from: ddmm(weekStart), to: ddmm(weekEnd(weekStart)), factory: mdSafe(fac.name), days: mdSafe(lines.join("\n")),
  });
}

export async function sendWeeklyRequests(opts: { weekStart: string; factoryId?: number; remind?: boolean; workerIds?: number[] }): Promise<{ notified: number; skipped: number }> {
  const facs = opts.factoryId
    ? await db.select().from(factoriesTable).where(eq(factoriesTable.id, opts.factoryId))
    : await db.select().from(factoriesTable).where(eq(factoriesTable.weeklyHours, true));
  let notified = 0, skipped = 0;
  for (const fac of facs) {
    const { rows } = await buildWeekRows(fac.id, opts.weekStart);
    const recipients = await weekRecipients(fac.id, opts.weekStart);
    const metas = recipients.size ? await db.select({ id: workersTable.id, telegramId: workersTable.telegramId, language: workersTable.language })
      .from(workersTable).where(inArray(workersTable.id, [...recipients])) : [];
    for (const w of metas) {
      if (opts.workerIds?.length && !opts.workerIds.includes(w.id)) continue;
      const row = rows.find(r => r.workerId === w.id);
      if (!w.telegramId || row?.report?.submittedAt) { skipped++; continue; }
      const lang = asLang(w.language);
      const [rep] = await db.insert(weeklyReportsTable).values({
        workerId: w.id, factoryId: fac.id, weekStart: opts.weekStart,
        ...(opts.remind ? { remindSentAt: new Date() } : { requestSentAt: new Date() }),
      }).onConflictDoUpdate({
        target: [weeklyReportsTable.workerId, weeklyReportsTable.factoryId, weeklyReportsTable.weekStart],
        set: opts.remind ? { remindSentAt: new Date(), updatedAt: new Date() } : { requestSentAt: new Date(), updatedAt: new Date() },
      }).returning({ id: weeklyReportsTable.id });
      try {
        await bot.telegram.sendMessage(w.telegramId, weekRequestText(lang, fac, opts.weekStart, row, !!opts.remind), {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: t(lang, "wkr.btnSubmit"), callback_data: `wkr:go:${rep!.id}` }]] },
        });
        notified++;
      } catch (err) { logger.warn({ err, workerId: w.id }, "weekly request failed"); skipped++; }
      await new Promise(r => setTimeout(r, 40));
    }
  }
  logger.info({ notified, skipped, weekStart: opts.weekStart, remind: !!opts.remind }, "Weekly hours requests sent");
  return { notified, skipped };
}

/** Рядок weekly_reports для пари (створити порожній, якщо нема). */
export async function ensureWeeklyReport(workerId: number, factoryId: number, weekStart: string) {
  const [row] = await db.insert(weeklyReportsTable).values({ workerId, factoryId, weekStart })
    .onConflictDoUpdate({ target: [weeklyReportsTable.workerId, weeklyReportsTable.factoryId, weeklyReportsTable.weekStart], set: { updatedAt: new Date() } })
    .returning();
  return row!;
}

/** Збереження поданого рапорту тижня (бот): зміни по днях + тотал + фото → похідні місячні рядки. */
export async function saveWeeklyReport(id: number, data: { days: Record<string, { shift: string | null; hours: number }>; hoursReported: number; photoLink: string | null }) {
  const [row] = await db.update(weeklyReportsTable).set({
    days: data.days, hoursReported: data.hoursReported, photoLink: data.photoLink, submittedAt: new Date(), updatedAt: new Date(),
  }).where(eq(weeklyReportsTable.id, id)).returning();
  if (row) await syncWeek(row.workerId, row.factoryId, String(row.weekStart));
  return row;
}

export { DAYS };
