// «Зарплати» (/payroll) — mirrored monthly payroll summaries per region:
// per-factory aggregates with the declared-vs-cash split and cost estimate,
// office payroll rows (separate, linked to nothing), and the source registry
// (owner pastes a spreadsheet link per month/region; month+region come from
// the workbook title). Cash payouts are cross-checked against the kasa.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  payrollSourcesTable, payrollFactoryMonthsTable, payrollCashRowsTable,
  payrollOfficeRowsTable, payrollFoldersTable, payrollNameMatchesTable, cashEntriesTable,
} from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { T_SALARY } from "../services/bankClassify";
import { authRequired, requireCap } from "../lib/auth";
import { syncPayrollSummaries, feedPnlCogs, factoryCost, parseWorkbookTitle, reconcilePeople, nameMatchKeys, EMPLOYER_ZUS_RATE } from "../services/payrollSummaries";
import { cashCategory } from "./cash";

const router: IRouter = Router();
router.use(authRequired);
router.use(requireCap("viewFinance"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const r2 = (n: number) => Math.round(n * 100) / 100;
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

router.get("/payroll/months", async (_req, res) => {
  const rows = await db.select({ m: payrollSourcesTable.periodMonth }).from(payrollSourcesTable);
  ok(res, { months: [...new Set(rows.map(x => x.m))].sort().reverse() });
});

router.get("/payroll/sources", async (_req, res) => {
  const rows = await db.select().from(payrollSourcesTable).orderBy(sql`period_month DESC, region`);
  const folders = await db.select().from(payrollFoldersTable).orderBy(payrollFoldersTable.id);
  ok(res, { sources: rows, folders });
});

// register a workbook or a whole Drive folder by link;
// month/region are parsed from workbook titles («05.2026 Люблін Сводна»)
router.post("/payroll/sources", async (req, res) => {
  const url = String(req.body?.url ?? "").trim();

  const folderMatch = url.match(/\/folders\/([a-zA-Z0-9_-]{20,})/);
  if (folderMatch) {
    const folderId = folderMatch[1]!;
    const dup = await db.select().from(payrollFoldersTable).where(eq(payrollFoldersTable.folderId, folderId));
    if (dup.length) return fail(res, 409, "Ця папка вже додана");
    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!), scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
    let title: string | null = null;
    try {
      title = (await google.drive({ version: "v3", auth }).files.get({ fileId: folderId, fields: "name", supportsAllDrives: true })).data.name ?? null;
    } catch {
      return fail(res, 400, "Не вдалося відкрити папку — перевір доступ для сервісного акаунта");
    }
    const [folder] = await db.insert(payrollFoldersTable).values({ folderId, title }).returning();
    const sync = await syncPayrollSummaries(); // scans folders → registers workbooks → syncs
    return ok(res, { folder, sync });
  }

  const m = url.match(/\/d\/([a-zA-Z0-9_-]{20,})/) ?? url.match(/^([a-zA-Z0-9_-]{20,})$/);
  if (!m) return fail(res, 400, "Не схоже на посилання на Google-таблицю чи папку");
  const spreadsheetId = m[1]!;
  const dup = await db.select().from(payrollSourcesTable).where(eq(payrollSourcesTable.spreadsheetId, spreadsheetId));
  if (dup.length) return fail(res, 409, "Ця таблиця вже додана");

  // fetch the title to derive period+region
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  let title = "";
  try {
    const meta = await google.sheets({ version: "v4", auth }).spreadsheets.get({ spreadsheetId });
    title = meta.data.properties?.title ?? "";
  } catch {
    return fail(res, 400, "Не вдалося відкрити таблицю — перевір доступ для сервісного акаунта");
  }
  const parsed = parseWorkbookTitle(title);
  const periodMonth = validMonth(req.body?.periodMonth) ? String(req.body.periodMonth) : parsed?.periodMonth;
  const region = String(req.body?.region ?? "").trim() || parsed?.region;
  if (!periodMonth || !region) return fail(res, 400, `Не зміг визначити місяць/регіон з назви «${title}» — вкажи їх вручну`);

  const [src] = await db.insert(payrollSourcesTable).values({ periodMonth, region, spreadsheetId, title }).returning();
  const sync = await syncPayrollSummaries({ sourceId: src!.id });
  ok(res, { source: src, sync });
});

router.delete("/payroll/sources/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [src] = await db.select().from(payrollSourcesTable).where(eq(payrollSourcesTable.id, id));
  if (!src) return fail(res, 404, "not found");
  await db.transaction(async tx => {
    await tx.delete(payrollCashRowsTable).where(eq(payrollCashRowsTable.sourceId, id));
    await tx.delete(payrollOfficeRowsTable).where(eq(payrollOfficeRowsTable.sourceId, id));
    await tx.delete(payrollFactoryMonthsTable).where(eq(payrollFactoryMonthsTable.sourceId, id));
    await tx.delete(payrollSourcesTable).where(eq(payrollSourcesTable.id, id));
  });
  await feedPnlCogs(src.periodMonth); // rebuilds the month without this source
  ok(res, { ok: true });
});

// stop watching a folder (already-imported months stay)
router.delete("/payroll/folders/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(payrollFoldersTable).where(eq(payrollFoldersTable.id, id));
  ok(res, { ok: true });
});

// «Звірка ЗП»: what the summaries say should go to bank accounts (netto minus
// cash) for month M vs actual salary transfers from the bank in month M+1
// (May salaries are paid out in June).
router.get("/payroll/reconcile", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const [y, mm] = month.split("-").map(Number);
  const payMonth = `${mm === 12 ? y! + 1 : y}-${String(mm === 12 ? 1 : mm! + 1).padStart(2, "0")}`;

  const rows = await db.select().from(payrollFactoryMonthsTable)
    .where(eq(payrollFactoryMonthsTable.periodMonth, month));
  const byFirm = new Map<string, { firm: string; expected: number; noCash: number; noCashFactories: string[]; bank: number; bankWorkers: number; bankOffice: number; bankUnknown: number; bankCount: number }>();
  const get = (firm: string) =>
    byFirm.get(firm) ?? byFirm.set(firm, { firm, expected: 0, noCash: 0, noCashFactories: [], bank: 0, bankWorkers: 0, bankOffice: 0, bankUnknown: 0, bankCount: 0 }).get(firm)!;
  for (const f of rows) {
    if (!f.doZaplaty) continue;
    const g = get(f.firm ?? "—");
    if (f.gotowka != null) {
      g.expected = r2(g.expected + f.doZaplaty - f.gotowka);
    } else {
      // no cash data — counted as fully bank-paid, flagged so the diff is explainable
      g.expected = r2(g.expected + f.doZaplaty);
      g.noCash = r2(g.noCash + f.doZaplaty);
      g.noCashFactories.push(f.factory);
    }
  }

  // actual salary transfers per firm in the payout month, split by whom they
  // went to: factory workers / office / unrecognized (from the per-person pass)
  const perPerson = await reconcilePeople(month, payMonth);
  for (const b of perPerson.bankSplit) {
    const g = get(b.firm);
    g.bankWorkers = b.workers;
    g.bankOffice = b.office;
    g.bankUnknown = b.unknown;
    g.bank = r2(b.workers + b.office + b.unknown);
    g.bankCount = 1; // flag: bank data present
  }

  const firms = [...byFirm.values()]
    // різниця рахується проти фабричної частини — очікування покривають лише сводні фабрик
    .map(g => ({ ...g, diff: r2(g.bankWorkers - g.expected) }))
    .sort((a, b) => b.expected - a.expected);
  const totals = {
    expected: r2(firms.reduce((a, g) => a + g.expected, 0)),
    noCash: r2(firms.reduce((a, g) => a + g.noCash, 0)),
    bankWorkers: r2(firms.reduce((a, g) => a + g.bankWorkers, 0)),
    bankOffice: r2(firms.reduce((a, g) => a + g.bankOffice, 0)),
    bankUnknown: r2(firms.reduce((a, g) => a + g.bankUnknown, 0)),
    bank: r2(firms.reduce((a, g) => a + g.bank, 0)),
    diff: r2(firms.reduce((a, g) => a + g.diff, 0)),
  };
  ok(res, { month, payMonth, firms, totals, ...perPerson });
});

// confirm a fuzzy suggestion: this bank counterparty IS this payroll person
router.post("/payroll/name-match", async (req, res) => {
  const counterparty = String(req.body?.counterparty ?? "").trim();
  const personName = String(req.body?.personName ?? "").trim();
  const kind = req.body?.kind === "office" ? "office" : "worker";
  if (!counterparty || !personName) return fail(res, 400, "counterparty and personName required");
  const { bankKey, personKey } = nameMatchKeys(counterparty, personName);
  if (!bankKey || !personKey) return fail(res, 400, "empty keys after normalization");
  const [row] = await db.insert(payrollNameMatchesTable)
    .values({ bankKey, counterparty, personKey, personName, kind })
    .onConflictDoUpdate({ target: payrollNameMatchesTable.bankKey, set: { counterparty, personKey, personName, kind } })
    .returning();
  ok(res, row);
});

router.delete("/payroll/name-match/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(payrollNameMatchesTable).where(eq(payrollNameMatchesTable.id, id));
  ok(res, { ok: true });
});

router.post("/payroll/sync", async (_req, res) => {
  ok(res, await syncPayrollSummaries());
});

router.get("/payroll", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const region = String(req.query.region ?? "").trim() || null; // місто
  const firm = String(req.query.firm ?? "").trim() || null;

  const allRows = await db.select().from(payrollFactoryMonthsTable)
    .where(eq(payrollFactoryMonthsTable.periodMonth, month));
  const regions = [...new Set(allRows.map(x => x.region))].sort();
  const firms = [...new Set(allRows.map(x => x.firm).filter((f): f is string => !!f))].sort();
  const rows = allRows.filter(x => (!region || x.region === region) && (!firm || x.firm === firm));

  const factories = rows
    .map(f => ({ ...f, cost: factoryCost(f) }))
    .sort((a, b) => (b.doZaplaty ?? 0) - (a.doZaplaty ?? 0));

  const sum = (f: (x: (typeof factories)[number]) => number | null) =>
    r2(factories.reduce((a, x) => a + (f(x) ?? 0), 0));
  const totals = {
    hours: sum(f => f.hours), doZaplaty: sum(f => f.doZaplaty), gotowka: sum(f => f.gotowka),
    blockNetto: sum(f => f.blockNetto), workers: sum(f => f.workers), students: sum(f => f.students),
    cost: sum(f => f.cost.total), zaliczki: sum(f => f.cost.zaliczki), hostel: sum(f => f.cost.hostel),
    workerTax: sum(f => f.cost.workerTax), employerZus: sum(f => f.cost.employerZus),
  };

  // planned ZUS/PIT (within the current filter): worker-side deductions from
  // declared brutto + estimated employer-side ZUS — grouped by firm and by city
  const zusGroup = (labelOf: (f: (typeof factories)[number]) => string) => {
    const map = new Map<string, { firm: string; declaredBrutto: number; workerTax: number; employerZus: number; total: number }>();
    for (const f of factories) {
      const label = labelOf(f);
      const z = map.get(label) ?? map.set(label, { firm: label, declaredBrutto: 0, workerTax: 0, employerZus: 0, total: 0 }).get(label)!;
      const declared = f.blockBrutto != null ? f.blockBrutto : f.mainBrutto;
      z.declaredBrutto = r2(z.declaredBrutto + (declared ?? 0));
      z.workerTax = r2(z.workerTax + f.cost.workerTax);
      z.employerZus = r2(z.employerZus + f.cost.employerZus);
      z.total = r2(z.workerTax + z.employerZus);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  };
  const plannedZus = zusGroup(f => f.firm ?? "—");
  const plannedZusByCity = zusGroup(f => f.region);

  // kasa cross-check: May salaries are paid out in cash in June → compare the
  // summary's gotówka total with kasa «salary» outflows of the NEXT month
  const [y, mm] = month.split("-").map(Number);
  const nextMonth = `${mm === 12 ? y! + 1 : y}-${String(mm === 12 ? 1 : mm! + 1).padStart(2, "0")}`;
  const kasa = { month: nextMonth, salaryOut: 0 };
  const cash = await db.select().from(cashEntriesTable)
    .where(and(eq(cashEntriesTable.periodMonth, nextMonth), eq(cashEntriesTable.kind, "out")));
  for (const e of cash) if (cashCategory(e) === "salary") kasa.salaryOut = r2(kasa.salaryOut + e.amount);

  // worker-level cash rows for drill-down
  const cashWhere = region
    ? and(eq(payrollCashRowsTable.periodMonth, month), eq(payrollCashRowsTable.region, region))
    : eq(payrollCashRowsTable.periodMonth, month);
  const cashRows = await db.select().from(payrollCashRowsTable).where(cashWhere)
    .orderBy(asc(payrollCashRowsTable.tabName), asc(payrollCashRowsTable.sortIdx));

  // office rows, grouped per firm — a standalone mirror
  const offWhere = region
    ? and(eq(payrollOfficeRowsTable.periodMonth, month), eq(payrollOfficeRowsTable.region, region))
    : eq(payrollOfficeRowsTable.periodMonth, month);
  const office = (await db.select().from(payrollOfficeRowsTable).where(offWhere)
    .orderBy(asc(payrollOfficeRowsTable.firm), asc(payrollOfficeRowsTable.sortIdx)))
    .filter(o => !firm || o.firm === firm);

  const sources = await db.select().from(payrollSourcesTable).where(eq(payrollSourcesTable.periodMonth, month));
  const folders = await db.select().from(payrollFoldersTable).orderBy(payrollFoldersTable.id);
  ok(res, { month, regions, firms, factories, totals, plannedZus, plannedZusByCity, kasa, cashRows, office, sources, folders, employerZusRate: EMPLOYER_ZUS_RATE });
});

export default router;
