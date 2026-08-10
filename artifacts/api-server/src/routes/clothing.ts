// Спецодяг: реєстр видачі (наш/свій/проданий) і ціни зняття з ЗП.
// Веде водій/офіс: RW — editData АБО assignDrivers; перегляд — будь-який залогінений.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { clothingItemsTable, workersTable } from "@workspace/db";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { authRequired, requireAnyCap } from "../lib/auth";

const router: IRouter = Router();
router.use(authRequired);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const RW = requireAnyCap("editData", "assignDrivers");
const TYPES = ["boots", "coverall", "jacket", "hat", "tshirt", "set", "other"];
const OWNERSHIP = ["ours", "own", "sold"];
const r2 = (n: number) => Math.round(n * 100) / 100;

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
    pending: sql<number>`coalesce(sum(case when not ${clothingItemsTable.deducted} and not ${clothingItemsTable.writtenOff} and ${clothingItemsTable.price} is not null then ${clothingItemsTable.price}::numeric else 0 end), 0)`,
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
