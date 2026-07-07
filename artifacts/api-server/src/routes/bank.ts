// Bank statements API (owner-only): the raw transaction layer + monthly/yearly cash
// summary. One place defines how transactions are classified (income / expenses / cash),
// used both by the summary metrics and the drill-down lists so they always agree.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { bankTransactionsTable, companiesTable } from "@workspace/db";
import { and, eq, gte, lte, lt, or, ilike, asc, desc, count, sql, inArray } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";
import { logger } from "../lib/logger";
import { syncBankTransactions } from "../services/bankStatements";

const router: IRouter = Router();
router.use(authRequired);
router.use(requireCap("viewFinance"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-\d{2}$/.test(m);
const rowsOf = (r: any): any[] => r?.rows ?? r ?? [];

// ── Classification (SQL, single source of truth) ──────────────────────────────
const TXT = `upper(coalesce(counterparty,'')||' '||coalesce(title,'')||' '||coalesce(tx_type,''))`;
// own-account moves; unnamed bare "Przelew" rows are verified inter-bank transfers
// (each has a mirror EUROSUPPORT credit on another of our accounts within ±3 days)
const T_INTERNAL = `(${TXT} ~ 'EUROSUPPORT|EURO SUPPORT|KLINEX|PRZELEW W.ASN|BETWEEN YOUR OWN' OR (counterparty IS NULL AND coalesce(title,'') = 'Przelew'))`;
// outgoing split-payment VAT auto-move (mirror of a client's MPP payment); the bank
// sometimes strips the /VAT//IDC markers leaving only a date-like title
const T_VATSPLIT_OUT = `((${TXT} ~ '/VAT/' AND ${TXT} ~ '/IDC/') OR (counterparty IS NULL AND tx_type IS NULL AND title ~ '^[0-9/.]+ ES-?\\.?\\s*$'))`;
// owner payouts (transfers to the Sydorchuk family incl. their salaries; card spending excluded)
const T_CARDOP = `${TXT} ~ 'BEZGOT|KART. DEBET|535472'`;
const T_OWNER_ROMAN = `(${TXT} ~ 'SYDORCZUK ROMAN|ROMAN SYDORCZUK|SYDORCHUK ROMAN|ROMAN SYDORCHUK' AND NOT ${T_CARDOP})`;
const T_OWNER_TETIANA = `(${TXT} ~ 'SYDORCZUK TETIANA|TETIANA SYDORCZUK|SYDORCHUK TETIANA|TETIANA SYDORCHUK|SYDORCZUK TATIANA|TATIANA SYDORCZUK' AND NOT ${T_CARDOP})`;
const T_OWNER_YURIY = `(${TXT} ~ 'SYDORCZUK YURI|YURI. SYDORCZUK|SYDORCHUK YURI|YURI. SYDORCHUK' AND NOT ${T_CARDOP})`;
const T_OWNER_ANY = `(${T_OWNER_ROMAN} OR ${T_OWNER_TETIANA} OR ${T_OWNER_YURIY})`;
const T_VATREF = `${TXT} ~ 'SKARBOW|URZ.D SKARB'`;                                         // tax-office VAT refund
// VAT split-payment rebooking between our own VAT & settlement accounts (A87
// "PRZEKSIĘGOWANIE VAT MPP") and incoming /SFP/ tax-form postings — not real income.
const T_VATMOVE = `(${TXT} ~ 'PRZEKS' OR ${TXT} ~ '/SFP/')`;
// cash withdrawal (not cashless card); the bank's withdrawal COMMISSION also mentions
// "gotówki" but is a company cost, not withdrawn cash → routed to the fees category
const T_CASH = `((${TXT} ~ 'BANKOMA' OR (${TXT} ~ 'GOT.WK' AND ${TXT} !~ 'BEZGOT')) AND ${TXT} !~ 'PROWIZ|OP.ATA')`;
const T_CASHDEP = `(${TXT} ~ 'WP.ATOMA' OR ${TXT} ~ 'ITCARD')`;                            // own cash deposited via a cash-deposit machine (ITCARD)
// salary transfers: "Wynagrodzenie za MM.YYYY" + umowa-zlecenie invoices ("RACHUNEK … DO UMOWY")
const T_SALARY = `(${TXT} ~ 'WYNAGRODZ|PENSJ' OR (${TXT} ~ 'RACHUNEK' AND ${TXT} ~ 'UMOW'))`;
// The bank-credit account is debt, not operating cash: its inflows are our own
// loan repayments (real expense = the outgoing transfer from the main account) and
// the bank charges interest on it without :61: entries. Exclude it from operating
// buckets and balances entirely.
const CREDIT_ACCOUNTS = `coalesce(account,'') IN ('PL75109025900000000158258415')`;
const OPER = `NOT ${CREDIT_ACCOUNTS}`;
const BUCKET: Record<string, string> = {
  income: `${OPER} AND direction='in' AND NOT (${T_INTERNAL}) AND NOT (${T_VATREF}) AND NOT (${T_VATMOVE}) AND NOT (${T_CASHDEP})`,
  // expenses INCLUDE salaries (they show as a category in the breakdown);
  // owner payouts stay separate; PRZEKS + outgoing VAT-split legs are internal VAT moves
  expenses: `${OPER} AND direction='out' AND NOT (${T_INTERNAL}) AND NOT (${T_CASH}) AND NOT (${TXT} ~ 'PRZEKS') AND NOT (${T_VATSPLIT_OUT}) AND NOT (${T_OWNER_ANY})`,
  cash: `${OPER} AND direction='out' AND (${T_CASH})`,
  cashdep: `${OPER} AND direction='in' AND (${T_CASHDEP})`,
  owner_roman: `${OPER} AND direction='out' AND NOT (${T_INTERNAL}) AND NOT (${T_CASH}) AND ${T_OWNER_ROMAN}`,
  owner_tetiana: `${OPER} AND direction='out' AND NOT (${T_INTERNAL}) AND NOT (${T_CASH}) AND ${T_OWNER_TETIANA}`,
  owner_yuriy: `${OPER} AND direction='out' AND NOT (${T_INTERNAL}) AND NOT (${T_CASH}) AND ${T_OWNER_YURIY}`,
};
// combined cash movement (withdrawals + deposits) for the «Готівковий рух» drill-down
BUCKET.cashmove = `((${BUCKET.cash}) OR (${BUCKET.cashdep}))`;

// ── Expense categories ────────────────────────────────────────────────────────
// Every `expenses` transaction falls into exactly one category: first matching
// pattern wins (order matters — e.g. a card payment at ORLEN is fuel, not "card").
// Unmatched → "other". Assignments confirmed against the company's cost registers.
const EXPENSE_CATS: [key: string, pattern: string][] = [
  ["zus", `${TXT} ~ 'ZUS|ZAK.AD UB|SK.ADKA'`],
  ["vat", `${TXT} ~ 'SKARBOW|/SFP/|VAT-7'`],
  ["seizure", `${TXT} ~ 'EGZEKUC|KOMORNIK|ZAJ.CIE|CA. Z\\.'`],
  ["salary", T_SALARY],
  ["zaliczki", `${TXT} ~ 'ZALICZK'`],
  // all bank commissions in one place: transfers, deposits, cash withdrawals,
  // account/card/package maintenance, e-banking (GOonline), ELIXIR transfer fees
  ["fees", `${TXT} ~ 'PROWIZ|PROW-PRZEL|C38|OP.ATA ZA PROWADZENIE|OP..MIES|OP.ATA MIESI|ZA OBS.UG|WEWN.TRZNE OBCI..ENIE|OP.ATA ZA PRZELEW|OP.ATA ZA RACHUNEK|GOONLINE'`],
  ["fuel", `${TXT} ~ 'ORLEN|SHELL|CIRCLE K|LOTOS|MOYA|AMIC|PALIW|STACJA PALIW'`],
  ["housing", `${TXT} ~ 'BLUERENT|HOUSE POLAND|HOSTEL|GIMIK|BARTKOWIAK|ZALEWSKA|FSDW|NOCLEG|APART|MIESZKAN|CZYNSZ|NAJEM'`],
  ["car_repair", `${TXT} ~ 'TECHNO HOUSE|ANDRII BOIKO|BOIKO ANDRII'`],
  ["office_rent", `${TXT} ~ 'ODROW..-PIENI|PIENI..EK'`],
  ["clothing", `${TXT} ~ '\\yULAN\\y'`],
  ["multisport", `${TXT} ~ 'BENEFIT'`],
  ["trainer", `${TXT} ~ 'PALUSI.SKI|PALUSINSKI'`],
  ["leasing", `${TXT} ~ 'LEASING|VOLKSWAGEN|SANTANDER CONSUMER|AUDI|TOYOTA'`],
  ["credit", `${TXT} ~ 'KREDYT|SP.ATA KAPITA|SP.ATA ODSET'`],
  ["services", `${TXT} ~ 'TKM|RACHUNKOW|KANCELARIA|ADWOKA|NOTARI|ONESOFT|LUXMED|MEDYCZN'`],
  ["marketing", `${TXT} ~ 'FB\\.|FACEBOOK|FACEBK|GOOGLE|TIKTOK|OLX|FREELINE|META PLATFORM|OTOMOTO'`],
  ["permits", `${TXT} ~ 'WOJEWODZKI|WOJEW.DZKI|ZEZWOLEN|OP.ATA SKARBOWA'`],
  ["b2b", `${TXT} ~ 'ANDROSHCHUK|SIMONIAN'`],
  // card purchases by merchant type (cash withdrawals by card are NOT here — they're in the cash bucket)
  ["taxi", `${TXT} ~ '\\yBOLT\\y|BOLT\\.EU|\\yUBER\\y|FREENOW|ITAXI'`],
  ["travel", `${TXT} ~ 'AIRBNB|BOOKI|KIWI\\.COM|GOTOGATE|RAINBOW|HOTEL|GETYOURGUIDE|RYANAIR|WIZZ|\\yLOT\\y|BKG-|ESKY|INTERCITY|BILET\\.|DISCOVERCARS'`],
  ["shops", `${TXT} ~ 'ZABKA|.ABKA|BIEDRONKA|LIDL|AUCHAN|CARREFOUR|KAUFLAND|PEPCO|ACTION|DEALZ|STOKROTKA|LEWIATAN|TRANSGOURMET'`],
  ["tech", `${TXT} ~ 'X-KOM|MEDIA MARKT|MEDIA SATURN|EURO-NET|KOMPUTRONIK|SMARTSPOT|RTV EURO|APPLE|ALLEGRO'`],
  ["household", `${TXT} ~ '\\yOBI\\y|BRICOMAN|CASTORAMA|LEROY|JYSK|IKEA|STALPOL|TEDI|SUPERHOBBY|DEDRA|DOMATOR|MAT[- ]?BUD|\\yPSB\\y|MR.WKA|BUDOWLAN|HURTOWNIA|MERKURY|BUDMAT'`],
  ["card", `${TXT} ~ 'BEZGOT|KART. DEBET'`],
];
// per-category exclusive condition: matches its own pattern and none of the earlier ones
function catCondition(key: string): string | null {
  const idx = EXPENSE_CATS.findIndex(([k]) => k === key);
  if (idx < 0 && key !== "other") return null;
  const base = BUCKET.expenses!;
  if (key === "other") return `${base} AND NOT (${EXPENSE_CATS.map(([, p]) => `(${p})`).join(" OR ")})`;
  const earlier = EXPENSE_CATS.slice(0, idx).map(([, p]) => `(${p})`).join(" OR ");
  return `${base} AND (${EXPENSE_CATS[idx]![1]})${earlier ? ` AND NOT (${earlier})` : ""}`;
}

// period (year or year+month) → [from, to] ISO date strings
function periodRange(year: string, month?: string): [string, string] {
  if (month && /^(0[1-9]|1[0-2])$/.test(month)) {
    const last = new Date(Number(year), Number(month), 0).getDate();
    return [`${year}-${month}-01`, `${year}-${month}-${last}`];
  }
  return [`${year}-01-01`, `${year}-12-31`];
}

// ── Balance at a date ──────────────────────────────────────────────────────────
// Per account: latest statement closing ≤ date PLUS transactions booked after that
// closing up to the date. The supplement matters because some banks close statements
// mid-month (e.g. the 29th) — without it, month-boundary days would be missed.
async function balanceAt(dateStr: string, companyId: number | null): Promise<number> {
  const co = companyId ? sql`AND company_id = ${companyId}` : sql``;
  const r = await db.execute<{ bal: number }>(sql`
    WITH last_close AS (
      SELECT DISTINCT ON (account) account, closing_date, closing_balance FROM bank_statements
      WHERE closing_date <= ${dateStr} AND closing_balance IS NOT NULL AND ${sql.raw(OPER)} ${co}
      ORDER BY account, closing_date DESC
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
    SELECT CASE ${sql.raw(caseExpr)} ELSE 'other' END AS cat,
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

// Manual re-sync from Drive
router.post("/bank/sync", async (_req, res) => {
  try { ok(res, await syncBankTransactions()); }
  catch (e: any) { logger.error({ err: e?.message }, "bank sync failed"); fail(res, 500, e?.message || "sync failed"); }
});

export default router;
