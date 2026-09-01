import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateSushiZalacznik,
  reconcileSushiHours,
  type FinanceInterval,
  type FactoryShiftRecord,
  type ReconciliationException,
} from "./sushiFinance.ts";

test("calculateSushiZalacznik: calculates categorized labor, odziez and penalties", () => {
  const intervals: FinanceInterval[] = [
    // 2 days for worker 1 (role: worker, 40 zł)
    {
      id: 1,
      workerId: 1,
      workDate: "2026-08-01",
      companyId: 1, // ES
      roleCode: "worker",
      roleName: "Pracownik Fizyczny",
      billableHours: 10,
      appliedClientRate: 40.0,
      odziezFeeApplicable: true,
    },
    {
      id: 2,
      workerId: 1,
      workDate: "2026-08-02",
      companyId: 1, // ES
      roleCode: "worker",
      roleName: "Pracownik Fizyczny",
      billableHours: 10,
      appliedClientRate: 40.0,
      odziezFeeApplicable: true,
    },
    // 1 day for worker 2 (role: leader, 41.5 zł)
    {
      id: 3,
      workerId: 2,
      workDate: "2026-08-01",
      companyId: 1, // ES
      roleCode: "leader",
      roleName: "Lider",
      billableHours: 8,
      appliedClientRate: 41.5,
      odziezFeeApplicable: true,
    },
    // Trainee (Wdrożenie - 0 zł to client)
    {
      id: 4,
      workerId: 3,
      workDate: "2026-08-01",
      companyId: 1, // ES
      roleCode: "trainee",
      roleName: "Uczeń (Wdrożenie)",
      billableHours: 0,
      appliedClientRate: 0.0,
      odziezFeeApplicable: true,
    },
    // Interval for company 2 (ESO) - should be excluded from ES zalacznik
    {
      id: 5,
      workerId: 4,
      workDate: "2026-08-01",
      companyId: 2, // ESO
      roleCode: "worker",
      roleName: "Pracownik Fizyczny",
      billableHours: 12,
      appliedClientRate: 40.0,
      odziezFeeApplicable: true,
    },
  ];

  const resES = calculateSushiZalacznik({
    periodMonth: "2026-08",
    factoryId: 1,
    companyId: 1, // ES
    intervals,
    contractualPenalties: 100.0,
    adjustments: 20.0,
  });

  // ES Labor:
  // worker: 20h * 40 = 800 zł
  // leader: 8h * 41.5 = 332 zł
  // trainee: 0h * 0 = 0 zł
  // Total Labor = 1132 zł
  assert.equal(resES.totalLaborCostNet, 1132.0);
  assert.equal(resES.totalBillableHours, 28.0);

  // Odziez: 4 unique (worker, date) pairs for ES = 4 * 6 zł = 24 zł
  assert.equal(resES.totalOdziezDaysCount, 4);
  assert.equal(resES.totalOdziezDeductionNet, 24.0);

  // Final Net: 1132 - 24 (odziez) - 100 (penalties) + 20 (adjustments) = 1028 zł
  assert.equal(resES.finalInvoiceNet, 1028.0);

  // Check roles breakdown
  assert.equal(resES.breakdownByRole["worker"]!.hours, 20);
  assert.equal(resES.breakdownByRole["worker"]!.amountNet, 800);
  assert.equal(resES.breakdownByRole["leader"]!.hours, 8);
  assert.equal(resES.breakdownByRole["leader"]!.amountNet, 332);
});

test("reconcileSushiHours: handles night shift offsets and true discrepancies", () => {
  // Worker 1: Night shift offset across 08-31 and 09-01 (sums to 0 delta)
  // Worker 2: True discrepancy (missing hours)
  // Worker 3: Discrepancy covered by approved exception

  const factoryRecords: FactoryShiftRecord[] = [
    { workerId: 1, workDate: "2026-08-31", factoryHours: 4.0 },
    { workerId: 1, workDate: "2026-09-01", factoryHours: 12.0 },
    { workerId: 2, workDate: "2026-08-31", factoryHours: 6.0 },
    { workerId: 3, workDate: "2026-08-31", factoryHours: 0.0 },
  ];

  const internalIntervals: FinanceInterval[] = [
    { id: 1, workerId: 1, workDate: "2026-08-31", companyId: 1, roleCode: "worker", roleName: "W", billableHours: 10.0, appliedClientRate: 40, odziezFeeApplicable: true },
    { id: 2, workerId: 1, workDate: "2026-09-01", companyId: 1, roleCode: "worker", roleName: "W", billableHours: 6.0, appliedClientRate: 40, odziezFeeApplicable: true },
    { id: 3, workerId: 2, workDate: "2026-08-31", companyId: 1, roleCode: "worker", roleName: "W", billableHours: 8.0, appliedClientRate: 40, odziezFeeApplicable: true },
    { id: 4, workerId: 3, workDate: "2026-08-31", companyId: 1, roleCode: "worker", roleName: "W", billableHours: 8.0, appliedClientRate: 40, odziezFeeApplicable: true },
  ];

  const exceptions: ReconciliationException[] = [
    { workerId: 3, fromDate: "2026-08-31", toDate: "2026-08-31", reason: "Authorized difference" },
  ];

  const report = reconcileSushiHours(factoryRecords, internalIntervals, exceptions);

  // Worker 1: Deltas are -6h on 08-31 and +6h on 09-01 => self-compensated
  const w1Items = report.items.filter((i) => i.workerId === 1);
  assert.equal(w1Items.length, 2);
  assert.equal(w1Items[0]!.status, "COMPENSATED_OFFSET");
  assert.equal(w1Items[1]!.status, "COMPENSATED_OFFSET");

  // Worker 2: Factory 6h vs Internal 8h => delta = -2h (MISMATCH)
  const w2Item = report.items.find((i) => i.workerId === 2)!;
  assert.equal(w2Item.status, "MISMATCH");
  assert.equal(w2Item.deltaHours, -2.0);

  // Worker 3: Covered by exception => EXCEPTION_APPROVED
  const w3Item = report.items.find((i) => i.workerId === 3)!;
  assert.equal(w3Item.status, "EXCEPTION_APPROVED");
});
