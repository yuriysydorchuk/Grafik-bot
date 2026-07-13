// Імпорт сводних у БД: розбирає сітки книг (Люблін/Познань/Лодзь + WYPŁATA
// GOTÓWKĄ), матчить людей до workers, пише svodni_rows + svodni_tab_checks.
// Ядро importSvodniGrids приймає готові сітки (тести/локальний прогін без
// Google), syncSvodni() — повний цикл із Google (реєстр = payroll_sources).
import { db } from "@workspace/db";
import {
  svodniRowsTable, svodniTabChecksTable, factoriesTable, workersTable,
  payrollSourcesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { matchWorker } from "../bot/workerMatch";
import { norm, key, num, cell } from "./payrollSummaries";
import {
  parseLublinTab, parseWorkList, parseLodzFullTab, parseGotowkaTab, overlayGotowka,
  computeMismatch, type SvodniParsedTab, type GotowkaRow,
} from "./svodni";

const r2 = (n: number) => Math.round(n * 100) / 100;
const CHECK_TOL = 0.06;

type City = "Люблін" | "Познань" | "Лодзь";
const SKIP_TABS = /GODZIN.*MIES|TOTAL.*MIES|MAILE DO FV|^OFFICE|^ОФИС|^ОФІС|WORK ?LIST|^ЛИСТ|NOTATKA/i;

export interface SvodniImportInput {
  sourceId: number | null;
  periodMonth: string; // YYYY-MM
  city: City;
  firm: string | null; // Лодзь: фірма книги
  grids: Map<string, unknown[][]>;
  /** Лодзь: рядки WYPŁATA GOTÓWKĄ цієї фірми за цей місяць */
  gotowka?: GotowkaRow[];
}

export interface SvodniImportResult {
  rows: number;
  matched: number;
  unmatched: number;
  mismatches: number;
  checks: { ok: number; bad: number };
  notes: string[];
}

// зведення (GODZIN MIESIĘCZNIE / Total Miesiąc): label → {hours, doZaplaty}
function parseSummaryTab(rows: unknown[][]): Map<string, { hours: number | null; doZaplaty: number | null }> {
  const out = new Map<string, { hours: number | null; doZaplaty: number | null }>();
  const header = (rows[0] ?? []).map(c => norm(String(c ?? "")));
  const hoursCol = header.findIndex(h => /^GODZIN OGOLEM/.test(h));
  const payCol = header.findIndex(h => /^DO ZAPLATY/.test(h));
  for (let i = 1; i < rows.length; i++) {
    const label = cell(rows[i], 0);
    if (!label || /^SUMA/.test(norm(label))) break;
    out.set(key(label), {
      hours: hoursCol >= 0 ? num(rows[i]?.[hoursCol]) : null,
      doZaplaty: payCol >= 0 ? num(rows[i]?.[payCol]) : null,
    });
  }
  return out;
}

// фабрики системи: як у payrollSummaries — точний key, потім префікс
async function factoryIdByLabel(): Promise<(label: string) => number | null> {
  const rows = await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable);
  return (label: string) => {
    const k = key(label);
    const exact = rows.find(f => key(f.name) === k);
    if (exact) return exact.id;
    const pref = rows.find(f => key(f.name).startsWith(k) || k.startsWith(key(f.name)));
    return pref?.id ?? null;
  };
}

export async function importSvodniGrids(input: SvodniImportInput): Promise<SvodniImportResult> {
  const { periodMonth, city, firm, grids } = input;
  const res: SvodniImportResult = { rows: 0, matched: 0, unmatched: 0, mismatches: 0, checks: { ok: 0, bad: 0 }, notes: [] };

  // Познань: Work List — контрольні години за Nr Osobowy
  let workList: Map<string, number> | null = null;
  for (const [t, rows] of grids) if (/WORK ?LIST/i.test(t)) workList = parseWorkList(rows);

  // зведення для tab_checks
  let summary: Map<string, { hours: number | null; doZaplaty: number | null }> | null = null;
  for (const [t, rows] of grids) if (/GODZIN.*MIES|TOTAL.*MIES/i.test(norm(t))) summary = parseSummaryTab(rows);

  const tabs: SvodniParsedTab[] = [];
  for (const [t, rows] of grids) {
    if (SKIP_TABS.test(t.trim())) continue;
    const parsed = city === "Лодзь" ? parseLodzFullTab(t, rows) : parseLublinTab(t, rows);
    if (!parsed) continue;
    if (input.gotowka?.length) {
      overlayGotowka(parsed, input.gotowka.filter(g => key(g.factory) === key(t) || key(t).startsWith(key(g.factory))));
    }
    for (const row of parsed.rows) {
      computeMismatch(row, city);
      // Познань: звірка годин із Work List (за Nr Osobowy у hr)
      if (workList && row.hr.nrOsobowy) {
        const wl = workList.get(String(row.hr.nrOsobowy));
        if (wl != null) {
          row.extras.workListHours = wl;
          if (row.hours != null && Math.abs(row.hours - wl) > CHECK_TOL) {
            row.mismatch = { ...(row.mismatch ?? {}), workList: { ours: row.hours, sheet: wl } };
          }
        }
      }
    }
    tabs.push(parsed);
  }

  // матчинг людей: активні + звільнені (сводна легально містить звільнених)
  const allWorkers = await db.select({ id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode })
    .from(workersTable);
  const facId = await factoryIdByLabel();

  const rowsToInsert: (typeof svodniRowsTable.$inferInsert)[] = [];
  const checksToInsert: (typeof svodniTabChecksTable.$inferInsert)[] = [];
  for (const tab of tabs) {
    const factoryId = facId(tab.factoryLabel);
    tab.rows.forEach((row, sortIdx) => {
      const m = matchWorker(row.rawName, allWorkers);
      const workerId = m.confident?.id ?? null;
      if (workerId) res.matched++; else res.unmatched++;
      if (row.mismatch) res.mismatches++;
      rowsToInsert.push({
        periodMonth, city, firm: firm ?? tab.firmGuess, factoryLabel: tab.factoryLabel, factoryId,
        sourceId: input.sourceId, sortIdx, section: row.section, rawName: row.rawName,
        workerId, linkStatus: workerId ? "auto" : "unmatched",
        hoursNotified: row.hoursNotified, hours: row.hours, shifts: row.shifts,
        rateBrutto: row.rateBrutto, rateNetto: row.rateNetto, premia: row.premia,
        zaliczka: row.zaliczka, zaliczkaBd: row.zaliczkaBd, hostel: row.hostel,
        odziez: row.odziez, dojazd: row.dojazd, kara: row.kara, komornik: row.komornik,
        kaucja: row.kaucja, potracenia: row.potracenia,
        doWyplaty: row.doWyplaty, brutto: row.brutto,
        hoursDeclared: row.hoursDeclared, ksiegBrutto: row.ksiegBrutto, ksiegNetto: row.ksiegNetto,
        gotowka: row.gotowka, konto: row.konto,
        isStudent: row.isStudent, under26: row.under26,
        extras: row.extras, hr: row.hr, sheetValues: row.sheetValues, mismatch: row.mismatch,
      });
    });

    // tab_checks: сума наших main-рядків vs рядок SUMA вкладки
    const mainRows = tab.rows.filter(r => !r.extras.blockOnly);
    const sums: [string, number | null, number | null][] = [
      ["hours", r2(mainRows.reduce((a, x) => a + (x.hours ?? 0), 0)), tab.sheetSuma.hours ?? null],
      ["do_wyplaty", r2(mainRows.reduce((a, x) => a + (x.doWyplaty ?? 0), 0)), tab.sheetSuma.doWyplaty ?? null],
      ["zaliczka", r2(mainRows.reduce((a, x) => a + (x.zaliczka ?? 0), 0)), tab.sheetSuma.zaliczka ?? null],
    ];
    for (const [metric, ours, sheetSuma] of sums) {
      const ok = sheetSuma == null || Math.abs((ours ?? 0) - sheetSuma) <= CHECK_TOL;
      if (!ok) res.checks.bad++; else res.checks.ok++;
      checksToInsert.push({
        periodMonth, city, firm: firm ?? tab.firmGuess, factoryLabel: tab.factoryLabel,
        metric, ours, sheetSuma, summaryTab: null, ok,
        note: ok ? null : "сума рядків не збігається з рядком SUMA вкладки",
      });
    }
  }

  // Контроль зведення (GODZIN MIESIĘCZNIE / Total Miesiąc): рядок зведення може
  // покривати КІЛЬКА вкладок (AGRAM = AGRAM + AGRAM MOTYCZ) — матч за префіксом
  if (summary) {
    for (const [label, sm] of summary) {
      const matched = tabs.filter(t => {
        const tk = key(t.factoryLabel);
        return tk === label || tk.startsWith(label) || label.startsWith(tk);
      });
      if (!matched.length) continue;
      const mainOf = (t: SvodniParsedTab) => t.rows.filter(r => !r.extras.blockOnly);
      const pairs: [string, number | null, number | null][] = [
        ["hours", r2(matched.reduce((a, t) => a + mainOf(t).reduce((b, x) => b + (x.hours ?? 0), 0), 0)), sm.hours],
        ["do_wyplaty", r2(matched.reduce((a, t) => a + mainOf(t).reduce((b, x) => b + (x.doWyplaty ?? 0), 0), 0)), sm.doZaplaty],
      ];
      for (const [metric, ours, summaryVal] of pairs) {
        if (summaryVal == null) continue;
        const ok = Math.abs((ours ?? 0) - summaryVal) <= CHECK_TOL;
        if (!ok) res.checks.bad++; else res.checks.ok++;
        checksToInsert.push({
          periodMonth, city, firm, factoryLabel: matched.map(t => t.factoryLabel).join(" + "),
          metric, ours, sheetSuma: null, summaryTab: summaryVal, ok,
          note: ok ? null : "сума вкладок не збігається зі зведенням",
        });
      }
    }
  }

  await db.transaction(async tx => {
    const delWhere = and(
      eq(svodniRowsTable.periodMonth, periodMonth), eq(svodniRowsTable.city, city),
      ...(firm ? [eq(svodniRowsTable.firm, firm)] : []),
    );
    await tx.delete(svodniRowsTable).where(delWhere);
    const delChecks = and(
      eq(svodniTabChecksTable.periodMonth, periodMonth), eq(svodniTabChecksTable.city, city),
      ...(firm ? [eq(svodniTabChecksTable.firm, firm)] : []),
    );
    await tx.delete(svodniTabChecksTable).where(delChecks);
    if (rowsToInsert.length) await tx.insert(svodniRowsTable).values(rowsToInsert);
    if (checksToInsert.length) await tx.insert(svodniTabChecksTable).values(checksToInsert);
  });
  res.rows = rowsToInsert.length;
  return res;
}

// gotówka-книга фірми → рядки конкретного місяця (вкладка «MM.YYYY»)
export function gotowkaRowsForMonth(grids: Map<string, unknown[][]>, periodMonth: string): GotowkaRow[] {
  const [y, m] = periodMonth.split("-");
  const tabName = `${m}.${y}`;
  for (const [t, rows] of grids) if (t.trim() === tabName) return parseGotowkaTab(rows);
  return [];
}

// Регіон реєстру payroll_sources → місто сводної
export function cityOfRegion(region: string): City | null {
  const n = norm(region);
  if (/ЛЮБЛ|LUBL/.test(n)) return "Люблін";
  if (/ПОЗНА|POZNA/.test(n)) return "Познань";
  if (/ЛОДЗ|LODZ/.test(n)) return "Лодзь";
  return null;
}

// Повний цикл із Google: читає всі книги місяця з реєстру payroll_sources.
// Використовує ту саму механіку читання, що й syncPayrollSummaries (gsheet
// напряму; xlsx — через тимчасову конвертацію у Google Sheet).
export async function syncSvodni(months: string[]): Promise<Record<string, SvodniImportResult>> {
  const { readSourceGrids, readGotowkaGrids } = await import("./svodniFetch");
  const sources = await db.select().from(payrollSourcesTable)
    .where(inArray(payrollSourcesTable.periodMonth, months));
  const gotowkaSources = await db.select().from(payrollSourcesTable)
    .where(eq(payrollSourcesTable.kind, "gotowka"));
  const gotowkaByFirm = new Map<string, Map<string, unknown[][]>>();
  for (const g of gotowkaSources) {
    try { gotowkaByFirm.set(g.firm ?? "ES", await readGotowkaGrids(g)); }
    catch (e) { logger.warn({ err: String(e) }, "svodni: gotowka read failed"); }
  }
  const out: Record<string, SvodniImportResult> = {};
  for (const src of sources) {
    const city = cityOfRegion(src.region);
    if (!city) continue;
    try {
      const grids = await readSourceGrids(src);
      const gotowka = city === "Лодзь" && src.firm
        ? gotowkaRowsForMonth(gotowkaByFirm.get(src.firm) ?? new Map(), src.periodMonth)
        : undefined;
      out[`${city} ${src.periodMonth}${src.firm ? " " + src.firm : ""}`] = await importSvodniGrids({
        sourceId: src.id, periodMonth: src.periodMonth, city, firm: src.firm, grids, gotowka,
      });
    } catch (e) {
      logger.warn({ sourceId: src.id, err: String(e) }, "svodni: source import failed");
      out[`${src.region} ${src.periodMonth}`] = { rows: 0, matched: 0, unmatched: 0, mismatches: 0, checks: { ok: 0, bad: 0 }, notes: [String(e)] };
    }
  }
  return out;
}
