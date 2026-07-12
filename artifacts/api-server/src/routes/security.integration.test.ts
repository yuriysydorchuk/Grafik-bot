import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedRole, seedAdmin, closeDb, db, driversTable } from "../test/harness.ts";

// End-to-end route security tests against a real Express app + Postgres. Opt-in: they run
// only when TEST_DATABASE_URL points at a disposable test database, otherwise they skip.
// These validate the auth/CSRF/gate wiring that unit tests can only approximate.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

before(async () => {
  if (!hasTestDb) return;
  await seedRole("viewer", [], ["/"]);                 // authenticated but no capabilities
  await seedRole("drivermgr", ["assignDrivers"], ["/drivers"]);
  await seedRole("editor", ["editData"], ["/workers"]);
});
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

// Roles are truncated by resetDb, so re-seed them per test that needs them.
async function withRoles() {
  await seedRole("viewer", [], ["/"]);
  await seedRole("drivermgr", ["assignDrivers"], ["/drivers"]);
  await seedRole("editor", ["editData"], ["/workers"]);
}

test("unauthenticated request is rejected with 401", opts, async () => {
  const res = await request(app).get("/api/drivers");
  assert.equal(res.status, 401);
});

test("CSRF: a mutation without X-Requested-With is blocked (403 csrf) even with a valid session", opts, async () => {
  const { cookie } = await seedAdmin({ role: "owner" });
  const res = await request(app).post("/api/companies").set("Cookie", cookie).send({ name: "Acme" });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "csrf");
});

test("CSRF: the same mutation passes the guard with the header (not a csrf 403)", opts, async () => {
  const { cookie } = await seedAdmin({ role: "owner" });
  const res = await request(app)
    .post("/api/companies").set("Cookie", cookie).set("X-Requested-With", "grafik")
    .send({ name: "Acme" });
  assert.notEqual(res.body?.error, "csrf");
  assert.ok(res.status < 500);
});

test("driver-invite gate (F1): a capless role is forbidden", opts, async () => {
  await withRoles();
  const [drv] = await db.insert(driversTable).values({ name: "Kierowca" }).returning({ id: driversTable.id });
  const { cookie } = await seedAdmin({ role: "viewer" });
  const res = await request(app).get(`/api/drivers/${drv!.id}/invite`).set("Cookie", cookie);
  assert.equal(res.status, 403);
});

test("driver-invite gate (F1): assignDrivers is allowed and returns a link", opts, async () => {
  await withRoles();
  const [drv] = await db.insert(driversTable).values({ name: "Kierowca" }).returning({ id: driversTable.id });
  const { cookie } = await seedAdmin({ role: "drivermgr" });
  const res = await request(app).get(`/api/drivers/${drv!.id}/invite`).set("Cookie", cookie);
  assert.equal(res.status, 200);
  assert.match(res.body.link ?? "", /start=drv/);
});

test("finance is owner/viewFinance-only: an editData role is forbidden", opts, async () => {
  await withRoles();
  const { cookie } = await seedAdmin({ role: "editor" });
  const res = await request(app).get("/api/finance?month=2026-07").set("Cookie", cookie);
  assert.equal(res.status, 403);
});

test("a revoked session no longer authenticates", opts, async () => {
  const { cookie, adminId } = await seedAdmin({ role: "owner" });
  // First call works…
  const ok = await request(app).get("/api/drivers").set("Cookie", cookie);
  assert.equal(ok.status, 200);
  // …then bump token_version (simulating "log out everywhere") — the old cookie dies.
  const { adminsTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  await db.update(adminsTable).set({ tokenVersion: 1 }).where(eq(adminsTable.id, adminId));
  const after = await request(app).get("/api/drivers").set("Cookie", cookie);
  assert.equal(after.status, 401);
});
