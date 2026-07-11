// Bank statements API (owner-only): the raw transaction layer + monthly/yearly cash
// summary. One place defines how transactions are classified (income / expenses / cash),
// used both by the summary metrics and the drill-down lists so they always agree.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { bankTransactionsTable, cashEntriesTable, companiesTable, counterpartyRulesTable } from "@workspace/db";
import { and, eq, gte, lte, lt, or, ilike, asc, desc, count, sql, inArray } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";
import { logger } from "../lib/logger";
import { syncBankTransactions, applyCounterpartyRules } from "../services/bankStatements";
import {
  BUCKET, EXPENSE_CATS, OWNER_KEYS, MC, TXT, OPER, catCondition, periodRange,
  T_INTERNAL, T_VATREF, T_VATMOVE, T_VATSPLIT_OUT, T_CASHDEP,
} from "../services/bankClassify";
import { syncCashRegister, type CashSyncResult } from "../services/cashRegister";

const router: IRouter = Router();
router.use(authRequired);
router.use(requireCap("viewFinance"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-\d{2}$/.test(m);
const rowsOf = (r: any): any[] => r?.rows ?? r ?? [];

// ── Balance at a date ──────────────────────────────────────────────────────────
// Per account: latest statement closing ≤ date PLUS transactions booked after that
// closing up to the date. The supplement matters because some banks close statements
// mid-month (e.g. the 29th) — without it, month-boundary days would be missed.
export async function balanceAt(dateStr: string, companyId: number | null): Promise<number> {
  const co = companyId ? sql`AND company_id = ${companyId}` : sql``;
  const r = await db.execute<{ bal: number }>(sql`
    WITH last_close AS (
      SELECT DISTINCT ON (account) account, closing_date, closing_balance FROM bank_statements
      WHERE closing_date <= ${dateStr} AND closing_balance IS NOT NULL AND ${sql.raw(OPER)} ${co}
      -- a file may hold several statement sections closing on the SAME day
      -- (e.g. 2026/001/2 and /3 both close 27.01) — the later section must win,
      -- otherwise the tie is broken arbitrarily and balances drift by the gap
      ORDER BY account, closing_date DESC, opening_date DESC, statement_no DESC
    )
    SELECT coalesce(sum(
      lc.closing_balance + coalesce((
        SELECT sum(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END)
        FROM bank_transactions t
        WHERE t.account = lc.account AND t.value_date > lc.closing_date AND t.value_date <= ${dateStr}
      ), 0)
    ), 0) AS bal FROM last_close lc`);
  return Number(rowsOf(r)[0]?.bal ?? 0);
}

// ── Period summary (metrics) ──────────────────────────────────────────────────
router.get("/bank/summary", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;
  const [from, to] = periodRange(year, month);
  const coCond = companyId ? sql`AND company_id = ${companyId}` : sql``;

  // one sum+count pair per bucket, built from the single BUCKET definition
  const parts = Object.entries(BUCKET)
    .map(([k, cond]) => `coalesce(sum(amount) FILTER (WHERE ${cond}), 0) AS "${k}", count(*) FILTER (WHERE ${cond}) AS "${k}_n"`)
    .join(", ");
  const agg = await db.execute(sql`
    SELECT ${sql.raw(parts)} FROM bank_transactions
    WHERE value_date >= ${from} AND value_date <= ${to} ${coCond}`);
  const a = rowsOf(agg)[0] ?? {};

  // opening = balance the day before the period; closing = balance at period end
  const prevEnd = new Date(new Date(from + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
  const [opening, closing] = await Promise.all([balanceAt(prevEnd, companyId), balanceAt(to, companyId)]);
  const num = (v: any) => Math.round(Number(v ?? 0) * 100) / 100;

  const buckets: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const k of Object.keys(BUCKET)) { buckets[k] = num(a[k]); counts[k] = Number(a[`${k}_n`] ?? 0); }
  ok(res, {
    year, month: month ?? null, companyId, from, to,
    opening: num(opening), closing: num(closing),
    ...buckets, counts,
  });
});

// ── Reconciliation: full cash equation for the period ─────────────────────────
// opening + income − expenses − salary − cash + cashdep − owners + vat_refund
// ± vat-account moves ± internal(net) = computed closing; residual vs statement
// closing = accounts with missing balance records in the uploaded files.
router.get("/bank/reconcile", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;
  const [from, to] = periodRange(year, month);
  const coCond = companyId ? sql`AND company_id = ${companyId}` : sql``;

  const SIGNED = `CASE WHEN direction='in' THEN amount ELSE -amount END`;
  const groups: Record<string, string> = {
    income: BUCKET.income!, expenses: BUCKET.expenses!,
    cashmove: BUCKET.cashmove!,
    owners: `(${BUCKET.owner_roman!}) OR (${BUCKET.owner_tetiana!}) OR (${BUCKET.owner_yuriy!})`,
    vat_refund: `direction='in' AND NOT (${T_INTERNAL}) AND (${T_VATREF})`,
    vat_moves: `(NOT (${T_INTERNAL}) AND (${TXT} ~ 'PRZEKS' OR (direction='out' AND ${T_VATSPLIT_OUT}) OR (direction='in' AND ${T_VATMOVE} AND NOT (${T_VATREF}) AND NOT (${T_CASHDEP}))))`,
    internal: `(${T_INTERNAL})`,
  };
  const parts = Object.entries(groups).map(([k, cond]) => `coalesce(sum(${SIGNED}) FILTER (WHERE ${cond}), 0) AS "${k}"`).join(", ");
  const agg = await db.execute(sql`
    SELECT ${sql.raw(parts)}, coalesce(sum(${sql.raw(SIGNED)}), 0) AS net_flow
    FROM bank_transactions WHERE ${sql.raw(OPER)} AND value_date >= ${from} AND value_date <= ${to} ${coCond}`);
  const a: any = rowsOf(agg)[0] ?? {};
  const num = (v: any) => Math.round(Number(v ?? 0) * 100) / 100;

  const prevEnd = new Date(new Date(from + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
  const [opening, closing] = await Promise.all([balanceAt(prevEnd, companyId), balanceAt(to, companyId)]);
  const computedClosing = num(opening + Number(a.net_flow ?? 0));
  ok(res, {
    year, month: month ?? null, companyId,
    opening: num(opening), closingStatement: num(closing), computedClosing,
    residual: num(closing - computedClosing),
    parts: Object.fromEntries(Object.keys(groups).map(k => [k, num(a[k])])),
    netFlow: num(a.net_flow),
  });
});

// ── Expense breakdown by category (shown when «Витрати» is clicked) ───────────
router.get("/bank/expense-categories", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;
  const [from, to] = periodRange(year, month);
  const coCond = companyId ? sql`AND company_id = ${companyId}` : sql``;

  const caseExpr = EXPENSE_CATS.map(([k, p]) => `WHEN (${p}) THEN '${k}'`).join(" ");
  const rows = await db.execute(sql`
    SELECT CASE WHEN ${sql.raw(MC)} IS NOT NULL THEN ${sql.raw(MC)} ${sql.raw(caseExpr)} ELSE 'other' END AS cat,
           coalesce(sum(amount), 0) AS total, count(*) AS n
    FROM bank_transactions
    WHERE ${sql.raw(BUCKET.expenses!)} AND value_date >= ${from} AND value_date <= ${to} ${coCond}
    GROUP BY 1 ORDER BY 2 DESC`);
  ok(res, { year, month: month ?? null, companyId, categories: rowsOf(rows).map((r: any) => ({ key: r.cat, total: Math.round(Number(r.total) * 100) / 100, n: Number(r.n) })) });
});

// ── Per-firm breakdown for any bucket/category (e.g. salaries by company) ─────
router.get("/bank/breakdown", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const [from, to] = periodRange(year, month);
  const b = String(req.query.bucket || "");
  const cond = b.startsWith("cat:") ? catCondition(b.slice(4)) : BUCKET[b] ?? null;
  if (!cond) return fail(res, 400, "unknown bucket");
  const rows = await db.execute(sql`
    SELECT company_id, coalesce(sum(amount),0) AS total, count(*) AS n
    FROM bank_transactions
    WHERE ${sql.raw(cond)} AND value_date >= ${from} AND value_date <= ${to}
    GROUP BY company_id ORDER BY 2 DESC`);
  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable);
  ok(res, {
    year, month: month ?? null, bucket: b,
    firms: rowsOf(rows).map((r: any) => ({
      companyId: r.company_id, name: companies.find(c => c.id === r.company_id)?.name ?? "—",
      total: Math.round(Number(r.total) * 100) / 100, n: Number(r.n),
    })),
  });
});

// ── Per-firm opening/closing balances for the period ─────────────────────────
router.get("/bank/balances", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const [from, to] = periodRange(year, month);
  const prevEnd = new Date(new Date(from + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
  const withData = await db.selectDistinct({ companyId: bankTransactionsTable.companyId }).from(bankTransactionsTable);
  const ids = withData.map(r => r.companyId).filter((x): x is number => x != null);
  const companies = ids.length ? await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(inArray(companiesTable.id, ids)).orderBy(companiesTable.id) : [];
  const firms = await Promise.all(companies.map(async c => ({
    companyId: c.id, name: c.name,
    opening: await balanceAt(prevEnd, c.id), closing: await balanceAt(to, c.id),
  })));
  ok(res, { year, month: month ?? null, firms });
});

// ── Transactions list (drill-down / search) ───────────────────────────────────
router.get("/bank/transactions", async (req, res) => {
  const q = req.query;
  const conds: any[] = [];
  if (q.companyId) conds.push(eq(bankTransactionsTable.companyId, Number(q.companyId)));
  if (/^\d{4}$/.test(String(q.year)) && !validMonth(q.month)) {
    const [from, to] = periodRange(String(q.year));
    conds.push(gte(bankTransactionsTable.valueDate, from), lte(bankTransactionsTable.valueDate, to));
  }
  if (validMonth(q.month)) {
    const [y, mo] = String(q.month).split("-").map(Number) as [number, number];
    const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
    conds.push(gte(bankTransactionsTable.valueDate, `${q.month}-01`), lt(bankTransactionsTable.valueDate, next));
  }
  if (typeof q.bucket === "string" && q.bucket.startsWith("cat:")) {
    const cond = catCondition(q.bucket.slice(4));
    if (cond) conds.push(sql.raw(cond));
  } else if (typeof q.bucket === "string" && BUCKET[q.bucket]) conds.push(sql.raw(BUCKET[q.bucket]!));
  else if (q.direction === "in" || q.direction === "out") conds.push(eq(bankTransactionsTable.direction, String(q.direction)));
  if (q.q) { const like = `%${String(q.q)}%`; conds.push(or(ilike(bankTransactionsTable.counterparty, like), ilike(bankTransactionsTable.title, like), ilike(bankTransactionsTable.txType, like))); }
  const where = conds.length ? and(...conds) : undefined;

  const sortCol = { date: bankTransactionsTable.valueDate, amount: bankTransactionsTable.amount, counterparty: bankTransactionsTable.counterparty }[String(q.sort)] ?? bankTransactionsTable.valueDate;
  const dir = q.order === "asc" ? asc : desc;
  const limit = Math.min(Number(q.limit) || 100, 500);
  const offset = Number(q.offset) || 0;

  const [rows, [tot]] = await Promise.all([
    db.select().from(bankTransactionsTable).where(where).orderBy(dir(sortCol), desc(bankTransactionsTable.id)).limit(limit).offset(offset),
    db.select({ n: count() }).from(bankTransactionsTable).where(where),
  ]);
  ok(res, { rows, total: tot?.n ?? 0, limit, offset });
});

// Filter option lists — only companies that actually have bank data (drops RS/TS)
router.get("/bank/meta", async (_req, res) => {
  const withData = await db.selectDistinct({ companyId: bankTransactionsTable.companyId }).from(bankTransactionsTable);
  const ids = withData.map(r => r.companyId).filter((x): x is number => x != null);
  const companies = ids.length ? await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(inArray(companiesTable.id, ids)).orderBy(companiesTable.id) : [];
  const years = await db.select({ year: sql<string>`distinct to_char(${bankTransactionsTable.valueDate}, 'YYYY')` }).from(bankTransactionsTable).orderBy(sql`1 desc`);
  ok(res, { companies, years: years.map(y => y.year) });
});

// Manual re-sync from Drive (statements) + the cash-register sheet
router.post("/bank/sync", async (_req, res) => {
  try {
    const bank = await syncBankTransactions();
    let cash: CashSyncResult | { error: string };
    try { cash = await syncCashRegister(); } catch (e: any) { cash = { error: e?.message ?? "cash sync failed" }; }
    ok(res, { ...bank, cash });
  } catch (e: any) { logger.error({ err: e?.message }, "bank sync failed"); fail(res, 500, e?.message || "sync failed"); }
});

// ── Manual re-categorization ──────────────────────────────────────────────────
// Move an expense transaction to another category, or mark it as an owner's
// personal spend (owner_*). null resets to automatic classification.
router.patch("/bank/transactions/:id/category", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const category = req.body?.category ?? null;
  const validKeys = new Set([...EXPENSE_CATS.map(([k]) => k), "other", ...OWNER_KEYS]);
  if (category !== null && !validKeys.has(String(category))) return fail(res, 400, "unknown category");
  const [row] = await db.select({ id: bankTransactionsTable.id, direction: bankTransactionsTable.direction })
    .from(bankTransactionsTable).where(eq(bankTransactionsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (row.direction !== "out") return fail(res, 400, "only expense transactions can be re-categorized");
  const [updated] = await db.update(bankTransactionsTable)
    .set({ manualCategory: category ? String(category) : null })
    .where(eq(bankTransactionsTable.id, id)).returning();
  ok(res, updated);
});

// ── Counterparty → category rules ─────────────────────────────────────────────
// «Перенести контрагента в категорію»: applies to all existing transactions of the
// counterparty and to future imports (sync hook). Owner payouts are never touched.
router.get("/bank/counterparty-rules", async (_req, res) => {
  const rules = await db.select().from(counterpartyRulesTable).orderBy(desc(counterpartyRulesTable.id));
  ok(res, { rules });
});

router.post("/bank/counterparty-rules", async (req, res) => {
  const pattern = String(req.body?.pattern ?? "").trim();
  const category = String(req.body?.category ?? "");
  if (pattern.length < 3) return fail(res, 400, "pattern must be at least 3 characters");
  const validKeys = new Set([...EXPENSE_CATS.map(([k]) => k), "other"]); // owner categories can't be a rule target
  if (!validKeys.has(category)) return fail(res, 400, "unknown category");
  const [rule] = await db.insert(counterpartyRulesTable).values({ pattern, category }).returning();
  const updated = await applyCounterpartyRules({ ruleId: rule!.id });
  ok(res, { rule, updated });
});

router.delete("/bank/counterparty-rules/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [rule] = await db.select().from(counterpartyRulesTable).where(eq(counterpartyRulesTable.id, id));
  if (!rule) return fail(res, 404, "not found");
  // rolling back: clear the manual categories this rule set (owner overrides untouched)
  await db.execute(sql`
    UPDATE bank_transactions SET manual_category = NULL
    WHERE direction='out' AND manual_category = ${rule.category}
      AND upper(coalesce(counterparty,'')) LIKE ${"%" + rule.pattern.toUpperCase() + "%"}`);
  await db.delete(counterpartyRulesTable).where(eq(counterpartyRulesTable.id, id));
  ok(res, { ok: true });
});

// ── Office cash box (сейф) ────────────────────────────────────────────────────
// Summary for a period: opening = openings of each firm's FIRST month in the period,
// closing = opening + Σin − Σout. Entries come from the office's STAN KASY sheet.
router.get("/bank/cash", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;
  const fromM = month ? `${year}-${month}` : `${year}-01`;
  const toM = month ? `${year}-${month}` : `${year}-12`;

  const conds = [gte(cashEntriesTable.periodMonth, fromM), lte(cashEntriesTable.periodMonth, toM)];
  if (companyId) conds.push(eq(cashEntriesTable.companyId, companyId));
  const entries = await db.select().from(cashEntriesTable).where(and(...conds))
    .orderBy(asc(cashEntriesTable.periodMonth), asc(cashEntriesTable.sortIdx));

  // per firm: opening of its first month in range; inflow/outflow across the range
  const perFirm = new Map<number, { opening: number; openMonth: string | null; inflow: number; outflow: number }>();
  for (const e of entries) {
    const f = perFirm.get(e.companyId ?? 0) ?? { opening: 0, openMonth: null, inflow: 0, outflow: 0 };
    if (e.kind === "opening") { if (f.openMonth === null || e.periodMonth < f.openMonth) { f.opening = e.amount; f.openMonth = e.periodMonth; } }
    else if (e.kind === "in") f.inflow += e.amount;
    else if (e.kind === "out") f.outflow += e.amount;
    perFirm.set(e.companyId ?? 0, f);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  let opening = 0, inflow = 0, outflow = 0;
  for (const f of perFirm.values()) { opening += f.opening; inflow += f.inflow; outflow += f.outflow; }
  ok(res, {
    year, month: month ?? null, companyId,
    opening: round(opening), inflow: round(inflow), outflow: round(outflow),
    closing: round(opening + inflow - outflow),
    counts: { in: entries.filter(e => e.kind === "in").length, out: entries.filter(e => e.kind === "out").length },
  });
});

// Cash entries list (drill-down)
router.get("/bank/cash/entries", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;
  const conds = [gte(cashEntriesTable.periodMonth, month ? `${year}-${month}` : `${year}-01`), lte(cashEntriesTable.periodMonth, month ? `${year}-${month}` : `${year}-12`)];
  if (companyId) conds.push(eq(cashEntriesTable.companyId, companyId));
  if (req.query.kind === "in" || req.query.kind === "out") conds.push(eq(cashEntriesTable.kind, String(req.query.kind)));
  else conds.push(inArray(cashEntriesTable.kind, ["in", "out"]));
  const rows = await db.select().from(cashEntriesTable).where(and(...conds))
    .orderBy(desc(cashEntriesTable.periodMonth), desc(cashEntriesTable.sortIdx)).limit(500);
  ok(res, { rows });
});

export default router;
