/**
 * Сервісний модуль для роботи з табелем інтервалів фабрики «Суші»:
 * - Побудова деревоподібної картки працівника (Рік -> Місяць -> День -> Інтервали)
 * - Ієрархічний резолвер діючих ставок (Worker Override > Role Default > Factory Default)
 * - Підготовка та коміт перевірених рядків Staging Area в робочі інтервали (ідемпотентний одяг 6 zł)
 */

export interface FlatSushiInterval {
  id: number;
  workerId: number;
  workDate: string; // YYYY-MM-DD
  billingMonth: string; // YYYY-MM
  startTime: string;
  stopTime: string;
  roundedStartTime: string;
  roundedStopTime: string;
  hours: number;
  payableHours: number;
  billableHours: number;
  lineName?: string;
  roleName?: string;
  supervisorName?: string;
  status: string;
  odziezFeeApplicable: boolean;
  notes?: string | null;
}

export interface TimesheetDayNode {
  date: string; // YYYY-MM-DD
  dayOfWeek: string;
  totalHours: number;
  payableHours: number;
  billableHours: number;
  odziezApplied: boolean;
  intervals: FlatSushiInterval[];
}

export interface TimesheetMonthNode {
  month: string; // YYYY-MM
  totalHours: number;
  totalPayableHours: number;
  totalBillableHours: number;
  totalDays: number;
  days: TimesheetDayNode[];
}

export interface TimesheetYearNode {
  year: number;
  totalHours: number;
  months: TimesheetMonthNode[];
}

export interface RatesContext {
  factoryDefaultWorkerRate: number | null;
  factoryDefaultClientRate: number | null;
  roleWorkerRate: number | null;
  roleClientRate: number | null;
  workerCustomRate: number | null;
}

export interface StagingCommitCandidate {
  stagingId: number;
  workerId: number;
  factoryId: number;
  companyId: number;
  workDate: string;
  billingMonth: string;
  startTime: string;
  stopTime: string;
  roundedStartTime: string;
  roundedStopTime: string;
  rawHours: number;
  roundedHours: number;
  lineId: number;
  roleId: number;
  supervisorId: number | null;
  isTraining?: boolean;
  notes?: string | null;
}

export interface PreparedInterval {
  stagingEntryId: number;
  workerId: number;
  factoryId: number;
  companyId: number;
  workDate: string;
  billingMonth: string;
  startTime: string;
  stopTime: string;
  roundedStartTime: string;
  roundedStopTime: string;
  rawHours: number;
  roundedHours: number;
  billableHours: number;
  payableHours: number;
  lineId: number;
  roleId: number;
  supervisorId: number | null;
  appliedClientRate: number;
  appliedWorkerRate: number;
  rateSnapshotSource: "WORKER_OVERRIDE" | "ROLE_DEFAULT" | "FACTORY_DEFAULT";
  isPrimaryDailyInterval: boolean;
  odziezFeeApplicable: boolean;
  status: "SYNCED";
  notes?: string | null;
}

/**
 * Побудова деревоподібної ієрархічної структури табеля:
 * Рік -> Місяць -> День -> Список інтервалів.
 */
export function buildTimesheetTree(intervals: FlatSushiInterval[]): TimesheetYearNode[] {
  const yearsMap = new Map<number, Map<string, Map<string, FlatSushiInterval[]>>>();

  for (const interval of intervals) {
    const year = parseInt(interval.workDate.slice(0, 4), 10);
    const month = interval.billingMonth || interval.workDate.slice(0, 7);
    const day = interval.workDate;

    if (!yearsMap.has(year)) yearsMap.set(year, new Map());
    const yearMonths = yearsMap.get(year)!;

    if (!yearMonths.has(month)) yearMonths.set(month, new Map());
    const monthDays = yearMonths.get(month)!;

    if (!monthDays.has(day)) monthDays.set(day, []);
    monthDays.get(day)!.push(interval);
  }

  const result: TimesheetYearNode[] = [];

  for (const [year, monthsMap] of yearsMap.entries()) {
    let yearTotalHours = 0;
    const monthsNodes: TimesheetMonthNode[] = [];

    for (const [month, daysMap] of monthsMap.entries()) {
      let monthTotalHours = 0;
      let monthPayable = 0;
      let monthBillable = 0;
      const dayNodes: TimesheetDayNode[] = [];

      for (const [date, dayIntervals] of daysMap.entries()) {
        const dayTotalHours = dayIntervals.reduce((acc, i) => acc + (i.hours || 0), 0);
        const dayPayable = dayIntervals.reduce((acc, i) => acc + (i.payableHours || 0), 0);
        const dayBillable = dayIntervals.reduce((acc, i) => acc + (i.billableHours || 0), 0);
        const odziezApplied = dayIntervals.some((i) => i.odziezFeeApplicable);

        // Day of week
        const d = new Date(date + "T00:00:00Z");
        const daysOfWeek = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
        const dayOfWeek = daysOfWeek[d.getUTCDay()] || "";

        dayNodes.push({
          date,
          dayOfWeek,
          totalHours: Math.round(dayTotalHours * 100) / 100,
          payableHours: Math.round(dayPayable * 100) / 100,
          billableHours: Math.round(dayBillable * 100) / 100,
          odziezApplied,
          intervals: dayIntervals,
        });

        monthTotalHours += dayTotalHours;
        monthPayable += dayPayable;
        monthBillable += dayBillable;
      }

      // Сортування днів хронологічно
      dayNodes.sort((a, b) => a.date.localeCompare(b.date));

      monthsNodes.push({
        month,
        totalHours: Math.round(monthTotalHours * 100) / 100,
        totalPayableHours: Math.round(monthPayable * 100) / 100,
        totalBillableHours: Math.round(monthBillable * 100) / 100,
        totalDays: dayNodes.length,
        days: dayNodes,
      });

      yearTotalHours += monthTotalHours;
    }

    // Сортування місяців хронологічно
    monthsNodes.sort((a, b) => a.month.localeCompare(b.month));

    result.push({
      year,
      totalHours: Math.round(yearTotalHours * 100) / 100,
      months: monthsNodes,
    });
  }

  // Сортування років за спаданням
  result.sort((a, b) => b.year - a.year);

  return result;
}

/**
 * Ієрархічний резолвер ставок (Worker Override > Role Default > Factory Default).
 */
export function resolveSushiRates(context: RatesContext): {
  workerRate: number;
  clientRate: number;
  source: "WORKER_OVERRIDE" | "ROLE_DEFAULT" | "FACTORY_DEFAULT";
} {
  let workerRate = 0;
  let source: "WORKER_OVERRIDE" | "ROLE_DEFAULT" | "FACTORY_DEFAULT" = "ROLE_DEFAULT";

  if (context.workerCustomRate !== null && context.workerCustomRate !== undefined) {
    workerRate = context.workerCustomRate;
    source = "WORKER_OVERRIDE";
  } else if (context.roleWorkerRate !== null && context.roleWorkerRate !== undefined) {
    workerRate = context.roleWorkerRate;
    source = "ROLE_DEFAULT";
  } else if (context.factoryDefaultWorkerRate !== null && context.factoryDefaultWorkerRate !== undefined) {
    workerRate = context.factoryDefaultWorkerRate;
    source = "FACTORY_DEFAULT";
  }

  const clientRate =
    context.roleClientRate !== null && context.roleClientRate !== undefined
      ? context.roleClientRate
      : context.factoryDefaultClientRate ?? 0;

  return {
    workerRate,
    clientRate,
    source,
  };
}

/**
 * Підготовка інтервалів для збереження з Staging Area в робочий табель.
 * Гарантує ідемпотентне списання одягу (рівно 1 раз на людино-день).
 */
export function prepareStagingCommit(
  candidates: StagingCommitCandidate[],
  getRatesFn: (workerId: number, roleId: number) => RatesContext,
): PreparedInterval[] {
  const result: PreparedInterval[] = [];
  const processedWorkerDays = new Set<string>();

  for (const candidate of candidates) {
    const workerDayKey = `${candidate.workerId}_${candidate.workDate}`;
    const isFirstForDay = !processedWorkerDays.has(workerDayKey);
    processedWorkerDays.add(workerDayKey);

    const rates = resolveSushiRates(getRatesFn(candidate.workerId, candidate.roleId));

    const payableHours = candidate.roundedHours;
    // Якщо роль Wdrożenie (клієнтська ставка 0), billableHours = 0
    const billableHours = rates.clientRate === 0 || candidate.isTraining ? 0 : candidate.roundedHours;

    result.push({
      stagingEntryId: candidate.stagingId,
      workerId: candidate.workerId,
      factoryId: candidate.factoryId,
      companyId: candidate.companyId,
      workDate: candidate.workDate,
      billingMonth: candidate.billingMonth,
      startTime: candidate.startTime,
      stopTime: candidate.stopTime,
      roundedStartTime: candidate.roundedStartTime,
      roundedStopTime: candidate.roundedStopTime,
      rawHours: candidate.rawHours,
      roundedHours: candidate.roundedHours,
      billableHours,
      payableHours,
      lineId: candidate.lineId,
      roleId: candidate.roleId,
      supervisorId: candidate.supervisorId,
      appliedClientRate: rates.clientRate,
      appliedWorkerRate: rates.workerRate,
      rateSnapshotSource: rates.source,
      isPrimaryDailyInterval: isFirstForDay,
      odziezFeeApplicable: isFirstForDay,
      status: "SYNCED",
      notes: candidate.notes,
    });
  }

  return result;
}
