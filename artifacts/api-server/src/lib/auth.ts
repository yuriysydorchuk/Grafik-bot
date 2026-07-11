import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { adminsTable, rolesTable, adminSessionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

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

// A missing SESSION_SECRET in production would silently sign sessions with a
// publicly known string — refuse to start instead.
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production");
}
const SECRET = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_COOKIE = "grafik_session";

import { OWNER, hasCap, PAGE_KEYS, CAP_KEYS, type Role, type Capability } from "./roles";

type SessionPayload = { adminId: number; name: string; role: Role; exp: number; tv?: number; sid?: string };

// ─── Role access cache (roles table) ───────────────────────────────────────────
// Role membership (pages/caps) lives in the DB and rarely changes — cache it and
// invalidate whenever a role is created/edited/deleted.
let rolesCache: Map<string, { pages: string[]; caps: string[] }> | null = null;
export async function loadRolesCache(force = false): Promise<Map<string, { pages: string[]; caps: string[] }>> {
  if (rolesCache && !force) return rolesCache;
  const rows = await db.select({ key: rolesTable.key, pages: rolesTable.pages, caps: rolesTable.caps }).from(rolesTable);
  rolesCache = new Map(rows.map(r => [r.key, { pages: r.pages ?? [], caps: r.caps ?? [] }]));
  return rolesCache;
}
export function invalidateRolesCache(): void { rolesCache = null; }

// Resolve a role key into its access sets. owner is the immutable superuser → full access.
async function resolveAccess(role: string): Promise<{ pages: string[]; caps: string[] }> {
  if (role === OWNER) return { pages: [...PAGE_KEYS], caps: [...CAP_KEYS] };
  const cache = await loadRolesCache();
  return cache.get(role) ?? { pages: [], caps: [] };
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sign(data: string): string {
  return b64url(createHmac("sha256", SECRET).update(data).digest());
}

export function createToken(adminId: number, name: string, role: Role = "owner", tokenVersion = 0, sid?: string): string {
  const payload: SessionPayload = { adminId, name, role, exp: Date.now() + TTL_MS, tv: tokenVersion, sid };
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
  admin?: { adminId: number; name: string; role: Role; isMain: boolean; caps: string[]; pages: string[]; sessionId?: string };
}

export async function authRequired(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = (req as any).cookies?.[SESSION_COOKIE] as string | undefined;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "unauthorized" });
  // Re-check against the DB every request so deletions / role changes take effect
  // immediately (the token's role is NOT trusted for authorization).
  try {
    const [admin] = await db.select({ id: adminsTable.id, role: adminsTable.role, isMain: adminsTable.isMain, tokenVersion: adminsTable.tokenVersion }).from(adminsTable).where(eq(adminsTable.id, payload.adminId));
    if (!admin) return res.status(401).json({ error: "unauthorized" }); // account deleted
    // Server-side revocation: a bumped token_version (password change / "log out everywhere")
    // invalidates every token issued before it. Pre-versioning tokens (tv undefined) count as 0.
    if ((payload.tv ?? 0) !== (admin.tokenVersion ?? 0)) return res.status(401).json({ error: "unauthorized" });
    // Per-session revocation: the token is bound to a tracked session (sid). A missing session
    // (revoked, or a legacy pre-tracking token) fails — that device is logged out.
    if (!payload.sid) return res.status(401).json({ error: "unauthorized" });
    const [sess] = await db.select({ id: adminSessionsTable.id, revokedAt: adminSessionsTable.revokedAt, lastSeenAt: adminSessionsTable.lastSeenAt })
      .from(adminSessionsTable).where(eq(adminSessionsTable.id, payload.sid));
    if (!sess || sess.revokedAt || sess.id === undefined) return res.status(401).json({ error: "unauthorized" });
    // Throttle last_seen writes to at most once per 5 min to avoid a DB write per request.
    if (Date.now() - new Date(sess.lastSeenAt).getTime() > 5 * 60 * 1000) {
      db.update(adminSessionsTable).set({ lastSeenAt: sql`now()` }).where(eq(adminSessionsTable.id, payload.sid))
        .catch(() => { /* best-effort */ });
    }
    const role = (admin.role ?? OWNER) as Role;
    const access = await resolveAccess(role);
    req.admin = { adminId: admin.id, name: payload.name, role, isMain: !!admin.isMain, caps: access.caps, pages: access.pages, sessionId: payload.sid };
    return next();
  } catch {
    return res.status(500).json({ error: "auth error" });
  }
}

// Gate a route to specific role keys (use after authRequired)
export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.admin) return res.status(401).json({ error: "unauthorized" });
    if (!roles.includes(req.admin.role)) return res.status(403).json({ error: "forbidden" });
    return next();
  };
}

// Gate a route to admins whose role grants a capability (owner always passes).
export function requireCap(cap: Capability) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.admin) return res.status(401).json({ error: "unauthorized" });
    if (!hasCap(req.admin.role, req.admin.caps, cap)) return res.status(403).json({ error: "forbidden" });
    return next();
  };
}

// Gate a route to admins whose role grants ANY of the capabilities (owner always passes).
export function requireAnyCap(...caps: Capability[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.admin) return res.status(401).json({ error: "unauthorized" });
    if (!caps.some(c => hasCap(req.admin!.role, req.admin!.caps, c))) return res.status(403).json({ error: "forbidden" });
    return next();
  };
}

// Gate a route by PAGE access (roles.pages) — for pages like «Каса» that an office
// employee fills without having any capability (owner always passes).
export function requirePage(page: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.admin) return res.status(401).json({ error: "unauthorized" });
    if (req.admin.role === OWNER || req.admin.pages.includes(page)) return next();
    return res.status(403).json({ error: "forbidden" });
  };
}

// Gate a route to the single immutable head admin (role assignment, user management).
// Nobody but this account — not even other owners — can pass.
export function requireMainAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.admin) return res.status(401).json({ error: "unauthorized" });
  if (!req.admin.isMain) return res.status(403).json({ error: "Лише головний адміністратор може керувати ролями та користувачами" });
  return next();
}
