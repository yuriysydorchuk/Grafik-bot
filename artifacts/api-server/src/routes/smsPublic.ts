// Публічна сторінка персонального SMS-лінка /r/<токен> (батч 2 SMS-кампаній):
// GET /r/:token — дані для продажної сторінки (імʼя, мова, пропозиція, лендінг, лінки),
// подія «переглянув»; GET /r/:token/e?k=cta_bot|cta_call|cta_wa — подія кнопки
// (GET, щоб sendBeacon/перехід не впирались у CSRF-гард на мутаціях).
// БЕЗ authRequired — монтується до auth-роутерів (routes/index.ts), rate-limit по префіксу.
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { db, factoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { findRecipientByToken, logSmsEvent, advanceRecipient } from "../services/sms/campaigns";
import { clientIp, parseDevice } from "../lib/clientInfo";

const router: IRouter = Router();
router.use("/r", rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Забагато запитів. Спробуйте пізніше." } }));

const TOKEN_RE = /^[0-9A-Z]{24}$/;
const botLink = (token: string): string => {
  const u = process.env.TELEGRAM_BOT_USERNAME || "";
  return u ? `https://t.me/${u}?start=sms${token}` : "";
};

router.get("/r/:token", async (req, res) => {
  const token = String(req.params.token || "").toUpperCase();
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: "Лінк недійсний." });
  const rec = await findRecipientByToken(token);
  if (!rec) return res.status(404).json({ error: "Лінк недійсний." });
  const c = rec.campaign;
  const ip = clientIp(req), device = parseDevice(req.headers["user-agent"]);
  await logSmsEvent(rec.id, "view", { ip, userAgent: req.headers["user-agent"] as string, device });
  await advanceRecipient(rec.id, "viewed", { viewedAt: rec.viewedAt ?? new Date() });
  const offer = (c.offer ?? {}) as Record<string, any>;
  const fac = offer.factoryId ? (await db.select({ name: factoriesTable.name, city: factoriesTable.city }).from(factoriesTable).where(eq(factoriesTable.id, Number(offer.factoryId))))[0] : null;
  const phone = offer.phone || process.env.SMS_OFFICE_PHONE || "";
  return res.json({
    firstName: rec.firstName || (rec.name || "").split(" ")[0] || "",
    lang: rec.lang, kind: c.kind, campaign: c.name,
    offer: { ...offer, factoryName: fac?.name ?? null, city: offer.city || fac?.city || null, phone, whatsapp: offer.whatsapp || phone },
    landing: c.landing ?? {},
    telegram: botLink(token),
    closed: c.status === "closed",
  });
});

const EVENTS = new Set(["cta_bot", "cta_call", "cta_wa"]);
router.get("/r/:token/e", async (req, res) => {
  const token = String(req.params.token || "").toUpperCase();
  const k = String(req.query.k || "");
  if (!TOKEN_RE.test(token) || !EVENTS.has(k)) return res.status(204).end();
  const rec = await findRecipientByToken(token);
  if (rec) {
    await logSmsEvent(rec.id, k, { ip: clientIp(req), userAgent: req.headers["user-agent"] as string, device: parseDevice(req.headers["user-agent"]) });
    await advanceRecipient(rec.id, "cta");
  }
  return res.status(204).end();
});

export default router;
