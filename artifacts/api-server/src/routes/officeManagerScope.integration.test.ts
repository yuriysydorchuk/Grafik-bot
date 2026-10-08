import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, adminsTable, factoriesTable, workersTable, svodniRowsTable, advanceRequestsTable, contractsTable, rolesTable } from "../test/harness.ts";
import { workerFactoriesTable, tasksTable } from "@workspace/db";
import { invalidateRolesCache } from "../lib/auth";
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

// ── 08.10.2026: задачі, календар працівників, залічки, запрошення/звільнення ──
const OM2_CAPS = [...OM_CAPS, "workerLifecycle", "advances"];
const OM2_PAGES = ["/workers", "/legalization", "/tasks", "/workers-calendar", "/advances"];

async function world2() {
  const main = await seedAdmin({ role: "owner", isMain: true, name: "Main" });
  await seedRole("office_manager", OM2_CAPS, OM2_PAGES);
  const [poz] = await db.insert(factoriesTable).values({ name: "POZ FAB", city: "Познань" }).returning();
  const [lodz] = await db.insert(factoriesTable).values({ name: "LDZ FAB", city: "Лодзь" }).returning();
  const [wPoz] = await db.insert(workersTable).values({ fullName: "Anna Poz", factoryId: poz!.id }).returning();
  const [wLodz] = await db.insert(workersTable).values({ fullName: "Olek Lodz", factoryId: lodz!.id }).returning();
  const om = await seedAdmin({ role: "office_manager", name: "OM Poznan" });
  await db.update(adminsTable).set({ scopeCities: ["Познань"] }).where(eq(adminsTable.id, om.adminId));
  return { main, om, poz: poz!, lodz: lodz!, wPoz: wPoz!, wLodz: wLodz! };
}

test("залічки: список лише свого міста, нова — лише для людини зі скоупу, чужий рядок — 403", opts, async () => {
  const { om, wPoz, wLodz, poz, lodz } = await world2();
  const [aPoz] = await db.insert(advanceRequestsTable).values({ workerId: wPoz.id, factoryId: poz.id, amount: 100, status: "approved" }).returning();
  const [aLodz] = await db.insert(advanceRequestsTable).values({ workerId: wLodz.id, factoryId: lodz.id, amount: 200, status: "approved" }).returning();
  const list = await request(app).get("/api/advances").set("Cookie", om.cookie);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((r: any) => r.id), [aPoz!.id]);
  assert.equal((await request(app).post("/api/advances").set("Cookie", om.cookie).set(H).send({ workerId: wLodz.id, amount: 50 })).status, 403);
  const created = await request(app).post("/api/advances").set("Cookie", om.cookie).set(H).send({ workerId: wPoz.id, amount: 50 });
  assert.equal(created.status, 200);
  assert.equal(created.body.status, "approved");
  assert.equal((await request(app).post(`/api/advances/${aLodz!.id}/paid`).set("Cookie", om.cookie).set(H).send({ method: "cash" })).status, 403);
  assert.equal((await request(app).post(`/api/advances/${aPoz!.id}/paid`).set("Cookie", om.cookie).set(H).send({ method: "cash" })).status, 200);
  // вкладки для editData — поза скоупом
  assert.equal((await request(app).get("/api/badania/pending").set("Cookie", om.cookie)).status, 403);
});

test("задачі: бачу свої й про людей/фабрики скоупу; чужа — 403; нова про чужу людину — 403", opts, async () => {
  const { main, om, wPoz, wLodz, poz, lodz } = await world2();
  const [tMine] = await db.insert(tasksTable).values({ title: "моя", kind: "task", status: "open", source: "manual", assigneeAdminId: om.adminId, creatorAdminId: main.adminId, checklist: [] }).returning();
  const [tPoz] = await db.insert(tasksTable).values({ title: "про Anna", kind: "task", status: "open", source: "manual", assigneeAdminId: main.adminId, creatorAdminId: main.adminId, workerId: wPoz.id, checklist: [] }).returning();
  const [tFac] = await db.insert(tasksTable).values({ title: "по POZ", kind: "task", status: "open", source: "manual", assigneeAdminId: main.adminId, creatorAdminId: main.adminId, factoryId: poz.id, checklist: [] }).returning();
  const [tLodz] = await db.insert(tasksTable).values({ title: "про Olek", kind: "task", status: "open", source: "manual", assigneeAdminId: main.adminId, creatorAdminId: main.adminId, workerId: wLodz.id, factoryId: lodz.id, checklist: [] }).returning();
  const [tNone] = await db.insert(tasksTable).values({ title: "чужа без привʼязки", kind: "task", status: "open", source: "manual", assigneeAdminId: main.adminId, creatorAdminId: main.adminId, checklist: [] }).returning();
  const all = await request(app).get("/api/tasks?scope=all").set("Cookie", om.cookie);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.map((t: any) => t.id).sort(), [tMine!.id, tPoz!.id, tFac!.id].sort());
  const cal = await request(app).get("/api/tasks/calendar?from=2020-01-01&to=2099-12-31&scope=team").set("Cookie", om.cookie);
  assert.equal(cal.status, 200);
  assert.ok(!cal.body.some((t: any) => t.id === tLodz!.id || t.id === tNone!.id));
  assert.equal((await request(app).get(`/api/tasks/${tPoz!.id}`).set("Cookie", om.cookie)).status, 200);
  assert.equal((await request(app).get(`/api/tasks/${tLodz!.id}`).set("Cookie", om.cookie)).status, 403);
  assert.equal((await request(app).get(`/api/tasks/${tNone!.id}`).set("Cookie", om.cookie)).status, 403);
  assert.equal((await request(app).post("/api/tasks/bulk").set("Cookie", om.cookie).set(H).send({ ids: [tMine!.id, tLodz!.id], action: "plan_today" })).status, 403);
  assert.equal((await request(app).post("/api/tasks").set("Cookie", om.cookie).set(H).send({ title: "x", workerId: wLodz.id })).status, 403);
  const ok = await request(app).post("/api/tasks").set("Cookie", om.cookie).set(H).send({ title: "подзвонити Anna", workerId: wPoz.id });
  assert.equal(ok.status, 200);
  // керування правилами/контроль — поза скоупом
  assert.equal((await request(app).get("/api/tasks/control").set("Cookie", om.cookie)).status, 403);
  assert.equal((await request(app).get("/api/task-auto-rules").set("Cookie", om.cookie)).status, 403);
});

test("ревʼю codex 08.10: людина з двох міст — залічка чужої фабрики прихована/недоступна, нова без фабрики — лише в скоуп; скасувати чуже виповідзення — 403; звільнені чужого міста не в календарі", opts, async () => {
  const { om, wLodz, poz, lodz } = await world2();
  // основна LDZ (поза скоупом), додаткова POZ → людина в скоупі, але її залічки LDZ — ні
  const [wBoth] = await db.insert(workersTable).values({ fullName: "Both Cities", factoryId: lodz.id }).returning();
  await db.insert(workerFactoriesTable).values({ workerId: wBoth!.id, factoryId: poz.id });
  const [aPoz] = await db.insert(advanceRequestsTable).values({ workerId: wBoth!.id, factoryId: poz.id, amount: 100, status: "approved" }).returning();
  const [aLodz] = await db.insert(advanceRequestsTable).values({ workerId: wBoth!.id, factoryId: lodz.id, amount: 200, status: "approved" }).returning();
  const [aNoFac] = await db.insert(advanceRequestsTable).values({ workerId: wBoth!.id, amount: 300, status: "approved" }).returning(); // без фабрики → профіль LDZ
  const list = await request(app).get("/api/advances").set("Cookie", om.cookie);
  assert.deepEqual(list.body.map((r: any) => r.id), [aPoz!.id]);
  assert.equal((await request(app).patch(`/api/advances/${aLodz!.id}`).set("Cookie", om.cookie).set(H).send({ payoutMonth: "2026-10", payoutGroup: "15" })).status, 403);
  assert.equal((await request(app).post(`/api/advances/${aNoFac!.id}/paid`).set("Cookie", om.cookie).set(H).send({ method: "cash" })).status, 403);
  assert.equal((await request(app).post(`/api/advances/${aPoz!.id}/paid`).set("Cookie", om.cookie).set(H).send({ method: "cash" })).status, 200);
  // нова залічка без фабрики підставила б профільну LDZ → 403; з POZ — ок
  assert.equal((await request(app).post("/api/advances").set("Cookie", om.cookie).set(H).send({ workerId: wBoth!.id, amount: 50 })).status, 403);
  assert.equal((await request(app).post("/api/advances").set("Cookie", om.cookie).set(H).send({ workerId: wBoth!.id, amount: 50, factoryId: poz.id })).status, 200);
  // виповідзення по LDZ поставив хтось інший — скасувати не можна; «з усіх» теж ні (є чужа фабрика)
  await db.update(workersTable).set({ terminationDate: "2030-01-01", terminationFactoryId: lodz.id }).where(eq(workersTable.id, wBoth!.id));
  assert.equal((await request(app).post(`/api/workers/${wBoth!.id}/termination`).set("Cookie", om.cookie).set(H).send({ date: null })).status, 403);
  // ...і перезаписати своїм по POZ теж не можна (ревʼю codex №2)
  assert.equal((await request(app).post(`/api/workers/${wBoth!.id}/termination`).set("Cookie", om.cookie).set(H).send({ date: "2030-02-01", factoryId: poz.id })).status, 403);
  await db.update(workersTable).set({ terminationDate: "2030-01-01", terminationFactoryId: null }).where(eq(workersTable.id, wBoth!.id));
  assert.equal((await request(app).post(`/api/workers/${wBoth!.id}/termination`).set("Cookie", om.cookie).set(H).send({ date: null })).status, 403);
  // своє по POZ — можна поставити й скасувати (після зняття чужого)
  await db.update(workersTable).set({ terminationDate: null, terminationFactoryId: null }).where(eq(workersTable.id, wBoth!.id));
  assert.equal((await request(app).post(`/api/workers/${wBoth!.id}/termination`).set("Cookie", om.cookie).set(H).send({ date: "2030-02-01", factoryId: poz.id })).status, 200);
  assert.equal((await request(app).post(`/api/workers/${wBoth!.id}/termination`).set("Cookie", om.cookie).set(H).send({ date: null })).status, 200);
  // звільнений у чужому місті — не в календарі (гілка end), чужа умова людини з двох міст — теж
  await db.update(workersTable).set({ isActive: false, firedAt: new Date("2026-06-10T10:00:00Z") }).where(eq(workersTable.id, wLodz.id));
  await db.insert(contractsTable).values({ workerId: wBoth!.id, factoryId: lodz.id, status: "signed", dateFrom: "2026-01-01", dateTo: "2026-06-20" } as any);
  await db.insert(contractsTable).values({ workerId: wBoth!.id, factoryId: poz.id, status: "signed", dateFrom: "2026-01-01", dateTo: "2026-06-25" } as any);
  const cal = await request(app).get("/api/workers-calendar?from=2026-06-01&to=2026-06-30&kinds=end,contract").set("Cookie", om.cookie);
  assert.equal(cal.status, 200);
  assert.ok(!cal.body.events.some((e: any) => e.workerId === wLodz.id), "звільнений чужого міста витік");
  const both = cal.body.events.filter((e: any) => e.workerId === wBoth!.id && e.kind === "contract");
  assert.ok(both.length >= 1 && both.every((e: any) => e.factoryId === poz.id), "умова чужої фабрики витекла");
});

test("календар працівників: лише люди свого міста; фабрика поза скоупом у фільтрі — 403", opts, async () => {
  const { om, wPoz, wLodz, lodz } = await world2();
  await db.update(workersTable).set({ birthDate: "1990-06-15" }).where(eq(workersTable.id, wPoz.id));
  await db.update(workersTable).set({ birthDate: "1990-06-20" }).where(eq(workersTable.id, wLodz.id));
  const r = await request(app).get("/api/workers-calendar?from=2026-06-01&to=2026-06-30&kinds=birthday").set("Cookie", om.cookie);
  assert.equal(r.status, 200);
  const ids = new Set(r.body.events.map((e: any) => e.workerId));
  assert.ok(ids.has(wPoz.id) && !ids.has(wLodz.id));
  assert.equal((await request(app).get(`/api/workers-calendar?from=2026-06-01&to=2026-06-30&factoryId=${lodz.id}`).set("Cookie", om.cookie)).status, 403);
});

test("запросити/звільнити: лінк і звільнення для своєї людини; людину з чинною фабрикою поза скоупом — лише по фабриці", opts, async () => {
  const { om, wPoz, wLodz, poz, lodz } = await world2();
  const inv = await request(app).get(`/api/workers/${wPoz.id}/invite`).set("Cookie", om.cookie);
  assert.equal(inv.status, 200);
  assert.ok(inv.body.link);
  assert.equal((await request(app).get(`/api/workers/${wLodz.id}/invite`).set("Cookie", om.cookie)).status, 403);
  // людина у двох містах: основна POZ + додаткова LDZ (чинна) → «з усіх» заборонено, по фабриці POZ — можна
  const [wBoth] = await db.insert(workersTable).values({ fullName: "Both Cities", factoryId: poz.id }).returning();
  await db.insert(workerFactoriesTable).values({ workerId: wBoth!.id, factoryId: lodz.id });
  assert.equal((await request(app).post(`/api/workers/${wBoth!.id}/fire`).set("Cookie", om.cookie).set(H).send({})).status, 403);
  assert.equal((await request(app).post(`/api/workers/${wBoth!.id}/termination`).set("Cookie", om.cookie).set(H).send({ date: "2030-01-01" })).status, 403);
  assert.equal((await request(app).post(`/api/workers/${wBoth!.id}/termination`).set("Cookie", om.cookie).set(H).send({ date: "2030-01-01", factoryId: poz.id })).status, 200);
  const fired = await request(app).post(`/api/workers/${wPoz.id}/fire`).set("Cookie", om.cookie).set(H).send({});
  assert.equal(fired.status, 200);
  assert.equal(fired.body.isActive, false);
  // без cap workerLifecycle (стара роль) — 403 за cap, не за скоупом
  await db.update(rolesTable).set({ caps: OM_CAPS }).where(eq(rolesTable.key, "office_manager"));
  invalidateRolesCache();
  assert.equal((await request(app).get(`/api/workers/${wPoz.id}/invite`).set("Cookie", om.cookie)).status, 403);
});
