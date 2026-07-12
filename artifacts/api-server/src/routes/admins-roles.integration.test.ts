import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, adminsTable, rolesTable, loginEventsTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { invalidateRolesCache } from "../lib/auth.ts";

// User/role management is the most sensitive mutation surface: requireMainAdmin only,
// the head admin can never be demoted/deleted, system roles are protected.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function seedMainAndRoles() {
  const main = await seedAdmin({ role: "owner", isMain: true, name: "Main" });
  await seedRole("scheduler", ["editData"], ["/schedule"]);
  return main;
}

test("POST /admins: an ordinary owner (not main) is forbidden", opts, async () => {
  await seedMainAndRoles();
  const other = await seedAdmin({ role: "owner", isMain: false, name: "Owner2" });
  const res = await request(app).post("/api/admins").set("Cookie", other.cookie).set(H)
    .send({ name: "New User", role: "scheduler" });
  assert.equal(res.status, 403);
});

test("POST /admins: main admin creates a user and gets an invite link; unknown role → 400", opts, async () => {
  const main = await seedMainAndRoles();
  const ok = await request(app).post("/api/admins").set("Cookie", main.cookie).set(H)
    .send({ name: "New User", role: "scheduler" });
  assert.equal(ok.status, 200);
  assert.match(ok.body.inviteLink ?? "", /start=adm/);

  const bad = await request(app).post("/api/admins").set("Cookie", main.cookie).set(H)
    .send({ name: "X", role: "no-such-role" });
  assert.equal(bad.status, 400);
});

test("the head admin can never be demoted from owner", opts, async () => {
  const main = await seedMainAndRoles();
  const res = await request(app).patch(`/api/admins/${main.adminId}/role`).set("Cookie", main.cookie).set(H)
    .send({ role: "scheduler" });
  assert.equal(res.status, 400);
  const [row] = await db.select({ role: adminsTable.role }).from(adminsTable).where(eq(adminsTable.id, main.adminId));
  assert.equal(row!.role, "owner");
});

test("DELETE /admins/:id: main admin protected; a user who logged in still deletes (FK cleanup)", opts, async () => {
  const main = await seedMainAndRoles();
  const victim = await seedAdmin({ role: "owner", name: "Victim" }); // has an admin_sessions row
  await db.insert(loginEventsTable).values({ adminId: victim.adminId, event: "success" }); // and an audit row

  const delMain = await request(app).delete(`/api/admins/${main.adminId}`).set("Cookie", main.cookie).set(H);
  assert.equal(delMain.status, 400); // main admin — never deletable (also covers "self" for the caller)

  // Deleting a user who has a session + a login event must NOT fail on FK constraints.
  const delOther = await request(app).delete(`/api/admins/${victim.adminId}`).set("Cookie", main.cookie).set(H);
  assert.equal(delOther.status, 200);
  assert.equal((await db.select().from(adminsTable).where(eq(adminsTable.id, victim.adminId))).length, 0);
  // The audit row survives but is unlinked (admin_id → null), not deleted.
  const events = await db.select().from(loginEventsTable).where(eq(loginEventsTable.adminId, victim.adminId));
  assert.equal(events.length, 0, "no login_events should still point at the deleted admin");
});

test("reset-web bumps token_version → the target's live session dies", opts, async () => {
  const main = await seedMainAndRoles();
  const target = await seedAdmin({ role: "owner", name: "Target" });
  // The target's cookie works before the reset…
  assert.equal((await request(app).get("/api/auth/me").set("Cookie", target.cookie)).status, 200);
  const res = await request(app).post(`/api/admins/${target.adminId}/reset-web`).set("Cookie", main.cookie).set(H);
  assert.equal(res.status, 200);
  // …and is revoked right after (token_version mismatch).
  assert.equal((await request(app).get("/api/auth/me").set("Cookie", target.cookie)).status, 401);
});

test("roles CRUD: create filters unknown caps/pages; owner role immutable; system/in-use roles protected", opts, async () => {
  const main = await seedMainAndRoles();

  // create — unknown capability and page keys are silently dropped (catalogue allow-list)
  const created = await request(app).post("/api/roles").set("Cookie", main.cookie).set(H)
    .send({ label: "Аудитор", caps: ["editData", "hackThePlanet"], pages: ["/schedule", "/etc/passwd"] });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.caps, ["editData"]);
  assert.deepEqual(created.body.pages, ["/schedule"]);

  // owner role can't be edited
  const [ownerRole] = await db.insert(rolesTable).values({ key: "owner", label: "Власник", isSystem: true }).returning({ id: rolesTable.id });
  invalidateRolesCache();
  const patchOwner = await request(app).patch(`/api/roles/${ownerRole!.id}`).set("Cookie", main.cookie).set(H).send({ label: "X" });
  assert.equal(patchOwner.status, 400);

  // a system role can't be deleted
  const delSystem = await request(app).delete(`/api/roles/${ownerRole!.id}`).set("Cookie", main.cookie).set(H);
  assert.equal(delSystem.status, 400);

  // an in-use role can't be deleted (scheduler is referenced by a user)
  await request(app).post("/api/admins").set("Cookie", main.cookie).set(H).send({ name: "U", role: "scheduler" });
  const [schedRole] = await db.select({ id: rolesTable.id }).from(rolesTable).where(eq(rolesTable.key, "scheduler"));
  const delUsed = await request(app).delete(`/api/roles/${schedRole!.id}`).set("Cookie", main.cookie).set(H);
  assert.equal(delUsed.status, 400);

  // an unused custom role deletes fine
  const delFree = await request(app).delete(`/api/roles/${created.body.id}`).set("Cookie", main.cookie).set(H);
  assert.equal(delFree.status, 200);
});
