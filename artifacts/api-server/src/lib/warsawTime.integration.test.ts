// Конвенція часу БД наскрізь: DB-дефолт now(), JS Date через Drizzle, сирий Date-параметр у sql``
// і now() у SQL — усе в одному поясі (Europe/Warsaw). До 09.10.2026 created_at (БД) і
// updated_at (JS) розходились на 1–2 год.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { hasTestDb, resetDb, closeDb, db } from "../test/harness.ts";
import { settingsTable, fromWarsawWall } from "@workspace/db";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("now() у БД, defaultNow, JS Date і Date-параметр — один пояс", opts, async () => {
  const [{ tz, nowWall }] = (await db.execute(sql`select current_setting('timezone') as tz, now()::timestamp::text as "nowWall"`)).rows as { tz: string; nowWall: string }[];
  assert.equal(tz, "Europe/Warsaw", "сесія Postgres примусово у Warsaw");
  const dbNow = fromWarsawWall(nowWall).getTime();
  assert.ok(Math.abs(dbNow - Date.now()) < 5_000, `now() БД ≈ Date.now(): ${nowWall} vs ${new Date().toISOString()}`);

  // defaultNow (БД) читається як правильний момент (settings не чистить resetDb — прибираємо ключ самі)
  await db.delete(settingsTable).where(eq(settingsTable.key, "tz_probe"));
  const [ins] = await db.insert(settingsTable).values({ key: "tz_probe", value: "1" }).returning();
  assert.ok(Math.abs(ins!.updatedAt.getTime() - Date.now()) < 5_000, `defaultNow: ${ins!.updatedAt.toISOString()}`);

  // JS Date через Drizzle: round-trip і те саме, що бачить SQL
  const at = new Date("2026-07-01T10:00:00.250Z"); // 12:00:00.250 у Варшаві
  await db.update(settingsTable).set({ updatedAt: at }).where(eq(settingsTable.key, "tz_probe"));
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, "tz_probe"));
  assert.equal(row!.updatedAt.toISOString(), at.toISOString());
  const [{ wall }] = (await db.execute(sql`select updated_at::text as wall from settings where key = 'tz_probe'`)).rows as { wall: string }[];
  assert.equal(wall, "2026-07-01 12:00:00.25", "у БД лежить варшавський настінний час");

  // сирий Date-параметр у sql`` порівнюється з колонкою в тому ж поясі
  const [{ cnt }] = (await db.execute(sql`select count(*)::int as cnt from settings where key = 'tz_probe' and updated_at = ${at}`)).rows as { cnt: number }[];
  assert.equal(cnt, 1, "Date-параметр = збережене значення");
  const [{ before }] = (await db.execute(sql`select count(*)::int as before from settings where key = 'tz_probe' and updated_at < now()`)).rows as { before: number }[];
  assert.equal(before, 1, "липень 2026 < now() у SQL");
});
