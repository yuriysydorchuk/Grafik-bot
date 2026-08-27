// «Прибирання» (/cleaning, cap `cleaning`) — окремий під-бізнес: прибирання
// wspólnot mieszkaniowych. Розділ повністю самодостатній (роль може бачити ЛИШЕ його):
//   - Вспульноти (проєкти): реєстр, сідиться з KSeF-продажів сегмента cleaning по NIP;
//   - Дохід: KSeF-фактури продажу на вспульноти (segment=cleaning), акруал M−1
//     (revenue_month — як у P&L), матч до проєкту по NIP ?? ручна привʼязка;
//   - Винагродження: вільний список людей по місяцях (години×ставка + складові),
//     поділ конто/готівка; ЗП ділиться ПОРІВНУ між привʼязаними вспульнотами;
//   - Видатки: фактури, позначені «на прибирання» (локальні invoices.cleaning +
//     KSeF-закупівлі segment=cleaning) і готівкові видатки каси з cleaning-категорій;
//   - P&L: по кожній вспульноті окремо і разом, по місяцях року.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  cleaningProjectsTable, cleaningPayrollsTable, cleaningPayrollProjectsTable,
  cleaningWorkersTable, cleaningWorkerRatesTable, payrollOfficeRowsTable,
  invoicesTable, ksefInvoicesTable, cashEntriesTable, cashCategoriesTable, companiesTable,
} from "@workspace/db";
import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";
import { CLEANING_OFFICE_RE } from "./pnl";
import { calcPayroll } from "../lib/payroll";

const router: IRouter = Router();
router.use(authRequired);
// скоуп по префіксу — роль «прибирання» не мусить проходити гейти сусідніх роутерів
router.use("/cleaning", requireCap("cleaning"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const r2 = (n: number) => Math.round(n * 100) / 100;
const validMonth = (s: any) => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const validYear = (s: any) => typeof s === "string" && /^\d{4}$/.test(s);
const normNip = (s: any) => String(s ?? "").replace(/\D/g, "");

// ── Складові винагородження: [{label, amount}] — amount може бути відʼємним ────
type Component = { label: string; amount: number };
function parseComponents(v: any): Component[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: Component[] = [];
  for (const c of v) {
    const amount = Number(String(c?.amount ?? "").replace(",", "."));
    if (!Number.isFinite(amount) || amount === 0) return null;
    out.push({ label: String(c?.label ?? "").trim(), amount: r2(amount) });
  }
  return out;
}
// Разом = podstawa + додаткові години×ставка + Σ складових
const payrollTotal = (base: number, hours: number | null, rate: number | null, comps: Component[]) =>
  r2(base + (hours && rate ? hours * rate : 0) + comps.reduce((s, c) => s + c.amount, 0));

// Резолюція «фактура → проєкт»: ручна привʼязка (cleaning_project_id) має
// пріоритет, далі — NIP покупця з реєстру вспульнот.
function projectResolver(projects: { id: number; nip: string | null }[]) {
  const byNip = new Map<string, number>();
  for (const p of projects) if (p.nip) byNip.set(normNip(p.nip), p.id);
  return (manualId: number | null, nip: string | null | undefined): number | null =>
    manualId ?? (nip ? byNip.get(normNip(nip)) ?? null : null);
}

// ── Вспульноти (проєкти) ───────────────────────────────────────────────────────
router.get("/cleaning/projects", async (_req, res) => {
  const projects = await db.select().from(cleaningProjectsTable).orderBy(cleaningProjectsTable.name);
  ok(res, { projects });
});

router.post("/cleaning/projects", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return fail(res, 400, "name required");
  const nip = normNip(req.body?.nip);
  if (nip && nip.length !== 10) return fail(res, 400, "NIP — 10 цифр");
  if (nip) {
    const [dup] = await db.select({ id: cleaningProjectsTable.id }).from(cleaningProjectsTable).where(eq(cleaningProjectsTable.nip, nip));
    if (dup) return fail(res, 409, "Вспульнота з таким NIP уже є");
  }
  const [row] = await db.insert(cleaningProjectsTable).values({
    name, nip: nip || null, note: String(req.body?.note ?? "").trim() || null,
  }).returning();
  ok(res, row);
});

router.patch("/cleaning/projects/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(cleaningProjectsTable).where(eq(cleaningProjectsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) return fail(res, 400, "name required"); patch.name = n; }
  if (b.nip !== undefined) {
    const nip = normNip(b.nip);
    if (nip && nip.length !== 10) return fail(res, 400, "NIP — 10 цифр");
    if (nip && nip !== row.nip) {
      const [dup] = await db.select({ id: cleaningProjectsTable.id }).from(cleaningProjectsTable).where(eq(cleaningProjectsTable.nip, nip));
      if (dup) return fail(res, 409, "Вспульнота з таким NIP уже є");
    }
    patch.nip = nip || null;
  }
  if (b.active !== undefined) patch.active = !!b.active;
  if (b.note !== undefined) patch.note = String(b.note ?? "").trim() || null;
  if (!Object.keys(patch).length) return fail(res, 400, "nothing to update");
  const [updated] = await db.update(cleaningProjectsTable).set(patch).where(eq(cleaningProjectsTable.id, id)).returning();
  ok(res, updated);
});

router.delete("/cleaning/projects/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(cleaningProjectsTable).where(eq(cleaningProjectsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  // проєкт із привʼязками (ЗП/фактури) не видаляється — деактивуй
  const refs: any = await db.execute(sql`
    SELECT (SELECT count(*) FROM cleaning_payroll_projects WHERE project_id = ${id})
         + (SELECT count(*) FROM ksef_invoices WHERE cleaning_project_id = ${id})
         + (SELECT count(*) FROM invoices WHERE cleaning_project_id = ${id}) AS n`);
  const n = Number(((refs.rows ?? refs) as any[])[0]?.n ?? 0);
  if (n > 0) {
    await db.update(cleaningProjectsTable).set({ active: false }).where(eq(cleaningProjectsTable.id, id));
    return ok(res, { deactivated: true });
  }
  await db.delete(cleaningProjectsTable).where(eq(cleaningProjectsTable.id, id));
  ok(res, { deleted: true });
});

// Сідинг з KSeF: покупці фактур продажу сегмента cleaning, яких ще нема в
// реєстрі (по NIP), стають проєктами. Повторний запуск додає лише нових.
router.post("/cleaning/projects/seed", async (_req, res) => {
  const sales = await db.select({
    nip: ksefInvoicesTable.buyerNip, name: ksefInvoicesTable.buyerName,
  }).from(ksefInvoicesTable)
    .where(and(eq(ksefInvoicesTable.kind, "sale"), eq(ksefInvoicesTable.segment, "cleaning")));
  const existing = new Set((await db.select({ nip: cleaningProjectsTable.nip }).from(cleaningProjectsTable))
    .map(p => normNip(p.nip)).filter(Boolean));
  const seen = new Set<string>();
  let created = 0;
  for (const s of sales) {
    const nip = normNip(s.nip);
    if (!nip || existing.has(nip) || seen.has(nip)) continue;
    seen.add(nip);
    await db.insert(cleaningProjectsTable).values({ name: (s.name ?? nip).trim(), nip });
    created++;
  }
  ok(res, { created });
});

// ── Дохід: KSeF-продажі на вспульноти ─────────────────────────────────────────
// month=YYYY-MM — один місяць; year=YYYY — цілий рік. Місяць — за ДАТОЮ
// ВИСТАВЛЕННЯ (issue_date; рішення 24.08.2026 — фактура прибирання виставляється
// в місяці послуги, зсув M−1 глобального P&L тут не діє). Рядок несе projectId
// (ручний ?? NIP-матч).
router.get("/cleaning/income", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  const year = validYear(req.query.year) ? String(req.query.year) : null;
  if (!month && !year) return fail(res, 400, "month=YYYY-MM або year=YYYY");
  const conds = [eq(ksefInvoicesTable.kind, "sale"), eq(ksefInvoicesTable.segment, "cleaning")];
  conds.push(month
    ? sql`to_char(${ksefInvoicesTable.issueDate}, 'YYYY-MM') = ${month}`
    : sql`to_char(${ksefInvoicesTable.issueDate}, 'YYYY') = ${year}`);
  const invoices = await db.select().from(ksefInvoicesTable).where(and(...conds)).orderBy(desc(ksefInvoicesTable.issueDate));
  const projects = await db.select().from(cleaningProjectsTable);
  const firms = new Map((await db.select().from(companiesTable)).map(c => [c.id, c.name]));
  const resolve = projectResolver(projects);
  const rows = invoices.map(inv => {
    const paid = inv.manualStatus ? inv.manualStatus === "paid" : inv.paidDate != null;
    return {
      id: inv.id, month: String(inv.issueDate).slice(0, 7), issueDate: inv.issueDate,
      number: inv.invoiceNumber, firm: firms.get(inv.companyId) ?? null,
      buyerName: inv.buyerName, buyerNip: inv.buyerNip,
      net: inv.net, gross: inv.gross, paid,
      paidDate: inv.manualStatus === "paid" ? inv.manualPaidDate ?? inv.paidDate : inv.manualStatus ? null : inv.paidDate,
      drivePdfId: inv.drivePdfId,
      projectId: resolve(inv.cleaningProjectId, inv.buyerNip),
      projectManual: inv.cleaningProjectId != null,
    };
  });
  ok(res, {
    rows, projects,
    totals: {
      net: r2(rows.reduce((s, x) => s + x.net, 0)),
      gross: r2(rows.reduce((s, x) => s + x.gross, 0)),
      unpaidGross: r2(rows.filter(x => !x.paid).reduce((s, x) => s + x.gross, 0)),
      count: rows.length,
      unmatched: rows.filter(x => x.projectId == null).length,
    },
  });
});

// Ручна привʼязка фактури доходу до вспульноти (для покупців без NIP у реєстрі)
router.patch("/cleaning/income/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [inv] = await db.select().from(ksefInvoicesTable)
    .where(and(eq(ksefInvoicesTable.id, id), eq(ksefInvoicesTable.kind, "sale"), eq(ksefInvoicesTable.segment, "cleaning")));
  if (!inv) return fail(res, 404, "not found");
  const pid = req.body?.projectId ? Number(req.body.projectId) : null;
  if (pid !== null) {
    const [p] = await db.select({ id: cleaningProjectsTable.id }).from(cleaningProjectsTable).where(eq(cleaningProjectsTable.id, pid));
    if (!p) return fail(res, 400, "unknown project");
  }
  const [updated] = await db.update(ksefInvoicesTable).set({ cleaningProjectId: pid }).where(eq(ksefInvoicesTable.id, id)).returning();
  ok(res, { id: updated!.id, projectId: updated!.cleaningProjectId });
});

// ── Працівники прибирання (довідник; фірма Klinex і посада sprzątanie — статичні) ──
// Оплата — позиціями (cleaning_worker_rates): вспульнота(и) → фіксована сума за
// позицію ЦІЛКОМ («3 вспульноти за 2500») АБО % від місячної ЗП. Режими в межах
// людини не змішуються.
type RateIn = { projectIds: number[]; amount: number | null; pct: number | null; note: string | null };
function parseRates(v: any, knownIds: Set<number>): { err?: string; rates?: RateIn[] } {
  if (v === undefined || v === null) return { rates: [] };
  if (!Array.isArray(v)) return { err: "rates: array" };
  const rates: RateIn[] = [];
  for (const r of v) {
    const pids: number[] = Array.isArray(r?.projectIds) ? [...new Set<number>((r.projectIds as any[]).map(Number))] : [];
    if (pids.some((x: number) => !knownIds.has(x))) return { err: "rates: невідома вспульнота" };
    const amount = r?.amount != null && r.amount !== "" ? Number(String(r.amount).replace(",", ".")) : null;
    const pct = r?.pct != null && r.pct !== "" ? Number(String(r.pct).replace(",", ".")) : null;
    if ((amount == null) === (pct == null)) return { err: "rates: позиція — сума АБО відсоток" };
    if (amount != null && (!Number.isFinite(amount) || amount <= 0)) return { err: "rates: сума > 0" };
    if (pct != null && (!Number.isFinite(pct) || pct <= 0 || pct > 100)) return { err: "rates: відсоток 0–100" };
    // фіксована позиція БЕЗ вспульнот — легальна «загальна podstawa» (людина без
    // відомої вспульноти: Irek, Aneta…) — іде в base, у P&L не атрибутується;
    // відсоткова позиція без вспульнот безглузда
    if (pct != null && !pids.length) return { err: "rates: відсоткова позиція мусить мати вспульноти" };
    rates.push({ projectIds: pids, amount: amount != null ? r2(amount) : null, pct, note: String(r?.note ?? "").trim() || null });
  }
  if (rates.some(r => r.amount != null) && rates.some(r => r.pct != null)) return { err: "rates: не змішуй суми і відсотки в однієї людини" };
  const pctSum = rates.reduce((s, r) => s + (r.pct ?? 0), 0);
  if (pctSum > 100.001) return { err: "rates: сума відсотків не може перевищувати 100" };
  return { rates };
}

async function workerWithRates(id: number) {
  const [w] = await db.select().from(cleaningWorkersTable).where(eq(cleaningWorkersTable.id, id));
  if (!w) return null;
  const rates = await db.select().from(cleaningWorkerRatesTable).where(eq(cleaningWorkerRatesTable.workerId, id)).orderBy(cleaningWorkerRatesTable.id);
  const fixedTotal = r2(rates.reduce((s, r) => s + (r.amount ?? 0), 0));
  return { ...w, rates, fixedTotal };
}

router.get("/cleaning/workers", async (_req, res) => {
  const workers = await db.select().from(cleaningWorkersTable)
    .orderBy(cleaningWorkersTable.lastName, cleaningWorkersTable.firstName);
  const rates = await db.select().from(cleaningWorkerRatesTable).orderBy(cleaningWorkerRatesTable.id);
  const byWorker = new Map<number, typeof rates>();
  for (const r of rates) (byWorker.get(r.workerId) ?? byWorker.set(r.workerId, []).get(r.workerId)!).push(r);
  const projects = await db.select().from(cleaningProjectsTable).orderBy(cleaningProjectsTable.name);
  ok(res, {
    workers: workers.map(w => {
      const rs = byWorker.get(w.id) ?? [];
      return { ...w, rates: rs, fixedTotal: r2(rs.reduce((s, r) => s + (r.amount ?? 0), 0)) };
    }),
    projects,
  });
});

async function replaceWorkerRates(workerId: number, rates: RateIn[]) {
  await db.delete(cleaningWorkerRatesTable).where(eq(cleaningWorkerRatesTable.workerId, workerId));
  for (const r of rates) {
    await db.insert(cleaningWorkerRatesTable).values({
      workerId, projectIds: r.projectIds, amount: r.amount, pct: r.pct, note: r.note,
    });
  }
}

router.post("/cleaning/workers", async (req, res) => {
  const b = req.body ?? {};
  const firstName = String(b.firstName ?? "").trim();
  if (!firstName) return fail(res, 400, "firstName required");
  const known = new Set((await db.select({ id: cleaningProjectsTable.id }).from(cleaningProjectsTable)).map(p => p.id));
  const { err, rates } = parseRates(b.rates, known);
  if (err) return fail(res, 400, err);
  const [row] = await db.insert(cleaningWorkersTable).values({
    firstName, lastName: String(b.lastName ?? "").trim(), note: String(b.note ?? "").trim() || null,
  }).returning();
  if (rates!.length) await replaceWorkerRates(row!.id, rates!);
  ok(res, await workerWithRates(row!.id));
});

router.patch("/cleaning/workers/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(cleaningWorkersTable).where(eq(cleaningWorkersTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.firstName !== undefined) { const n = String(b.firstName).trim(); if (!n) return fail(res, 400, "firstName required"); patch.firstName = n; }
  if (b.lastName !== undefined) patch.lastName = String(b.lastName ?? "").trim();
  if (b.active !== undefined) patch.active = !!b.active;
  if (b.note !== undefined) patch.note = String(b.note ?? "").trim() || null;
  if (Object.keys(patch).length) await db.update(cleaningWorkersTable).set(patch).where(eq(cleaningWorkersTable.id, id));
  if (b.rates !== undefined) {
    const known = new Set((await db.select({ id: cleaningProjectsTable.id }).from(cleaningProjectsTable)).map(p => p.id));
    const { err, rates } = parseRates(b.rates, known);
    if (err) return fail(res, 400, err);
    await replaceWorkerRates(id, rates!);
  }
  ok(res, await workerWithRates(id));
});

router.delete("/cleaning/workers/:id", async (req, res) => {
  const id = Number(req.params.id);
  await db.delete(cleaningWorkersTable).where(eq(cleaningWorkersTable.id, id)); // rates — ON DELETE CASCADE
  ok(res, { ok: true });
});

// ── Винагродження ─────────────────────────────────────────────────────────────
router.get("/cleaning/payrolls", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const rows = await db.select().from(cleaningPayrollsTable)
    .where(eq(cleaningPayrollsTable.periodMonth, month)).orderBy(cleaningPayrollsTable.id);
  const links = rows.length
    ? await db.select().from(cleaningPayrollProjectsTable)
        .where(inArray(cleaningPayrollProjectsTable.payrollId, rows.map(x => x.id)))
    : [];
  const byPayroll = new Map<number, number[]>();
  for (const l of links) (byPayroll.get(l.payrollId) ?? byPayroll.set(l.payrollId, []).get(l.payrollId)!).push(l.projectId);
  const projects = await db.select().from(cleaningProjectsTable).orderBy(cleaningProjectsTable.name);
  const out = rows.map(x => ({ ...x, cash: r2(x.total - x.konto), projectIds: byPayroll.get(x.id) ?? [] }));
  ok(res, {
    month, rows: out, projects,
    totals: {
      total: r2(out.reduce((s, x) => s + x.total, 0)),
      konto: r2(out.reduce((s, x) => s + x.konto, 0)),
      cash: r2(out.reduce((s, x) => s + x.cash, 0)),
      count: out.length,
    },
  });
});

// Спільний розбір тіла для POST/PATCH; totals сервер рахує сам.
function parsePayrollBody(b: any, forCreate: boolean): { err?: string; fields?: any; projectIds?: number[] } {
  const fields: any = {};
  if (b.name !== undefined || forCreate) {
    const name = String(b.name ?? "").trim();
    if (!name) return { err: "name required" };
    fields.name = name;
  }
  for (const k of ["hours", "rate"] as const) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === "") { fields[k] = null; continue; }
    const v = Number(String(b[k]).replace(",", "."));
    if (!Number.isFinite(v) || v < 0) return { err: `${k} must be ≥ 0` };
    fields[k] = v;
  }
  if (b.base !== undefined) {
    const v = Number(String(b.base === null || b.base === "" ? 0 : b.base).replace(",", "."));
    if (!Number.isFinite(v) || v < 0) return { err: "base must be ≥ 0" };
    fields.base = r2(v);
  }
  if (b.components !== undefined) {
    const comps = parseComponents(b.components);
    if (!comps) return { err: "components: [{label, amount≠0}]" };
    fields.components = comps;
  }
  if (b.konto !== undefined) {
    const v = Number(String(b.konto === null || b.konto === "" ? 0 : b.konto).replace(",", "."));
    if (!Number.isFinite(v) || v < 0) return { err: "konto must be ≥ 0" };
    fields.konto = r2(v);
  }
  if (b.note !== undefined) fields.note = String(b.note ?? "").trim() || null;
  let projectIds: number[] | undefined;
  if (b.projectIds !== undefined) {
    if (!Array.isArray(b.projectIds) || b.projectIds.some((x: any) => !Number.isFinite(Number(x)))) return { err: "projectIds: number[]" };
    projectIds = [...new Set((b.projectIds as any[]).map(Number))];
  }
  return { fields, projectIds };
}

async function replacePayrollLinks(payrollId: number, projectIds: number[]) {
  // share (вага поділу з довідника працівників) переживає інлайн-правку списку
  const old = await db.select().from(cleaningPayrollProjectsTable).where(eq(cleaningPayrollProjectsTable.payrollId, payrollId));
  const shareBy = new Map(old.map(l => [l.projectId, l.share]));
  await db.delete(cleaningPayrollProjectsTable).where(eq(cleaningPayrollProjectsTable.payrollId, payrollId));
  for (const pid of projectIds) {
    await db.insert(cleaningPayrollProjectsTable).values({ payrollId, projectId: pid, share: shareBy.get(pid) ?? null });
  }
}

// Заповнення місяця з довідника працівників: кожному АКТИВНОМУ без рядка місяця
// (матч по імені) створюється винагродження: base = Σ фіксованих позицій,
// вспульноти позицій — привʼязками з вагою поділу (сума/відсоток позиції
// ділиться порівну між її вспульнотами). Наявні рядки не чіпаються.
router.post("/cleaning/payrolls/from-workers", async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month: YYYY-MM");
  const workers = await db.select().from(cleaningWorkersTable).where(eq(cleaningWorkersTable.active, true));
  const allRates = await db.select().from(cleaningWorkerRatesTable);
  const ratesBy = new Map<number, typeof allRates>();
  for (const r of allRates) (ratesBy.get(r.workerId) ?? ratesBy.set(r.workerId, []).get(r.workerId)!).push(r);
  const existing = new Set((await db.select({ name: cleaningPayrollsTable.name }).from(cleaningPayrollsTable)
    .where(eq(cleaningPayrollsTable.periodMonth, month))).map(x => x.name.trim().toLowerCase()));
  let created = 0, skipped = 0;
  for (const w of workers) {
    const name = `${w.firstName} ${w.lastName}`.trim();
    if (existing.has(name.toLowerCase())) { skipped++; continue; }
    const rs = ratesBy.get(w.id) ?? [];
    const base = r2(rs.reduce((s, r) => s + (r.amount ?? 0), 0));
    const [row] = await db.insert(cleaningPayrollsTable).values({
      periodMonth: month, name, base, hours: null, rate: null, components: [], total: base, konto: 0,
    }).returning({ id: cleaningPayrollsTable.id });
    const weight = new Map<number, number>();
    for (const r of rs) {
      const pids = (r.projectIds as number[]) ?? [];
      const per = (r.amount ?? r.pct ?? 0) / (pids.length || 1);
      for (const pid of pids) weight.set(pid, r2((weight.get(pid) ?? 0) + per));
    }
    for (const [pid, share] of weight) {
      await db.insert(cleaningPayrollProjectsTable).values({ payrollId: row!.id, projectId: pid, share }).onConflictDoNothing();
    }
    created++;
  }
  ok(res, { month, created, skipped });
});

router.post("/cleaning/payrolls", async (req, res) => {
  const b = req.body ?? {};
  if (!validMonth(b.periodMonth)) return fail(res, 400, "periodMonth: YYYY-MM");
  const { err, fields, projectIds } = parsePayrollBody(b, true);
  if (err) return fail(res, 400, err);
  if (projectIds?.length) {
    const known = await db.select({ id: cleaningProjectsTable.id }).from(cleaningProjectsTable).where(inArray(cleaningProjectsTable.id, projectIds));
    if (known.length !== projectIds.length) return fail(res, 400, "unknown project");
  }
  const comps: Component[] = fields.components ?? [];
  const total = payrollTotal(fields.base ?? 0, fields.hours ?? null, fields.rate ?? null, comps);
  const konto = fields.konto ?? 0;
  if (konto > total) return fail(res, 400, "konto не може перевищувати разом");
  const [row] = await db.insert(cleaningPayrollsTable).values({
    periodMonth: b.periodMonth, name: fields.name, base: fields.base ?? 0,
    hours: fields.hours ?? null, rate: fields.rate ?? null,
    components: comps, total, konto, note: fields.note ?? null,
  }).returning();
  if (projectIds?.length) await replacePayrollLinks(row!.id, projectIds);
  ok(res, { ...row, cash: r2(total - konto), projectIds: projectIds ?? [] });
});

router.patch("/cleaning/payrolls/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(cleaningPayrollsTable).where(eq(cleaningPayrollsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const { err, fields, projectIds } = parsePayrollBody(req.body ?? {}, false);
  if (err) return fail(res, 400, err);
  if (projectIds?.length) {
    const known = await db.select({ id: cleaningProjectsTable.id }).from(cleaningProjectsTable).where(inArray(cleaningProjectsTable.id, projectIds));
    if (known.length !== projectIds.length) return fail(res, 400, "unknown project");
  }
  const merged = { ...row, ...fields };
  merged.total = payrollTotal(merged.base ?? 0, merged.hours, merged.rate, (merged.components ?? []) as Component[]);
  if (merged.konto > merged.total) return fail(res, 400, "konto не може перевищувати разом");
  const [updated] = await db.update(cleaningPayrollsTable).set({
    name: merged.name, base: merged.base ?? 0, hours: merged.hours, rate: merged.rate, components: merged.components,
    total: merged.total, konto: merged.konto, note: merged.note,
  }).where(eq(cleaningPayrollsTable.id, id)).returning();
  if (projectIds !== undefined) await replacePayrollLinks(id, projectIds);
  const links = await db.select().from(cleaningPayrollProjectsTable).where(eq(cleaningPayrollProjectsTable.payrollId, id));
  ok(res, { ...updated, cash: r2(updated!.total - updated!.konto), projectIds: links.map(l => l.projectId) });
});

router.delete("/cleaning/payrolls/:id", async (req, res) => {
  const id = Number(req.params.id);
  await db.delete(cleaningPayrollsTable).where(eq(cleaningPayrollsTable.id, id)); // links — ON DELETE CASCADE
  ok(res, { ok: true });
});

// ── Видатки ───────────────────────────────────────────────────────────────────
// Три джерела одним списком: локальні фактури з позначкою cleaning (місяць =
// period_month), KSeF-закупівлі segment=cleaning (місяць = revenue_month, для
// закупівель це місяць виставлення) і готівкові видатки каси з cleaning-категорій.
// Зарплатні категорії каси (payroll='cleaning') сюди НЕ входять — це виплата
// винагороджень, вони вже пораховані вкладкою «Винагродження».
async function expensesForMonths(monthCond: (col: any) => any) {
  const firms = new Map((await db.select().from(companiesTable)).map(c => [c.id, c.name]));
  const localAll = await db.select().from(invoicesTable)
    .where(and(eq(invoicesTable.cleaning, true), monthCond(invoicesTable.periodMonth)));
  const ksef = await db.select().from(ksefInvoicesTable)
    .where(and(eq(ksefInvoicesTable.kind, "purchase"), eq(ksefInvoicesTable.segment, "cleaning"), monthCond(ksefInvoicesTable.revenueMonth)));
  // дедуп (дзеркало dupOfKsefId з /cost-invoices): та сама фактура постачальника
  // часто живе і в KSeF, і рядком sheet-реєстру — локальний дубль не рахуємо
  const normNo = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/\s+/g, "");
  const ksefByNum = new Map<string, number[]>();
  for (const k of ksef) {
    const key = normNo(k.invoiceNumber);
    if (key) (ksefByNum.get(key) ?? ksefByNum.set(key, []).get(key)!).push(k.gross);
  }
  const local = localAll.filter(l => {
    const grosses = ksefByNum.get(normNo(l.number));
    return !grosses || !grosses.some(g => Math.abs(g - l.amount) <= 0.05);
  });
  const cleanCats = await db.select().from(cashCategoriesTable).where(eq(cashCategoriesTable.cleaning, true));
  const catByKey = new Map(cleanCats.map(c => [c.key, c.label]));
  const cash = cleanCats.length
    ? await db.select().from(cashEntriesTable).where(and(
        eq(cashEntriesTable.kind, "out"),
        inArray(cashEntriesTable.manualCategory, cleanCats.map(c => c.key)),
        monthCond(cashEntriesTable.periodMonth)))
    : [];
  const rows = [
    ...local.map(l => ({
      key: `l${l.id}`, origin: "local" as const, id: l.id, month: l.periodMonth,
      date: l.issueDate, number: l.number, counterparty: l.counterparty,
      firm: l.companyId ? firms.get(l.companyId) ?? null : null,
      amount: l.amount, paid: l.manualStatus ? l.manualStatus === "paid" : !l.unpaid,
      projectId: l.cleaningProjectId, source: "invoice" as const, note: l.note,
    })),
    ...ksef.map(k => ({
      key: `k${k.id}`, origin: "ksef" as const, id: k.id, month: k.revenueMonth,
      date: k.issueDate, number: k.invoiceNumber, counterparty: k.sellerName,
      firm: firms.get(k.companyId) ?? null,
      amount: k.gross, paid: k.manualStatus ? k.manualStatus === "paid" : k.paidDate != null,
      projectId: k.cleaningProjectId, source: "ksef" as const, note: null as string | null,
    })),
    ...cash.map(c => ({
      key: `c${c.id}`, origin: "cash" as const, id: c.id, month: c.periodMonth,
      date: c.entryDate, number: null as string | null,
      counterparty: c.description ?? catByKey.get(c.manualCategory ?? "") ?? null,
      firm: null as string | null,
      amount: c.amount, paid: true, projectId: null as number | null,
      source: "cash" as const, note: c.note,
    })),
  ].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  return rows;
}

router.get("/cleaning/expenses", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  const year = validYear(req.query.year) ? String(req.query.year) : null;
  if (!month && !year) return fail(res, 400, "month=YYYY-MM або year=YYYY");
  const cond = month ? (col: any) => eq(col, month) : (col: any) => sql`${col} LIKE ${year + "-%"}`;
  const rows = await expensesForMonths(cond);
  const projects = await db.select().from(cleaningProjectsTable).orderBy(cleaningProjectsTable.name);
  ok(res, {
    rows, projects,
    totals: { amount: r2(rows.reduce((s, x) => s + x.amount, 0)), count: rows.length },
  });
});

// Привʼязка видатку-фактури до вспульноти зсередини розділу (NULL = загальний)
router.patch("/cleaning/expenses/:origin/:id", async (req, res) => {
  const origin = req.params.origin;
  const id = Number(req.params.id);
  const pid = req.body?.projectId ? Number(req.body.projectId) : null;
  if (pid !== null) {
    const [p] = await db.select({ id: cleaningProjectsTable.id }).from(cleaningProjectsTable).where(eq(cleaningProjectsTable.id, pid));
    if (!p) return fail(res, 400, "unknown project");
  }
  if (origin === "local") {
    const [row] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.cleaning, true)));
    if (!row) return fail(res, 404, "not found");
    await db.update(invoicesTable).set({ cleaningProjectId: pid }).where(eq(invoicesTable.id, id));
  } else if (origin === "ksef") {
    const [row] = await db.select().from(ksefInvoicesTable)
      .where(and(eq(ksefInvoicesTable.id, id), eq(ksefInvoicesTable.kind, "purchase"), eq(ksefInvoicesTable.segment, "cleaning")));
    if (!row) return fail(res, 404, "not found");
    await db.update(ksefInvoicesTable).set({ cleaningProjectId: pid }).where(eq(ksefInvoicesTable.id, id));
  } else return fail(res, 400, "origin: local | ksef");
  ok(res, { ok: true, projectId: pid });
});

// ── P&L ───────────────────────────────────────────────────────────────────────
// year=YYYY: по місяцях року × по проєктах. Дохід — нетто за місяцем ВИСТАВЛЕННЯ
// (issue_date, як вкладка «Дохід»); винагродження — total, поділ ПОРІВНУ між
// привʼязаними вспульнотами (без привʼязок — «нерозподілене»); видатки — по
// проєкту або в «загальні».
router.get("/cleaning/pnl", async (req, res) => {
  const year = validYear(req.query.year) ? String(req.query.year) : String(new Date().getFullYear());
  const like = year + "-%";
  const projects = await db.select().from(cleaningProjectsTable).orderBy(cleaningProjectsTable.name);
  const resolve = projectResolver(projects);

  type Cell = { revenue: number; payroll: number; expenses: number };
  const mk = (): Cell => ({ revenue: 0, payroll: 0, expenses: 0 });
  // matrix: projectId (0 = нерозподілене/загальні) → month → Cell
  const matrix = new Map<number, Map<string, Cell>>();
  const bump = (pid: number | null, month: string, field: keyof Cell, amount: number) => {
    const p = matrix.get(pid ?? 0) ?? matrix.set(pid ?? 0, new Map()).get(pid ?? 0)!;
    const c = p.get(month) ?? p.set(month, mk()).get(month)!;
    c[field] = r2(c[field] + amount);
  };

  const sales = await db.select().from(ksefInvoicesTable).where(and(
    eq(ksefInvoicesTable.kind, "sale"), eq(ksefInvoicesTable.segment, "cleaning"),
    sql`to_char(${ksefInvoicesTable.issueDate}, 'YYYY') = ${year}`));
  for (const s of sales) bump(resolve(s.cleaningProjectId, s.buyerNip), String(s.issueDate).slice(0, 7), "revenue", s.net);

  const payrolls = await db.select().from(cleaningPayrollsTable).where(sql`${cleaningPayrollsTable.periodMonth} LIKE ${like}`);
  const links = payrolls.length
    ? await db.select().from(cleaningPayrollProjectsTable)
        .where(inArray(cleaningPayrollProjectsTable.payrollId, payrolls.map(x => x.id)))
    : [];
  const linksByPayroll = new Map<number, { projectId: number; share: number | null }[]>();
  for (const l of links) (linksByPayroll.get(l.payrollId) ?? linksByPayroll.set(l.payrollId, []).get(l.payrollId)!)
    .push({ projectId: l.projectId, share: l.share });
  for (const p of payrolls) {
    const pls = linksByPayroll.get(p.id) ?? [];
    if (!pls.length) { bump(null, p.periodMonth, "payroll", p.total); continue; }
    // ваги з довідника працівників (share: zł фіксованих позицій або %); без ваг — порівну
    const totalW = pls.reduce((s, l) => s + (l.share ?? 0), 0);
    if (totalW > 0) {
      for (const l of pls) bump(l.projectId, p.periodMonth, "payroll", p.total * ((l.share ?? 0) / totalW));
    } else {
      const share = p.total / pls.length;
      for (const l of pls) bump(l.projectId, p.periodMonth, "payroll", share);
    }
  }

  const expenses = await expensesForMonths((col: any) => sql`${col} LIKE ${like}`);
  for (const e of expenses) bump(e.projectId, e.month, "expenses", e.amount);

  // Офіційні умови прибиральників — OFFICE KLINEX-вкладка зведених ЗП (Sidor,
  // Zilińska, Dębski). Нетто їм переказом НЕ висилається (перевірено по витягах
  // 27.08.2026) — реальні гроші людям ідуть готівкою і ВЖЕ пораховані вкладкою
  // «Винагродження», тож у кошт прибирання лягають лише ПОДАТКИ умови:
  // ZUS+здоровʼя працівника (брутто − нетто) + ZUS роботодавця. З main-P&L
  // (міста, actuals) ці рядки виключені (routes/pnl.ts, CLEANING_OFFICE_RE);
  // людина↔вспульноти тут не мапляться — іде в payroll «нерозподілено»
  const officeRows = (await db.select().from(payrollOfficeRowsTable)
    .where(sql`${payrollOfficeRowsTable.periodMonth} LIKE ${like}`))
    .filter(o => CLEANING_OFFICE_RE.test(o.section ?? ""));
  for (const o of officeRows) {
    if (!String(o.status ?? "").toUpperCase().includes("ZUS")) continue; // без ZUS податків нема
    const p = calcPayroll(o.brutto ?? 0, false, false);
    bump(null, o.periodMonth, "payroll", r2(p.eeTotal + p.erTotal));
  }

  const months = [...new Set([...matrix.values()].flatMap(m => [...m.keys()]))].sort();
  const cellOut = (c: Cell | undefined) => c
    ? { ...c, margin: r2(c.revenue - c.payroll - c.expenses) }
    : { revenue: 0, payroll: 0, expenses: 0, margin: 0 };
  const sumCells = (cells: (Cell | undefined)[]): Cell =>
    cells.reduce<Cell>((acc, c) => c
      ? { revenue: r2(acc.revenue + c.revenue), payroll: r2(acc.payroll + c.payroll), expenses: r2(acc.expenses + c.expenses) }
      : acc, mk());

  const projRows = projects
    .map(p => {
      const byMonth = matrix.get(p.id) ?? new Map<string, Cell>();
      return {
        id: p.id, name: p.name, nip: p.nip, active: p.active,
        byMonth: Object.fromEntries(months.map(m => [m, cellOut(byMonth.get(m))])),
        totals: cellOut(sumCells(months.map(m => byMonth.get(m)))),
      };
    })
    // порожні (все нулі) не показуємо, але активні лишаємо — видно нові проєкти
    .filter(p => p.active || p.totals.revenue || p.totals.payroll || p.totals.expenses);
  const commonByMonth = matrix.get(0) ?? new Map<string, Cell>();
  const common = {
    byMonth: Object.fromEntries(months.map(m => [m, cellOut(commonByMonth.get(m))])),
    totals: cellOut(sumCells(months.map(m => commonByMonth.get(m)))),
  };
  const totalsByMonth = Object.fromEntries(months.map(m =>
    [m, cellOut(sumCells([...matrix.values()].map(x => x.get(m))))]));
  const totals = cellOut(sumCells([...matrix.values()].flatMap(x => [...x.values()])));

  ok(res, { year, months, projects: projRows, common, totalsByMonth, totals });
});

export default router;
