// Аналітика («Аналітика», /analytics) — багатомісячні тренди поверх pnl_entries:
// динаміка дохід/собівартість/маржа по сегментах, години з payroll_factory_months
// (маржа на годину), рентабельність клієнтів за період. Місячний зріз і звірки —
// на /cfo; тут — серії. Owner-only (viewFinance), як увесь фінблок.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";

const router: IRouter = Router();
router.use(authRequired);
router.use("/analytics", requireCap("viewFinance")); // скоуп по префіксу

const rowsOf = (r: any): any[] => r?.rows ?? r ?? [];
const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? r2((part / whole) * 100) : null);

type SegmentSum = { revenue: number; cogs: number; margin: number; marginPct: number | null };
const seg = (): SegmentSum => ({ revenue: 0, cogs: 0, margin: 0, marginPct: null });
const closeSeg = (s: SegmentSum) => {
  s.margin = r2(s.revenue - s.cogs);
  s.marginPct = pct(s.margin, s.revenue);
};

router.get("/analytics", async (req, res) => {
  const months = Math.min(24, Math.max(3, Number(req.query.months) || 12));

  // Місяці з даними P&L (останні N, у висхідному порядку — під графіки)
  const monthRows = rowsOf(await db.execute(sql`
    SELECT DISTINCT period_month AS m FROM pnl_entries ORDER BY 1 DESC LIMIT ${months}`));
  const monthList = monthRows.map((x: any) => String(x.m)).sort();
  if (!monthList.length) return res.json({ months: [], series: [], clients: [] });
  const from = monthList[0]!;

  const [pnlRows, hourRows] = await Promise.all([
    db.execute(sql`
      SELECT period_month AS m, section, coalesce(segment, 'main') AS segment, label,
             coalesce(sum(amount), 0) AS total
      FROM pnl_entries
      WHERE period_month >= ${from}
      GROUP BY 1, 2, 3, 4`),
    db.execute(sql`
      SELECT period_month AS m, coalesce(sum(hours), 0) AS hours
      FROM payroll_factory_months
      WHERE period_month >= ${from}
      GROUP BY 1`),
  ]);

  const hoursByMonth = new Map<string, number>();
  for (const r of rowsOf(hourRows)) hoursByMonth.set(String(r.m), r2(Number(r.hours)));

  // ── Серії по місяцях ────────────────────────────────────────────────────────
  type MonthAgg = { main: SegmentSum; cleaning: SegmentSum; total: SegmentSum; fixed: number };
  const byMonth = new Map<string, MonthAgg>();
  for (const m of monthList) byMonth.set(m, { main: seg(), cleaning: seg(), total: seg(), fixed: 0 });

  // ── Клієнти (revenue/cogs по label) ─────────────────────────────────────────
  type Client = {
    label: string; segment: string;
    total: SegmentSum;
    monthly: Record<string, { revenue: number; cogs: number; margin: number }>;
  };
  const clients = new Map<string, Client>();

  for (const r of rowsOf(pnlRows)) {
    const m = String(r.m);
    const agg = byMonth.get(m);
    if (!agg) continue;
    const amount = Number(r.total);
    const section = String(r.section);
    if (section === "fixed") { agg.fixed = r2(agg.fixed + amount); continue; }
    if (section !== "revenue" && section !== "cogs") continue;

    const segment = r.segment === "cleaning" ? "cleaning" : "main";
    const bucket = segment === "cleaning" ? agg.cleaning : agg.main;
    if (section === "revenue") { bucket.revenue = r2(bucket.revenue + amount); agg.total.revenue = r2(agg.total.revenue + amount); }
    else { bucket.cogs = r2(bucket.cogs + amount); agg.total.cogs = r2(agg.total.cogs + amount); }

    const label = String(r.label);
    const c = clients.get(label) ?? clients.set(label, { label, segment, total: seg(), monthly: {} }).get(label)!;
    if (segment === "cleaning") c.segment = "cleaning"; // label живе в одному сегменті; cleaning-мітка пріоритетна
    const cm = c.monthly[m] ?? (c.monthly[m] = { revenue: 0, cogs: 0, margin: 0 });
    if (section === "revenue") { cm.revenue = r2(cm.revenue + amount); c.total.revenue = r2(c.total.revenue + amount); }
    else { cm.cogs = r2(cm.cogs + amount); c.total.cogs = r2(c.total.cogs + amount); }
  }

  const series = monthList.map(m => {
    const a = byMonth.get(m)!;
    closeSeg(a.main); closeSeg(a.cleaning); closeSeg(a.total);
    const hours = hoursByMonth.get(m) ?? 0;
    return {
      month: m,
      main: a.main, cleaning: a.cleaning, total: a.total,
      fixed: a.fixed,
      profit: r2(a.total.margin - a.fixed),
      hours: hours > 0 ? hours : null,
      // години ведуться по основному бізнесу (payroll) → ділимо маржу main
      marginPerHour: hours > 0 ? r2(a.main.margin / hours) : null,
      revenuePerHour: hours > 0 ? r2(a.main.revenue / hours) : null,
    };
  });

  const clientList = [...clients.values()].map(c => {
    for (const m of Object.keys(c.monthly)) c.monthly[m]!.margin = r2(c.monthly[m]!.revenue - c.monthly[m]!.cogs);
    closeSeg(c.total);
    const activeMonths = Object.keys(c.monthly).filter(m => c.monthly[m]!.revenue > 0).sort();
    return { ...c, activeMonths, lastMonth: activeMonths[activeMonths.length - 1] ?? null };
  }).sort((a, b) => b.total.revenue - a.total.revenue);

  return res.json({ months: monthList, series, clients: clientList });
});

export default router;
