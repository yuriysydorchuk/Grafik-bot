// Зголошення #20 і #23 (рішення власника 05.11.2026):
//  • активний профіль без жодної фабрики («нічий») видно кожному скоуп-адміну; призначити йому можна
//    лише фабрику зі свого скоупу (POST /workers/:id/assign-factory, право workerLifecycle);
//  • злиття дублів — editData або окреме право mergeWorkers, обидва профілі в скоупі;
//  • голий лінк у бот — лише editData; ролі без нього запрошують лінком «скан + анкета».
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, adminsTable, factoriesTable, workersTable, companiesTable, workerChangesTable } from "../test/harness.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function world(caps: string[]) {
  await seedAdmin({ role: "owner", isMain: true, name: "Main" });
  await seedRole("office_manager", caps, ["/workers"]);
  const [co] = await db.insert(companiesTable).values({ name: "ESO" }).returning();
  const [poz] = await db.insert(factoriesTable).values({ name: "POZ FAB", city: "Познань", companyId: co!.id }).returning();
  const [lodz] = await db.insert(factoriesTable).values({ name: "LDZ FAB", city: "Лодзь" }).returning();
  const [mine] = await db.insert(workersTable).values({ fullName: "Anna Poz", factoryId: poz!.id, isActive: true }).returning();
  const [foreign] = await db.insert(workersTable).values({ fullName: "Olek Lodz", factoryId: lodz!.id, isActive: true }).returning();
  const [orphan] = await db.insert(workersTable).values({ fullName: "Anna Poz Dubel", factoryId: null, isActive: true }).returning();
  const [firedOrphan] = await db.insert(workersTable).values({ fullName: "Stary Bez Fabryki", factoryId: null, isActive: false, status: "fired" } as any).returning();
  const om = await seedAdmin({ role: "office_manager", name: "OM Poznan" });
  await db.update(adminsTable).set({ scopeCities: ["Познань"] }).where(eq(adminsTable.id, om.adminId));
  return { om, co: co!, poz: poz!, lodz: lodz!, mine: mine!, foreign: foreign!, orphan: orphan!, firedOrphan: firedOrphan! };
}

test("«нічий» активний профіль видно скоуп-адміну; фабрику йому можна призначити лише зі свого скоупу", opts, async () => {
  const { om, co, poz, lodz, mine, foreign, orphan, firedOrphan } = await world(["viewWorkers", "workerLifecycle"]);
  const list = await request(app).get("/api/workers").set("Cookie", om.cookie);
  assert.deepEqual(list.body.map((w: any) => w.id).sort((a: number, b: number) => a - b), [mine.id, orphan.id].sort((a, b) => a - b), "свій + нічий; чужий і звільнений без фабрики — ні");
  assert.equal((await request(app).get(`/api/workers/${orphan.id}`).set("Cookie", om.cookie)).status, 200);
  assert.equal((await request(app).get(`/api/workers/${foreign.id}`).set("Cookie", om.cookie)).status, 403);
  assert.equal((await request(app).get(`/api/workers/${firedOrphan.id}`).set("Cookie", om.cookie)).status, 403);

  const assign = (id: number, factoryId: number) => request(app).post(`/api/workers/${id}/assign-factory`).set("Cookie", om.cookie).set(H).send({ factoryId });
  assert.equal((await assign(orphan.id, lodz.id)).status, 403, "чужа фабрика");
  assert.equal((await assign(mine.id, poz.id)).status, 400, "у людини вже є фабрика");
  const ok = await assign(orphan.id, poz.id);
  assert.equal(ok.status, 200, ok.text);
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, orphan.id));
  assert.deepEqual([w!.factoryId, w!.companyId], [poz.id, co.id], "фабрика + її фірма");
  const fields = (await db.select().from(workerChangesTable).where(eq(workerChangesTable.workerId, orphan.id))).map(j => j.field).sort();
  assert.deepEqual(fields, ["companyId", "factoryId"], "зміна в журналі");
});

test("злиття дублів: з правом mergeWorkers — так (обидва в скоупі), без нього — 403; голий лінк у бот — лише editData", opts, async () => {
  const { om, mine, foreign, orphan } = await world(["viewWorkers", "workerLifecycle", "mergeWorkers"]);
  const preview = (keep: number, drop: number) => request(app).get(`/api/workers/${keep}/merge-preview?dropId=${drop}`).set("Cookie", om.cookie);
  assert.equal((await preview(mine.id, orphan.id)).status, 200, "свій + нічий дубль");
  assert.equal((await preview(mine.id, foreign.id)).status, 403, "дубль поза скоупом");
  const merged = await request(app).post(`/api/workers/${mine.id}/merge`).set("Cookie", om.cookie).set(H).send({ dropId: orphan.id });
  assert.equal(merged.status, 200, merged.text);
  assert.equal((await db.select().from(workersTable).where(eq(workersTable.id, orphan.id))).length, 0, "дубль зник");

  // голий лінк привʼязки — лише з правом редагування; «скан + анкета» — доступний
  assert.equal((await request(app).get(`/api/workers/${mine.id}/invite`).set("Cookie", om.cookie)).status, 403);
  const docs = await request(app).post(`/api/workers/${mine.id}/docs-invite`).set("Cookie", om.cookie).set(H).send({});
  assert.equal(docs.status, 200, docs.text); assert.match(docs.body.link, /passport-scan/);
});

test("без права mergeWorkers злиття недоступне", opts, async () => {
  const { om, mine, orphan } = await world(["viewWorkers", "workerLifecycle"]);
  assert.equal((await request(app).get(`/api/workers/${mine.id}/merge-preview?dropId=${orphan.id}`).set("Cookie", om.cookie)).status, 403);
  assert.equal((await request(app).post(`/api/workers/${mine.id}/merge`).set("Cookie", om.cookie).set(H).send({ dropId: orphan.id })).status, 403);
});
