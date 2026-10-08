import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, factoriesTable } from "../test/harness.ts";

// Роль «лише перегляд» (08.10.2026, «Власник (перегляд)»): прапорець readOnly у roles.caps —
// authRequired відхиляє будь-яку мутацію, крім особистих налаштувань і «читальних» POST.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("readOnly: читання проходить, мутація — 403 code=readOnly і нічого не пише", opts, async () => {
  await seedRole("owner_view", ["readOnly", "editData", "viewFinance"], ["/finance", "/factories"]);
  const ro = await seedAdmin({ role: "owner_view", name: "Viewer" });
  assert.equal((await request(app).get("/api/factories").set("Cookie", ro.cookie)).status, 200);
  const r = await request(app).post("/api/factories").set("Cookie", ro.cookie).set(H).send({ name: "Нова фабрика" });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "readOnly");
  assert.equal((await db.select().from(factoriesTable)).length, 0);
});

test("readOnly: особисті налаштування й позначка «прочитано» дозволені", opts, async () => {
  await seedRole("owner_view", ["readOnly", "viewFinance"], ["/finance"]);
  const ro = await seedAdmin({ role: "owner_view" });
  assert.equal((await request(app).post("/api/auth/web-prefs").set("Cookie", ro.cookie).set(H).send({ key: "x", value: 1 })).status, 200);
  assert.equal((await request(app).post("/api/notifications/read").set("Cookie", ro.cookie).set(H).send({ id: "all" })).status, 200);
});

test("без readOnly та сама роль редагує (контроль)", opts, async () => {
  await seedRole("editor", ["editData"], ["/factories"]);
  const ed = await seedAdmin({ role: "editor" });
  assert.equal((await request(app).post("/api/factories").set("Cookie", ed.cookie).set(H).send({ name: "Нова фабрика" })).status, 200);
});

test("readOnly зберігається редактором ролей, owner його не отримує", opts, async () => {
  const main = await seedAdmin({ role: "owner", isMain: true });
  const r = await request(app).post("/api/roles").set("Cookie", main.cookie).set(H)
    .send({ label: "Viewer", pages: ["/finance"], caps: ["readOnly", "viewFinance", "bogus"] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.caps, ["readOnly", "viewFinance"]);
  const me = await request(app).get("/api/auth/me").set("Cookie", main.cookie);
  assert.ok(!me.body.caps.includes("readOnly"));
});
