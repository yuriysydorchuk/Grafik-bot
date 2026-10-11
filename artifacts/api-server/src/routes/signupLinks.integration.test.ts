import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, workersTable, factoriesTable, adminsTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { resolveSignupLink } from "../services/signupLinks";

// Персональні лінки реєстрації (cap signupLinks): сталий лінк адмін×фабрика, свої/усі,
// атрибуція «хто привів», перевипуск токена, скоуп фабрик.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

let recruiter = { adminId: 0, cookie: "" };
let factoryId = 0;
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  await seedRole("recruiter", ["signupLinks"], ["/signup-links"]);
  recruiter = await seedAdmin({ role: "recruiter", name: "Rekruter" });
  const [f] = await db.insert(factoriesTable).values({ name: "Fabryka Lublin", city: "Lublin" }).returning({ id: factoriesTable.id });
  factoryId = f!.id;
});
after(async () => { if (hasTestDb) await closeDb(); });

test("POST get-or-create: той самий лінк на пару адмін×фабрика; URL — deep-link rec<токен>", opts, async () => {
  const a = await request(app).post("/api/signup-links").set("Cookie", recruiter.cookie).set(H).send({ factoryId });
  assert.equal(a.status, 200);
  assert.match(a.body.url, /start=rec[0-9A-Z]{12}$/);
  assert.equal(a.body.factoryName, "Fabryka Lublin");
  const b = await request(app).post("/api/signup-links").set("Cookie", recruiter.cookie).set(H).send({ factoryId });
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.token, a.body.token, "сталий лінк — можна друкувати");
  const list = await request(app).get("/api/signup-links").set("Cookie", recruiter.cookie);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].registered, 0);
});

test("атрибуція: працівник із signup_link_id рахується в лічильниках і в списку лінка; чужий лінк — 404, owner бачить усіх", opts, async () => {
  const { body: link } = await request(app).post("/api/signup-links").set("Cookie", recruiter.cookie).set(H).send({ factoryId });
  await db.insert(workersTable).values({ fullName: "Jan Nowak", factoryId, signupLinkId: link.id, firstWorkDate: "2026-10-01" });
  await db.insert(workersTable).values({ fullName: "Piotr Fired", factoryId, signupLinkId: link.id, isActive: false });
  const list = await request(app).get("/api/signup-links").set("Cookie", recruiter.cookie);
  assert.deepEqual([list.body[0].registered, list.body[0].active, list.body[0].started], [2, 1, 1]);
  const ws = await request(app).get(`/api/signup-links/${link.id}/workers`).set("Cookie", recruiter.cookie);
  assert.equal(ws.status, 200);
  assert.deepEqual(ws.body.map((w: any) => w.fullName).sort(), ["Jan Nowak", "Piotr Fired"]);

  const other = await seedAdmin({ role: "recruiter", name: "Inny" });
  assert.equal((await request(app).get(`/api/signup-links/${link.id}/workers`).set("Cookie", other.cookie)).status, 404, "чужий лінк не розкривається");
  assert.equal((await request(app).get("/api/signup-links").set("Cookie", other.cookie)).body.length, 0);

  const owner = await seedAdmin({ role: "owner" });
  const all = await request(app).get("/api/signup-links?all=1").set("Cookie", owner.cookie);
  assert.equal(all.body.length, 1);
  assert.equal(all.body[0].adminName, "Rekruter");
  assert.equal((await request(app).get(`/api/signup-links/${link.id}/qr.png`).set("Cookie", owner.cookie)).headers["content-type"], "image/png");
});

test("rotate: новий токен, старий більше не резолвиться, атрибуція лишається", opts, async () => {
  const { body: link } = await request(app).post("/api/signup-links").set("Cookie", recruiter.cookie).set(H).send({ factoryId });
  await db.insert(workersTable).values({ fullName: "Anna", signupLinkId: link.id });
  const r = await request(app).post(`/api/signup-links/${link.id}/rotate`).set("Cookie", recruiter.cookie).set(H).send({});
  assert.equal(r.status, 200);
  assert.notEqual(r.body.token, link.token);
  assert.equal(r.body.id, link.id);
  assert.equal(r.body.registered, 1);
  assert.equal(await resolveSignupLink(link.token), null);
  assert.equal((await resolveSignupLink(r.body.token.toLowerCase()))?.factory.id, factoryId, "регістр токена не має значення");
});

test("гейти: без cap — 403; скоуп-адмін не отримує лінк на фабрику поза скоупом; офісна фабрика — 400", opts, async () => {
  await seedRole("plain", ["viewWorkers"], ["/workers"]);
  const plain = await seedAdmin({ role: "plain" });
  assert.equal((await request(app).get("/api/signup-links").set("Cookie", plain.cookie)).status, 403);

  const [otherFac] = await db.insert(factoriesTable).values({ name: "Fabryka Poznan", city: "Poznan" }).returning({ id: factoriesTable.id });
  await db.update(adminsTable).set({ scopeFactoryIds: [factoryId] }).where(eq(adminsTable.id, recruiter.adminId));
  assert.equal((await request(app).post("/api/signup-links").set("Cookie", recruiter.cookie).set(H).send({ factoryId: otherFac!.id })).status, 403);
  assert.equal((await request(app).post("/api/signup-links").set("Cookie", recruiter.cookie).set(H).send({ factoryId })).status, 200);

  const [office] = await db.insert(factoriesTable).values({ name: "Biuro", isOffice: true }).returning({ id: factoriesTable.id });
  await db.update(adminsTable).set({ scopeFactoryIds: [] }).where(eq(adminsTable.id, recruiter.adminId));
  assert.equal((await request(app).post("/api/signup-links").set("Cookie", recruiter.cookie).set(H).send({ factoryId: office!.id })).status, 400);
});

test("скоуп звузили після створення: лінк зникає зі списку, рядок — 404; деактивований адмін — лінк не резолвиться", opts, async () => {
  const { body: link } = await request(app).post("/api/signup-links").set("Cookie", recruiter.cookie).set(H).send({ factoryId });
  const [otherFac] = await db.insert(factoriesTable).values({ name: "Fabryka Inna" }).returning({ id: factoriesTable.id });
  await db.update(adminsTable).set({ scopeFactoryIds: [otherFac!.id] }).where(eq(adminsTable.id, recruiter.adminId));
  assert.equal((await request(app).get("/api/signup-links").set("Cookie", recruiter.cookie)).body.length, 0, "лінк поза поточним скоупом не показується");
  assert.equal((await request(app).get(`/api/signup-links/${link.id}/workers`).set("Cookie", recruiter.cookie)).status, 404);
  assert.equal((await request(app).post(`/api/signup-links/${link.id}/rotate`).set("Cookie", recruiter.cookie).set(H).send({})).status, 404);
  // owner бачить усе незалежно від скоупу рекрутера
  const owner = await seedAdmin({ role: "owner" });
  assert.equal((await request(app).get(`/api/signup-links/${link.id}/workers`).set("Cookie", owner.cookie)).status, 200);

  assert.ok(await resolveSignupLink(link.token));
  await db.update(adminsTable).set({ deactivatedAt: new Date() }).where(eq(adminsTable.id, recruiter.adminId));
  assert.equal(await resolveSignupLink(link.token), null, "лінк деактивованого адміна мертвий");
});
