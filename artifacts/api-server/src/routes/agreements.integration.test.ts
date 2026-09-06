import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, seedRole, db, companiesTable } from "../test/harness.ts";

// Умови (агрименти/договори) на /cost-invoices: одноразові/на термін/безстрокові
// зобов'язання, що генерують agreement_charges (окремий бакет «Умови» поруч із
// KSeF і ручними фактурами). Місяці навмисно взяті в далекому минулому (2020),
// щоб бекфіл (прив'язаний до РЕАЛЬНОГО поточного місяця, не тестового) завжди
// впирався в endMonth умови, а не в «сьогодні» прогону тестів. Сума — ЗАВЖДИ
// брутто (як вводить кшєнгова), vatRate — лише інформаційний тег 23|8|zw.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

let buch = "";
let companyId = 0;
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  await seedRole("buch", ["costInvoices"], ["/cost-invoices"]);
  buch = (await seedAdmin({ role: "buch", name: "Кшєнгова" })).cookie;
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning({ id: companiesTable.id });
  companyId = co!.id;
});
after(async () => { if (hasTestDb) await closeDb(); });

test("fixed_term: створення одразу бекфілить усі місяці до endMonth; назва складена з категорії+контрагента", opts, async () => {
  const created = await request(app).post("/api/agreements").set("Cookie", buch).set(H).send({
    companyId, category: "other", counterparty: "Landlord Sp. z o.o.", kind: "fixed_term",
    amount: "1000", startMonth: "2020-01", endMonth: "2020-03",
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.chargesCreated, 3, "три місяці: 01,02,03");
  assert.equal(created.body.title, "Інше · Landlord Sp. z o.o.");

  const feb = await request(app).get(`/api/cost-invoices?month=2020-02`).set("Cookie", buch);
  const row = feb.body.rows.find((x: any) => x.origin === "agreement");
  assert.ok(row, "запис умови видно на /cost-invoices у місяці послуги");
  assert.equal(row.gross, 1000, "сума брутто — як введено, без розрахунків");
  assert.equal(row.category, "other");
  assert.equal(row.source, "agreement");
});

test("сума завжди брутто: vatRate — лише тег, невалідний відхиляється", opts, async () => {
  const created = await request(app).post("/api/agreements").set("Cookie", buch).set(H).send({
    companyId, category: "other", kind: "one_time",
    amount: "100", vatRate: "8", startMonth: "2020-05",
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.vatRate, "8");
  assert.equal(created.body.chargesCreated, 1);

  const r = await request(app).get(`/api/cost-invoices?month=2020-05`).set("Cookie", buch);
  const row = r.body.rows.find((x: any) => x.origin === "agreement");
  assert.equal(row.gross, 100, "amount використовується як є — жодного розрахунку net→gross");

  const bad = await request(app).post("/api/agreements").set("Cookie", buch).set(H).send({
    companyId, category: "other", kind: "one_time", amount: "50", vatRate: "20", startMonth: "2020-05",
  });
  assert.equal(bad.status, 400);

  const zw = await request(app).post("/api/agreements").set("Cookie", buch).set(H).send({
    companyId, category: "other", kind: "one_time", amount: "50", vatRate: "zw", startMonth: "2020-05",
  });
  assert.equal(zw.status, 200);
  assert.equal(zw.body.vatRate, "zw");
});

test("backfillMonths: створення заднім числом зараховує лише вибрані місяці", opts, async () => {
  const created = await request(app).post("/api/agreements").set("Cookie", buch).set(H).send({
    companyId, category: "other", kind: "fixed_term",
    amount: "200", startMonth: "2020-01", endMonth: "2020-04",
    backfillMonths: ["2020-01", "2020-03"], // свідомо пропускаємо 02 і 04
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.chargesCreated, 2);

  const jan = await request(app).get(`/api/cost-invoices?month=2020-01`).set("Cookie", buch);
  assert.ok(jan.body.rows.some((x: any) => x.origin === "agreement"));
  const feb = await request(app).get(`/api/cost-invoices?month=2020-02`).set("Cookie", buch);
  assert.ok(!feb.body.rows.some((x: any) => x.origin === "agreement"), "лютий свідомо не вибраний — не зарахований");
  const apr = await request(app).get(`/api/cost-invoices?month=2020-04`).set("Cookie", buch);
  assert.ok(!apr.body.rows.some((x: any) => x.origin === "agreement"), "квітень свідомо не вибраний — не зарахований");

  // точковий бекфіл пропущеного місяця пізніше — POST /agreements/:id/generate
  const gen = await request(app).post(`/api/agreements/${created.body.id}/generate`).set("Cookie", buch).set(H).send({ month: "2020-02" });
  assert.equal(gen.status, 200);
  assert.equal(gen.body.created, true);
  const feb2 = await request(app).get(`/api/cost-invoices?month=2020-02`).set("Cookie", buch);
  assert.ok(feb2.body.rows.some((x: any) => x.origin === "agreement"), "лютий додано точковим генератором");
});

test("ручна корекція місячного запису переживає повторну генерацію; видалений місяць не воскресає", opts, async () => {
  const created = await request(app).post("/api/agreements").set("Cookie", buch).set(H).send({
    companyId, category: "other", kind: "fixed_term",
    amount: "500", startMonth: "2020-01", endMonth: "2020-03",
  });
  const agreementId = created.body.id;

  // ручна правка лютневого запису
  const feb1 = await request(app).get(`/api/cost-invoices?month=2020-02`).set("Cookie", buch);
  const febRow = feb1.body.rows.find((x: any) => x.origin === "agreement");
  const editRes = await request(app).patch(`/api/agreements/charges/${febRow.id}`).set("Cookie", buch).set(H).send({ amount: "777" });
  assert.equal(editRes.status, 200);
  assert.equal(editRes.body.source, "manual-edit");

  // видалення березневого запису
  const mar1 = await request(app).get(`/api/cost-invoices?month=2020-03`).set("Cookie", buch);
  const marRow = mar1.body.rows.find((x: any) => x.origin === "agreement");
  const delRes = await request(app).delete(`/api/agreements/charges/${marRow.id}`).set("Cookie", buch).set(H);
  assert.equal(delRes.status, 200);

  // повторна генерація за ті самі місяці — не повинна ні перетерти ручну суму, ні воскресити видалене
  await request(app).post("/api/agreements/generate").set("Cookie", buch).set(H).send({ month: "2020-02" });
  await request(app).post("/api/agreements/generate").set("Cookie", buch).set(H).send({ month: "2020-03" });

  const feb2 = await request(app).get(`/api/cost-invoices?month=2020-02`).set("Cookie", buch);
  const febRow2 = feb2.body.rows.find((x: any) => x.origin === "agreement");
  assert.equal(febRow2.gross, 777, "ручна сума не перетерта повторною генерацією");

  const mar2 = await request(app).get(`/api/cost-invoices?month=2020-03`).set("Cookie", buch);
  assert.ok(!mar2.body.rows.some((x: any) => x.origin === "agreement" && x.agreementId === agreementId), "видалений місяць не воскрес");
});

test("дострокове завершення: PATCH endMonth у минуле зупиняє подальшу генерацію", opts, async () => {
  // startMonth у минулому — бекфіл при створенні одразу закриває все до РЕАЛЬНОГО
  // поточного місяця (це очікувано: щойно заведена стара безстрокова умова
  // повинна дістати всю історію). Дострокове завершення лише блокує МАЙБУТНІ
  // місяці, яких бекфіл ще не торкався — тому ціль тесту свідомо в 2099-му.
  const created = await request(app).post("/api/agreements").set("Cookie", buch).set(H).send({
    companyId, category: "other", kind: "indefinite",
    amount: "50", startMonth: "2020-01",
  });
  assert.equal(created.body.endMonth, null);
  // місяць уже закритий бекфілом (у межах old endMonth=null) — запис є
  const before = await request(app).get(`/api/cost-invoices?month=2020-02`).set("Cookie", buch);
  assert.ok(before.body.rows.some((x: any) => x.origin === "agreement"), "бекфіл при створенні вже закрив 2020-02");

  // достроково завершуємо в лютому 2020
  const patched = await request(app).patch(`/api/agreements/${created.body.id}`).set("Cookie", buch).set(H)
    .send({ endMonth: "2020-02" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.endMonth, "2020-02");

  // генерація за далеке майбутнє (поза новими межами) не створює запис
  const gen = await request(app).post("/api/agreements/generate").set("Cookie", buch).set(H).send({ month: "2099-01" });
  assert.equal(gen.status, 200);
  assert.equal(gen.body.created, 0);
  const future = await request(app).get(`/api/cost-invoices?month=2099-01`).set("Cookie", buch);
  assert.ok(!future.body.rows.some((x: any) => x.origin === "agreement"), "після дострокового завершення майбутній місяць не генерується");
});

test("видалення умови (soft) не чіпає вже згенеровані записи; журнал дій пише історію", opts, async () => {
  const created = await request(app).post("/api/agreements").set("Cookie", buch).set(H).send({
    companyId, category: "other", kind: "one_time",
    amount: "30", startMonth: "2020-06",
  });
  const del = await request(app).delete(`/api/agreements/${created.body.id}`).set("Cookie", buch).set(H);
  assert.equal(del.status, 200);

  const r = await request(app).get(`/api/cost-invoices?month=2020-06`).set("Cookie", buch);
  assert.ok(r.body.rows.some((x: any) => x.origin === "agreement"), "уже згенерований запис лишається видимим");

  const audit = await request(app).get(`/api/agreements/audit?entity=condition&id=${created.body.id}`).set("Cookie", buch);
  assert.equal(audit.status, 200);
  const actions = audit.body.entries.map((e: any) => e.action);
  assert.deepEqual(actions, ["deleted", "created"], "новіші дії першими");
  assert.equal(audit.body.entries[0].adminName, "Кшєнгова");
});

test("гейт: роль без viewFinance/costInvoices не бачить умови", opts, async () => {
  await seedRole("plain", [], ["/"]);
  const plain = (await seedAdmin({ role: "plain" })).cookie;
  const denied = await request(app).get("/api/agreements").set("Cookie", plain);
  assert.equal(denied.status, 403);
});
