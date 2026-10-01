// Резолвер виплат наскрізь (06.09.2026): документи → кеш worker_legality.effective_* →
// журнал worker_changes (effectiveLegalStatus) → превʼю/прийняття у сводну зі снапшотом
// рядка; workers.legal_status при цьому НЕ змінюється (payroll-інваріант).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, db,
  workersTable, companiesTable, factoriesTable, workerLegalityTable, workerChangesTable, svodniRowsTable,
  documentTemplatesTable, contractsTable, contractFilesTable,
} from "../test/harness.ts";
import { seedLegalizationCatalog } from "./legalizationSeed.ts";
import { recomputeWorkerLegality } from "./legalityRecompute.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); await seedLegalizationCatalog(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const H = { "X-Requested-With": "grafik" };

async function signedUmowa(workerId: number, factoryId: number, companyId: number, dateFrom: string) {
  const [tpl] = await db.insert(documentTemplatesTable).values({ kind: "umowa", title: "Umowa T", scope: "all", body: { pl: "<p>x</p>" } as any }).returning();
  const [c] = await db.insert(contractsTable).values({ workerId, factoryId, companyId, status: "signed", dateFrom }).returning();
  await db.insert(contractFilesTable).values({ contractId: c!.id, templateId: tpl!.id, title: tpl!.title, sortOrder: 1 });
  return c!.id;
}

test("поляк без умови → ручне поле; з підписаною умовою → статус за документами + журнал з датою умови; профіль не змінюється", opts, async () => {
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "AGRAM", companyId: co!.id }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Polak", nationality: "poland", companyId: co!.id, factoryId: fa!.id, isActive: true, legalStatus: null }).returning();

  await recomputeWorkerLegality(w!.id, "2026-09-06");
  let [lg] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, w!.id));
  assert.equal(lg?.overall, "illegal", "без умови не оформлений повністю");
  assert.equal(lg?.effectiveSource, "none"); assert.equal(lg?.effectiveLegalStatus, null);
  assert.equal((await db.select().from(workerChangesTable)).length, 0, "перший розрахунок журнал не пише");

  await signedUmowa(w!.id, fa!.id, co!.id, "2026-08-15");
  await recomputeWorkerLegality(w!.id, "2026-09-06");
  [lg] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, w!.id));
  assert.equal(lg?.overall, "legal");
  assert.equal(lg?.effectiveSource, "documents"); assert.equal(lg?.effectiveLegalStatus, "polak");
  assert.equal(String(lg?.effectiveSince), "2026-08-15", "діє з дати умови (з урахуванням дат документів)");
  const journal = await db.select().from(workerChangesTable).where(eq(workerChangesTable.workerId, w!.id));
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.field, "effectiveLegalStatus"); assert.equal(journal[0]?.oldValue, null); assert.equal(journal[0]?.newValue, "polak");
  assert.equal(String(journal[0]?.effectiveDate), "2026-08-15");
  assert.deepEqual(journal[0]?.appliedRows, [], "з 29.09 зміна застосовується одразу (рядків сводної нема → 0)"); assert.equal(journal[0]?.adminId, null);
  // повторний перерахунок не дублює відкритий запис
  await recomputeWorkerLegality(w!.id, "2026-09-07");
  assert.equal((await db.select().from(workerChangesTable)).length, 1);
  const [wAfter] = await db.select({ legalStatus: workersTable.legalStatus }).from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(wAfter?.legalStatus, null, "движок не пише workers.legal_status");

  // GET /workers/:id/legality: відкритої зміни нема (застосована авто), інфо-рядок — «застосовано»
  const owner = await seedAdmin({ role: "owner" });
  const g = await request(app).get(`/api/workers/${w!.id}/legality`).set("Cookie", owner.cookie);
  assert.equal(g.status, 200);
  assert.equal(g.body.effectiveLegalStatus, "polak"); assert.equal(g.body.effectiveSource, "documents");
  assert.equal(g.body.pendingEffectiveChange, null);
  assert.equal(g.body.recentEffectiveChange?.state, "applied"); assert.equal(g.body.recentEffectiveChange?.newValue, "polak"); assert.equal(g.body.recentEffectiveChange?.byAdmin, false);
});

test("прийняття зміни за документами (під локом — інакше з 29.09 застосовується авто): превʼю → apply переписує снапшот і розклад рядка, журнал закривається; відхилення — dismiss", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const { svodniLocksTable } = await import("@workspace/db");
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "AGRAM", companyId: co!.id, city: "Люблін" }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Polak", nationality: "poland", companyId: co!.id, factoryId: fa!.id, isActive: true, legalStatus: null, hourlyRate: 31.4, hourlyRateNetto: 25.35 }).returning();
  await recomputeWorkerLegality(w!.id, "2026-09-06"); // кеш: none
  // рядок сводної, сформований поки людина була «не зголошена»: усе готівкою
  const [row] = await db.insert(svodniRowsTable).values({
    periodMonth: "2026-09", city: "Люблін", factoryLabel: "AGRAM", factoryId: fa!.id, rawName: "Jan Polak", workerId: w!.id,
    linkStatus: "confirmed", manual: true, hours: 100, rateBrutto: 31.4, rateNetto: 25.35, doWyplaty: 2535, brutto: 3140,
    hoursDeclared: 0, ksiegBrutto: 0, ksiegNetto: 0, konto: 0, gotowka: 2535, legalStatus: null, legalSource: "none",
    isStudent: false, under26: false, extras: {}, hr: {}, sheetValues: {},
  }).returning();
  // вкладка залочена → авто-застосування пропускає рядок (skippedLocked), зміна чекає ревʼю/ручного apply
  await db.insert(svodniLocksTable).values({ periodMonth: "2026-09", city: "Люблін", factoryLabel: "AGRAM" } as any);

  await signedUmowa(w!.id, fa!.id, co!.id, "2026-08-15");
  await recomputeWorkerLegality(w!.id, "2026-09-06");
  const [pending] = await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, w!.id), eq(workerChangesTable.field, "effectiveLegalStatus")));
  assert.ok(pending); assert.deepEqual(pending!.appliedRows, [], "під локом — застосовано 0"); assert.equal((pending!.skippedLocked as any[])?.length, 1, "рядок чекає ревʼю при розлоку");
  const [rowLocked] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, row!.id));
  assert.equal(rowLocked?.legalStatus, null, "залочений рядок не чіпаємо");
  await db.delete(svodniLocksTable).where(eq(svodniLocksTable.factoryLabel, "AGRAM")); // розлок без ревʼю — далі ручний шлях

  const impact = await request(app).post("/api/svodni/profile-impact").set("Cookie", owner.cookie).set(H)
    .send({ workerId: w!.id, changes: { effectiveLegalStatus: "polak" }, from: "2026-08-15" });
  assert.equal(impact.status, 200, JSON.stringify(impact.body));
  assert.equal(impact.body.items.length, 1);
  const kontoDiff = impact.body.items[0].diffs.find((d: any) => d.key === "konto");
  assert.ok(kontoDiff && kontoDiff.to > 0, "оформлений → konto зʼявляється");
  assert.ok(impact.body.items[0].diffs.some((d: any) => d.key === "legalStatus" && d.to === "polak"));

  const apply = await request(app).post("/api/svodni/profile-apply").set("Cookie", owner.cookie).set(H)
    .send({ workerId: w!.id, changes: { effectiveLegalStatus: "polak" }, from: "2026-08-15", rowIds: [row!.id] });
  assert.equal(apply.status, 200, JSON.stringify(apply.body)); assert.equal(apply.body.applied, 1);
  const [rowAfter] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, row!.id));
  assert.equal(rowAfter?.legalStatus, "polak"); assert.equal(rowAfter?.legalSource, "documents");
  assert.ok((rowAfter?.konto ?? 0) > 0); assert.equal(rowAfter?.gotowka, 0);
  const [wAfter] = await db.select({ legalStatus: workersTable.legalStatus }).from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(wAfter?.legalStatus, null, "profile-apply з ефективним статусом не пише workers.legal_status");
  const [journalAfter] = await db.select().from(workerChangesTable).where(eq(workerChangesTable.id, pending!.id));
  assert.ok(Array.isArray(journalAfter?.appliedRows), "запис журналу закрито як прийнятий");
  const g = await request(app).get(`/api/workers/${w!.id}/legality`).set("Cookie", owner.cookie);
  assert.equal(g.body.pendingEffectiveChange, null);

  // серіалізація рядка: статус із снапшоту, джерело — документи
  const list = await request(app).get("/api/svodni?month=2026-09&city=%D0%9B%D1%8E%D0%B1%D0%BB%D1%96%D0%BD").set("Cookie", owner.cookie);
  assert.equal(list.status, 200);
  const ser = (list.body.rows ?? list.body).find?.((r: any) => r.id === row!.id) ?? null;
  if (ser) { assert.equal(ser.legalStatus, "polak"); assert.equal(ser.legalSource, "documents"); }

  // відхилення: новий запис (умову скасували → назад none) під локом → при розлоку офіс не приймає (applyChangeIds: [])
  await db.insert(svodniLocksTable).values({ periodMonth: "2026-09", city: "Люблін", factoryLabel: "AGRAM" } as any);
  await db.update(contractsTable).set({ status: "cancelled" }).where(eq(contractsTable.workerId, w!.id));
  await recomputeWorkerLegality(w!.id, "2026-09-06");
  const open = (await db.select().from(workerChangesTable).where(eq(workerChangesTable.workerId, w!.id))).filter(c => (c.skippedLocked as any[] | null)?.length && c.reviewDismissedAt == null && c.newValue == null);
  assert.equal(open.length, 1); assert.equal(open[0]?.oldValue, "polak"); assert.equal(open[0]?.newValue, null);
  // явний dismiss для зміни, що вже «пройшла» авто-прогін (appliedRows = []), — 400; шлях відхилення — ревʼю при розлоку
  assert.equal((await request(app).post(`/api/svodni/profile-change/${open[0]!.id}/dismiss`).set("Cookie", owner.cookie).set(H)).status, 400);
  const lp = await request(app).post("/api/svodni/lock-pending").set("Cookie", owner.cookie).set(H).send({ month: "2026-09", city: "Люблін", factoryLabel: "AGRAM" });
  assert.equal(lp.status, 200); assert.ok(lp.body.changes.some((c: any) => c.id === open[0]!.id), "зміна в ревʼю розлоку");
  const unlock = await request(app).post("/api/svodni/lock").set("Cookie", owner.cookie).set(H).send({ month: "2026-09", city: "Люблін", factoryLabel: "AGRAM", applyChangeIds: [] });
  assert.equal(unlock.status, 200, unlock.text);
  const [dismissed] = await db.select().from(workerChangesTable).where(eq(workerChangesTable.id, open[0]!.id));
  assert.ok(dismissed?.reviewDismissedAt); assert.equal(dismissed?.adminId, owner.adminId);
  const [rowStill] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, row!.id));
  assert.equal(rowStill?.legalStatus, "polak", "відхилення не чіпає сводну");
});

test("дві фабрики, умова лише на одну: статус для виплат ПО ФАБРИЦІ рядка (01.10.2026) — add-row, profile-apply, профіль по фабриках", opts, async () => {
  const { workerFactoriesTable } = await import("@workspace/db");
  const owner = await seedAdmin({ role: "owner" });
  const [es] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [eso] = await db.insert(companiesTable).values({ name: "ESO" }).returning();
  const [agram] = await db.insert(factoriesTable).values({ name: "AGRAM", companyId: es!.id, city: "Люблін" }).returning();
  const [sushi] = await db.insert(factoriesTable).values({ name: "SUSHI", companyId: eso!.id, city: "Люблін" }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Polak", nationality: "poland", companyId: es!.id, factoryId: agram!.id, isActive: true, legalStatus: null, hourlyRate: 31.4, hourlyRateNetto: 25.35 }).returning();
  await db.insert(workerFactoriesTable).values({ workerId: w!.id, factoryId: sushi!.id });
  await signedUmowa(w!.id, agram!.id, es!.id, "2026-08-15");
  await recomputeWorkerLegality(w!.id, "2026-09-06");
  // загальний статус людини: умови на SUSHI нема → не «за документами»
  const [lg] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, w!.id));
  assert.equal(lg?.overall, "illegal"); assert.equal(lg?.effectiveSource, "none");

  // за місяць по фабриці: AGRAM — документи, SUSHI — none; фабрика поза профілем — теж none
  const { legalityForMonth } = await import("./legalityMonth.ts");
  const { resolveEffectiveLegal } = await import("./effectiveStatus.ts");
  const effA = resolveEffectiveLegal(w!, await legalityForMonth(w!.id, "2026-09", undefined, agram!.id));
  const effS = resolveEffectiveLegal(w!, await legalityForMonth(w!.id, "2026-09", undefined, sushi!.id));
  assert.deepEqual([effA.source, effA.status], ["documents", "polak"]);
  assert.deepEqual([effS.source, effS.status], ["none", null]);
  const [other] = await db.insert(factoriesTable).values({ name: "LST", companyId: es!.id, city: "Люблін" }).returning();
  const effO = resolveEffectiveLegal(w!, await legalityForMonth(w!.id, "2026-09", undefined, other!.id));
  assert.equal(effO.source, "none", "фабрика поза профілем: умови на неї нема");

  // ручне додавання рядка — снапшот по фабриці рядка
  const addA = await request(app).post("/api/svodni/rows").set("Cookie", owner.cookie).set(H).send({ periodMonth: "2026-09", city: "Люблін", factoryLabel: "AGRAM", workerId: w!.id });
  const addS = await request(app).post("/api/svodni/rows").set("Cookie", owner.cookie).set(H).send({ periodMonth: "2026-09", city: "Люблін", factoryLabel: "SUSHI", workerId: w!.id });
  assert.equal(addA.status, 200, JSON.stringify(addA.body)); assert.equal(addS.status, 200, JSON.stringify(addS.body));
  const rows = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w!.id));
  const rA = rows.find(r => r.factoryId === agram!.id)!, rS = rows.find(r => r.factoryId === sushi!.id)!;
  assert.equal(rA.legalSource, "documents"); assert.equal(rA.legalStatus, "polak");
  assert.equal(rS.legalSource, "none"); assert.equal(rS.legalStatus, null);

  // profile-apply ефективної зміни на ОБИДВА рядки: AGRAM — polak за документами (по фабриці рядка),
  // SUSHI без умови — журнальне polak НЕ застосовується (вісь «умова» червона → ручний/порожній статус)
  await db.update(svodniRowsTable).set({ legalStatus: null, legalSource: "none", konto: 0 }).where(eq(svodniRowsTable.id, rA.id));
  const apply = await request(app).post("/api/svodni/profile-apply").set("Cookie", owner.cookie).set(H)
    .send({ workerId: w!.id, changes: { effectiveLegalStatus: "polak" }, from: "2026-09-01", rowIds: [rA.id, rS.id] });
  assert.equal(apply.status, 200, JSON.stringify(apply.body));
  const [rA2] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, rA.id));
  const [rS2] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, rS.id));
  assert.equal(rA2?.legalStatus, "polak"); assert.equal(rA2?.legalSource, "documents");
  assert.equal(rS2?.legalStatus ?? null, null, "SUSHI без умови лишається без статусу"); assert.equal(rS2?.legalSource, "none");

  // профіль: блок по фабриках
  const g = await request(app).get(`/api/workers/${w!.id}/legality`).set("Cookie", owner.cookie);
  assert.equal(g.status, 200);
  const pf = g.body.payrollByFactory as any[];
  assert.equal(pf.length, 2);
  assert.deepEqual(pf.find(x => x.factoryId === agram!.id)?.source, "documents");
  assert.deepEqual(pf.find(x => x.factoryId === sushi!.id)?.source, "none");
});
