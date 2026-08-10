// Транспортні гроші: журнал поїздок (архів таблиць водія 2022–2026 + подальші
// місяці — авторозрахунок із призначень), оплати водіям за виїзд (ставка
// водій×фабрика), зняття з ЗП працівників за довіз (transport_deductions).
// Доступ: перегляд/правки — editData АБО assignDrivers; суми оплат водіям — це
// операційні виплати (веде головний водій), не owner-only фінанси.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  driverTripLogTable, driverTripRatesTable, transportDeductionsTable,
  driversTable, factoriesTable, workersTable, driverShiftAssignmentsTable, scheduleWeeksTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte, like, lte, sql } from "drizzle-orm";
import { authRequired, requireAnyCap } from "../lib/auth";

const router: IRouter = Router();
router.use(authRequired);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const RW = requireAnyCap("editData", "assignDrivers");
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const r2 = (n: number) => Math.round(n * 100) / 100;

// ─── Журнал поїздок (архів) ──────────────────────────────────────────────────

router.get("/transport/trip-log", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const factory = String(req.query.factory ?? "").trim();
  const conds = [gte(driverTripLogTable.tripDate, `${month}-01`), lte(driverTripLogTable.tripDate, `${month}-31`)];
  if (factory) conds.push(eq(driverTripLogTable.factoryLabel, factory));
  const rows = await db.select().from(driverTripLogTable)
    .where(and(...conds))
    .orderBy(asc(driverTripLogTable.tripDate), asc(driverTripLogTable.factoryLabel), asc(driverTripLogTable.id));
  const months = await db.selectDistinct({ m: sql<string>`substring(${driverTripLogTable.tripDate}::text from 1 for 7)` }).from(driverTripLogTable);
  const factoriesList = await db.selectDistinct({ f: driverTripLogTable.factoryLabel }).from(driverTripLogTable);
  ok(res, {
    month,
    months: months.map((x) => x.m).sort().reverse(),
    factories: factoriesList.map((x) => x.f).sort(),
    rows,
  });
});

// ─── Виплати водіям за місяць ────────────────────────────────────────────────
// Джерело 1: журнал (архів таблиць — там оплати вже вписані).
// Джерело 2: призначення тижнів (для місяців без журналу) × ставка (оверрайд ?? базова).
router.get("/transport/driver-pay", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");

  const logRows = await db.select({
    driverId: driverTripLogTable.driverId,
    driverName: driverTripLogTable.driverName,
    factoryLabel: driverTripLogTable.factoryLabel,
    trips: sql<number>`count(*)`,
    km: sql<number>`coalesce(sum(${driverTripLogTable.km}), 0)`,
    pay: sql<number>`coalesce(sum(${driverTripLogTable.payAmount}::numeric), 0)`,
  }).from(driverTripLogTable)
    .where(and(gte(driverTripLogTable.tripDate, `${month}-01`), lte(driverTripLogTable.tripDate, `${month}-31`)))
    .groupBy(driverTripLogTable.driverId, driverTripLogTable.driverName, driverTripLogTable.factoryLabel);

  if (logRows.length) {
    const drivers = await db.select().from(driversTable);
    const nameById = new Map(drivers.map((d) => [d.id, d.name]));
    return ok(res, {
      month, source: "log",
      rows: logRows.map((r) => ({
        driverId: r.driverId, driverName: r.driverId != null ? nameById.get(r.driverId) ?? r.driverName : r.driverName,
        factoryLabel: r.factoryLabel, trips: Number(r.trips), km: Number(r.km), pay: r2(Number(r.pay)),
      })).sort((a, b) => (a.driverName ?? "").localeCompare(b.driverName ?? "") || a.factoryLabel.localeCompare(b.factoryLabel)),
    });
  }

  // Немає журналу за місяць → рахуємо з призначень: кожен рядок (день × зміна ×
  // фабрика × вид) = один виїзд. Тижні беремо з запасом і фільтруємо по даті.
  const DAY_IDX: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const [y, m] = month.split("-").map(Number);
  const first = `${month}-01`;
  const last = `${month}-${String(new Date(Date.UTC(y!, m!, 0)).getUTCDate()).padStart(2, "0")}`;
  const weekFrom = new Date(Date.UTC(y!, m! - 1, 1 - 6)).toISOString().slice(0, 10);
  const weeks = await db.select().from(scheduleWeeksTable)
    .where(and(gte(scheduleWeeksTable.weekStart, weekFrom), lte(scheduleWeeksTable.weekStart, last)));
  const weekById = new Map(weeks.map((w) => [w.id, w.weekStart]));
  const assigns = weeks.length
    ? await db.select().from(driverShiftAssignmentsTable)
      .where(sql`${driverShiftAssignmentsTable.weekId} IN (${sql.join(weeks.map((w) => sql`${w.id}`), sql`, `)})`)
    : [];
  const rates = await db.select().from(driverTripRatesTable);
  const rateFor = new Map(rates.map((r) => [`${r.driverId}:${r.factoryId}`, r.rate]));
  const drivers = await db.select().from(driversTable);
  const baseRate = new Map(drivers.map((d) => [d.id, d.tripRate]));
  const nameById = new Map(drivers.map((d) => [d.id, d.name]));
  const factories = await db.select().from(factoriesTable);
  const facName = new Map(factories.map((f) => [f.id, f.name]));

  const agg = new Map<string, { driverId: number; factoryId: number; trips: number; pay: number; noRate: boolean }>();
  for (const a of assigns) {
    const ws = weekById.get(a.weekId);
    if (!ws) continue;
    const [wy, wm, wd] = ws.split("-").map(Number);
    const dt = new Date(Date.UTC(wy!, wm! - 1, wd! + DAY_IDX[a.dayOfWeek]));
    const dateStr = dt.toISOString().slice(0, 10);
    if (dateStr < first || dateStr > last) continue;
    const key = `${a.driverId}:${a.factoryId}`;
    const rate = rateFor.get(key) ?? baseRate.get(a.driverId) ?? null;
    const cur = agg.get(key) ?? { driverId: a.driverId, factoryId: a.factoryId, trips: 0, pay: 0, noRate: false };
    cur.trips++;
    if (rate != null) cur.pay = r2(cur.pay + rate); else cur.noRate = true;
    agg.set(key, cur);
  }
  ok(res, {
    month, source: "assignments",
    rows: [...agg.values()].map((r) => ({
      driverId: r.driverId, driverName: nameById.get(r.driverId) ?? `#${r.driverId}`,
      factoryLabel: facName.get(r.factoryId) ?? `#${r.factoryId}`, trips: r.trips, km: null,
      pay: r.pay, noRate: r.noRate,
    })).sort((a, b) => a.driverName.localeCompare(b.driverName) || a.factoryLabel.localeCompare(b.factoryLabel)),
  });
});

// ─── Ставки ──────────────────────────────────────────────────────────────────

router.get("/transport/rates", async (_req, res) => {
  const drivers = await db.select().from(driversTable).where(eq(driversTable.isActive, true)).orderBy(driversTable.name);
  const overrides = await db.select({ o: driverTripRatesTable, factoryName: factoriesTable.name })
    .from(driverTripRatesTable)
    .leftJoin(factoriesTable, eq(driverTripRatesTable.factoryId, factoriesTable.id));
  ok(res, {
    drivers: drivers.map((d) => ({ id: d.id, name: d.name, tripRate: d.tripRate })),
    overrides: overrides.map(({ o, factoryName }) => ({ id: o.id, driverId: o.driverId, factoryId: o.factoryId, factoryName, rate: o.rate })),
  });
});

router.put("/transport/rates/driver/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  const rate = req.body?.rate;
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  if (rate !== null && (!Number.isFinite(Number(rate)) || Number(rate) < 0)) return fail(res, 400, "rate ≥ 0 або null");
  const [d] = await db.update(driversTable).set({ tripRate: rate === null ? null : r2(Number(rate)) }).where(eq(driversTable.id, id)).returning();
  if (!d) return fail(res, 404, "Не знайдено");
  ok(res, { id: d.id, tripRate: d.tripRate });
});

router.put("/transport/rates/override", RW, async (req, res) => {
  const driverId = Number(req.body?.driverId), factoryId = Number(req.body?.factoryId);
  const rate = req.body?.rate;
  if (!Number.isFinite(driverId) || !Number.isFinite(factoryId)) return fail(res, 400, "driverId і factoryId обовʼязкові");
  if (rate === null) {
    await db.delete(driverTripRatesTable).where(and(eq(driverTripRatesTable.driverId, driverId), eq(driverTripRatesTable.factoryId, factoryId)));
    return ok(res, { ok: true, removed: true });
  }
  if (!Number.isFinite(Number(rate)) || Number(rate) < 0) return fail(res, 400, "rate ≥ 0 або null");
  const [row] = await db.insert(driverTripRatesTable)
    .values({ driverId, factoryId, rate: r2(Number(rate)) })
    .onConflictDoUpdate({ target: [driverTripRatesTable.driverId, driverTripRatesTable.factoryId], set: { rate: r2(Number(rate)) } })
    .returning();
  ok(res, row);
});

// ─── Зняття з працівників за довіз ───────────────────────────────────────────

router.get("/transport/deductions", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const rows = await db.select({ d: transportDeductionsTable, workerName: workersTable.fullName, factoryName: factoriesTable.name })
    .from(transportDeductionsTable)
    .leftJoin(workersTable, eq(transportDeductionsTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(transportDeductionsTable.factoryId, factoriesTable.id))
    .where(eq(transportDeductionsTable.periodMonth, month));
  const months = await db.selectDistinct({ m: transportDeductionsTable.periodMonth }).from(transportDeductionsTable);
  ok(res, {
    month,
    months: months.map((x) => x.m).sort().reverse(),
    rows: rows.map(({ d, workerName, factoryName }) => ({
      id: d.id, workerId: d.workerId, workerName: workerName ?? d.workerName,
      factoryId: d.factoryId, factoryLabel: factoryName ?? d.factoryLabel,
      tripsCount: d.tripsCount, amount: d.amount, note: d.note,
    })).sort((a, b) => (a.workerName ?? "").localeCompare(b.workerName ?? "", "pl")),
  });
});

router.post("/transport/deductions", RW, async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  const workerId = Number(req.body?.workerId);
  const amount = Number(req.body?.amount);
  if (!month || !Number.isFinite(workerId) || !Number.isFinite(amount) || amount < 0) return fail(res, 400, "month, workerId, сума ≥ 0");
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return fail(res, 404, "працівника не знайдено");
  const [fac] = w.factoryId != null ? await db.select().from(factoriesTable).where(eq(factoriesTable.id, w.factoryId)) : [];
  const [created] = await db.insert(transportDeductionsTable).values({
    periodMonth: month, workerId, amount: r2(amount),
    tripsCount: Number.isFinite(Number(req.body?.tripsCount)) && req.body?.tripsCount !== "" && req.body?.tripsCount != null ? Math.floor(Number(req.body.tripsCount)) : null,
    factoryId: w.factoryId, factoryLabel: fac?.name ?? null,
    note: String(req.body?.note ?? "").trim() || null,
  }).returning();
  ok(res, created);
});

router.patch("/transport/deductions/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const patch: Record<string, unknown> = {};
  if (req.body?.amount !== undefined) {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) return fail(res, 400, "сума ≥ 0");
    patch.amount = r2(amount);
  }
  if (req.body?.tripsCount !== undefined) patch.tripsCount = req.body.tripsCount === null || req.body.tripsCount === "" ? null : Math.floor(Number(req.body.tripsCount));
  if (req.body?.note !== undefined) patch.note = String(req.body.note).trim() || null;
  if (!Object.keys(patch).length) return fail(res, 400, "нема що оновлювати");
  const [u] = await db.update(transportDeductionsTable).set(patch).where(eq(transportDeductionsTable.id, id)).returning();
  if (!u) return fail(res, 404, "Не знайдено");
  ok(res, u);
});

router.delete("/transport/deductions/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(transportDeductionsTable).where(eq(transportDeductionsTable.id, id));
  ok(res, { ok: true });
});

export default router;
