// Cost invoices («Фактури») — synced from the three "Faktury Kosztowe" Google Sheets
// (ESG → ES, Outsourcing → ESO, Klinex), one tab per month (MM.YYYY). Columns:
// A marker (PROFORMA/FAKTURA) | B Data | C NR FV | D Kwota | E Status | F Termin
// Płatności | G Wystawca | H Kategoria | I Data Opłaty. The sheets stay the office's
// entry point — we mirror them (wipe & insert per sheet+tab), daily + on demand.
import { google } from "googleapis";
import { db } from "@workspace/db";
import { invoicesTable, companiesTable } from "@workspace/db";
import { eq, isNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isCleaningSupplier } from "./ksef";

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

// «за який місяць» з номера фактури: «1/06/2026», «142/07/2026» (№/MM/YYYY)
// або «2026/08/HOUSE/…» (YYYY/MM/…). Рік — здоровий діапазон, інакше null.
export function guessServiceMonth(number: string | null | undefined): string | null {
  const s = String(number ?? "").trim();
  let m = /^\d{1,4}\/(0[1-9]|1[0-2])\/(20[2-3]\d)\b/.exec(s);
  if (m) return `${m[2]}-${m[1]}`;
  m = /^(20[2-3]\d)\/(0[1-9]|1[0-2])\//.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  return null;
}

export interface InvoiceSyncResult { sheets: number; tabs: number; invoices: number; unpaid: number }

export async function syncInvoices(): Promise<InvoiceSyncResult> {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });

  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable);
  const coId = new Map(companies.map(c => [c.name, c.id]));
  const result: InvoiceSyncResult = { sheets: 0, tabs: 0, invoices: 0, unpaid: 0 };

  // cost-center місто по контрагенту: остання фактура з проставленим містом
  // передає його новим фактурам того ж контрагента (щоб B2B не проставляти щомісяця)
  const cpKey = (s: string | null | undefined) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  const prevCity = new Map<string, string>();
  for (const r of await db.select({ c: invoicesTable.counterparty, city: invoicesTable.city })
    .from(invoicesTable).where(sql`${invoicesTable.city} IS NOT NULL`).orderBy(invoicesTable.id)) {
    if (r.c) prevCity.set(cpKey(r.c), r.city!);
  }

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
      // manual_* overrides + hostel link + позначка прибирання are OUR metadata —
      // carry them over by row identity (invoice number + amount), first unused match wins
      const old = await db.select().from(invoicesTable).where(eq(invoicesTable.tabName, `${src.company}:${tab}`));
      const overrides = new Map<string, { manualStatus: string | null; manualPaidDate: string | null; manualCategory: string | null; hostelId: number | null; vehicleId: number | null; city: string | null; serviceMonth: string | null; cleaning: boolean; cleaningProjectId: number | null }[]>();
      const rowKey = (e: { number: string | null; amount: number }) => `${(e.number ?? "").trim()}|${e.amount}`;
      for (const o of old) if (o.manualStatus || o.manualPaidDate || o.manualCategory || o.hostelId || o.vehicleId || o.city || o.serviceMonth || o.cleaning || o.cleaningProjectId) {
        const k = rowKey(o);
        (overrides.get(k) ?? overrides.set(k, []).get(k)!).push({ manualStatus: o.manualStatus, manualPaidDate: o.manualPaidDate, manualCategory: o.manualCategory, hostelId: o.hostelId, vehicleId: o.vehicleId, city: o.city, serviceMonth: o.serviceMonth, cleaning: o.cleaning, cleaningProjectId: o.cleaningProjectId });
      }
      for (const e of entries) {
        const stack = overrides.get(rowKey(e as any));
        if (stack?.length) Object.assign(e, stack.shift()!);
        // постачальники прибирання (PELIA Nepelak, FloRyś) — завжди cleaning, і після ресинку
        if (isCleaningSupplier(e.counterparty)) e.cleaning = true;
        // cost-center місто успадковується: нова фактура контрагента бере місто
        // з його попередніх фактур (B2B: Androshchuk→Люблін, Simonian→Лодзь+Познань…)
        if (!(e as any).city) {
          const c = prevCity.get(cpKey(e.counterparty));
          if (c) (e as any).city = c;
        }
        // «за який місяць» — авто з номера фактури (ручне значення живе в carry-over)
        if (!(e as any).serviceMonth) (e as any).serviceMonth = guessServiceMonth((e as any).number);
      }
      await db.delete(invoicesTable).where(eq(invoicesTable.tabName, `${src.company}:${tab}`));
      if (entries.length) await db.insert(invoicesTable).values(entries);
      result.tabs++;
      result.invoices += entries.length;
      result.unpaid += entries.filter(e => e.unpaid).length;
    }
  }
  const attached = await autoAttachLeaseInvoices();
  if (attached) logger.info({ attached }, "lease invoices auto-attached");
  logger.info(result, "invoices sync done");
  return result;
}

// Авто-привʼязка лізингових фактур до авто за правилом власника: контрагент
// фактури ~ lease_lessor авто; якщо кілька авто ділять лізингодавця — розрізняє
// lease_contract_no (токен у номері/нотатці фактури), інакше НЕ вгадуємо.
export async function autoAttachLeaseInvoices(): Promise<number> {
  const { vehiclesTable } = await import("@workspace/db");
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/s\.?a\.?$/i, "").replace(/[^a-z0-9а-яіїєґ]+/gi, "");
  const vehicles = (await db.select().from(vehiclesTable)).filter(v => v.leaseLessor);
  if (!vehicles.length) return 0;
  const unattached = await db.select().from(invoicesTable).where(isNull(invoicesTable.vehicleId));
  let attached = 0;
  for (const inv of unattached) {
    const cp = norm(inv.counterparty);
    if (!cp) continue;
    const byLessor = vehicles.filter(v => {
      const l = norm(v.leaseLessor);
      return l && (cp.includes(l) || l.includes(cp));
    });
    if (!byLessor.length) continue;
    let winner = byLessor.length === 1 ? byLessor[0]! : undefined;
    if (!winner) {
      const hay = `${inv.number ?? ""} ${inv.note ?? ""} ${inv.category ?? ""}`.toLowerCase();
      const byContract = byLessor.filter(v => v.leaseContractNo && hay.includes(v.leaseContractNo.toLowerCase()));
      if (byContract.length === 1) winner = byContract[0]!;
    }
    if (!winner) continue; // неоднозначно — лишаємо на ручну привʼязку
    await db.update(invoicesTable).set({ vehicleId: winner.id }).where(eq(invoicesTable.id, inv.id));
    attached++;
  }
  return attached;
}
