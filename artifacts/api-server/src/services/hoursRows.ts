// Спільний збирач рядків «Обліку годин» місяця: явки затверджених тижнів +
// рапорти працівників + години фабрики, злиті по парі (працівник, фабрика).
// ЄДИНЕ джерело правди для сторінки GET /hours і Excel-експорту
// buildReportHoursExcel: розсинхрон двох окремих збирачів уже давав інцидент
// (04.08.2026 — експорт ішов лише по активних працівниках і мовчки губив
// рапорти звільнених/переведених: у файлі було менше людей і годин, ніж на
// сторінці). Рядок пари потрапляє сюди, якщо є ХОЧ ЩОСЬ: явка місяця, рапорт,
// години фабрики — незалежно від isActive; активні без нічого показуються
// нульовим рядком під своєю поточною фабрикою.
import { db } from "@workspace/db";
import {
  companiesTable, factoriesTable, factoryHoursTable, hoursMonthExclusionsTable, hoursNotesTable, monthlyReportsTable,
  scheduleEntriesTable, scheduleWeeksTable, workersTable,
} from "@workspace/db";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { entryDateStr, weekFromForMonth } from "../lib/dates";
import { factoryShiftHours } from "../bot/time";

export type FactoryRow = typeof factoriesTable.$inferSelect;

export type HoursMergedRow = {
  workerId: number;
  name: string;
  code: string | null;
  isActive: boolean;
  positionId: number | null;
  profileRate: number | null;
  isStudent: boolean | null;
  under26: boolean | null;
  legalStatus: string | null;
  birthDate: string | Date | null;
  factoryId: number | null;
  factory: string | null;
  firm: string | null;                 // фірма фабрики (companies.name)
  factoryShiftCount: number;
  byShift: Record<string, number>;
  shifts: number;
  weekendShifts: number;               // кількість змін, відпрацьованих у сб/нд
  hours: number;                       // затверджені явки (підтверджує водій/графікова)
  reportHours: number | null;
  reportSubmitted: boolean;
  reportLink: string | null;
  factoryHours: number | null;
  factoryDays: Record<string, number | Record<string, number>> | null;
  factoryConfirmed: boolean;
  askSentAt: Date | null;
  askHours: number | null;
  workerResponse: string | null;
  workerResponseAt: Date | null;
  workerNote: string | null;
  note: string | null;                 // ручна замітка графіка/офісу (hours_notes)
  createdViaImport: boolean;
};

const rowKey = (workerId: number, factoryId: number | null) => `${workerId}|${factoryId ?? 0}`;

export async function buildHoursMergedRows(month: string): Promise<{
  rows: HoursMergedRow[];
  facById: Map<number, FactoryRow>;
  /** активні, приховані з цього місяця (hours_month_exclusions) — для чипа «приховані» на вкладці фабрики */
  excluded: { workerId: number; name: string; factoryId: number | null; reason: string }[];
}> {
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;

  const facRows = await db.select().from(factoriesTable);
  const facById = new Map<number, FactoryRow>(facRows.map(f => [f.id, f]));
  const companyRows = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable);
  const companyName = new Map<number, string>(companyRows.map(c => [c.id, c.name]));
  const firmOf = (fac: FactoryRow | undefined) => fac?.companyId != null ? companyName.get(fac.companyId) ?? null : null;

  type WorkerMeta = {
    id: number; fullName: string; code: string | null; positionId: number | null;
    factoryId: number | null; rate: number | null; isStudent: boolean | null; under26: boolean | null;
    legalStatus: string | null; birthDate: string | Date | null; isActive: boolean;
    employmentStartDate?: string | Date | null; createdAt?: string | Date | null;
  };
  const workerMetaCols = {
    id: workersTable.id, fullName: workersTable.fullName, code: workersTable.workerCode,
    positionId: workersTable.positionId, factoryId: workersTable.factoryId,
    rate: workersTable.hourlyRate, isStudent: workersTable.isStudent, under26: workersTable.under26,
    legalStatus: workersTable.legalStatus, birthDate: workersTable.birthDate, isActive: workersTable.isActive,
    employmentStartDate: workersTable.employmentStartDate, createdAt: workersTable.createdAt,
  };

  const blankRow = (w: WorkerMeta, factoryId: number | null): HoursMergedRow => {
    const fac = factoryId != null ? facById.get(factoryId) : undefined;
    return {
      workerId: w.id, name: w.fullName, code: w.code, isActive: w.isActive,
      positionId: w.positionId, profileRate: w.rate,
      isStudent: w.isStudent, under26: w.under26, legalStatus: w.legalStatus, birthDate: w.birthDate,
      factoryId, factory: fac?.name ?? null, firm: firmOf(fac),
      factoryShiftCount: Math.min(6, Math.max(1, fac?.shiftCount ?? 3)),
      byShift: {}, shifts: 0, weekendShifts: 0, hours: 0,
      reportHours: null, reportSubmitted: false, reportLink: null,
      factoryHours: null, factoryDays: null, factoryConfirmed: false,
      askSentAt: null, askHours: null, workerResponse: null, workerResponseAt: null, workerNote: null,
      note: null,
      createdViaImport: false,
    };
  };

  // Явки затверджених тижнів; кожна зміна зараховується за фактичною датою
  // (тиждень легально перетинає межу місяця).
  const entries = await db
    .select({
      workerId: scheduleEntriesTable.workerId, factoryId: scheduleEntriesTable.factoryId,
      shift: scheduleEntriesTable.shift, hoursOverride: scheduleEntriesTable.hoursOverride,
      day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart,
      name: workersTable.fullName, code: workersTable.workerCode, positionId: workersTable.positionId,
      curFactoryId: workersTable.factoryId, rate: workersTable.hourlyRate,
      isStudent: workersTable.isStudent, under26: workersTable.under26,
      legalStatus: workersTable.legalStatus, birthDate: workersTable.birthDate, isActive: workersTable.isActive,
    })
    .from(scheduleEntriesTable)
    .leftJoin(workersTable, eq(scheduleEntriesTable.workerId, workersTable.id))
    .leftJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
    .where(and(
      eq(scheduleWeeksTable.status, "approved"),
      gte(scheduleWeeksTable.weekStart, weekFromForMonth(monthStart)),
      lt(scheduleWeeksTable.weekStart, monthEnd),
      eq(scheduleEntriesTable.status, "present"),
    ));

  const byKey = new Map<string, HoursMergedRow>();
  for (const r of entries) {
    if (!r.workerId || !r.name) continue;
    const date = entryDateStr(String(r.weekStart), r.day);
    if (date < monthStart || date >= monthEnd) continue;
    const key = rowKey(r.workerId, r.factoryId);
    if (!byKey.has(key)) byKey.set(key, blankRow({
      id: r.workerId, fullName: r.name, code: r.code, positionId: r.positionId,
      factoryId: r.curFactoryId, rate: r.rate, isStudent: r.isStudent, under26: r.under26,
      legalStatus: r.legalStatus, birthDate: r.birthDate, isActive: r.isActive ?? false,
    }, r.factoryId));
    const row = byKey.get(key)!;
    const fac = r.factoryId != null ? facById.get(r.factoryId) : undefined;
    row.shifts++;
    row.hours += r.hoursOverride ?? factoryShiftHours(fac, r.shift as any);
    row.byShift[r.shift] = (row.byShift[r.shift] ?? 0) + 1;
    if (r.day === "sat" || r.day === "sun") row.weekendShifts++;
  }

  // Всі активні працівники — навіть без жодної зміни місяця (нульовий рядок
  // під поточною фабрикою), щоб було видно, хто не здав рапорт. Але:
  //  • людина потрапляє в списки лише від дати працевлаштування (нема — від
  //    створення профілю): найнятий у серпні не висить у липневому обліку;
  //  • виключені на цей місяць (hours_month_exclusions: прибрано вручну /
  //    відпустка / ще не приступив) — ховаються, поки нема реальних даних.
  const dayStr = (v: string | Date | null | undefined): string | null => {
    if (!v) return null;
    if (typeof v === "string") return v.slice(0, 10);
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  };
  const exclusionRows = await db.select().from(hoursMonthExclusionsTable).where(eq(hoursMonthExclusionsTable.month, month));
  const exclusionByWorker = new Map(exclusionRows.map(e => [e.workerId, e.reason]));
  const activeWorkers = await db.select(workerMetaCols).from(workersTable).where(eq(workersTable.isActive, true));
  const workersWithRows = new Set<number>([...byKey.values()].map(w => w.workerId));
  const excluded: { workerId: number; name: string; factoryId: number | null; reason: string }[] = [];
  for (const aw of activeWorkers) {
    if (workersWithRows.has(aw.id)) continue;
    const startStr = dayStr(aw.employmentStartDate) ?? dayStr(aw.createdAt);
    if (startStr != null && startStr >= monthEnd) continue; // приступив після цього місяця
    const reason = exclusionByWorker.get(aw.id);
    if (reason) { excluded.push({ workerId: aw.id, name: aw.fullName, factoryId: aw.factoryId, reason }); continue; }
    byKey.set(rowKey(aw.id, aw.factoryId), blankRow(aw, aw.factoryId));
  }
  const curFacByWorker = new Map(activeWorkers.map(a => [a.id, a.factoryId]));

  // Довідка про працівників, на яких посилаються рапорти/години фабрики поза
  // наявними рядками (звільнені/переведені) — БЕЗ фільтра isActive.
  const fetchMeta = async (ids: number[]): Promise<Map<number, WorkerMeta>> => {
    if (!ids.length) return new Map();
    const infos = await db.select(workerMetaCols).from(workersTable).where(inArray(workersTable.id, ids));
    return new Map(infos.map(w => [w.id, w]));
  };

  // Рапорти працівників (бот) цього місяця, по парі (працівник, фабрика).
  const reports = await db.select({
    workerId: monthlyReportsTable.workerId, factoryId: monthlyReportsTable.factoryId,
    hours: monthlyReportsTable.hoursReported, link: monthlyReportsTable.photoLink,
  }).from(monthlyReportsTable).where(eq(monthlyReportsTable.month, month));
  // Рапорт по парі без жодної явки (переведення всередині місяця, звільнені) —
  // окремий рядок з 0 змін, а не втрата.
  const orphanReports = reports.filter(r => r.factoryId != null && !byKey.has(rowKey(r.workerId, r.factoryId)));
  const orphanRepMeta = await fetchMeta([...new Set(orphanReports.map(r => r.workerId))]);
  for (const r of orphanReports) {
    const w = orphanRepMeta.get(r.workerId);
    if (!w) continue;
    byKey.set(rowKey(r.workerId, r.factoryId), blankRow(w, r.factoryId));
  }
  const repByKey = new Map<string, typeof reports[number]>();
  for (const r of reports) if (r.factoryId != null) repByKey.set(rowKey(r.workerId, r.factoryId), r);
  // Legacy/ручні рапорти без фабрики → рядок поточної фабрики працівника, інакше перший його рядок.
  for (const r of reports) {
    if (r.factoryId != null) continue;
    const wRows = [...byKey.values()].filter(w => w.workerId === r.workerId);
    const target = wRows.find(w => w.factoryId === curFacByWorker.get(r.workerId)) ?? wRows[0];
    if (target && !repByKey.has(rowKey(r.workerId, target.factoryId))) repByKey.set(rowKey(r.workerId, target.factoryId), r);
  }

  // Години з фабрики (імпорт/ручний ввід) — колонка звірки поруч із рапортом.
  const facHoursRows = await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.month, month));
  const orphanFh = facHoursRows.filter(r => !byKey.has(rowKey(r.workerId, r.factoryId)));
  const orphanFhMeta = await fetchMeta([...new Set(orphanFh.map(r => r.workerId))]);
  for (const r of orphanFh) {
    const w = orphanFhMeta.get(r.workerId);
    if (!w) continue;
    byKey.set(rowKey(r.workerId, r.factoryId), blankRow(w, r.factoryId));
  }
  const fhByKey = new Map(facHoursRows.map(r => [rowKey(r.workerId, r.factoryId), r]));

  // Ручні замітки (hours_notes) — по тій самій парі; замітка без рядка даних
  // рядок не створює (нема до чого чіпляти).
  const noteRows = await db.select({ workerId: hoursNotesTable.workerId, factoryId: hoursNotesTable.factoryId, note: hoursNotesTable.note })
    .from(hoursNotesTable).where(eq(hoursNotesTable.month, month));
  const noteByKey = new Map(noteRows.map(r => [rowKey(r.workerId, r.factoryId), r.note]));

  // Облік годин НЕ ділиться по фірмі працівника: фабрика шле одну евіденцію на
  // всіх, вкладка одна (рішення 06.08.2026, Sushi&Food). factories.multi_firm
  // керує лише сводною — from-hours пише фірму працівника в svodni_rows.firm,
  // вкладка одна з групами фірм (routes/svodni.ts, рішення 12.08.2026).
  const rowWorkerIds = [...new Set([...byKey.values()].map(w => w.workerId))];
  const workerCos = rowWorkerIds.length ? await db.select({
    id: workersTable.id, createdSource: workersTable.createdSource,
  }).from(workersTable).where(inArray(workersTable.id, rowWorkerIds)) : [];
  const importCreated = new Set(workerCos.filter(w => w.createdSource === "hours_import").map(w => w.id));

  for (const row of byKey.values()) {
    const rep = repByKey.get(rowKey(row.workerId, row.factoryId));
    row.reportHours = rep?.hours ?? null;
    row.reportSubmitted = !!rep;
    row.reportLink = rep?.link ?? null;
    const fh = fhByKey.get(rowKey(row.workerId, row.factoryId));
    row.factoryHours = fh?.hours ?? null;
    row.factoryDays = (fh?.days as HoursMergedRow["factoryDays"]) ?? null;
    row.factoryConfirmed = fh?.confirmed ?? false;
    row.askSentAt = fh?.askSentAt ?? null;
    row.askHours = fh?.askHours ?? null;
    row.workerResponse = fh?.workerResponse ?? null;
    row.workerResponseAt = fh?.workerResponseAt ?? null;
    row.workerNote = fh?.workerNote ?? null;
    row.note = noteByKey.get(rowKey(row.workerId, row.factoryId)) ?? null;
    row.createdViaImport = importCreated.has(row.workerId);
  }

  return { rows: [...byKey.values()], facById, excluded };
}
