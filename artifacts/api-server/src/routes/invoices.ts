// Cost invoices («Фактури», /invoices) — mirror of the Faktury Kosztowe sheets
// plus manual rows added in the panel. Sheet rows stay content-read-only, but the
// paid status and category can be overridden here (manual_* fields survive the
// re-sync). Unpaid invoices (effective status) feed the net position on /balance.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { invoicesTable, companiesTable } from "@workspace/db";
import { and, eq, desc, asc, ilike, or, sql, type SQL } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";
import { syncInvoices } from "../services/invoices";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(authRequired);
router.use(requireCap("viewFinance"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const round2 = (n: number) => Math.round(n * 100) / 100;
const validDate = (d: any) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const MANUAL = "manual";

// effective values: panel override wins over the sheet mirror
const EFF_UNPAID = sql<boolean>`CASE WHEN ${invoicesTable.manualStatus} IS NOT NULL THEN ${invoicesTable.manualStatus} = 'unpaid' ELSE ${invoicesTable.unpaid} END`;
const effRow = (r: typeof invoicesTable.$inferSelect) => ({
  ...r,
  effUnpaid: r.manualStatus != null ? r.manualStatus === "unpaid" : r.unpaid,
  effPaidDate: r.manualPaidDate ?? r.paidDate,
  effCategory: (r.manualCategory ?? r.category ?? "").trim() || "Inne",
  editable: r.tabName === MANUAL,
});

// unpaid total as of a date (effective status) — feeds /balance and /cashflow
export async function unpaidInvoicesAt(asOf: string): Promise<{ total: number; count: number }> {
  const r: any = await db.execute(sql`
    SELECT coalesce(sum(amount), 0) AS s, count(*) AS n FROM invoices
    WHERE coalesce(issue_date::text, period_month || '-01') <= ${asOf}
      AND (
        (CASE WHEN manual_status IS NOT NULL THEN manual_status = 'unpaid' ELSE unpaid END)
        OR (coalesce(manual_paid_date, paid_date) IS NOT NULL AND coalesce(manual_paid_date, paid_date)::text > ${asOf})
      )`);
  const row = (r?.rows ?? r)[0] ?? {};
  return { total: round2(Number(row.s ?? 0)), count: Number(row.n ?? 0) };
}

router.get("/invoices", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;
  const status = req.query.status === "unpaid" ? "unpaid" : req.query.status === "paid" ? "paid" : null;
  const cat = String(req.query.cat ?? "").trim();
  const q = String(req.query.q ?? "").trim();

  const base: SQL[] = [
    sql`${invoicesTable.periodMonth} >= ${month ? `${year}-${month}` : `${year}-01`}`,
    sql`${invoicesTable.periodMonth} <= ${month ? `${year}-${month}` : `${year}-12`}`,
  ];
  if (companyId) base.push(sql`${invoicesTable.companyId} = ${companyId}`);
  if (q) base.push(or(ilike(invoicesTable.counterparty, `%${q}%`), ilike(invoicesTable.number, `%${q}%`), ilike(invoicesTable.category, `%${q}%`))! as SQL);

  const conds = [...base];
  if (status === "unpaid") conds.push(sql`${EFF_UNPAID}`);
  if (status === "paid") conds.push(sql`NOT ${EFF_UNPAID}`);
  if (cat) conds.push(sql`coalesce(nullif(trim(coalesce(${invoicesTable.manualCategory}, ${invoicesTable.category})), ''), 'Inne') = ${cat}`);

  const rows = await db.select().from(invoicesTable).where(and(...conds))
    .orderBy(desc(invoicesTable.periodMonth), desc(invoicesTable.issueDate), asc(invoicesTable.sortIdx)).limit(1000);
  const mapped = rows.map(r => ({ ...effRow(r), cashPaid: /got.wk/i.test(r.statusRaw ?? "") }));
  let total = 0, unpaidTotal = 0, unpaidCount = 0;
  for (const r of mapped) { total += r.amount; if (r.effUnpaid) { unpaidTotal += r.amount; unpaidCount++; } }

  // category summary over the same period/firm/search (status & category filters not applied)
  const catRows: any = await db.execute(sql`
    SELECT coalesce(nullif(trim(coalesce(manual_category, category)), ''), 'Inne') AS cat,
           coalesce(sum(amount), 0) AS total, count(*) AS n,
           coalesce(sum(amount) FILTER (WHERE CASE WHEN manual_status IS NOT NULL THEN manual_status = 'unpaid' ELSE unpaid END), 0) AS unpaid,
           count(*) FILTER (WHERE CASE WHEN manual_status IS NOT NULL THEN manual_status = 'unpaid' ELSE unpaid END) AS unpaid_n
    FROM invoices
    WHERE ${and(...base)}
    GROUP BY 1 ORDER BY 2 DESC`);

  ok(res, {
    year, month: month ?? null, companyId, status, cat: cat || null, rows: mapped,
    totals: { total: round2(total), count: mapped.length, unpaid: round2(unpaidTotal), unpaidCount },
    categories: ((catRows.rows ?? catRows) as any[]).map((r: any) => ({
      category: String(r.cat), total: round2(Number(r.total)), n: Number(r.n),
      unpaid: round2(Number(r.unpaid)), unpaidCount: Number(r.unpaid_n),
    })),
  });
});

router.get("/invoices/meta", async (_req, res) => {
  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.isActive, true));
  const years: any = await db.execute(sql`SELECT DISTINCT left(period_month, 4) AS y FROM invoices ORDER BY 1 DESC`);
  const cats: any = await db.execute(sql`SELECT DISTINCT coalesce(nullif(trim(coalesce(manual_category, category)), ''), 'Inne') AS c FROM invoices ORDER BY 1`);
  ok(res, {
    companies: companies.filter(c => ["ES", "ESO", "Klinex"].includes(c.name)),
    years: ((years.rows ?? years) as any[]).map((r: any) => String(r.y)),
    categories: ((cats.rows ?? cats) as any[]).map((r: any) => String(r.c)),
  });
});

// add a manual invoice (panel-owned row, survives sheet syncs)
router.post("/invoices", async (req, res) => {
  const { companyId, issueDate, number, amount, counterparty, category, dueDate, paid, paidDate } = req.body ?? {};
  if (!companyId) return fail(res, 400, "companyId required");
  if (!validDate(issueDate)) return fail(res, 400, "issueDate must be YYYY-MM-DD");
  if (!number || !String(number).trim()) return fail(res, 400, "number required");
  const amt = Number(String(amount ?? "").replace(",", "."));
  if (!Number.isFinite(amt) || amt <= 0) return fail(res, 400, "amount must be > 0");
  const [co] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, Number(companyId)));
  if (!co) return fail(res, 400, "unknown company");
  const [row] = await db.insert(invoicesTable).values({
    companyId: Number(companyId), periodMonth: String(issueDate).slice(0, 7),
    issueDate: String(issueDate), number: String(number).trim(), amount: amt,
    statusRaw: paid ? "Opłacona (панель)" : "Nie oplacona", unpaid: !paid,
    dueDate: dueDate && validDate(dueDate) ? dueDate : null,
    counterparty: counterparty ? String(counterparty).trim() : null,
    category: category ? String(category).trim() : null,
    paidDate: paid && paidDate && validDate(paidDate) ? paidDate : (paid ? new Date().toISOString().slice(0, 10) : null),
    tabName: MANUAL, sortIdx: Math.floor(Date.now() / 1000),
  }).returning();
  ok(res, effRow(row!));
});

// edit: manual rows — everything; sheet rows — paid status / paid date / category (overrides)
router.patch("/invoices/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  const isManual = row.tabName === MANUAL;

  if (b.paid !== undefined) {
    const paid = !!b.paid;
    if (isManual) {
      patch.unpaid = !paid;
      patch.statusRaw = paid ? "Opłacona (панель)" : "Nie oplacona";
      patch.paidDate = paid ? (validDate(b.paidDate) ? b.paidDate : new Date().toISOString().slice(0, 10)) : null;
    } else {
      // override matches the sheet again → drop it (sheet stays the source)
      if (paid === !row.unpaid) { patch.manualStatus = null; patch.manualPaidDate = null; }
      else {
        patch.manualStatus = paid ? "paid" : "unpaid";
        patch.manualPaidDate = paid ? (validDate(b.paidDate) ? b.paidDate : new Date().toISOString().slice(0, 10)) : null;
      }
    }
  } else if (b.paidDate !== undefined) {
    if (b.paidDate && !validDate(b.paidDate)) return fail(res, 400, "bad paidDate");
    if (isManual) patch.paidDate = b.paidDate || null; else patch.manualPaidDate = b.paidDate || null;
  }
  if (b.category !== undefined) {
    const cat = b.category ? String(b.category).trim() : null;
    if (isManual) patch.category = cat;
    else patch.manualCategory = cat && cat !== (row.category ?? "").trim() ? cat : null;
  }
  if (isManual) {
    if (b.issueDate !== undefined) { if (!validDate(b.issueDate)) return fail(res, 400, "bad issueDate"); patch.issueDate = b.issueDate; patch.periodMonth = String(b.issueDate).slice(0, 7); }
    if (b.number !== undefined) { if (!String(b.number).trim()) return fail(res, 400, "number required"); patch.number = String(b.number).trim(); }
    if (b.amount !== undefined) {
      const amt = Number(String(b.amount).replace(",", "."));
      if (!Number.isFinite(amt) || amt <= 0) return fail(res, 400, "amount must be > 0");
      patch.amount = amt;
    }
    if (b.counterparty !== undefined) patch.counterparty = b.counterparty ? String(b.counterparty).trim() : null;
    if (b.dueDate !== undefined) { if (b.dueDate && !validDate(b.dueDate)) return fail(res, 400, "bad dueDate"); patch.dueDate = b.dueDate || null; }
    if (b.companyId !== undefined) patch.companyId = b.companyId ? Number(b.companyId) : null;
  }
  if (!Object.keys(patch).length) return fail(res, 400, "nothing to update");
  const [updated] = await db.update(invoicesTable).set(patch).where(eq(invoicesTable.id, id)).returning();
  ok(res, effRow(updated!));
});

router.delete("/invoices/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (row.tabName !== MANUAL) return fail(res, 400, "фактури з таблиці — лише для читання (видаліть у Google Sheet)");
  await db.delete(invoicesTable).where(eq(invoicesTable.id, id));
  ok(res, { ok: true });
});

router.post("/invoices/sync", async (_req, res) => {
  try {
    const result = await syncInvoices();
    ok(res, result);
  } catch (e) {
    logger.error({ err: String(e) }, "invoices sync failed");
    res.status(500).json({ error: String(e) });
  }
});

export default router;
