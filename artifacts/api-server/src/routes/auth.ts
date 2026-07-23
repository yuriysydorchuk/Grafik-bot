import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { randomBytes, randomInt } from "node:crypto";
import { db } from "@workspace/db";
import { adminsTable, rolesTable, adminSessionsTable, loginEventsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { verifyPassword, createToken, verifyToken, authRequired, SESSION_COOKIE, type AuthedRequest } from "../lib/auth";
import { verifyWebAppInitData } from "../lib/telegramWebApp";
import { clientIp, parseDevice, lookupGeo } from "../lib/clientInfo";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Brute-force protection on the auth endpoints (per IP)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Забагато спроб. Спробуйте за 15 хвилин." },
});

// Pending 2FA logins (in-memory, short-lived). pendingId → { adminId, code, expires, attempts }
const pending = new Map<string, { adminId: number; code: string; expires: number; attempts: number }>();
const PENDING_TTL = 5 * 60 * 1000;
function sweep() { const now = Date.now(); for (const [k, v] of pending) if (v.expires < now) pending.delete(k); }

type LoginEventKind = "success" | "bad_password" | "bad_2fa" | "no_telegram" | "logout";

// Record a sign-in attempt (success or failure). Geo is resolved asynchronously so it never
// slows the login response; the row is patched in once the lookup returns.
async function logEvent(req: any, event: LoginEventKind, opts: { adminId?: number | null; usernameTried?: string | null; sessionId?: string | null } = {}) {
  const ip = clientIp(req);
  const device = parseDevice(req.headers?.["user-agent"]);
  try {
    const [row] = await db.insert(loginEventsTable).values({
      adminId: opts.adminId ?? null,
      usernameTried: opts.usernameTried ?? null,
      ip, device, event,
      sessionId: opts.sessionId ?? null,
    }).returning({ id: loginEventsTable.id });
    if (row) fillGeo(ip, { eventId: row.id, sessionId: opts.sessionId ?? null });
  } catch (e) {
    logger.error({ err: e }, "logEvent failed");
  }
}

// Fire-and-forget geo backfill for a session and/or login event.
function fillGeo(ip: string | null, target: { eventId?: number; sessionId?: string | null }) {
  lookupGeo(ip).then(geo => {
    if (!geo) return;
    if (target.sessionId) db.update(adminSessionsTable).set({ geo }).where(eq(adminSessionsTable.id, target.sessionId)).catch(() => {});
    if (target.eventId) db.update(loginEventsTable).set({ geo }).where(eq(loginEventsTable.id, target.eventId)).catch(() => {});
  }).catch(() => {});
}

// Create the tracked session row + issue its HMAC token cookie.
async function setSession(req: any, res: any, admin: { id: number; name: string; role: string | null; tokenVersion?: number }): Promise<string> {
  const role = (admin.role ?? "owner") as any;
  const sid = randomBytes(24).toString("hex");
  const ip = clientIp(req);
  const ua = (req.headers?.["user-agent"] as string | undefined) ?? null;
  await db.insert(adminSessionsTable).values({ id: sid, adminId: admin.id, ip, userAgent: ua, device: parseDevice(ua) });
  fillGeo(ip, { sessionId: sid });
  const token = createToken(admin.id, admin.name, role, admin.tokenVersion ?? 0, sid);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax",
    secure: process.env.NODE_ENV === "production", // HTTPS-only cookie in production
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  return sid;
}

// Step 1: username + password → send a Telegram 2FA code
router.post("/auth/login", authLimiter, async (req, res) => {
  sweep();
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: "Введіть логін і пароль" });
  const uname = String(username).trim().toLowerCase();
  const admin = (await db.select().from(adminsTable).where(eq(adminsTable.username, uname)))[0];
  if (!admin || !verifyPassword(String(password), admin.passwordHash)) {
    await logEvent(req, "bad_password", { adminId: admin?.id ?? null, usernameTried: uname });
    return res.status(401).json({ error: "Невірний логін або пароль" });
  }
  if (!admin.telegramId) {
    await logEvent(req, "no_telegram", { adminId: admin.id, usernameTried: uname });
    return res.status(403).json({ error: "Акаунт не приєднаний до Telegram — двофакторний вхід неможливий. Зверніться до власника." });
  }
  const code = String(randomInt(100000, 1000000));
  const pendingId = randomBytes(16).toString("hex");
  pending.set(pendingId, { adminId: admin.id, code, expires: Date.now() + PENDING_TTL, attempts: 0 });
  try {
    const { sendLoginCode } = await import("../bot/notify");
    const sent = await sendLoginCode(admin.telegramId, code);
    if (!sent) { pending.delete(pendingId); return res.status(502).json({ error: "Не вдалося надіслати код у Telegram. Переконайтесь, що бот запущений і ви почали з ним діалог." }); }
  } catch (e) {
    logger.error({ err: e }, "send login code failed");
    pending.delete(pendingId);
    return res.status(502).json({ error: "Помилка надсилання коду." });
  }
  return res.json({ twoFactor: true, pendingId });
});

// Step 2: verify the Telegram code → issue session
router.post("/auth/verify-2fa", authLimiter, async (req, res) => {
  sweep();
  const { pendingId, code } = req.body ?? {};
  const p = pending.get(String(pendingId));
  if (!p) return res.status(400).json({ error: "Сесію входу не знайдено або вона застаріла. Увійдіть знову." });
  if (Date.now() > p.expires) { pending.delete(String(pendingId)); return res.status(400).json({ error: "Код прострочено. Увійдіть знову." }); }
  if (p.attempts >= 5) { pending.delete(String(pendingId)); return res.status(429).json({ error: "Забагато спроб. Увійдіть знову." }); }
  if (String(code).trim() !== p.code) {
    p.attempts++;
    await logEvent(req, "bad_2fa", { adminId: p.adminId });
    return res.status(401).json({ error: "Невірний код." });
  }
  pending.delete(String(pendingId));
  const admin = (await db.select().from(adminsTable).where(eq(adminsTable.id, p.adminId)))[0];
  if (!admin) return res.status(401).json({ error: "Акаунт не знайдено" });
  const sid = await setSession(req, res, admin);
  await logEvent(req, "success", { adminId: admin.id, usernameTried: admin.username, sessionId: sid });
  return res.json({ id: admin.id, name: admin.name, username: admin.username, role: admin.role ?? "owner" });
});

// Telegram Mini App: the panel opened inside Telegram logs in by the WebApp initData
// signature instead of password+2FA. Telegram itself vouches for the user identity, so a
// verified telegram_id mapping to an existing admin account is the whole authentication.
router.post("/auth/telegram-webapp", authLimiter, async (req, res) => {
  const { initData } = req.body ?? {};
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const verified = verifyWebAppInitData(String(initData ?? ""), botToken);
  if (!verified) return res.status(401).json({ error: "Не вдалося підтвердити Telegram-підпис. Відкрийте панель через кнопку в боті ще раз." });
  const admin = (await db.select().from(adminsTable).where(eq(adminsTable.telegramId, String(verified.user.id))))[0];
  if (!admin) {
    await logEvent(req, "no_telegram", { usernameTried: `tg:${verified.user.id}` });
    return res.status(403).json({ error: "Цей Telegram-акаунт не має доступу до панелі. Зверніться до власника." });
  }
  const sid = await setSession(req, res, admin);
  await logEvent(req, "success", { adminId: admin.id, usernameTried: admin.username, sessionId: sid });
  return res.json({ id: admin.id, name: admin.name, username: admin.username, role: admin.role ?? "owner" });
});

router.post("/auth/logout", async (req, res) => {
  // Revoke just this device's session (not "everywhere" — that's an explicit action on the
  // Security page). Succeeds regardless of token validity.
  const payload = verifyToken((req as any).cookies?.[SESSION_COOKIE]);
  if (payload?.sid) {
    try { await db.update(adminSessionsTable).set({ revokedAt: sql`now()` }).where(eq(adminSessionsTable.id, payload.sid)); } catch { /* best-effort */ }
    await logEvent(req, "logout", { adminId: payload.adminId, sessionId: payload.sid });
  }
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

router.get("/auth/me", authRequired, async (req: AuthedRequest, res) => {
  const admin = (await db.select().from(adminsTable).where(eq(adminsTable.id, req.admin!.adminId)))[0];
  if (!admin) return res.status(401).json({ error: "unauthorized" });
  const roleKey = admin.role ?? "owner";
  const [role] = await db.select({ label: rolesTable.label }).from(rolesTable).where(eq(rolesTable.key, roleKey));
  return res.json({
    id: admin.id, name: admin.name, username: admin.username, isMain: !!admin.isMain,
    role: roleKey, roleLabel: role?.label ?? roleKey,
    caps: req.admin!.caps, pages: req.admin!.pages,
  });
});

export default router;
