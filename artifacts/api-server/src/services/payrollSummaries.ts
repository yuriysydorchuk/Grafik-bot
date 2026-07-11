// Payroll summaries («Зведені ЗП») — monthly per-region workbooks the office
// maintains by hand (e.g. «05.2026 Люблін Сводна»). Sources are registered from
// the web panel (a spreadsheet link per month/region); we mirror three things:
//   1. GODZIN MIESIĘCZNIE — per-factory aggregates (hours, netto to pay, extras);
//   2. per-factory tabs — main payroll table sums (brutto/netto the accountant
//      sees) + the bottom «godz fakt / godz księgowość / gotówka» block, where
//      part of the pay goes officially and the rest in cash;
//   3. OFFICE * tabs — office payroll rows, mirrored raw and linked to nothing.
// On sync the per-factory cost feeds P&L cogs (source='payroll').
import { Readable } from "node:stream";
import { google } from "googleapis";
import { db } from "@workspace/db";
import {
  payrollSourcesTable, payrollFactoryMonthsTable, payrollCashRowsTable,
  payrollOfficeRowsTable, payrollFoldersTable, payrollNameMatchesTable, pnlEntriesTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getDriveAuth } from "./drive";
import { T_SALARY } from "./bankClassify";

// employer-side ZUS on declared brutto of taxed (non-student) zlecenie workers:
// emerytalne 9,76% + rentowe 6,5% + wypadkowe ~1,67% + FP 2,45% + FGŚP 0,1%
export const EMPLOYER_ZUS_RATE = 0.2048;

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim();
  if (!s || s === "-" || /#REF|#DIV|#N\/A/i.test(s)) return null;
  const n = Number(s.replace(/[\s zł]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.round(n); };
const cell = (r: unknown[] | undefined, i: number): string => String(r?.[i] ?? "").trim();
// office tabs carry dates; UNFORMATTED_VALUE returns them as sheet serials (46099 → 23.03.2026)
const dateCell = (r: unknown[] | undefined, i: number): string | null => {
  const s = cell(r, i);
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n) && n > 30000 && n < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
  }
  return s;
};
const norm = (s: string) =>
  s.toUpperCase()
    .replace(/[ĄĆĘŁŃÓŚŹŻ]/g, ch => ({ Ą: "A", Ć: "C", Ę: "E", Ł: "L", Ń: "N", Ó: "O", Ś: "S", Ź: "Z", Ż: "Z" }[ch] ?? ch))
    .replace(/\s+/g, " ").trim();
// matching key: letters/digits only («InPost [LDZ]» ↔ tab «InPost LDZ», «TOP-2» ↔ «TOP - 2»)
const key = (s: string) => norm(s).replace(/[^A-Z0-9]/g, "");

// factory → firm, where the tab name lies: verified by the per-person bank
// reconciliation («Звірка ЗП → По фабриках») — workers of these Lublin
// factories are actually paid from other firms' accounts
const FIRM_OVERRIDES: Record<string, string> = {
  LST: "ESO",
  PREMIUMFRUITS: "Klinex",
};

// summary-row label → factory tab name(s); keys are `key()`-normalized
const TAB_ALIASES: Record<string, string[]> = {
  AGRAM: ["AGRAM", "AGRAMMOTYCZ"],
  ANDROS: ["ANDROSKLINEX", "ANDROSEUROSUPORT", "ANDROSEUROSUPPORT"],
  BLC: ["SUPERDROB"],
  EUROCASHBL: ["EUROCASHBIALYSTOK"],
  EUROCASHLB: ["EUROCASHLUBLIN"],
  PAKSERVICE: ["PAKSERWIS"],
};

const isServiceRow = (name: string) =>
  /^(SUMA|ILOSC|ILOŚĆ|W TYM|RAZEM|RAMZEM|NIE OPODATKOWANE|OPODATKOWANE|LUBLIN|STOLBEC|СТОЛБЕЦ|NAZWISKO|IMIE|IMIĘ)/i.test(norm(name));

export interface WorkerRow {
  name: string;
  hoursActual: number | null;
  hoursDeclared: number | null;
  brutto: number | null;   // declared brutto (ZUS base)
  netto: number | null;    // declared netto (bank part)
  gotowka: number | null;
  fullNetto: number | null; // Do wypłaty / RAZEM
  konto: number | null;     // expected bank transfer
}
export interface TabSums {
  firmGuess: string | null; // Poznań worker rows carry the firm in column A
  mainBrutto: number; mainNetto: number; mainTaxedBrutto: number;
  workers: WorkerRow[];     // all workers of the tab, main table merged with the block
  block: null | {
    brutto: number; netto: number; taxedBrutto: number; gotowka: number;
    hoursActual: number; hoursDeclared: number;
    rows: { name: string; hoursActual: number | null; hoursDeclared: number | null; brutto: number | null; netto: number | null; gotowka: number | null }[];
  };
}

// strip annotations: «PAVLENKO IRYNA *( 2000 zl na kartu)», «KALCHUK VITALII - wózkowy»,
// role suffixes «MAMMADLI KHAYAL Lider / Pracownik» (one person, two payroll lines)
export const cleanName = (s: string) =>
  s.replace(/\(.*?\)/g, "").replace(/\s+-\s.*$/, "").replace(/\*/g, "")
    .replace(/\s+(lider|pracownik|brygadzista|koordynator|wozkowy|wózkowy)\s*$/i, "")
    .replace(/\s+/g, " ").trim();
export const nameTokens = (s: string) => norm(cleanName(s)).split(" ").filter(t => t.length > 1);

// merge the bottom-block rows into the main worker list: exact key first, then
// ≥2 shared name tokens (the sheets abbreviate and misspell names between blocks)
export function mergeWorkers(main: WorkerRow[], block: NonNullable<TabSums["block"]>["rows"]): WorkerRow[] {
  const out = main.map(w => ({ ...w }));
  const used = new Set<number>();
  for (const b of block) {
    const bk = key(cleanName(b.name));
    const bt = nameTokens(b.name);
    let idx = out.findIndex((w, i) => !used.has(i) && key(cleanName(w.name)) === bk);
    if (idx < 0) idx = out.findIndex((w, i) => {
      if (used.has(i)) return false;
      const wt = new Set(nameTokens(w.name));
      return bt.filter(t => wt.has(t)).length >= 2;
    });
    if (idx >= 0) {
      used.add(idx);
      const w = out[idx]!;
      w.hoursActual = w.hoursActual ?? b.hoursActual;
      w.hoursDeclared = b.hoursDeclared;
      w.brutto = b.brutto;
      w.netto = b.netto;
      w.gotowka = b.gotowka;
      w.konto = b.netto; // declared part goes to the account
    } else {
      out.push({ ...b, fullNetto: (b.netto ?? 0) + (b.gotowka ?? 0), konto: b.netto });
    }
  }
  return out;
}

// Parse one factory tab: sum the main payroll table (per-worker netto/brutto)
// and, if present, the bottom declared-vs-cash block.
export function parseFactoryTab(rows: unknown[][]): TabSums | null {
  const header = rows[0];
  if (!header) return null;
  const hIdx = (re: RegExp, from = 0) => header.findIndex((c, i) => i >= from && re.test(norm(String(c ?? ""))));
  const nettoCol = hIdx(/^DO WYPLATY( NETTO)?$/);
  if (nettoCol < 0) return null; // non-standard tab (Eurocash performance sheets etc.)
  const bruttoCol = hIdx(/^BRUTTO$/, nettoCol + 1);
  // names sit just left of «Ilość godz w powiadomieniu» (Poznań tabs prepend
  // Nr Osobowy/Stanowisko/… columns, so the name is not necessarily column A)
  const powiadCol = hIdx(/GODZ W POWIADOMIENIU/);
  const mainNameCol = powiadCol > 0 ? powiadCol - 1 : 0;
  const hoursCol = hIdx(/^ILOSC GODZIN$/);

  const sums: TabSums = { firmGuess: null, mainBrutto: 0, mainNetto: 0, mainTaxedBrutto: 0, workers: [], block: null };
  const mainWorkers: WorkerRow[] = [];
  let r = 1;
  for (; r < rows.length; r++) {
    const name = cell(rows[r], mainNameCol);
    if (/^SUMA GODZIN/i.test(norm(name)) || /^SUMA GODZIN/i.test(norm(cell(rows[r], mainNameCol + 1)))) break;
    if (!name || isServiceRow(name)) continue;
    const netto = num(rows[r]?.[nettoCol]);
    if (netto == null) continue;
    if (!sums.firmGuess && mainNameCol > 0) {
      // firm column position drifts between months — scan everything left of the name
      for (let j = 0; j < mainNameCol && !sums.firmGuess; j++) sums.firmGuess = firmFromLabel(cell(rows[r], j));
    }
    const brutto = bruttoCol >= 0 ? num(rows[r]?.[bruttoCol]) : null;
    sums.mainNetto += netto;
    sums.mainBrutto += brutto ?? netto; // students: brutto column often left empty
    if (brutto != null && brutto > netto + 0.01) sums.mainTaxedBrutto += brutto;
    mainWorkers.push({
      name, hoursActual: hoursCol >= 0 ? num(rows[r]?.[hoursCol]) : null, hoursDeclared: null,
      brutto: brutto ?? netto, netto, gotowka: null, fullNetto: netto, konto: netto, // no cash block → all official
    });
  }

  // bottom block, layout variants across regions/months:
  //  a) labeled header «godz fakt / godz księgowość / brutto / netto / gotówka»
  //     (sometimes without «godz fakt» — then it's the column left of księgowość);
  //  b) header whose ONLY label is «gotówka» (Poznań) — the four columns to its
  //     left are netto / brutto / godz księg. / godz fakt.
  // The name column is found from the first data row: the rightmost text cell
  // left of «godz fakt» that is not a powiad marker (side mini-tables sit further left).
  for (; r < rows.length; r++) {
    const line = rows[r] ?? [];
    const labels = line.map(c => norm(String(c ?? "")));
    const idx = (re: RegExp) => labels.findIndex(h => re.test(h));
    const fakt = idx(/GODZ\.?\s*FAKT/);
    const ksiegLbl = idx(/KSIEGOWOSC/);
    const gotLbl = idx(/GOTOWKA|DOTOWKA/);
    let faktCol: number, ksieg: number, bru: number, net: number, got: number;
    if (fakt >= 0 || ksiegLbl >= 0) {
      ksieg = ksiegLbl >= 0 ? ksiegLbl : fakt + 1;
      faktCol = fakt >= 0 ? fakt : ksieg - 1;
      const bruLbl = idx(/^BRUTTO/);
      bru = bruLbl >= 0 ? bruLbl : ksieg + 1;
      const netLbl = idx(/^NETTO/);
      net = netLbl >= 0 ? netLbl : bru + 1;
      got = gotLbl >= 0 ? gotLbl : net + 1;
    } else if (gotLbl >= 5 && labels.filter(h => h).length === 1) {
      got = gotLbl; net = got - 1; bru = got - 2; ksieg = got - 3; faktCol = got - 4;
    } else continue;
    const firstData = rows[r + 1] ?? [];
    let nameCol = -1;
    for (let j = faktCol - 1; j >= 0; j--) {
      const v = String(firstData[j] ?? "").trim();
      if (!v || num(v) != null) continue;
      if (/^(STUD|DYPLOM|NIE ZG|KARTA|POWIAD|СТОЛБЕЦ|STOLBEC)/i.test(norm(v))) continue;
      nameCol = j;
      break;
    }
    if (nameCol < 0) continue; // header matched but no data row → keep scanning
    const block: NonNullable<TabSums["block"]> = { brutto: 0, netto: 0, taxedBrutto: 0, gotowka: 0, hoursActual: 0, hoursDeclared: 0, rows: [] };
    for (let i = r + 1; i < rows.length; i++) {
      const name = cell(rows[i], nameCol);
      if (!name || isServiceRow(name)) break;
      const row = {
        name,
        hoursActual: faktCol >= 0 ? num(rows[i]?.[faktCol]) : null,
        hoursDeclared: ksieg >= 0 ? num(rows[i]?.[ksieg]) : null,
        brutto: bru >= 0 ? num(rows[i]?.[bru]) : null,
        netto: net >= 0 ? num(rows[i]?.[net]) : null,
        gotowka: got >= 0 ? num(rows[i]?.[got]) : null,
      };
      block.rows.push(row);
      block.hoursActual += row.hoursActual ?? 0;
      block.hoursDeclared += row.hoursDeclared ?? 0;
      block.brutto += row.brutto ?? 0;
      block.netto += row.netto ?? 0;
      block.gotowka += row.gotowka ?? 0;
      if (row.brutto != null && row.netto != null && row.brutto > row.netto + 0.01) block.taxedBrutto += row.brutto;
    }
    if (block.rows.length) sums.block = block;
    break;
  }
  sums.workers = sums.block ? mergeWorkers(mainWorkers, sums.block.rows) : mainWorkers;
  return sums;
}

// Łódź worker tabs: sections with repeating headers «Nazwisko/Imię | Status |
// Godzin | Stawka/brutto | Stawka/netto | … | RAZEM | NA KONTO "h" | Ew. | h. |
// zł. | Dopłata ES | …». The official (ZUS) part is Ew. hours × stawka; the
// rest is paid in cash: na rękę = RAZEM − Ew×netto + Dopłata ES (checked
// against the «WYPŁATA GOTÓWKĄ» workbooks).
export function parseLodzTab(rows: unknown[][]): TabSums | null {
  const sums: TabSums = { firmGuess: null, mainBrutto: 0, mainNetto: 0, mainTaxedBrutto: 0, workers: [], block: null };
  const block: NonNullable<TabSums["block"]> = { brutto: 0, netto: 0, taxedBrutto: 0, gotowka: 0, hoursActual: 0, hoursDeclared: 0, rows: [] };
  let c: { name: number; godzin: number; stB: number; stN: number; razem: number; ew: number; doplata: number } | null = null;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  let hasEw = false;
  for (const row of rows) {
    const labels = (row ?? []).map(x => norm(String(x ?? "")));
    if (labels.some(h => /NAZWISKO/.test(h)) && labels.some(h => /^RAZEM$/.test(h))) {
      const idx = (re: RegExp) => labels.findIndex(h => re.test(h));
      c = {
        name: idx(/NAZWISKO/), godzin: idx(/^GODZIN$/), stB: idx(/STAWKA.*BRUTTO/), stN: idx(/STAWKA.*NETTO/),
        razem: idx(/^RAZEM$/), ew: idx(/^EW\.?$/), doplata: idx(/^DOPLATA/),
      };
      continue;
    }
    if (!c) continue;
    const name = cell(row, c.name);
    if (!name || isServiceRow(name) || /^UL[. ]|^TOTAL/i.test(norm(name))) continue;
    const razem = num(row?.[c.razem]);
    if (razem == null) continue;
    const stB = num(row?.[c.stB]) ?? 0;
    const stN = num(row?.[c.stN]) ?? 0;
    const taxed = stB > stN + 0.001 && stN > 0;
    const hoursActual = num(row?.[c.godzin]);
    if (c.ew >= 0 && c.stN >= 0) {
      // full layout (Klinex): Ew. hours → exact declared/cash split
      hasEw = true;
      const ew = num(row?.[c.ew]) ?? 0;
      const doplata = c.doplata >= 0 ? num(row?.[c.doplata]) ?? 0 : 0;
      const brutto = r2(ew * stB);
      const netto = r2(ew * stN);
      const gotowka = r2(razem - netto + doplata);
      block.rows.push({ name, hoursActual, hoursDeclared: ew, brutto, netto, gotowka });
      sums.workers.push({ name, hoursActual, hoursDeclared: ew, brutto, netto, gotowka, fullNetto: razem, konto: netto });
      block.hoursActual += hoursActual ?? 0;
      block.hoursDeclared += ew;
      block.brutto += brutto;
      block.netto += netto;
      block.gotowka += gotowka;
      if (taxed) block.taxedBrutto += brutto;
      sums.mainBrutto += brutto;
      if (taxed) sums.mainTaxedBrutto += brutto;
    } else {
      // limited layout (ESO/ESG): no Ew. column — assume fully official; the
      // «WYPŁATA GOTÓWKĄ» overlay corrects workers who get part in cash
      const brutto = taxed ? r2(razem * (stB / stN)) : razem;
      sums.workers.push({ name, hoursActual, hoursDeclared: null, brutto, netto: razem, gotowka: null, fullNetto: razem, konto: razem });
      sums.mainBrutto += brutto;
      if (taxed) sums.mainTaxedBrutto += brutto;
    }
    sums.mainNetto += razem;
  }
  if (!sums.workers.length) return null;
  if (hasEw && block.rows.length) sums.block = block;
  return sums;
}

// «05.2026 Люблін Сводна» → { periodMonth: "2026-05", region: "Люблін", firm: null }
// «Фабрик 06.2026 KLINEX» / «Сводная Фабрик 01.2026 EUROSUPPORT» (Лодзь, per-firm
// workbooks) → { periodMonth: "2026-06", region: "Лодзь", firm: "Klinex" }
export function parseWorkbookTitle(title: string): { periodMonth: string; region: string; firm: string | null } | null {
  const lodz = title.match(/фабрик\s+(\d{1,2})[.\-\/](\d{4})\s+(.+?)(?:\.xlsx)?\s*$/i);
  if (lodz) {
    const raw = norm(lodz[3]!);
    const firm = /OUTS/.test(raw) ? "ESO" : /KLINEX/.test(raw) ? "Klinex" : "ES";
    return { periodMonth: `${lodz[2]}-${lodz[1]!.padStart(2, "0")}`, region: "Лодзь", firm };
  }
  const m = title.match(/(\d{1,2})[.\-\/](\d{4})\s+(.+?)\s*(сводна|zvedena|зведена)?\s*$/i);
  if (!m) return null;
  return { periodMonth: `${m[2]}-${m[1]!.padStart(2, "0")}`, region: m[3]!.trim(), firm: null };
}

// ES | ESO | Klinex from a free-form label (tab name, worker-row firm column)
function firmFromLabel(s: string): string | null {
  const n = norm(s);
  if (/OUTS/.test(n)) return "ESO";
  if (/KLINEX/.test(n)) return "Klinex";
  if (/EURO\s*SUP|(^|[^A-Z])ES([^A-Z]|$)|EUROSUPPORT/.test(n)) return "ES";
  return null;
}

export interface PayrollSyncResult { sources: number; factories: number; cashRows: number; officeRows: number; registered: number; errors: string[] }

// Scan registered Drive folders and auto-register any workbook whose title
// parses as «MM.YYYY <регіон> Сводна». Returns how many new sources appeared.
async function scanPayrollFolders(auth: InstanceType<typeof google.auth.GoogleAuth>, errors: string[]): Promise<number> {
  const folders = await db.select().from(payrollFoldersTable);
  if (!folders.length) return 0;
  const drive = google.drive({ version: "v3", auth });
  const known = new Set((await db.select({ id: payrollSourcesTable.spreadsheetId }).from(payrollSourcesTable)).map(x => x.id));
  let registered = 0;
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  for (const folder of folders) {
    try {
      // walk subfolders too (Łódź keeps per-firm folders inside the year folder)
      const queue = [folder.folderId];
      for (let depth = 0; depth < 4 && queue.length; depth++) {
        const level = queue.splice(0);
        for (const dirId of level) {
          let pageToken: string | undefined;
          do {
            const r = await drive.files.list({
              q: `'${dirId}' in parents and trashed=false`,
              fields: "nextPageToken, files(id,name,mimeType)", pageSize: 100, pageToken,
              supportsAllDrives: true, includeItemsFromAllDrives: true,
            });
            for (const f of r.data.files ?? []) {
              if (!f.id) continue;
              if (f.mimeType === "application/vnd.google-apps.folder") { queue.push(f.id); continue; }
              const kind = f.mimeType === XLSX_MIME ? "xlsx" : f.mimeType === "application/vnd.google-apps.spreadsheet" ? "gsheet" : null;
              if (!kind || known.has(f.id)) continue;
              // «WYPŁATA GOTÓWKĄ <FIRM>» — per-firm cash-payout workbook (tab per
              // month), overlays the declared/cash split onto factory months
              if (/WYP\S*ATA\s+GOT/i.test(norm(f.name ?? ""))) {
                await db.insert(payrollSourcesTable).values({
                  periodMonth: "*", region: "Лодзь", firm: firmFromLabel(f.name ?? "") ?? "ES",
                  spreadsheetId: f.id, kind: "gotowka", title: f.name ?? null,
                });
                known.add(f.id);
                registered++;
                continue;
              }
              const parsed = parseWorkbookTitle(f.name ?? "");
              if (!parsed) continue; // not a monthly summary workbook
              await db.insert(payrollSourcesTable).values({ ...parsed, spreadsheetId: f.id, kind, title: f.name ?? null });
              known.add(f.id);
              registered++;
            }
            pageToken = r.data.nextPageToken ?? undefined;
          } while (pageToken);
        }
      }
      await db.update(payrollFoldersTable).set({ lastSyncAt: new Date(), lastError: null }).where(eq(payrollFoldersTable.id, folder.id));
    } catch (e) {
      errors.push(`папка ${folder.title ?? folder.folderId}: ${String(e)}`);
      await db.update(payrollFoldersTable).set({ lastError: String(e) }).where(eq(payrollFoldersTable.id, folder.id));
    }
  }
  return registered;
}

export async function syncPayrollSummaries(opts: { sourceId?: number } = {}): Promise<PayrollSyncResult> {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(json),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly", "https://www.googleapis.com/auth/drive.readonly"],
  });
  const api = google.sheets({ version: "v4", auth });
  const saDrive = google.drive({ version: "v3", auth });
  // xlsx workbooks are read through a temporary Google-Sheet conversion (formulas
  // in Office files carry no cached values): the service account downloads the
  // bytes (it has read access to the shared folders), the admin's OAuth account
  // uploads them converted into its own Drive (service accounts have no quota),
  // we read the values and delete the temp file.
  const userAuth = getDriveAuth();
  const userDrive = google.drive({ version: "v3", auth: userAuth as any });
  const userSheets = google.sheets({ version: "v4", auth: userAuth as any });

  const errors: string[] = [];
  const registered = opts.sourceId ? 0 : await scanPayrollFolders(auth, errors);
  const sources = (opts.sourceId
    ? await db.select().from(payrollSourcesTable).where(eq(payrollSourcesTable.id, opts.sourceId))
    : await db.select().from(payrollSourcesTable))
    // cash-payout overlays must run AFTER the monthly workbooks they enrich
    .sort((a, b) => Number(a.kind === "gotowka") - Number(b.kind === "gotowka"));
  const result: PayrollSyncResult = { sources: 0, factories: 0, cashRows: 0, officeRows: 0, registered, errors };

  for (const src of sources) {
    let tempId: string | null = null;
    try {
      if (src.kind === "gotowka") {
        await syncGotowkaSource(api, src);
        result.sources++;
        continue;
      }
      let sheetId = src.spreadsheetId;
      const sheetsApi = src.kind === "xlsx" ? userSheets : api;
      if (src.kind === "xlsx") {
        const dl = await saDrive.files.get(
          { fileId: src.spreadsheetId, alt: "media", supportsAllDrives: true },
          { responseType: "arraybuffer" },
        );
        const up = await userDrive.files.create({
          requestBody: { name: `tmp payroll import ${src.id}`, mimeType: "application/vnd.google-apps.spreadsheet" },
          media: {
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            body: Readable.from(Buffer.from(dl.data as ArrayBuffer)),
          },
        });
        tempId = up.data.id ?? null;
        if (!tempId) throw new Error("xlsx → gsheet conversion failed");
        sheetId = tempId;
      }
      const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: sheetId });
      const tabs = (meta.data.sheets ?? []).map(s => s.properties?.title ?? "").filter(Boolean);
      const grid = new Map<string, unknown[][]>();
      // batch-read all tabs we care about
      const wanted = tabs.filter(t => norm(t) !== "MAILE DO FV");
      const res = await sheetsApi.spreadsheets.values.batchGet({
        spreadsheetId: sheetId,
        ranges: wanted.map(t => `'${t}'!A1:AG400`), // Poznań tabs go past column R
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      (res.data.valueRanges ?? []).forEach((vr, i) => grid.set(wanted[i]!, (vr.values ?? []) as unknown[][]));

      // ---- GODZIN MIESIĘCZNIE / Total Miesiąc (Łódź): per-factory aggregates
      const godzTab = wanted.find(t => /GODZIN.*MIES|TOTAL.*MIES/i.test(norm(t)));
      const factories: (typeof payrollFactoryMonthsTable.$inferInsert)[] = [];
      const cashRows: (typeof payrollCashRowsTable.$inferInsert)[] = [];

      // pre-parse all factory tabs (skip GODZIN/office)
      const tabSums = new Map<string, TabSums>();
      for (const t of wanted) {
        if (t === godzTab || /OFFICE/i.test(norm(t)) || /^(ОФИС|ОФІС|OFIS)/i.test(t.trim())) continue;
        const s = parseFactoryTab(grid.get(t) ?? []) ?? parseLodzTab(grid.get(t) ?? []);
        if (s) tabSums.set(t, s);
      }

      if (godzTab) {
        const rows = grid.get(godzTab) ?? [];
        const header = (rows[0] ?? []).map(c => norm(String(c ?? "")));
        const col = (re: RegExp) => header.findIndex(h => re.test(h));
        const c = {
          hours: col(/^GODZIN OGOLEM/), doZaplaty: col(/^DO ZAPLATY/), zaliczki: col(/^ZALICZKI$/),
          zaliczkaBd: col(/^ZALICZKA BD/), premia: col(/^PREMIA/), odziez: col(/^ODZIEZ/),
          hostel: col(/^HOSTEL/), dojazd: col(/^DOJAZD/), kary: col(/^KARA/),
          workers: col(/^ILOSC PRACOWNIKOW/), students: col(/^ILOSC STUDENTOW/), over26: col(/WYZEJ 26/),
        };
        for (let i = 1; i < rows.length; i++) {
          const label = cell(rows[i], 0);
          if (!label || /^SUMA/i.test(norm(label))) break; // totals row / rate-negotiation block below
          // match the factory row to its tab(s)
          const nl = key(label);
          // aliases first: «Agram» covers two tabs, «BLC» lives in SUPERDROB etc.
          let matched = TAB_ALIASES[nl] ? tabs.filter(t => TAB_ALIASES[nl]!.includes(key(t))) : [];
          if (!matched.length) matched = tabs.filter(t => key(t) === nl);
          if (!matched.length) matched = tabs.filter(t => key(t).startsWith(nl) && !/OFFICE/i.test(norm(t)));
          const sums = matched.map(t => tabSums.get(t)).filter((s): s is TabSums => !!s);
          // firm: verified override → whole-workbook (Лодзь) → worker-row column
          // (Познань) → tab name (Люблін: ANDROS KLINEX vs ANDROS EURO SUPORT);
          // data-bearing tab wins
          const firm = FIRM_OVERRIDES[nl]
            ?? src.firm
            ?? sums.find(s => s.mainNetto > 0)?.firmGuess
            ?? (matched.length
              ? firmFromLabel(matched.find(t => (tabSums.get(t)?.mainNetto ?? 0) > 0) ?? matched[0]!) ?? "ES"
              : null);
          const add = (f: (s: TabSums) => number) => sums.length ? Math.round(sums.reduce((a, s) => a + f(s), 0) * 100) / 100 : null;
          const blocks = sums.map(s => s.block).filter((b): b is NonNullable<TabSums["block"]> => !!b);
          const badd = (f: (b: NonNullable<TabSums["block"]>) => number) => blocks.length ? Math.round(blocks.reduce((a, b) => a + f(b), 0) * 100) / 100 : null;
          const g = (idx: number) => (idx >= 0 ? num(rows[i]?.[idx]) : null);
          factories.push({
            sourceId: src.id, periodMonth: src.periodMonth, region: src.region,
            factory: label, firm, tabName: matched.join(" + ") || null,
            hours: g(c.hours), doZaplaty: g(c.doZaplaty), zaliczki: g(c.zaliczki), zaliczkaBd: g(c.zaliczkaBd),
            premia: g(c.premia), odziez: g(c.odziez), hostel: g(c.hostel), dojazd: g(c.dojazd), kary: g(c.kary),
            workers: c.workers >= 0 ? int(rows[i]?.[c.workers]) : null,
            students: c.students >= 0 ? int(rows[i]?.[c.students]) : null,
            over26: c.over26 >= 0 ? int(rows[i]?.[c.over26]) : null,
            mainBrutto: add(s => s.mainBrutto), mainNetto: add(s => s.mainNetto), mainTaxedBrutto: add(s => s.mainTaxedBrutto),
            blockBrutto: badd(b => b.brutto), blockNetto: badd(b => b.netto), blockTaxedBrutto: badd(b => b.taxedBrutto),
            gotowka: badd(b => b.gotowka),
            blockHoursActual: badd(b => b.hoursActual), blockHoursDeclared: badd(b => b.hoursDeclared),
          });
          for (const t of matched) {
            const workers = tabSums.get(t)?.workers;
            if (!workers?.length) continue;
            workers.forEach((row, sortIdx) => cashRows.push({
              sourceId: src.id, periodMonth: src.periodMonth, region: src.region, tabName: t,
              name: row.name, hoursActual: row.hoursActual, hoursDeclared: row.hoursDeclared,
              brutto: row.brutto, netto: row.netto, gotowka: row.gotowka,
              fullNetto: row.fullNetto, konto: row.konto, sortIdx,
            }));
          }
        }
      }

      // ---- OFFICE tabs: raw mirror
      const officeRows: (typeof payrollOfficeRowsTable.$inferInsert)[] = [];
      for (const t of wanted) {
        const isLodzOffice = /^(ОФИС|ОФІС|OFIS)/i.test(t.trim()); // NB: JS \b breaks after Cyrillic
        if (!/^OFFICE\b/i.test(norm(t)) && !isLodzOffice) continue;
        const firm = isLodzOffice
          ? src.firm ?? "ES"
          : firmFromLabel(t.replace(/office/i, "").trim()) ?? (t.replace(/office/i, "").trim() || t);
        let section: string | null = null;
        let sortIdx = 0;
        for (const row of grid.get(t) ?? []) {
          const name = cell(row, 0);
          if (!name) continue;
          const n = norm(name);
          if (/^BIURO$/.test(n)) continue; // Łódź header row
          if (/^LUBLIN|^LODZ|OFFICE|STUDENTY/.test(n) && !num(row?.[4])) { section = name; continue; }
          if (/^\d/.test(name) || isServiceRow(name)) continue;
          // section header rows inside the tab («Kierowcy | godziny/dni | stawka»)
          if (/GODZIN|DNI/.test(norm(cell(row, 1))) || /GODZIN|DNI/.test(norm(cell(row, 2)))) { section = name; continue; }
          officeRows.push(isLodzOffice
            // Łódź layout: name | godziny | migawka | zaliczka | stawka | razem
            ? {
                sourceId: src.id, periodMonth: src.periodMonth, region: src.region, firm, section,
                name, status: null, hours: cell(row, 1) || null, stawka: cell(row, 4) || null,
                brutto: num(row?.[5]), umowaOd: null, umowaDo: null, koniecStudiow: null, zaswiadczenie: null,
                sortIdx: sortIdx++,
              }
            // Lublin layout: name | status | godziny | stawka | brutto | umowa od/do | …
            : {
                sourceId: src.id, periodMonth: src.periodMonth, region: src.region, firm, section,
                name, status: cell(row, 1) || null, hours: cell(row, 2) || null, stawka: cell(row, 3) || null,
                brutto: num(row?.[4]),
                umowaOd: dateCell(row, 5), umowaDo: dateCell(row, 6),
                koniecStudiow: dateCell(row, 7), zaswiadczenie: dateCell(row, 8),
                sortIdx: sortIdx++,
              });
        }
      }

      // wipe & insert per source
      await db.transaction(async tx => {
        await tx.delete(payrollCashRowsTable).where(eq(payrollCashRowsTable.sourceId, src.id));
        await tx.delete(payrollOfficeRowsTable).where(eq(payrollOfficeRowsTable.sourceId, src.id));
        await tx.delete(payrollFactoryMonthsTable).where(eq(payrollFactoryMonthsTable.sourceId, src.id));
        if (factories.length) await tx.insert(payrollFactoryMonthsTable).values(factories);
        if (cashRows.length) await tx.insert(payrollCashRowsTable).values(cashRows);
        if (officeRows.length) await tx.insert(payrollOfficeRowsTable).values(officeRows);
        await tx.update(payrollSourcesTable)
          .set({
            lastSyncAt: new Date(), lastError: null,
            // the temp copy carries a synthetic name — keep the original title for xlsx
            title: src.kind === "xlsx" ? src.title : meta.data.properties?.title ?? src.title,
          })
          .where(eq(payrollSourcesTable.id, src.id));
      });
      await feedPnlCogs(src.periodMonth);
      result.sources++;
      result.factories += factories.length;
      result.cashRows += cashRows.length;
      result.officeRows += officeRows.length;
    } catch (e) {
      const msg = `${src.region} ${src.periodMonth}: ${String(e)}`;
      result.errors.push(msg);
      logger.warn({ sourceId: src.id, err: String(e) }, "payroll summary sync failed");
      await db.update(payrollSourcesTable).set({ lastError: String(e) }).where(eq(payrollSourcesTable.id, src.id));
    } finally {
      if (tempId) await userDrive.files.delete({ fileId: tempId, supportsAllDrives: true }).catch(() => {});
    }
  }
  return result;
}

// «WYPŁATA GOTÓWKĄ <FIRM>» overlay (Лодзь): tab per month, rows
// Imie/Nazwisko | Fabryka | Razem | Na konto | (Dopłata ES) | Na renke.
// Fills the declared/cash split for factories whose own tab didn't provide it
// (Klinex tabs carry Ew. hours and are computed exactly — those are kept).
// Declared brutto is estimated from na konto at the standard 31,40/25,35 ratio.
const STD_BRUTTO_NETTO_RATIO = 31.4 / 25.35;
async function syncGotowkaSource(api: ReturnType<typeof google.sheets>, src: typeof payrollSourcesTable.$inferSelect) {
  const meta = await api.spreadsheets.get({ spreadsheetId: src.spreadsheetId });
  const tabs = (meta.data.sheets ?? []).map(s => s.properties?.title ?? "").filter(t => /^\d{2}\.\d{4}$/.test(t.trim()));
  if (!tabs.length) return;
  const res = await api.spreadsheets.values.batchGet({
    spreadsheetId: src.spreadsheetId,
    ranges: tabs.map(t => `'${t}'!A1:L400`),
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const months = new Set<string>();
  await db.transaction(async tx => {
    await tx.delete(payrollCashRowsTable).where(eq(payrollCashRowsTable.sourceId, src.id));
    for (let ti = 0; ti < tabs.length; ti++) {
      const [mm, yyyy] = tabs[ti]!.trim().split(".");
      const month = `${yyyy}-${mm}`;
      const rows = (res.data.valueRanges?.[ti]?.values ?? []) as unknown[][];
      // column map from the header row
      let c: { name: number; fab: number; razem: number; konto: number; renke: number } | null = null;
      // per-factory accumulation
      const byFab = new Map<string, { rows: { name: string; netto: number; gotowka: number; razem: number | null }[]; konto: number; renke: number }>();
      for (const row of rows) {
        const labels = (row ?? []).map(x => norm(String(x ?? "")));
        if (labels.some(h => /NAZWISKO/.test(h)) && labels.some(h => /NA KONTO/.test(h))) {
          const idx = (re: RegExp) => labels.findIndex(h => re.test(h));
          c = { name: idx(/NAZWISKO/), fab: idx(/FABRYKA/), razem: idx(/^RAZEM$/), konto: idx(/^NA KONTO/), renke: idx(/NA RENKE|NA REKE/) };
          continue;
        }
        if (!c) continue;
        const name = cell(row, c.name);
        const fab = cell(row, c.fab);
        const konto = num(row?.[c.konto]);
        if (!name || !fab || isServiceRow(name) || konto == null) continue;
        const renke = num(row?.[c.renke]) ?? 0;
        const g = byFab.get(key(fab)) ?? byFab.set(key(fab), { rows: [], konto: 0, renke: 0 }).get(key(fab))!;
        g.rows.push({ name, netto: konto, gotowka: renke, razem: num(row?.[c.razem]) });
        g.konto = r2(g.konto + konto);
        g.renke = r2(g.renke + renke);
      }
      if (!byFab.size) continue;
      const factories = await tx.select().from(payrollFactoryMonthsTable).where(and(
        eq(payrollFactoryMonthsTable.periodMonth, month),
        eq(payrollFactoryMonthsTable.region, src.region),
      ));
      for (const f of factories) {
        if (f.firm !== src.firm || f.gotowka != null) continue; // own-tab split wins
        const g = byFab.get(key(f.factory)) ?? (f.tabName ? byFab.get(key(f.tabName)) : undefined);
        if (!g) continue;
        const tabNames = (f.tabName ?? f.factory).split(" + ");
        // update the workbook's worker rows (they assume «all official») with the
        // real na konto / na rękę split; insert rows the workbook doesn't have
        const existing = await tx.select().from(payrollCashRowsTable).where(and(
          eq(payrollCashRowsTable.periodMonth, month),
          eq(payrollCashRowsTable.region, src.region),
          inArray(payrollCashRowsTable.tabName, tabNames),
        ));
        const used = new Set<number>();
        for (const [sortIdx, row] of g.rows.entries()) {
          const rk = key(cleanName(row.name));
          const rt = nameTokens(row.name);
          let m = existing.find(e => !used.has(e.id) && key(cleanName(e.name)) === rk);
          if (!m) m = existing.find(e => {
            if (used.has(e.id)) return false;
            const et = new Set(nameTokens(e.name));
            return rt.filter(tk => et.has(tk)).length >= 2;
          });
          if (m) {
            used.add(m.id);
            // per-worker brutto/netto ratio from the workbook (student = 1) beats the standard one
            const ratio = m.brutto && m.netto ? m.brutto / m.netto : STD_BRUTTO_NETTO_RATIO;
            await tx.update(payrollCashRowsTable).set({
              netto: row.netto, konto: row.netto, gotowka: row.gotowka,
              brutto: r2(row.netto * ratio),
              fullNetto: row.razem ?? m.fullNetto ?? r2(row.netto + row.gotowka),
            }).where(eq(payrollCashRowsTable.id, m.id));
          } else {
            await tx.insert(payrollCashRowsTable).values({
              sourceId: src.id, periodMonth: month, region: src.region, tabName: tabNames[0]!,
              name: row.name, hoursActual: null, hoursDeclared: null,
              brutto: r2(row.netto * STD_BRUTTO_NETTO_RATIO), netto: row.netto, gotowka: row.gotowka,
              fullNetto: row.razem ?? r2(row.netto + row.gotowka), konto: row.netto, sortIdx,
            });
          }
        }
        // recompute the factory aggregates from the merged rows
        const merged = await tx.select().from(payrollCashRowsTable).where(and(
          eq(payrollCashRowsTable.periodMonth, month),
          eq(payrollCashRowsTable.region, src.region),
          inArray(payrollCashRowsTable.tabName, tabNames),
        ));
        const sum = (fn: (x: (typeof merged)[number]) => number | null) => r2(merged.reduce((a, x) => a + (fn(x) ?? 0), 0));
        await tx.update(payrollFactoryMonthsTable).set({
          blockNetto: sum(x => x.konto),
          blockBrutto: sum(x => x.brutto),
          blockTaxedBrutto: sum(x => (x.brutto ?? 0) > (x.netto ?? 0) + 0.01 ? x.brutto : 0),
          gotowka: sum(x => x.gotowka),
        }).where(eq(payrollFactoryMonthsTable.id, f.id));
        months.add(month);
      }
    }
    await tx.update(payrollSourcesTable).set({ lastSyncAt: new Date(), lastError: null }).where(eq(payrollSourcesTable.id, src.id));
  });
  for (const m of months) await feedPnlCogs(m);
}

// keys for storing a manual «bank counterparty = payroll person» confirmation
export function nameMatchKeys(counterparty: string, personName: string) {
  return { bankKey: key(counterparty), personKey: key(cleanName(personName)) };
}

// bounded Levenshtein for fuzzy name tokens (typos like SAVRINOKHON/SARVINOZKHON)
function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}
const fuzzyToken = (a: string, b: string) =>
  a === b || (a.length >= 4 && b.length >= 4 && lev(a, b) <= (Math.min(a.length, b.length) >= 7 ? 2 : 1));
// «INYANGUDO» ↔ «INYANG UDO»: a token may equal two adjacent tokens glued together
export const fuzzyScore = (personTokens: string[], bankTokens: string[]): number => {
  let score = 0;
  for (const pt of personTokens) {
    if (bankTokens.some(bt => fuzzyToken(pt, bt))) { score++; continue; }
    let glued = false;
    for (let i = 0; i < bankTokens.length - 1 && !glued; i++)
      for (let j = i + 1; j < bankTokens.length && !glued; j++)
        if (fuzzyToken(pt, bankTokens[i]! + bankTokens[j]!) || fuzzyToken(pt, bankTokens[j]! + bankTokens[i]!)) glued = true;
    if (glued) score++;
  }
  // and the reverse gluing: person «INYANG UDO» vs bank «INYANGUDO»
  if (score < 2 && personTokens.length >= 2) {
    for (let i = 0; i < personTokens.length - 1; i++)
      for (let j = i + 1; j < personTokens.length; j++)
        if (bankTokens.some(bt => fuzzyToken(personTokens[i]! + personTokens[j]!, bt) || fuzzyToken(personTokens[j]! + personTokens[i]!, bt))) return score + 2;
  }
  return score;
};

// Per-person salary reconciliation: expected bank transfer (konto) per worker
// from the summaries vs actual salary transfers in the payout month. The bank
// counterparty is «NAME + address», so matching is by name tokens (≥2 shared,
// best match wins). The bank account's firm reveals the worker's real firm.
// Office people are reconciled separately (they are deliberately not linked to
// factories), and the leftovers of both sides get a fuzzy second pass whose
// results are shown as suggestions, not facts.
export async function reconcilePeople(month: string, payMonth: string) {
  const rows = await db.select().from(payrollCashRowsTable).where(eq(payrollCashRowsTable.periodMonth, month));
  const fms = await db.select().from(payrollFactoryMonthsTable).where(eq(payrollFactoryMonthsTable.periodMonth, month));
  const tabInfo = new Map<string, { factory: string; firm: string | null; region: string }>();
  for (const fm of fms) for (const t of (fm.tabName ?? "").split(" + ")) if (t) tabInfo.set(t, { factory: fm.factory, firm: fm.firm, region: fm.region });

  const r2 = (n: number) => Math.round(n * 100) / 100;
  interface Person {
    name: string; tokens: string[]; factories: Set<string>; firm: string | null; region: string;
    konto: number; gotowka: number; fullNetto: number; bank: number; bankFirms: Map<string, number>; bankN: number;
    matchKind?: string;
  }
  const people = new Map<string, Person>();
  for (const row of rows) {
    const k = key(cleanName(row.name));
    if (!k) continue;
    const info = tabInfo.get(row.tabName);
    const p = people.get(k) ?? people.set(k, {
      name: cleanName(row.name), tokens: nameTokens(row.name), factories: new Set(), firm: info?.firm ?? null,
      region: info?.region ?? row.region, konto: 0, gotowka: 0, fullNetto: 0, bank: 0, bankFirms: new Map(), bankN: 0,
    }).get(k)!;
    p.factories.add(info?.factory ?? row.tabName);
    p.konto = r2(p.konto + (row.konto ?? 0));
    p.gotowka = r2(p.gotowka + (row.gotowka ?? 0));
    p.fullNetto = r2(p.fullNetto + (row.fullNetto ?? 0));
  }
  const persons = [...people.values()];

  const bankRes: any = await db.execute(sql`
    SELECT t.counterparty, t.amount, coalesce(c.name, '—') AS firm
    FROM bank_transactions t LEFT JOIN companies c ON c.id = t.company_id
    WHERE t.direction = 'out' AND ${sql.raw(T_SALARY)}
      AND to_char(t.value_date, 'YYYY-MM') = ${payMonth}`);
  const bankRows = (bankRes.rows ?? bankRes) as { counterparty: string | null; amount: number; firm: string }[];

  // office people from the OFFICE tabs — reconciled separately
  const officeRows = await db.select().from(payrollOfficeRowsTable).where(eq(payrollOfficeRowsTable.periodMonth, month));
  interface OfficePerson { name: string; tokens: string[]; firm: string; region: string; brutto: number; bank: number; bankFirms: Map<string, number>; bankN: number; matchKind?: string }
  const officeMap = new Map<string, OfficePerson>();
  for (const row of officeRows) {
    const k = key(cleanName(row.name));
    if (!k) continue;
    const p = officeMap.get(k) ?? officeMap.set(k, {
      name: cleanName(row.name), tokens: nameTokens(row.name), firm: row.firm, region: row.region,
      brutto: 0, bank: 0, bankFirms: new Map(), bankN: 0,
    }).get(k)!;
    p.brutto = r2(p.brutto + (row.brutto ?? 0));
  }
  // manually confirmed office people that are not (yet) in any OFFICE tab —
  // they still get a row in the office reconciliation instead of «лише в банку»
  const manualRowsPre = await db.select().from(payrollNameMatchesTable);
  for (const m of manualRowsPre) {
    if (m.kind !== "office" || officeMap.has(m.personKey)) continue;
    officeMap.set(m.personKey, {
      name: cleanName(m.personName ?? m.counterparty ?? "?"), tokens: nameTokens(m.personName ?? ""),
      firm: "(поза сводною)", region: "", brutto: 0, bank: 0, bankFirms: new Map(), bankN: 0,
    });
  }
  const officePersons = [...officeMap.values()];

  // manually confirmed pairs (survive syncs; created from the UI suggestions)
  const manualRows = manualRowsPre;
  const manualByBank = new Map(manualRows.map(m => [m.bankKey, m]));

  const assign = <T extends { bank: number; bankFirms: Map<string, number>; bankN: number; matchKind?: string }>(
    p: T, b: { amount: number; firm: string }, kind: "strict" | "fuzzy" | "manual",
  ) => {
    p.bank = r2(p.bank + b.amount);
    p.bankN++;
    p.bankFirms.set(b.firm, r2((p.bankFirms.get(b.firm) ?? 0) + b.amount));
    const rank = { strict: 2, manual: 3, fuzzy: 1 } as const;
    if (!p.matchKind || rank[kind] > rank[p.matchKind as keyof typeof rank]) p.matchKind = kind;
  };

  // pass 1: manual pairs, then strict token match (workers, then office people)
  const strictAssign = <T extends { tokens: string[]; bank: number; bankFirms: Map<string, number>; bankN: number; matchKind?: string }>(
    candidates: T[], btokens: Set<string>, b: { amount: number; firm: string },
  ): boolean => {
    let best: T | null = null;
    let bestScore = 0;
    let tie = false;
    for (const p of candidates) {
      const score = p.tokens.filter(t => btokens.has(t)).length;
      if (score < Math.min(2, p.tokens.length)) continue;
      if (score > bestScore) { best = p; bestScore = score; tie = false; }
      else if (score === bestScore && best && p !== best) tie = true;
    }
    if (!best || tie) return false;
    assign(best, b, "strict");
    return true;
  };

  const allByKey = new Map<string, Person | OfficePerson>();
  for (const p of persons) allByKey.set(key(cleanName(p.name)), p);
  for (const p of officePersons) if (!allByKey.has(key(cleanName(p.name)))) allByKey.set(key(cleanName(p.name)), p);

  // how the bank's salary money splits per firm: factory workers / office / unrecognized
  const bankSplit = new Map<string, { firm: string; workers: number; office: number; unknown: number }>();
  const bump = (firm: string, cat: "workers" | "office" | "unknown", amt: number) => {
    const g = bankSplit.get(firm) ?? bankSplit.set(firm, { firm, workers: 0, office: 0, unknown: 0 }).get(firm)!;
    g[cat] = r2(g[cat] + amt);
  };

  const leftover: typeof bankRows = [];
  for (const b of bankRows) {
    const manual = manualByBank.get(key(b.counterparty ?? ""));
    const manualPerson = manual ? allByKey.get(manual.personKey) : undefined;
    if (manualPerson) {
      assign(manualPerson, b, "manual");
      bump(b.firm, "konto" in manualPerson ? "workers" : "office", b.amount);
      continue;
    }
    const btokens = new Set(norm(b.counterparty ?? "").split(/[^A-Z]+/).filter(t => t.length > 1));
    if (strictAssign(persons, btokens, b)) { bump(b.firm, "workers", b.amount); continue; }
    if (strictAssign(officePersons, btokens, b)) { bump(b.firm, "office", b.amount); continue; }
    leftover.push(b);
  }

  // pass 2 over the leftovers: fuzzy names + amount evidence.
  // Auto-confirm when the money agrees (≥2 fuzzy tokens & amount close, or ≥1
  // shared token & amount to the grosz); otherwise it's a suggestion for manual
  // confirmation in the UI.
  const suggestByPerson = new Map<Person | OfficePerson, { counterparty: string; firm: string; amount: number }>();
  const bankOnly = new Map<string, { counterparty: string; firm: string; amount: number; n: number; suggest: string | null; suggestKind: string | null }>();
  for (const b of leftover) {
    const btokens = norm(b.counterparty ?? "").split(/[^A-Z]+/).filter(t => t.length > 1);
    const btokenSet = new Set(btokens);
    let best: Person | OfficePerson | null = null;
    let bestScore = 0;
    let tie = false;
    const candidates: (Person | OfficePerson)[] = [
      ...persons.filter(p => p.bankN === 0 && p.konto > 0),
      ...officePersons.filter(p => p.bankN === 0),
    ];
    for (const p of candidates) {
      let score = fuzzyScore(p.tokens, btokens);
      const isWorker = "konto" in p;
      // exact-amount evidence compensates a weak name match (USMONOVA case)
      if (isWorker && score >= 1 && Math.abs((p as Person).konto - b.amount) <= 1) score += 2;
      if (score < 2) continue;
      if (score > bestScore) { best = p; bestScore = score; tie = false; }
      else if (score === bestScore && best && p !== best) tie = true;
    }
    if (best && !tie) {
      const isWorker = "konto" in best;
      const amountClose = isWorker && Math.abs((best as Person).konto - b.amount) <= Math.max(2, (best as Person).konto * 0.005);
      const sharesToken = best.tokens.some(t => btokenSet.has(t));
      if (isWorker && amountClose && (fuzzyScore(best.tokens, btokens) >= 2 || sharesToken)) {
        assign(best, b, "fuzzy"); // stage-2 auto-confirm: гроші сходяться
        bump(b.firm, "workers", b.amount);
        continue;
      }
      const prev = suggestByPerson.get(best);
      suggestByPerson.set(best, { counterparty: b.counterparty ?? "?", firm: b.firm, amount: r2((prev?.amount ?? 0) + b.amount) });
    }
    const ck = norm(b.counterparty ?? "?").slice(0, 40) + "|" + b.firm;
    const g = bankOnly.get(ck) ?? bankOnly.set(ck, { counterparty: b.counterparty ?? "?", firm: b.firm, amount: 0, n: 0, suggest: null, suggestKind: null }).get(ck)!;
    g.amount = r2(g.amount + b.amount);
    g.n++;
    bump(b.firm, "unknown", b.amount);
    if (best && !tie) {
      g.suggest = best.name;
      g.suggestKind = "konto" in best ? "worker" : "office";
    }
  }

  const peopleOut = persons.map(p => ({
    name: p.name, factories: [...p.factories], firm: p.firm, region: p.region,
    konto: p.konto, gotowka: p.gotowka, fullNetto: p.fullNetto,
    bank: p.bank, bankN: p.bankN,
    bankFirm: [...p.bankFirms.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    diff: r2(p.bank - p.konto),
    suggest: suggestByPerson.get(p) ?? null,
    matchKind: p.matchKind ?? null,
    manualId: p.matchKind === "manual" ? manualRows.find(m => m.personKey === key(cleanName(p.name)))?.id ?? null : null,
  })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const officeOut = officePersons.map(p => ({
    name: p.name, firm: p.firm, region: p.region, brutto: p.brutto,
    bank: p.bank, bankN: p.bankN,
    bankFirm: [...p.bankFirms.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    suggest: suggestByPerson.get(p) ?? null,
    matchKind: p.matchKind ?? null,
    manualId: p.matchKind === "manual" ? manualRows.find(m => m.personKey === key(cleanName(p.name)))?.id ?? null : null,
  })).sort((a, b) => b.bank - a.bank || b.brutto - a.brutto);

  // per-factory: which firm's account actually paid its (single-factory) people
  const factSummary = new Map<string, { factory: string; region: string; firmSvod: string | null; byBankFirm: Record<string, number>; matched: number; total: number }>();
  for (const p of persons) {
    if (p.factories.size !== 1) continue;
    const factory = [...p.factories][0]!;
    const fs = factSummary.get(factory) ?? factSummary.set(factory, { factory, region: p.region, firmSvod: p.firm, byBankFirm: {}, matched: 0, total: 0 }).get(factory)!;
    fs.total++;
    if (p.bankN) {
      fs.matched++;
      for (const [f, amt] of p.bankFirms) fs.byBankFirm[f] = r2((fs.byBankFirm[f] ?? 0) + amt);
    }
  }
  const factories = [...factSummary.values()].map(f => ({
    ...f,
    suggested: Object.entries(f.byBankFirm).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  })).sort((a, b) => (b.byBankFirm ? Object.values(b.byBankFirm).reduce((x, y) => x + y, 0) : 0) - (a.byBankFirm ? Object.values(a.byBankFirm).reduce((x, y) => x + y, 0) : 0));

  return {
    people: peopleOut,
    office: officeOut,
    factories,
    bankOnly: [...bankOnly.values()].sort((a, b) => b.amount - a.amount),
    bankSplit: [...bankSplit.values()],
  };
}

// Cost of a factory month: full netto paid out + advances/hostel withheld from
// it (the worker earned them, so they belong to the labor cost) + worker-side
// taxes we remit on the declared part + estimated employer-side ZUS on taxed
// (non-student) brutto. Where a cash block exists the declared amounts come
// from it; otherwise the whole main table is the declared payroll.
export function factoryCost(f: {
  doZaplaty: number | null; mainBrutto: number | null; mainNetto: number | null; mainTaxedBrutto: number | null;
  blockBrutto: number | null; blockNetto: number | null; blockTaxedBrutto: number | null; gotowka: number | null;
  zaliczki: number | null; zaliczkaBd: number | null; hostel: number | null;
}): { netto: number; zaliczki: number; hostel: number; workerTax: number; employerZus: number; total: number } {
  const netto = f.doZaplaty ?? f.mainNetto ?? 0;
  const zaliczki = (f.zaliczki ?? 0) + (f.zaliczkaBd ?? 0); // аванси: зняті з ЗП, але зароблені
  const hostel = f.hostel ?? 0;
  const declaredBrutto = f.blockBrutto != null ? f.blockBrutto : f.mainBrutto;
  const declaredNetto = f.blockBrutto != null ? f.blockNetto : f.mainNetto;
  const taxedBrutto = f.blockBrutto != null ? f.blockTaxedBrutto : f.mainTaxedBrutto;
  const workerTax = Math.max(0, (declaredBrutto ?? 0) - (declaredNetto ?? 0));
  const employerZus = (taxedBrutto ?? 0) * EMPLOYER_ZUS_RATE;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    netto: r2(netto), zaliczki: r2(zaliczki), hostel: r2(hostel), workerTax: r2(workerTax), employerZus: r2(employerZus),
    total: r2(netto + zaliczki + hostel + workerTax + employerZus),
  };
}

// P&L client label per factory: cities/halls of one client merge into one line
// so revenue (one KSeF invoice stream) meets its full cost
const PNL_LABEL_MERGE: Record<string, string> = {
  "EUROCASHBL": "Eurocash", "EUROCASHLB": "Eurocash", "EUROCASHKROSNO": "Eurocash",
  "INPOSTLDZ": "InPost", "INPOSTGD3": "InPost", "INPOSTKRAKOWALLIN": "InPost", "INPOSTPZS": "InPost",
};
const pnlLabelFor = (factory: string) => PNL_LABEL_MERGE[key(factory)] ?? factory;

// Rebuild ALL source='payroll' lines of the month from payroll_factory_months:
// cogs per factory + a revenue line for hostel withholdings (workers pay for
// housing out of their salaries — that's additional income).
export async function feedPnlCogs(periodMonth: string) {
  const rows = await db.select().from(payrollFactoryMonthsTable)
    .where(eq(payrollFactoryMonthsTable.periodMonth, periodMonth));
  const fmt = (n: number) => n.toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await db.transaction(async tx => {
    await tx.delete(pnlEntriesTable).where(and(
      eq(pnlEntriesTable.periodMonth, periodMonth),
      eq(pnlEntriesTable.source, "payroll"),
    ));
    const hostelByRegion = new Map<string, number>();
    for (const f of rows) {
      const cost = factoryCost(f);
      if (cost.hostel) hostelByRegion.set(f.region, Math.round(((hostelByRegion.get(f.region) ?? 0) + cost.hostel) * 100) / 100);
      if (!cost.total) continue;
      await tx.insert(pnlEntriesTable).values({
        periodMonth, section: "cogs", label: pnlLabelFor(f.factory), amount: cost.total, source: "payroll",
        note: `[${f.region}${f.firm ? ` · ${f.firm}` : ""}] ${f.factory}: нетто ${fmt(cost.netto)}${cost.zaliczki ? ` + аванси ${fmt(cost.zaliczki)}` : ""}${cost.hostel ? ` + хостел ${fmt(cost.hostel)}` : ""} + PIT/ZUS ~${fmt(cost.workerTax + cost.employerZus)}`,
      });
    }
    const hostelTotal = [...hostelByRegion.values()].reduce((a, b) => a + b, 0);
    if (hostelTotal > 0) {
      await tx.insert(pnlEntriesTable).values({
        periodMonth, section: "revenue", label: "Хостели (утримання з ЗП)", amount: Math.round(hostelTotal * 100) / 100, source: "payroll",
        note: `утримано з зарплат за житло: ${[...hostelByRegion.entries()].map(([r, v]) => `${r} ${fmt(v)}`).join(" · ")}`,
      });
    }
  });
}
