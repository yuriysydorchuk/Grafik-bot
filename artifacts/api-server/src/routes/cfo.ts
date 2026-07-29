// CFO-модуль (/cfo, owner-only): місячна звірка кешфлоу↔баланс, P&L vs кеш,
// маржі по клієнтах, АІ-висновок. Логіка — services/cfo.ts.
import { Router, type IRouter } from "express";
import { db, adminsTable } from "@workspace/db";
import { authRequired, requireCap } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  buildCfoData, getCfoSettings, saveCfoSettings, runCfoAnalysis, listCfoReports, cfoAiConfigured,
} from "../services/cfo";

const router: IRouter = Router();
router.use(authRequired);
router.use(requireCap("viewFinance"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const validMonth = (m: any) => typeof m === "string" && /^\d{4}-\d{2}$/.test(m);

router.get("/cfo", async (req, res) => {
  const month = validMonth(req.query.month) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
  try {
    const [data, settings, reports, admins] = await Promise.all([
      buildCfoData(month), getCfoSettings(), listCfoReports(month),
      db.select({ id: adminsTable.id, name: adminsTable.name }).from(adminsTable),
    ]);
    ok(res, { ...data, settings, reports, admins, aiConfigured: cfoAiConfigured() });
  } catch (e: any) {
    logger.error({ err: e?.message, month }, "cfo build failed");
    fail(res, 500, e?.message || "cfo failed");
  }
});

router.put("/cfo/settings", async (req, res) => {
  const t = Number(req.body?.marginThreshold);
  const ids = Array.isArray(req.body?.recipientAdminIds) ? req.body.recipientAdminIds.map(Number).filter(Number.isFinite) : [];
  if (!Number.isFinite(t) || t < 0 || t > 100) return fail(res, 400, "marginThreshold 0–100");
  await saveCfoSettings({ marginThreshold: t, recipientAdminIds: ids });
  ok(res, { ok: true });
});

// АІ-висновок по місяцю (кнопка «Аналіз»)
router.post("/cfo/analyze", async (req, res) => {
  const month = validMonth(req.body?.month) ? String(req.body.month) : null;
  if (!month) return fail(res, 400, "month=YYYY-MM required");
  try { ok(res, await runCfoAnalysis(month, false)); }
  catch (e: any) {
    logger.warn({ err: e?.message, month }, "cfo analyze failed");
    fail(res, 502, e?.message || "analyze failed");
  }
});

export default router;