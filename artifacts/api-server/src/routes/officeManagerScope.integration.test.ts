import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db, adminsTable, factoriesTable, workersTable, svodniRowsTable, advanceRequestsTable, contractsTable, rolesTable } from "../test/harness.ts";
import { workerFactoriesTable, tasksTable, workerBadaniaTable, clothingStockTable, clothingItemsTable, scheduleWeeksTable, scheduleEntriesTable, hoursDisputesTable, absenceRequestsTable, penaltiesTable, svodniLocksTable, workerChangesTable } from "@workspace/db";
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

// 13.10.2026: глобальний пошук (Ctrl+K) для скоуп-адміна давав 403 → порожнє поле; імʼя шукається по словах у будь-якому порядку
test("скоуп: глобальний пошук — 200, лише свої люди/фабрики, слова імені в будь-якому порядку", opts, async () => {
  const { om, main, wPoz, wLodz } = await world();
  const mine = await request(app).get("/api/search?q=poz%20anna").set("Cookie", om.cookie);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.hits.filter((h: any) => h.kind === "worker").map((h: any) => h.id), [wPoz.id]);
  // роль без сторінки /factories — групи фабрик у пошуку нема взагалі (гейт по roles.pages лишається)
  assert.equal(mine.body.hits.filter((h: any) => h.kind === "factory").length, 0);
  const other = await request(app).get("/api/search?q=Olek").set("Cookie", om.cookie);
  assert.equal(other.status, 200);
  assert.equal(other.body.hits.length, 0, "чужа людина у пошуку скоуп-адміна");
  const all = await request(app).get("/api/search?q=Lodz%20Olek").set("Cookie", main.cookie);
  assert.deepEqual(all.body.hits.filter((h: any) => h.kind === "worker").map((h: any) => h.id), [wLodz.id]);
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
  // вкладка «У сводну» — лише editData
  assert.equal((await request(app).get("/api/advances/svodni-pending").set("Cookie", om.cookie)).status, 403);
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

test("бадання й одяг: внести своїй людині — ок, чужій — 403; списки «до зняття» лише свого міста", opts, async () => {
  const { om, wPoz, wLodz } = await world2();
  assert.equal((await request(app).post(`/api/workers/${wPoz.id}/badania`).set("Cookie", om.cookie).set(H).send({ amount: 120 })).status, 200);
  assert.equal((await request(app).post(`/api/workers/${wLodz.id}/badania`).set("Cookie", om.cookie).set(H).send({ amount: 120 })).status, 403);
  const [bLodz] = await db.insert(workerBadaniaTable).values({ workerId: wLodz.id, amount: 90, enteredAt: "2026-10-01" } as any).returning();
  const pend = await request(app).get("/api/badania/pending").set("Cookie", om.cookie);
  assert.equal(pend.status, 200);
  assert.deepEqual(pend.body.rows.map((r: any) => r.workerId), [wPoz.id]);
  assert.equal((await request(app).delete(`/api/worker-badania/${bLodz!.id}`).set("Cookie", om.cookie).set(H)).status, 403);
  // одяг: видача зі складу
  const [stock] = await db.insert(clothingStockTable).values({ itemType: "boots", size: "42", condition: "new", price: 80, qty: 3 }).returning();
  assert.equal((await request(app).post("/api/clothing/issue").set("Cookie", om.cookie).set(H).send({ stockId: stock!.id, workerId: wLodz.id })).status, 403);
  const issued = await request(app).post("/api/clothing/issue").set("Cookie", om.cookie).set(H).send({ stockId: stock!.id, workerId: wPoz.id });
  assert.equal(issued.status, 200);
  const [foreign] = await db.insert(clothingItemsTable).values({ workerId: wLodz.id, itemType: "boots", price: 50, ownership: "sold" }).returning();
  const [raw] = await db.insert(clothingItemsTable).values({ workerName: "Nobody Raw", itemType: "hat", price: 10, ownership: "sold" }).returning();
  const cp = await request(app).get("/api/clothing/pending").set("Cookie", om.cookie);
  assert.equal(cp.status, 200);
  assert.deepEqual(cp.body.groups.map((g: any) => g.workerId), [wPoz.id]);
  assert.equal((await request(app).post(`/api/clothing/${foreign!.id}/return`).set("Cookie", om.cookie).set(H).send({})).status, 403);
  assert.equal((await request(app).patch(`/api/clothing/${raw!.id}`).set("Cookie", om.cookie).set(H).send({ price: 1 })).status, 403);
  assert.equal((await request(app).post("/api/clothing").set("Cookie", om.cookie).set(H).send({ itemType: "boots", workerName: "X Y", price: 5 })).status, 403);
  assert.equal((await request(app).post(`/api/clothing/${issued.body.id}/return`).set("Cookie", om.cookie).set(H).send({})).status, 200);
  const list = await request(app).get(`/api/clothing?workerId=${wPoz.id}`).set("Cookie", om.cookie);
  assert.equal(list.status, 200);
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

// ── 11.10.2026: скоуп-адмін з editData веде графік/замовлення/доступність/години своїх фабрик ──
const GRAFIK_PAGES = ["/", "/schedule", "/orders", "/availability", "/reliability", "/absences", "/hours", "/broadcast", "/workers", "/tasks"];
const WEEK = "2030-03-04"; // понеділок у майбутньому: жодних тригерів «минулі дні»

async function world3() {
  const main = await seedAdmin({ role: "owner", isMain: true, name: "Main" });
  await seedRole("inpost-grafikowy", ["editData"], GRAFIK_PAGES);
  const [poz] = await db.insert(factoriesTable).values({ name: "POZ FAB", city: "Познань" }).returning();
  const [lodz] = await db.insert(factoriesTable).values({ name: "LDZ FAB", city: "Лодзь" }).returning();
  const [wPoz] = await db.insert(workersTable).values({ fullName: "Anna Poz", factoryId: poz!.id }).returning();
  const [wLodz] = await db.insert(workersTable).values({ fullName: "Olek Lodz", factoryId: lodz!.id }).returning();
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: WEEK, status: "draft" }).returning();
  const [ePoz] = await db.insert(scheduleEntriesTable).values({ weekId: wk!.id, workerId: wPoz!.id, factoryId: poz!.id, dayOfWeek: "mon", shift: "1", status: "scheduled" }).returning();
  const [eLodz] = await db.insert(scheduleEntriesTable).values({ weekId: wk!.id, workerId: wLodz!.id, factoryId: lodz!.id, dayOfWeek: "mon", shift: "1", status: "scheduled" }).returning();
  const g = await seedAdmin({ role: "inpost-grafikowy", name: "Grafik POZ" });
  await db.update(adminsTable).set({ scopeFactoryIds: [poz!.id] }).where(eq(adminsTable.id, g.adminId));
  return { main, g, poz: poz!, lodz: lodz!, wPoz: wPoz!, wLodz: wLodz!, wk: wk!, ePoz: ePoz!, eLodz: eLodz! };
}

test("графік зі скоупом: фабрика обовʼязкова; своя — 200, чужа/без — 403; записи — по фабриці запису", opts, async () => {
  const { g, poz, lodz, wPoz, wLodz, ePoz, eLodz } = await world3();
  assert.equal((await request(app).get(`/api/schedule?weekStart=${WEEK}`).set("Cookie", g.cookie)).status, 403);
  assert.equal((await request(app).get(`/api/schedule?weekStart=${WEEK}&factoryId=${lodz.id}`).set("Cookie", g.cookie)).status, 403);
  const sch = await request(app).get(`/api/schedule?weekStart=${WEEK}&factoryId=${poz.id}`).set("Cookie", g.cookie);
  assert.equal(sch.status, 200);
  assert.equal((await request(app).post("/api/schedule/generate").set("Cookie", g.cookie).set(H).send({ weekStart: WEEK })).status, 403);
  assert.equal((await request(app).post("/api/schedule/approve").set("Cookie", g.cookie).set(H).send({ weekStart: WEEK })).status, 403);
  assert.equal((await request(app).post("/api/schedule/generate").set("Cookie", g.cookie).set(H).send({ weekStart: WEEK, factoryId: lodz.id })).status, 403);
  // новий запис: своя людина на свою фабрику — ок; чужа людина — 403; чужа фабрика — 403
  const add = await request(app).post("/api/schedule/entry").set("Cookie", g.cookie).set(H).send({ weekStart: WEEK, workerId: wPoz.id, factoryId: poz.id, day: "tue", shift: "1" });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal((await request(app).post("/api/schedule/entry").set("Cookie", g.cookie).set(H).send({ weekStart: WEEK, workerId: wLodz.id, factoryId: poz.id, day: "tue", shift: "1" })).status, 403);
  assert.equal((await request(app).post("/api/schedule/entry").set("Cookie", g.cookie).set(H).send({ weekStart: WEEK, workerId: wPoz.id, factoryId: lodz.id, day: "wed", shift: "1" })).status, 403);
  assert.equal((await request(app).patch(`/api/schedule/entry/${eLodz.id}/status`).set("Cookie", g.cookie).set(H).send({ status: "present" })).status, 403);
  assert.equal((await request(app).delete(`/api/schedule/entry/${eLodz.id}`).set("Cookie", g.cookie).set(H)).status, 403);
  assert.equal((await request(app).delete(`/api/schedule/entry/${ePoz.id}`).set("Cookie", g.cookie).set(H)).status, 200);
  // замовлення/Excel — лише своя фабрика
  assert.equal((await request(app).get(`/api/orders?weekStart=${WEEK}&factoryId=${lodz.id}`).set("Cookie", g.cookie)).status, 403);
  assert.equal((await request(app).get(`/api/orders?weekStart=${WEEK}&factoryId=${poz.id}`).set("Cookie", g.cookie)).status, 200);
  assert.equal((await request(app).put("/api/orders").set("Cookie", g.cookie).set(H).send({ weekStart: WEEK, factoryId: lodz.id, orders: [] })).status, 403);
  // шаблони листів — лише читати
  assert.equal((await request(app).get("/api/email-templates").set("Cookie", g.cookie)).status, 200);
  assert.equal((await request(app).post("/api/email-templates").set("Cookie", g.cookie).set(H).send({ name: "x", subject: "s", body: "b" })).status, 403);
});

test("списки зі скоупом: огляд, доступність, години, рапорти, відпрошування, пропуски — лише свої фабрики", opts, async () => {
  const { g, poz, lodz, wPoz, wLodz, wk } = await world3();
  await db.update(scheduleWeeksTable).set({ status: "approved" }).where(eq(scheduleWeeksTable.id, wk.id));
  await db.update(scheduleEntriesTable).set({ status: "absent" }).where(eq(scheduleEntriesTable.weekId, wk.id));
  await db.insert(hoursDisputesTable).values([{ workerId: wPoz.id, month: "2030-03", message: "a", status: "new" }, { workerId: wLodz.id, month: "2030-03", message: "b", status: "new" }] as any);
  await db.insert(absenceRequestsTable).values([{ workerId: wPoz.id, weekStart: WEEK, dayOfWeek: "mon", status: "pending" }, { workerId: wLodz.id, weekStart: WEEK, dayOfWeek: "mon", status: "pending" }] as any);
  const dash = await request(app).get("/api/dashboard").set("Cookie", g.cookie);
  assert.equal(dash.status, 200);
  assert.equal(dash.body.counts.factories, 1);
  assert.equal(dash.body.counts.workers, 1);
  const attn = await request(app).get("/api/attention").set("Cookie", g.cookie);
  assert.equal(attn.status, 200);
  assert.equal(attn.body.pendingAbsences, 1);
  assert.equal(attn.body.hoursDisputes, 1);
  const miss = await request(app).get(`/api/availability/missing?weekStart=${WEEK}`).set("Cookie", g.cookie);
  assert.deepEqual(miss.body.map((w: any) => w.id), [wPoz.id]);
  const av = await request(app).get(`/api/availability?weekStart=${WEEK}`).set("Cookie", g.cookie);
  assert.equal(av.status, 200);
  assert.ok(!av.body.some((r: any) => r.workerId === wLodz.id));
  const hrs = await request(app).get("/api/hours?month=2030-03").set("Cookie", g.cookie);
  assert.equal(hrs.status, 200);
  assert.ok(!hrs.body.workers.some((w: any) => w.workerId === wLodz.id), "людина чужої фабрики в обліку годин");
  const reps = await request(app).get("/api/hours-reports").set("Cookie", g.cookie);
  assert.deepEqual(reps.body.map((r: any) => r.workerId), [wPoz.id]);
  const lodzRep = (await db.select().from(hoursDisputesTable).where(eq(hoursDisputesTable.workerId, wLodz.id)))[0]!;
  assert.equal((await request(app).post(`/api/hours-reports/${lodzRep.id}/resolve`).set("Cookie", g.cookie).set(H).send({})).status, 403);
  const ar = await request(app).get("/api/absence-requests").set("Cookie", g.cookie);
  assert.deepEqual(ar.body.map((r: any) => r.workerId), [wPoz.id]);
  const abs = await request(app).get("/api/absences?month=2030-03").set("Cookie", g.cookie);
  assert.equal(abs.status, 200);
  assert.ok(!abs.body.absences.some((a: any) => a.workerId === wLodz.id), "пропуск чужої фабрики");
  const rel = await request(app).get("/api/reliability?month=2030-03").set("Cookie", g.cookie);
  assert.equal(rel.status, 200);
  assert.ok(!JSON.stringify(rel.body).includes("Olek Lodz"), "надійність показує чужу людину");
  // ревʼю codex: відпрошування чужої людини не в /schedule, людина без фабрики не в запасі; approve не торкає чужу зміну; /weeks — обсяг лише своїх
  const schedAbs = await request(app).get(`/api/schedule?weekStart=${WEEK}&factoryId=${poz.id}`).set("Cookie", g.cookie);
  assert.ok(!Object.keys(schedAbs.body.absenceByWorker).some(k => k.startsWith(`${wLodz.id}-`)), "чуже відпрошування у графіку");
  const lodzReq = (await db.select().from(absenceRequestsTable).where(eq(absenceRequestsTable.workerId, wLodz.id)))[0]!;
  assert.equal((await request(app).post(`/api/absence-requests/${lodzReq.id}/approve`).set("Cookie", g.cookie).set(H).send({})).status, 403);
  const weeks = await request(app).get("/api/weeks").set("Cookie", g.cookie);
  assert.equal(weeks.body.find((w: any) => w.id === wk.id)?.entries, 1);
  assert.equal(dash.body.attendance?.total ?? 1, 1);
  // масиви id у тілі: чужа людина у виключеннях/розсилці — 403; «всім» — 403; свій працівник без фабрики — 403
  assert.equal((await request(app).post("/api/hours/exclusions").set("Cookie", g.cookie).set(H).send({ month: "2030-03", items: [{ workerId: wLodz.id, reason: "vacation" }] })).status, 403);
  assert.equal((await request(app).post("/api/broadcast").set("Cookie", g.cookie).set(H).send({ text: "hi", target: "all" })).status, 403);
  assert.equal((await request(app).post("/api/broadcast").set("Cookie", g.cookie).set(H).send({ text: "hi", target: "factory", factoryId: lodz.id })).status, 403);
  assert.equal((await request(app).post("/api/workers").set("Cookie", g.cookie).set(H).send({ fullName: "Nowy Czlowiek" })).status, 403);
  assert.equal((await request(app).post("/api/workers").set("Cookie", g.cookie).set(H).send({ fullName: "Nowy Czlowiek", factoryId: poz.id })).status, 200);
  // без скоупу (головний) усе як раніше
  const { main } = { main: await seedAdmin({ role: "owner", isMain: true, name: "Main2" }) };
  const all = await request(app).get("/api/hours-reports").set("Cookie", main.cookie);
  assert.equal(all.body.length, 2);
});

// 13.10.2026: роль «Dyrektor» регіону — сводна зі скоупом міст: читання лише своїх міст, мутації лише у своїй
// області, движок знять не чіпає рядки чужого міста, дії «по всіх містах» закриті.
test("сводна зі скоупом: рядки/вкладки/локи лише свого міста; чужа область — 403; зняття лише у свої рядки", opts, async () => {
  const { main, poz, lodz, wPoz, wLodz } = await world();
  await seedRole("dyrektor-test", ["viewWorkers", "editData", "svodni", "svodniSensitive"], ["/svodni", "/workers"]);
  const dyr = await seedAdmin({ role: "dyrektor-test", name: "Dyr Poznan" });
  await db.update(adminsTable).set({ scopeCities: ["Познань"] }).where(eq(adminsTable.id, dyr.adminId));
  const M = "2026-08";
  const [rPoz] = await db.insert(svodniRowsTable).values({ periodMonth: M, city: "Познань", factoryLabel: "POZ FAB", factoryId: poz.id, rawName: "Anna Poz", workerId: wPoz.id, linkStatus: "confirmed", hours: 100, rateNetto: 25, doWyplaty: 2500, extras: {} }).returning();
  const [rLodz] = await db.insert(svodniRowsTable).values({ periodMonth: M, city: "Лодзь", factoryLabel: "LDZ FAB", factoryId: lodz.id, rawName: "Olek Lodz", workerId: wLodz.id, linkStatus: "confirmed", hours: 50, rateNetto: 25, doWyplaty: 1250, extras: {} }).returning();
  await db.insert(svodniLocksTable).values({ periodMonth: M, city: "Лодзь", factoryLabel: "", lockedBy: main.adminId });

  // читання: лише своє місто
  const r = await request(app).get(`/api/svodni?month=${M}`).set("Cookie", dyr.cookie);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.cities, ["Познань"]);
  assert.deepEqual(r.body.rows.map((x: any) => x.id), [rPoz!.id]);
  assert.equal(r.body.locks.length, 0, "чужий лок видно");
  assert.equal((await request(app).get(`/api/svodni?month=${M}&city=${encodeURIComponent("Лодзь")}`).set("Cookie", dyr.cookie)).status, 403);
  const xl = await request(app).get(`/api/svodni/excel?month=${M}`).set("Cookie", dyr.cookie);
  assert.equal(xl.status, 200); // лише свої рядки (чужих у файлі нема — 404 було б, якби свої відфільтрувались)

  // мутації: своя область — ок, чужа — 403
  assert.equal((await request(app).post("/api/svodni/lock").set("Cookie", dyr.cookie).set(H).send({ month: M, city: "Познань" })).status, 200);
  assert.equal((await request(app).post("/api/svodni/lock").set("Cookie", dyr.cookie).set(H).send({ month: M, city: "Познань" })).status, 200); // розлок
  assert.equal((await request(app).post("/api/svodni/lock").set("Cookie", dyr.cookie).set(H).send({ month: M, city: "Лодзь" })).status, 403);
  assert.equal((await request(app).patch(`/api/svodni/rows/${rLodz!.id}`).set("Cookie", dyr.cookie).set(H).send({ field: "kara", value: 5 })).status, 403);
  assert.equal((await request(app).patch(`/api/svodni/rows/${rPoz!.id}`).set("Cookie", dyr.cookie).set(H).send({ field: "kara", value: 5 })).status, 200);
  assert.equal((await request(app).post("/api/svodni/clear").set("Cookie", dyr.cookie).set(H).send({ month: M, city: "Лодзь", factoryLabel: "LDZ FAB" })).status, 403);
  assert.equal((await request(app).post("/api/svodni/rows").set("Cookie", dyr.cookie).set(H).send({ periodMonth: M, city: "Лодзь", factoryLabel: "LDZ FAB", workerId: wPoz.id })).status, 403);
  // «по всіх містах» — закрито; синк свого міста — пропускає гейт (далі падає на Google, не на 403)
  assert.equal((await request(app).post("/api/svodni/rematch").set("Cookie", dyr.cookie).set(H).send({})).status, 403);
  assert.equal((await request(app).post("/api/svodni/apply-rates").set("Cookie", dyr.cookie).set(H).send({ month: M })).status, 403);
  assert.equal((await request(app).post("/api/svodni/sync").set("Cookie", dyr.cookie).set(H).send({ months: [M], city: "Лодзь" })).status, 403);
  assert.notEqual((await request(app).post("/api/svodni/sync").set("Cookie", dyr.cookie).set(H).send({ months: [M], city: "Познань" })).status, 403);

  // зняття: без ids — 403; чужа людина — 403; своя — лягає у свій рядок
  const [pLodz] = await db.insert(penaltiesTable).values({ periodMonth: M, workerId: wLodz.id, factoryId: lodz.id, amount: 30 }).returning();
  const [pPoz] = await db.insert(penaltiesTable).values({ periodMonth: M, workerId: wPoz.id, factoryId: poz.id, amount: 20 }).returning();
  assert.equal((await request(app).post("/api/svodni/apply-penalty-deductions").set("Cookie", dyr.cookie).set(H).send({ month: M })).status, 403);
  assert.equal((await request(app).post("/api/svodni/apply-penalty-deductions").set("Cookie", dyr.cookie).set(H).send({ month: M, ids: [pLodz!.id] })).status, 403);
  const ap = await request(app).post("/api/svodni/apply-penalty-deductions").set("Cookie", dyr.cookie).set(H).send({ month: M, ids: [pPoz!.id] });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.updated, 1);
  const [after] = await db.select({ kara: svodniRowsTable.kara }).from(svodniRowsTable).where(eq(svodniRowsTable.id, rPoz!.id));
  assert.equal(after!.kara, 25); // 5 (PATCH) + 20 (штраф)
  const [untouched] = await db.select({ kara: svodniRowsTable.kara }).from(svodniRowsTable).where(eq(svodniRowsTable.id, rLodz!.id));
  assert.equal(untouched!.kara ?? 0, 0);
  assert.equal((await request(app).post("/api/svodni/undo-penalty-deduction").set("Cookie", dyr.cookie).set(H).send({ id: pPoz!.id })).status, 200);

  // людина з двох міст: реальне зняття сидить у рядку чужого міста, а у своєму є інша сума тієї ж колонки —
  // undo НЕ вгадує й не віднімає зі свого рядка (ревʼю codex 13.10); журнальну зміну такої людини не відкотити
  const [rPozLodz] = await db.insert(svodniRowsTable).values({ periodMonth: M, city: "Лодзь", factoryLabel: "LDZ FAB", factoryId: lodz.id, rawName: "Anna Poz", workerId: wPoz.id, linkStatus: "confirmed", hours: 10, rateNetto: 25, doWyplaty: 250, kara: 30, extras: {} }).returning();
  const [pForeign] = await db.insert(penaltiesTable).values({ periodMonth: M, workerId: wPoz.id, factoryId: lodz.id, amount: 30, deducted: true, deductedAt: "2026-09-01", deductedMonth: M }).returning();
  await request(app).patch(`/api/svodni/rows/${rPoz!.id}`).set("Cookie", dyr.cookie).set(H).send({ field: "kara", value: 7 });
  assert.equal((await request(app).post("/api/svodni/undo-penalty-deduction").set("Cookie", dyr.cookie).set(H).send({ id: pForeign!.id })).status, 409); // помилка движка → 409, джерело лишається знятим
  const [stillOwn] = await db.select({ kara: svodniRowsTable.kara }).from(svodniRowsTable).where(eq(svodniRowsTable.id, rPoz!.id));
  assert.equal(stillOwn!.kara, 7);
  const [stillForeign] = await db.select({ kara: svodniRowsTable.kara }).from(svodniRowsTable).where(eq(svodniRowsTable.id, rPozLodz!.id));
  assert.equal(stillForeign!.kara, 30);
  const [chg] = await db.insert(workerChangesTable).values({ workerId: wPoz.id, field: "legalStatus", oldValue: "zus", newValue: "student", effectiveDate: `${M}-01` }).returning();
  assert.equal((await request(app).delete(`/api/svodni/profile-change/${chg!.id}`).set("Cookie", dyr.cookie).set(H)).status, 403);
  await db.delete(svodniRowsTable).where(eq(svodniRowsTable.id, rPozLodz!.id));

  // головний адмін бачить обидва міста як і раніше
  const all = await request(app).get(`/api/svodni?month=${M}`).set("Cookie", main.cookie);
  assert.deepEqual(all.body.cities, ["Лодзь", "Познань"]);
  assert.equal(all.body.rows.length, 2);
});
