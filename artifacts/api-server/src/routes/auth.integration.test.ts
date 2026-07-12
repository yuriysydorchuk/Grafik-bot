import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  app, hasTestDb, resetDb, closeDb, db,
  adminsTable, adminSessionsTable, loginEventsTable, hashPassword, SESSION_COOKIE,
} from "../test/harness.ts";
import { eq, desc } from "drizzle-orm";
import { bot } from "../bot/instance.ts";

// End-to-end login/2FA/logout flow. The Telegram code-send is stubbed at bot.telegram
// (dummy token, no network) so we can read the 2FA code the server generated.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

let sentText = "";
(bot.telegram as any).sendMessage = async (_chat: string, text: string) => { sentText = String(text); return { message_id: 1 }; };

beforeEach(async () => { if (hasTestDb) { await resetDb(); sentText = ""; } });
after(async () => { if (hasTestDb) await closeDb(); });

async function seedLoginAdmin(over: Record<string, unknown> = {}): Promise<{ id: number; username: string; password: string }> {
  const username = `user${Math.random().toString(36).slice(2, 8)}`;
  const password = "S3cret-pass";
  const [a] = await db.insert(adminsTable).values({
    name: "Login Admin", username, passwordHash: hashPassword(password),
    role: "owner", isMain: true, telegramId: `tg-${Math.random().toString(36).slice(2, 8)}`, tokenVersion: 0,
    ...over,
  }).returning({ id: adminsTable.id });
  return { id: a!.id, username, password };
}
async function lastEvent(adminId: number) {
  const [e] = await db.select().from(loginEventsTable).where(eq(loginEventsTable.adminId, adminId)).orderBy(desc(loginEventsTable.id)).limit(1);
  return e;
}

test("full login → 2FA → session → /auth/me", opts, async () => {
  const { id, username, password } = await seedLoginAdmin();

  const login = await request(app).post("/api/auth/login").send({ username, password });
  assert.equal(login.status, 200);
  assert.equal(login.body.twoFactor, true);
  const code = sentText.match(/`(\d{6})`/)?.[1];
  assert.ok(code, "a 6-digit code must have been sent");

  const verify = await request(app).post("/api/auth/verify-2fa").send({ pendingId: login.body.pendingId, code });
  assert.equal(verify.status, 200);
  const cookie = (verify.headers["set-cookie"] as unknown as string[])?.find(c => c.startsWith(SESSION_COOKIE));
  assert.ok(cookie, "a session cookie must be set");

  const me = await request(app).get("/api/auth/me").set("Cookie", cookie!.split(";")[0]!);
  assert.equal(me.status, 200);
  assert.equal(me.body.id, id);
  assert.equal((await lastEvent(id))!.event, "success");
});

test("wrong password → 401 and a bad_password event", opts, async () => {
  const { id, username } = await seedLoginAdmin();
  const res = await request(app).post("/api/auth/login").send({ username, password: "nope" });
  assert.equal(res.status, 401);
  assert.equal((await lastEvent(id))!.event, "bad_password");
});

test("account without Telegram cannot do 2FA → 403 no_telegram", opts, async () => {
  const { id, username, password } = await seedLoginAdmin({ telegramId: null });
  const res = await request(app).post("/api/auth/login").send({ username, password });
  assert.equal(res.status, 403);
  assert.equal((await lastEvent(id))!.event, "no_telegram");
});

test("wrong 2FA code → 401 and a bad_2fa event", opts, async () => {
  const { id, username, password } = await seedLoginAdmin();
  const login = await request(app).post("/api/auth/login").send({ username, password });
  const res = await request(app).post("/api/auth/verify-2fa").send({ pendingId: login.body.pendingId, code: "000000" });
  assert.equal(res.status, 401);
  assert.equal((await lastEvent(id))!.event, "bad_2fa");
});

test("logout revokes the current session and records a logout event", opts, async () => {
  const { username, password } = await seedLoginAdmin();
  const login = await request(app).post("/api/auth/login").send({ username, password });
  const code = sentText.match(/`(\d{6})`/)?.[1];
  const verify = await request(app).post("/api/auth/verify-2fa").send({ pendingId: login.body.pendingId, code });
  const cookie = (verify.headers["set-cookie"] as unknown as string[]).find(c => c.startsWith(SESSION_COOKIE))!.split(";")[0]!;

  // /auth/logout mutates state → CSRF guard requires the header.
  const out = await request(app).post("/api/auth/logout").set("Cookie", cookie).set("X-Requested-With", "grafik");
  assert.equal(out.status, 200);

  const sessions = await db.select().from(adminSessionsTable);
  assert.ok(sessions.every(s => s.revokedAt), "the session must be revoked");
  // The revoked cookie no longer authenticates.
  const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
  assert.equal(me.status, 401);
});
