// Consolidated cashflow («Кешфлоу», /cashflow) — ALL company money in one view:
// bank accounts (ES/ESO/Klinex) + cash boxes (office safe + owner safes).
// Flows are merged per category (bank transfers + cash payments), internal moves
// (bank↔kasa, box↔box, deposits) cancel out and appear only in the reconciliation.
// Owner payouts are personal draws — a separate section, not an expense category.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { cashEntriesTable, companiesTable } from "@workspace/db";
import { and, eq, gte, lte, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";
import { BUCKET, EXPENSE_CATS, MC, OPER, T_INTERNAL, T_VATREF, T_VATMOVE, T_VATSPLIT_OUT, T_CASHDEP, TXT, catCondition, periodRange } from "../services/bankClassify";
import { balanceAt } from "./bank";
import { cashPosition, cashBoxesAt, cashCategory } from "./cash";
import { openObligations, openObligationRows } from "./obligations";
import { unpaidInvoicesAt } from "./invoices";
import { ksefReceivablesAt } from "../services/ksef";

const router: IRouter = Router();
router.use(authRequired);
router.use(requireCap("viewFinance"));

const ok = (res: any, data: any) => res.json(data);
const rowsOf = (r: any): any[] => r?.rows ?? r ?? [];
const round2 = (n: number) => Math.round(n * 100) / 100;

router.get("/cashflow", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const [from, to] = periodRange(year, month);
  const fromM = from.slice(0, 7), toM = to.slice(0, 7);
  const prevEnd = new Date(new Date(from + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);

  // ── bank side: buckets + expense categories (same single source as /bank) ────
  const SIGNED = `CASE WHEN direction='in' THEN amount ELSE -amount END`;
  const groups: Record<string, string> = {
    income: BUCKET.income!,
    vat_refund: `direction='in' AND NOT (${T_INTERNAL}) AND (${T_VATREF})`,
    cash: BUCKET.cash!, cashdep: BUCKET.cashdep!,
    owner_roman: BUCKET.owner_roman!, owner_tetiana: BUCKET.owner_tetiana!, owner_yuriy: BUCKET.owner_yuriy!,
    vat_moves: `(NOT (${T_INTERNAL}) AND (${TXT} ~ 'PRZEKS' OR (direction='out' AND ${T_VATSPLIT_OUT}) OR (direction='in' AND ${T_VATMOVE} AND NOT (${T_VATREF}) AND NOT (${T_CASHDEP}))))`,
    internal: `(${T_INTERNAL})`,
  };
  const parts = Object.entries(groups).map(([k, cond]) => `coalesce(sum(amount) FILTER (WHERE ${cond}), 0) AS "${k}", coalesce(sum(${SIGNED}) FILTER (WHERE ${cond}), 0) AS "${k}_net"`).join(", ");
  const agg: any = rowsOf(await db.execute(sql`
    SELECT ${sql.raw(parts)}, coalesce(sum(${sql.raw(SIGNED)}), 0) AS net_flow
    FROM bank_transactions WHERE ${sql.raw(OPER)} AND value_date >= ${from} AND value_date <= ${to}`))[0] ?? {};
  const num = (v: any) => round2(Number(v ?? 0));

  const caseExpr = EXPENSE_CATS.map(([k, p]) => `WHEN (${p}) THEN '${k}'`).join(" ");
  const bankCats: Record<string, number> = {};
  for (const r of rowsOf(await db.execute(sql`
    SELECT CASE WHEN ${sql.raw(MC)} IS NOT NULL THEN ${sql.raw(MC)} ${sql.raw(caseExpr)} ELSE 'other' END AS cat,
           coalesce(sum(amount), 0) AS total
    FROM bank_transactions
    WHERE ${sql.raw(BUCKET.expenses!)} AND value_date >= ${from} AND value_date <= ${to}
    GROUP BY 1`))) bankCats[String((r as any).cat)] = num((r as any).total);

  // ── cash side: classify outflows, total inflows (transfers cancel out) ───────
  const entries = await db.select().from(cashEntriesTable)
    .where(and(gte(cashEntriesTable.periodMonth, fromM), lte(cashEntriesTable.periodMonth, toM), isNull(cashEntriesTable.transferGroup)));
  const cashCats: Record<string, number> = {};
  const cashOwners: Record<string, number> = { owner_roman: 0, owner_tetiana: 0, owner_yuriy: 0 };
  let kasaIn = 0, kasaDeposits = 0;
  for (const e of entries) {
    if (e.kind === "in") { kasaIn += e.amount; continue; }
    if (e.kind !== "out") continue;
    const cat = cashCategory(e) ?? "other";
    if (cat === "deposit") kasaDeposits += e.amount;
    else if (cat in cashOwners) cashOwners[cat]! += e.amount;
    else cashCats[cat] = round2((cashCats[cat] ?? 0) + e.amount);
  }

  // ── positions ─────────────────────────────────────────────────────────────────
  // obligations & unpaid invoices as of the END of the selected period
  const [bankOpen, bankClose, cashPos, obligationsRaw, unpaidInv, ksefRecv] = await Promise.all([
    balanceAt(prevEnd, null), balanceAt(to, null), cashPosition(fromM, toM), openObligations(to), unpaidInvoicesAt(to), ksefReceivablesAt(to),
  ]);
  const unpaidInvoices = unpaidInv.total;
  // «нам винні» = ручні належності + наші неоплачені фактури з KSeF на кінець
  // періоду; непокриті коректи клієнтам — на бік «ми винні»
  const obligations = {
    ...obligationsRaw,
    receivable: round2(obligationsRaw.receivable + ksefRecv.total),
    payable: round2(obligationsRaw.payable + ksefRecv.credits.total),
  };

  // ── merge per category ────────────────────────────────────────────────────────
  const keys = new Set([...Object.keys(bankCats), ...Object.keys(cashCats)]);
  const expenses = [...keys].map(key => ({
    key, bank: round2(bankCats[key] ?? 0), cash: round2(cashCats[key] ?? 0),
    total: round2((bankCats[key] ?? 0) + (cashCats[key] ?? 0)),
  })).sort((a, b) => b.total - a.total);
  const owners = (["owner_roman", "owner_tetiana", "owner_yuriy"] as const).map(key => ({
    key, bank: num(agg[key]), cash: round2(cashOwners[key] ?? 0),
    total: round2(num(agg[key]) + (cashOwners[key] ?? 0)),
  }));

  // ── conservation: ΔM = income + vatref − expenses − owners
  //    + (kasaIn − withdrawn) + (bank deposits − kasa deposit records) ± vat/internal nets
  const income = num(agg.income), vatRefund = num(agg.vat_refund);
  const expensesTotal = round2(expenses.reduce((s, e) => s + e.total, 0));
  const ownersTotal = round2(owners.reduce((s, o) => s + o.total, 0));
  const cashGap = round2(kasaIn - num(agg.cash));          // готівка: вписано в касу мінус знято з банку
  const depositGap = round2(num(agg.cashdep) - kasaDeposits); // вплачено на рахунок мінус записано в касі
  const vatMovesNet = num(agg.vat_moves_net), internalNet = num(agg.internal_net);
  const opening = round2(bankOpen + cashPos.opening);
  const closing = round2(bankClose + cashPos.closing);
  const computedClosing = round2(opening + income + vatRefund - expensesTotal - ownersTotal + cashGap + depositGap + vatMovesNet + internalNet);

  ok(res, {
    year, month: month ?? null, from, to,
    opening: { banks: round2(bankOpen), cash: round2(cashPos.opening), total: opening },
    closing: { banks: round2(bankClose), cash: round2(cashPos.closing), total: closing },
    delta: round2(closing - opening),
    inflows: { income, vatRefund, total: round2(income + vatRefund) },
    expenses, expensesTotal,
    owners, ownersTotal,
    internal: {
      bankWithdrawn: num(agg.cash), kasaIn: round2(kasaIn), cashGap,
      bankDeposits: num(agg.cashdep), kasaDeposits: round2(kasaDeposits), depositGap,
      vatMovesNet, internalNet,
    },
    // receivables/payables as of the period end → month-end net financial position;
    // unpaid cost invoices join the payable side automatically
    asOf: to,
    obligations: { receivable: obligations.receivable, payable: round2(obligations.payable + unpaidInvoices), unpaidInvoices },
    netPosition: round2(closing + obligations.receivable - obligations.payable - unpaidInvoices),
    reconcile: { computedClosing, residual: round2(closing - computedClosing) },
  });
});

// ── Drill-down list («Кешфлоу» → клік по категорії/пошук) ────────────────────
// Merged movements for the period: bank transactions (same single-source SQL
// classification as the aggregates above) + cash-box entries (cashCategory).
// cat: expense key | "other" | owner_* | "income" | "vat_refund" | "" (everything).
router.get("/cashflow/entries", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const [from, to] = periodRange(year, month);
  const fromM = from.slice(0, 7), toM = to.slice(0, 7);
  const cat = String(req.query.cat ?? "");
  const source = req.query.source === "bank" || req.query.source === "cash" ? String(req.query.source) : "";
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;
  const q = String(req.query.q ?? "").trim();
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  let bankCond: string | null;
  if (!cat) bankCond = OPER;
  else if (cat === "income") bankCond = BUCKET.income!;
  else if (cat === "vat_refund") bankCond = `direction='in' AND NOT (${T_INTERNAL}) AND (${T_VATREF})`;
  else if (cat.startsWith("owner_") && BUCKET[cat]) bankCond = BUCKET[cat]!;
  else bankCond = catCondition(cat);
  if (!bankCond) { res.status(400).json({ error: "unknown cat" }); return; }
  // готівкова сторона є лише у витратних категорій і виплат власникам
  const cashApplicable = !cat || cat === "other" || cat.startsWith("owner_") || EXPENSE_CATS.some(([k]) => k === cat);

  // bank side: top-(offset+limit) rows by date + full count/sums for the filter
  let bankRows: any[] = [], bankTotal = 0, bankIn = 0, bankOut = 0;
  if (source !== "cash") {
    const co = companyId ? sql`AND company_id = ${companyId}` : sql``;
    const qq = q ? sql`AND (counterparty ILIKE ${"%" + q + "%"} OR title ILIKE ${"%" + q + "%"} OR tx_type ILIKE ${"%" + q + "%"})` : sql``;
    const base = sql`FROM bank_transactions WHERE ${sql.raw(bankCond)} AND value_date >= ${from} AND value_date <= ${to} ${co} ${qq}`;
    const [rowsR, aggR] = await Promise.all([
      db.execute(sql`SELECT id, company_id, value_date, direction, amount, counterparty, title, tx_type, account, manual_category ${base} ORDER BY value_date DESC, id DESC LIMIT ${offset + limit}`),
      db.execute(sql`SELECT count(*) AS n,
        coalesce(sum(amount) FILTER (WHERE direction='in'), 0) AS s_in,
        coalesce(sum(amount) FILTER (WHERE direction='out'), 0) AS s_out ${base}`),
    ]);
    bankRows = rowsOf(rowsR);
    const a: any = rowsOf(aggR)[0] ?? {};
    bankTotal = Number(a.n ?? 0); bankIn = Number(a.s_in ?? 0); bankOut = Number(a.s_out ?? 0);
  }

  // cash side: a period holds dozens of rows — load & classify in JS (single
  // source: cashCategory), so no SQL duplicate of the CASH_AUTO patterns
  let cashRows: (typeof cashEntriesTable.$inferSelect)[] = [];
  if (source !== "bank" && cashApplicable) {
    const conds = [gte(cashEntriesTable.periodMonth, fromM), lte(cashEntriesTable.periodMonth, toM), isNull(cashEntriesTable.transferGroup)];
    if (companyId) conds.push(eq(cashEntriesTable.companyId, companyId));
    const entries = await db.select().from(cashEntriesTable).where(and(...conds));
    const ql = q.toLowerCase();
    cashRows = entries.filter(e => {
      if (e.kind !== "in" && e.kind !== "out") return false;
      if (cat && (e.kind !== "out" || (cashCategory(e) ?? "other") !== cat)) return false;
      if (ql && !`${e.description ?? ""} ${e.note ?? ""}`.toLowerCase().includes(ql)) return false;
      return true;
    });
  }
  const cashIn = round2(cashRows.filter(e => e.kind === "in").reduce((s, e) => s + e.amount, 0));
  const cashOut = round2(cashRows.filter(e => e.kind === "out").reduce((s, e) => s + e.amount, 0));

  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable);
  const coName = (id: number | null) => companies.find(c => c.id === id)?.name ?? null;
  // merged page: bank top-(offset+limit) ∪ ALL matching cash rows covers the true
  // top-(offset+limit) of the union, so the slice below is a correct page
  const unified = [
    ...bankRows.map((r: any) => ({
      id: `b${r.id}`, source: "bank" as const, date: String(r.value_date), firm: coName(r.company_id),
      direction: r.direction as "in" | "out", amount: round2(Number(r.amount)),
      who: r.counterparty ?? null, title: r.title ?? null, txType: r.tx_type ?? null,
      account: r.account ?? null, box: null as string | null, manualCategory: r.manual_category ?? null,
    })),
    ...cashRows.map(e => ({
      id: `c${e.id}`, source: "cash" as const, date: e.entryDate ?? `${e.periodMonth}-01`, firm: coName(e.companyId),
      direction: (e.kind === "in" ? "in" : "out") as "in" | "out", amount: round2(e.amount),
      who: e.description ?? null, title: e.note ?? null, txType: null, account: null,
      box: e.box ?? null, manualCategory: e.manualCategory ?? null,
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  ok(res, {
    year, month: month ?? null, cat: cat || null, from, to,
    rows: unified.slice(offset, offset + limit),
    total: bankTotal + cashRows.length, limit, offset,
    sums: { in: round2(bankIn + cashIn), out: round2(bankOut + cashOut), bank: round2(bankIn + bankOut), cash: round2(cashIn + cashOut) },
  });
});

// ── Balance («Баланс», /balance) — snapshot at the END of the selected month ──
// Money (banks per firm + cash per box) + receivables − payables (manual items
// open at the date + unpaid cost invoices) = net position.
router.get("/balance", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const [, to] = periodRange(year, month);
  const toM = to.slice(0, 7);

  const companies = (await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.isActive, true)))
    .filter(c => ["ES", "ESO", "Klinex"].includes(c.name));
  const [bankTotal, cashBoxes, obRows, unpaidInv, ksefRecv, ...perFirm] = await Promise.all([
    balanceAt(to, null), cashBoxesAt(toM), openObligationRows(to), unpaidInvoicesAt(to), ksefReceivablesAt(to),
    ...companies.map(c => balanceAt(to, c.id)),
  ]);

  const receivables = obRows.filter(r => r.direction === "receivable");
  const payables = obRows.filter(r => r.direction === "payable");
  // manual receivables + our issued invoices unpaid at the date (KSeF × bank);
  // clients netting negative (uncovered korekty) land on the payable side
  const receivableTotal = round2(receivables.reduce((s, r) => s + r.amount, 0) + ksefRecv.total);
  const payableTotal = round2(payables.reduce((s, r) => s + r.amount, 0) + unpaidInv.total + ksefRecv.credits.total);
  const moneyTotal = round2(bankTotal + cashBoxes.total);
  const pick = (r: any) => ({
    id: r.id, counterparty: r.counterparty, description: r.description, amount: r.amount,
    dueDate: r.dueDate, companyId: r.companyId, arisenDate: r.arisenDate, status: r.status,
    settledAt: r.settledAt, note: r.note, source: r.source, direction: r.direction,
  });

  ok(res, {
    year, month: month ?? null, asOf: to,
    money: {
      total: moneyTotal,
      banks: { total: round2(bankTotal), perFirm: companies.map((c, i) => ({ companyId: c.id, name: c.name, amount: round2(perFirm[i] ?? 0) })) },
      cash: { total: cashBoxes.total, perBox: cashBoxes.perBox },
    },
    receivables: { total: receivableTotal, ksef: ksefRecv, rows: receivables.map(pick) },
    payables: { total: payableTotal, unpaidInvoices: unpaidInv, ksefCredits: ksefRecv.credits, rows: payables.map(pick) },
    netPosition: round2(moneyTotal + receivableTotal - payableTotal),
  });
});

export default router;
