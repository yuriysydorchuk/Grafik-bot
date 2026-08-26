// «KSeF» (/ksef) — sales invoices mirrored from KSeF: list per revenue month,
// totals per client, payment status (strict bank match + manual override).
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { ksefInvoicesTable, companiesTable } from "@workspace/db";
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { archiveInvoicesToDrive } from "../services/invoiceArchive";
import { logInvoiceAudit, auditDiff } from "../services/invoiceAudit";
import { authRequired, requireAnyCap, type AuthedRequest } from "../lib/auth";
import { syncKsef, matchKsefPayments, feedPnlRevenue } from "../services/ksef";

const router: IRouter = Router();
router.use(authRequired);
// скоуп по префіксу; costInvoices — бухгалтерія веде і спшедажові (розділ на /cost-invoices, рішення 26.08.2026)
router.use("/ksef", requireAnyCap("viewFinance", "costInvoices"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const r2 = (n: number) => Math.round(n * 100) / 100;
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const validDate = (s: any) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const validKind = (k: any): "sale" | "purchase" => (k === "purchase" ? "purchase" : "sale");

router.get("/ksef/months", async (req, res) => {
  const kind = validKind(req.query.kind);
  // продажі: wspólnoty (segment=cleaning) живуть у розділі «Прибирання», не тут
  const r: any = kind === "sale"
    ? await db.execute(sql`SELECT DISTINCT revenue_month AS m FROM ksef_invoices WHERE kind = 'sale' AND segment <> 'cleaning' ORDER BY 1 DESC`)
    : await db.execute(sql`SELECT DISTINCT revenue_month AS m FROM ksef_invoices WHERE kind = ${kind} ORDER BY 1 DESC`);
  ok(res, { months: ((r.rows ?? r) as any[]).map(x => String(x.m)) });
});

router.get("/ksef", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const companyId = Number(req.query.companyId) || null;
  const kind = validKind(req.query.kind);

  const conds = [eq(ksefInvoicesTable.revenueMonth, month), eq(ksefInvoicesTable.kind, kind)];
  // фактури на вспульноти (segment=cleaning) — у розділі «Прибирання», не в спшедажових
  if (kind === "sale") conds.push(sql`${ksefInvoicesTable.segment} <> 'cleaning'`);
  if (companyId) conds.push(eq(ksefInvoicesTable.companyId, companyId));
  const rows = await db.select().from(ksefInvoicesTable).where(and(...conds))
    .orderBy(asc(ksefInvoicesTable.companyId), desc(ksefInvoicesTable.issueDate), asc(ksefInvoicesTable.invoiceNumber));
  const companies = new Map((await db.select().from(companiesTable)).map(c => [c.id, c.name]));

  const invoices = rows.map(inv => {
    // manual override wins; otherwise the bank match decides
    const paid = inv.manualStatus ? inv.manualStatus === "paid" : inv.paidDate != null;
    const paidDate = inv.manualStatus === "paid" ? inv.manualPaidDate ?? inv.paidDate : inv.manualStatus ? null : inv.paidDate;
    // paid_via records HOW the auto-match decided (bank/register/korekta); older
    // rows without it fall back to txn-presence inference
    const paidSource = inv.manualStatus ? "manual" : inv.paidDate ? inv.paidVia ?? (inv.paidTxnId ? "bank" : "register") : null;
    // на Диск їде лише PDF (26.08) — «залито» означає «є PDF-візуалізація»
    return { ...inv, firm: companies.get(inv.companyId) ?? "?", paid, effPaidDate: paidDate, paidSource, driveFileId: inv.drivePdfId };
  });

  // sales group by client, purchases by supplier
  const byClient = new Map<string, { client: string; count: number; net: number; gross: number; unpaidGross: number }>();
  for (const inv of invoices) {
    const label = kind === "purchase" ? inv.sellerName ?? "—" : inv.clientLabel ?? inv.buyerName ?? "—";
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
    month, kind, invoices,
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
  {
    const adm = (req as AuthedRequest).admin;
    const changes = auditDiff(inv as any, patch);
    if (changes.length) await logInvoiceAudit("ksef", id, "updated", { adminId: adm?.adminId, name: adm?.name }, changes);
  }
  ok(res, updated);
});

router.post("/ksef/sync", async (_req, res) => {
  ok(res, await syncKsef());
});

// Разовий пуш однієї фактури в архів на Drive (кнопка в рядку /ksef);
// заодно з XML підтягуються термін оплати і форма оплати
router.post("/ksef/invoices/:id/drive", async (req, res) => {
  const id = Number(req.params.id);
  const [inv] = await db.select().from(ksefInvoicesTable).where(eq(ksefInvoicesTable.id, id));
  if (!inv) return fail(res, 404, "not found");
  const r = await archiveInvoicesToDrive({ ksefIds: [id], force: true });
  if (r.alreadyRunning) return fail(res, 409, "Архів уже виконується у фоні — спробуй за хвилину");
  if (r.errors.length) return fail(res, 502, r.errors[0]!);
  const [updated] = await db.select().from(ksefInvoicesTable).where(eq(ksefInvoicesTable.id, id));
  ok(res, { driveFileId: updated?.drivePdfId ?? null, driveError: updated?.driveError ?? null });
});

// Залити на Drive всі фактури місяця вкладки (sale АБО purchase), крім уже
// залитих. Місяць — той, яким групує сторінка (revenue_month: для продажів це
// «місяць роботи», папка на Диску все одно за датою виставлення).
router.post("/ksef/drive-month", async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const kind = validKind(req.body?.kind);
  const ids = (await db.select({ id: ksefInvoicesTable.id }).from(ksefInvoicesTable)
    .where(and(eq(ksefInvoicesTable.revenueMonth, month), eq(ksefInvoicesTable.kind, kind),
      or(isNull(ksefInvoicesTable.drivePdfId), isNotNull(ksefInvoicesTable.driveFileId))!)))
    .map(r => r.id);
  if (!ids.length) return ok(res, { processed: 0, uploaded: 0, failed: 0, errors: [] });
  const r = await archiveInvoicesToDrive({ ksefIds: ids });
  if (r.alreadyRunning) return fail(res, 409, "Архів уже виконується у фоні — спробуй за хвилину");
  ok(res, r);
});

router.post("/ksef/rematch", async (_req, res) => {
  const { relabelKsefClients } = await import("../services/ksef");
  const relabeled = await relabelKsefClients(); // NIP-привʼязка клієнтів з довідника фабрик
  const matched = await matchKsefPayments();
  ok(res, { matched, relabeled });
});

export default router;
