// Office cash box (сейф) — synced from the "STAN KASY" Google Sheet the office keeps.
// One tab per month+entity ("07.2026 es outsorcing", "05.2026 klinex"): columns are
// ДАТА | ОПИС | ЗНЯТО З КАРТИ (in) | ВИТРАЧЕНО ГОТІВКОЮ (out) | СТАН КАСИ | нотатка,
// with a "STAN KASY NA POCZĄTEK" opening row. The sheet stays the office's entry
// point — we mirror it (wipe & insert per tab), daily + on demand.
import { google } from "googleapis";
import { db } from "@workspace/db";
import { cashEntriesTable, companiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const CASH_SHEET_ID = process.env.CASH_REGISTER_SHEET_ID || "1ymmpTZS9ftgUztb0HzHdKFD6nc9FX_q8UgJDrVe7r-c";

// tab name → { month "YYYY-MM", company name } (entity naming is loose in the sheet)
export function parseTabName(tab: string): { month: string; company: string } | null {
  const m = tab.trim().match(/^(\d{2})\.(\d{4})\s+(.+)$/);
  if (!m) return null;
  const month = `${m[2]}-${m[1]}`;
  const ent = m[3]!.toUpperCase();
  if (ent.includes("KLINEX")) return { month, company: "Klinex" };
  if (ent.includes("OUTSOR") || ent.includes("OUTSOUR")) return { month, company: "ESO" };
  if (ent.includes("EUROSUPPORT") || ent.includes("ES ") || ent === "ES") return { month, company: "ES" };
  return null;
}

const excelDate = (v: unknown): string | null => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 30000 || n > 80000) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export interface CashSyncResult { tabs: number; entries: number; unmatchedTabs: string[] }

export async function syncCashRegister(): Promise<CashSyncResult> {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });

  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable);
  const coId = new Map(companies.map(c => [c.name, c.id]));

  const meta = await sheets.spreadsheets.get({ spreadsheetId: CASH_SHEET_ID });
  const tabs = (meta.data.sheets ?? []).map(s => s.properties?.title ?? "").filter(Boolean);

  const result: CashSyncResult = { tabs: 0, entries: 0, unmatchedTabs: [] };
  for (const tab of tabs) {
    const parsed = parseTabName(tab);
    if (!parsed || !coId.has(parsed.company)) { result.unmatchedTabs.push(tab); continue; }
    const companyId = coId.get(parsed.company)!;

    // only A..F — the side summary block (cols H+) must not be read as entries
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: CASH_SHEET_ID, range: `'${tab}'!A1:F400`, valueRenderOption: "UNFORMATTED_VALUE" });
    const rows = res.data.values ?? [];

    const entries: (typeof cashEntriesTable.$inferInsert)[] = [];
    let sortIdx = 0;
    for (const r of rows) {
      const desc = String(r?.[1] ?? "").trim();
      const inAmt = num(r?.[2]);
      const outAmt = num(r?.[3]);
      const stan = num(r?.[4]);
      const note = String(r?.[5] ?? "").trim() || null;
      const entryDate = excelDate(r?.[0]);
      const isOpening = /STAN KASY NA POCZ/i.test(desc);
      if (isOpening) {
        entries.push({ companyId, periodMonth: parsed.month, entryDate, kind: "opening", amount: inAmt ?? stan ?? 0, description: desc, note, tabName: tab, sortIdx: sortIdx++ });
        continue;
      }
      if (/^(ДАТА|DATA)$/i.test(String(r?.[0] ?? "").trim())) continue; // header
      if (inAmt && inAmt !== 0) entries.push({ companyId, periodMonth: parsed.month, entryDate, kind: "in", amount: inAmt, description: desc || "Знято з карти", note, tabName: tab, sortIdx: sortIdx++ });
      if (outAmt && outAmt !== 0) entries.push({ companyId, periodMonth: parsed.month, entryDate, kind: "out", amount: outAmt, description: desc || null, note, tabName: tab, sortIdx: sortIdx++ });
    }

    // mirror the tab: office keeps editing the sheet, so wipe & reinsert.
    // manual_category is OUR metadata (not sheet content) — carry it over by
    // matching row identity (date+kind+amount+description), first unused match wins
    const old = await db.select().from(cashEntriesTable).where(eq(cashEntriesTable.tabName, tab));
    const catByKey = new Map<string, string[]>();
    const rowKey = (e: { entryDate: string | null; kind: string; amount: number; description: string | null }) =>
      `${e.entryDate ?? ""}|${e.kind}|${e.amount}|${(e.description ?? "").trim()}`;
    for (const o of old) if (o.manualCategory) {
      const k = rowKey(o);
      (catByKey.get(k) ?? catByKey.set(k, []).get(k)!).push(o.manualCategory);
    }
    for (const e of entries) {
      const stack = catByKey.get(rowKey(e as any));
      if (stack?.length) e.manualCategory = stack.shift()!;
    }
    await db.delete(cashEntriesTable).where(eq(cashEntriesTable.tabName, tab));
    if (entries.length) await db.insert(cashEntriesTable).values(entries);
    result.tabs++;
    result.entries += entries.length;
  }
  logger.info({ ...result, unmatched: result.unmatchedTabs.length }, "cash register sync done");
  return result;
}
