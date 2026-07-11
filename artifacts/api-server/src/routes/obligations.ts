// Receivables / payables («Належності», /obligations) — who owes us and what we
// owe, per firm. Manual entries for now; the invoices tab and KSeF will add
// auto-fed rows (source != manual) later. Open items feed the net position on
// the Cashflow page.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { obligationsTable, companiesTable } from "@workspace/db";
import { and, eq, lte, desc } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";

const router: IRouter = Router();
router.use(authRequired);
router.use(requireCap("viewFinance"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const round2 = (n: number) => Math.round(n * 100) / 100;
const validDate = (d: any) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

// items open as of a date — arisen by that date and not settled yet (or settled later)
export async function openObligationRows(asOf: string) {
  const rows = await db.select().from(obligationsTable).where(lte(obligationsTable.arisenDate, asOf));
  return rows.filter(r => !(r.status === "settled" && r.settledAt != null && r.settledAt <= asOf));
}

// totals as of a date — used by /cashflow and /balance for the month-end net position
export async function openObligations(asOf: string): Promise<{ receivable: number; payable: number }> {
  let receivable = 0, payable = 0;
  for (const r of await openObligationRows(asOf)) r.direction === "receivable" ? (receivable += r.amount) : (payable += r.amount);
  return { receivable: round2(receivable), payable: round2(payable) };
}

router.get("/obligations", async (req, res) => {
  const status = req.query.status === "settled" ? "settled" : req.query.status === "all" ? null : "open";
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;
  const conds = [];
  if (status) conds.push(eq(obligationsTable.status, status));
  if (companyId) conds.push(eq(obligationsTable.companyId, companyId));
  const rows = await db.select().from(obligationsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(obligationsTable.status === undefined ? obligationsTable.id : obligationsTable.id)).limit(1000);
  let receivable = 0, payable = 0;
  for (const r of rows) if (r.status === "open") r.direction === "receivable" ? (receivable += r.amount) : (payable += r.amount);
  ok(res, { rows, totals: { receivable: round2(receivable), payable: round2(payable), net: round2(receivable - payable) } });
});

router.post("/obligations", async (req, res) => {
  const { companyId, direction, counterparty, description, amount, dueDate, arisenDate, note } = req.body ?? {};
  if (direction !== "receivable" && direction !== "payable") return fail(res, 400, "direction must be receivable|payable");
  if (!counterparty || !String(counterparty).trim()) return fail(res, 400, "counterparty required");
  const amt = Number(String(amount ?? "").replace(",", "."));
  if (!Number.isFinite(amt) || amt <= 0) return fail(res, 400, "amount must be > 0");
  if (dueDate && !validDate(dueDate)) return fail(res, 400, "dueDate must be YYYY-MM-DD");
  if (arisenDate && !validDate(arisenDate)) return fail(res, 400, "arisenDate must be YYYY-MM-DD");
  if (companyId) {
    const [co] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, Number(companyId)));
    if (!co) return fail(res, 400, "unknown company");
  }
  const [row] = await db.insert(obligationsTable).values({
    companyId: companyId ? Number(companyId) : null, direction, counterparty: String(counterparty).trim(),
    description: description ? String(description).trim() : null, amount: amt,
    dueDate: dueDate || null, arisenDate: arisenDate || new Date().toISOString().slice(0, 10),
    note: note ? String(note).trim() : null,
  }).returning();
  ok(res, row);
});

router.patch("/obligations/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(obligationsTable).where(eq(obligationsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.counterparty !== undefined) { if (!String(b.counterparty).trim()) return fail(res, 400, "counterparty required"); patch.counterparty = String(b.counterparty).trim(); }
  if (b.description !== undefined) patch.description = b.description ? String(b.description).trim() : null;
  if (b.amount !== undefined) {
    const amt = Number(String(b.amount).replace(",", "."));
    if (!Number.isFinite(amt) || amt <= 0) return fail(res, 400, "amount must be > 0");
    patch.amount = amt;
  }
  if (b.dueDate !== undefined) { if (b.dueDate && !validDate(b.dueDate)) return fail(res, 400, "bad dueDate"); patch.dueDate = b.dueDate || null; }
  if (b.arisenDate !== undefined) { if (!validDate(b.arisenDate)) return fail(res, 400, "bad arisenDate"); patch.arisenDate = b.arisenDate; }
  if (b.note !== undefined) patch.note = b.note ? String(b.note).trim() : null;
  if (b.companyId !== undefined) patch.companyId = b.companyId ? Number(b.companyId) : null;
  if (b.status !== undefined) {
    if (b.status !== "open" && b.status !== "settled") return fail(res, 400, "status must be open|settled");
    patch.status = b.status;
    patch.settledAt = b.status === "settled" ? new Date().toISOString().slice(0, 10) : null;
  }
  if (!Object.keys(patch).length) return fail(res, 400, "nothing to update");
  const [updated] = await db.update(obligationsTable).set(patch).where(eq(obligationsTable.id, id)).returning();
  ok(res, updated);
});

router.delete("/obligations/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(obligationsTable).where(eq(obligationsTable.id, id));
  ok(res, { ok: true });
});

export default router;
