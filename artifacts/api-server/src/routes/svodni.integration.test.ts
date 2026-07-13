import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, svodniRowsTable, workersTable } from "../test/harness.ts";

// Гейти сводних: сторінка — capability `svodni`; закритий шар (księgowość,
// готівка, конто) віддається ЛИШЕ з `svodniSensitive` — перевіряємо фільтрацію
// в самій відповіді API, не в UI. Плюс ручна привʼязка людини до працівника.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function seedRow(over: Record<string, unknown> = {}) {
  await db.insert(svodniRowsTable).values({
    periodMonth: "2026-06", city: "Люблін", firm: "ES", factoryLabel: "TESTOWA",
    rawName: "KOWALSKI JAN", linkStatus: "unmatched",
    hours: 160, rateBrutto: 31.4, rateNetto: 25.35, doWyplaty: 4056,
    hoursDeclared: 100, ksiegBrutto: 3140, ksiegNetto: 2535, gotowka: 1521, konto: 2535,
    extras: {}, hr: {}, sheetValues: {},
    ...over,
  } as any);
}

test("без capability svodni — 403; з нею — 200", opts, async () => {
  await seedRow();
  await seedRole("editor", ["editData"], ["/workers"]);
  const editor = (await seedAdmin({ role: "editor" })).cookie;
  assert.equal((await request(app).get("/api/svodni?month=2026-06").set("Cookie", editor)).status, 403);

  await seedRole("svodniBase", ["svodni"], ["/svodni"]);
  const base = (await seedAdmin({ role: "svodniBase", name: "Base" })).cookie;
  const res = await request(app).get("/api/svodni?month=2026-06").set("Cookie", base);
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 1);
});

test("закритий шар: базовий кап НЕ бачить готівку/księgowość, sensitive і owner — бачать", opts, async () => {
  await seedRow();
  await seedRole("svodniBase", ["svodni"], ["/svodni"]);
  await seedRole("svodniFull", ["svodni", "svodniSensitive"], ["/svodni"]);
  const base = (await seedAdmin({ role: "svodniBase", name: "Base" })).cookie;
  const full = (await seedAdmin({ role: "svodniFull", name: "Full" })).cookie;
  const owner = (await seedAdmin({ role: "owner", name: "Own" })).cookie;

  const rBase = (await request(app).get("/api/svodni?month=2026-06").set("Cookie", base)).body;
  assert.equal(rBase.sensitive, false);
  assert.equal(rBase.rows[0].gotowka, undefined, "готівка не має віддаватись без svodniSensitive");
  assert.equal(rBase.rows[0].ksiegNetto, undefined);
  assert.equal(rBase.rows[0].konto, undefined);
  assert.equal(rBase.rows[0].hours, 160, "відкритий шар (фактичні години) — видно");
  assert.equal(rBase.rows[0].doWyplaty, 4056);

  const rFull = (await request(app).get("/api/svodni?month=2026-06").set("Cookie", full)).body;
  assert.equal(rFull.sensitive, true);
  assert.equal(rFull.rows[0].gotowka, 1521);
  assert.equal(rFull.rows[0].ksiegNetto, 2535);

  const rOwner = (await request(app).get("/api/svodni?month=2026-06").set("Cookie", owner)).body;
  assert.equal(rOwner.rows[0].gotowka, 1521, "owner завжди бачить усе");
});

test("привʼязка: POST /svodni/link підвʼязує всі рядки імені в місті", opts, async () => {
  await seedRow();
  await seedRow({ periodMonth: "2026-05" }); // та сама людина, інший місяць
  const [w] = await db.insert(workersTable).values({ fullName: "Kowalski Jan" }).returning();
  const owner = (await seedAdmin({ role: "owner" })).cookie;

  const un = (await request(app).get("/api/svodni/unmatched").set("Cookie", owner)).body;
  assert.equal(un.people.length, 1);
  assert.deepEqual(un.people[0].months, ["2026-05", "2026-06"]);

  const link = await request(app).post("/api/svodni/link").set("Cookie", owner).set(H)
    .send({ rawName: "KOWALSKI JAN", city: "Люблін", workerId: w!.id, status: "confirmed" });
  assert.equal(link.status, 200);
  assert.equal(link.body.updated, 2, "обидва місяці підвʼязано");

  const rows = await db.select().from(svodniRowsTable);
  assert.ok(rows.every(r => r.workerId === w!.id && r.linkStatus === "confirmed"));
});
