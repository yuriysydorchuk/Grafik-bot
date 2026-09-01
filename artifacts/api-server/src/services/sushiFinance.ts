/**
 * Сервісний модуль фінансів, додатку до фактури Załącznik та звірки двох контурів годин
 * для фабрики «Суші» (Sushi & Food Factory).
 */

export interface FinanceInterval {
  id: number;
  workerId: number;
  workDate: string; // YYYY-MM-DD
  companyId: number; // 1 = ES, 2 = ESO
  roleCode: string; // worker | leader | supervisor | repack | skoczek | trainee
  roleName: string;
  billableHours: number;
  appliedClientRate: number;
  odziezFeeApplicable: boolean;
}

export interface ZalacznikCalculationInput {
  periodMonth: string; // YYYY-MM
  factoryId: number;
  companyId: number;
  intervals: FinanceInterval[];
  contractualPenalties?: number; // Kary umowne
  adjustments?: number; // Inne korekty
}

export interface RoleBreakdown {
  roleCode: string;
  roleName: string;
  clientRate: number;
  hours: number;
  amountNet: number;
}

export interface ZalacznikCalculationResult {
  periodMonth: string;
  factoryId: number;
  companyId: number;
  totalBillableHours: number;
  totalLaborCostNet: number;
  totalOdziezDaysCount: number;
  totalOdziezDeductionNet: number;
  totalContractualPenalties: number;
  otherAdjustmentsNet: number;
  finalInvoiceNet: number;
  breakdownByRole: Record<string, RoleBreakdown>;
}

export interface FactoryShiftRecord {
  workerId: number;
  workDate: string;
  factoryHours: number;
}

export interface ReconciliationException {
  workerId: number;
  fromDate: string;
  toDate: string;
  reason: string;
}

export interface ReconciliationItem {
  workerId: number;
  workDate: string;
  factoryHours: number;
  internalHours: number;
  deltaHours: number;
  status: "MATCH" | "COMPENSATED_OFFSET" | "MISMATCH" | "EXCEPTION_APPROVED";
  reason?: string;
}

export interface ReconciliationReport {
  totalFactoryHours: number;
  totalInternalHours: number;
  netDiscrepancy: number;
  mismatchCount: number;
  items: ReconciliationItem[];
}

/**
 * Розрахунок підсумків додатку до фактури Załącznik для вказаної компанії (ES або ESO).
 */
export function calculateSushiZalacznik(
  input: ZalacznikCalculationInput,
): ZalacznikCalculationResult {
  const companyIntervals = input.intervals.filter((i) => i.companyId === input.companyId);

  const breakdownByRole: Record<string, RoleBreakdown> = {};
  let totalBillableHours = 0;
  let totalLaborCostNet = 0;

  // Підрахунок унікальних людино-днів для віднімання одягу (6 zł/день)
  const uniqueWorkerDays = new Set<string>();

  for (const interval of companyIntervals) {
    totalBillableHours += interval.billableHours;
    const amount = Math.round(interval.billableHours * interval.appliedClientRate * 100) / 100;
    totalLaborCostNet += amount;

    if (!breakdownByRole[interval.roleCode]) {
      breakdownByRole[interval.roleCode] = {
        roleCode: interval.roleCode,
        roleName: interval.roleName,
        clientRate: interval.appliedClientRate,
        hours: 0,
        amountNet: 0,
      };
    }

    breakdownByRole[interval.roleCode]!.hours += interval.billableHours;
    breakdownByRole[interval.roleCode]!.amountNet += amount;

    if (interval.odziezFeeApplicable) {
      uniqueWorkerDays.add(`${interval.workerId}_${interval.workDate}`);
    }
  }

  const totalOdziezDaysCount = uniqueWorkerDays.size;
  const totalOdziezDeductionNet = totalOdziezDaysCount * 6.0; // 6 PLN на день
  const penalties = input.contractualPenalties ?? 0;
  const adjustments = input.adjustments ?? 0;

  // Razem Netto = Robocizna - Odzież - Kary + Inne
  const finalInvoiceNet =
    Math.round((totalLaborCostNet - totalOdziezDeductionNet - penalties + adjustments) * 100) / 100;

  return {
    periodMonth: input.periodMonth,
    factoryId: input.factoryId,
    companyId: input.companyId,
    totalBillableHours: Math.round(totalBillableHours * 100) / 100,
    totalLaborCostNet: Math.round(totalLaborCostNet * 100) / 100,
    totalOdziezDaysCount,
    totalOdziezDeductionNet: Math.round(totalOdziezDeductionNet * 100) / 100,
    totalContractualPenalties: Math.round(penalties * 100) / 100,
    otherAdjustmentsNet: Math.round(adjustments * 100) / 100,
    finalInvoiceNet,
    breakdownByRole,
  };
}

/**
 * Двоконтурна звірка годин фабрики та внутрішнього обліку з алгоритмом самокомпенсації нічних зсувів.
 */
export function reconcileSushiHours(
  factoryRecords: FactoryShiftRecord[],
  internalIntervals: FinanceInterval[],
  exceptions: ReconciliationException[],
): ReconciliationReport {
  // Агрегуємо години по (workerId, workDate)
  const map = new Map<string, { workerId: number; workDate: string; factoryHours: number; internalHours: number }>();

  for (const f of factoryRecords) {
    const key = `${f.workerId}_${f.workDate}`;
    map.set(key, {
      workerId: f.workerId,
      workDate: f.workDate,
      factoryHours: f.factoryHours,
      internalHours: 0,
    });
  }

  for (const i of internalIntervals) {
    const key = `${i.workerId}_${i.workDate}`;
    const existing = map.get(key);
    if (existing) {
      existing.internalHours += i.billableHours;
    } else {
      map.set(key, {
        workerId: i.workerId,
        workDate: i.workDate,
        factoryHours: 0,
        internalHours: i.billableHours,
      });
    }
  }

  const rawItems: {
    workerId: number;
    workDate: string;
    factoryHours: number;
    internalHours: number;
    deltaHours: number;
  }[] = [];

  for (const val of map.values()) {
    const delta = Math.round((val.factoryHours - val.internalHours) * 100) / 100;
    rawItems.push({
      ...val,
      deltaHours: delta,
    });
  }

  // Сортуємо за працівником та датою
  rawItems.sort((a, b) => a.workerId - b.workerId || a.workDate.localeCompare(b.workDate));

  // Групуємо по працівниках для перевірки нічних парних зсувів (self-compensation)
  const byWorker = new Map<number, typeof rawItems>();
  for (const item of rawItems) {
    if (!byWorker.has(item.workerId)) byWorker.set(item.workerId, []);
    byWorker.get(item.workerId)!.push(item);
  }

  const items: ReconciliationItem[] = [];
  let totalFactHours = 0;
  let totalIntHours = 0;
  let mismatchCount = 0;

  for (const [workerId, workerItems] of byWorker.entries()) {
    // Шукаємо суміжні дні з взаємокомпенсуючими дельтами
    const compensatedIndices = new Set<number>();

    for (let i = 0; i < workerItems.length; i++) {
      if (compensatedIndices.has(i)) continue;
      const current = workerItems[i]!;

      if (Math.abs(current.deltaHours) > 0.01) {
        // Перевіряємо наступний день
        if (i + 1 < workerItems.length) {
          const next = workerItems[i + 1]!;
          const combinedDelta = Math.abs(current.deltaHours + next.deltaHours);
          if (combinedDelta < 0.1) {
            compensatedIndices.add(i);
            compensatedIndices.add(i + 1);
          }
        }
      }
    }

    for (let i = 0; i < workerItems.length; i++) {
      const item = workerItems[i]!;
      totalFactHours += item.factoryHours;
      totalIntHours += item.internalHours;

      // Перевірка виключень
      const hasException = exceptions.some(
        (e) => e.workerId === workerId && item.workDate >= e.fromDate && item.workDate <= e.toDate,
      );

      if (hasException) {
        items.push({
          ...item,
          status: "EXCEPTION_APPROVED",
          reason: "Approved exception",
        });
        continue;
      }

      if (compensatedIndices.has(i)) {
        items.push({
          ...item,
          status: "COMPENSATED_OFFSET",
          reason: "Night shift crossing boundary (self-compensated)",
        });
        continue;
      }

      if (Math.abs(item.deltaHours) < 0.01) {
        items.push({
          ...item,
          status: "MATCH",
        });
      } else {
        mismatchCount++;
        items.push({
          ...item,
          status: "MISMATCH",
          reason: `Discrepancy of ${item.deltaHours > 0 ? "+" : ""}${item.deltaHours} hrs`,
        });
      }
    }
  }

  return {
    totalFactoryHours: Math.round(totalFactHours * 100) / 100,
    totalInternalHours: Math.round(totalIntHours * 100) / 100,
    netDiscrepancy: Math.round((totalFactHours - totalIntHours) * 100) / 100,
    mismatchCount,
    items,
  };
}
