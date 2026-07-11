import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { adminSessionsTable, loginEventsTable, adminsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { authRequired, requireMainAdmin, type AuthedRequest } from "../lib/auth";

// Security / sessions — head-admin-only view of who logged in (when, from where, which device)
// plus per-session revocation. Gated to the single main admin, like user/role management.
const router: IRouter = Router();
router.use(authRequired);
router.use(requireMainAdmin);

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });

// Active + recently-seen sessions across all admins. `current` marks the caller's own device.
router.get("/security/sessions", async (req: AuthedRequest, res) => {
  const rows = await db.select({
    id: adminSessionsTable.id,
    adminId: adminSessionsTable.adminId,
    adminName: adminsTable.name,
    createdAt: adminSessionsTable.createdAt,
    lastSeenAt: adminSessionsTable.lastSeenAt,
    ip: adminSessionsTable.ip,
    device: adminSessionsTable.device,
    geo: adminSessionsTable.geo,
    revokedAt: adminSessionsTable.revokedAt,
  })
    .from(adminSessionsTable)
    .leftJoin(adminsTable, eq(adminsTable.id, adminSessionsTable.adminId))
    .orderBy(desc(adminSessionsTable.lastSeenAt))
    .limit(200);
  ok(res, rows.map(r => ({ ...r, active: !r.revokedAt, current: r.id === req.admin!.sessionId })));
});

// Sign-in audit trail: successes and failures.
router.get("/security/login-events", async (_req, res) => {
  const rows = await db.select({
    id: loginEventsTable.id,
    adminId: loginEventsTable.adminId,
    adminName: adminsTable.name,
    usernameTried: loginEventsTable.usernameTried,
    at: loginEventsTable.at,
    ip: loginEventsTable.ip,
    device: loginEventsTable.device,
    geo: loginEventsTable.geo,
    event: loginEventsTable.event,
  })
    .from(loginEventsTable)
    .leftJoin(adminsTable, eq(adminsTable.id, loginEventsTable.adminId))
    .orderBy(desc(loginEventsTable.at))
    .limit(300);
  ok(res, rows);
});

// Block one suspicious session — its token stops working on the next request.
router.post("/security/sessions/:id/revoke", async (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  const [sess] = await db.select({ id: adminSessionsTable.id }).from(adminSessionsTable).where(eq(adminSessionsTable.id, id));
  if (!sess) return fail(res, 404, "Сесію не знайдено");
  await db.update(adminSessionsTable)
    .set({ revokedAt: sql`now()`, revokedBy: req.admin!.adminId })
    .where(eq(adminSessionsTable.id, id));
  ok(res, { ok: true });
});

// Log an admin out of ALL devices: revoke every active session + bump token_version so any
// legacy/outstanding token dies too.
router.post("/security/admins/:id/logout-everywhere", async (req, res) => {
  const adminId = Number(req.params.id);
  if (!Number.isFinite(adminId)) return fail(res, 400, "Невірний id");
  await db.update(adminSessionsTable)
    .set({ revokedAt: sql`now()`, revokedBy: (req as AuthedRequest).admin!.adminId })
    .where(sql`${adminSessionsTable.adminId} = ${adminId} AND ${adminSessionsTable.revokedAt} IS NULL`);
  await db.update(adminsTable)
    .set({ tokenVersion: sql`${adminsTable.tokenVersion} + 1` })
    .where(eq(adminsTable.id, adminId));
  ok(res, { ok: true });
});

export default router;
