// Спецодяг: магазин (склад: тип/розмір/стан/ціна/кількість), видача зі складу
// з життєвим циклом (видано → повернуто/знято з ЗП) і реєстр видачі.
// Веде водій/офіс: RW — editData АБО assignDrivers; перегляд — будь-який залогінений.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { clothingItemsTable, clothingStockTable, clothingTypesTable, workersTable } from "@workspace/db";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { authRequired, requireAnyCap } from "../lib/auth";

const router: IRouter = Router();
router.use(authRequired);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const RW = requireAnyCap("editData", "assignDrivers");
// базові типи (сідяться міграцією в clothing_types); валідація йде по довіднику,
// цей список — лише фолбек на випадок, коли рядок довідника видалили
const TYPES = ["boots", "coverall", "jacket", "hat", "tshirt", "set", "other"];
const OWNERSHIP = ["ours", "own", "sold"];
const CONDITIONS = ["new", "used"];
const r2 = (n: number) => Math.round(n * 100) / 100;
const warsawToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const dateOrToday = (v: unknown): string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : warsawToday();
// тип валідний, якщо є в довіднику (вкл. неактивні — легасі-записи) або в базовому списку
const isValidType = async (k: string): Promise<boolean> => {
  if (TYPES.includes(k)) return true;
  const [row] = await db.select({ id: clothingTypesTable.id }).from(clothingTypesTable).where(eq(clothingTypesTable.key, k));
  return !!row;
};

// ─── Довідник типів одягу ────────────────────────────────────────────────────

router.get("/clothing/types", async (_req, res) => {
  const rows = await db.select().from(clothingTypesTable)
    .orderBy(asc(clothingTypesTable.sortOrder), asc(clothingTypesTable.id));
  ok(res, rows);
});

router.post("/clothing/types", RW, async (req, res) => {
  const label = String(req.body?.label ?? "").trim();
  if (!label) return fail(res, 400, "Вкажіть назву типу");
  // key — стабільний слаг з назви (в item_type складу/видач); колізія → суфікс
  const base = label.toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "type";
  let key = base;
  for (let i = 2; ; i++) {
    const [dup] = await db.select({ id: clothingTypesTable.id }).from(clothingTypesTable).where(eq(clothingTypesTable.key, key));
    if (!dup && !TYPES.includes(key)) break;
    key = `${base}-${i}`;
  }
  const [max] = await db.select({ m: sql<number>`coalesce(max(${clothingTypesTable.sortOrder}), 0)` }).from(clothingTypesTable);
  const [created] = await db.insert(clothingTypesTable).values({
    key, label, sortOrder: Number(max?.m ?? 0) + 10,
  }).returning();
  ok(res, created);
});

router.patch("/clothing/types/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const patch: Record<string, unknown> = {};
  if (req.body?.label !== undefined) {
    const label = String(req.body.label).trim();
    if (!label) return fail(res, 400, "Назва не може бути порожня");
    patch.label = label;
  }
  if (req.body?.sortOrder !== undefined) patch.sortOrder = Math.floor(Number(req.body.sortOrder)) || 0;
  if (req.body?.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);
  if (!Object.keys(patch).length) return fail(res, 400, "нема що оновлювати");
  const [u] = await db.update(clothingTypesTable).set(patch).where(eq(clothingTypesTable.id, id)).returning();
  if (!u) return fail(res, 404, "Не знайдено");
  ok(res, u);
});

router.delete("/clothing/types/:id", RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(clothingTypesTable).where(eq(clothingTypesTable.id, id));
  if (!row) return fail(res, 404, "Не знайдено");
  // тип, що вже використовується складом чи видачами, — лише деактивація
  const [usedStock] = await db.select({ id: clothingStockTable.id }).from(clothingStockTable).where(eq(clothingStockTable.itemType, row.key)).limit(1);
  const [usedItem] = await db.select({ id: clothingItemsTable.id }).from(clothingItemsTable).where(eq(clothingItemsTable.itemType, row.key)).limit(1);
  if (usedStock || usedItem) {
    await db.update(clothingTypesTable).set({ isActive: false }).where(eq(clothingTypesTable.id, id));
    return ok(res, { ok: true, deactivated: true });
  }
  await db.delete(clothingTypesTable).where(eq(clothingTypesTable.id, id));
  ok(res, { ok: true });
});

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
  if (!(await isValidType(itemType))) return fail(res, 400, "невідомий тип одягу (довідник «Типи»)");
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
  if (b.itemType !== undefined) { if (!(await isValidType(String(b.itemType)))) return fail(res, 400, "невідомий тип одягу (довідник «Типи»)"); patch.itemType = String(b.itemType); }
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
// річ вертається на склад у ВИБРАНОМУ стані (body.condition new|used; типово БУ —
// ношене нове стає вживаним). Працює і для записів без stockId (ручні/легасі):
// позиція складу шукається/створюється за типом+назвою+розміром+станом.
router.post("/clothing/:id/return", RW, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [item] = await db.select().from(clothingItemsTable).where(eq(clothingItemsTable.id, id));
  if (!item) return fail(res, 404, "Не знайдено");
  if (item.returnedAt) return fail(res, 400, "Уже повернуто");
  const returnedAt = dateOrToday(req.body?.date);
  const backCondition = req.body?.condition === "new" ? "new" : "used";
  const [u] = await db.update(clothingItemsTable).set({ returnedAt }).where(eq(clothingItemsTable.id, id)).returning();
  // атрибути цільової позиції: з позиції видачі (stockId) або з самого запису
  const [srcStock] = item.stockId != null
    ? await db.select().from(clothingStockTable).where(eq(clothingStockTable.id, item.stockId))
    : [];
  const attrs = srcStock
    ? { itemType: srcStock.itemType, name: srcStock.name, size: srcStock.size }
    : { itemType: item.itemType, name: null as string | null, size: item.size };
  let restocked: unknown = null;
  if (srcStock && srcStock.condition === backCondition) {
    await db.update(clothingStockTable).set({ qty: srcStock.qty + 1, isActive: true }).where(eq(clothingStockTable.id, srcStock.id));
    restocked = { stockId: srcStock.id, condition: backCondition };
  } else {
    const candidates = await db.select().from(clothingStockTable).where(and(
      eq(clothingStockTable.itemType, attrs.itemType), eq(clothingStockTable.condition, backCondition),
      attrs.name != null ? eq(clothingStockTable.name, attrs.name) : isNull(clothingStockTable.name),
      attrs.size != null ? eq(clothingStockTable.size, attrs.size) : isNull(clothingStockTable.size),
    ));
    const target = candidates[0];
    if (target) {
      await db.update(clothingStockTable).set({ qty: target.qty + 1, isActive: true }).where(eq(clothingStockTable.id, target.id));
      restocked = { stockId: target.id, condition: backCondition };
    } else {
      const [createdStock] = await db.insert(clothingStockTable).values({
        ...attrs, condition: backCondition,
        price: null, qty: 1, note: "авто: повернення з видачі",
      }).returning();
      restocked = { stockId: createdStock!.id, condition: backCondition, created: true };
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
  if (!(await isValidType(itemType))) return fail(res, 400, "невідомий тип одягу (довідник «Типи»)");
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
  if (b.itemType !== undefined) { if (!(await isValidType(String(b.itemType)))) return fail(res, 400, "невідомий тип одягу (довідник «Типи»)"); patch.itemType = String(b.itemType); }
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
