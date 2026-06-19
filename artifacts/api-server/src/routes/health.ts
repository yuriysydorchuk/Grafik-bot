import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { isBotLaunched } from "../bot/instance";

const router: IRouter = Router();

// Liveness/readiness probe. Public endpoint — returns only coarse status, never
// secrets, stack traces or internal DB error text. 503 when the DB is unreachable.
router.get("/healthz", async (_req, res) => {
  let dbOk = false;
  try {
    await pool.query("select 1");
    dbOk = true;
  } catch {
    dbOk = false; // swallow details on purpose — nothing internal leaves here
  }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    db: dbOk ? "ok" : "down",
    bot: isBotLaunched() ? "up" : "down", // best-effort, no extra Telegram call
    uptimeSec: Math.round(process.uptime()),
  });
});

export default router;
