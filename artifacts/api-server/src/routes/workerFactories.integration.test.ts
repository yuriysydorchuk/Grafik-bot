// Кілька фабрик працівника + вісь «умова» через БД: CRUD worker_factories, перерахунок
// легальності, офісна посада → пакет без фабрики, дашборд повертає contract/contractBasis.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, workerLegalityTable, factoriesTable, companiesTable, contractsTable, contractFilesTable, documentTemplatesTable,
} from "../test/harness.ts";
import { seedLegalizationCatalog } from "../services/legalizationSeed.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); await seedLegalizationCatalog(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const H = { "X-Requested-With": "grafik" };

async function factory(name: string, extra: Partial<typeof factoriesTable.$inferInsert> = {}) { const [f] = await db.insert(factoriesTable).values({ name, ...extra }).returning(); return f!; }
async function signedUmowa(workerId: number, factoryId: number | null, dateTo: string | null = null, companyId: number | null = null) {
  const [tpl] = await db.insert(documentTemplatesTable).values({ kind: "umowa", title: `Umowa ${factoryId ?? "biuro"}`, scope: "all", body: { pl: "<p>x</p>" } as any }).returning();
  const [c] = await db.insert(contractsTable).values({ workerId, factoryId, companyId, status: "signed", dateFrom: "2026-01-01", dateTo }).returning();
  await db.insert(contractFilesTable).values({ contractId: c!.id, templateId: tpl!.id, title: tpl!.title, sortOrder: 1 });
  return c!;
}
const lg = async (workerId: number) => (await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, workerId)))[0];

test("умова на основну фабрику → contract legal; додаткова фабрика без умови → illegal з назвою; прибрали → знову legal", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const agram = await factory("AGRAM"); const sushi = await factory("SUSHI");
  const [w] = await db.insert(workersTable).values({ fullName: "Test Multi", isActive: true, nationality: "poland", factoryId: agram.id }).returning();
  await signedUmowa(w!.id, agram.id);
  await request(app).post(`/api/workers/${w!.id}/legality/recompute`).set("Cookie", owner.cookie).set(H);
  let l = await lg(w!.id);
  assert.equal(l?.contract, "legal"); assert.equal(l?.overall, "legal");

  const add = await request(app).post(`/api/workers/${w!.id}/factories`).set("Cookie", owner.cookie).set(H).send({ factoryId: sushi.id });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal((await request(app).post(`/api/workers/${w!.id}/factories`).set("Cookie", owner.cookie).set(H).send({ factoryId: agram.id })).status, 400, "основну фабрику додавати не можна");
  l = await lg(w!.id);
  assert.equal(l?.contract, "illegal"); assert.equal(l?.overall, "illegal");
  const reason = (l?.reasons ?? []).find(r => r.code === "contract_missing");
  assert.equal(reason?.params?.factory, "SUSHI");

  const list = await request(app).get(`/api/workers/${w!.id}/factories`).set("Cookie", owner.cookie);
  assert.equal(list.body.length, 1); assert.equal(list.body[0].factoryName, "SUSHI");
  const dash = await request(app).get("/api/legalization").set("Cookie", owner.cookie);
  const row = dash.body.rows.find((r: any) => r.id === w!.id);
  assert.equal(row.legality.contract, "illegal"); assert.equal(row.contractBasis?.label, "Umowa — AGRAM", "підстава основної фабрики є, бракує SUSHI");

  await signedUmowa(w!.id, sushi.id);
  await request(app).post(`/api/workers/${w!.id}/legality/recompute`).set("Cookie", owner.cookie).set(H);
  l = await lg(w!.id); assert.equal(l?.contract, "legal");
  const row2 = (await request(app).get("/api/legalization").set("Cookie", owner.cookie)).body.rows.find((r: any) => r.id === w!.id);
  assert.equal(row2.contractBasis.label, "Umowa — AGRAM");

  // дата «до» додаткової фабрики в минулому → умова на неї не потрібна
  await request(app).patch(`/api/worker-factories/${add.body.id}`).set("Cookie", owner.cookie).set(H).send({ validTo: "2026-01-31" });
  await db.delete(contractsTable).where(eq(contractsTable.factoryId, sushi.id));
  await request(app).post(`/api/workers/${w!.id}/legality/recompute`).set("Cookie", owner.cookie).set(H);
  assert.equal((await lg(w!.id))?.contract, "legal");
  assert.equal((await request(app).delete(`/api/worker-factories/${add.body.id}`).set("Cookie", owner.cookie).set(H)).status, 200);
});

test("без фабрики → червоне no_factory; офіс = фабрика Biuro (is_office) — умова на неї як на будь-яку", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [w] = await db.insert(workersTable).values({ fullName: "Test Office", isActive: true, nationality: "poland", factoryId: null }).returning();
  await request(app).post(`/api/workers/${w!.id}/legality/recompute`).set("Cookie", owner.cookie).set(H);
  let l = await lg(w!.id);
  assert.equal(l?.contract, "illegal"); assert.equal(l?.overall, "illegal");
  assert.ok((l?.reasons ?? []).some(r => r.code === "no_factory"));

  const biuro = await factory("Biuro", { isOffice: true });
  const f = await request(app).patch(`/api/factories/${biuro.id}`).set("Cookie", owner.cookie).set(H).send({ isOffice: true });
  assert.equal(f.status, 200); assert.equal(f.body.isOffice, true);
  await request(app).patch(`/api/workers/${w!.id}`).set("Cookie", owner.cookie).set(H).send({ factoryId: biuro.id });
  await request(app).post(`/api/workers/${w!.id}/legality/recompute`).set("Cookie", owner.cookie).set(H);
  assert.equal((await lg(w!.id))?.contract, "illegal", "офіс без пакета на Biuro — без умови");

  await signedUmowa(w!.id, biuro.id);
  await request(app).post(`/api/workers/${w!.id}/legality/recompute`).set("Cookie", owner.cookie).set(H);
  l = await lg(w!.id);
  assert.equal(l?.contract, "legal"); assert.equal(l?.overall, "legal");
});

test("роботодавці: мультифірмова фабрика вимагає фірму; умова від іншої фірми → contract_wrong_company; UA без powiadomienia на другу фірму → work illegal", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [es, eso] = await db.insert(companiesTable).values([{ name: "ES" }, { name: "ESO" }]).returning();
  const agram = await factory("AGRAM", { companyId: es!.id }); const sushi = await factory("SUSHI", { companyId: es!.id, multiFirm: true });
  const [w] = await db.insert(workersTable).values({ fullName: "Test Firms", isActive: true, nationality: "poland", companyId: es!.id, factoryId: agram.id }).returning();
  await signedUmowa(w!.id, agram.id, null, es!.id);
  assert.equal((await request(app).post(`/api/workers/${w!.id}/factories`).set("Cookie", owner.cookie).set(H).send({ factoryId: sushi.id })).status, 400, "мультифірмова без фірми");
  const add = await request(app).post(`/api/workers/${w!.id}/factories`).set("Cookie", owner.cookie).set(H).send({ factoryId: sushi.id, companyId: eso!.id });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const list = await request(app).get(`/api/workers/${w!.id}/factories`).set("Cookie", owner.cookie);
  assert.equal(list.body[0].companyName, "ESO");
  let l = await lg(w!.id);
  assert.equal((l?.reasons ?? []).find(r => r.code === "contract_missing")?.params?.factory, "SUSHI");
  // умова на SUSHI, але від ES → не та фірма
  const wrong = await signedUmowa(w!.id, sushi.id, null, es!.id);
  await request(app).post(`/api/workers/${w!.id}/legality/recompute`).set("Cookie", owner.cookie).set(H);
  l = await lg(w!.id);
  assert.equal(l?.contract, "illegal"); assert.equal((l?.reasons ?? []).find(r => r.code === "contract_wrong_company")?.params?.company, "ESO");
  await db.delete(contractsTable).where(eq(contractsTable.id, wrong.id));
  await signedUmowa(w!.id, sushi.id, null, eso!.id);
  await request(app).post(`/api/workers/${w!.id}/legality/recompute`).set("Cookie", owner.cookie).set(H);
  l = await lg(w!.id);
  assert.equal(l?.contract, "legal"); assert.equal(l?.overall, "legal", "PL-громадянин — підстава праці незалежна від роботодавця");
});
