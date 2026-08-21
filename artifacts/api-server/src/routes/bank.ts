// Bank statements API (owner-only): the raw transaction layer + monthly/yearly cash
// summary. One place defines how transactions are classified (income / expenses / cash),
// used both by the summary metrics and the drill-down lists so they always agree.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { bankTransactionsTable, cashEntriesTable, companiesTable, counterpartyRulesTable, expenseCategoriesTable, bankApiConsentsTable, bankApiAccountsTable, counterpartiesTable, counterpartyAliasesTable, counterpartyAccountsTable } from "@workspace/db";
import { and, eq, gte, lte, lt, or, ilike, asc, desc, count, sql, inArray } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";
import { logger } from "../lib/logger";
import { syncBankTransactions, applyCounterpartyRules, RULE_HAYSTACK } from "../services/bankStatements";
import {
  BUCKET, OWNER_KEYS, MC, TXT, OPER, catCondition, catCaseExpr, patternCondition,
  getExpenseCats, invalidateExpenseCats, periodRange,
  T_INTERNAL, T_VATREF, T_VATMOVE, T_VATSPLIT_OUT, T_CASHDEP,
} from "../services/bankClassify";
import { ebConfigured, listAspsps, startAuth, completeAuth, importSession, revokeConsent, syncBankApi } from "../services/bankApi";
import { syncCounterparties, resolveBankCounterparties, normAlias, normIban } from "../services/counterparties";

const router: IRouter = Router();
router.use(authRequired);
// Гейт скоуплено по префіксу: неупакований router.use() в Express зачіпає і ПРОХІДНІ
// запити до роутерів, змонтованих далі (роль без viewFinance не діставалась до
// /cash, /cost-invoices, /fuel — латентний баг порядку монтування, виправлено 12.08.2026)
router.use("/bank", requireCap("viewFinance"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-\d{2}$/.test(m);
const rowsOf = (r: any): any[] => r?.rows ?? r ?? [];

// ── Balance at a date ──────────────────────────────────────────────────────────
// Per account: latest statement closing ≤ date PLUS transactions booked after that
// closing up to the date. The supplement matters because some banks close statements
// mid-month (e.g. the 29th) — without it, month-boundary days would be missed.
export async function balanceAt(dateStr: string, companyId: number | null, excludeAccountKeys: string[] = []): Promise<number> {
  const co = companyId ? sql`AND company_id = ${companyId}` : sql``;
  // рахунки, покриті живими API-балансами, можна виключити (26-цифрові ядра NRB) —
  // їх суму дає банк напряму (balanceAtLive), інакше було б подвійне врахування
  const excl = excludeAccountKeys.length
    ? sql`AND NOT (regexp_replace(coalesce(account, ''), '[^0-9]', '', 'g') LIKE ANY(ARRAY[${sql.join(excludeAccountKeys.map(k => sql`${"%" + k + "%"}`), sql`, `)}]))`
    : sql``;
  // ідентичність рахунку — цифрове ядро NRB (як у supersedeApiRows): MT940 «:25:»
  // пише «/PL…», API-рядки — голий IBAN; точний збіг рядків губив API-докидку
  const r = await db.execute<{ bal: number }>(sql`
    WITH last_close AS (
      SELECT DISTINCT ON (regexp_replace(coalesce(account, ''), '[^0-9]', '', 'g'))
        regexp_replace(coalesce(account, ''), '[^0-9]', '', 'g') AS acct_key, closing_date, closing_balance
      FROM bank_statements
      WHERE closing_date <= ${dateStr} AND closing_balance IS NOT NULL AND ${sql.raw(OPER)} ${co} ${excl}
      -- a file may hold several statement sections closing on the SAME day
      -- (e.g. 2026/001/2 and /3 both close 27.01) — the later section must win,
      -- otherwise the tie is broken arbitrarily and balances drift by the gap
      ORDER BY regexp_replace(coalesce(account, ''), '[^0-9]', '', 'g'), closing_date DESC, opening_date DESC, statement_no DESC
    )
    SELECT coalesce(sum(
      lc.closing_balance + coalesce((
        SELECT sum(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END)
        FROM bank_transactions t
        WHERE regexp_replace(coalesce(t.account, ''), '[^0-9]', '', 'g') = lc.acct_key
          AND t.value_date > lc.closing_date AND t.value_date <= ${dateStr}
      ), 0)
    ), 0) AS bal FROM last_close lc`);
  return Number(rowsOf(r)[0]?.bal ?? 0);
}

// «Живий» варіант для знімків «на зараз» (дата ≥ сьогодні): рахунки, покриті
// свіжими балансами Enable Banking (< 48 год), беруть цифру банку (ITBD — вона
// авторитетніша за розрахунок: включає комісії/відсотки без окремих рядків),
// решта — звичайний розрахунок closings+транзакції. Минулі дати — як було.
export async function balanceAtLive(dateStr: string, companyId: number | null): Promise<{ total: number; liveCount: number; liveAt: string | null }> {
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr < today) return { total: await balanceAt(dateStr, companyId), liveCount: 0, liveAt: null };
  const co = companyId ? sql`AND a.company_id = ${companyId}` : sql``;
  const liveRows = rowsOf(await db.execute(sql`
    SELECT a.iban, a.last_booked_balance AS bal, a.balance_at AS at
    FROM bank_api_accounts a JOIN bank_api_consents c ON c.id = a.consent_id
    WHERE c.revoked_at IS NULL AND a.iban IS NOT NULL AND a.last_booked_balance IS NOT NULL
      AND a.balance_at > now() - interval '48 hours' ${co}`));
  const keys = liveRows.map(r => String(r.iban).replace(/\D/g, "").match(/\d{26}/)?.[0]).filter((k): k is string => !!k);
  const computed = await balanceAt(dateStr, companyId, keys);
  const liveSum = liveRows.reduce((s, r) => s + Number(r.bal ?? 0), 0);
  const liveAt = liveRows.reduce<string | null>((mx, r) => {
    const at = r.at instanceof Date ? r.at.toISOString() : String(r.at ?? "");
    return !mx || at > mx ? at : mx;
  }, null);
  return { total: Math.round((computed + liveSum) * 100) / 100, liveCount: liveRows.length, liveAt };
}

// Розбивка «Гроші → банк» по рахунках для сторінки Балансу: живі API-рахунки
// (з продуктом і банком) + розрахункові з витягів (виключаючи покриті живими).
export type BalanceAccount = { iban: string; bank: string | null; product: string | null; amount: number; live: boolean };

export async function balanceAccountsAt(dateStr: string, companyId: number): Promise<BalanceAccount[]> {
  const today = new Date().toISOString().slice(0, 10);
  const useLive = dateStr >= today;
  const out: BalanceAccount[] = [];
  const liveKeys: string[] = [];
  if (useLive) {
    const liveRows = rowsOf(await db.execute(sql`
      SELECT a.iban, a.product, a.last_booked_balance AS bal, c.aspsp_name AS bank
      FROM bank_api_accounts a JOIN bank_api_consents c ON c.id = a.consent_id
      WHERE c.revoked_at IS NULL AND a.iban IS NOT NULL AND a.last_booked_balance IS NOT NULL
        AND a.balance_at > now() - interval '48 hours' AND a.company_id = ${companyId}`));
    for (const r of liveRows) {
      out.push({ iban: String(r.iban), bank: r.bank ?? null, product: r.product ?? null, amount: Math.round(Number(r.bal) * 100) / 100, live: true });
      const k = String(r.iban).replace(/\D/g, "").match(/\d{26}/)?.[0];
      if (k) liveKeys.push(k);
    }
  }
  const excl = liveKeys.length
    ? sql`AND NOT (regexp_replace(coalesce(account, ''), '[^0-9]', '', 'g') LIKE ANY(ARRAY[${sql.join(liveKeys.map(k => sql`${"%" + k + "%"}`), sql`, `)}]))`
    : sql``;
  // та сама ідентичність по цифровому ядру, що й у balanceAt; account лишаємо для показу
  const computed = rowsOf(await db.execute(sql`
    WITH last_close AS (
      SELECT DISTINCT ON (regexp_replace(coalesce(account, ''), '[^0-9]', '', 'g'))
        account, regexp_replace(coalesce(account, ''), '[^0-9]', '', 'g') AS acct_key, closing_date, closing_balance
      FROM bank_statements
      WHERE closing_date <= ${dateStr} AND closing_balance IS NOT NULL AND ${sql.raw(OPER)}
        AND company_id = ${companyId} ${excl}
      ORDER BY regexp_replace(coalesce(account, ''), '[^0-9]', '', 'g'), closing_date DESC, opening_date DESC, statement_no DESC
    )
    SELECT lc.account,
      lc.closing_balance + coalesce((
        SELECT sum(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END)
        FROM bank_transactions t
        WHERE regexp_replace(coalesce(t.account, ''), '[^0-9]', '', 'g') = lc.acct_key
          AND t.value_date > lc.closing_date AND t.value_date <= ${dateStr}
      ), 0) AS bal
    FROM last_close lc ORDER BY bal DESC`));
  for (const r of computed) {
    out.push({ iban: String(r.account), bank: null, product: null, amount: Math.round(Number(r.bal) * 100) / 100, live: false });
  }
  return out.sort((a, b) => b.amount - a.amount);
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

  const rows = await db.execute(sql`
    SELECT ${sql.raw(catCaseExpr(await getExpenseCats()))} AS cat,
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
  const cond = b.startsWith("cat:") ? catCondition(b.slice(4), await getExpenseCats()) : BUCKET[b] ?? null;
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
    const cond = catCondition(q.bucket.slice(4), await getExpenseCats());
    if (cond) conds.push(sql.raw(cond));
  } else if (typeof q.bucket === "string" && BUCKET[q.bucket]) conds.push(sql.raw(BUCKET[q.bucket]!));
  else if (q.direction === "in" || q.direction === "out") conds.push(eq(bankTransactionsTable.direction, String(q.direction)));
  if (q.q) {
    const like = `%${String(q.q)}%`;
    // рахунки матчимо без пробілів: IBAN копіюють як «PL61 1090 …», у базі — суцільно
    const likeNs = `%${String(q.q).replace(/\s+/g, "")}%`;
    conds.push(or(
      ilike(bankTransactionsTable.counterparty, like),
      ilike(bankTransactionsTable.title, like),
      ilike(bankTransactionsTable.txType, like),
      sql`replace(${bankTransactionsTable.counterpartyAccount}, ' ', '') ILIKE ${likeNs}`,
      sql`replace(${bankTransactionsTable.account}, ' ', '') ILIKE ${likeNs}`,
    ));
  }
  if (q.source === "api" || q.source === "mt940") conds.push(eq(bankTransactionsTable.source, String(q.source)));
  if (q.counterpartyId) conds.push(eq(bankTransactionsTable.counterpartyId, Number(q.counterpartyId)));
  const minA = Number(String(q.minAmount ?? "").replace(",", ".")), maxA = Number(String(q.maxAmount ?? "").replace(",", "."));
  if (q.minAmount && Number.isFinite(minA)) conds.push(gte(bankTransactionsTable.amount, minA));
  if (q.maxAmount && Number.isFinite(maxA)) conds.push(lte(bankTransactionsTable.amount, maxA));
  const where = conds.length ? and(...conds) : undefined;

  const sortCol = { date: bankTransactionsTable.valueDate, amount: bankTransactionsTable.amount, counterparty: bankTransactionsTable.counterparty }[String(q.sort)] ?? bankTransactionsTable.valueDate;
  const dir = q.order === "asc" ? asc : desc;
  const limit = Math.min(Number(q.limit) || 100, 500);
  const offset = Number(q.offset) || 0;

  const [rows, [tot]] = await Promise.all([
    db.select().from(bankTransactionsTable).where(where).orderBy(dir(sortCol), desc(bankTransactionsTable.id)).limit(limit).offset(offset),
    // totals over the WHOLE filter (not the page) — for the «Разом» footer row
    db.select({
      n: count(),
      sumIn: sql<number>`coalesce(sum(amount) FILTER (WHERE direction='in'), 0)`,
      sumOut: sql<number>`coalesce(sum(amount) FILTER (WHERE direction='out'), 0)`,
    }).from(bankTransactionsTable).where(where),
  ]);
  const r2 = (n: any) => Math.round(Number(n ?? 0) * 100) / 100;
  ok(res, { rows, total: tot?.n ?? 0, sums: { in: r2(tot?.sumIn), out: r2(tot?.sumOut) }, limit, offset });
});

// Filter option lists — only companies that actually have bank data (drops RS/TS)
router.get("/bank/meta", async (_req, res) => {
  const withData = await db.selectDistinct({ companyId: bankTransactionsTable.companyId }).from(bankTransactionsTable);
  const ids = withData.map(r => r.companyId).filter((x): x is number => x != null);
  const companies = ids.length ? await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(inArray(companiesTable.id, ids)).orderBy(companiesTable.id) : [];
  const years = await db.select({ year: sql<string>`distinct to_char(${bankTransactionsTable.valueDate}, 'YYYY')` }).from(bankTransactionsTable).orderBy(sql`1 desc`);
  ok(res, { companies, years: years.map(y => y.year) });
});

// Manual re-sync from Drive (statements). The STAN KASY sheet is retired
// (08.2026) — kasa entries live on /cash; syncCashRegister stays for one-off scripts.
router.post("/bank/sync", async (_req, res) => {
  try {
    ok(res, await syncBankTransactions());
  } catch (e: any) { logger.error({ err: e?.message }, "bank sync failed"); fail(res, 500, e?.message || "sync failed"); }
});

// ── Manual re-categorization ──────────────────────────────────────────────────
// Valid targets for a manual override: every DB category + virtual keys.
async function validCatKeys(withOwners = true): Promise<Set<string>> {
  const cats = await getExpenseCats();
  return new Set([...cats.map(c => c.key), "other", ...(withOwners ? OWNER_KEYS : [])]);
}

// Move an expense transaction to another category, or mark it as an owner's
// personal spend (owner_*). null resets to automatic classification.
router.patch("/bank/transactions/:id/category", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const category = req.body?.category ?? null;
  if (category !== null && !(await validCatKeys()).has(String(category))) return fail(res, 400, "unknown category");
  const [row] = await db.select({ id: bankTransactionsTable.id, direction: bankTransactionsTable.direction })
    .from(bankTransactionsTable).where(eq(bankTransactionsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (row.direction !== "out") return fail(res, 400, "only expense transactions can be re-categorized");
  const [updated] = await db.update(bankTransactionsTable)
    .set({ manualCategory: category ? String(category) : null })
    .where(eq(bankTransactionsTable.id, id)).returning();
  ok(res, updated);
});

// Batch re-categorization — the multi-select in the transactions list.
router.post("/bank/transactions/recategorize", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) return fail(res, 400, "ids required");
  if (ids.length > 500) return fail(res, 400, "too many ids (max 500)");
  const category = req.body?.category ?? null;
  if (category !== null && !(await validCatKeys()).has(String(category))) return fail(res, 400, "unknown category");
  const updated = await db.update(bankTransactionsTable)
    .set({ manualCategory: category ? String(category) : null })
    .where(and(inArray(bankTransactionsTable.id, ids), eq(bankTransactionsTable.direction, "out")))
    .returning({ id: bankTransactionsTable.id });
  ok(res, { updated: updated.length, skipped: ids.length - updated.length });
});

// ── Expense categories CRUD ───────────────────────────────────────────────────
// Categories are owner-editable rows in expense_categories (see bankClassify.ts
// for the pattern mini-DSL). Virtual keys (other, owner_*) are not manageable.

// Pattern must compile as Postgres regexes — a broken pattern would break every
// classification query, so each term is test-evaluated (parameterized) first.
async function checkPattern(pattern: string): Promise<string | null> {
  const terms = pattern.split("\n").flatMap(l => l.split(" + ")).map(t => t.trim()).filter(Boolean);
  if (terms.length === 0) return "pattern is empty";
  for (const t of terms) {
    try { await db.execute(sql`SELECT '' ~ ${t}`); }
    catch (e: any) { return `bad regex «${t}»: ${e?.message ?? "error"}`; }
  }
  return null;
}

router.get("/bank/categories", async (_req, res) => {
  const cats = await getExpenseCats();
  // usage counts over ALL expenses — shown in the management modal
  const counts = new Map<string, number>();
  const rows = await db.execute(sql`
    SELECT ${sql.raw(catCaseExpr(cats))} AS cat, count(*) AS n
    FROM bank_transactions WHERE ${sql.raw(BUCKET.expenses!)} GROUP BY 1`);
  for (const r of rowsOf(rows)) counts.set(String(r.cat), Number(r.n));
  ok(res, {
    categories: cats.map(c => ({ ...c, txCount: counts.get(c.key) ?? 0 })),
    otherCount: counts.get("other") ?? 0,
  });
});

const RESERVED_KEYS = new Set(["other", ...OWNER_KEYS, "deposit", "transfer", "income", "vat_refund"]);

router.post("/bank/categories", async (req, res) => {
  const label = String(req.body?.label ?? "").trim();
  if (label.length < 2) return fail(res, 400, "label must be at least 2 characters");
  const pattern = String(req.body?.pattern ?? "").trim() || null;
  if (pattern) { const err = await checkPattern(pattern); if (err) return fail(res, 400, err); }
  // key: latin slug from the label when possible, otherwise a generated cat_<n>
  const slug = label.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  const cats = await getExpenseCats();
  const taken = new Set([...cats.map(c => c.key), ...RESERVED_KEYS]);
  let key = slug.length >= 2 && !taken.has(slug) ? slug : "";
  if (!key) { let n = cats.length + 1; while (taken.has(`cat_${n}`)) n++; key = `cat_${n}`; }
  const maxSort = cats.reduce((m, c) => Math.max(m, c.sortOrder), 0);
  const [row] = await db.insert(expenseCategoriesTable)
    .values({ key, label, pattern, sortOrder: maxSort + 10 }).returning();
  invalidateExpenseCats();
  ok(res, row);
});

router.patch("/bank/categories/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [cat] = await db.select().from(expenseCategoriesTable).where(eq(expenseCategoriesTable.id, id));
  if (!cat) return fail(res, 404, "not found");
  const patch: Partial<{ label: string; pattern: string | null; sortOrder: number }> = {};
  if (req.body?.label !== undefined) {
    const label = String(req.body.label).trim();
    if (label.length < 2) return fail(res, 400, "label must be at least 2 characters");
    patch.label = label;
  }
  if (req.body?.pattern !== undefined) {
    const pattern = String(req.body.pattern ?? "").trim() || null;
    if (pattern) { const err = await checkPattern(pattern); if (err) return fail(res, 400, err); }
    patch.pattern = pattern;
  }
  if (req.body?.sortOrder !== undefined) {
    const so = Number(req.body.sortOrder);
    if (!Number.isFinite(so)) return fail(res, 400, "bad sortOrder");
    patch.sortOrder = so;
  }
  if (Object.keys(patch).length === 0) return fail(res, 400, "nothing to update");
  const [updated] = await db.update(expenseCategoriesTable).set(patch).where(eq(expenseCategoriesTable.id, id)).returning();
  invalidateExpenseCats();
  ok(res, updated);
});

// Deleting a category moves everything it held to «Інше»: manual overrides (bank
// and cash) are re-pinned to 'other', rules targeting it are removed, and its
// auto-pattern disappears so pattern-matched rows fall through naturally.
router.delete("/bank/categories/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [cat] = await db.select().from(expenseCategoriesTable).where(eq(expenseCategoriesTable.id, id));
  if (!cat) return fail(res, 404, "not found");
  await db.transaction(async tx => {
    await tx.update(bankTransactionsTable).set({ manualCategory: "other" }).where(eq(bankTransactionsTable.manualCategory, cat.key));
    await tx.update(cashEntriesTable).set({ manualCategory: "other" }).where(eq(cashEntriesTable.manualCategory, cat.key));
    await tx.delete(counterpartyRulesTable).where(eq(counterpartyRulesTable.category, cat.key));
    await tx.delete(expenseCategoriesTable).where(eq(expenseCategoriesTable.id, id));
  });
  invalidateExpenseCats();
  ok(res, { ok: true });
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
  // owner categories can't be a rule target
  if (!(await validCatKeys(false)).has(category)) return fail(res, 400, "unknown category");
  const [rule] = await db.insert(counterpartyRulesTable).values({ pattern, category }).returning();
  const updated = await applyCounterpartyRules({ ruleId: rule!.id });
  ok(res, { rule, updated });
});

// rolling back a rule: clear the manual categories it set (owner overrides untouched)
async function unapplyRule(rule: { pattern: string; category: string }): Promise<void> {
  await db.execute(sql`
    UPDATE bank_transactions SET manual_category = NULL
    WHERE direction='out' AND manual_category = ${rule.category}
      AND ${sql.raw(RULE_HAYSTACK)} LIKE ${"%" + rule.pattern.toUpperCase().replace(/\s+/g, " ") + "%"}`);
}

router.patch("/bank/counterparty-rules/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [rule] = await db.select().from(counterpartyRulesTable).where(eq(counterpartyRulesTable.id, id));
  if (!rule) return fail(res, 404, "not found");
  const pattern = req.body?.pattern !== undefined ? String(req.body.pattern).trim() : rule.pattern;
  const category = req.body?.category !== undefined ? String(req.body.category) : rule.category;
  if (pattern.length < 3) return fail(res, 400, "pattern must be at least 3 characters");
  if (!(await validCatKeys(false)).has(category)) return fail(res, 400, "unknown category");
  if (pattern === rule.pattern && category === rule.category) return ok(res, { rule, updated: 0 });
  await unapplyRule(rule); // detach what the OLD rule matched, then re-apply the new one
  const [updated] = await db.update(counterpartyRulesTable).set({ pattern, category }).where(eq(counterpartyRulesTable.id, id)).returning();
  const n = await applyCounterpartyRules({ ruleId: id });
  ok(res, { rule: updated, updated: n });
});

router.delete("/bank/counterparty-rules/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [rule] = await db.select().from(counterpartyRulesTable).where(eq(counterpartyRulesTable.id, id));
  if (!rule) return fail(res, 404, "not found");
  await unapplyRule(rule);
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

// ── Open banking (Enable Banking) — оперативний шар ────────────────────────────
// Згоди PSD2, живі баланси, старт/фінал авторизації в банку. Все за тим самим
// гейтом viewFinance, що й решта сторінки.

router.get("/bank/api-consents", async (_req, res) => {
  const consents = await db.select().from(bankApiConsentsTable).orderBy(desc(bankApiConsentsTable.createdAt));
  const accounts = await db.select().from(bankApiAccountsTable);
  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable);
  const coName = new Map(companies.map(c => [c.id, c.name]));
  ok(res, {
    configured: ebConfigured(),
    consents: consents.map(c => ({
      ...c,
      companyName: c.companyId ? coName.get(c.companyId) ?? null : null,
      daysLeft: Math.ceil((c.validUntil.getTime() - Date.now()) / 86_400_000),
      accounts: accounts.filter(a => a.consentId === c.id).map(a => ({
        ...a, companyName: a.companyId ? coName.get(a.companyId) ?? null : null,
      })),
    })),
  });
});

// Банки, доступні для підключення (кешуємо: список майже статичний)
let aspspCache: { at: number; country: string; list: { name: string; country: string }[] } | null = null;
router.get("/bank/api-aspsps", async (req, res) => {
  const country = /^[A-Z]{2}$/.test(String(req.query.country)) ? String(req.query.country) : "PL";
  try {
    if (!aspspCache || aspspCache.country !== country || Date.now() - aspspCache.at > 3600_000) {
      aspspCache = { at: Date.now(), country, list: await listAspsps(country) };
    }
    ok(res, { aspsps: aspspCache.list });
  } catch (e: any) { fail(res, 502, e?.message || "aspsps failed"); }
});

// Старт авторизації: віддає URL банку, куди веб-панель редіректить власника
router.post("/bank/api-consents/start", async (req, res) => {
  const name = String(req.body?.aspspName ?? "").trim();
  const country = /^[A-Z]{2}$/.test(String(req.body?.aspspCountry)) ? String(req.body?.aspspCountry) : "PL";
  if (!name) return fail(res, 400, "aspspName required");
  try { ok(res, await startAuth(name, country)); }
  catch (e: any) { fail(res, 502, e?.message || "auth start failed"); }
});

// Redirect з банку (адреса зареєстрована в Enable Banking CP). GET — CSRF-гард не
// зачіпає; сесія панелі в цьому ж браузері, бо флоу стартує зі сторінки /bank.
router.get("/bank/psd2-callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const error = typeof req.query.error === "string" ? req.query.error : null;
  if (!code) return res.redirect(`/bank?api=${encodeURIComponent(error || "no_code")}`);
  try {
    const r = await completeAuth(code);
    // 0 рахунків = логін не прив'язаний (whitelisted) в Enable Banking CP — згода
    // порожня і марна, прибираємо одразу й пояснюємо тостом
    if (r.accounts === 0) {
      await revokeConsent(r.consentId).catch(() => {});
      return res.redirect("/bank?api=no_accounts");
    }
    return res.redirect("/bank?api=linked");
  } catch (e: any) {
    logger.warn({ err: e?.message }, "psd2 callback failed");
    return res.redirect(`/bank?api=exchange_failed`);
  }
});

// Імпорт уже створеної сесії за id (сід сесій, авторизованих poza панеллю)
router.post("/bank/api-consents/import", async (req, res) => {
  const sessionId = String(req.body?.sessionId ?? "").trim();
  if (!sessionId) return fail(res, 400, "sessionId required");
  try { ok(res, await importSession(sessionId)); }
  catch (e: any) { fail(res, 502, e?.message || "import failed"); }
});

router.delete("/bank/api-consents/:id", async (req, res) => {
  try { await revokeConsent(Number(req.params.id)); ok(res, { ok: true }); }
  catch (e: any) { fail(res, 400, e?.message || "revoke failed"); }
});

// Ручний синк (кнопка на /bank); крон робить те саме за розкладом
router.post("/bank/api-sync", async (_req, res) => {
  try {
    const r = await syncBankApi();
    ok(res, r);
  } catch (e: any) { logger.error({ err: e?.message }, "bank api sync failed"); fail(res, 500, e?.message || "sync failed"); }
});

// Виправлення мапи рахунок→юрособа (якщо авто-матч не впорався) + пропагація
// на вже синкнуті API-рядки цього рахунку
router.patch("/bank/api-accounts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const companyId = req.body?.companyId == null ? null : Number(req.body.companyId);
  const [row] = await db.select().from(bankApiAccountsTable).where(eq(bankApiAccountsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  await db.update(bankApiAccountsTable).set({ companyId }).where(eq(bankApiAccountsTable.id, id));
  if (row.iban) {
    const key = row.iban.replace(/[^0-9]/g, "");
    if (key.length >= 10) await db.execute(sql`
      UPDATE bank_transactions SET company_id = ${companyId}
      WHERE source = 'api' AND regexp_replace(coalesce(account, ''), '[^0-9]', '', 'g') LIKE ${"%" + key + "%"}`);
  }
  ok(res, { ok: true });
});

// ── Довідник контрагентів ──────────────────────────────────────────────────────
// Єдина ідентичність клієнтів/постачальників (назва + NIP + аліаси + IBAN-и);
// транзакції резолвляться в довідник (counterparty_id) — сервіс counterparties.ts.

router.get("/bank/counterparties", async (req, res) => {
  const conds: any[] = [];
  if (req.query.kind && ["client", "supplier", "both", "other"].includes(String(req.query.kind))) {
    conds.push(eq(counterpartiesTable.kind, String(req.query.kind)));
  }
  if (req.query.q) {
    const like = `%${String(req.query.q)}%`;
    conds.push(or(
      ilike(counterpartiesTable.name, like),
      ilike(counterpartiesTable.nip, like),
      sql`EXISTS (SELECT 1 FROM counterparty_aliases a WHERE a.counterparty_id = ${counterpartiesTable.id} AND a.alias ILIKE ${like})`,
    ));
  }
  const cps = await db.select().from(counterpartiesTable).where(conds.length ? and(...conds) : undefined).orderBy(asc(counterpartiesTable.name)).limit(500);
  const ids = cps.map(c => c.id);
  const [aliases, accounts, stats] = await Promise.all([
    ids.length ? db.select().from(counterpartyAliasesTable).where(inArray(counterpartyAliasesTable.counterpartyId, ids)) : ([] as (typeof counterpartyAliasesTable.$inferSelect)[]),
    ids.length ? db.select().from(counterpartyAccountsTable).where(inArray(counterpartyAccountsTable.counterpartyId, ids)) : ([] as (typeof counterpartyAccountsTable.$inferSelect)[]),
    ids.length ? db.select({
      counterpartyId: bankTransactionsTable.counterpartyId,
      n: count(),
      sumIn: sql<number>`coalesce(sum(amount) FILTER (WHERE direction='in'), 0)`,
      sumOut: sql<number>`coalesce(sum(amount) FILTER (WHERE direction='out'), 0)`,
    }).from(bankTransactionsTable).where(inArray(bankTransactionsTable.counterpartyId, ids)).groupBy(bankTransactionsTable.counterpartyId) : [],
  ]);
  const statBy = new Map(stats.map(s => [s.counterpartyId, s]));
  ok(res, {
    rows: cps.map(c => ({
      ...c,
      aliases: aliases.filter(a => a.counterpartyId === c.id),
      accounts: accounts.filter(a => a.counterpartyId === c.id),
      txns: statBy.get(c.id)?.n ?? 0,
      sumIn: Math.round(Number(statBy.get(c.id)?.sumIn ?? 0) * 100) / 100,
      sumOut: Math.round(Number(statBy.get(c.id)?.sumOut ?? 0) * 100) / 100,
    })),
  });
});

router.post("/bank/counterparties", async (req, res) => {
  const name = String(req.body?.name ?? "").replace(/\s+/g, " ").trim();
  if (!name) return fail(res, 400, "name required");
  const kind = ["client", "supplier", "both", "other"].includes(String(req.body?.kind)) ? String(req.body.kind) : "other";
  const nip = String(req.body?.nip ?? "").replace(/\D/g, "") || null;
  if (nip && nip.length !== 10) return fail(res, 400, "NIP — 10 цифр");
  try {
    const [row] = await db.insert(counterpartiesTable).values({ name, kind, nip }).returning();
    await db.insert(counterpartyAliasesTable).values({ counterpartyId: row!.id, alias: normAlias(name) }).onConflictDoNothing();
    ok(res, row);
  } catch (e: any) { fail(res, 400, e?.message?.includes("unique") ? "Контрагент із цим NIP уже є" : e?.message); }
});

router.patch("/bank/counterparties/:id", async (req, res) => {
  const id = Number(req.params.id);
  const patch: any = {};
  if (req.body?.name != null) { const n = String(req.body.name).replace(/\s+/g, " ").trim(); if (!n) return fail(res, 400, "name"); patch.name = n; }
  if (req.body?.kind != null && ["client", "supplier", "both", "other"].includes(String(req.body.kind))) patch.kind = String(req.body.kind);
  if (req.body?.nip !== undefined) { const nip = String(req.body.nip ?? "").replace(/\D/g, ""); if (nip && nip.length !== 10) return fail(res, 400, "NIP — 10 цифр"); patch.nip = nip || null; }
  if (req.body?.note !== undefined) patch.note = String(req.body.note ?? "").trim() || null;
  if (!Object.keys(patch).length) return fail(res, 400, "empty");
  const [row] = await db.update(counterpartiesTable).set(patch).where(eq(counterpartiesTable.id, id)).returning();
  if (!row) return fail(res, 404, "not found");
  ok(res, row);
});

router.delete("/bank/counterparties/:id", async (req, res) => {
  const id = Number(req.params.id);
  await db.update(bankTransactionsTable).set({ counterpartyId: null }).where(eq(bankTransactionsTable.counterpartyId, id));
  await db.delete(counterpartiesTable).where(eq(counterpartiesTable.id, id)); // aliases/accounts — cascade
  ok(res, { ok: true });
});

// Злиття дублів: аліаси/рахунки/транзакції — до цілі; NIP цілі виграє
router.post("/bank/counterparties/merge", async (req, res) => {
  const fromId = Number(req.body?.fromId), toId = Number(req.body?.toId);
  if (!fromId || !toId || fromId === toId) return fail(res, 400, "fromId/toId");
  const [from] = await db.select().from(counterpartiesTable).where(eq(counterpartiesTable.id, fromId));
  const [to] = await db.select().from(counterpartiesTable).where(eq(counterpartiesTable.id, toId));
  if (!from || !to) return fail(res, 404, "not found");
  await db.execute(sql`UPDATE counterparty_aliases SET counterparty_id = ${toId} WHERE counterparty_id = ${fromId} AND alias NOT IN (SELECT alias FROM counterparty_aliases WHERE counterparty_id = ${toId})`);
  await db.execute(sql`UPDATE counterparty_accounts SET counterparty_id = ${toId} WHERE counterparty_id = ${fromId} AND iban NOT IN (SELECT iban FROM counterparty_accounts WHERE counterparty_id = ${toId})`);
  await db.update(bankTransactionsTable).set({ counterpartyId: toId }).where(eq(bankTransactionsTable.counterpartyId, fromId));
  await db.insert(counterpartyAliasesTable).values({ counterpartyId: toId, alias: normAlias(from.name) }).onConflictDoNothing();
  if (from.nip && !to.nip) await db.update(counterpartiesTable).set({ nip: null }).where(eq(counterpartiesTable.id, fromId)); // звільнити NIP…
  await db.delete(counterpartiesTable).where(eq(counterpartiesTable.id, fromId));
  if (from.nip && !to.nip) await db.update(counterpartiesTable).set({ nip: from.nip }).where(eq(counterpartiesTable.id, toId)); // …і перенести цілі
  ok(res, { ok: true });
});

router.post("/bank/counterparties/:id/alias", async (req, res) => {
  const alias = normAlias(String(req.body?.alias ?? ""));
  if (!alias) return fail(res, 400, "alias required");
  try {
    const [row] = await db.insert(counterpartyAliasesTable).values({ counterpartyId: Number(req.params.id), alias }).returning();
    void resolveBankCounterparties().catch(() => {});
    ok(res, row);
  } catch { fail(res, 400, "Такий аліас уже привʼязаний"); }
});
router.delete("/bank/counterparties/alias/:aliasId", async (req, res) => {
  await db.delete(counterpartyAliasesTable).where(eq(counterpartyAliasesTable.id, Number(req.params.aliasId)));
  ok(res, { ok: true });
});

router.post("/bank/counterparties/:id/account", async (req, res) => {
  const iban = normIban(String(req.body?.iban ?? ""));
  if (iban.length < 15) return fail(res, 400, "IBAN закороткий");
  try {
    const [row] = await db.insert(counterpartyAccountsTable).values({ counterpartyId: Number(req.params.id), iban }).returning();
    void resolveBankCounterparties().catch(() => {});
    ok(res, row);
  } catch { fail(res, 400, "Цей IBAN уже привʼязаний"); }
});
router.delete("/bank/counterparties/account/:accId", async (req, res) => {
  await db.delete(counterpartyAccountsTable).where(eq(counterpartyAccountsTable.id, Number(req.params.accId)));
  ok(res, { ok: true });
});

// Повний сідинг (KSeF + фабрики + витяги) + резолюція — кнопка на /bank; крон
// робить те саме щодня після KSeF-синку
router.post("/bank/counterparties/sync", async (_req, res) => {
  try { ok(res, await syncCounterparties()); }
  catch (e: any) { logger.error({ err: e?.message }, "counterparties sync failed"); fail(res, 500, e?.message || "sync failed"); }
});

export default router;
