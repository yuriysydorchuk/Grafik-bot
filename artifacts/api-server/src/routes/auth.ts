import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { randomBytes } from "node:crypto";
import { db } from "@workspace/db";
import { adminsTable, rolesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyPassword, createToken, authRequired, SESSION_COOKIE, type AuthedRequest } from "../lib/auth";
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

function setSession(res: any, admin: { id: number; name: string; role: string | null }) {
  const role = (admin.role ?? "owner") as any;
  const token = createToken(admin.id, admin.name, role);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax",
    secure: process.env.NODE_ENV === "production", // HTTPS-only cookie in production
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

// Step 1: username + password → send a Telegram 2FA code
router.post("/auth/login", authLimiter, async (req, res) => {
  sweep();
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: "Введіть логін і пароль" });
  const admin = (await db.select().from(adminsTable).where(eq(adminsTable.username, String(username).trim().toLowerCase())))[0];
  if (!admin || !verifyPassword(String(password), admin.passwordHash)) {
    return res.status(401).json({ error: "Невірний логін або пароль" });
  }
  if (!admin.telegramId) {
    return res.status(403).json({ error: "Акаунт не приєднаний до Telegram — двофакторний вхід неможливий. Зверніться до власника." });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
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
  if (String(code).trim() !== p.code) { p.attempts++; return res.status(401).json({ error: "Невірний код." }); }
  pending.delete(String(pendingId));
  const admin = (await db.select().from(adminsTable).where(eq(adminsTable.id, p.adminId)))[0];
  if (!admin) return res.status(401).json({ error: "Акаунт не знайдено" });
  setSession(res, admin);
  return res.json({ id: admin.id, name: admin.name, username: admin.username, role: admin.role ?? "owner" });
});

router.post("/auth/logout", (_req, res) => {
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
