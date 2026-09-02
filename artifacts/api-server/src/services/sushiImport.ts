/**
 * Сервіс імпорту та валідації щоденних звітів зміни (DAILY_SHIFT_REPORT)
 * для фабрики «Суші» (на прикладі файлів Pakowanie M4 (I + II zm).xlsx).
 */

import * as XLSX from "xlsx";
import { normalizeTime, parseExcelHours, validateTimeInterval } from "./sushiTime.ts";

export interface RawParsedRow {
  rowNumber: number;
  firma: string;
  rcpCode: string;
  dzial: string;
  od: string;
  do: string;
  realneGodziny: number;
  podpis: string;
  uwagi: string;
}

export interface ParsedDailyReport {
  fileName: string;
  reportDate: string; // YYYY-MM-DD
  rows: RawParsedRow[];
  totalRows: number;
}

export interface WorkerCodeLookup {
  rcpCode: string;
  workerId: number;
  companyId: number;
  validFrom: string;
  validTo: string | null;
}

export interface ValidationContext {
  reportDate: string;
  workerCodes: WorkerCodeLookup[];
  companies: { id: number; name: string }[];
  lines: { id: number; name: string; code: string }[];
  lineAliases: { lineId: number; rawAlias: string }[];
  supervisors: { id: number; signatureName: string; workerId: number | null }[];
}

export interface ValidationRowResult {
  status: "OK" | "CHECK_ID" | "INVALID_TIME" | "UNKNOWN_LINE" | "MISSING_SIGNATURE" | "COMPANY_MISMATCH";
  errorMessage?: string;
  resolvedWorkerId: number | null;
  resolvedLineId: number | null;
  resolvedSupervisorId: number | null;
  roundedStart?: string;
  roundedStop?: string;
  computedHours?: number;
}

/**
 * Парсинг та нормалізація дати звіту (з A1 або тексту "Data: YYYY-MM-DD" / "DD.MM.YYYY").
 */
export function parseReportDate(raw: string | number | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;

  if (typeof raw === "number") {
    // Excel date serial number (обмежуємо реальними роками 2020..2035)
    const parsedDate = XLSX.SSF.parse_date_code(raw);
    if (!parsedDate || parsedDate.y < 2020 || parsedDate.y > 2035) return null;
    const y = parsedDate.y;
    const m = String(parsedDate.m).padStart(2, "0");
    const d = String(parsedDate.d).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  const str = String(raw).trim();
  const cleaned = str.replace(/^Data\s*[:\s-]\s*/i, "").trim();

  // Match YYYY-MM-DD or YYYY/MM/DD
  const ymdMatch = cleaned.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymdMatch) {
    const y = ymdMatch[1]!;
    if (parseInt(y, 10) < 2020 || parseInt(y, 10) > 2035) return null;
    const m = String(parseInt(ymdMatch[2]!, 10)).padStart(2, "0");
    const d = String(parseInt(ymdMatch[3]!, 10)).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // Match DD.MM.YYYY or DD/MM/YYYY
  const dmyMatch = cleaned.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (dmyMatch) {
    const y = dmyMatch[3]!;
    if (parseInt(y, 10) < 2020 || parseInt(y, 10) > 2035) return null;
    const d = String(parseInt(dmyMatch[1]!, 10)).padStart(2, "0");
    const m = String(parseInt(dmyMatch[2]!, 10)).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  return null;
}

/**
 * Нормалізація коду RCP (прибирає ведучі нулі: "00123" -> "123", але зберігає "0").
 */
export function normalizeRcpCode(rcpVal: string | number | null | undefined): string {
  if (rcpVal === undefined || rcpVal === null) return "";
  const str = String(rcpVal).trim();
  if (!str) return "";
  const stripped = str.replace(/^0+/, "");
  return stripped || "0";
}

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

/**
 * Генерує прев'ю вмісту Excel-файлу для візуального маппінгу колонок супервайзером.
 */
export function previewExcelReport(
  buffer: Buffer | Uint8Array,
  fileName: string,
  targetSheetName?: string,
): ExcelPreviewData {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new Error("Excel файл не містить аркушів");
  }

  const selectedSheet =
    targetSheetName && wb.SheetNames.includes(targetSheetName)
      ? targetSheetName
      : wb.SheetNames[0]!;

  const ws = wb.Sheets[selectedSheet];
  if (!ws) throw new Error(`Аркуш ${selectedSheet} не знайдено`);

  const data: (string | number | null)[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: "",
    raw: true,
  });

  // 1. Пошук дати
  let detectedDate: string | null = null;
  for (let r = 0; r < Math.min(10, data.length); r++) {
    const row = data[r] || [];
    for (let c = 0; c < Math.min(10, row.length); c++) {
      const parsed = parseReportDate(row[c]);
      if (parsed) {
        detectedDate = parsed;
        break;
      }
    }
    if (detectedDate) break;
  }
  if (!detectedDate) {
    detectedDate = parseReportDate(fileName) || new Date().toISOString().slice(0, 10);
  }

  // 2. Визначення рядка заголовків
  let headerRowIndex = -1;
  let colFirma = -1;
  let colRcp = -1;
  let colDzial = -1;
  let colOd = -1;
  let colDo = -1;
  let colRealne = -1;
  let colPodpis = -1;
  let colUwagi = -1;

  for (let r = 0; r < Math.min(15, data.length); r++) {
    const row = data[r] || [];
    let foundKeywords = 0;
    for (let c = 0; c < row.length; c++) {
      const val = String(row[c] || "").toLowerCase().trim();
      if (val.includes("rcp") || val.includes("karta") || val.includes("kod") || val === "id" || val.includes("id prac")) {
        foundKeywords++;
      }
      if (val === "od" || val.startsWith("od ") || val.includes("start") || val === "do" || val.startsWith("do ") || val.includes("stop") || val.includes("koniec")) {
        foundKeywords++;
      }
    }

    if (foundKeywords >= 2 || row.some((cell) => String(cell || "").toLowerCase().includes("rcp"))) {
      headerRowIndex = r;
      for (let c = 0; c < row.length; c++) {
        const val = String(row[c] || "").toLowerCase().trim();
        if (colRcp === -1 && (val.includes("rcp") || val.includes("karta") || val.includes("kod") || val === "id" || val.includes("id prac"))) {
          colRcp = c;
        } else if (colFirma === -1 && (val.includes("firma") || val.includes("agencja") || val.includes("klient"))) {
          colFirma = c;
        } else if (colDzial === -1 && (val.includes("dzia") || val.includes("linia") || val.includes("stanowisko") || val.includes("sektor"))) {
          colDzial = c;
        } else if (colOd === -1 && (val === "od" || val.startsWith("od ") || val.includes("start") || val.includes("pocz"))) {
          colOd = c;
        } else if (colDo === -1 && (val === "do" || val.startsWith("do ") || val.includes("stop") || val.includes("koniec"))) {
          colDo = c;
        } else if (colRealne === -1 && (val.includes("realn") || val.includes("godzin") || val.includes("czas") || val.includes("suma"))) {
          colRealne = c;
        } else if (colPodpis === -1 && (val.includes("podpis") || val.includes("brygadz") || val.includes("lider"))) {
          colPodpis = c;
        } else if (colUwagi === -1 && (val.includes("uwag") || val.includes("koment") || val.includes("notat"))) {
          colUwagi = c;
        }
      }
      break;
    }
  }

  // Fallbacks
  if (colFirma === -1) colFirma = 0;
  if (colRcp === -1) colRcp = 1;
  if (colDzial === -1) colDzial = 2;
  if (colOd === -1) colOd = 6;
  if (colDo === -1) colDo = 7;
  if (colRealne === -1) colRealne = 8;
  if (colPodpis === -1) colPodpis = 9;
  if (colUwagi === -1) colUwagi = 11;

  const previewRows = data.slice(0, 25);
  const maxCols = Math.max(...previewRows.map((r) => r.length), 12);

  return {
    fileName,
    sheetNames: wb.SheetNames,
    selectedSheet,
    detectedDate,
    detectedHeaderRow: headerRowIndex !== -1 ? headerRowIndex : 1,
    detectedMapping: {
      colFirma,
      colRcp,
      colDzial,
      colOd,
      colDo,
      colRealne,
      colPodpis,
      colUwagi,
    },
    rows: previewRows,
    totalRows: data.length,
    totalCols: maxCols,
  };
}

/**
 * Парсер Excel-файлу щоденного звіту бригадира з підтримкою кастомного маппінгу.
 */
export function parseDailyShiftExcel(
  buffer: Buffer | Uint8Array,
  fileName: string,
  customMapping?: SushiColumnMapping,
): ParsedDailyReport {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new Error("Excel файл не містить аркушів");
  }

  // Аркуш з кастомного маппінгу або перший валідний
  let ws: XLSX.WorkSheet | undefined;
  if (customMapping?.sheetName && wb.Sheets[customMapping.sheetName]) {
    ws = wb.Sheets[customMapping.sheetName];
  } else {
    for (const sheetName of wb.SheetNames) {
      const candidate = wb.Sheets[sheetName];
      if (candidate && candidate["!ref"]) {
        ws = candidate;
        break;
      }
    }
  }

  if (!ws) {
    ws = wb.Sheets[wb.SheetNames[0]!];
  }

  if (!ws) {
    throw new Error("Не вдалося відкрити аркуш Excel");
  }

  // Raw rows as matrix
  const data: (string | number | null | undefined)[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: "",
    raw: true,
  });

  if (data.length === 0) {
    throw new Error("Excel файл порожній");
  }

  // 1. Пошук дати в customMapping або перших 10 рядках
  let reportDate: string | null = customMapping?.customReportDate || null;
  if (!reportDate) {
    for (let r = 0; r < Math.min(10, data.length); r++) {
      const row = data[r] || [];
      for (let c = 0; c < Math.min(10, row.length); c++) {
        const val = row[c];
        const parsed = parseReportDate(val);
        if (parsed) {
          reportDate = parsed;
          break;
        }
      }
      if (reportDate) break;
    }
  }

  if (!reportDate) {
    const fromFilename = parseReportDate(fileName);
    reportDate = fromFilename || new Date().toISOString().slice(0, 10);
  }

  // 2. Визначення стовпчиків: якщо передано customMapping, беремо його, інакше авто-детекція
  let headerRowIndex = customMapping?.headerRowIndex ?? -1;
  let colFirma = customMapping?.colFirma ?? -1;
  let colRcp = customMapping?.colRcp ?? -1;
  let colDzial = customMapping?.colDzial ?? -1;
  let colOd = customMapping?.colOd ?? -1;
  let colDo = customMapping?.colDo ?? -1;
  let colRealne = customMapping?.colRealne ?? -1;
  let colPodpis = customMapping?.colPodpis ?? -1;
  let colUwagi = customMapping?.colUwagi ?? -1;

  if (colRcp === -1 || colOd === -1 || colDo === -1) {
    for (let r = 0; r < Math.min(15, data.length); r++) {
      const row = data[r] || [];
      let foundKeywords = 0;
      for (let c = 0; c < row.length; c++) {
        const val = String(row[c] || "").toLowerCase().trim();
        if (val.includes("rcp") || val.includes("karta") || val.includes("kod") || val === "id" || val.includes("id prac")) {
          foundKeywords++;
        }
        if (val === "od" || val.startsWith("od ") || val.includes("start") || val === "do" || val.startsWith("do ") || val.includes("stop") || val.includes("koniec")) {
          foundKeywords++;
        }
      }

      if (foundKeywords >= 2 || row.some((cell) => String(cell || "").toLowerCase().includes("rcp"))) {
        headerRowIndex = r;
        for (let c = 0; c < row.length; c++) {
          const val = String(row[c] || "").toLowerCase().trim();
          if (colRcp === -1 && (val.includes("rcp") || val.includes("karta") || val.includes("kod") || val === "id" || val.includes("id prac"))) {
            colRcp = c;
          } else if (colFirma === -1 && (val.includes("firma") || val.includes("agencja") || val.includes("klient"))) {
            colFirma = c;
          } else if (colDzial === -1 && (val.includes("dzia") || val.includes("linia") || val.includes("stanowisko") || val.includes("sektor"))) {
            colDzial = c;
          } else if (colOd === -1 && (val === "od" || val.startsWith("od ") || val.includes("start") || val.includes("pocz"))) {
            colOd = c;
          } else if (colDo === -1 && (val === "do" || val.startsWith("do ") || val.includes("stop") || val.includes("koniec"))) {
            colDo = c;
          } else if (colRealne === -1 && (val.includes("realn") || val.includes("godzin") || val.includes("czas") || val.includes("suma"))) {
            colRealne = c;
          } else if (colPodpis === -1 && (val.includes("podpis") || val.includes("brygadz") || val.includes("lider"))) {
            colPodpis = c;
          } else if (colUwagi === -1 && (val.includes("uwag") || val.includes("koment") || val.includes("notat"))) {
            colUwagi = c;
          }
        }
        break;
      }
    }
  }

  // Fallbacks if still not found
  if (colFirma === -1) colFirma = 0;
  if (colRcp === -1) colRcp = 1;
  if (colDzial === -1) colDzial = 2;
  if (colOd === -1) colOd = 6;
  if (colDo === -1) colDo = 7;
  if (colRealne === -1) colRealne = 8;
  if (colPodpis === -1) colPodpis = 9;
  if (colUwagi === -1) colUwagi = 11;

  const startRow = headerRowIndex !== -1 ? headerRowIndex + 1 : 2;
  const rows: RawParsedRow[] = [];

  for (let r = startRow; r < data.length; r++) {
    const row = data[r] || [];
    const firstCell = String(row[0] || "").trim().toUpperCase();
    const secondCell = String(row[1] || "").trim().toUpperCase();

    // Маркери завершення
    if (
      firstCell.includes("SUMA") ||
      firstCell.includes("RAZEM") ||
      secondCell.includes("SUMA") ||
      secondCell.includes("RAZEM")
    ) {
      break;
    }

    const rawFirma = colFirma >= 0 ? String(row[colFirma] || "").trim() : "";
    const rawRcp = colRcp >= 0 ? normalizeRcpCode(row[colRcp]) : "";
    const rawDzial = colDzial >= 0 ? String(row[colDzial] || "").trim() : "";
    const rawOd = colOd >= 0 ? normalizeTime(row[colOd]) || String(row[colOd] || "").trim() : "";
    const rawDo = colDo >= 0 ? normalizeTime(row[colDo]) || String(row[colDo] || "").trim() : "";
    const rawRealne = colRealne >= 0 ? parseExcelHours(row[colRealne]) : 0;
    const rawPodpis = colPodpis >= 0 ? String(row[colPodpis] || "").trim() : "";
    const rawUwagi = colUwagi >= 0 ? String(row[colUwagi] || "").trim() : "";

    // Пропускаємо повністю порожні рядки
    if (!rawRcp && !rawOd && !rawDo && !rawFirma && !rawDzial) {
      continue;
    }

    rows.push({
      rowNumber: r + 1,
      firma: rawFirma,
      rcpCode: rawRcp,
      dzial: rawDzial,
      od: rawOd,
      do: rawDo,
      realneGodziny: rawRealne,
      podpis: rawPodpis,
      uwagi: rawUwagi,
    });
  }

  return {
    fileName,
    reportDate,
    rows,
    totalRows: rows.length,
  };
}

/**
 * Валідація рядка зі Staging Area проти контексту бази даних.
 */
export function validateStagingRow(
  row: RawParsedRow,
  context: ValidationContext,
): ValidationRowResult {
  // 1. Пошук табельного номера RCP у базі за датою звіту
  const workerCodeEntry = context.workerCodes.find((w) => {
    if (normalizeRcpCode(w.rcpCode) !== normalizeRcpCode(row.rcpCode)) return false;
    if (w.validFrom && context.reportDate < w.validFrom) return false;
    if (w.validTo && context.reportDate > w.validTo) return false;
    return true;
  });

  const resolvedWorkerId = workerCodeEntry ? workerCodeEntry.workerId : null;

  if (!resolvedWorkerId) {
    return {
      status: "CHECK_ID",
      errorMessage: `Табельний номер RCP "${row.rcpCode}" не знайдено в базі працівників`,
      resolvedWorkerId: null,
      resolvedLineId: null,
      resolvedSupervisorId: null,
    };
  }

  // 2. Валідація часу
  const timeVal = validateTimeInterval(row.od, row.do);
  if (!timeVal.valid) {
    return {
      status: "INVALID_TIME",
      errorMessage: timeVal.errorMessage || "Некоректний час зміни",
      resolvedWorkerId,
      resolvedLineId: null,
      resolvedSupervisorId: null,
      computedHours: 0,
    };
  }

  // 3. Валідація підпису бригадира
  if (!row.podpis) {
    return {
      status: "MISSING_SIGNATURE",
      errorMessage: "Відсутній підпис бригадира у звіті",
      resolvedWorkerId,
      resolvedLineId: null,
      resolvedSupervisorId: null,
    };
  }

  // Пошук ID бригадира за підписом
  const sup = context.supervisors.find(
    (s) => s.signatureName.trim().toLowerCase() === row.podpis.trim().toLowerCase(),
  );
  const resolvedSupervisorId = sup ? sup.id : null;

  // 4. Пошук лінії через аліаси або пряму назву
  let resolvedLineId: number | null = null;
  const directLine = context.lines.find(
    (l) => l.name.trim().toLowerCase() === row.dzial.trim().toLowerCase() || l.code.trim().toLowerCase() === row.dzial.trim().toLowerCase(),
  );

  if (directLine) {
    resolvedLineId = directLine.id;
  } else {
    const alias = context.lineAliases.find(
      (a) => a.rawAlias.trim().toLowerCase() === row.dzial.trim().toLowerCase(),
    );
    if (alias) {
      resolvedLineId = alias.lineId;
    }
  }

  return {
    status: "OK",
    resolvedWorkerId,
    resolvedLineId,
    resolvedSupervisorId,
    roundedStart: timeVal.roundedStart,
    roundedStop: timeVal.roundedStop,
    computedHours: timeVal.hours,
  };
}
