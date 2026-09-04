// Кілька фабрик працівника + вісь «умова» через БД: CRUD worker_factories, перерахунок
// легальності, офісна посада → пакет без фабрики, дашборд повертає contract/contractBasis.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, workerLegalityTable, factoriesTable, positionsTable, contractsTable, contractFilesTable, documentTemplatesTable,
} from "../test/harness.ts";
import { seedLegalizationCatalog } from "../services/legalizationSeed.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); await seedLegalizationCatalog(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const H = { "X-Requested-With": "grafik" };

async function factory(name: string) { const [f] = await db.insert(factoriesTable).values({ name }).returning(); return f!; }
async function signedUmowa(workerId: number, factoryId: number | null, dateTo: string | null = null) {
  const [tpl] = await db.insert(documentTemplatesTable).values({ kind: "umowa", title: `Umowa ${factoryId ?? "biuro"}`, scope: "all", body: { pl: "<p>x</p>" } as any }).returning();
  const [c] = await db.insert(contractsTable).values({ workerId, factoryId, status: "signed", dateFrom: "2026-01-01", dateTo }).returning();
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

test("офісна посада: без фабрики не «unknown», умова = пакет без фабрики з umową; ознака посади перераховує людей", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [pos] = await db.insert(positionsTable).values({ name: "Biuro" }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Test Office", isActive: true, nationality: "poland", factoryId: null, positionId: pos!.id }).returning();
  await request(app).post(`/api/workers/${w!.id}/legality/recompute`).set("Cookie", owner.cookie).set(H);
  assert.equal((await lg(w!.id))?.contract, "unknown", "звичайна посада без фабрики — умову звірити ні з чим");

  const p = await request(app).patch(`/api/positions/${pos!.id}`).set("Cookie", owner.cookie).set(H).send({ isOffice: true });
  assert.equal(p.status, 200); assert.equal(p.body.isOffice, true);
  await new Promise(r => setTimeout(r, 300)); // перерахунок людей на посаді — fire-and-forget
  assert.equal((await lg(w!.id))?.contract, "illegal", "офіс без пакета BIURO — без умови");

  await signedUmowa(w!.id, null);
  await request(app).post(`/api/workers/${w!.id}/legality/recompute`).set("Cookie", owner.cookie).set(H);
  const l = await lg(w!.id);
  assert.equal(l?.contract, "legal"); assert.equal(l?.overall, "legal");
});
