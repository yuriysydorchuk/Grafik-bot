import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTimesheetTree,
  resolveSushiRates,
  prepareStagingCommit,
  type FlatSushiInterval,
  type StagingCommitCandidate,
  type RatesContext,
} from "./sushiTimesheet.ts";

test("buildTimesheetTree: builds hierarchical tree Year -> Month -> Day -> Intervals", () => {
  const intervals: FlatSushiInterval[] = [
    {
      id: 1,
      workerId: 10,
      workDate: "2026-08-31",
      billingMonth: "2026-08",
      startTime: "06:01",
      stopTime: "14:14",
      roundedStartTime: "06:15",
      roundedStopTime: "14:00",
      hours: 7.75,
      payableHours: 7.75,
      billableHours: 7.75,
      lineName: "Pakowanie 4",
      roleName: "Pracownik Fizyczny",
      supervisorName: "Emmanuel",
      status: "CONFIRMED",
      odziezFeeApplicable: true,
    },
    {
      id: 2,
      workerId: 10,
      workDate: "2026-08-31",
      billingMonth: "2026-08",
      startTime: "17:00",
      stopTime: "22:00",
      roundedStartTime: "17:00",
      roundedStopTime: "22:00",
      hours: 5.0,
      payableHours: 5.0,
      billableHours: 5.0,
      lineName: "Pakowanie 4",
      roleName: "Pracownik Fizyczny",
      supervisorName: "Sumon",
      status: "CONFIRMED",
      odziezFeeApplicable: false, // second shift on same day
    },
    {
      id: 3,
      workerId: 10,
      workDate: "2026-09-01",
      billingMonth: "2026-09",
      startTime: "06:00",
      stopTime: "14:00",
      roundedStartTime: "06:00",
      roundedStopTime: "14:00",
      hours: 8.0,
      payableHours: 8.0,
      billableHours: 8.0,
      lineName: "Pakowanie 4",
      roleName: "Lider",
      supervisorName: "Emmanuel",
      status: "SYNCED",
      odziezFeeApplicable: true,
    },
  ];

  const tree = buildTimesheetTree(intervals);

  assert.equal(tree.length, 1); // 1 year (2026)
  const year2026 = tree[0]!;
  assert.equal(year2026.year, 2026);
  assert.equal(year2026.months.length, 2); // August & September

  // August
  const aug = year2026.months.find((m) => m.month === "2026-08")!;
  assert.equal(aug.totalHours, 12.75);
  assert.equal(aug.totalDays, 1);
  assert.equal(aug.days.length, 1);
  assert.equal(aug.days[0]!.date, "2026-08-31");
  assert.equal(aug.days[0]!.intervals.length, 2);
  assert.equal(aug.days[0]!.totalHours, 12.75);

  // September
  const sep = year2026.months.find((m) => m.month === "2026-09")!;
  assert.equal(sep.totalHours, 8.0);
  assert.equal(sep.totalDays, 1);
  assert.equal(sep.days.length, 1);
  assert.equal(sep.days[0]!.intervals.length, 1);
});

test("resolveSushiRates: prioritizes Worker Override > Role Default > Factory Default", () => {
  const context: RatesContext = {
    factoryDefaultWorkerRate: 28.0,
    factoryDefaultClientRate: 40.0,
    roleWorkerRate: 29.5,
    roleClientRate: 41.5,
    workerCustomRate: 32.0,
  };

  // With worker override:
  const ratesWithOverride = resolveSushiRates(context);
  assert.equal(ratesWithOverride.workerRate, 32.0); // worker override
  assert.equal(ratesWithOverride.clientRate, 41.5); // role default
  assert.equal(ratesWithOverride.source, "WORKER_OVERRIDE");

  // Without worker override:
  const ratesRole = resolveSushiRates({
    ...context,
    workerCustomRate: null,
  });
  assert.equal(ratesRole.workerRate, 29.5); // role default
  assert.equal(ratesRole.clientRate, 41.5); // role default
  assert.equal(ratesRole.source, "ROLE_DEFAULT");

  // Fallback to factory:
  const ratesFactory = resolveSushiRates({
    factoryDefaultWorkerRate: 28.0,
    factoryDefaultClientRate: 40.0,
    roleWorkerRate: null,
    roleClientRate: null,
    workerCustomRate: null,
  });
  assert.equal(ratesFactory.workerRate, 28.0);
  assert.equal(ratesFactory.clientRate, 40.0);
  assert.equal(ratesFactory.source, "FACTORY_DEFAULT");
});

test("prepareStagingCommit: correctly freezes rates and sets odziez fee only for first daily interval", () => {
  const candidates: StagingCommitCandidate[] = [
    {
      stagingId: 101,
      workerId: 10,
      factoryId: 1,
      companyId: 1,
      workDate: "2026-08-31",
      billingMonth: "2026-08",
      startTime: "06:01",
      stopTime: "14:14",
      roundedStartTime: "06:15",
      roundedStopTime: "14:00",
      rawHours: 8.22,
      roundedHours: 7.75,
      lineId: 5,
      roleId: 2, // Lider
      supervisorId: 3,
      isTraining: false,
    },
    {
      stagingId: 102,
      workerId: 10,
      factoryId: 1,
      companyId: 1,
      workDate: "2026-08-31",
      billingMonth: "2026-08",
      startTime: "17:00",
      stopTime: "22:00",
      roundedStartTime: "17:00",
      roundedStopTime: "22:00",
      rawHours: 5.0,
      roundedHours: 5.0,
      lineId: 5,
      roleId: 2, // Lider
      supervisorId: 3,
      isTraining: false,
    },
    {
      stagingId: 103,
      workerId: 12,
      factoryId: 1,
      companyId: 1,
      workDate: "2026-08-31",
      billingMonth: "2026-08",
      startTime: "06:00",
      stopTime: "14:00",
      roundedStartTime: "06:00",
      roundedStopTime: "14:00",
      rawHours: 8.0,
      roundedHours: 8.0,
      lineId: 5,
      roleId: 6, // Trainee (Wdrożenie)
      supervisorId: 3,
      isTraining: true,
    },
  ];

  const getRates = (workerId: number, roleId: number): RatesContext => {
    if (roleId === 6) {
      return {
        factoryDefaultWorkerRate: 28.0,
        factoryDefaultClientRate: 40.0,
        roleWorkerRate: 28.0,
        roleClientRate: 0.0, // Wdrożenie 0 zł client
        workerCustomRate: null,
      };
    }
    return {
      factoryDefaultWorkerRate: 28.0,
      factoryDefaultClientRate: 40.0,
      roleWorkerRate: 29.5,
      roleClientRate: 41.5,
      workerCustomRate: null,
    };
  };

  const prepared = prepareStagingCommit(candidates, getRates);

  assert.equal(prepared.length, 3);

  // First interval of worker 10 on 2026-08-31
  assert.equal(prepared[0]!.isPrimaryDailyInterval, true);
  assert.equal(prepared[0]!.odziezFeeApplicable, true);
  assert.equal(prepared[0]!.appliedClientRate, 41.5);
  assert.equal(prepared[0]!.appliedWorkerRate, 29.5);
  assert.equal(prepared[0]!.billableHours, 7.75);

  // Second interval of worker 10 on same date -> odziez = false
  assert.equal(prepared[1]!.isPrimaryDailyInterval, false);
  assert.equal(prepared[1]!.odziezFeeApplicable, false);
  assert.equal(prepared[1]!.billableHours, 5.0);

  // Trainee worker 12 -> billableHours = 0 (client rate 0)
  assert.equal(prepared[2]!.isPrimaryDailyInterval, true);
  assert.equal(prepared[2]!.odziezFeeApplicable, true);
  assert.equal(prepared[2]!.appliedClientRate, 0.0);
  assert.equal(prepared[2]!.billableHours, 0.0);
  assert.equal(prepared[2]!.payableHours, 8.0);
});
