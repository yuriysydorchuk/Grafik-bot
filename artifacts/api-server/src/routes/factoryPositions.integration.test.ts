// Посади всередині фабрики (зголошення #12, 03.11.2026): GET/PUT/DELETE /factories/:id/positions[/:positionId];
// видалення посади з каталогу, що стоїть на фабриці, — 400 (раніше 500 через FK); фільтр задач за кількома
// джерелами через кому (#13).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, seedRole, db, workersTable, factoriesTable, positionsTable, factoryPositionsTable, tasksTable } from "../test/harness.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" };
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("посади фабрики: додати вмикає «розрізняти посади»; поля рядка; ставки без права ігноруються; прибрати зайняту — 400", opts, async () => {
  const owner = await seedAdmin({ role: "owner", isMain: true });
  await seedRole("grafik", ["editData"], ["/settings"]);
  const g = await seedAdmin({ role: "grafik" });
  const [f] = await db.insert(factoriesTable).values({ name: "SUSHI", usesPositions: false } as any).returning();
  const [p] = await db.insert(positionsTable).values({ name: "Skoczek", color: "amber" } as any).returning();
  const put = (cookie: string, body: object) => request(app).put(`/api/factories/${f!.id}/positions/${p!.id}`).set("Cookie", cookie).set(H).send(body);

  assert.equal((await put(owner.cookie, {})).status, 200);
  const [fac] = await db.select().from(factoriesTable).where(eq(factoriesTable.id, f!.id));
  assert.equal(fac!.usesPositions, true, "перша посада вмикає usesPositions");

  const r1 = await put(owner.cookie, { rate: "31.5", contractDuties: "Pakowanie", uaStanowisko: "Pracownik produkcji", kzisCode: "932990" });
  assert.equal(r1.status, 200, r1.text);
  assert.equal((await put(owner.cookie, { kzisCode: "12" })).status, 400, "KZiS — 6 цифр");
  // код мусить бути з довідника KZiS (зголошення #26); довідник віддається пікеру
  const bad = await put(owner.cookie, { kzisCode: "999999" });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /немає в класифікації/);
  const ref = await request(app).get("/api/reference/kzis").set("Cookie", owner.cookie);
  assert.equal(ref.status, 200); assert.ok(ref.body.codes.length > 2900);
  assert.ok(ref.body.codes.some((c: [string, string]) => c[0] === "932990" && /Pozostali robotnicy/.test(c[1])));
  // без viewFinance/factoryRates ставки мовчки ігноруються, решта полів пишеться
  assert.equal((await put(g.cookie, { rate: "99", contractDuties: "Sortowanie" })).status, 200);
  const [row] = await db.select().from(factoryPositionsTable).where(eq(factoryPositionsTable.factoryId, f!.id));
  assert.equal(row!.rate, 31.5); assert.equal(row!.contractDuties, "Sortowanie"); assert.equal(row!.kzisCode, "932990");

  const listOwner = await request(app).get(`/api/factories/${f!.id}/positions`).set("Cookie", owner.cookie);
  assert.equal(listOwner.status, 200); assert.equal(listOwner.body[0].rate, 31.5); assert.equal(listOwner.body[0].name, "Skoczek");
  const listG = await request(app).get(`/api/factories/${f!.id}/positions`).set("Cookie", g.cookie);
  assert.equal(listG.status, 200); assert.equal("rate" in listG.body[0], false, "ставки без права не віддаються");

  // каталог: посаду на фабриці не видалити (400, а не 500)
  const delCat = await request(app).delete(`/api/positions/${p!.id}`).set("Cookie", owner.cookie).set(H);
  assert.equal(delCat.status, 400, delCat.text); assert.match(delCat.body.error, /SUSHI/);

  // прибрати з фабрики: активний працівник на посаді — 400; без нього — ок
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowal", factoryId: f!.id, positionId: p!.id, isActive: true } as any).returning();
  assert.equal((await request(app).delete(`/api/factories/${f!.id}/positions/${p!.id}`).set("Cookie", owner.cookie).set(H)).status, 400);
  await db.update(workersTable).set({ isActive: false }).where(eq(workersTable.id, w!.id));
  // людина з цією посадою на фабриці як на ДОДАТКОВІЙ (worker_factories) — теж зайнято
  const [f2] = await db.insert(factoriesTable).values({ name: "LST" } as any).returning();
  const [w2] = await db.insert(workersTable).values({ fullName: "Ola Nowak", factoryId: f2!.id, positionId: p!.id, isActive: true } as any).returning();
  await db.execute(sql`insert into worker_factories (worker_id, factory_id) values (${w2!.id}, ${f!.id})`);
  assert.equal((await request(app).delete(`/api/factories/${f!.id}/positions/${p!.id}`).set("Cookie", owner.cookie).set(H)).status, 400, "додаткова фабрика");
  await db.execute(sql`update worker_factories set valid_to = current_date - 1 where worker_id = ${w2!.id}`);
  assert.equal((await request(app).delete(`/api/factories/${f!.id}/positions/${p!.id}`).set("Cookie", owner.cookie).set(H)).status, 200);
  assert.equal((await db.select().from(factoryPositionsTable).where(eq(factoryPositionsTable.factoryId, f!.id))).length, 0);
});

test("задачі: фільтр source — кілька джерел через кому", opts, async () => {
  const owner = await seedAdmin({ role: "owner", isMain: true });
  const mk = (title: string, source: string) => ({ kind: "task", title, status: "open", priority: "normal", source, assigneeAdminId: owner.adminId, createdBy: owner.adminId } as any);
  await db.insert(tasksTable).values([mk("ZUA", "auto:hire_zus"), mk("ZWUA", "auto:termination_zus"), mk("Doc", "auto:doc_expiring"), mk("Ручна", "manual")]);
  const titles = async (src: string) => (await request(app).get(`/api/tasks?scope=all&source=${encodeURIComponent(src)}`).set("Cookie", owner.cookie)).body.map((x: any) => x.title).sort();
  assert.deepEqual(await titles("hire_zus,termination_zus"), ["ZUA", "ZWUA"]);
  assert.deepEqual(await titles("hire_zus"), ["ZUA"]);
  assert.deepEqual(await titles("bad source!"), []);
});
