// P&L («P&L», /pnl) — accrual profit & loss for a single month:
// revenue and cost-of-sales per client + fixed costs; net = margin − fixed.
// Lines live in pnl_entries: imported history (source=import, revenue incl. VAT as
// in the owner's workbook), manual entries (VAT/ZUS etc.) and, later, automated
// feeds (KSeF revenue, payroll summaries).
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  pnlEntriesTable, payrollFactoryMonthsTable, payrollOfficeRowsTable, staffAllocationsTable,
  hostelsTable, hostelDeductionsTable, invoicesTable, factoriesTable, svodniRowsTable,
  ksefInvoicesTable, pnlManualItemsTable, companiesTable,
} from "@workspace/db";
import { and, eq, desc, inArray, isNull, sql } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";
import { factoryCost, pnlLabelResolver, cleanName, EMPLOYER_ZUS_RATE } from "../services/payrollSummaries";
import { cityOfRegion } from "../services/svodniSync";
import { BUCKET, catCondition, getExpenseCats } from "../services/bankClassify";

const router: IRouter = Router();
router.use(authRequired);
router.use("/pnl", requireCap("viewFinance")); // скоуп по префіксу

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
  // Розбивка собівартості клієнта на «ЗП» (нетто + аванси + хостел-утримання)
  // і «податки» (PIT/ZUS працівника + ZUS роботодавця) — наживо зі зведених ЗП.
  // Податки беремо з payroll-компонентів, ЗП = решта cogs (ручні коригування
  // рядків лишаються в колонці ЗП); без зведених — усе в ЗП.
  const pfRows = await db.select().from(payrollFactoryMonthsTable).where(eq(payrollFactoryMonthsTable.periodMonth, month));
  const labelOf0 = await pnlLabelResolver();
  const taxByLabel = new Map<string, number>();
  for (const f of pfRows) {
    const c = factoryCost(f);
    if (!c.total) continue;
    const label = labelOf0(f.factory);
    taxByLabel.set(label, round2((taxByLabel.get(label) ?? 0) + c.workerTax + c.employerZus));
  }
  const clientRows = [...clients.values()]
    .map(c => {
      const tax = c.cogs > 0 ? Math.min(taxByLabel.get(c.label) ?? 0, c.cogs) : 0;
      return {
        ...c, cogsTax: round2(tax), cogsSalary: round2(c.cogs - tax),
        margin: round2(c.revenue - c.cogs),
        marginPct: c.revenue > 0 ? round2(100 * (c.revenue - c.cogs) / c.revenue) : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);
  const revenue = round2(clientRows.reduce((s, c) => s + c.revenue, 0));
  const revenueGross = round2(clientRows.reduce((s, c) => s + c.revenueGross, 0));
  const cogs = round2(clientRows.reduce((s, c) => s + c.cogs, 0));
  const cogsSalary = round2(clientRows.reduce((s, c) => s + c.cogsSalary, 0));
  const cogsTax = round2(clientRows.reduce((s, c) => s + c.cogsTax, 0));
  const fixedTotal = round2(fixed.reduce((s, f) => s + f.amount, 0));
  fixed.sort((a, b) => b.amount - a.amount);

  ok(res, {
    month,
    segment,
    clients: clientRows,
    fixed,
    totals: {
      revenue, revenueGross, cogs, cogsSalary, cogsTax,
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

// ── P&L по містах ────────────────────────────────────────────────────────────
// Cost-center — місто (рішення власника). Розріз збирається наживо:
//  • собівартість — payroll_factory_months (місто = місто сводної);
//  • дохід — revenue-рядки pnl_entries, поділені по містах ∝ собівартості
//    клієнта в кожному місті (кілька фабрик клієнта в різних містах);
//  • офіс/обслуговуючий персонал — OFFICE-вкладки зведених ЗП: брутто
//    (+ ZUS роботодавця для статусу ZUS), місто сводної або ручний %-поділ
//    із staff_allocations;
//  • паливо — банк-категорія fuel, ділиться ∝ кількості людей місяця на
//    фабриках із fuel_commute (сводні);
//  • житло — хостели міста: фактури (або договірна ціна) мінус утримання з ЗП;
//  • інші витрати — фактури з проставленим cost-center містом (без хостельних).
// Що не мапиться на місто — блок «нерозподілене» (fixed-рядки, дохід без
// собівартості, персонал без міста).

const personKeyOf = (name: string) => cleanName(name).toUpperCase().replace(/\s+/g, " ").trim();
const monthBounds = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, "0")}` };
};
const officeCost = (brutto: number | null, status: string | null) => {
  const b = brutto ?? 0;
  return round2(b + (String(status ?? "").toUpperCase().includes("ZUS") ? b * EMPLOYER_ZUS_RATE : 0));
};

router.get("/pnl/cities", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const { start, end } = monthBounds(month);
  const labelOf = await pnlLabelResolver();

  type CityAgg = {
    city: string;
    revenue: number; revenueClients: { label: string; amount: number }[];
    cogs: number; cogsClients: { label: string; amount: number }[];
    office: { total: number; rows: { personKey: string; name: string; cost: number; pct: number }[] };
    fuel: { total: number; workers: number };
    housing: { cost: number; deducted: number; net: number; hostels: { name: string; cost: number; source: "invoices" | "contract" | null }[] };
    invoices: { total: number; rows: { id: number; number: string | null; counterparty: string | null; category: string | null; amount: number }[] };
  };
  const cities = new Map<string, CityAgg>();
  const cityOf = (c: string) => cities.get(c) ?? cities.set(c, {
    city: c,
    revenue: 0, revenueClients: [],
    cogs: 0, cogsClients: [],
    office: { total: 0, rows: [] },
    fuel: { total: 0, workers: 0 },
    housing: { cost: 0, deducted: 0, net: 0, hostels: [] },
    invoices: { total: 0, rows: [] },
  }).get(c)!;

  // — собівартість по містах і клієнтах (payroll_factory_months)
  const pf = await db.select().from(payrollFactoryMonthsTable).where(eq(payrollFactoryMonthsTable.periodMonth, month));
  const cogsByClient = new Map<string, Map<string, number>>(); // client → city → cogs
  for (const f of pf) {
    const cost = factoryCost(f).total;
    if (!cost) continue;
    const city = cityOfRegion(f.region) ?? f.region;
    const label = labelOf(f.factory);
    const agg = cityOf(city);
    agg.cogs = round2(agg.cogs + cost);
    const cl = agg.cogsClients.find(x => x.label === label);
    if (cl) cl.amount = round2(cl.amount + cost); else agg.cogsClients.push({ label, amount: cost });
    const byCity = cogsByClient.get(label) ?? cogsByClient.set(label, new Map()).get(label)!;
    byCity.set(city, round2((byCity.get(city) ?? 0) + cost));
  }

  // — дохід: revenue-рядки P&L, поділені ∝ собівартості клієнта по містах.
  // Рядок «Хостели (утримання з ЗП)» (source=payroll) сюди не входить —
  // утримання вже зменшують вартість житла нижче.
  const entries = await db.select().from(pnlEntriesTable).where(eq(pnlEntriesTable.periodMonth, month));
  const unallocRevenue: { label: string; amount: number }[] = [];
  for (const r of entries.filter(r => r.section === "revenue" && r.source !== "payroll")) {
    const byCity = cogsByClient.get(r.label);
    const total = [...(byCity?.values() ?? [])].reduce((a, b) => a + b, 0);
    if (!byCity || total <= 0) { unallocRevenue.push({ label: r.label, amount: r.amount }); continue; }
    for (const [city, c] of byCity) {
      const part = round2(r.amount * c / total);
      const agg = cityOf(city);
      agg.revenue = round2(agg.revenue + part);
      const cl = agg.revenueClients.find(x => x.label === r.label);
      if (cl) cl.amount = round2(cl.amount + part); else agg.revenueClients.push({ label: r.label, amount: part });
    }
  }

  // — обслуговуючий персонал (OFFICE-вкладки): місто сводної або ручний поділ
  const officeRows = await db.select().from(payrollOfficeRowsTable).where(eq(payrollOfficeRowsTable.periodMonth, month));
  const allocs = await db.select().from(staffAllocationsTable);
  const allocByKey = new Map(allocs.map(a => [a.personKey, a]));
  type StaffRow = { personKey: string; personName: string; firms: string[]; defaultCity: string; cost: number; allocations: { city: string; pct: number }[] };
  const staffByKey = new Map<string, StaffRow>();
  for (const o of officeRows) {
    const k = personKeyOf(o.name);
    const cost = officeCost(o.brutto, o.status);
    const s = staffByKey.get(k) ?? staffByKey.set(k, {
      personKey: k, personName: cleanName(o.name), firms: [],
      defaultCity: cityOfRegion(o.region) ?? o.region, cost: 0,
      allocations: allocByKey.get(k)?.allocations ?? [],
    }).get(k)!;
    s.cost = round2(s.cost + cost);
    if (o.firm && !s.firms.includes(o.firm)) s.firms.push(o.firm);
  }
  for (const s of staffByKey.values()) {
    const split = s.allocations.length ? s.allocations : [{ city: s.defaultCity, pct: 100 }];
    for (const a of split) {
      const agg = cityOf(a.city);
      const part = round2(s.cost * a.pct / 100);
      agg.office.total = round2(agg.office.total + part);
      agg.office.rows.push({ personKey: s.personKey, name: s.personName, cost: part, pct: a.pct });
    }
  }

  // — паливо: банк-категорія fuel ∝ людей на фабриках з доїздом
  const cats = await getExpenseCats();
  const fuelCond = catCondition("fuel", cats);
  let fuelBankTotal = 0;
  if (fuelCond) {
    const r: any = await db.execute(sql`
      SELECT coalesce(sum(amount), 0) AS s FROM bank_transactions
      WHERE ${sql.raw(BUCKET.expenses!)} AND ${sql.raw(fuelCond)} AND value_date >= ${start} AND value_date <= ${end}`);
    fuelBankTotal = round2(Number((r.rows ?? r)[0]?.s ?? 0));
  }
  const commuteFactories = await db.select({ id: factoriesTable.id, city: factoriesTable.city })
    .from(factoriesTable).where(eq(factoriesTable.fuelCommute, true));
  const commuteCityById = new Map(commuteFactories.map(f => [f.id, f.city]));
  let fuelWorkersTotal = 0;
  const fuelWorkersByCity = new Map<string, number>();
  if (commuteFactories.length) {
    const counts: any = await db.select({
      factoryId: svodniRowsTable.factoryId,
      city: svodniRowsTable.city,
      n: sql<number>`count(distinct coalesce(${svodniRowsTable.workerId}::text, ${svodniRowsTable.rawName}))::int`,
    }).from(svodniRowsTable)
      .where(and(
        eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf),
        inArray(svodniRowsTable.factoryId, commuteFactories.map(f => f.id)),
      ))
      .groupBy(svodniRowsTable.factoryId, svodniRowsTable.city);
    for (const c of counts) {
      const city = commuteCityById.get(c.factoryId) ?? c.city;
      if (!city) continue;
      fuelWorkersByCity.set(city, (fuelWorkersByCity.get(city) ?? 0) + Number(c.n));
      fuelWorkersTotal += Number(c.n);
    }
  }
  if (fuelBankTotal > 0 && fuelWorkersTotal > 0) {
    for (const [city, n] of fuelWorkersByCity) {
      const agg = cityOf(city);
      agg.fuel.total = round2(fuelBankTotal * n / fuelWorkersTotal);
      agg.fuel.workers = n;
    }
  }

  // — житло: хостели міста (фактури або договірна ціна) мінус утримання з ЗП
  const hostels = await db.select().from(hostelsTable).where(eq(hostelsTable.active, true));
  const hostelInv = await db.select().from(invoicesTable)
    .where(and(eq(invoicesTable.periodMonth, month), sql`${invoicesTable.hostelId} IS NOT NULL`));
  const invByHostel = new Map<number, number>();
  for (const i of hostelInv) invByHostel.set(i.hostelId!, round2((invByHostel.get(i.hostelId!) ?? 0) + i.amount));
  for (const h of hostels) {
    const invTotal = invByHostel.get(h.id) ?? 0;
    const rentCost = h.monthlyCost != null ? round2(h.rentModel === "per_place" ? h.monthlyCost * (h.places ?? 1) : h.monthlyCost) : null;
    const cost = invTotal > 0 ? invTotal : rentCost ?? 0;
    const agg = cityOf(h.city);
    agg.housing.cost = round2(agg.housing.cost + cost);
    agg.housing.hostels.push({ name: h.name, cost, source: invTotal > 0 ? "invoices" : rentCost != null ? "contract" : null });
  }
  const dedRows: any = await db.select({
    city: hostelDeductionsTable.city,
    s: sql<number>`coalesce(sum(${hostelDeductionsTable.amount}), 0)`,
  }).from(hostelDeductionsTable).where(eq(hostelDeductionsTable.periodMonth, month)).groupBy(hostelDeductionsTable.city);
  for (const d of dedRows) {
    if (!d.city) continue;
    const agg = cityOf(d.city);
    agg.housing.deducted = round2(agg.housing.deducted + Number(d.s));
  }
  for (const agg of cities.values()) agg.housing.net = round2(agg.housing.cost - agg.housing.deducted);

  // — інші фактури з cost-center містом (хостельні вже пораховані вище)
  const cityInv = await db.select().from(invoicesTable).where(and(
    eq(invoicesTable.periodMonth, month), sql`${invoicesTable.city} IS NOT NULL`, sql`${invoicesTable.hostelId} IS NULL`,
  ));
  for (const i of cityInv) {
    const agg = cityOf(i.city!);
    agg.invoices.total = round2(agg.invoices.total + i.amount);
    agg.invoices.rows.push({ id: i.id, number: i.number, counterparty: i.counterparty, category: (i.manualCategory ?? i.category) || null, amount: i.amount });
  }

  // — підсумки
  const out = [...cities.values()].map(c => {
    const overheads = round2(c.office.total + c.fuel.total + c.housing.net + c.invoices.total);
    const margin = round2(c.revenue - c.cogs);
    return {
      ...c,
      revenueClients: c.revenueClients.sort((a, b) => b.amount - a.amount),
      cogsClients: c.cogsClients.sort((a, b) => b.amount - a.amount),
      margin, overheads, net: round2(margin - overheads),
    };
  }).sort((a, b) => b.revenue - a.revenue);

  const fixed = entries.filter(r => r.section === "fixed").map(r => ({ label: r.label, amount: r.amount })).sort((a, b) => b.amount - a.amount);
  ok(res, {
    month,
    cities: out,
    staff: [...staffByKey.values()].sort((a, b) => b.cost - a.cost),
    fuelMeta: { bankTotal: fuelBankTotal, workersTotal: fuelWorkersTotal, commuteFactories: commuteFactories.length },
    unallocated: {
      revenue: unallocRevenue.sort((a, b) => b.amount - a.amount),
      fixed,
      fixedTotal: round2(fixed.reduce((s, f) => s + f.amount, 0)),
      fuel: fuelWorkersTotal > 0 ? 0 : fuelBankTotal,
    },
    totals: {
      revenue: round2(out.reduce((s, c) => s + c.revenue, 0)),
      cogs: round2(out.reduce((s, c) => s + c.cogs, 0)),
      overheads: round2(out.reduce((s, c) => s + c.overheads, 0)),
      net: round2(out.reduce((s, c) => s + c.net, 0)),
    },
  });
});

// ── Фактичні платежі місяця (принцип «у M+1 за M») ───────────────────────────
// Касовий зріз під P&L: що реально платиться наступного місяця за вибраний.
//  • приходи — виставлені фактури KSeF з revenue_month = M;
//  • ЗП конто/готівка й аванси — зі сводної M (закритий шар konto/gotowka);
//  • ЗП офісу — вкладки «Офис …» сводної, теж конто/готівка;
//  • бензин — закупівлі KSeF від ORLEN (NIP 7740001454) за датою виставлення в M;
//  • ремонти (Naprawy), хостели (Hostele) та «інші категорії» — реєстр фактур
//    витрат за M; Paliwo з реєстру ховаємо (дубль бензину з KSeF);
//  • VAT/ZUS — ручні суми по фірмах (pnl_manual_items).

const ORLEN_NIP = "7740001454";
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const OFFICE_TAB_RE = /офис|офіс|office/i;

router.get("/pnl/actuals", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");

  // приходи: виставлені в M+1 фактури за роботу M
  const sales = await db.select().from(ksefInvoicesTable)
    .where(and(eq(ksefInvoicesTable.kind, "sale"), eq(ksefInvoicesTable.revenueMonth, month)));
  const income = {
    net: round2(sales.reduce((s, i) => s + i.net, 0)),
    gross: round2(sales.reduce((s, i) => s + i.gross, 0)),
    count: sales.length,
  };

  // сводна M: ЗП конто/готівка, аванси; вкладки «Офис …» — окремим рядком
  const sv = await db.select().from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf)));
  const pay = { konto: 0, cash: 0, unsplit: 0 };      // працівники
  const office = { konto: 0, cash: 0, unsplit: 0 };   // офісні вкладки
  let advances = 0;
  for (const r of sv) {
    const dst = OFFICE_TAB_RE.test(r.factoryLabel) ? office : pay;
    if (r.konto == null && r.gotowka == null) dst.unsplit = round2(dst.unsplit + (r.doWyplaty ?? 0));
    else { dst.konto = round2(dst.konto + (r.konto ?? 0)); dst.cash = round2(dst.cash + (r.gotowka ?? 0)); }
    advances = round2(advances + (r.zaliczka ?? 0) + (r.zaliczkaBd ?? 0));
  }

  // бензин: закупівлі KSeF від Orlen, місяць за датою виставлення
  const purchases = await db.select().from(ksefInvoicesTable)
    .where(and(eq(ksefInvoicesTable.kind, "purchase"), sql`substr(${ksefInvoicesTable.issueDate}::text, 1, 7) = ${month}`));
  const orlen = purchases.filter(p => digits(p.sellerNip) === ORLEN_NIP);
  const fuel = {
    net: round2(orlen.reduce((s, i) => s + i.net, 0)),
    gross: round2(orlen.reduce((s, i) => s + i.gross, 0)),
    count: orlen.length,
  };

  // реєстр фактур витрат за M: ремонти, хостели, решта категорій
  const inv = await db.select().from(invoicesTable).where(eq(invoicesTable.periodMonth, month));
  const catOf = (i: typeof inv[number]) => (i.manualCategory ?? i.category ?? "").trim() || "Inne";
  type CatAgg = { category: string; total: number; rows: { id: number; number: string | null; counterparty: string | null; amount: number }[] };
  const byCat = new Map<string, CatAgg>();
  for (const i of inv) {
    const c = catOf(i);
    const agg = byCat.get(c) ?? byCat.set(c, { category: c, total: 0, rows: [] }).get(c)!;
    agg.total = round2(agg.total + i.amount);
    agg.rows.push({ id: i.id, number: i.number, counterparty: i.counterparty, amount: i.amount });
  }
  const takeCat = (name: string): CatAgg => {
    const agg = byCat.get(name) ?? { category: name, total: 0, rows: [] };
    byCat.delete(name);
    return { ...agg, rows: agg.rows.sort((a, b) => b.amount - a.amount) };
  };
  const repairs = takeCat("Naprawy");
  const hostels = takeCat("Hostele");
  const fuelRegistry = takeCat("Paliwo"); // дубль бензину з KSeF — довідково, у підсумок не йде
  const others = [...byCat.values()]
    .map(c => ({ ...c, rows: c.rows.sort((a, b) => b.amount - a.amount) }))
    .sort((a, b) => b.total - a.total);
  const othersTotal = round2(others.reduce((s, c) => s + c.total, 0));

  // ручні VAT/ZUS по фірмах
  const manual = await db.select().from(pnlManualItemsTable).where(eq(pnlManualItemsTable.periodMonth, month));
  const firms = (await db.select().from(companiesTable).where(eq(companiesTable.isActive, true))).map(c => c.name);
  const vat = manual.filter(m => m.kind === "vat");
  const zus = manual.filter(m => m.kind === "zus");
  const vatTotal = round2(vat.reduce((s, m) => s + m.amount, 0));
  const zusTotal = round2(zus.reduce((s, m) => s + m.amount, 0));

  const payTotal = round2(pay.konto + pay.cash + pay.unsplit);
  const officeTotal = round2(office.konto + office.cash + office.unsplit);
  const expenses = round2(payTotal + advances + fuel.gross + repairs.total + hostels.total + vatTotal + zusTotal + officeTotal + othersTotal);

  ok(res, {
    month, income,
    salary: { ...pay, total: payTotal },
    advances,
    fuel, fuelRegistry,
    repairs, hostels,
    officeSalary: { ...office, total: officeTotal },
    manual: { vat, zus, vatTotal, zusTotal, firms },
    others, othersTotal,
    totals: { expenses, balanceGross: round2(income.gross - expenses), balanceNet: round2(income.net - expenses) },
  });
});

// upsert ручної суми VAT/ZUS фірми за місяць
router.put("/pnl/manual", async (req, res) => {
  const { month, kind, firm, amount, note } = req.body ?? {};
  if (!validMonth(month)) return fail(res, 400, "month must be YYYY-MM");
  if (kind !== "vat" && kind !== "zus") return fail(res, 400, "kind must be vat|zus");
  if (!firm || !String(firm).trim()) return fail(res, 400, "firm required");
  const amt = Number(String(amount ?? "").replace(",", "."));
  if (!Number.isFinite(amt) || amt < 0) return fail(res, 400, "amount must be a number ≥ 0");
  const [row] = await db.insert(pnlManualItemsTable)
    .values({ periodMonth: month, kind, firm: String(firm).trim(), amount: round2(amt), note: note ? String(note).trim() : null })
    .onConflictDoUpdate({
      target: [pnlManualItemsTable.periodMonth, pnlManualItemsTable.kind, pnlManualItemsTable.firm],
      set: { amount: round2(amt), note: note ? String(note).trim() : null },
    }).returning();
  ok(res, row);
});

router.delete("/pnl/manual/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(pnlManualItemsTable).where(eq(pnlManualItemsTable.id, id));
  ok(res, { ok: true });
});

// ручний %-поділ людини між містами; порожній масив = повернути дефолт (місто сводної)
router.put("/pnl/staff-allocations", async (req, res) => {
  const { personKey, personName, allocations } = req.body ?? {};
  if (!personKey || !String(personKey).trim()) return fail(res, 400, "personKey required");
  if (!Array.isArray(allocations)) return fail(res, 400, "allocations must be an array");
  const clean: { city: string; pct: number }[] = [];
  for (const a of allocations) {
    const city = String(a?.city ?? "").trim();
    const pct = Number(a?.pct);
    if (!city) return fail(res, 400, "allocation city required");
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return fail(res, 400, "pct must be in (0, 100]");
    if (clean.some(x => x.city === city)) return fail(res, 400, `місто «${city}» повторюється`);
    clean.push({ city, pct: Math.round(pct * 10) / 10 });
  }
  const total = clean.reduce((s, a) => s + a.pct, 0);
  if (clean.length && Math.abs(total - 100) > 0.5) return fail(res, 400, `сума відсотків має бути 100 (зараз ${total})`);
  const key = String(personKey).trim();
  if (!clean.length) {
    await db.delete(staffAllocationsTable).where(eq(staffAllocationsTable.personKey, key));
    return ok(res, { personKey: key, allocations: [] });
  }
  const [row] = await db.insert(staffAllocationsTable)
    .values({ personKey: key, personName: personName ? String(personName).trim() : null, allocations: clean })
    .onConflictDoUpdate({
      target: staffAllocationsTable.personKey,
      set: { personName: personName ? String(personName).trim() : null, allocations: clean },
    }).returning();
  ok(res, row);
});

export default router;
