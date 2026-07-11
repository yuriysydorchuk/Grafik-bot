// «KSeF» (/ksef) — sales invoices mirrored from KSeF: list per revenue month,
// totals per client, payment status (strict bank match + manual override).
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { ksefInvoicesTable, companiesTable } from "@workspace/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";
import { syncKsef, matchKsefPayments, feedPnlRevenue } from "../services/ksef";

const router: IRouter = Router();
router.use(authRequired);
router.use(requireCap("viewFinance"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const r2 = (n: number) => Math.round(n * 100) / 100;
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const validDate = (s: any) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

router.get("/ksef/months", async (_req, res) => {
  const r: any = await db.execute(sql`SELECT DISTINCT revenue_month AS m FROM ksef_invoices ORDER BY 1 DESC`);
  ok(res, { months: ((r.rows ?? r) as any[]).map(x => String(x.m)) });
});

router.get("/ksef", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const companyId = Number(req.query.companyId) || null;

  const where = companyId
    ? and(eq(ksefInvoicesTable.revenueMonth, month), eq(ksefInvoicesTable.companyId, companyId))
    : eq(ksefInvoicesTable.revenueMonth, month);
  const rows = await db.select().from(ksefInvoicesTable).where(where)
    .orderBy(asc(ksefInvoicesTable.companyId), desc(ksefInvoicesTable.issueDate), asc(ksefInvoicesTable.invoiceNumber));
  const companies = new Map((await db.select().from(companiesTable)).map(c => [c.id, c.name]));

  const invoices = rows.map(inv => {
    // manual override wins; otherwise the bank match decides
    const paid = inv.manualStatus ? inv.manualStatus === "paid" : inv.paidDate != null;
    const paidDate = inv.manualStatus === "paid" ? inv.manualPaidDate ?? inv.paidDate : inv.manualStatus ? null : inv.paidDate;
    return { ...inv, firm: companies.get(inv.companyId) ?? "?", paid, effPaidDate: paidDate, paidSource: inv.manualStatus ? "manual" : inv.paidDate ? "bank" : null };
  });

  const byClient = new Map<string, { client: string; count: number; net: number; gross: number; unpaidGross: number }>();
  for (const inv of invoices) {
    const label = inv.clientLabel ?? inv.buyerName ?? "—";
    const g = byClient.get(label) ?? byClient.set(label, { client: label, count: 0, net: 0, gross: 0, unpaidGross: 0 }).get(label)!;
    g.count++;
    g.net = r2(g.net + inv.net);
    g.gross = r2(g.gross + inv.gross);
    if (!inv.paid) g.unpaidGross = r2(g.unpaidGross + inv.gross);
  }
  const totals = {
    count: invoices.length,
    net: r2(invoices.reduce((a, i) => a + i.net, 0)),
    vat: r2(invoices.reduce((a, i) => a + i.vat, 0)),
    gross: r2(invoices.reduce((a, i) => a + i.gross, 0)),
    paidGross: r2(invoices.filter(i => i.paid).reduce((a, i) => a + i.gross, 0)),
    unpaidGross: r2(invoices.filter(i => !i.paid).reduce((a, i) => a + i.gross, 0)),
  };
  ok(res, {
    month, invoices,
    byClient: [...byClient.values()].sort((a, b) => b.net - a.net),
    totals,
    firms: [...new Set(invoices.map(i => i.firm))].sort(),
  });
});

// manual paid/unpaid override (auto state comes from the bank match)
router.patch("/ksef/invoices/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [inv] = await db.select().from(ksefInvoicesTable).where(eq(ksefInvoicesTable.id, id));
  if (!inv) return fail(res, 404, "not found");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.paid !== undefined) {
    const autoPaid = inv.paidDate != null;
    if (Boolean(b.paid) === autoPaid) { patch.manualStatus = null; patch.manualPaidDate = null; } // back to auto
    else { patch.manualStatus = b.paid ? "paid" : "unpaid"; patch.manualPaidDate = b.paid && validDate(b.paidDate) ? b.paidDate : null; }
  } else if (b.paidDate !== undefined) {
    if (b.paidDate !== null && !validDate(b.paidDate)) return fail(res, 400, "bad paidDate");
    patch.manualPaidDate = b.paidDate;
  }
  if (!Object.keys(patch).length) return fail(res, 400, "nothing to update");
  const [updated] = await db.update(ksefInvoicesTable).set(patch).where(eq(ksefInvoicesTable.id, id)).returning();
  ok(res, updated);
});

router.post("/ksef/sync", async (_req, res) => {
  ok(res, await syncKsef());
});

router.post("/ksef/rematch", async (_req, res) => {
  const matched = await matchKsefPayments();
  ok(res, { matched });
});

export default router;
