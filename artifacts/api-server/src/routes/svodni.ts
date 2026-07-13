// «Сводні» (/svodni) — повне дзеркало зарплатних таблиць по містах.
// Доступ: capability `svodni` (сторінка, відкритий шар: фактичні години,
// ставки, відрахування, до виплати); закритий шар (księgowość-години,
// ksieg brutto/netto, готівка, конто) віддається ЛИШЕ з `svodniSensitive`
// (owner бачить усе) — фільтрація тут, в API, а не в інтерфейсі.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { svodniRowsTable, svodniTabChecksTable, workersTable } from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { authRequired, requireCap, type AuthedRequest } from "../lib/auth";
import { hasCap } from "../lib/roles";
import { logger } from "../lib/logger";
import { matchWorker } from "../bot/workerMatch";
import { cleanName } from "../services/payrollSummaries";
import { rematchSvodni, applyRatesFromSvodni, ensureSvodniFactories, dedupeWorkers } from "../services/svodniSync";

const router: IRouter = Router();
router.use(authRequired);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const canSensitive = (req: AuthedRequest) => hasCap(req.admin!.role, req.admin!.caps, "svodniSensitive");

router.get("/svodni/months", requireCap("svodni"), async (_req, res) => {
  const rows = await db.selectDistinct({ m: svodniRowsTable.periodMonth }).from(svodniRowsTable);
  ok(res, { months: rows.map(x => x.m).sort().reverse() });
});

router.get("/svodni", requireCap("svodni"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const city = String(req.query.city ?? "").trim() || null;
  const sensitive = canSensitive(req);

  const where = city
    ? and(eq(svodniRowsTable.periodMonth, month), eq(svodniRowsTable.city, city))
    : eq(svodniRowsTable.periodMonth, month);
  const raw = await db.select({ r: svodniRowsTable, workerName: workersTable.fullName })
    .from(svodniRowsTable)
    .leftJoin(workersTable, eq(svodniRowsTable.workerId, workersTable.id))
    .where(where)
    .orderBy(asc(svodniRowsTable.factoryLabel), asc(svodniRowsTable.sortIdx));

  const SENSITIVE_EXTRAS = new Set(["kontoH", "gotowkaH", "doplataEs"]);
  const rows = raw.map(({ r, workerName }) => {
    const base: Record<string, unknown> = {
      id: r.id, city: r.city, firm: r.firm, factoryLabel: r.factoryLabel, factoryId: r.factoryId,
      sortIdx: r.sortIdx, section: r.section, rawName: r.rawName,
      workerId: r.workerId, workerName, linkStatus: r.linkStatus,
      hoursNotified: r.hoursNotified, hours: r.hours, shifts: r.shifts,
      rateBrutto: r.rateBrutto, rateNetto: r.rateNetto, premia: r.premia,
      zaliczka: r.zaliczka, zaliczkaBd: r.zaliczkaBd, hostel: r.hostel, odziez: r.odziez,
      dojazd: r.dojazd, kara: r.kara, komornik: r.komornik, kaucja: r.kaucja,
      potracenia: r.potracenia, doWyplaty: r.doWyplaty, brutto: r.brutto,
      isStudent: r.isStudent, under26: r.under26,
      extras: sensitive ? r.extras : Object.fromEntries(Object.entries(r.extras as Record<string, unknown>).filter(([k]) => !SENSITIVE_EXTRAS.has(k))),
      hr: r.hr, mismatch: r.mismatch,
    };
    if (sensitive) {
      base.hoursDeclared = r.hoursDeclared;
      base.ksiegBrutto = r.ksiegBrutto;
      base.ksiegNetto = r.ksiegNetto;
      base.gotowka = r.gotowka;
      base.konto = r.konto;
    }
    return base;
  });

  const checks = await db.select().from(svodniTabChecksTable).where(
    city
      ? and(eq(svodniTabChecksTable.periodMonth, month), eq(svodniTabChecksTable.city, city))
      : eq(svodniTabChecksTable.periodMonth, month));

  const cities = (await db.selectDistinct({ c: svodniRowsTable.city }).from(svodniRowsTable)
    .where(eq(svodniRowsTable.periodMonth, month))).map(x => x.c).sort();

  ok(res, { month, city, cities, rows, checks, sensitive });
});

// незматчені люди: місто · фабрика · місяці + кандидати для привʼязки
router.get("/svodni/unmatched", requireCap("svodni"), async (_req, res) => {
  const rows = await db.select({
    rawName: svodniRowsTable.rawName, city: svodniRowsTable.city,
    factoryLabel: svodniRowsTable.factoryLabel, periodMonth: svodniRowsTable.periodMonth,
  }).from(svodniRowsTable).where(eq(svodniRowsTable.linkStatus, "unmatched"));
  const workers = dedupeWorkers(await db.select({ id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode, isActive: workersTable.isActive })
    .from(workersTable));
  const grouped = new Map<string, { rawName: string; city: string; factories: Set<string>; months: Set<string> }>();
  for (const r of rows) {
    const k = `${r.city}::${cleanName(r.rawName).toUpperCase()}`;
    const g = grouped.get(k) ?? grouped.set(k, { rawName: r.rawName, city: r.city, factories: new Set(), months: new Set() }).get(k)!;
    g.factories.add(r.factoryLabel);
    g.months.add(r.periodMonth);
  }
  const out = [...grouped.values()].map(g => ({
    rawName: g.rawName, city: g.city,
    factories: [...g.factories].sort(), months: [...g.months].sort(),
    candidates: matchWorker(cleanName(g.rawName), workers).candidates.slice(0, 4).map(w => ({ id: w.id, name: w.fullName })),
  })).sort((a, b) => a.city.localeCompare(b.city) || a.rawName.localeCompare(b.rawName));
  ok(res, { people: out });
});

// ручна привʼязка / «зовнішній» / скидання — на всі рядки цього імені в місті
router.post("/svodni/link", requireCap("svodni"), async (req, res) => {
  const rawName = String(req.body?.rawName ?? "").trim();
  const city = String(req.body?.city ?? "").trim();
  const workerId = req.body?.workerId != null ? Number(req.body.workerId) : null;
  const status = String(req.body?.status ?? (workerId ? "confirmed" : "external"));
  if (!rawName || !city) return fail(res, 400, "rawName і city обовʼязкові");
  if (!["confirmed", "external", "unmatched"].includes(status)) return fail(res, 400, "bad status");
  if (status === "confirmed" && !workerId) return fail(res, 400, "workerId обовʼязковий для confirmed");
  const all = await db.select({ id: svodniRowsTable.id, rawName: svodniRowsTable.rawName })
    .from(svodniRowsTable).where(eq(svodniRowsTable.city, city));
  const keyOf = (s: string) => cleanName(s).toUpperCase();
  const ids = all.filter(r => keyOf(r.rawName) === keyOf(rawName)).map(r => r.id);
  if (!ids.length) return fail(res, 404, "рядків не знайдено");
  await db.update(svodniRowsTable)
    .set({ workerId: status === "confirmed" ? workerId : null, linkStatus: status })
    .where(inArray(svodniRowsTable.id, ids));
  ok(res, { updated: ids.length });
});

router.post("/svodni/rematch", requireCap("svodni"), async (_req, res) => {
  ok(res, await rematchSvodni());
});

// повний синк із Google (книги місяців з реєстру /payroll) + фабрики
router.post("/svodni/sync", requireCap("svodni"), async (req, res) => {
  const months: string[] = Array.isArray(req.body?.months) ? req.body.months.filter(validMonth) : [];
  if (!months.length) return fail(res, 400, "months=[YYYY-MM,…] обовʼязково");
  try {
    const { syncSvodni } = await import("../services/svodniSync");
    const result = await syncSvodni(months);
    const factories = await ensureSvodniFactories();
    ok(res, { result, factories });
  } catch (e) {
    logger.error({ err: e }, "svodni sync failed");
    fail(res, 500, "Помилка синхронізації");
  }
});

// застосувати ставки/студент/до-26 місяця до профілів працівників (фінансова дія)
router.post("/svodni/apply-rates", requireCap("viewFinance"), async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  ok(res, await applyRatesFromSvodni(month));
});

export default router;
