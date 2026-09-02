import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  parseReportDate,
  normalizeRcpCode,
  parseDailyShiftExcel,
  validateStagingRow,
  decodeOriginalFilename,
  type RawParsedRow,
  type ValidationContext,
} from "./sushiImport.ts";

test("parseReportDate: extracts date from string variants", () => {
  assert.equal(parseReportDate("Data: 2026-08-31"), "2026-08-31");
  assert.equal(parseReportDate("Data: 31.08.2026"), "2026-08-31");
  assert.equal(parseReportDate("2026-09-01"), "2026-09-01");
  assert.equal(parseReportDate("01.09.2026"), "2026-09-01");
  assert.equal(parseReportDate("Data : 2026/08/15"), "2026-08-15");
});

test("normalizeRcpCode: removes leading zeros", () => {
  assert.equal(normalizeRcpCode("00123"), "123");
  assert.equal(normalizeRcpCode("0100905"), "100905");
  assert.equal(normalizeRcpCode(100905), "100905");
  assert.equal(normalizeRcpCode("1234"), "1234");
  assert.equal(normalizeRcpCode("0"), "0");
  assert.equal(normalizeRcpCode(""), "");
});

test("parseDailyShiftExcel: parses standard Excel shift report", () => {
  // Create an in-memory workbook mimicking Pakowanie M4 (I + II zm).xlsx
  const wsData = [
    ["Data: 2026-08-31", "", "", "", "", "", "", "", "", "", "", ""],
    ["Firma", "Nr RCP", "Dział", "", "", "", "OD", "DO", "Realne godziny", "Podpis", "", "UWAGI"],
    ["ES", "100901", "PAKOWANIE 4", "", "", "", "06:01", "14:14", 8.22, "Emmanuel", "", ""],
    ["ESO", "001234", "PAKOWANIE 4 (2 zm)", "", "", "", "17:00", "05:00", 12.00, "Sumon", "", "Nocna zmiana"],
    ["ES", "999999", "PAKOWANIE 4", "", "", "", "", "", 0, "", "", "Nieobecний"],
    ["SUMA GODZIN", "", "", "", "", "", "", "", 20.22, "", "", ""],
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, "Pakowanie M4");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const parsed = parseDailyShiftExcel(buffer, "Pakowanie M4 (I + II zm).xlsx");

  assert.equal(parsed.reportDate, "2026-08-31");
  assert.equal(parsed.rows.length, 3); // excluding header and SUMA GODZIN

  assert.deepEqual(parsed.rows[0], {
    rowNumber: 3,
    firma: "ES",
    rcpCode: "100901",
    dzial: "PAKOWANIE 4",
    od: "06:01",
    do: "14:14",
    realneGodziny: 8.22,
    podpis: "Emmanuel",
    uwagi: "",
  });

  assert.equal(parsed.rows[1]!.rcpCode, "1234"); // leading zeros stripped
  assert.equal(parsed.rows[1]!.podpis, "Sumon");
});

test("validateStagingRow: validates OK row when worker and line match", () => {
  const row: RawParsedRow = {
    rowNumber: 3,
    firma: "ES",
    rcpCode: "100901",
    dzial: "PAKOWANIE 4",
    od: "06:01",
    do: "14:14",
    realneGodziny: 8.22,
    podpis: "Emmanuel",
    uwagi: "",
  };

  const context: ValidationContext = {
    reportDate: "2026-08-31",
    workerCodes: [
      { rcpCode: "100901", workerId: 10, companyId: 1, validFrom: "2020-01-01", validTo: null },
    ],
    companies: [{ id: 1, name: "ES" }, { id: 2, name: "ESO" }],
    lines: [{ id: 5, name: "Pakowanie 4", code: "PAK_4" }],
    lineAliases: [{ lineId: 5, rawAlias: "PAKOWANIE 4" }],
    supervisors: [{ id: 2, signatureName: "Emmanuel", workerId: 20 }],
  };

  const res = validateStagingRow(row, context);

  assert.equal(res.status, "OK");
  assert.equal(res.resolvedWorkerId, 10);
  assert.equal(res.resolvedLineId, 5);
  assert.equal(res.resolvedSupervisorId, 2);
  assert.equal(res.roundedStart, "06:15");
  assert.equal(res.roundedStop, "14:00");
  assert.equal(res.computedHours, 7.75);
});

test("validateStagingRow: flags CHECK_ID for unknown RCP code", () => {
  const row: RawParsedRow = {
    rowNumber: 3,
    firma: "ES",
    rcpCode: "UNKNOWN_999",
    dzial: "PAKOWANIE 4",
    od: "06:00",
    do: "14:00",
    realneGodziny: 8.0,
    podpis: "Emmanuel",
    uwagi: "",
  };

  const context: ValidationContext = {
    reportDate: "2026-08-31",
    workerCodes: [],
    companies: [{ id: 1, name: "ES" }],
    lines: [{ id: 5, name: "Pakowanie 4", code: "PAK_4" }],
    lineAliases: [{ lineId: 5, rawAlias: "PAKOWANIE 4" }],
    supervisors: [{ id: 2, signatureName: "Emmanuel", workerId: 20 }],
  };

  const res = validateStagingRow(row, context);

  assert.equal(res.status, "CHECK_ID");
  assert.equal(res.resolvedWorkerId, null);
});

test("validateStagingRow: flags INVALID_TIME for missing time values", () => {
  const row: RawParsedRow = {
    rowNumber: 3,
    firma: "ES",
    rcpCode: "100901",
    dzial: "PAKOWANIE 4",
    od: "",
    do: "",
    realneGodziny: 8.0,
    podpis: "Emmanuel",
    uwagi: "",
  };

  const context: ValidationContext = {
    reportDate: "2026-08-31",
    workerCodes: [
      { rcpCode: "100901", workerId: 10, companyId: 1, validFrom: "2020-01-01", validTo: null },
    ],
    companies: [{ id: 1, name: "ES" }],
    lines: [{ id: 5, name: "Pakowanie 4", code: "PAK_4" }],
    lineAliases: [{ lineId: 5, rawAlias: "PAKOWANIE 4" }],
    supervisors: [{ id: 2, signatureName: "Emmanuel", workerId: 20 }],
  };

  const res = validateStagingRow(row, context);

  assert.equal(res.status, "INVALID_TIME");
});

test("validateStagingRow: flags MISSING_SIGNATURE when supervisor is empty", () => {
  const row: RawParsedRow = {
    rowNumber: 3,
    firma: "ES",
    rcpCode: "100901",
    dzial: "PAKOWANIE 4",
    od: "06:00",
    do: "14:00",
    realneGodziny: 8.0,
    podpis: "",
    uwagi: "",
  };

  const context: ValidationContext = {
    reportDate: "2026-08-31",
    workerCodes: [
      { rcpCode: "100901", workerId: 10, companyId: 1, validFrom: "2020-01-01", validTo: null },
    ],
    companies: [{ id: 1, name: "ES" }],
    lines: [{ id: 5, name: "Pakowanie 4", code: "PAK_4" }],
    lineAliases: [{ lineId: 5, rawAlias: "PAKOWANIE 4" }],
    supervisors: [],
  };

  const res = validateStagingRow(row, context);

  assert.equal(res.status, "MISSING_SIGNATURE");
});

test("decodeOriginalFilename: recovers Polish and Cyrillic UTF-8 characters from Latin-1 mojibake", () => {
  // Latin-1 byte interpretation of "Składanie M5.xlsx"
  const mojibakePolish = Buffer.from("Składanie M5.xlsx", "utf8").toString("latin1");
  assert.equal(decodeOriginalFilename(mojibakePolish), "Składanie M5.xlsx");

  // Latin-1 byte interpretation of "Główna Produkcja (żółty).xlsx"
  const mojibakeComplex = Buffer.from("Główna Produkcja (żółty).xlsx", "utf8").toString("latin1");
  assert.equal(decodeOriginalFilename(mojibakeComplex), "Główna Produkcja (żółty).xlsx");

  // Latin-1 byte interpretation of Ukrainian Cyrillic
  const mojibakeCyr = Buffer.from("Звіт_Суші_Серпень.xlsx", "utf8").toString("latin1");
  assert.equal(decodeOriginalFilename(mojibakeCyr), "Звіт_Суші_Серпень.xlsx");

  // Already valid UTF-8 remains unchanged
  assert.equal(decodeOriginalFilename("Składanie M5.xlsx"), "Składanie M5.xlsx");

  // Standard ASCII remains unchanged
  assert.equal(decodeOriginalFilename("Pakowanie M4.xlsx"), "Pakowanie M4.xlsx");

  // Empty string fallback
  assert.equal(decodeOriginalFilename(""), "report.xlsx");
});
