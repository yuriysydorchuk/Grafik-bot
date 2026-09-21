// Публічна сторінка персонального SMS-лінка /r/<токен> (батч 2 SMS-кампаній):
// GET /r/:token — дані для продажної сторінки (імʼя, мова, пропозиція, лендінг, лінки),
// подія «переглянув»; GET /r/:token/e?k=cta_bot|cta_call|cta_wa — подія кнопки
// (GET, щоб sendBeacon/перехід не впирались у CSRF-гард на мутаціях).
// БЕЗ authRequired — монтується до auth-роутерів (routes/index.ts), rate-limit по префіксу.
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { db, factoriesTable, adminsTable, smsEventsTable } from "@workspace/db";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { findRecipientByToken, logSmsEvent, advanceRecipient } from "../services/sms/campaigns";
import { clientIp, parseDevice } from "../lib/clientInfo";
import { bot } from "../bot/instance";
import { escapeHtml } from "../bot/display";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use("/r", rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Забагато запитів. Спробуйте пізніше." } }));

const TOKEN_RE = /^[0-9A-Z]{8,24}$/; // 8 (нові, одна частина SMS) … 24 (старі)
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
  const landing = (c.landing ?? {}) as Record<string, any>;
  // міста на сторінці: з лендінгу кампанії, інакше — міста фабрик (без офісу), в алфавіті
  const cities: string[] = landing.cities?.length ? landing.cities : (await db.select({ city: factoriesTable.city }).from(factoriesTable).where(and(isNotNull(factoriesTable.city), ne(factoriesTable.city, ""), sql`coalesce(${factoriesTable.isOffice}, false) = false`)))
    .map((r) => String(r.city).trim()).filter((v, i, a) => v && a.indexOf(v) === i).sort((a, b) => a.localeCompare(b, "uk"));
  const [interested] = await db.select({ id: smsEventsTable.id }).from(smsEventsTable).where(and(eq(smsEventsTable.recipientId, rec.id), inArray(smsEventsTable.kind, ["interested", "interested_ref"]))).limit(1);
  return res.json({
    firstName: rec.firstName || (rec.name || "").split(" ")[0] || "",
    lang: rec.lang, kind: c.kind, campaign: c.name,
    offer: { ...offer, factoryName: fac?.name ?? null, city: offer.city || fac?.city || null, phone, whatsapp: offer.whatsapp || phone },
    landing, cities,
    recruiter: { name: landing.recruiterName || process.env.SMS_RECRUITER_NAME || "", hours: landing.hours || process.env.SMS_RECRUITER_HOURS || "10–17" },
    interested: !!interested,
    telegram: botLink(token),
    closed: c.status === "closed",
  });
});

// Кнопки сторінки. «Мені цікаво» / «Хочу привести друга» (interested*) — головна конверсія:
// телефон уже відомий, форми немає (рішення власника 21.09.2026) → рекрутер кампанії
// отримує в бот картку на обдзвон; повторне натискання не дублює сповіщення.
const EVENTS = new Set(["cta_bot", "cta_call", "cta_wa", "interested", "interested_ref"]);
router.get("/r/:token/e", async (req, res) => {
  const token = String(req.params.token || "").toUpperCase();
  const k = String(req.query.k || "");
  if (!TOKEN_RE.test(token) || !EVENTS.has(k)) return res.status(204).end();
  const rec = await findRecipientByToken(token);
  if (rec) {
    const first = k.startsWith("interested")
      ? !(await db.select({ id: smsEventsTable.id }).from(smsEventsTable).where(and(eq(smsEventsTable.recipientId, rec.id), inArray(smsEventsTable.kind, ["interested", "interested_ref"]))).limit(1))[0]
      : false;
    await logSmsEvent(rec.id, k, { ip: clientIp(req), userAgent: req.headers["user-agent"] as string, device: parseDevice(req.headers["user-agent"]) });
    await advanceRecipient(rec.id, "cta");
    if (first && rec.campaign.recruiterAdminId) {
      try {
        const [a] = await db.select({ telegramId: adminsTable.telegramId }).from(adminsTable).where(eq(adminsTable.id, rec.campaign.recruiterAdminId));
        if (a?.telegramId) await bot.telegram.sendMessage(a.telegramId,
          `📞 <b>Зацікавлений з SMS</b>${k === "interested_ref" ? " · хоче привести друга" : ""}
<b>${escapeHtml(rec.name || "—")}</b> · ${escapeHtml(rec.phone)} · ${rec.lang}
Кампанія «${escapeHtml(rec.campaign.name)}». Передзвонити.`, { parse_mode: "HTML" });
      } catch (e) { logger.warn({ err: e, recipientId: rec.id }, "sms interested notify failed"); }
    }
  }
  return res.status(204).end();
});

export default router;
