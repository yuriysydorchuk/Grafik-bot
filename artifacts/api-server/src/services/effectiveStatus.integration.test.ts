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
  assert.equal(String(journal[0]?.effectiveDate), "2026-08-15"); assert.equal(journal[0]?.appliedRows, null);
  // повторний перерахунок не дублює відкритий запис
  await recomputeWorkerLegality(w!.id, "2026-09-07");
  assert.equal((await db.select().from(workerChangesTable)).length, 1);
  const [wAfter] = await db.select({ legalStatus: workersTable.legalStatus }).from(workersTable).where(eq(workersTable.id, w!.id));
  assert.equal(wAfter?.legalStatus, null, "движок не пише workers.legal_status");

  // GET /workers/:id/legality віддає відкриту зміну для банера в профілі
  const owner = await seedAdmin({ role: "owner" });
  const g = await request(app).get(`/api/workers/${w!.id}/legality`).set("Cookie", owner.cookie);
  assert.equal(g.status, 200);
  assert.equal(g.body.effectiveLegalStatus, "polak"); assert.equal(g.body.effectiveSource, "documents");
  assert.equal(g.body.pendingEffectiveChange?.newValue, "polak"); assert.equal(g.body.pendingEffectiveChange?.effectiveDate, "2026-08-15");
});

test("прийняття зміни за документами: превʼю → apply переписує снапшот і розклад рядка сводної, журнал закривається; відхилення — dismiss", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
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

  await signedUmowa(w!.id, fa!.id, co!.id, "2026-08-15");
  await recomputeWorkerLegality(w!.id, "2026-09-06");
  const [pending] = await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, w!.id), eq(workerChangesTable.field, "effectiveLegalStatus")));
  assert.ok(pending);

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

  // відхилення: новий запис (умову скасували → назад none) → dismiss
  await db.update(contractsTable).set({ status: "cancelled" }).where(eq(contractsTable.workerId, w!.id));
  await recomputeWorkerLegality(w!.id, "2026-09-06");
  const [pending2] = await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, w!.id), eq(workerChangesTable.field, "effectiveLegalStatus"), eq(workerChangesTable.newValue, "")));
  const open = (await db.select().from(workerChangesTable).where(eq(workerChangesTable.workerId, w!.id))).filter(c => c.appliedRows == null && c.reviewDismissedAt == null);
  assert.equal(open.length, 1); assert.equal(open[0]?.oldValue, "polak"); assert.equal(open[0]?.newValue, null);
  void pending2;
  const d = await request(app).post(`/api/svodni/profile-change/${open[0]!.id}/dismiss`).set("Cookie", owner.cookie).set(H);
  assert.equal(d.status, 200);
  const [dismissed] = await db.select().from(workerChangesTable).where(eq(workerChangesTable.id, open[0]!.id));
  assert.ok(dismissed?.reviewDismissedAt);
  const [rowStill] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, row!.id));
  assert.equal(rowStill?.legalStatus, "polak", "відхилення не чіпає сводну");
});
