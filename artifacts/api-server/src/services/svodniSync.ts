// Імпорт сводних у БД: розбирає сітки книг (Люблін/Познань/Лодзь + WYPŁATA
// GOTÓWKĄ), матчить людей до workers, пише svodni_rows + svodni_tab_checks.
// Ядро importSvodniGrids приймає готові сітки (тести/локальний прогін без
// Google), syncSvodni() — повний цикл із Google (реєстр = payroll_sources).
import { db } from "@workspace/db";
import {
  svodniRowsTable, svodniTabChecksTable, svodniTabMetaTable, factoriesTable, workersTable,
  payrollSourcesTable, companiesTable,
} from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { matchWorker, nameScore, normalizeName } from "../bot/workerMatch";
import { norm, key, num, cell, cleanName, TAB_ALIASES } from "./payrollSummaries";
import {
  parseLublinTab, parseWorkList, parseLodzFullTab, parseGotowkaTab, overlayGotowka,
  parseOfficeTab, computeMismatch, legalStatusOf, type SvodniParsedTab, type GotowkaRow,
} from "./svodni";

const r2 = (n: number) => Math.round(n * 100) / 100;
const CHECK_TOL = 0.06;

type City = "Люблін" | "Познань" | "Лодзь";
const SKIP_TABS = /GODZIN.*MIES|TOTAL.*MIES|MAILE DO FV|WORK ?LIST|^ЛИСТ|NOTATKA/i;
export const OFFICE_TAB_RE = /^OFFICE|^ОФИС|^ОФІС|^OFIS/i;
// віртуальна вкладка «Додаткові студенти» (оптимізація) — лише для svodniSensitive
export const EXTRA_STUDENTS_LABEL = "Додаткові студенти";

export interface SvodniImportInput {
  sourceId: number | null;
  periodMonth: string; // YYYY-MM
  city: City;
  firm: string | null; // Лодзь: фірма книги
  grids: Map<string, unknown[][]>;
  /** Лодзь: рядки WYPŁATA GOTÓWKĄ цієї фірми за цей місяць */
  gotowka?: GotowkaRow[];
  /** фони клітинок вкладок (hex або null), tab → [рядок][колонка] — кольори позначок */
  colors?: Map<string, (string | null)[][]>;
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

// назви вкладок, що відрізняються від довідника фабрик (одрукування у сводних)
const FACTORY_LABEL_ALIASES: Record<string, string> = {
  ALLMIZ: "ALMIZ",
};

// Матчинг імені сводної до працівника. Обробляє два системні кейси:
//  1) дублікатні рядки однієї людини (fired + active після повторного найму)
//     блокують «впевнений» матч нічиєю 1.0/1.0 → дедуп: активний > новіший;
//  2) сводна пише повне імʼя з middle-іменами («ELHAGALY MOHAMED HELAL
//     ABDELSATAR» vs «Elhagaly Mohamed») → зворотний скоринг: усі токени
//     системного імені присутні в імені сводної.
type WLike = { id: number; fullName: string; workerCode: string | null; isActive?: boolean };
export function dedupeWorkers<T extends WLike>(workers: T[]): T[] {
  const byName = new Map<string, T>();
  for (const w of workers) {
    const k = normalizeName(w.fullName);
    const cur = byName.get(k);
    if (!cur || (w.isActive && !cur.isActive) || (w.isActive === cur.isActive && w.id > cur.id)) byName.set(k, w);
  }
  return [...byName.values()];
}
export function matchSvodniName<T extends WLike>(rawName: string, workers: T[]): T | null {
  const cleaned = cleanName(rawName);
  const m = matchWorker(cleaned, workers);
  if (m.confident) return m.confident;
  // сводна з 3–5 токенами може мати < 0.55 у прямому скорі — зворотний прохід
  // по всіх працівниках (ім'я працівника має ≥2 токени і всі вони в сводній)
  const reverse = workers.filter(w =>
    normalizeName(w.fullName).split(" ").filter(t => t.length >= 2).length >= 2 &&
    nameScore(w.fullName, cleaned) >= 0.99);
  return reverse.length === 1 ? reverse[0]! : null;
}

// фабрики системи: аліас → точний key → префікс
async function factoryIdByLabel(): Promise<(label: string) => number | null> {
  const rows = await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable);
  return (label: string) => {
    const k = FACTORY_LABEL_ALIASES[key(label)] ?? key(label);
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
  const tabColors = new Map<SvodniParsedTab, (string | null)[][]>();
  for (const [t, rows] of grids) {
    if (SKIP_TABS.test(t.trim())) continue;
    const parsed = OFFICE_TAB_RE.test(t.trim())
      ? parseOfficeTab(t.trim(), rows)
      : city === "Лодзь" ? parseLodzFullTab(t, rows) : parseLublinTab(t, rows);
    if (!parsed) continue;
    const clr = input.colors?.get(t);
    if (clr) tabColors.set(parsed, clr);
    if (input.gotowka?.length) {
      // книга готівки підписує фабрики канонічно («Pak-Service»), вкладки — по-своєму
      // («PAK-SERWIS») — ті самі аліаси, що в зарплатному модулі
      overlayGotowka(parsed, input.gotowka.filter(g => {
        const gk = key(g.factory), tk = key(t);
        return gk === tk || tk.startsWith(gk) || (TAB_ALIASES[gk] ?? []).includes(tk);
      }));
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

  // матчинг людей: активні + звільнені (сводна легально містить звільнених),
  // дублікати однієї людини схлопуються (активний рядок виграє)
  const allWorkers = dedupeWorkers(await db.select({ id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode, isActive: workersTable.isActive })
    .from(workersTable));
  const facId = await factoryIdByLabel();

  const rowsToInsert: (typeof svodniRowsTable.$inferInsert)[] = [];
  const checksToInsert: (typeof svodniTabChecksTable.$inferInsert)[] = [];
  const metaToInsert: (typeof svodniTabMetaTable.$inferInsert)[] = [];
  for (const tab of tabs) {
    const factoryId = facId(tab.factoryLabel);
    const isOffice = OFFICE_TAB_RE.test(tab.factoryLabel);
    if (tab.colOrder?.length || tab.info) {
      metaToInsert.push({
        periodMonth, city, firm: firm ?? tab.firmGuess, factoryLabel: tab.factoryLabel,
        colOrder: tab.colOrder ?? [], info: tab.info ?? {},
      });
    }
    const clr = tabColors.get(tab);
    // фон рядка = фон клітинки з іменем; білий/відсутній → без кольору
    const rowColorOf = (row: (typeof tab.rows)[number]): string | null => {
      if (!clr || row.sheetRow == null || tab.nameCol == null) return null;
      const c = clr[row.sheetRow]?.[tab.nameCol];
      return c && c !== "#ffffff" ? c : null;
    };
    tab.rows.forEach((row, sortIdx) => {
      const workerId = isOffice ? null : matchSvodniName(row.rawName, allWorkers)?.id ?? null;
      if (workerId) res.matched++; else if (!isOffice) res.unmatched++;
      if (row.mismatch) res.mismatches++;
      // студентські секції офісних вкладок (LUBLIN STUDENTY ES/KLINEX) — це
      // оптимізаційні студенти: живуть у вкладці «Додаткові студенти»
      const isOptStudent = isOffice && /STUDENT/i.test(row.section ?? "");
      rowsToInsert.push({
        periodMonth, city, firm: firm ?? tab.firmGuess,
        factoryLabel: isOptStudent ? EXTRA_STUDENTS_LABEL : tab.factoryLabel, factoryId,
        sourceId: input.sourceId, sortIdx, section: row.section, rawName: row.rawName,
        workerId, linkStatus: workerId ? "auto" : isOffice ? "office" : "unmatched",
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
        rowColor: rowColorOf(row),
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
        // офісні вкладки і кириличні назви (порожній латинський key) — поза зведенням
        if (OFFICE_TAB_RE.test(t.factoryLabel)) return false;
        const tk = key(t.factoryLabel);
        if (!tk || !label) return false;
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
    const scope = and(
      eq(svodniRowsTable.periodMonth, periodMonth), eq(svodniRowsTable.city, city),
      ...(firm ? [eq(svodniRowsTable.firm, firm)] : []),
    );
    // правлені на сайті рядки — джерело правди: лишаються, а парсовані
    // дублікати тих самих людей (фабрика+імʼя) не вставляються
    const manualRows = await tx.select({ factoryLabel: svodniRowsTable.factoryLabel, rawName: svodniRowsTable.rawName })
      .from(svodniRowsTable).where(and(scope, eq(svodniRowsTable.manual, true)));
    const manualKeys = new Set(manualRows.map(m => `${key(m.factoryLabel)}::${key(cleanName(m.rawName))}`));
    await tx.delete(svodniRowsTable).where(and(scope, eq(svodniRowsTable.manual, false)));
    const delChecks = and(
      eq(svodniTabChecksTable.periodMonth, periodMonth), eq(svodniTabChecksTable.city, city),
      ...(firm ? [eq(svodniTabChecksTable.firm, firm)] : []),
    );
    await tx.delete(svodniTabChecksTable).where(delChecks);
    await tx.delete(svodniTabMetaTable).where(and(
      eq(svodniTabMetaTable.periodMonth, periodMonth), eq(svodniTabMetaTable.city, city),
      ...(firm ? [eq(svodniTabMetaTable.firm, firm)] : []),
    ));
    const fresh = rowsToInsert.filter(r => !manualKeys.has(`${key(r.factoryLabel)}::${key(cleanName(r.rawName))}`));
    if (fresh.length) await tx.insert(svodniRowsTable).values(fresh);
    if (checksToInsert.length) await tx.insert(svodniTabChecksTable).values(checksToInsert);
    if (metaToInsert.length) await tx.insert(svodniTabMetaTable).values(metaToInsert);
    res.rows = fresh.length + manualRows.length;
    if (manualRows.length) res.notes.push(`збережено ручних рядків: ${manualRows.length}`);
  });
  return res;
}

// Перематчування незматчених рядків (після додавання працівників у систему):
// рядки сводних живуть постійно, тож щойно людина зʼявляється в workers —
// цей прохід підвʼязує її історію за іменем.
export async function rematchSvodni(): Promise<{ linked: number }> {
  const allWorkers = dedupeWorkers(await db.select({ id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode, isActive: workersTable.isActive })
    .from(workersTable));
  const unmatched = await db.select({ id: svodniRowsTable.id, rawName: svodniRowsTable.rawName })
    .from(svodniRowsTable).where(eq(svodniRowsTable.linkStatus, "unmatched"));
  let linked = 0;
  for (const row of unmatched) {
    const w = matchSvodniName(row.rawName, allWorkers);
    if (!w) continue;
    await db.update(svodniRowsTable)
      .set({ workerId: w.id, linkStatus: "auto" })
      .where(eq(svodniRowsTable.id, row.id));
    linked++;
  }
  return { linked };
}

// Створює в довіднику відсутні фабрики зі сводних: фабрика — той самий запис,
// що використовують графік/зарплати/фінанси. companyId — за фірмою (ES/ESO/Klinex).
export async function ensureSvodniFactories(): Promise<{ created: string[] }> {
  const companies = await db.select().from(companiesTable);
  const companyByFirm = (firm: string | null) =>
    companies.find(c => firm && key(c.name) === key(firm))?.id ?? null;
  const missing = await db.selectDistinct({ label: svodniRowsTable.factoryLabel, firm: svodniRowsTable.firm })
    .from(svodniRowsTable).where(isNull(svodniRowsTable.factoryId));
  const created: string[] = [];
  for (const m of missing) {
    if (OFFICE_TAB_RE.test(m.label) || m.label === EXTRA_STUDENTS_LABEL) continue; // не фабрики

    const [f] = await db.insert(factoriesTable)
      .values({ name: m.label, companyId: companyByFirm(m.firm) })
      .returning({ id: factoriesTable.id });
    await db.update(svodniRowsTable)
      .set({ factoryId: f!.id })
      .where(and(eq(svodniRowsTable.factoryLabel, m.label), isNull(svodniRowsTable.factoryId)));
    created.push(m.label);
  }
  return { created };
}

// Застосовує «правдиві» ставки/студент/до-26 зі сводної місяця до профілів
// зматчених працівників (перевага рядку зі ставкою; оновлюються лише зміни).
export interface RatesApplyResult { updated: number; skipped: number }
export async function applyRatesFromSvodni(periodMonth: string): Promise<RatesApplyResult> {
  const rows = await db.select().from(svodniRowsTable).where(and(
    eq(svodniRowsTable.periodMonth, periodMonth),
  ));
  const perWorker = new Map<number, typeof rows[number]>();
  for (const r of rows) {
    if (r.workerId == null) continue;
    const cur = perWorker.get(r.workerId);
    if (!cur || (cur.rateBrutto == null && r.rateBrutto != null)) perWorker.set(r.workerId, r);
  }
  const workers = await db.select().from(workersTable)
    .where(inArray(workersTable.id, [...perWorker.keys()]));
  let updated = 0, skipped = 0;
  for (const w of workers) {
    const s = perWorker.get(w.id)!;
    const set: Partial<typeof workersTable.$inferInsert> = {};
    if (s.rateBrutto != null && s.rateBrutto !== w.hourlyRate) set.hourlyRate = s.rateBrutto;
    if (s.rateNetto != null && s.rateNetto !== w.hourlyRateNetto) set.hourlyRateNetto = s.rateNetto;
    if (s.isStudent != null && s.isStudent !== w.isStudent) set.isStudent = s.isStudent;
    // дата народження зі сводної (dd.mm.yyyy) → профіль; «до 26» виводиться з неї
    const bd = parseSheetDate((s.hr as Record<string, string> | null)?.dataUrodzenia);
    if (bd && bd !== w.birthDate) set.birthDate = bd;
    const effBd = bd ?? w.birthDate;
    const under26 = effBd ? isUnder26(effBd) : s.under26;
    if (under26 != null && under26 !== w.under26) set.under26 = under26;
    // форма легалізації з тексту Księgowość + години в повідомленні
    const ls = legalStatusOf((s.extras as Record<string, unknown> | null)?.zusStatus as string);
    if (ls && ls !== w.legalStatus) set.legalStatus = ls;
    if (s.hoursNotified != null && s.hoursNotified !== w.notifyHours) set.notifyHours = s.hoursNotified;
    if (!Object.keys(set).length) { skipped++; continue; }
    await db.update(workersTable).set(set).where(eq(workersTable.id, w.id));
    updated++;
  }
  return { updated, skipped };
}

// «21.12.2003» / «1.9.2005» → «2003-12-21» (невалідне → null)
export function parseSheetDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const dd = Number(d), mm = Number(mo);
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
  return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}
export function isUnder26(birthDate: string, at: Date = new Date()): boolean {
  const bd = new Date(birthDate + "T00:00:00");
  const cutoff = new Date(bd.getFullYear() + 26, bd.getMonth(), bd.getDate());
  return at < cutoff;
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
      const { grids, colors } = await readSourceGrids(src);
      const gotowka = city === "Лодзь" && src.firm
        ? gotowkaRowsForMonth(gotowkaByFirm.get(src.firm) ?? new Map(), src.periodMonth)
        : undefined;
      out[`${city} ${src.periodMonth}${src.firm ? " " + src.firm : ""}`] = await importSvodniGrids({
        sourceId: src.id, periodMonth: src.periodMonth, city, firm: src.firm, grids, gotowka, colors,
      });
    } catch (e) {
      logger.warn({ sourceId: src.id, err: String(e) }, "svodni: source import failed");
      out[`${src.region} ${src.periodMonth}`] = { rows: 0, matched: 0, unmatched: 0, mismatches: 0, checks: { ok: 0, bad: 0 }, notes: [String(e)] };
    }
  }
  return out;
}
