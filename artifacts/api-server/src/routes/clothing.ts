// Спецодяг: магазин (склад: тип/розмір/стан/ціна/кількість), видача зі складу
// з життєвим циклом (видано → повернуто/знято з ЗП) і реєстр видачі.
// Веде водій/офіс: RW — editData АБО assignDrivers; перегляд — будь-який залогінений.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { clothingItemsTable, clothingStockTable, workersTable } from "@workspace/db";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { authRequired, requireAnyCap } from "../lib/auth";

const router: IRouter = Router();
router.use(authRequired);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const RW = requireAnyCap("editData", "assignDrivers");
const TYPES = ["boots", "coverall", "jacket", "hat", "tshirt", "set", "other"];
const OWNERSHIP = ["ours", "own", "sold"];
const CONDITIONS = ["new", "used"];
const r2 = (n: number) => Math.round(n * 100) / 100;
const warsawToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const dateOrToday = (v: unknown): string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : warsawToday();

// ─── Магазин: склад ──────────────────────────────────────────────────────────
// ВАЖЛИВО: /clothing/stock оголошується ДО /clothing/:id (інакше "stock" зʼїсть :id)

router.get("/clothing/stock", async (_req, res) => {
  const rows = await db.select().from(clothingStockTable)
    .orderBy(desc(clothingStockTable.isActive), asc(clothingStockTable.itemType), asc(clothingStockTable.name), asc(clothingStockTable.size), asc(clothingStockTable.condition));
  ok(res, rows);
});

router.post("/clothing/stock", RW, async (req, res) => {
  const b = req.body ?? {};
  const itemType = String(b.itemType ?? "");
  if (!TYPES.includes(itemType)) return fail(res, 400, `itemType: ${TYPES.join("|")}`);
  const condition = CONDITIONS.includes(String(b.condition)) ? String(b.condition) : "new";
  const qty = Number.isFinite(Number(b.qty)) ? Math.max(0, Math.floor(Number(b.qty))) : 0;
  const [created] = await db.insert(clothingStockTable).values({
    itemType, name: String(b.name ?? "").trim() || null, size: String(b.size ?? "").trim() || null,
    condition, price: Number(b.price) > 0 ? r2(Number(b.price)) : null, qty,
    note: String(b.note ?? "").trim() || null,
  }).returning();
  ok(res, created);
});

router.patch("/clothing/stock/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.itemType !== undefined) { if (!TYPES.includes(String(b.itemType))) return fail(res, 400, "itemType"); patch.itemType = String(b.itemType); }
  if (b.name !== undefined) patch.name = String(b.name).trim() || null;
  if (b.size !== undefined) patch.size = String(b.size).trim() || null;
  if (b.condition !== undefined) { if (!CONDITIONS.includes(String(b.condition))) return fail(res, 400, "condition: new|used"); patch.condition = String(b.condition); }
  if (b.price !== undefined) patch.price = Number(b.price) > 0 ? r2(Number(b.price)) : null;
  if (b.qty !== undefined) { const q = Number(b.qty); if (!Number.isFinite(q) || q < 0) return fail(res, 400, "qty ≥ 0"); patch.qty = Math.floor(q); }
  if (b.note !== undefined) patch.note = String(b.note).trim() || null;
  if (b.isActive !== undefined) patch.isActive = Boolean(b.isActive);
  if (!Object.keys(patch).length) return fail(res, 400, "нема що оновлювати");
  const [u] = await db.update(clothingStockTable).set(patch).where(eq(clothingStockTable.id, id)).returning();
  if (!u) return fail(res, 404, "Не знайдено");
  ok(res, u);
});

router.delete("/clothing/stock/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  // позиція з видачами не видаляється (історія посилається) — деактивується
  const [used] = await db.select({ id: clothingItemsTable.id }).from(clothingItemsTable)
    .where(eq(clothingItemsTable.stockId, id)).limit(1);
  if (used) {
    await db.update(clothingStockTable).set({ isActive: false }).where(eq(clothingStockTable.id, id));
    return ok(res, { ok: true, deactivated: true });
  }
  await db.delete(clothingStockTable).where(eq(clothingStockTable.id, id));
  ok(res, { ok: true });
});

// ─── Видача зі складу / повернення ───────────────────────────────────────────

// Видача: мінусує склад, створює запис реєстру з ціною зняття («маємо зняти»).
router.post("/clothing/issue", RW, async (req, res) => {
  const b = req.body ?? {};
  const stockId = Number(b.stockId);
  const workerId = Number(b.workerId);
  if (!Number.isFinite(stockId) || !Number.isFinite(workerId)) return fail(res, 400, "stockId і workerId обовʼязкові");
  const [s] = await db.select().from(clothingStockTable).where(eq(clothingStockTable.id, stockId));
  if (!s) return fail(res, 404, "Позицію складу не знайдено");
  if (!s.isActive) return fail(res, 400, "Позиція неактивна");
  if (s.qty <= 0) return fail(res, 400, "На складі 0 шт");
  const [w] = await db.select({ id: workersTable.id }).from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return fail(res, 404, "Працівника не знайдено");
  const issuedAt = dateOrToday(b.date);
  const price = b.price !== undefined && b.price !== null && b.price !== ""
    ? (Number(b.price) >= 0 ? r2(Number(b.price)) : null)
    : s.price;
  await db.update(clothingStockTable).set({ qty: s.qty - 1 }).where(eq(clothingStockTable.id, stockId));
  const [created] = await db.insert(clothingItemsTable).values({
    workerId, itemType: s.itemType, stockId, size: s.size, condition: s.condition,
    ownership: price != null && price > 0 ? "sold" : "ours",
    price: price != null && price > 0 ? price : null,
    issuedAt, periodMonth: issuedAt.slice(0, 7),
    note: String(b.note ?? "").trim() || null,
  }).returning();
  ok(res, created);
});

// Повернення: запис отримує дату повернення (незняте перестає бути «до зняття»),
// річ вертається на склад; НОВА після носіння стає БУ (окрема позиція used).
router.post("/clothing/:id/return", RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [item] = await db.select().from(clothingItemsTable).where(eq(clothingItemsTable.id, id));
  if (!item) return fail(res, 404, "Не знайдено");
  if (item.returnedAt) return fail(res, 400, "Уже повернуто");
  const returnedAt = dateOrToday(req.body?.date);
  const [u] = await db.update(clothingItemsTable).set({ returnedAt }).where(eq(clothingItemsTable.id, id)).returning();
  let restocked: unknown = null;
  if (item.stockId != null) {
    const [s] = await db.select().from(clothingStockTable).where(eq(clothingStockTable.id, item.stockId));
    if (s) {
      if (s.condition === "used") {
        await db.update(clothingStockTable).set({ qty: s.qty + 1 }).where(eq(clothingStockTable.id, s.id));
        restocked = { stockId: s.id, condition: "used" };
      } else {
        // шукаємо/створюємо БУ-позицію того самого типу+назви+розміру
        const usedRows = await db.select().from(clothingStockTable).where(and(
          eq(clothingStockTable.itemType, s.itemType), eq(clothingStockTable.condition, "used"),
          s.name != null ? eq(clothingStockTable.name, s.name) : isNull(clothingStockTable.name),
          s.size != null ? eq(clothingStockTable.size, s.size) : isNull(clothingStockTable.size),
        ));
        const target = usedRows[0];
        if (target) {
          await db.update(clothingStockTable).set({ qty: target.qty + 1, isActive: true }).where(eq(clothingStockTable.id, target.id));
          restocked = { stockId: target.id, condition: "used" };
        } else {
          const [createdStock] = await db.insert(clothingStockTable).values({
            itemType: s.itemType, name: s.name, size: s.size, condition: "used",
            price: null, qty: 1, note: "авто: повернення з видачі",
          }).returning();
          restocked = { stockId: createdStock!.id, condition: "used", created: true };
        }
      }
    }
  }
  ok(res, { ...u, restocked });
});

// ─── До зняття: підсумки по людях (для вкладки і перенесення до сводної) ─────
router.get("/clothing/pending", async (_req, res) => {
  const rows = await db.select({ c: clothingItemsTable, workerName: workersTable.fullName })
    .from(clothingItemsTable)
    .leftJoin(workersTable, eq(clothingItemsTable.workerId, workersTable.id))
    .where(and(
      eq(clothingItemsTable.deducted, false), eq(clothingItemsTable.writtenOff, false),
      isNull(clothingItemsTable.returnedAt), sql`${clothingItemsTable.price} is not null and ${clothingItemsTable.price} > 0`,
    ))
    .orderBy(asc(workersTable.fullName), desc(clothingItemsTable.id));
  const byWorker = new Map<string, { workerId: number | null; workerName: string | null; total: number; items: any[] }>();
  for (const { c, workerName } of rows) {
    const key = c.workerId != null ? `w${c.workerId}` : `n${(workerName ?? c.workerName ?? "").toLowerCase()}`;
    const g = byWorker.get(key) ?? byWorker.set(key, { workerId: c.workerId, workerName: workerName ?? c.workerName, total: 0, items: [] }).get(key)!;
    g.total = r2(g.total + (c.price ?? 0));
    g.items.push({ id: c.id, itemType: c.itemType, size: c.size, condition: c.condition, price: c.price, issuedAt: c.issuedAt, note: c.note });
  }
  ok(res, {
    groups: [...byWorker.values()].sort((a, b) => (a.workerName ?? "").localeCompare(b.workerName ?? "", "pl")),
    total: r2([...byWorker.values()].reduce((s, g) => s + g.total, 0)),
  });
});

router.get("/clothing", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const workerId = Number.isFinite(Number(req.query.workerId)) && req.query.workerId ? Number(req.query.workerId) : null;
  const conds = [];
  if (workerId) conds.push(eq(clothingItemsTable.workerId, workerId));
  if (q) conds.push(or(ilike(workersTable.fullName, `%${q}%`), ilike(clothingItemsTable.workerName, `%${q}%`)));
  const rows = await db.select({ c: clothingItemsTable, workerName: workersTable.fullName })
    .from(clothingItemsTable)
    .leftJoin(workersTable, eq(clothingItemsTable.workerId, workersTable.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(clothingItemsTable.id))
    .limit(500);
  const totals = await db.select({
    // повернений одяг більше не «до зняття» (якщо ще не зняли)
    pending: sql<number>`coalesce(sum(case when not ${clothingItemsTable.deducted} and not ${clothingItemsTable.writtenOff} and ${clothingItemsTable.returnedAt} is null and ${clothingItemsTable.price} is not null then ${clothingItemsTable.price}::numeric else 0 end), 0)`,
    items: sql<number>`count(*)`,
  }).from(clothingItemsTable);
  ok(res, {
    rows: rows.map(({ c, workerName }) => ({ ...c, workerName: workerName ?? c.workerName })),
    pendingTotal: r2(Number(totals[0]?.pending ?? 0)),
    totalItems: Number(totals[0]?.items ?? 0),
  });
});

router.post("/clothing", RW, async (req, res) => {
  const b = req.body ?? {};
  const itemType = String(b.itemType ?? "");
  if (!TYPES.includes(itemType)) return fail(res, 400, `itemType: ${TYPES.join("|")}`);
  const workerId = Number.isFinite(Number(b.workerId)) && b.workerId ? Number(b.workerId) : null;
  if (!workerId && !String(b.workerName ?? "").trim()) return fail(res, 400, "workerId або workerName");
  const ownership = OWNERSHIP.includes(String(b.ownership)) ? String(b.ownership) : null;
  const [created] = await db.insert(clothingItemsTable).values({
    workerId, workerName: workerId ? null : String(b.workerName).trim(),
    itemType, ownership,
    price: Number(b.price) > 0 ? r2(Number(b.price)) : null,
    deducted: Boolean(b.deducted),
    periodMonth: typeof b.month === "string" && /^\d{4}-\d{2}$/.test(b.month) ? b.month : null,
    note: String(b.note ?? "").trim() || null,
  }).returning();
  ok(res, created);
});

router.patch("/clothing/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.itemType !== undefined) { if (!TYPES.includes(String(b.itemType))) return fail(res, 400, "itemType"); patch.itemType = String(b.itemType); }
  if (b.ownership !== undefined) patch.ownership = OWNERSHIP.includes(String(b.ownership)) ? String(b.ownership) : null;
  if (b.price !== undefined) patch.price = Number(b.price) > 0 ? r2(Number(b.price)) : null;
  if (b.deducted !== undefined) patch.deducted = Boolean(b.deducted);
  if (b.writtenOff !== undefined) patch.writtenOff = Boolean(b.writtenOff);
  if (b.month !== undefined) patch.periodMonth = typeof b.month === "string" && /^\d{4}-\d{2}$/.test(b.month) ? b.month : null;
  if (b.note !== undefined) patch.note = String(b.note).trim() || null;
  if (b.size !== undefined) patch.size = String(b.size).trim() || null;
  if (b.condition !== undefined) patch.condition = CONDITIONS.includes(String(b.condition)) ? String(b.condition) : null;
  if (b.issuedAt !== undefined) patch.issuedAt = typeof b.issuedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.issuedAt) ? b.issuedAt : null;
  if (b.returnedAt !== undefined) patch.returnedAt = typeof b.returnedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.returnedAt) ? b.returnedAt : null;
  if (!Object.keys(patch).length) return fail(res, 400, "нема що оновлювати");
  const [u] = await db.update(clothingItemsTable).set(patch).where(eq(clothingItemsTable.id, id)).returning();
  if (!u) return fail(res, 404, "Не знайдено");
  ok(res, u);
});

router.delete("/clothing/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(clothingItemsTable).where(eq(clothingItemsTable.id, id));
  ok(res, { ok: true });
});

export default router;
