// Пальне (cap `fuel`): фактури Orlen — імпорт PDF, місячна аналітика по
// місту/водію/авто/продукту, дрил-даун транзакцій, довідник флотових карток.
// «Місто» аналітики — місто команди з довідника картки (не місто станції).
// Місяць — за фактичною датою транзакції (фактура легально перетинає місяці).
import { Router, type IRouter } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import {
  fuelInvoicesTable, fuelTransactionsTable, fuelCardsTable,
  driversTable, vehiclesTable,
} from "@workspace/db";
import { eq, and, gte, lt, desc, sql } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";
import { parseOrlenPdf } from "../services/orlenFuel";
import { wojewodztwoOf } from "../services/plRegions";

const router: IRouter = Router();
router.use(authRequired);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
// період = місяць YYYY-MM або цілий рік YYYY
const validPeriod = (m: any) => typeof m === "string" && /^\d{4}(-(0[1-9]|1[0-2]))?$/.test(m);
const r2 = (n: number) => Math.round(n * 100) / 100;

// [від, до) для періоду — дати рахуємо рядками, без Date/toISOString
const periodRange = (period: string): [string, string] => {
  if (period.length === 4) return [`${period}-01-01`, `${Number(period) + 1}-01-01`];
  const [y, m] = period.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return [`${period}-01`, `${next}-01`];
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 40 } });

// ── Імпорт PDF ──────────────────────────────────────────────────────────────
// Кілька файлів за раз; фактура з тим самим номером замінюється (перезаливка безпечна).
router.post("/fuel/import", requireCap("fuel"), upload.array("files", 40), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) return fail(res, 400, "додай PDF-файли фактур (files)");

  const results: any[] = [];
  for (const f of files) {
    try {
      const inv = await parseOrlenPdf(new Uint8Array(f.buffer));
      const txSum = r2(inv.transactions.reduce((a, t) => a + t.gross, 0));

      const [existing] = await db.select().from(fuelInvoicesTable).where(eq(fuelInvoicesTable.number, inv.number));
      if (existing) await db.delete(fuelInvoicesTable).where(eq(fuelInvoicesTable.id, existing.id)); // cascade → tx

      const [created] = await db.insert(fuelInvoicesTable).values({
        number: inv.number, invoiceDate: inv.invoiceDate, saleDate: inv.saleDate,
        ksefNumber: inv.ksefNumber, net: inv.net, vat: inv.vat, gross: inv.gross,
        fileName: f.originalname,
      }).returning();
      if (inv.transactions.length) {
        await db.insert(fuelTransactionsTable).values(inv.transactions.map(t => ({
          invoiceId: created!.id, lp: t.lp, cardNumber: t.cardNumber, regNumber: t.regNumber,
          product: t.product, isFuel: t.isFuel, stationCity: t.stationCity, stationNo: t.stationNo,
          txDate: t.txDate, txTime: t.txTime, qty: t.qty, unitPrice: t.unitPrice,
          priceAfterRebate: t.priceAfterRebate, vatRate: t.vatRate,
          net: t.net, vatAmount: t.vatAmount, gross: t.gross,
        })));
      }
      results.push({
        file: f.originalname, ok: true, number: inv.number, invoiceDate: inv.invoiceDate,
        replaced: !!existing, txCount: inv.transactions.length,
        gross: inv.gross, txSum, rebate: r2(inv.gross - txSum), // знижка рівня фактури поза wykaz-ом
        warnings: inv.warnings,
      });
    } catch (e: any) {
      results.push({ file: f.originalname, ok: false, error: e?.message ?? String(e) });
    }
  }
  ok(res, { results });
});

// ── Місяці та фактури ───────────────────────────────────────────────────────
router.get("/fuel/months", requireCap("fuel"), async (_req, res) => {
  const months = await db.execute(sql`SELECT DISTINCT substr(tx_date::text, 1, 7) AS m FROM fuel_transactions ORDER BY m DESC`);
  const years = await db.execute(sql`SELECT DISTINCT substr(tx_date::text, 1, 4) AS y FROM fuel_transactions ORDER BY y DESC`);
  const invoices = await db.select().from(fuelInvoicesTable).orderBy(desc(fuelInvoicesTable.invoiceDate));
  ok(res, { months: (months.rows as any[]).map(r => r.m), years: (years.rows as any[]).map(r => r.y), invoices });
});

// ── Місячна аналітика ───────────────────────────────────────────────────────
router.get("/fuel/summary", requireCap("fuel"), async (req, res) => {
  const month = validPeriod(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM|YYYY required");
  const [from, to] = periodRange(month);

  const txs = await db.select().from(fuelTransactionsTable)
    .where(and(gte(fuelTransactionsTable.txDate, from), lt(fuelTransactionsTable.txDate, to)));
  const cards = await db.select({
    c: fuelCardsTable,
    driverName: driversTable.name,
    vehiclePlate: vehiclesTable.plate,
  }).from(fuelCardsTable)
    .leftJoin(driversTable, eq(fuelCardsTable.driverId, driversTable.id))
    .leftJoin(vehiclesTable, eq(fuelCardsTable.vehicleId, vehiclesTable.id));
  const cardBy = new Map(cards.map(x => [x.c.cardNumber, x]));

  type Agg = { key: string; label: string; liters: number; fuelNet: number; fuelGross: number; goodsNet: number; goodsGross: number; net: number; gross: number; txCount: number };
  const aggInto = (map: Map<string, Agg>, key: string, label: string, t: typeof txs[number]) => {
    const a = map.get(key) ?? { key, label, liters: 0, fuelNet: 0, fuelGross: 0, goodsNet: 0, goodsGross: 0, net: 0, gross: 0, txCount: 0 };
    if (t.isFuel) { a.liters += t.qty; a.fuelNet += t.net; a.fuelGross += t.gross; }
    else { a.goodsNet += t.net; a.goodsGross += t.gross; }
    a.net += t.net; a.gross += t.gross; a.txCount += 1;
    map.set(key, a);
  };
  const finish = (map: Map<string, Agg>) =>
    [...map.values()]
      .map(a => ({ ...a, liters: r2(a.liters), fuelNet: r2(a.fuelNet), fuelGross: r2(a.fuelGross), goodsNet: r2(a.goodsNet), goodsGross: r2(a.goodsGross), net: r2(a.net), gross: r2(a.gross) }))
      .sort((a, b) => b.gross - a.gross);

  const byCity = new Map<string, Agg>(), byDriver = new Map<string, Agg>(), byVehicle = new Map<string, Agg>(),
    byCard = new Map<string, Agg>(), byProduct = new Map<string, Agg>(), byStationCity = new Map<string, Agg>(),
    byMonth = new Map<string, Agg>(), noRegByCard = new Map<string, Agg>();
  let liters = 0, fuelNet = 0, fuelGross = 0, goodsNet = 0, goodsGross = 0;

  for (const t of txs) {
    const card = cardBy.get(t.cardNumber);
    if (t.isFuel) { liters += t.qty; fuelNet += t.net; fuelGross += t.gross; }
    else { goodsNet += t.net; goodsGross += t.gross; }
    aggInto(byCity, card?.c.city ?? "", card?.c.city ?? "—", t);
    aggInto(byDriver, card?.driverName ?? card?.c.label ?? "", card?.driverName ?? card?.c.label ?? "—", t);
    const veh = t.regNumber ?? card?.vehiclePlate ?? "";
    aggInto(byVehicle, veh, veh || "—", t);
    // хто саме заправляв без номера авто — розгортання рядка «—» у «По авто»
    if (!veh) aggInto(noRegByCard, t.cardNumber, card?.driverName ?? card?.c.label ?? `…${t.cardNumber.slice(-6)}`, t);
    aggInto(byCard, t.cardNumber, t.cardNumber, t);
    aggInto(byProduct, t.isFuel ? t.product : "__goods__", t.isFuel ? t.product : "", t);
    if (t.isFuel) aggInto(byStationCity, t.stationCity ?? "", t.stationCity ?? "—", t);
    aggInto(byMonth, t.txDate.slice(0, 7), t.txDate.slice(0, 7), t);
  }

  // ── Пробіг авто за період ──────────────────────────────────────────────────
  // До 07.2026 — архівний журнал Любліна (driver_trip_log, км виїздів);
  // з 07.2026 — одометри бот-змін (driver_workdays). Ключ — номер без пробілів
  // (у журналі й автопарку номери гуляють: "LU 318 TV" ↔ "LU318TV").
  const BOT_KM_FROM = "2026-07-01";
  const normPlate = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").toUpperCase();
  // Рахуємо помісячно (`plate|YYYY-MM`), бо ручний оверрайд (fuel_km_overrides)
  // перекриває САМЕ місяць; період-рік = сума ефективних місяців.
  const kmAutoByPM = new Map<string, number>();
  const addAuto = (plate: string | null, m: string, km: number) => {
    const p = normPlate(plate);
    if (p) kmAutoByPM.set(`${p}|${m}`, (kmAutoByPM.get(`${p}|${m}`) ?? 0) + km);
  };
  if (from < BOT_KM_FROM) {
    const logKm = await db.execute(sql`
      SELECT vehicle_plate AS plate, substr(trip_date::text, 1, 7) AS m, sum(km)::int AS km
      FROM driver_trip_log
      WHERE km IS NOT NULL AND vehicle_plate IS NOT NULL
        AND trip_date >= ${from} AND trip_date < ${to < BOT_KM_FROM ? to : BOT_KM_FROM}
      GROUP BY 1, 2`);
    for (const r of logKm.rows as any[]) addAuto(r.plate, r.m, Number(r.km));
  }
  if (to > BOT_KM_FROM) {
    const botKm = await db.execute(sql`
      SELECT v.plate AS plate, substr(w.work_date::text, 1, 7) AS m, sum(w.odometer_end - w.odometer_start)::int AS km
      FROM driver_workdays w JOIN vehicles v ON v.id = w.vehicle_id
      WHERE w.odometer_end IS NOT NULL
        AND w.work_date >= ${from > BOT_KM_FROM ? from : BOT_KM_FROM} AND w.work_date < ${to}
      GROUP BY 1, 2`);
    for (const r of botKm.rows as any[]) addAuto(r.plate, r.m, Number(r.km));
  }
  const ovr = await db.execute(sql`
    SELECT plate, month, km FROM fuel_km_overrides
    WHERE month >= ${from.slice(0, 7)} AND month < ${to.slice(0, 7)}`);
  const ovrByPM = new Map((ovr.rows as any[]).map(r => [`${normPlate(r.plate)}|${r.month}`, Number(r.km)]));

  type KmAcc = { auto: number; eff: number; manual: number | null; edited: boolean };
  const kmAcc = new Map<string, KmAcc>();
  for (const pm of new Set([...kmAutoByPM.keys(), ...ovrByPM.keys()])) {
    const plate = pm.split("|")[0]!;
    const a = kmAcc.get(plate) ?? { auto: 0, eff: 0, manual: null, edited: false };
    const auto = kmAutoByPM.get(pm) ?? 0;
    const manual = ovrByPM.get(pm);
    a.auto += auto;
    a.eff += manual ?? auto;
    if (manual != null) { a.edited = true; if (month.length === 7) a.manual = manual; }
    kmAcc.set(plate, a);
  }
  const kmFields = (plate: string) => {
    const k = kmAcc.get(plate);
    return { km: k ? k.eff : null, kmAuto: k ? k.auto : null, kmManual: k?.manual ?? null, kmEdited: k?.edited ?? false };
  };
  const byVehicleRows: (Agg & ReturnType<typeof kmFields>)[] =
    finish(byVehicle).map(a => ({ ...a, ...kmFields(normPlate(a.key)) }));
  // авто з пробігом, але без заправок за період (напр. Renault без своєї картки) — теж у список
  const fueledPlates = new Set(byVehicleRows.map(a => normPlate(a.key)).filter(Boolean));
  for (const [plate, k] of [...kmAcc.entries()].sort((a, b) => b[1].eff - a[1].eff)) {
    if (!fueledPlates.has(plate)) byVehicleRows.push({ key: plate, label: plate, liters: 0, fuelNet: 0, fuelGross: 0, goodsNet: 0, goodsGross: 0, net: 0, gross: 0, txCount: 0, km: k.eff, kmAuto: k.auto, kmManual: month.length === 7 ? k.manual : null, kmEdited: k.edited });
  }

  // збагачення розрізу карток мапінгом + невідомі картки
  const byCardRows = finish(byCard).map(a => {
    const card = cardBy.get(a.key);
    return {
      ...a,
      label: card?.c.label ?? a.key,
      city: card?.c.city ?? null,
      driverName: card?.driverName ?? null,
      vehiclePlate: card?.vehiclePlate ?? null,
      mapped: !!card,
      regNumbers: [...new Set(txs.filter(t => t.cardNumber === a.key && t.regNumber).map(t => t.regNumber!))],
    };
  });
  const unmappedCards = byCardRows.filter(c => !c.mapped);

  const invoices = await db.select().from(fuelInvoicesTable).orderBy(desc(fuelInvoicesTable.invoiceDate));
  const avgPrice = liters > 0 ? r2(fuelGross / liters) : null;

  ok(res, {
    month,
    totals: {
      liters: r2(liters), fuelNet: r2(fuelNet), fuelGross: r2(fuelGross),
      goodsNet: r2(goodsNet), goodsGross: r2(goodsGross),
      net: r2(fuelNet + goodsNet), gross: r2(fuelGross + goodsGross),
      avgPricePerLiter: avgPrice, txCount: txs.length,
    },
    byCity: finish(byCity), byDriver: finish(byDriver), byVehicle: byVehicleRows,
    byProduct: finish(byProduct),
    // місто станції + воєводство — веб групує у регіони з розгортанням до міст
    byStationCity: finish(byStationCity).map(a => ({ ...a, region: wojewodztwoOf(a.key) })),
    byMonth: finish(byMonth).sort((a, b) => a.key.localeCompare(b.key)),
    noRegByCard: finish(noRegByCard).map(a => ({ ...a, cardNumber: a.key })),
    byCard: byCardRows, unmappedCards,
    invoices: invoices.filter(i => (i.saleDate ?? i.invoiceDate).startsWith(month) || i.invoiceDate.startsWith(month)),
  });
});

// ── Ручний пробіг ───────────────────────────────────────────────────────────
// Оверрайд км пари авто × місяць (km: null/"" — прибрати, повернутись до авто-розрахунку).
router.post("/fuel/km-override", requireCap("fuel"), async (req, res) => {
  const plate = String(req.body?.plate ?? "").replace(/\s+/g, "").toUpperCase();
  const m = String(req.body?.month ?? "");
  if (!plate || !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return fail(res, 400, "потрібні plate і month=YYYY-MM");
  const kmRaw = req.body?.km;
  if (kmRaw == null || kmRaw === "") {
    await db.execute(sql`DELETE FROM fuel_km_overrides WHERE plate = ${plate} AND month = ${m}`);
    return ok(res, { plate, month: m, km: null });
  }
  const km = Math.round(Number(kmRaw));
  if (!Number.isFinite(km) || km < 0 || km > 1_000_000) return fail(res, 400, "km — ціле число від 0");
  await db.execute(sql`
    INSERT INTO fuel_km_overrides (plate, month, km) VALUES (${plate}, ${m}, ${km})
    ON CONFLICT (plate, month) DO UPDATE SET km = EXCLUDED.km`);
  ok(res, { plate, month: m, km });
});

// ── Транзакції (дрил-даун) ──────────────────────────────────────────────────
router.get("/fuel/transactions", requireCap("fuel"), async (req, res) => {
  const month = validPeriod(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM|YYYY required");
  const [from, to] = periodRange(month);

  const conds = [gte(fuelTransactionsTable.txDate, from), lt(fuelTransactionsTable.txDate, to)];
  if (req.query.card) conds.push(eq(fuelTransactionsTable.cardNumber, String(req.query.card)));
  if (req.query.fuelOnly === "1") conds.push(eq(fuelTransactionsTable.isFuel, true));
  if (req.query.goodsOnly === "1") conds.push(eq(fuelTransactionsTable.isFuel, false));

  const rows = await db.select({
    t: fuelTransactionsTable,
    invoiceNumber: fuelInvoicesTable.number,
  }).from(fuelTransactionsTable)
    .innerJoin(fuelInvoicesTable, eq(fuelTransactionsTable.invoiceId, fuelInvoicesTable.id))
    .where(and(...conds))
    .orderBy(desc(fuelTransactionsTable.txDate), desc(fuelTransactionsTable.txTime));

  const cards = await db.select({ c: fuelCardsTable, driverName: driversTable.name, vehiclePlate: vehiclesTable.plate })
    .from(fuelCardsTable)
    .leftJoin(driversTable, eq(fuelCardsTable.driverId, driversTable.id))
    .leftJoin(vehiclesTable, eq(fuelCardsTable.vehicleId, vehiclesTable.id));
  const cardBy = new Map(cards.map(x => [x.c.cardNumber, x]));

  // фільтри по мапінгу картки — після join-у в памʼяті (обсяг місяця невеликий)
  let out = rows;
  if (req.query.city !== undefined) out = out.filter(r => (cardBy.get(r.t.cardNumber)?.c.city ?? "") === String(req.query.city));
  if (req.query.driver !== undefined) out = out.filter(r => (cardBy.get(r.t.cardNumber)?.driverName ?? "") === String(req.query.driver));
  // ключ авто — як у зведенні: номер із фактури, інакше авто з довідника картки
  if (req.query.vehicle !== undefined) out = out.filter(r => (r.t.regNumber ?? cardBy.get(r.t.cardNumber)?.vehiclePlate ?? "") === String(req.query.vehicle));
  if (req.query.product !== undefined) out = out.filter(r => r.t.isFuel && r.t.product === String(req.query.product));
  if (req.query.stationCity !== undefined) out = out.filter(r => (r.t.stationCity ?? "") === String(req.query.stationCity));
  // регіон = воєводство міста станції; "__other__" — міста поза мапою plRegions
  if (req.query.region !== undefined) {
    const want = String(req.query.region);
    out = out.filter(r => (wojewodztwoOf(r.t.stationCity) ?? "__other__") === want);
  }

  ok(res, {
    rows: out.map(({ t, invoiceNumber }) => ({
      id: t.id, lp: t.lp, invoiceNumber,
      cardNumber: t.cardNumber,
      cardLabel: cardBy.get(t.cardNumber)?.c.label ?? null,
      driverName: cardBy.get(t.cardNumber)?.driverName ?? null,
      city: cardBy.get(t.cardNumber)?.c.city ?? null,
      regNumber: t.regNumber, product: t.product, isFuel: t.isFuel,
      stationCity: t.stationCity, stationNo: t.stationNo,
      txDate: t.txDate, txTime: t.txTime,
      qty: t.qty, unitPrice: t.unitPrice, priceAfterRebate: t.priceAfterRebate,
      vatRate: t.vatRate, net: t.net, vatAmount: t.vatAmount, gross: t.gross,
    })),
  });
});

// ── Довідник карток ─────────────────────────────────────────────────────────
router.get("/fuel/cards", requireCap("fuel"), async (_req, res) => {
  const cards = await db.select({ c: fuelCardsTable, driverName: driversTable.name, vehiclePlate: vehiclesTable.plate })
    .from(fuelCardsTable)
    .leftJoin(driversTable, eq(fuelCardsTable.driverId, driversTable.id))
    .leftJoin(vehiclesTable, eq(fuelCardsTable.vehicleId, vehiclesTable.id));
  // картки, які бачили у фактурах: останній номер авто + остання транзакція
  const seen = await db.execute(sql`
    SELECT card_number,
           max(tx_date::text) AS last_tx,
           (array_remove(array_agg(DISTINCT reg_number), NULL))[1] AS reg,
           count(*) AS tx_count
    FROM fuel_transactions GROUP BY card_number`);
  const known = new Set(cards.map(x => x.c.cardNumber));
  ok(res, {
    cards: cards.map(({ c, driverName, vehiclePlate }) => ({ ...c, driverName, vehiclePlate }))
      .sort((a, b) => (a.city ?? "").localeCompare(b.city ?? "") || (a.label ?? "").localeCompare(b.label ?? "")),
    seen: (seen.rows as any[]).map(r => ({
      cardNumber: r.card_number, lastTx: r.last_tx, regNumber: r.reg, txCount: Number(r.tx_count),
      mapped: known.has(r.card_number),
    })).sort((a, b) => a.cardNumber.localeCompare(b.cardNumber)),
  });
});

router.post("/fuel/cards", requireCap("fuel"), async (req, res) => {
  const cardNumber = String(req.body?.cardNumber ?? "").replace(/\s+/g, "");
  if (!/^\d{17}$/.test(cardNumber)) return fail(res, 400, "cardNumber: 17 цифр");
  const [existing] = await db.select().from(fuelCardsTable).where(eq(fuelCardsTable.cardNumber, cardNumber));
  if (existing) return fail(res, 409, "картка вже в довіднику");
  const [created] = await db.insert(fuelCardsTable).values({
    cardNumber,
    label: String(req.body?.label ?? "").trim() || null,
    city: String(req.body?.city ?? "").trim() || null,
    driverId: Number.isFinite(Number(req.body?.driverId)) && req.body?.driverId != null ? Number(req.body.driverId) : null,
    vehicleId: Number.isFinite(Number(req.body?.vehicleId)) && req.body?.vehicleId != null ? Number(req.body.vehicleId) : null,
    note: String(req.body?.note ?? "").trim() || null,
  }).returning();
  ok(res, created);
});

router.patch("/fuel/cards/:id", requireCap("fuel"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const patch: Record<string, unknown> = {};
  if (req.body?.label !== undefined) patch.label = String(req.body.label).trim() || null;
  if (req.body?.city !== undefined) patch.city = String(req.body.city).trim() || null;
  if (req.body?.driverId !== undefined) patch.driverId = req.body.driverId == null ? null : Number(req.body.driverId);
  if (req.body?.vehicleId !== undefined) patch.vehicleId = req.body.vehicleId == null ? null : Number(req.body.vehicleId);
  if (req.body?.note !== undefined) patch.note = String(req.body.note).trim() || null;
  if (req.body?.isActive !== undefined) patch.isActive = !!req.body.isActive;
  if (!Object.keys(patch).length) return fail(res, 400, "нема що оновлювати");
  const [u] = await db.update(fuelCardsTable).set(patch).where(eq(fuelCardsTable.id, id)).returning();
  ok(res, u ?? {});
});

router.delete("/fuel/cards/:id", requireCap("fuel"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(fuelCardsTable).where(eq(fuelCardsTable.id, id));
  ok(res, { ok: true });
});

// Видалення фактури (разом із транзакціями) — на випадок помилкового імпорту
router.delete("/fuel/invoices/:id", requireCap("fuel"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(fuelInvoicesTable).where(eq(fuelInvoicesTable.id, id));
  ok(res, { ok: true });
});

export default router;
