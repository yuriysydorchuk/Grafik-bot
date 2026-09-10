// Публічна анкета ZUS ZCNA (/zcna/:token) — без сесії, токен (passport_scan_tokens.purpose='zcna',
// 30 днів) єдина авторизація, як /docs/:token. GET — хто заповнює + поточні члени + довідники;
// POST — повний список членів (заміна), валідація в services/zcna.ts.
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, workersTable } from "@workspace/db";
import { asLang } from "../bot/i18n";
import { loadZcnaToken, listFamily, submitZcnaForm, ZCNA_RELATION_CODES, ZCNA_DISABILITY_CODES } from "../services/zcna";

const router: IRouter = Router();
const fail = (res: any, code: number, msg: string, extra: Record<string, unknown> = {}) => res.status(code).json({ error: msg, ...extra });

router.get("/zcna/:token", async (req, res) => {
  const row = await loadZcnaToken(String(req.params.token));
  if (!row) return fail(res, 404, "Лінк недійсний або прострочений");
  const [w] = await db.select({ id: workersTable.id, fullName: workersTable.fullName, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, row.workerId!));
  if (!w) return fail(res, 404, "Лінк недійсний");
  res.json({ workerName: w.fullName, language: asLang(row.language ?? w.language), members: await listFamily(w.id), relationCodes: ZCNA_RELATION_CODES, disabilityCodes: ZCNA_DISABILITY_CODES, submittedAt: row.usedAt });
});

router.post("/zcna/:token", async (req, res) => {
  const members = Array.isArray(req.body?.members) ? req.body.members : null;
  if (!members) return fail(res, 400, "members[] обовʼязковий");
  try { res.json({ ok: true, ...(await submitZcnaForm(String(req.params.token), members)) }); }
  catch (e: any) { fail(res, /недійсний/i.test(e?.message ?? "") ? 404 : 400, e?.message ?? "Не вдалося зберегти", { field: e?.field ?? null, index: e?.index ?? null }); }
});

export default router;
