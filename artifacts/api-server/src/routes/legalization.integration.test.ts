// Інтеграційні тести роутера легалізації (фаза 2): гейти cap, світлофори, юридичні
// поля документа, верифікація/відхилення, версії правил, дашборд + Excel, /attention,
// хуки audit+recompute у старих документних роутах admin-api.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, seedRole, db,
  workersTable, companiesTable, factoriesTable, documentTypesTable, workerDocumentsTable, workerLegalityTable, legalRulesTable, documentAuditTable,
  documentTemplatesTable, contractsTable, contractFilesTable,
} from "../test/harness.ts";
import { seedLegalizationCatalog } from "../services/legalizationSeed.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); await seedLegalizationCatalog(); } });
after(async () => { if (hasTestDb) await closeDb(); });

const H = { "X-Requested-With": "grafik" };
const typeId = async (code: string) => (await db.select({ id: documentTypesTable.id }).from(documentTypesTable).where(eq(documentTypesTable.code, code)))[0]!.id;

async function seedUa() {
  const [es, eso] = await db.insert(companiesTable).values([{ name: "ES" }, { name: "ESO" }]).returning();
  const [fab] = await db.insert(factoriesTable).values({ name: "AGRAM", companyId: es!.id }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Kowal Anna", nationality: "ukraine", companyId: es!.id, factoryId: fab!.id, employmentStartDate: "2026-01-10", isActive: true, legalStatus: "zus" }).returning();
  // підписана umowa на AGRAM — щоб вісь «умова» не тягнула overall у цих тестах (окремо — workerFactories.integration.test.ts)
  const [tpl] = await db.insert(documentTemplatesTable).values({ kind: "umowa", title: "Umowa AGRAM", scope: "all", body: { pl: "<p>x</p>" } as any }).returning();
  const [c] = await db.insert(contractsTable).values({ workerId: w!.id, factoryId: fab!.id, status: "signed", dateFrom: "2026-01-10" }).returning();
  await db.insert(contractFilesTable).values({ contractId: c!.id, templateId: tpl!.id, title: tpl!.title, sortOrder: 1 });
  return { es: es!, eso: eso!, w: w! };
}

test("гейти: світлофори — будь-якій ролі; дашборд/правила/юр-поля — лише cap legalization", opts, async () => {
  await seedRole("clerk", ["editData"], ["/workers"]);
  await seedRole("kadry", ["editData", "legalization"], ["/workers", "/legalization"]);
  const clerk = await seedAdmin({ role: "clerk" });
  const kadry = await seedAdmin({ role: "kadry" });
  const { w } = await seedUa();
  assert.equal((await request(app).get(`/api/workers/${w.id}/legality`).set("Cookie", clerk.cookie)).status, 200);
  assert.equal((await request(app).get("/api/legalization").set("Cookie", clerk.cookie)).status, 403);
  assert.equal((await request(app).get("/api/legal-rules").set("Cookie", clerk.cookie)).status, 403);
  assert.equal((await request(app).get("/api/legalization").set("Cookie", kadry.cookie)).status, 200);
  assert.equal((await request(app).get("/api/legal-rules").set("Cookie", kadry.cookie)).status, 200);
});

test("GET /workers/:id/legality рахує на льоту; документи через старі роути тягнуть audit + перерахунок; /workers віддає legality", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const { w, es } = await seedUa();
  const r0 = await request(app).get(`/api/workers/${w.id}/legality`).set("Cookie", owner.cookie);
  assert.equal(r0.status, 200); assert.equal(r0.body.overall, "unknown");
  // status_ukr через старий POST /workers/:id/documents (RW) → recompute → stay legal
  const c1 = await request(app).post(`/api/workers/${w.id}/documents`).set("Cookie", owner.cookie).set(H).send({ docTypeId: await typeId("status_ukr") });
  assert.equal(c1.status, 200);
  const [lg1] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, w.id));
  assert.equal(lg1?.stay, "legal"); assert.equal(lg1?.work, "unknown"); assert.equal(lg1?.nextExpiryAt, "2027-03-04");
  const audit1 = await db.select().from(documentAuditTable).where(eq(documentAuditTable.documentId, c1.body.id));
  assert.equal(audit1[0]?.action, "created"); assert.equal(audit1[0]?.adminName, "Test Admin");
  // powiadomienie + юр-поля через новий PATCH /legal → work legal, derived powiadomienie
  const c2 = await request(app).post(`/api/workers/${w.id}/documents`).set("Cookie", owner.cookie).set(H).send({ docTypeId: await typeId("powiadomienie_ua") });
  const p = await request(app).patch(`/api/worker-documents/${c2.body.id}/legal`).set("Cookie", owner.cookie).set(H)
    .send({ employerCompanyId: es.id, submittedAt: "2026-01-12", issuer: "PUP Lublin" });
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.employerCompanyId, es.id);
  const list = await request(app).get("/api/workers").set("Cookie", owner.cookie);
  const me = list.body.find((x: any) => x.id === w.id);
  assert.equal(me.legality.overall, "legal"); assert.equal(me.legality.derivedLegalStatus, "powiadomienie"); assert.equal(me.legality.legacyMismatchKind, "within_class");
  assert.equal(me.legalStatus, "zus", "легасі-поле не змінилось");
  // валідації PATCH /legal
  assert.equal((await request(app).patch(`/api/worker-documents/${c2.body.id}/legal`).set("Cookie", owner.cookie).set(H).send({ submittedAt: "12.01.2026" })).status, 400);
  assert.equal((await request(app).patch(`/api/worker-documents/${c2.body.id}/legal`).set("Cookie", owner.cookie).set(H).send({ caseStatus: "lost" })).status, 400);
  assert.equal((await request(app).patch(`/api/worker-documents/${c2.body.id}/legal`).set("Cookie", owner.cookie).set(H).send({ employerCompanyId: 9999 })).status, 400);
  // журнал документа
  const audit = await request(app).get(`/api/worker-documents/${c2.body.id}/audit`).set("Cookie", owner.cookie);
  assert.equal(audit.status, 200); assert.ok(audit.body.some((e: any) => e.action === "updated" && e.changes.some((c: any) => c.field === "employerCompanyId")));
});

test("verify/reject: pending-аплоуд стає підставою лише після verify; reject → missing з причиною", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const { w, es } = await seedUa();
  await db.insert(workerDocumentsTable).values({ workerId: w.id, docTypeId: await typeId("status_ukr"), title: "UKR", status: "present" });
  const [pend] = await db.insert(workerDocumentsTable).values({ workerId: w.id, docTypeId: await typeId("powiadomienie_ua"), title: "POW", status: "pending", source: "worker_bot", employerCompanyId: es.id }).returning();
  const before = await request(app).post(`/api/workers/${w.id}/legality/recompute`).set("Cookie", owner.cookie).set(H);
  assert.equal(before.body.work, "unknown", "pending ≠ підстава (D4)");
  assert.equal((await request(app).post(`/api/worker-documents/${pend!.id}/reject`).set("Cookie", owner.cookie).set(H).send({})).status, 400);
  const v = await request(app).post(`/api/worker-documents/${pend!.id}/verify`).set("Cookie", owner.cookie).set(H);
  assert.equal(v.status, 200); assert.equal(v.body.status, "present"); assert.ok(v.body.verifiedAt);
  const [lg] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, w.id));
  assert.equal(lg?.work, "legal");
  const rj = await request(app).post(`/api/worker-documents/${pend!.id}/reject`).set("Cookie", owner.cookie).set(H).send({ note: "розмите фото" });
  assert.equal(rj.body.status, "missing"); assert.equal(rj.body.reviewNote, "розмите фото"); assert.equal(rj.body.verifiedAt, null);
  const [lg2] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, w.id));
  assert.equal(lg2?.work, "unknown");
  const actions = (await db.select().from(documentAuditTable).where(eq(documentAuditTable.documentId, pend!.id))).map(a => a.action);
  assert.deepEqual(actions, ["verified", "rejected"]);
});

test("status-map: без правила — дефолти коду; версія payroll.status_map перекриває studentMaxAge/manualOnly", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const before = await request(app).get("/api/legalization/status-map").set("Cookie", owner.cookie);
  assert.equal(before.status, 200); assert.equal(before.body.overridden, false); assert.equal(before.body.studentMaxAge, 26);
  assert.equal(before.body.statuses.find((s: any) => s.status === "student").manualOnly, false);
  const c = await request(app).post("/api/legal-rules").set("Cookie", owner.cookie).set(H)
    .send({ code: "payroll.status_map", kind: "global", axis: null, conditions: { studentMaxAge: 30, statuses: [{ status: "student", manualOnly: true }] }, effectiveFrom: "2026-01-01" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const after = await request(app).get("/api/legalization/status-map").set("Cookie", owner.cookie);
  assert.equal(after.body.overridden, true); assert.equal(after.body.studentMaxAge, 30); assert.equal(after.body.rule.id, c.body.id);
  assert.equal(after.body.statuses.find((s: any) => s.status === "student").manualOnly, true);
  assert.equal(after.body.statuses.find((s: any) => s.status === "polak").precedence, 1, "незгадані статуси — з дефолтів");
});

test("правила: нова версія закриває попередню; PATCH править лише verified/note/isActive; умови — тільки версією", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const c = await request(app).post("/api/legal-rules").set("Cookie", owner.cookie).set(H)
    .send({ code: "global.ukr_status_end", kind: "global", axis: "stay", conditions: { date: "2028-03-04" }, effectiveFrom: "2027-03-05", source: "тест", verified: false });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body.verifiedAt, null);
  const versions = await db.select().from(legalRulesTable).where(eq(legalRulesTable.code, "global.ukr_status_end"));
  const old = versions.find(v => v.effectiveFrom === "2026-03-05")!; const nw = versions.find(v => v.effectiveFrom === "2027-03-05")!;
  assert.equal(old.effectiveTo, "2027-03-05"); assert.equal(nw.effectiveTo, null);
  assert.equal((await request(app).post("/api/legal-rules").set("Cookie", owner.cookie).set(H).send({ code: "bad code", kind: "global", conditions: {}, effectiveFrom: "2027-01-01" })).status, 400);
  assert.equal((await request(app).patch(`/api/legal-rules/${nw.id}`).set("Cookie", owner.cookie).set(H).send({ conditions: { date: "2030-01-01" } })).status, 400);
  const v = await request(app).patch(`/api/legal-rules/${nw.id}`).set("Cookie", owner.cookie).set(H).send({ verified: true, note: "юрист ок" });
  assert.ok(v.body.verifiedAt); assert.equal(v.body.note, "юрист ок");
});

test("дашборд + Excel + /attention", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const { w } = await seedUa();
  await db.insert(workersTable).values({ fullName: "Nowak Jan", nationality: "poland", isActive: true });
  const plus7 = new Date(Date.now() + 7 * 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
  await db.insert(workerDocumentsTable).values({ workerId: w.id, docTypeId: await typeId("trc"), title: "TRC", status: "present", expiresAt: plus7 });
  const ra = await request(app).post("/api/legalization/recompute-all").set("Cookie", owner.cookie).set(H);
  assert.equal(ra.body.total, 2);
  const d = await request(app).get("/api/legalization").set("Cookie", owner.cookie);
  assert.equal(d.status, 200); assert.equal(d.body.summary.total, 2); assert.equal(d.body.summary.legal, 1);
  const anna = d.body.rows.find((r: any) => r.id === w.id);
  assert.equal(anna.stayBasis.label, "Karta pobytu czasowego"); assert.equal(anna.stayBasis.until, plus7);
  assert.equal(anna.legality.stay, "expiring");
  assert.equal(anna.factoryName, "AGRAM"); assert.equal(anna.companyName, "ES");
  const jan = d.body.rows.find((r: any) => r.fullName === "Nowak Jan");
  assert.equal(jan.stayBasis.label, "Obywatel PL"); assert.equal(jan.legality.overall, "legal");
  const xl = await request(app).get("/api/legalization/excel").set("Cookie", owner.cookie);
  assert.equal(xl.status, 200); assert.match(xl.headers["content-type"], /spreadsheetml/);
  const att = await request(app).get("/api/attention").set("Cookie", owner.cookie);
  assert.equal(att.body.legalityIllegal, 1, "Anna: work unknown → у лічильнику без даних");
  assert.equal(att.body.legalityExpiring, 1, "TRC спливає через 7 днів → у лічильнику ≤14");
  assert.equal(typeof att.body.pendingDocUploads, "number");
});

test("GET /workers: зріз умов — umowa на фірму працівника (через фабрику) + сталий комплект", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const { w, es, eso } = await seedUa();
  const [fabEso] = await db.insert(factoriesTable).values({ name: "LST", companyId: eso.id }).returning();
  const { contractsTable } = await import("../test/harness.ts");
  await db.insert(contractsTable).values([
    { workerId: w.id, factoryId: fabEso!.id, status: "signed", dateTo: "2027-01-31" },   // інша фірма (ESO) — не рахується
    { workerId: w.id, factoryId: w.factoryId!, status: "worker_signed", dateTo: "2026-12-31" }, // ES — на підписі компанією
    { workerId: w.id, factoryId: null, status: "signed" },                                 // сталий комплект
  ]);
  const list = await request(app).get("/api/workers").set("Cookie", owner.cookie);
  const me = list.body.find((x: any) => x.id === w.id);
  assert.equal(me.contracts.umowa.status, "worker_signed"); assert.equal(me.contracts.umowa.factoryName, "AGRAM"); assert.equal(me.contracts.umowa.expired, false);
  assert.equal(me.contracts.package.status, "signed");
});

test("document-types: нові поля легалізації правляться; системний тип не видаляється, лише вимикається", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const id = await typeId("medical_exam");
  const p = await request(app).patch(`/api/document-types/${id}`).set("Cookie", owner.cookie).set(H)
    .send({ renewalLeadDays: 45, appliesToNationalities: ["non_eu"], category: "medical", grantsWork: false });
  assert.equal(p.status, 200); assert.equal(p.body.renewalLeadDays, 45); assert.deepEqual(p.body.appliesToNationalities, ["non_eu"]);
  assert.equal((await request(app).patch(`/api/document-types/${id}`).set("Cookie", owner.cookie).set(H).send({ category: "weird" })).status, 400);
  assert.equal((await request(app).patch(`/api/document-types/${id}`).set("Cookie", owner.cookie).set(H).send({ appliesToNationalities: ["mars"] })).status, 400);
  assert.equal((await request(app).delete(`/api/document-types/${id}`).set("Cookie", owner.cookie).set(H)).status, 400);
  const off = await request(app).patch(`/api/document-types/${id}`).set("Cookie", owner.cookie).set(H).send({ isActive: false });
  assert.equal(off.body.isActive, false);
});
