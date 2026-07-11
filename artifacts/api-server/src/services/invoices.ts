// Cost invoices («Фактури») — synced from the three "Faktury Kosztowe" Google Sheets
// (ESG → ES, Outsourcing → ESO, Klinex), one tab per month (MM.YYYY). Columns:
// A marker (PROFORMA/FAKTURA) | B Data | C NR FV | D Kwota | E Status | F Termin
// Płatności | G Wystawca | H Kategoria | I Data Opłaty. The sheets stay the office's
// entry point — we mirror them (wipe & insert per sheet+tab), daily + on demand.
import { google } from "googleapis";
import { db } from "@workspace/db";
import { invoicesTable, companiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const INVOICE_SHEETS: { sheetId: string; company: string }[] = [
  { sheetId: process.env.INVOICES_ES_SHEET_ID || "1DNCJioxjJzNH0cUbAmzjoQJ6lHhcQcO_IoB06zmFkXU", company: "ES" },
  { sheetId: process.env.INVOICES_ESO_SHEET_ID || "1aWJ0yZmPUEye6O-Xs6yN1CN2JONkTonr8NOxRhxVMZk", company: "ESO" },
  { sheetId: process.env.INVOICES_KLINEX_SHEET_ID || "1Z-a8mtNZLvGD9kmNKJC3nh_pVMVuVQga7SD0YhyZLSk", company: "Klinex" },
];

const parseMonthTab = (tab: string): string | null => {
  const m = tab.trim().match(/^(\d{2})\.(\d{4})$/);
  return m ? `${m[2]}-${m[1]}` : null;
};

// dates come either as "dd.mm.yyyy" strings or as sheet serial numbers
const toIso = (v: unknown): string | null => {
  if (typeof v === "number" && v > 30000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const m = String(v ?? "").trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : null;
};
const toAmount = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n !== 0 ? n : null;
};

export interface InvoiceSyncResult { sheets: number; tabs: number; invoices: number; unpaid: number }

export async function syncInvoices(): Promise<InvoiceSyncResult> {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });

  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable);
  const coId = new Map(companies.map(c => [c.name, c.id]));
  const result: InvoiceSyncResult = { sheets: 0, tabs: 0, invoices: 0, unpaid: 0 };

  for (const src of INVOICE_SHEETS) {
    const companyId = coId.get(src.company);
    if (!companyId) continue;
    let meta;
    try {
      meta = await sheets.spreadsheets.get({ spreadsheetId: src.sheetId });
    } catch (e) {
      logger.warn({ company: src.company, err: String(e) }, "invoices sheet unavailable");
      continue;
    }
    result.sheets++;
    for (const s of meta.data.sheets ?? []) {
      const tab = s.properties?.title ?? "";
      const month = parseMonthTab(tab);
      if (!month) continue;

      const res = await sheets.spreadsheets.values.get({ spreadsheetId: src.sheetId, range: `'${tab}'!A1:I500`, valueRenderOption: "UNFORMATTED_VALUE" });
      const rows = res.data.values ?? [];
      const entries: (typeof invoicesTable.$inferInsert)[] = [];
      let sortIdx = 0;
      for (const r of rows) {
        const amount = toAmount(r?.[3]);
        const number = String(r?.[2] ?? "").trim();
        if (amount == null || !number) continue; // header / empty / summary rows
        const statusRaw = String(r?.[4] ?? "").trim() || null;
        entries.push({
          companyId, periodMonth: month,
          docType: String(r?.[0] ?? "").trim() || null,
          issueDate: toIso(r?.[1]), number, amount,
          statusRaw, unpaid: /nie\s*op/i.test(statusRaw ?? ""),
          dueDate: toIso(r?.[5]),
          counterparty: String(r?.[6] ?? "").trim() || null,
          category: String(r?.[7] ?? "").trim() || null,
          paidDate: toIso(r?.[8]),
          tabName: `${src.company}:${tab}`, sortIdx: sortIdx++,
        });
      }
      // mirror the tab: the office keeps editing the sheet, so wipe & reinsert.
      // manual_* overrides are OUR metadata — carry them over by row identity
      // (invoice number + amount), first unused match wins
      const old = await db.select().from(invoicesTable).where(eq(invoicesTable.tabName, `${src.company}:${tab}`));
      const overrides = new Map<string, { manualStatus: string | null; manualPaidDate: string | null; manualCategory: string | null }[]>();
      const rowKey = (e: { number: string | null; amount: number }) => `${(e.number ?? "").trim()}|${e.amount}`;
      for (const o of old) if (o.manualStatus || o.manualPaidDate || o.manualCategory) {
        const k = rowKey(o);
        (overrides.get(k) ?? overrides.set(k, []).get(k)!).push({ manualStatus: o.manualStatus, manualPaidDate: o.manualPaidDate, manualCategory: o.manualCategory });
      }
      for (const e of entries) {
        const stack = overrides.get(rowKey(e as any));
        if (stack?.length) Object.assign(e, stack.shift()!);
      }
      await db.delete(invoicesTable).where(eq(invoicesTable.tabName, `${src.company}:${tab}`));
      if (entries.length) await db.insert(invoicesTable).values(entries);
      result.tabs++;
      result.invoices += entries.length;
      result.unpaid += entries.filter(e => e.unpaid).length;
    }
  }
  logger.info(result, "invoices sync done");
  return result;
}
