// Штрафи (kary) по місяцях — дзеркало вкладки «Хостели»: ручний реєстр
// сум, який сводні підтягують як джерело колонки Kara. Cap `svodni`.
// (Жив у роутері сводної 2.0 — перенесений сюди при її видаленні.)
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { penaltiesTable, workersTable, factoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authRequired, requireCap } from "../lib/auth";

const router: IRouter = Router();
router.use(authRequired);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const r2 = (n: number) => Math.round(n * 100) / 100;

router.get("/penalties", requireCap("svodni"), async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  const rows = await db.select({ p: penaltiesTable, workerName: workersTable.fullName, factoryName: factoriesTable.name })
    .from(penaltiesTable)
    .leftJoin(workersTable, eq(penaltiesTable.workerId, workersTable.id))
    .leftJoin(factoriesTable, eq(penaltiesTable.factoryId, factoriesTable.id))
    .where(eq(penaltiesTable.periodMonth, month));
  const months = await db.selectDistinct({ m: penaltiesTable.periodMonth }).from(penaltiesTable);
  ok(res, {
    month,
    months: months.map(x => x.m).sort().reverse(),
    rows: rows.map(({ p, workerName, factoryName }) => ({
      id: p.id, workerId: p.workerId, workerName, city: p.city,
      factoryId: p.factoryId, factoryLabel: factoryName ?? p.factoryLabel,
      amount: p.amount, note: p.note,
    })).sort((a, b) => (a.city ?? "").localeCompare(b.city ?? "")
      || (a.factoryLabel ?? "").localeCompare(b.factoryLabel ?? "")
      || (a.workerName ?? "").localeCompare(b.workerName ?? "", "pl")),
  });
});

router.post("/penalties", requireCap("svodni"), async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  const workerId = Number(req.body?.workerId);
  const amount = Number(req.body?.amount);
  if (!month || !Number.isFinite(workerId) || !Number.isFinite(amount) || amount <= 0) {
    return fail(res, 400, "month, workerId і сума > 0 обовʼязкові");
  }
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) return fail(res, 404, "працівника не знайдено");
  const [fac] = w.factoryId != null ? await db.select().from(factoriesTable).where(eq(factoriesTable.id, w.factoryId)) : [];
  const [created] = await db.insert(penaltiesTable).values({
    periodMonth: month, workerId, amount: r2(amount),
    city: fac?.city ?? null, factoryId: w.factoryId, factoryLabel: fac?.name ?? null,
    note: String(req.body?.note ?? "").trim() || null,
  }).returning();
  ok(res, created);
});

router.patch("/penalties/:id", requireCap("svodni"), async (req, res) => {
  const id = Number(req.params.id);
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(id) || !Number.isFinite(amount) || amount <= 0) return fail(res, 400, "сума > 0");
  const patch: Record<string, unknown> = { amount: r2(amount) };
  if (req.body?.note !== undefined) patch.note = String(req.body.note).trim() || null;
  const [u] = await db.update(penaltiesTable).set(patch).where(eq(penaltiesTable.id, id)).returning();
  ok(res, u ?? {});
});

router.delete("/penalties/:id", requireCap("svodni"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  await db.delete(penaltiesTable).where(eq(penaltiesTable.id, id));
  ok(res, { ok: true });
});

export default router;
