// Транспортні гроші: журнал поїздок (архів таблиць водія 2022–2026 + подальші
// місяці — авторозрахунок із призначень), оплати водіям за виїзд (ставка
// водій×фабрика), зняття з ЗП працівників за довіз (transport_deductions).
// Доступ: перегляд/правки — editData АБО assignDrivers; суми оплат водіям — це
// операційні виплати (веде головний водій), не owner-only фінанси.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  driverTripLogTable, driverTripRatesTable, transportDeductionsTable, transportFeeMembersTable,
  driversTable, factoriesTable, workersTable, driverShiftAssignmentsTable, scheduleWeeksTable,
  scheduleEntriesTable, shiftCancellationsTable, svodniRowsTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lte, sql } from "drizzle-orm";
import { authRequired, requireAnyCap } from "../lib/auth";
import { weekFromForMonth, entryDateStr } from "../lib/dates";
import { factoryShiftHours } from "../bot/time";

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
  // місяці для вибору: наявні зняття ∪ місяці сводних (розрахунок іде з годин
  // сводної, тож будь-який її місяць — валідна ціль ще ДО перших рядків знять)
  const months = await db.selectDistinct({ m: transportDeductionsTable.periodMonth }).from(transportDeductionsTable);
  const svodniMonths = await db.selectDistinct({ m: svodniRowsTable.periodMonth }).from(svodniRowsTable);
  // години сводної пари (довідково поруч зі змінами — з них зміни й рахуються)
  const svodniHours = await db.select({
    workerId: svodniRowsTable.workerId, factoryId: svodniRowsTable.factoryId,
    hours: sql<number>`coalesce(sum(${svodniRowsTable.hours}), 0)`,
  }).from(svodniRowsTable)
    .where(and(eq(svodniRowsTable.periodMonth, month), sql`${svodniRowsTable.segmentOf} IS NULL`))
    .groupBy(svodniRowsTable.workerId, svodniRowsTable.factoryId);
  const hoursByPair = new Map(svodniHours.map((r) => [`${r.workerId}|${r.factoryId}`, Number(r.hours)]));
  // Вкладка показує ВСІХ людей платних фабрик місяця (за годинами сводної),
  // навіть без нарахування (self_transport без посадок, ліміти) — такі рядки
  // «віртуальні»: без id/суми, лише довідково. Плюс маркер «доїжджає сам».
  const paidFacs = (await db.select().from(factoriesTable)).filter(f => f.paidTransport);
  const paidFacById = new Map(paidFacs.map(f => [f.id, f]));
  const dedPairs = new Set(rows.filter(r => r.d.workerId != null && r.d.factoryId != null).map(r => `${r.d.workerId}|${r.d.factoryId}`));
  const extraPairs = svodniHours.filter(p =>
    p.workerId != null && p.factoryId != null && Number(p.hours) > 0 &&
    paidFacById.has(p.factoryId) && !dedPairs.has(`${p.workerId}|${p.factoryId}`));
  const wIds = [...new Set([...rows.map(r => r.d.workerId), ...extraPairs.map(p => p.workerId!)].filter((x): x is number => x != null))];
  const workers = wIds.length ? await db.select({
    id: workersTable.id, fullName: workersTable.fullName,
    selfTransport: workersTable.selfTransport, selfTransportSince: workersTable.selfTransportSince,
    nationality: workersTable.nationality,
  }).from(workersTable).where(inArray(workersTable.id, wIds)) : [];
  const wById = new Map(workers.map(w => [w.id, w]));
  const selfOf = (workerId: number | null) => {
    const w = workerId != null ? wById.get(workerId) : undefined;
    return { selfTransport: w?.selfTransport ?? false, selfTransportSince: w?.selfTransportSince ?? null, nationality: w?.nationality ?? null };
  };
  const listed = [
    ...rows.map(({ d, workerName, factoryName }) => ({
      id: d.id as number | null, workerId: d.workerId, workerName: workerName ?? d.workerName,
      factoryId: d.factoryId, factoryLabel: factoryName ?? d.factoryLabel,
      tripsCount: d.tripsCount, amount: d.amount as number | null, note: d.note, sourceRef: d.sourceRef,
      hours: hoursByPair.get(`${d.workerId}|${d.factoryId}`) ?? null,
      ...selfOf(d.workerId),
    })),
    ...extraPairs.map((p) => ({
      id: null, workerId: p.workerId!, workerName: wById.get(p.workerId!)?.fullName ?? null,
      factoryId: p.factoryId!, factoryLabel: paidFacById.get(p.factoryId!)?.name ?? null,
      tripsCount: null, amount: null, note: null, sourceRef: null,
      hours: Number(p.hours),
      ...selfOf(p.workerId),
    })),
  ];
  ok(res, {
    month,
    months: [...new Set([...months.map((x) => x.m), ...svodniMonths.map((x) => x.m)])].sort().reverse(),
    rows: listed.sort((a, b) => (a.factoryLabel ?? "").localeCompare(b.factoryLabel ?? "", "pl") || (a.workerName ?? "").localeCompare(b.workerName ?? "", "pl")),
  });
});

router.post("/transport/deductions", RW, async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  const workerId = Number(req.body?.workerId);
  const amount = Number(req.body?.amount);
  if (!month || !Number.isFinite(workerId) || !Number.isFinite(amount) || amount < 0) return fail(res, 400, "month, workerId, сума ≥ 0");
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return fail(res, 404, "працівника не знайдено");
  // фабрика пари: явна з тіла (кнопка ✎ на віртуальному рядку вкладки — зокрема
  // self_transport, яким авторозрахунок нічого не нараховує) або фабрика профілю
  const factoryId = req.body?.factoryId != null && Number.isFinite(Number(req.body.factoryId))
    ? Number(req.body.factoryId) : w.factoryId;
  const [fac] = factoryId != null ? await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)) : [];
  const [created] = await db.insert(transportDeductionsTable).values({
    periodMonth: month, workerId, amount: r2(amount),
    tripsCount: Number.isFinite(Number(req.body?.tripsCount)) && req.body?.tripsCount !== "" && req.body?.tripsCount != null ? Math.floor(Number(req.body.tripsCount)) : null,
    factoryId, factoryLabel: fac?.name ?? null,
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
  // правка суми/змін на авто-рядку робить його ручним: повторний «Розрахувати»
  // такий рядок більше не перетирає (замітка ручним не робить)
  if (patch.amount !== undefined || patch.tripsCount !== undefined) {
    const [cur] = await db.select().from(transportDeductionsTable).where(eq(transportDeductionsTable.id, id));
    if (cur?.sourceRef === "auto") patch.sourceRef = "manual-edit";
  }
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

// ─── Вибірковий платний довіз: хто платить на фабриці ────────────────────────
// Порожній список фабрики = платить уся фабрика (як досі); є вибрані —
// авторозрахунок тарифікує лише їх. Ціна/ліміт — завжди фабричні.
router.get("/transport/fee-members", async (_req, res) => {
  const facs = (await db.select().from(factoriesTable)).filter(f => f.paidTransport);
  const ids = facs.map(f => f.id);
  const members = ids.length
    ? await db.select({
        factoryId: transportFeeMembersTable.factoryId,
        workerId: transportFeeMembersTable.workerId,
        name: workersTable.fullName,
      }).from(transportFeeMembersTable)
        .innerJoin(workersTable, eq(transportFeeMembersTable.workerId, workersTable.id))
        .where(inArray(transportFeeMembersTable.factoryId, ids))
    : [];
  ok(res, {
    factories: facs.map(f => ({
      factoryId: f.id, name: f.name,
      feePerShift: f.transportFeePerShift, monthCap: f.transportFeeMonthCap,
      members: members.filter(m => m.factoryId === f.id)
        .map(m => ({ workerId: m.workerId, name: m.name }))
        .sort((a, b) => a.name.localeCompare(b.name, "pl")),
    })).sort((a, b) => a.name.localeCompare(b.name, "pl")),
  });
});

// кандидати для модалки вибору: активні працівники фабрики (профіль) ∪ люди з
// рядками сводної цієї фабрики за місяць (реально їздили) ∪ уже вибрані
router.get("/transport/fee-members/candidates", async (req, res) => {
  const factoryId = Number(req.query.factoryId);
  if (!Number.isFinite(factoryId)) return fail(res, 400, "factoryId required");
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  const svodniWorkers = month
    ? await db.select({ workerId: svodniRowsTable.workerId }).from(svodniRowsTable).where(and(
        eq(svodniRowsTable.periodMonth, month), eq(svodniRowsTable.factoryId, factoryId),
        isNull(svodniRowsTable.segmentOf), isNotNull(svodniRowsTable.workerId)))
    : [];
  const hasHours = new Set(svodniWorkers.map(r => r.workerId!));
  const memberIds = new Set((await db.select({ workerId: transportFeeMembersTable.workerId })
    .from(transportFeeMembersTable).where(eq(transportFeeMembersTable.factoryId, factoryId))).map(r => r.workerId));
  const profileWorkers = await db.select().from(workersTable).where(and(
    eq(workersTable.factoryId, factoryId), eq(workersTable.isActive, true)));
  const extraIds = [...new Set([...hasHours, ...memberIds])].filter(id => !profileWorkers.some(w => w.id === id));
  const extra = extraIds.length ? await db.select().from(workersTable).where(inArray(workersTable.id, extraIds)) : [];
  ok(res, {
    candidates: [...profileWorkers, ...extra].map(w => ({
      workerId: w.id, name: w.fullName, isActive: w.isActive,
      hasHours: hasHours.has(w.id), member: memberIds.has(w.id),
    })).sort((a, b) => a.name.localeCompare(b.name, "pl")),
  });
});

// повна заміна складу вибраних фабрики
router.put("/transport/fee-members", RW, async (req, res) => {
  const factoryId = Number(req.body?.factoryId);
  const workerIds = Array.isArray(req.body?.workerIds)
    ? [...new Set((req.body.workerIds as unknown[]).map(Number).filter(Number.isFinite))]
    : null;
  if (!Number.isFinite(factoryId) || !workerIds) return fail(res, 400, "factoryId і workerIds[] обовʼязкові");
  const [fac] = await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  if (!fac) return fail(res, 404, "фабрику не знайдено");
  if (workerIds.length) {
    const found = await db.select({ id: workersTable.id }).from(workersTable).where(inArray(workersTable.id, workerIds));
    if (found.length !== workerIds.length) return fail(res, 400, "невідомі workerIds");
  }
  await db.transaction(async (tx) => {
    await tx.delete(transportFeeMembersTable).where(eq(transportFeeMembersTable.factoryId, factoryId));
    if (workerIds.length) {
      await tx.insert(transportFeeMembersTable).values(workerIds.map(w => ({ factoryId, workerId: w })));
    }
  });
  ok(res, { ok: true, members: workerIds.length });
});

// ─── Авторозрахунок знять за місяць ──────────────────────────────────────────
// Фабрики з «платним довозом» (paid_transport + ціна за зміну): кожному
// працівнику сума = min(зміни × ціна, місячний ліміт). Кількість змін —
// ЗАВЖДИ з годин, перенесених до сводної (svodni_rows.hours пари працівник+
// фабрика за місяць): ceil(години ÷ тривалість 1-ї зміни фабрики, 8/12 год).
// Тож флоу: заповнити сводну (from-hours) → розрахувати → перенести.
// self_transport (доїжджають самі) — виняток: тарифікуються лише зміни, де
// водій позначив посадку (picked_up_by у затверджених тижнях місяця, без
// скасованих клітинок).
// Вибірковість: фабрика зі списком transport_fee_members тарифікує ЛИШЕ
// вибраних (порожній список = уся фабрика).
// Повторний запуск перезаписує ЛИШЕ авто-рядки (source_ref='auto'); рядки,
// створені чи правлені вручну, не чіпаються. Авто-рядки пар, яких більше не
// нарахувалось, зносяться.
router.post("/transport/deductions/generate", RW, async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = m! === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;

  const paidFactories = (await db.select().from(factoriesTable))
    .filter(f => f.paidTransport && (f.transportFeePerShift ?? 0) > 0);
  if (!paidFactories.length) return fail(res, 400, "немає фабрик з платним довозом (увімкни в налаштуваннях фабрики і вкажи ціну за зміну)");
  const paidIds = paidFactories.map(f => f.id);
  const facById = new Map(paidFactories.map(f => [f.id, f]));

  // 1) години пар із сводної місяця (сегменти не дублюємо — лише батьківські
  // рядки; кілька рядків пари, напр. фірмові вкладки multi_firm — сумуються)
  const svodniRows = await db.select({
    workerId: svodniRowsTable.workerId, factoryId: svodniRowsTable.factoryId, hours: svodniRowsTable.hours,
  }).from(svodniRowsTable).where(and(
    eq(svodniRowsTable.periodMonth, month), isNull(svodniRowsTable.segmentOf),
    inArray(svodniRowsTable.factoryId, paidIds),
  ));
  const hoursByPair = new Map<string, number>();
  for (const r of svodniRows) {
    if (r.workerId == null || !(r.hours != null && r.hours > 0)) continue;
    const k = `${r.workerId}|${r.factoryId}`;
    hoursByPair.set(k, (hoursByPair.get(k) ?? 0) + r.hours);
  }
  const workerIds = new Set<number>([...hoursByPair.keys()].map(k => Number(k.split("|")[0])));
  const shiftsByPair = new Map<string, number>(); // workerId|factoryId → зміни
  for (const [k, hours] of hoursByPair) {
    const factoryId = Number(k.split("|")[1]);
    const shiftLen = factoryShiftHours(facById.get(factoryId), "1" as any) || 8;
    shiftsByPair.set(k, Math.ceil(hours / shiftLen));
  }

  // 2) self_transport: години сводної не тарифікуємо — лише зміни з посадкою
  // водієм (затверджені тижні, дата в місяці, без скасованих клітинок).
  // Режим вирішується ПОМІСЯЧНО через self_transport_since («діє з»): прапорець
  // увімкнули з датою після кінця місяця → у цьому місяці людина ще «звичайна»;
  // вимкнули з датою після кінця місяця → у цьому місяці ще була self. Без дати
  // (легасі) — за поточним прапорцем. Перехід усередині місяця не ламається:
  // посадки водія поденні й тарифікуються самі собою.
  const isSelfForMonth = (w: { selfTransport: boolean; selfTransportSince: string | null }): boolean =>
    w.selfTransport ? (w.selfTransportSince == null || w.selfTransportSince < monthEnd)
      : (w.selfTransportSince != null && w.selfTransportSince >= monthEnd);
  const workers = workerIds.size
    ? await db.select().from(workersTable).where(inArray(workersTable.id, [...workerIds]))
    : [];
  const selfIds = new Set(workers.filter(isSelfForMonth).map(w => w.id));
  for (const k of [...shiftsByPair.keys()]) {
    if (selfIds.has(Number(k.split("|")[0]))) shiftsByPair.delete(k);
  }
  {
    const weeks = await db.select().from(scheduleWeeksTable).where(and(
      eq(scheduleWeeksTable.status, "approved"),
      gte(scheduleWeeksTable.weekStart, weekFromForMonth(monthStart)),
      lte(scheduleWeeksTable.weekStart, monthEnd),
    ));
    const weekById = new Map(weeks.map(w => [w.id, w.weekStart]));
    const weekIds = weeks.map(w => w.id);
    const picked = weekIds.length
      ? await db.select().from(scheduleEntriesTable).where(and(
          inArray(scheduleEntriesTable.weekId, weekIds), inArray(scheduleEntriesTable.factoryId, paidIds),
          isNotNull(scheduleEntriesTable.pickedUpBy)))
      : [];
    const cancels = weekIds.length
      ? await db.select().from(shiftCancellationsTable).where(and(
          inArray(shiftCancellationsTable.weekId, weekIds), inArray(shiftCancellationsTable.factoryId, paidIds)))
      : [];
    const cancelled = new Set(cancels.map(c => `${c.weekId}|${c.factoryId}|${c.dayOfWeek}|${c.shift}`));
    const selfWorkerIds = new Set<number>(picked.map(e => e.workerId));
    const selfWorkers = selfWorkerIds.size
      ? await db.select().from(workersTable).where(inArray(workersTable.id, [...selfWorkerIds]))
      : [];
    for (const w of selfWorkers) if (isSelfForMonth(w)) selfIds.add(w.id);
    for (const e of picked) {
      if (!selfIds.has(e.workerId)) continue;
      const ws = weekById.get(e.weekId);
      if (!ws) continue;
      const date = entryDateStr(String(ws), e.dayOfWeek);
      if (date < monthStart || date >= monthEnd) continue;
      if (cancelled.has(`${e.weekId}|${e.factoryId}|${e.dayOfWeek}|${e.shift}`)) continue;
      const k = `${e.workerId}|${e.factoryId}`;
      shiftsByPair.set(k, (shiftsByPair.get(k) ?? 0) + 1);
    }
  }

  // 2b) вибірковий платний довіз: фабрика зі списком «хто платить» тарифікує
  // лише вибраних — стосується і звичайних пар (години сводної), і
  // self_transport-посадок
  const feeMembers = await db.select().from(transportFeeMembersTable)
    .where(inArray(transportFeeMembersTable.factoryId, paidIds));
  const membersByFactory = new Map<number, Set<number>>();
  for (const m of feeMembers) {
    (membersByFactory.get(m.factoryId) ?? membersByFactory.set(m.factoryId, new Set()).get(m.factoryId)!).add(m.workerId);
  }
  for (const k of [...shiftsByPair.keys()]) {
    const [wId, fId] = k.split("|").map(Number);
    const mem = membersByFactory.get(fId!);
    if (mem?.size && !mem.has(wId!)) shiftsByPair.delete(k);
  }

  // 3) суми + upsert (ручні рядки пари не чіпаємо, авто — оновлюємо/зносимо)
  const existing = await db.select().from(transportDeductionsTable)
    .where(eq(transportDeductionsTable.periodMonth, month));
  const existingByPair = new Map(existing.filter(r => r.workerId != null && r.factoryId != null)
    .map(r => [`${r.workerId}|${r.factoryId}`, r]));
  let created = 0, updated = 0, deleted = 0, skippedManual = 0;
  const seen = new Set<string>();
  for (const [k, shifts] of shiftsByPair) {
    if (!(shifts > 0)) continue;
    const [workerId, factoryId] = k.split("|").map(Number);
    const fac = facById.get(factoryId!)!;
    const fee = fac.transportFeePerShift!;
    const cap = fac.transportFeeMonthCap;
    const amount = r2(Math.min(shifts * fee, cap != null && cap > 0 ? cap : Infinity));
    seen.add(k);
    const prev = existingByPair.get(k);
    if (prev) {
      if (prev.sourceRef !== "auto") { skippedManual++; continue; }
      if (prev.amount !== amount || prev.tripsCount !== shifts) {
        await db.update(transportDeductionsTable)
          .set({ amount, tripsCount: shifts, factoryLabel: fac.name })
          .where(eq(transportDeductionsTable.id, prev.id));
        updated++;
      }
    } else {
      await db.insert(transportDeductionsTable).values({
        periodMonth: month, workerId, factoryId, factoryLabel: fac.name,
        tripsCount: shifts, amount, sourceRef: "auto",
      });
      created++;
    }
  }
  // авто-рядки платних фабрик, яких більше не нарахувалось (людину прибрали з
  // графіку, ціну змінили) — зносимо, щоб не висіли стейлом
  for (const [k, prev] of existingByPair) {
    if (prev.sourceRef !== "auto" || seen.has(k)) continue;
    if (!paidIds.includes(prev.factoryId!)) continue;
    await db.delete(transportDeductionsTable).where(eq(transportDeductionsTable.id, prev.id));
    deleted++;
  }
  ok(res, {
    month, created, updated, deleted, skippedManual,
    factories: paidFactories.map(f => f.name).sort(),
  });
});

export default router;
