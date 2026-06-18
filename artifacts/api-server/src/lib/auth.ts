import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { adminsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ─── Password hashing (scrypt, no external deps) ───────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  try {
    const salt = Buffer.from(saltHex!, "hex");
    const expected = Buffer.from(hashHex!, "hex");
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ─── Session token (HMAC-signed, stateless) ────────────────────────────────────

const SECRET = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_COOKIE = "grafik_session";

import type { Role } from "./roles";

type SessionPayload = { adminId: number; name: string; role: Role; exp: number };

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sign(data: string): string {
  return b64url(createHmac("sha256", SECRET).update(data).digest());
}

export function createToken(adminId: number, name: string, role: Role = "owner"): string {
  const payload: SessionPayload = { adminId, name, role, exp: Date.now() + TTL_MS };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string | undefined): SessionPayload | null {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = sign(body!);
  if (sig!.length !== expected.length || !timingSafeEqual(Buffer.from(sig!), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body!, "base64").toString("utf8")) as SessionPayload;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Express middleware ────────────────────────────────────────────────────────

export interface AuthedRequest extends Request {
  admin?: { adminId: number; name: string; role: Role; isMain: boolean };
}

export async function authRequired(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = (req as any).cookies?.[SESSION_COOKIE] as string | undefined;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "unauthorized" });
  // Re-check against the DB every request so deletions / role changes take effect
  // immediately (the token's role is NOT trusted for authorization).
  try {
    const [admin] = await db.select({ id: adminsTable.id, role: adminsTable.role, isMain: adminsTable.isMain }).from(adminsTable).where(eq(adminsTable.id, payload.adminId));
    if (!admin) return res.status(401).json({ error: "unauthorized" }); // account deleted
    req.admin = { adminId: admin.id, name: payload.name, role: (admin.role ?? "owner") as Role, isMain: !!admin.isMain };
    return next();
  } catch {
    return res.status(500).json({ error: "auth error" });
  }
}

// Gate a route to specific roles (use after authRequired)
export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.admin) return res.status(401).json({ error: "unauthorized" });
    if (!roles.includes(req.admin.role)) return res.status(403).json({ error: "forbidden" });
    return next();
  };
}

// Gate a route to the single immutable head admin (role assignment, user management).
// Nobody but this account — not even other owners — can pass.
export function requireMainAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.admin) return res.status(401).json({ error: "unauthorized" });
  if (!req.admin.isMain) return res.status(403).json({ error: "Лише головний адміністратор може керувати ролями та користувачами" });
  return next();
}
