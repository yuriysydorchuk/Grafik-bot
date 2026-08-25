// Довідник хостелів (/hostels, вкладка «Хостели»): місто → хостел з умовами
// оренди (модель whole/per_place, ціна, кауція), проживання працівників
// (hostel_stays: хто де живе і скільки платить) і привʼязані рахунки за
// оренду/медіа (invoices.hostel_id). Список/мешканці — cap `svodni`;
// фінансовий шар (ціни, кауції, фактури, маржа) — лише `viewFinance`.
// Зняття з ЗП (hostel_deductions) лишаються в routes/svodni.ts; тут — генерація
// цих знять із проживань (fill-deductions, прорейт по днях).
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { hostelsTable, hostelStaysTable, hostelDeductionsTable, hostelRoomsTable, hostelPaymentsTable, invoicesTable, workersTable, companiesTable } from "@workspace/db";
import { and, asc, eq, inArray, isNull, or, gte, lte, sql } from "drizzle-orm";
import { authRequired, requireCap, requireAnyCap, type AuthedRequest } from "../lib/auth";
import { hasCap } from "../lib/roles";
import { canonCity } from "../services/svodniSync";

const router: IRouter = Router();
router.use(authRequired);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const validDate = (d: any) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const r2 = (n: number) => Math.round(n * 100) / 100;
const canFinance = (req: AuthedRequest) => hasCap(req.admin!.role, req.admin!.caps, "viewFinance");

const RENT_MODELS = new Set(["whole", "per_place"]);
const toAmount = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? r2(n) : NaN;
};

// межі місяця рядками (дати рахуємо рядком — правило проєкту)
const monthBounds = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, "0")}`, days };
};
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// ── Реєстр хостелів ──────────────────────────────────────────────────────────

// Огляд: хостели + мешканці місяця; з viewFinance — ще й фактури місяця,
// утримання з ЗП мешканців і маржа житла.
router.get("/hostels/registry", requireAnyCap("svodni", "viewFinance", "hostelOps"), async (req: AuthedRequest, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
  const { start, end } = monthBounds(month);
  const fin = canFinance(req);

  const hostels = await db.select({ h: hostelsTable, companyName: companiesTable.name })
    .from(hostelsTable)
    .leftJoin(companiesTable, eq(hostelsTable.companyId, companiesTable.id))
    .orderBy(asc(hostelsTable.city), asc(hostelsTable.name));

  // проживання, що перетинають місяць (+ відкриті)
  const stays = await db.select({ s: hostelStaysTable, workerName: workersTable.fullName, workerActive: workersTable.isActive })
    .from(hostelStaysTable)
    .innerJoin(workersTable, eq(hostelStaysTable.workerId, workersTable.id))
    .where(and(lte(hostelStaysTable.fromDate, end), or(isNull(hostelStaysTable.toDate), gte(hostelStaysTable.toDate, start))))
    .orderBy(asc(hostelStaysTable.fromDate));

  const staysByHostel = new Map<number, typeof stays>();
  for (const st of stays) (staysByHostel.get(st.s.hostelId) ?? staysByHostel.set(st.s.hostelId, []).get(st.s.hostelId)!).push(st);

  // фінансовий шар: фактури місяця по хостелах + утримання з ЗП мешканців
  let invByHostel = new Map<number, { id: number; number: string | null; issueDate: string | null; amount: number; counterparty: string | null; category: string | null }[]>();
  let deductedByWorker = new Map<number, number>();
  if (fin) {
    const invs = await db.select().from(invoicesTable)
      .where(and(eq(invoicesTable.periodMonth, month), sql`${invoicesTable.hostelId} IS NOT NULL`));
    for (const i of invs) {
      const list = invByHostel.get(i.hostelId!) ?? invByHostel.set(i.hostelId!, []).get(i.hostelId!)!;
      list.push({ id: i.id, number: i.number, issueDate: i.issueDate, amount: i.amount, counterparty: i.counterparty, category: (i.manualCategory ?? i.category) || null });
    }
    const workerIds = [...new Set(stays.map(st => st.s.workerId).filter((x): x is number => x != null))];
    if (workerIds.length) {
      const ded = await db.select().from(hostelDeductionsTable)
        .where(and(eq(hostelDeductionsTable.periodMonth, month), inArray(hostelDeductionsTable.workerId, workerIds)));
      for (const d of ded) deductedByWorker.set(d.workerId, r2((deductedByWorker.get(d.workerId) ?? 0) + d.amount));
    }
  }

  ok(res, {
    month,
    canFinance: fin,
    hostels: hostels.map(({ h, companyName }) => {
      const hs = staysByHostel.get(h.id) ?? [];
      const residents = hs.map(({ s, workerName, workerActive }) => ({
        stayId: s.id, workerId: s.workerId, workerName, workerActive,
        fromDate: s.fromDate, toDate: s.toDate,
        monthlyRate: s.monthlyRate ?? h.workerRate ?? null, rateIsCustom: s.monthlyRate != null,
        note: s.note,
      }));
      const current = hs.filter(x => !x.s.toDate || x.s.toDate >= end).length;
      const base = {
        id: h.id, name: h.name, city: h.city, address: h.address, rentModel: h.rentModel,
        places: h.places, workerRate: h.workerRate, landlord: h.landlord,
        companyId: h.companyId, companyName, active: h.active, note: h.note,
        residents, currentCount: current,
      };
      if (!fin) return base;
      const invoices = invByHostel.get(h.id) ?? [];
      const invoicesTotal = r2(invoices.reduce((a, i) => a + i.amount, 0));
      // орієнтовна вартість місяця: фактури, якщо привʼязані, інакше договірна ціна
      const rentCost = h.monthlyCost != null ? r2(h.rentModel === "per_place" ? h.monthlyCost * (h.places ?? (current || 1)) : h.monthlyCost) : null;
      const cost = invoicesTotal > 0 ? invoicesTotal : rentCost;
      const deducted = r2(residents.reduce((a, r) => a + (r.workerId != null ? deductedByWorker.get(r.workerId) ?? 0 : 0), 0));
      return {
        ...base,
        monthlyCost: h.monthlyCost, kaucja: h.kaucja, kaucjaNote: h.kaucjaNote,
        invoices, invoicesTotal, rentCost, deducted,
        margin: cost != null ? r2(deducted - cost) : null,
      };
    }),
  });
});

// легкий список для селекторів (привʼязка фактур, модалки); costInvoices —
// щоб бухгалтерія могла привʼязати рахунок за оренду/медіа при внесенні
router.get("/hostels/options", requireAnyCap("svodni", "viewFinance", "costInvoices"), async (_req, res) => {
  const rows = await db.select({ id: hostelsTable.id, name: hostelsTable.name, city: hostelsTable.city, active: hostelsTable.active })
    .from(hostelsTable).orderBy(asc(hostelsTable.city), asc(hostelsTable.name));
  ok(res, rows);
});

const hostelPatch = (b: any, patch: Record<string, unknown>): string | null => {
  if (b.name !== undefined) { if (!String(b.name).trim()) return "name required"; patch.name = String(b.name).trim(); }
  if (b.city !== undefined) { const c = canonCity(b.city); if (!c) return "city required"; patch.city = c; }
  if (b.address !== undefined) patch.address = b.address ? String(b.address).trim() : null;
  if (b.rentModel !== undefined) { if (!RENT_MODELS.has(String(b.rentModel))) return "rentModel must be whole|per_place"; patch.rentModel = String(b.rentModel); }
  for (const k of ["monthlyCost", "kaucja", "workerRate"] as const) {
    if (b[k] !== undefined) { const v = toAmount(b[k]); if (Number.isNaN(v)) return `${k} must be a number`; patch[k] = v; }
  }
  if (b.places !== undefined) {
    const p = b.places === null || b.places === "" ? null : Number(b.places);
    if (p !== null && (!Number.isInteger(p) || p < 0)) return "places must be a non-negative integer";
    patch.places = p;
  }
  if (b.kaucjaNote !== undefined) patch.kaucjaNote = b.kaucjaNote ? String(b.kaucjaNote).trim() : null;
  if (b.landlord !== undefined) patch.landlord = b.landlord ? String(b.landlord).trim() : null;
  if (b.companyId !== undefined) patch.companyId = b.companyId ? Number(b.companyId) : null;
  if (b.active !== undefined) patch.active = !!b.active;
  if (b.note !== undefined) patch.note = b.note ? String(b.note).trim() : null;
  return null;
};

router.post("/hostels/registry", requireCap("viewFinance"), async (req, res) => {
  const b = req.body ?? {};
  if (!b.name || !String(b.name).trim()) return fail(res, 400, "name required");
  if (!b.city || !String(b.city).trim()) return fail(res, 400, "city required");
  const patch: Record<string, unknown> = {};
  const err = hostelPatch(b, patch);
  if (err) return fail(res, 400, err);
  const [row] = await db.insert(hostelsTable).values(patch as typeof hostelsTable.$inferInsert).returning();
  ok(res, row);
});

router.patch("/hostels/registry/:id", requireCap("viewFinance"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(hostelsTable).where(eq(hostelsTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const patch: Record<string, unknown> = {};
  const err = hostelPatch(req.body ?? {}, patch);
  if (err) return fail(res, 400, err);
  if (!Object.keys(patch).length) return fail(res, 400, "nothing to update");
  const [updated] = await db.update(hostelsTable).set(patch).where(eq(hostelsTable.id, id)).returning();
  ok(res, updated);
});

router.delete("/hostels/registry/:id", requireCap("viewFinance"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(hostelStaysTable).where(eq(hostelStaysTable.hostelId, id));
  if (n > 0) return fail(res, 400, "у хостела є проживання — деактивуйте його замість видалення");
  await db.update(invoicesTable).set({ hostelId: null }).where(eq(invoicesTable.hostelId, id));
  await db.delete(hostelsTable).where(eq(hostelsTable.id, id));
  ok(res, { ok: true });
});

// ── Проживання ───────────────────────────────────────────────────────────────

router.post("/hostels/stays", requireAnyCap("svodni", "hostelOps"), async (req, res) => {
  const b = req.body ?? {};
  const hostelId = Number(b.hostelId), workerId = Number(b.workerId);
  if (!Number.isFinite(hostelId)) return fail(res, 400, "hostelId required");
  if (!Number.isFinite(workerId)) return fail(res, 400, "workerId required");
  if (!validDate(b.fromDate)) return fail(res, 400, "fromDate must be YYYY-MM-DD");
  if (b.toDate && !validDate(b.toDate)) return fail(res, 400, "bad toDate");
  if (b.toDate && b.toDate < b.fromDate) return fail(res, 400, "toDate before fromDate");
  const rate = toAmount(b.monthlyRate);
  if (Number.isNaN(rate)) return fail(res, 400, "monthlyRate must be a number");
  const [hostel] = await db.select().from(hostelsTable).where(eq(hostelsTable.id, hostelId));
  if (!hostel) return fail(res, 400, "unknown hostel");
  const [worker] = await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!worker) return fail(res, 400, "unknown worker");
  // відкрите проживання працівника (будь-де) закривається днем перед новим
  await db.update(hostelStaysTable)
    .set({ toDate: sql`(${b.fromDate}::date - 1)::date` })
    .where(and(eq(hostelStaysTable.workerId, workerId), isNull(hostelStaysTable.toDate), sql`${hostelStaysTable.fromDate} < ${b.fromDate}::date`));
  const [row] = await db.insert(hostelStaysTable).values({
    hostelId, workerId, fromDate: b.fromDate, toDate: b.toDate || null,
    roomId: Number.isFinite(Number(b.roomId)) && b.roomId ? Number(b.roomId) : null,
    payer: ["self", "payroll"].includes(String(b.payer)) ? String(b.payer) : null,
    deposit: toAmount(b.deposit) || null, keyDeposit: toAmount(b.keyDeposit) || null,
    monthlyRate: rate, note: b.note ? String(b.note).trim() : null,
  }).returning();
  ok(res, row);
  // правила проживання — мешканцеві в бот його мовою (best-effort, не блокує відповідь)
  void (async () => {
    try {
      const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
      if (!w?.telegramId) return;
      const { regulaminFor } = await import("../services/hostelRegulamin");
      const { bot } = await import("../bot");
      const text = `🏠 ${hostel.name}\n\n${regulaminFor(w.language)}`;
      for (let i = 0; i < text.length; i += 3900) {
        await bot.telegram.sendMessage(w.telegramId, text.slice(i, i + 3900));
      }
    } catch { /* мешканець без бота або бот лежить — не критично */ }
  })();
});

router.patch("/hostels/stays/:id", requireAnyCap("svodni", "hostelOps"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(hostelStaysTable).where(eq(hostelStaysTable.id, id));
  if (!row) return fail(res, 404, "not found");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.fromDate !== undefined) { if (!validDate(b.fromDate)) return fail(res, 400, "bad fromDate"); patch.fromDate = b.fromDate; }
  if (b.toDate !== undefined) {
    if (b.toDate && !validDate(b.toDate)) return fail(res, 400, "bad toDate");
    patch.toDate = b.toDate || null;
  }
  const from = (patch.fromDate ?? row.fromDate) as string;
  const to = (patch.toDate !== undefined ? patch.toDate : row.toDate) as string | null;
  if (to && to < from) return fail(res, 400, "toDate before fromDate");
  if (b.monthlyRate !== undefined) { const v = toAmount(b.monthlyRate); if (Number.isNaN(v)) return fail(res, 400, "monthlyRate must be a number"); patch.monthlyRate = v; }
  if (b.note !== undefined) patch.note = b.note ? String(b.note).trim() : null;
  if (!Object.keys(patch).length) return fail(res, 400, "nothing to update");
  const [updated] = await db.update(hostelStaysTable).set(patch).where(eq(hostelStaysTable.id, id)).returning();
  ok(res, updated);
});

router.delete("/hostels/stays/:id", requireAnyCap("svodni", "hostelOps"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(hostelStaysTable).where(eq(hostelStaysTable.id, id));
  ok(res, { ok: true });
});

// історія проживань працівника — блок «Хостел» у профілі
router.get("/hostels/worker/:id", requireAnyCap("svodni", "viewFinance", "hostelOps"), async (req, res) => {
  const workerId = Number(req.params.id);
  if (!Number.isFinite(workerId)) return fail(res, 400, "bad id");
  const rows = await db.select({ s: hostelStaysTable, hostelName: hostelsTable.name, city: hostelsTable.city, workerRate: hostelsTable.workerRate })
    .from(hostelStaysTable)
    .innerJoin(hostelsTable, eq(hostelStaysTable.hostelId, hostelsTable.id))
    .where(eq(hostelStaysTable.workerId, workerId))
    .orderBy(asc(hostelStaysTable.fromDate));
  ok(res, rows.map(({ s, hostelName, city, workerRate }) => ({
    stayId: s.id, hostelId: s.hostelId, hostelName, city,
    fromDate: s.fromDate, toDate: s.toDate,
    monthlyRate: s.monthlyRate ?? workerRate ?? null, note: s.note,
  })));
});

// ── Генерація знять із ЗП з проживань ────────────────────────────────────────
// Для кожного проживання, що перетинає місяць: ставка мешканця × частка днів.
// Працівники, у яких за місяць уже є будь-яке зняття (ручне/із таблиці),
// пропускаються — повторний запуск нічого не дублює.
router.post("/hostels/fill-deductions", requireCap("svodni"), async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const { start, end, days } = monthBounds(month);

  const stays = await db.select({ s: hostelStaysTable, h: hostelsTable })
    .from(hostelStaysTable)
    .innerJoin(hostelsTable, eq(hostelStaysTable.hostelId, hostelsTable.id))
    .where(and(lte(hostelStaysTable.fromDate, end), or(isNull(hostelStaysTable.toDate), gte(hostelStaysTable.toDate, start))));

  const existing = await db.select({ workerId: hostelDeductionsTable.workerId })
    .from(hostelDeductionsTable).where(eq(hostelDeductionsTable.periodMonth, month));
  const hasDeduction = new Set(existing.map(e => e.workerId));

  let created = 0, skippedExisting = 0, skippedNoRate = 0, total = 0;
  const values: (typeof hostelDeductionsTable.$inferInsert)[] = [];
  for (const { s, h } of stays) {
    if (s.workerId == null) continue; // історичний мешканець без профілю — зняття не генеруємо
    if (hasDeduction.has(s.workerId)) { skippedExisting++; continue; }
    const rate = s.monthlyRate ?? h.workerRate;
    if (rate == null || rate <= 0) { skippedNoRate++; continue; }
    const from = s.fromDate > start ? s.fromDate : start;
    const to = s.toDate && s.toDate < end ? s.toDate : end;
    const lived = dayDiff(from, to) + 1;
    if (lived <= 0) continue;
    const amount = lived >= days ? r2(rate) : r2(rate * lived / days);
    if (amount <= 0) continue;
    values.push({
      periodMonth: month, workerId: s.workerId, city: h.city, amount,
      note: lived >= days ? h.name : `${h.name} · ${lived}/${days} дн.`,
    });
    created++; total = r2(total + amount);
  }
  if (values.length) await db.insert(hostelDeductionsTable).values(values);
  ok(res, { month, created, skippedExisting, skippedNoRate, total });
});

// ─── Хостели 2.0: кімнати, платежі мешканців, шахматка ───────────────────────
// Операційне ведення — hostelOps (головний водій) або viewFinance (owner).
const OPS = requireAnyCap("viewFinance", "hostelOps");
const VIEW = requireAnyCap("svodni", "viewFinance", "hostelOps");

router.get("/hostels/:id/rooms", VIEW, async (req, res) => {
  const hostelId = Number(req.params.id);
  if (!Number.isFinite(hostelId)) return fail(res, 400, "bad id");
  const rooms = await db.select().from(hostelRoomsTable)
    .where(eq(hostelRoomsTable.hostelId, hostelId))
    .orderBy(hostelRoomsTable.sort, hostelRoomsTable.id);
  ok(res, rooms);
});

router.post("/hostels/rooms", OPS, async (req, res) => {
  const hostelId = Number(req.body?.hostelId);
  const label = String(req.body?.label ?? "").trim();
  if (!Number.isFinite(hostelId) || !label) return fail(res, 400, "hostelId і label обовʼязкові");
  const [room] = await db.insert(hostelRoomsTable).values({
    hostelId, label,
    capacity: Number(req.body?.capacity) > 0 ? Math.floor(Number(req.body.capacity)) : null,
    roomType: req.body?.roomType === "family" ? "family" : null,
    basePrice: Number(req.body?.basePrice) > 0 ? Math.round(Number(req.body.basePrice) * 100) / 100 : null,
    sort: Number.isFinite(Number(req.body?.sort)) ? Number(req.body.sort) : 0,
  }).returning();
  ok(res, room);
});

router.patch("/hostels/rooms/:id", OPS, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.label !== undefined) { if (!String(b.label).trim()) return fail(res, 400, "label"); patch.label = String(b.label).trim(); }
  if (b.capacity !== undefined) patch.capacity = Number(b.capacity) > 0 ? Math.floor(Number(b.capacity)) : null;
  if (b.roomType !== undefined) patch.roomType = b.roomType === "family" ? "family" : null;
  if (b.basePrice !== undefined) patch.basePrice = Number(b.basePrice) > 0 ? Math.round(Number(b.basePrice) * 100) / 100 : null;
  if (b.sort !== undefined) patch.sort = Number.isFinite(Number(b.sort)) ? Number(b.sort) : 0;
  if (b.isActive !== undefined) patch.isActive = Boolean(b.isActive);
  if (!Object.keys(patch).length) return fail(res, 400, "нема що оновлювати");
  const [room] = await db.update(hostelRoomsTable).set(patch).where(eq(hostelRoomsTable.id, id)).returning();
  if (!room) return fail(res, 404, "Не знайдено");
  ok(res, room);
});

router.delete("/hostels/rooms/:id", OPS, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const staysInRoom = await db.select({ n: sql<number>`count(*)` }).from(hostelStaysTable).where(eq(hostelStaysTable.roomId, id));
  if (Number(staysInRoom[0]?.n) > 0) {
    await db.update(hostelRoomsTable).set({ isActive: false }).where(eq(hostelRoomsTable.id, id));
    return ok(res, { ok: true, deactivated: true });
  }
  await db.delete(hostelRoomsTable).where(eq(hostelRoomsTable.id, id));
  ok(res, { ok: true });
});

// Платежі мешканців за місяць (готівка/картка «платит сам» + payroll-історія)
router.get("/hostels/payments", VIEW, async (req, res) => {
  const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const hostelId = Number.isFinite(Number(req.query.hostelId)) && req.query.hostelId ? Number(req.query.hostelId) : null;
  const conds = [eq(hostelPaymentsTable.periodMonth, month)];
  if (hostelId) conds.push(eq(hostelPaymentsTable.hostelId, hostelId));
  const rows = await db.select({ p: hostelPaymentsTable, workerName: workersTable.fullName, hostelName: hostelsTable.name })
    .from(hostelPaymentsTable)
    .leftJoin(workersTable, eq(hostelPaymentsTable.workerId, workersTable.id))
    .leftJoin(hostelsTable, eq(hostelPaymentsTable.hostelId, hostelsTable.id))
    .where(and(...conds));
  const months = await db.selectDistinct({ m: hostelPaymentsTable.periodMonth }).from(hostelPaymentsTable);
  ok(res, {
    month,
    months: months.map(x => x.m).sort().reverse(),
    rows: rows.map(({ p, workerName, hostelName }) => ({
      id: p.id, hostelId: p.hostelId, hostelName, workerId: p.workerId,
      residentName: workerName ?? p.residentName, amount: p.amount, method: p.method, note: p.note,
    })).sort((a, b) => (a.hostelName ?? "").localeCompare(b.hostelName ?? "") || (a.residentName ?? "").localeCompare(b.residentName ?? "", "pl")),
  });
});

router.post("/hostels/payments", OPS, async (req, res) => {
  const b = req.body ?? {};
  const month = typeof b.month === "string" && /^\d{4}-\d{2}$/.test(b.month) ? b.month : null;
  const hostelId = Number(b.hostelId);
  const amount = Number(b.amount);
  if (!month || !Number.isFinite(hostelId) || !Number.isFinite(amount) || amount <= 0) return fail(res, 400, "month, hostelId, сума > 0");
  const method = ["cash", "card", "payroll"].includes(String(b.method)) ? String(b.method) : "cash";
  const workerId = Number.isFinite(Number(b.workerId)) && b.workerId ? Number(b.workerId) : null;
  const [created] = await db.insert(hostelPaymentsTable).values({
    hostelId, workerId, residentName: workerId == null ? String(b.residentName ?? "").trim() || null : null,
    periodMonth: month, amount: Math.round(amount * 100) / 100, method,
    note: String(b.note ?? "").trim() || null,
  }).returning();
  ok(res, created);
});

router.patch("/hostels/payments/:id", OPS, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.amount !== undefined) {
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, "сума > 0");
    patch.amount = Math.round(amount * 100) / 100;
  }
  if (b.method !== undefined) {
    if (!["cash", "card", "payroll"].includes(String(b.method))) return fail(res, 400, "method: cash|card|payroll");
    patch.method = String(b.method);
  }
  if (b.note !== undefined) patch.note = String(b.note).trim() || null;
  if (!Object.keys(patch).length) return fail(res, 400, "нема що оновлювати");
  const [u] = await db.update(hostelPaymentsTable).set(patch).where(eq(hostelPaymentsTable.id, id)).returning();
  if (!u) return fail(res, 404, "Не знайдено");
  ok(res, u);
});

router.delete("/hostels/payments/:id", OPS, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(hostelPaymentsTable).where(eq(hostelPaymentsTable.id, id));
  ok(res, { ok: true });
});

// Друкована umowa najmu для проживання: заповнений HTML (браузер → друк → PDF).
// Текст — за docx-майстром водія («Умова на хостел», знімок 07.2026), польською.
router.get("/hostels/stays/:id/umowa", VIEW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [stay] = await db.select().from(hostelStaysTable).where(eq(hostelStaysTable.id, id));
  if (!stay) return fail(res, 404, "Не знайдено");
  const [hostel] = await db.select().from(hostelsTable).where(eq(hostelsTable.id, stay.hostelId));
  const [worker] = stay.workerId != null ? await db.select().from(workersTable).where(eq(workersTable.id, stay.workerId)) : [];
  const [room] = stay.roomId != null ? await db.select().from(hostelRoomsTable).where(eq(hostelRoomsTable.id, stay.roomId)) : [];
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const dmy = (d: string | null) => (d ? d.split("-").reverse().join(".") : "………………");
  const name = worker?.fullName ?? stay.residentName ?? "……………………………………";
  const price = stay.monthlyRate ?? room?.basePrice ?? hostel?.workerRate ?? null;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
  res.type("html").send(`<!doctype html><html lang="pl"><head><meta charset="utf-8">
<title>Umowa najmu — ${esc(name)}</title>
<style>body{font:14px/1.5 Georgia,serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#111}
h1{font-size:18px;text-align:center}h2{font-size:15px;margin-top:1.2em}
.sig{display:flex;justify-content:space-between;margin-top:4rem}
.sig div{width:40%;border-top:1px solid #111;padding-top:.3rem;text-align:center;font-size:12px}
@media print{.noprint{display:none}}</style></head><body>
<button class="noprint" onclick="print()" style="float:right">Drukuj</button>
<h1>UMOWA NAJMU</h1>
<p>Zawarta w dniu ${dmy(today)} w Lublinie pomiędzy:</p>
<p><b>EUROSUPPORT GROUP Sp. z o.o.</b> z siedzibą w Lublinie przy ul. Krakowskie Przedmieście 55,
20-076 Lublin, KRS 0000847164, NIP 9462698100, REGON 386387801, reprezentowaną przez
Alonę Kovalchuk — prezesa zarządu, zwaną dalej „Wynajmującym”,</p>
<p>a <b>${esc(name)}</b>, legitymującym/-ą się dokumentem nr ……………………, zwanym/-ą dalej „Najemcą”.</p>
<h2>§1. Przedmiot umowy</h2>
<p>1. Wynajmujący udostępnia Najemcy ${room ? `pokój <b>${esc(room.label)}</b>` : "miejsce noclegowe"}
w budynku przy ${esc(hostel?.address ?? hostel?.name ?? "……………………")}
na okres od <b>${dmy(stay.fromDate)}</b> do <b>${stay.toDate ? dmy(stay.toDate) : "czasu nieoznaczonego"}</b>.</p>
<p>2. Najemca otrzymuje dostęp do łóżka oraz pomieszczeń wspólnych (łazienka, kuchnia, korytarz) zgodnie z regulaminem.</p>
<p>3. Najemca nie może zameldować się samodzielnie bez pozwolenia Wynajmującego.</p>
<h2>§2. Cena najmu</h2>
<p>Cena za wynajem wynosi <b>${price != null ? `${price} PLN` : "………… PLN"}</b> za miesiąc.
Koszt najmu płatny z góry od 1 do 5 każdego miesiąca${stay.payer === "payroll" ? " (potrącenie z wynagrodzenia)" : " gotówką"}.</p>
${stay.deposit || stay.keyDeposit ? `<h2>§3. Kaucje</h2><p>${stay.deposit ? `Kaucja przy zakwaterowaniu: <b>${stay.deposit} PLN</b>. ` : ""}${stay.keyDeposit ? `Kaucja za klucz: <b>${stay.keyDeposit} PLN</b>.` : ""}</p>` : ""}
<h2>§${stay.deposit || stay.keyDeposit ? 4 : 3}. Obowiązki Najemcy</h2>
<p>Najemca zobowiązuje się do korzystania z pomieszczeń zgodnie z przeznaczeniem, z zachowaniem
porządku i higieny, do przestrzegania regulaminu hostelu oraz zasad współżycia. Najemca ponosi
odpowiedzialność za zniszczenia mienia powstałe z jego winy.</p>
<div class="sig"><div>Wynajmujący</div><div>Najemca</div></div>
</body></html>`);
});

// Шахматка: кімнати × мешканці хостела за місяць (+ хто без кімнати)
router.get("/hostels/:id/grid", VIEW, async (req, res) => {
  const hostelId = Number(req.params.id);
  const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : null;
  if (!Number.isFinite(hostelId) || !month) return fail(res, 400, "id і month=YYYY-MM");
  const start = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const end = `${month}-${String(new Date(Date.UTC(y!, m!, 0)).getUTCDate()).padStart(2, "0")}`;
  const rooms = await db.select().from(hostelRoomsTable)
    .where(and(eq(hostelRoomsTable.hostelId, hostelId), eq(hostelRoomsTable.isActive, true)))
    .orderBy(hostelRoomsTable.sort, hostelRoomsTable.id);
  const stays = await db.select({ s: hostelStaysTable, workerName: workersTable.fullName })
    .from(hostelStaysTable)
    .leftJoin(workersTable, eq(hostelStaysTable.workerId, workersTable.id))
    .where(and(
      eq(hostelStaysTable.hostelId, hostelId),
      lte(hostelStaysTable.fromDate, end),
      or(isNull(hostelStaysTable.toDate), gte(hostelStaysTable.toDate, start)),
    ));
  const occupants = stays.map(({ s, workerName }) => ({
    stayId: s.id, workerId: s.workerId, name: workerName ?? s.residentName ?? "?",
    roomId: s.roomId, fromDate: s.fromDate, toDate: s.toDate, payer: s.payer, note: s.note,
  }));
  ok(res, {
    month,
    rooms: rooms.map(r => ({
      id: r.id, label: r.label, capacity: r.capacity, roomType: r.roomType, basePrice: r.basePrice,
      occupants: occupants.filter(o => o.roomId === r.id),
    })),
    unassigned: occupants.filter(o => o.roomId == null),
  });
});

export default router;
