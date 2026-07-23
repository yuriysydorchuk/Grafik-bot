import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, closeDb, db, adminsTable, adminSessionsTable, loginEventsTable, SESSION_COOKIE } from "../test/harness.ts";
import { signWebAppInitData } from "../lib/telegramWebApp.ts";

// Вхід із Telegram Mini App: підписаний initData → сесія для адміна з відповідним
// telegram_id. Сам підпис перевірено юнітами (lib/telegramWebApp.test.ts) — тут
// перевіряємо маршрут: видачу cookie/сесії, відмови і CSRF-заголовок.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

// env.ts pins TELEGRAM_BOT_TOKEN for the whole test process — sign with the same token.
const initDataFor = (tgId: number) => signWebAppInitData({
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: "AAtest",
  user: JSON.stringify({ id: tgId, first_name: "Head", username: "head_drv" }),
}, process.env.TELEGRAM_BOT_TOKEN!);

test("linked admin gets a session + cookie; the login lands in the journal", opts, async () => {
  const [admin] = await db.insert(adminsTable).values({ name: "HeadDrv", role: "driver", telegramId: "800100" })
    .returning({ id: adminsTable.id });
  const res = await request(app).post("/api/auth/telegram-webapp").set(H).send({ initData: initDataFor(800100) });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, admin!.id);

  const cookie = (res.headers["set-cookie"] as unknown as string[])?.find(c => c.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(cookie, "session cookie must be set");
  const me = await request(app).get("/api/auth/me").set("Cookie", cookie!);
  assert.equal(me.status, 200, "the issued cookie must authenticate normal API calls");

  const sessions = await db.select().from(adminSessionsTable).where(eq(adminSessionsTable.adminId, admin!.id));
  assert.equal(sessions.length, 1);
  const events = await db.select().from(loginEventsTable).where(eq(loginEventsTable.adminId, admin!.id));
  assert.deepEqual(events.map(e => e.event), ["success"]);
});

test("a Telegram id with no admin account is refused (403) and journaled", opts, async () => {
  const res = await request(app).post("/api/auth/telegram-webapp").set(H).send({ initData: initDataFor(800999) });
  assert.equal(res.status, 403);
  const events = await db.select().from(loginEventsTable);
  assert.deepEqual(events.map(e => e.event), ["no_telegram"]);
});

test("garbage / unsigned initData is rejected with 401", opts, async () => {
  await db.insert(adminsTable).values({ name: "HeadDrv", role: "driver", telegramId: "800100" });
  const forged = initDataFor(800100).replace("head_drv", "attacker");
  for (const bad of [undefined, "", "auth_date=1&user=%7B%22id%22%3A800100%7D", forged]) {
    const res = await request(app).post("/api/auth/telegram-webapp").set(H).send({ initData: bad });
    assert.equal(res.status, 401, `must reject: ${String(bad).slice(0, 40)}`);
  }
  assert.equal((await db.select().from(adminSessionsTable)).length, 0, "no session may be created");
});

test("the CSRF header guard covers the endpoint", opts, async () => {
  await db.insert(adminsTable).values({ name: "HeadDrv", role: "driver", telegramId: "800100" });
  const res = await request(app).post("/api/auth/telegram-webapp").send({ initData: initDataFor(800100) });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "csrf");
});
