import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, adminsTable, factoriesTable, workersTable, svodniRowsTable, advanceRequestsTable, contractsTable } from "../test/harness.ts";
import { workerFactoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Роль «Офіс-менеджер» (01.10.2026): скоуп міст/фабрик на адміні («заборонено, поки не
// дозволено»), зарплата по фабриках у профілі, делеговані запрошення.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const OM_CAPS = ["viewWorkers", "workerDocs", "legalization", "workerPay"];

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function world() {
  const main = await seedAdmin({ role: "owner", isMain: true, name: "Main" });
  await seedRole("office_manager", OM_CAPS, ["/workers", "/legalization"]);
  const [poz] = await db.insert(factoriesTable).values({ name: "POZ FAB", city: "Познань" }).returning();
  const [lodz] = await db.insert(factoriesTable).values({ name: "LDZ FAB", city: "Лодзь" }).returning();
  const [wPoz] = await db.insert(workersTable).values({ fullName: "Anna Poz", factoryId: poz!.id }).returning();
  const [wLodz] = await db.insert(workersTable).values({ fullName: "Olek Lodz", factoryId: lodz!.id }).returning();
  const om = await seedAdmin({ role: "office_manager", name: "OM Poznan" });
  await db.update(adminsTable).set({ scopeCities: ["Познань"] }).where(eq(adminsTable.id, om.adminId));
  return { main, om, poz: poz!, lodz: lodz!, wPoz: wPoz!, wLodz: wLodz! };
}

test("скоуп: список працівників і фабрик — лише свого міста", opts, async () => {
  const { om, wPoz, poz } = await world();
  const ws = await request(app).get("/api/workers").set("Cookie", om.cookie);
  assert.equal(ws.status, 200);
  assert.deepEqual(ws.body.map((w: any) => w.id), [wPoz.id]);
  const fs = await request(app).get("/api/factories").set("Cookie", om.cookie);
  assert.deepEqual(fs.body.map((f: any) => f.id), [poz.id]);
});

test("скоуп: профіль працівника іншого міста — 403, свого — 200", opts, async () => {
  const { om, wPoz, wLodz } = await world();
  assert.equal((await request(app).get(`/api/workers/${wPoz.id}`).set("Cookie", om.cookie)).status, 200);
  assert.equal((await request(app).get(`/api/workers/${wLodz.id}`).set("Cookie", om.cookie)).status, 403);
  assert.equal((await request(app).get(`/api/workers/${wLodz.id}/documents`).set("Cookie", om.cookie)).status, 403);
});

test("скоуп: ендпойнт поза білим списком — 403 навіть за наявного cap (заборонено, поки не дозволено)", opts, async () => {
  const { om } = await world();
  assert.equal((await request(app).post("/api/legalization/recompute-all").set("Cookie", om.cookie).set(H)).status, 403);
  assert.equal((await request(app).get("/api/legal-rules").set("Cookie", om.cookie)).status, 403);
});

test("скоуп: привʼязати працівника до фабрики поза скоупом — 403", opts, async () => {
  const { om, wPoz, lodz } = await world();
  const r = await request(app).post(`/api/workers/${wPoz.id}/factories`).set("Cookie", om.cookie).set(H).send({ factoryId: lodz.id });
  assert.equal(r.status, 403);
});

test("скоуп: лінк скану нового кандидата вимагає фабрику зі скоупу", opts, async () => {
  const { om, poz, lodz } = await world();
  assert.equal((await request(app).post("/api/workers/scan-invite").set("Cookie", om.cookie).set(H).send({})).status, 403);
  assert.equal((await request(app).post("/api/workers/scan-invite").set("Cookie", om.cookie).set(H).send({ factoryId: lodz.id })).status, 403);
  const ok = await request(app).post("/api/workers/scan-invite").set("Cookie", om.cookie).set(H).send({ factoryId: poz.id });
  assert.equal(ok.status, 200);
  assert.match(ok.body.link, /passport-scan/);
});

test("зарплата: розбивка сходиться з doWyplaty, рядки іншого міста приховані, без konto/готівки", opts, async () => {
  const { om, wPoz, poz, lodz } = await world();
  await db.insert(svodniRowsTable).values([
    { periodMonth: "2026-08", city: "Познань", factoryLabel: "POZ FAB", factoryId: poz.id, rawName: "Anna Poz", workerId: wPoz.id, linkStatus: "confirmed",
      hours: 100, rateNetto: 25, premia: 200, zaliczka: 300, kara: 50, doWyplaty: 2350, konto: 2000, gotowka: 350, extras: {} },
    { periodMonth: "2026-08", city: "Лодзь", factoryLabel: "LDZ FAB", factoryId: lodz.id, rawName: "Anna Poz", workerId: wPoz.id, linkStatus: "confirmed",
      hours: 10, rateNetto: 25, doWyplaty: 250, extras: {} },
  ]);
  await db.insert(advanceRequestsTable).values({ workerId: wPoz.id, factoryId: poz.id, amount: 300, status: "paid", svodniMonth: "2026-08" });
  const r = await request(app).get(`/api/workers/${wPoz.id}/pay`).set("Cookie", om.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.rows.length, 1);
  const row = r.body.rows[0];
  assert.equal(row.base, 2500);
  assert.equal(row.adjust, null); // 2500 + 200 − 300 − 50 = 2350
  assert.equal(row.doWyplaty, 2350);
  assert.equal("konto" in row || "gotowka" in row, false);
  assert.equal(r.body.details.zaliczka.length, 1);
});

test("зарплата: без svodni/workerPay — 403", opts, async () => {
  const { wPoz } = await world();
  await seedRole("viewer", ["viewWorkers"], ["/workers"]);
  const v = await seedAdmin({ role: "viewer", name: "Viewer" });
  assert.equal((await request(app).get(`/api/workers/${wPoz.id}/pay`).set("Cookie", v.cookie)).status, 403);
});

test("запрошення: делегат запрошує лише на дозволену роль і в межах свого скоупу", opts, async () => {
  const { main, om, poz, lodz } = await world();
  // без права — 403
  assert.equal((await request(app).post("/api/admin-invites").set("Cookie", om.cookie).set(H).send({ name: "X", role: "office_manager", scopeCities: ["Познань"] })).status, 403);
  // головний видає право
  const p = await request(app).patch(`/api/admins/${om.adminId}`).set("Cookie", main.cookie).set(H).send({ canInviteRoles: ["office_manager"] });
  assert.equal(p.status, 200);
  // не можна делегувати owner
  assert.equal((await request(app).patch(`/api/admins/${om.adminId}`).set("Cookie", main.cookie).set(H).send({ canInviteRoles: ["owner"] })).status, 400);

  const owner = await request(app).post("/api/admin-invites").set("Cookie", om.cookie).set(H).send({ name: "X", role: "owner", scopeCities: ["Познань"] });
  assert.equal(owner.status, 403);
  const noScope = await request(app).post("/api/admin-invites").set("Cookie", om.cookie).set(H).send({ name: "X", role: "office_manager" });
  assert.equal(noScope.status, 400); // порожній скоуп = «усе» — ескалація
  const foreign = await request(app).post("/api/admin-invites").set("Cookie", om.cookie).set(H).send({ name: "X", role: "office_manager", scopeFactoryIds: [lodz.id] });
  assert.equal(foreign.status, 403);
  const ok = await request(app).post("/api/admin-invites").set("Cookie", om.cookie).set(H).send({ name: "New OM", role: "office_manager", scopeFactoryIds: [poz.id] });
  assert.equal(ok.status, 200);
  assert.match(ok.body.inviteLink, /start=adm/);
  const [created] = await db.select().from(adminsTable).where(eq(adminsTable.id, ok.body.id));
  assert.equal(created!.invitedBy, om.adminId);

  const list = await request(app).get("/api/admin-invites").set("Cookie", om.cookie);
  assert.deepEqual(list.body.invites.map((i: any) => i.id), [ok.body.id]);
  // головний список адмінів делегату недоступний
  assert.equal((await request(app).get("/api/admins").set("Cookie", om.cookie)).status, 403);
});

test("головний адмін ніколи не скоупиться (захист від самоблокування)", opts, async () => {
  const { main, wLodz } = await world();
  await db.update(adminsTable).set({ scopeCities: ["Познань"] }).where(eq(adminsTable.id, main.adminId));
  assert.equal((await request(app).get(`/api/workers/${wLodz.id}`).set("Cookie", main.cookie)).status, 200);
});

// Ревʼю codex 01.10.2026: працівник у двох містах — дані чужої фабрики не протікають
test("скоуп: людина у двох містах — аванси/сводна чужої фабрики приховані, її привʼязку/умову не змінити", opts, async () => {
  const { om, wPoz, lodz, poz } = await world();
  await db.insert(advanceRequestsTable).values([
    { workerId: wPoz.id, factoryId: poz.id, amount: 100, status: "paid" },
    { workerId: wPoz.id, factoryId: lodz.id, amount: 999, status: "paid" },
  ]);
  const adv = await request(app).get(`/api/workers/${wPoz.id}/advances`).set("Cookie", om.cookie);
  assert.equal(adv.status, 200);
  assert.deepEqual(adv.body.rows.map((r: any) => r.amount), [100]);

  const [wf] = await db.insert(workerFactoriesTable).values({ workerId: wPoz.id, factoryId: lodz.id }).returning();
  assert.equal((await request(app).delete(`/api/worker-factories/${wf!.id}`).set("Cookie", om.cookie).set(H)).status, 403);
  const [c] = await db.insert(contractsTable).values({ workerId: wPoz.id, factoryId: lodz.id, status: "approved" } as any).returning();
  assert.equal((await request(app).get(`/api/contracts/${c!.id}`).set("Cookie", om.cookie)).status, 403);
});

test("скоуп: імпорт підписаної умови (multipart) на фабрику поза скоупом — 403", opts, async () => {
  const { om, wPoz, lodz } = await world();
  const r = await request(app).post(`/api/workers/${wPoz.id}/contracts/import`).set("Cookie", om.cookie).set(H)
    .field("factoryId", String(lodz.id)).field("dateFrom", "2026-09-01")
    .attach("file", Buffer.from("%PDF-1.4\n%%EOF"), { filename: "u.pdf", contentType: "application/pdf" });
  assert.equal(r.status, 403);
});
