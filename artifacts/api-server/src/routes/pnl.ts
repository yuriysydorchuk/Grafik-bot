// P&L («P&L», /pnl) — accrual profit & loss for a single month:
// revenue and cost-of-sales per client + fixed costs; net = margin − fixed.
// Lines live in pnl_entries: imported history (source=import, revenue incl. VAT as
// in the owner's workbook), manual entries (VAT/ZUS etc.) and, later, automated
// feeds (KSeF revenue, payroll summaries).
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { pnlEntriesTable } from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";

const router: IRouter = Router();
router.use(authRequired);
router.use(requireCap("viewFinance"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const round2 = (n: number) => Math.round(n * 100) / 100;
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const SECTIONS = new Set(["revenue", "cogs", "fixed"]);

router.get("/pnl/months", async (_req, res) => {
  const r: any = await db.execute(sql`SELECT DISTINCT period_month AS m FROM pnl_entries ORDER BY 1 DESC`);
  ok(res, { months: ((r.rows ?? r) as any[]).map((x: any) => String(x.m)) });
});

router.get("/pnl", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const segment = req.query.segment === "cleaning" ? "cleaning" : "main";
  const rows = (await db.select().from(pnlEntriesTable).where(eq(pnlEntriesTable.periodMonth, month)))
    .filter(r => (r.segment ?? "main") === segment);

  // clients: merge revenue+cogs lines by label. Revenue is netto (без VAT) with
  // gross alongside; cogs is the full labor cost (ЗП брутто + податки).
  // Margin per client = revenue netto − cogs.
  const clients = new Map<string, { label: string; revenue: number; revenueGross: number; cogs: number; revenueIds: number[]; cogsIds: number[] }>();
  const fixed: { id: number; label: string; amount: number; source: string; note: string | null }[] = [];
  for (const r of rows) {
    if (r.section === "fixed") { fixed.push({ id: r.id, label: r.label, amount: r.amount, source: r.source, note: r.note }); continue; }
    const c = clients.get(r.label) ?? clients.set(r.label, { label: r.label, revenue: 0, revenueGross: 0, cogs: 0, revenueIds: [], cogsIds: [] }).get(r.label)!;
    if (r.section === "revenue") {
      c.revenue = round2(c.revenue + r.amount);
      c.revenueGross = round2(c.revenueGross + (r.amountGross ?? r.amount));
      c.revenueIds.push(r.id);
    } else { c.cogs = round2(c.cogs + r.amount); c.cogsIds.push(r.id); }
  }
  const clientRows = [...clients.values()]
    .map(c => ({ ...c, margin: round2(c.revenue - c.cogs), marginPct: c.revenue > 0 ? round2(100 * (c.revenue - c.cogs) / c.revenue) : null }))
    .sort((a, b) => b.revenue - a.revenue);
  const revenue = round2(clientRows.reduce((s, c) => s + c.revenue, 0));
  const revenueGross = round2(clientRows.reduce((s, c) => s + c.revenueGross, 0));
  const cogs = round2(clientRows.reduce((s, c) => s + c.cogs, 0));
  const fixedTotal = round2(fixed.reduce((s, f) => s + f.amount, 0));
  fixed.sort((a, b) => b.amount - a.amount);

  ok(res, {
    month,
    segment,
    clients: clientRows,
    fixed,
    totals: {
      revenue, revenueGross, cogs,
      margin: round2(revenue - cogs),
      marginPct: revenue > 0 ? round2(100 * (revenue - cogs) / revenue) : null,
      fixed: fixedTotal, net: round2(revenue - cogs - fixedTotal),
    },
    imported: rows.some(r => r.source === "import"),
  });
});

router.post("/pnl/entries", async (req, res) => {
  const { periodMonth, section, label, amount, note, segment } = req.body ?? {};
  if (!validMonth(periodMonth)) return fail(res, 400, "periodMonth must be YYYY-MM");
  if (!SECTIONS.has(String(section))) return fail(res, 400, "section must be revenue|cogs|fixed");
  if (!label || !String(label).trim()) return fail(res, 400, "label required");
  const amt = Number(String(amount ?? "").replace(",", "."));
  if (!Number.isFinite(amt)) return fail(res, 400, "amount must be a number");
  const [row] = await db.insert(pnlEntriesTable).values({
    periodMonth, section: String(section), label: String(label).trim(), amount: amt,
    segment: segment === "cleaning" ? "cleaning" : "main",
    note: note ? String(note).trim() : null,
  }).returning();
  ok(res, row);
});

router.patch("/pnl/entries/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(pnlEntriesTable).where(eq(pnlEntriesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.label !== undefined) { if (!String(b.label).trim()) return fail(res, 400, "label required"); patch.label = String(b.label).trim(); }
  if (b.amount !== undefined) {
    const amt = Number(String(b.amount).replace(",", "."));
    if (!Number.isFinite(amt)) return fail(res, 400, "amount must be a number");
    patch.amount = amt;
  }
  if (b.note !== undefined) patch.note = b.note ? String(b.note).trim() : null;
  if (!Object.keys(patch).length) return fail(res, 400, "nothing to update");
  const [updated] = await db.update(pnlEntriesTable).set(patch).where(eq(pnlEntriesTable.id, id)).returning();
  ok(res, updated);
});

router.delete("/pnl/entries/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(pnlEntriesTable).where(eq(pnlEntriesTable.id, id));
  ok(res, { ok: true });
});

export default router;
