import { get, post, patch, del, upload } from "./api";

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface SushiRole {
  id: number;
  code: string;
  name: string;
  colorBadge: string | null;
  defaultClientRate: number;
  defaultWorkerRate: number;
  isBillableToClient: boolean;
  isActive: boolean;
  displayOrder: number;
}

export interface SushiLine {
  id: number;
  factoryId: number;
  name: string;
  code: string;
  requiresLeader: boolean;
  minStaffing: number | null;
  isActive: boolean;
  displayOrder: number;
  aliases: string[];
}

export interface SushiSupervisor {
  id: number;
  signatureName: string;
  workerId: number | null;
  workerName: string | null;
  isActive: boolean;
}

export interface SushiWorkerCode {
  id: number;
  workerId: number;
  workerName: string | null;
  workerCode: string | null;
  factoryId: number;
  companyId: number;
  companyName: string | null;
  rcpCode: string;
  validFrom: string;
  validTo: string | null;
  isPrimary: boolean;
  notes: string | null;
  createdAt: string;
}

export interface SushiImportBatch {
  id: number;
  factoryId: number;
  sourceFilename: string;
  reportDate: string;
  isDateMissing?: boolean;
  totalRowsCount: number;
  validRowsCount: number;
  errorRowsCount: number;
  status: string;
  createdAt: string;
}

export interface SushiStagingEntry {
  id: number;
  batchId: number;
  rowNumber: number;
  rawFirma: string | null;
  rawRcp: string | null;
  rawDzial: string | null;
  rawOd: string | null;
  rawDo: string | null;
  rawRealneGodziny: string | null;
  rawPodpis: string | null;
  rawUwagi: string | null;
  resolvedWorkerId: number | null;
  workerName: string | null;
  resolvedLineId: number | null;
  lineName: string | null;
  validationStatus: "OK" | "CHECK_ID" | "INVALID_TIME" | "UNKNOWN_LINE" | "MISSING_SIGNATURE" | "COMPANY_MISMATCH" | "PROCESSED";
  errorMessage: string | null;
  isProcessed: boolean;
  createdAt: string;
}

export interface SushiIntervalItem {
  id: number;
  workerId: number;
  workerName?: string | null;
  workerCode?: string | null;
  workDate: string;
  billingMonth: string;
  startTime: string;
  stopTime: string;
  roundedStartTime: string;
  roundedStopTime: string;
  hours: number;
  payableHours: number;
  billableHours: number;
  lineId?: number;
  lineName?: string;
  roleId?: number;
  roleName?: string;
  supervisorId?: number | null;
  supervisorName?: string;
  status: string;
  odziezFeeApplicable: boolean;
  notes?: string | null;
  createdAt?: string;
}

export interface TimesheetDayNode {
  date: string;
  dayOfWeek: string;
  totalHours: number;
  payableHours: number;
  billableHours: number;
  odziezApplied: boolean;
  intervals: SushiIntervalItem[];
}

export interface TimesheetMonthNode {
  month: string;
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

export interface SushiDispute {
  id: number;
  workerId: number;
  workerName: string | null;
  workerCode: string | null;
  workIntervalId: number | null;
  disputeType: string;
  targetDate: string;
  billingMonth: string;
  claimedStartTime: string | null;
  claimedStopTime: string | null;
  claimedHours: number | null;
  claimedLineId: number | null;
  claimedLineName: string | null;
  workerComment: string | null;
  status: "OPEN" | "RESOLVED" | "REJECTED";
  resolutionAction: string | null;
  adminResolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface RoleBreakdown {
  roleCode: string;
  roleName: string;
  clientRate: number;
  hours: number;
  amountNet: number;
}

export interface SushiZalacznik {
  periodMonth: string;
  factoryId: number;
  companyId: number | null;
  totalBillableHours: number;
  totalLaborCostNet: number;
  totalOdziezDaysCount: number;
  totalOdziezDeductionNet: number;
  totalContractualPenalties: number;
  otherAdjustmentsNet: number;
  finalInvoiceNet: number;
  breakdownByRole: Record<string, RoleBreakdown>;
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

// ─── API Methods ────────────────────────────────────────────────────────────

// 1. Roles & Lines
export const fetchSushiRoles = () => get<SushiRole[]>("/sushi/roles");
export const fetchSushiLines = (factoryId = 1) => get<SushiLine[]>(`/sushi/lines?factoryId=${factoryId}`);
export const createSushiLine = (data: Partial<SushiLine>) => post<SushiLine>("/sushi/lines", data);
export const addSushiLineAlias = (lineId: number, rawAlias: string) =>
  post<{ lineId: number; rawAlias: string }>(`/sushi/lines/${lineId}/aliases`, { rawAlias });

// 2. Supervisors
export const fetchSushiSupervisors = () => get<SushiSupervisor[]>("/sushi/supervisors");
export const saveSushiSupervisor = (data: { signatureName: string; workerId?: number | null }) =>
  post<SushiSupervisor>("/sushi/supervisors", data);

// 3. Worker RCP Codes
export const fetchSushiWorkerCodes = (factoryId = 1) =>
  get<SushiWorkerCode[]>(`/sushi/worker-codes?factoryId=${factoryId}`);
export const createSushiWorkerCode = (data: Partial<SushiWorkerCode>) =>
  post<SushiWorkerCode>("/sushi/worker-codes", data);
export const deleteSushiWorkerCode = (id: number) => del(`/sushi/worker-codes/${id}`);

export interface SushiColumnMapping {
  sheetName?: string;
  headerRowIndex?: number;
  customReportDate?: string;
  colFirma?: number;
  colRcp?: number;
  colDzial?: number;
  colOd?: number;
  colDo?: number;
  colRealne?: number;
  colPodpis?: number;
  colUwagi?: number;
}

export interface ExcelPreviewData {
  fileName: string;
  sheetNames: string[];
  selectedSheet: string;
  detectedDate: string;
  isDateMissing?: boolean;
  detectedHeaderRow: number;
  detectedMapping: {
    colFirma: number;
    colRcp: number;
    colDzial: number;
    colOd: number;
    colDo: number;
    colRealne: number;
    colPodpis: number;
    colUwagi: number;
  };
  rows: (string | number | null)[][];
  totalRows: number;
  totalCols: number;
}

// 4. Import & Staging
export const previewSushiExcel = (file: File, sheetName?: string) => {
  const form = new FormData();
  form.append("files", file);
  if (sheetName) form.append("sheetName", sheetName);
  return upload<ExcelPreviewData>("/sushi/import/preview", form);
};

export const uploadSushiReport = (
  fileOrFiles: File | File[] | FileList,
  factoryId = 1,
  mapping?: SushiColumnMapping,
) => {
  const form = new FormData();
  const list = fileOrFiles instanceof File ? [fileOrFiles] : Array.from(fileOrFiles);
  for (const f of list) {
    form.append("files", f);
  }
  form.append("factoryId", String(factoryId));
  if (mapping) {
    form.append("mapping", JSON.stringify(mapping));
  }
  return upload<{
    batchesCount: number;
    batchId?: number;
    reportDate?: string;
    totalRows: number;
    validRows: number;
    errorRows: number;
  }>("/sushi/import/upload", form);
};
export const fetchSushiImportBatches = (factoryId = 1) =>
  get<SushiImportBatch[]>(`/sushi/import/batches?factoryId=${factoryId}`);
export const updateSushiBatchDate = (batchId: number, reportDate: string) =>
  patch<{ success: boolean; reportDate: string }>(`/sushi/import/batches/${batchId}`, { reportDate });
export const fetchSushiStaging = (params?: { batchId?: number; status?: string }) => {
  const q = new URLSearchParams();
  if (params?.batchId) q.set("batchId", String(params.batchId));
  if (params?.status) q.set("status", params.status);
  return get<SushiStagingEntry[]>(`/sushi/staging?${q.toString()}`);
};
export const patchSushiStaging = (id: number, data: Partial<SushiStagingEntry>) =>
  patch<SushiStagingEntry>(`/sushi/staging/${id}`, data);
export const linkSushiRcpAlias = (data: { workerId: number; factoryId?: number; rcpCode: string; notes?: string }) =>
  post<{ linkedRcp: string; workerId: number; updatedStagingRows: number }>("/sushi/staging/link-alias", data);
export const approveSushiValidStaging = (batchId: number) =>
  post<{ committed: number }>("/sushi/staging/approve-all-valid", { batchId });

// 5. Timesheet & Intervals
export const fetchSushiTimesheetTree = (workerId: number) =>
  get<{ tree: TimesheetYearNode[]; intervalsCount: number }>(`/sushi/timesheet/${workerId}`);
export const fetchSushiIntervals = (params?: { factoryId?: number; month?: string; date?: string; workerId?: number }) => {
  const q = new URLSearchParams();
  if (params?.factoryId) q.set("factoryId", String(params.factoryId));
  if (params?.month) q.set("month", params.month);
  if (params?.date) q.set("date", params.date);
  if (params?.workerId) q.set("workerId", String(params.workerId));
  return get<SushiIntervalItem[]>(`/sushi/intervals?${q.toString()}`);
};
export const createSushiInterval = (data: Partial<SushiIntervalItem>) =>
  post<SushiIntervalItem>("/sushi/intervals", data);
export const patchSushiInterval = (id: number, data: Partial<SushiIntervalItem>) =>
  patch<SushiIntervalItem>(`/sushi/intervals/${id}`, data);
export const deleteSushiInterval = (id: number) => del(`/sushi/intervals/${id}`);

// 6. Disputes
export const fetchSushiDisputes = (params?: { status?: string; month?: string }) => {
  const q = new URLSearchParams();
  if (params?.status) q.set("status", params.status);
  if (params?.month) q.set("month", params.month);
  return get<SushiDispute[]>(`/sushi/disputes?${q.toString()}`);
};
export const createSushiDispute = (data: Partial<SushiDispute>) =>
  post<SushiDispute>("/sushi/disputes", data);
export const resolveSushiDispute = (id: number, data: {
  action?: string;
  note?: string;
  startTime?: string;
  stopTime?: string;
  lineId?: number;
  supervisorId?: number;
  applyPenaltyToSupervisor?: boolean;
  penaltyAmount?: number;
}) => post(`/sushi/disputes/${id}/resolve`, data);
export const rejectSushiDispute = (id: number, note?: string) =>
  post(`/sushi/disputes/${id}/reject`, { note });

// 7. Finance & Reconciliation
export const fetchSushiZalacznik = (params: { factoryId?: number; month?: string; companyId?: number | null; penalties?: number; adjustments?: number }) => {
  const q = new URLSearchParams();
  if (params.factoryId) q.set("factoryId", String(params.factoryId));
  if (params.month) q.set("month", params.month);
  if (params.companyId) q.set("companyId", String(params.companyId));
  if (params.penalties) q.set("penalties", String(params.penalties));
  if (params.adjustments) q.set("adjustments", String(params.adjustments));
  return get<SushiZalacznik>(`/sushi/finance/zalacznik?${q.toString()}`);
};
export const lockSushiZalacznik = (data: any) => post("/sushi/finance/zalacznik/lock", data);
export const fetchSushiReconciliation = (params: { factoryId?: number; month?: string }) => {
  const q = new URLSearchParams();
  if (params.factoryId) q.set("factoryId", String(params.factoryId));
  if (params.month) q.set("month", params.month);
  return get<ReconciliationReport>(`/sushi/finance/reconciliation?${q.toString()}`);
};
export const createSushiException = (data: { factoryId?: number; workerId: number; fromDate: string; toDate: string; reason: string }) =>
  post("/sushi/finance/exceptions", data);
