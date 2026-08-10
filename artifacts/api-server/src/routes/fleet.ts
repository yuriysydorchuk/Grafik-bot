// Автопарк 2.0 — розширена картка авто (страховка/техогляд/власність/інвентар),
// витрати на ремонти по місяцях і алерти про сплив документів.
// Джерело процесу — таблиця головного водія «АВТОПАРК 2» (мігрована 07.2026).
// Доступ: перегляд і правки — editData АБО assignDrivers (головний водій веде парк сам);
// фінансовий шар (оренда/ціни купівлі-продажу) — лише viewFinance, і в GET, і в мутаціях.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { vehiclesTable, vehicleExpensesTable, vehicleServiceInvoicesTable, companiesTable, invoicesTable } from "@workspace/db";
import { and, desc, eq, gte, isNotNull, like, lte, or, sql } from "drizzle-orm";
import { authRequired, requireAnyCap, type AuthedRequest } from "../lib/auth";
import { hasCap } from "../lib/roles";
import { fleetExpiryList } from "../services/fleet";

const router: IRouter = Router();
router.use(authRequired);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const FLEET_RW = requireAnyCap("editData", "assignDrivers");
const canFinance = (req: any) => hasCap((req as AuthedRequest).admin?.role, (req as AuthedRequest).admin?.caps, "viewFinance");

const validDate = (s: any) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const r2 = (n: number) => Math.round(n * 100) / 100;

const FIN_FIELDS = ["rentMonthly", "purchasePrice", "marketPrice", "leaseTotal", "leaseInitialPaid"] as const;

function stripFinance(req: any, v: Record<string, unknown>) {
  if (canFinance(req)) return v;
  const out = { ...v };
  for (const f of FIN_FIELDS) delete out[f];
  return out;
}

// ─── Vehicles (повна картка) ─────────────────────────────────────────────────

router.get("/fleet/vehicles", async (req, res) => {
  const all = req.query.all === "1"; // включно з проданими/утилем/неактивними
  const rows = await db.select({ v: vehiclesTable, companyName: companiesTable.name })
    .from(vehiclesTable)
    .leftJoin(companiesTable, eq(vehiclesTable.companyId, companiesTable.id))
    .orderBy(vehiclesTable.plate);
  // привʼязані фактури (лізинг/сервіс): виставлено/оплачено по авто.
  // «оплачено» = ефективний статус фактури (manual_status перекриває аркушевий unpaid)
  const fin = canFinance(req);
  const leaseAgg = new Map<number, { invoiced: number; paid: number; count: number }>();
  if (fin) {
    const agg: any[] = await db.select({
      vehicleId: invoicesTable.vehicleId,
      invoiced: sql<number>`coalesce(sum(${invoicesTable.amount}::numeric), 0)`,
      paid: sql<number>`coalesce(sum(${invoicesTable.amount}::numeric) FILTER (WHERE CASE WHEN ${invoicesTable.manualStatus} IS NOT NULL THEN ${invoicesTable.manualStatus} = 'paid' ELSE NOT ${invoicesTable.unpaid} END), 0)`,
      count: sql<number>`count(*)`,
    }).from(invoicesTable).where(sql`${invoicesTable.vehicleId} IS NOT NULL`).groupBy(invoicesTable.vehicleId);
    for (const a of agg) leaseAgg.set(a.vehicleId, { invoiced: Number(a.invoiced), paid: Number(a.paid), count: Number(a.count) });
  }
  const list = rows
    .filter(({ v }) => all || (v.isActive && v.status === "active"))
    .map(({ v, companyName }) => {
      const base = stripFinance(req, { ...v, companyName });
      if (!fin) return base;
      const la = leaseAgg.get(v.id);
      return { ...base, leaseInvoiced: la?.invoiced ?? 0, leasePaid: la?.paid ?? 0, leaseInvoiceCount: la?.count ?? 0 };
    });
  ok(res, list);
});

// Ручний запуск авто-привʼязки лізингових фактур (правило lease_lessor + contract_no)
router.post("/fleet/lease-attach", requireAnyCap("viewFinance"), async (_req, res) => {
  const { autoAttachLeaseInvoices } = await import("../services/invoices");
  const attached = await autoAttachLeaseInvoices();
  ok(res, { attached });
});

router.patch("/fleet/vehicles/:id", FLEET_RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.plate !== undefined) {
    if (!String(b.plate).trim()) return fail(res, 400, "Вкажіть номер авто");
    patch.plate = String(b.plate).trim().toUpperCase();
  }
  for (const f of ["brandModel", "city", "ownerName", "fuel", "vin", "notes"] as const) {
    if (b[f] !== undefined) patch[f] = String(b[f]).trim() || null;
  }
  if (b.seats !== undefined) patch.seats = Number(b.seats) > 0 ? Math.floor(Number(b.seats)) : null;
  if (b.year !== undefined) patch.year = Number(b.year) > 1900 ? Math.floor(Number(b.year)) : null;
  if (b.companyId !== undefined) patch.companyId = Number.isFinite(Number(b.companyId)) && b.companyId !== null ? Number(b.companyId) : null;
  if (b.ownership !== undefined) {
    const own = String(b.ownership);
    if (own && !["umowa", "leasing", "faktura", "private"].includes(own)) return fail(res, 400, "ownership: umowa|leasing|faktura|private");
    patch.ownership = own || null;
  }
  if (b.kind !== undefined) {
    const k = String(b.kind);
    if (k && !["car", "bus"].includes(k)) return fail(res, 400, "kind: car|bus");
    patch.kind = k || null;
  }
  if (b.status !== undefined) {
    const s = String(b.status);
    if (!["active", "sold", "scrapped"].includes(s)) return fail(res, 400, "status: active|sold|scrapped");
    patch.status = s;
  }
  for (const f of ["insuranceUntil", "inspectionUntil", "purchasedAt", "soldAt"] as const) {
    if (b[f] !== undefined) {
      if (b[f] !== null && !validDate(b[f])) return fail(res, 400, `${f}: YYYY-MM-DD або null`);
      patch[f] = b[f];
    }
  }
  if (b.equipment !== undefined) {
    if (b.equipment !== null && (typeof b.equipment !== "object" || Array.isArray(b.equipment))) return fail(res, 400, "equipment: обʼєкт");
    patch.equipment = b.equipment ?? {};
  }
  if (b.isActive !== undefined) patch.isActive = Boolean(b.isActive);
  if (b.personal !== undefined) patch.personal = Boolean(b.personal);
  if (canFinance(req)) {
    for (const f of FIN_FIELDS) {
      if (b[f] !== undefined) patch[f] = b[f] === null || b[f] === "" ? null : r2(Number(b[f]));
    }
    for (const f of ["leaseLessor", "leaseContractNo"] as const) {
      if (b[f] !== undefined) patch[f] = String(b[f]).trim() || null;
    }
  }
  if (!Object.keys(patch).length) return fail(res, 400, "нема що оновлювати");
  const [v] = await db.update(vehiclesTable).set(patch).where(eq(vehiclesTable.id, id)).returning();
  if (!v) return fail(res, 404, "Не знайдено");
  ok(res, stripFinance(req, { ...v }));
});

// ─── Витрати на авто (ремонти/шини) ──────────────────────────────────────────

router.get("/fleet/expenses", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year ?? "")) ? String(req.query.year) : null;
  const vehicleId = Number.isFinite(Number(req.query.vehicleId)) && req.query.vehicleId ? Number(req.query.vehicleId) : null;
  const conds = [];
  if (year) conds.push(like(vehicleExpensesTable.month, `${year}-%`));
  if (vehicleId) conds.push(eq(vehicleExpensesTable.vehicleId, vehicleId));
  const rows = await db.select({ e: vehicleExpensesTable, plate: vehiclesTable.plate, brandModel: vehiclesTable.brandModel })
    .from(vehicleExpensesTable)
    .leftJoin(vehiclesTable, eq(vehicleExpensesTable.vehicleId, vehiclesTable.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(vehicleExpensesTable.month), vehicleExpensesTable.id);
  const years = await db.selectDistinct({ y: sql<string>`substring(${vehicleExpensesTable.month} from 1 for 4)` }).from(vehicleExpensesTable);
  ok(res, {
    years: years.map((x) => x.y).sort().reverse(),
    rows: rows.map(({ e, plate, brandModel }) => ({ ...e, plate, brandModel })),
  });
});

router.post("/fleet/expenses", FLEET_RW, async (req, res) => {
  const b = req.body ?? {};
  if (!validMonth(b.month)) return fail(res, 400, "month=YYYY-MM");
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, "сума > 0");
  const vehicleId = Number.isFinite(Number(b.vehicleId)) && b.vehicleId ? Number(b.vehicleId) : null;
  if (vehicleId) {
    const [v] = await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, vehicleId));
    if (!v) return fail(res, 404, "авто не знайдено");
  }
  const kind = ["repair", "tire", "other"].includes(String(b.kind)) ? String(b.kind) : "repair";
  const [created] = await db.insert(vehicleExpensesTable).values({
    vehicleId,
    vehicleLabel: String(b.vehicleLabel ?? "").trim() || null,
    month: String(b.month),
    amount: r2(amount),
    kind,
    service: String(b.service ?? "").trim() || null,
    invoiceNo: String(b.invoiceNo ?? "").trim() || null,
    note: String(b.note ?? "").trim() || null,
  }).returning();
  ok(res, created);
});

router.patch("/fleet/expenses/:id", FLEET_RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.month !== undefined) {
    if (!validMonth(b.month)) return fail(res, 400, "month=YYYY-MM");
    patch.month = String(b.month);
  }
  if (b.amount !== undefined) {
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, "сума > 0");
    patch.amount = r2(amount);
  }
  if (b.vehicleId !== undefined) patch.vehicleId = Number.isFinite(Number(b.vehicleId)) && b.vehicleId ? Number(b.vehicleId) : null;
  if (b.kind !== undefined) {
    if (!["repair", "tire", "other"].includes(String(b.kind))) return fail(res, 400, "kind: repair|tire|other");
    patch.kind = String(b.kind);
  }
  for (const f of ["service", "invoiceNo", "note", "vehicleLabel"] as const) {
    if (b[f] !== undefined) patch[f] = String(b[f]).trim() || null;
  }
  if (!Object.keys(patch).length) return fail(res, 400, "нема що оновлювати");
  const [u] = await db.update(vehicleExpensesTable).set(patch).where(eq(vehicleExpensesTable.id, id)).returning();
  if (!u) return fail(res, 404, "Не знайдено");
  ok(res, u);
});

router.delete("/fleet/expenses/:id", FLEET_RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(vehicleExpensesTable).where(eq(vehicleExpensesTable.id, id));
  ok(res, { ok: true });
});

// Зведення для сторінки: авто × місяць за рік + річні підсумки + фактури сервісів.
router.get("/fleet/summary", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year ?? "")) ? String(req.query.year) : String(new Date().getFullYear());
  const rows = await db.select({
    vehicleId: vehicleExpensesTable.vehicleId,
    vehicleLabel: vehicleExpensesTable.vehicleLabel,
    plate: vehiclesTable.plate,
    brandModel: vehiclesTable.brandModel,
    month: vehicleExpensesTable.month,
    total: sql<number>`sum(${vehicleExpensesTable.amount}::numeric)`, // float4-сума губить центи на великих підсумках
  })
    .from(vehicleExpensesTable)
    .leftJoin(vehiclesTable, eq(vehicleExpensesTable.vehicleId, vehiclesTable.id))
    .where(like(vehicleExpensesTable.month, `${year}-%`))
    .groupBy(vehicleExpensesTable.vehicleId, vehicleExpensesTable.vehicleLabel, vehiclesTable.plate, vehiclesTable.brandModel, vehicleExpensesTable.month);
  const invoices = await db.select().from(vehicleServiceInvoicesTable)
    .where(like(vehicleServiceInvoicesTable.month, `${year}-%`))
    .orderBy(vehicleServiceInvoicesTable.month, vehicleServiceInvoicesTable.invoiceNo);
  const byVehicle = new Map<string, { vehicleId: number | null; label: string; months: Record<string, number>; total: number }>();
  for (const r of rows) {
    const key = r.vehicleId != null ? `v${r.vehicleId}` : `l:${r.vehicleLabel ?? "?"}`;
    const label = r.vehicleId != null ? `${r.brandModel ?? ""} ${r.plate ?? ""}`.trim() : (r.vehicleLabel ?? "?");
    if (!byVehicle.has(key)) byVehicle.set(key, { vehicleId: r.vehicleId, label, months: {}, total: 0 });
    const v = byVehicle.get(key)!;
    const t = r2(Number(r.total));
    v.months[r.month] = r2((v.months[r.month] ?? 0) + t);
    v.total = r2(v.total + t);
  }
  ok(res, {
    year,
    vehicles: [...byVehicle.values()].sort((a, b) => b.total - a.total),
    grandTotal: r2([...byVehicle.values()].reduce((s, v) => s + v.total, 0)),
    invoices,
    invoicesTotal: r2(invoices.reduce((s, i) => s + i.amount, 0)),
  });
});

// ─── Алерти про сплив страховки/техогляду ────────────────────────────────────
// Використовується сторінкою і кроном (services/fleetAlerts.ts).
router.get("/fleet/alerts", async (req, res) => {
  const days = Number.isFinite(Number(req.query.days)) && Number(req.query.days) > 0 ? Math.floor(Number(req.query.days)) : 30;
  ok(res, await fleetExpiryList(days));
});

export default router;
