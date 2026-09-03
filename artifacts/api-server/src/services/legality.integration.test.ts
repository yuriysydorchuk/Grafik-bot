// Інтеграційні тести обгортки движка легальності над БД (legalityRecompute.ts)
// + бекфіл code в ensureDocumentType + звірка TS-сіду з SQL-сідом.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  hasTestDb, resetDb, closeDb, db, workersTable, companiesTable, documentTypesTable, workerDocumentsTable,
  workerChangesTable, workerLegalityTable, legalRulesTable,
} from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { seedLegalizationCatalog, DOCUMENT_TYPE_SEED } from "./legalizationSeed.ts";
import { recomputeWorkerLegality, recomputeAllActiveLegality, employerSinceOf } from "./legalityRecompute.ts";
import { ensureDocumentType } from "./workerDocuments.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); await seedLegalizationCatalog(); } });
after(async () => { if (hasTestDb) await closeDb(); });

const typeId = async (code: string) => (await db.select({ id: documentTypesTable.id }).from(documentTypesTable).where(eq(documentTypesTable.code, code)))[0]!.id;

test("сід: усі коди TS-каталогу є в БД, правила накатані", opts, async () => {
  const codes = new Set((await db.select({ code: documentTypesTable.code }).from(documentTypesTable)).map(r => r.code));
  for (const t of DOCUMENT_TYPE_SEED) assert.ok(codes.has(t.code), `бракує типу ${t.code}`);
  assert.equal((await db.select().from(legalRulesTable)).length, 10);
  await seedLegalizationCatalog(); // ідемпотентно
  assert.equal((await db.select().from(legalRulesTable)).length, 10);
});

test("ensureDocumentType: легасі-рядок «Paszport» без code отримує code, не дублюється", opts, async () => {
  await db.delete(documentTypesTable).where(eq(documentTypesTable.code, "passport"));
  const [legacy] = await db.insert(documentTypesTable).values({ name: "Paszport", required: true, hasExpiry: true, icon: "passport" }).returning();
  const t = await ensureDocumentType("passport");
  assert.equal(t.id, legacy!.id); assert.equal(t.code, "passport"); assert.equal(t.category, "identity");
  assert.equal((await db.select().from(documentTypesTable).where(eq(documentTypesTable.name, "Paszport"))).length, 1);
  // невідомий код — помилка, а не тихий рядок
  await assert.rejects(() => ensureDocumentType("nope"), /Невідомий код/);
});

test("recompute: UA + status_ukr + powiadomienie на нашу фірму → кеш overall=legal; зміна фірми → work illegal, employerSince з журналу", opts, async () => {
  const [es, eso] = await db.insert(companiesTable).values([{ name: "ES" }, { name: "ESO" }]).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Test Ua", nationality: "ukraine", companyId: es!.id, employmentStartDate: "2026-01-10", isActive: true }).returning();
  await db.insert(workerDocumentsTable).values([
    { workerId: w!.id, docTypeId: await typeId("status_ukr"), title: "UKR", status: "present" },
    { workerId: w!.id, docTypeId: await typeId("powiadomienie_ua"), title: "POW", status: "present", employerCompanyId: es!.id, submittedAt: "2026-01-12" },
  ]);
  const r1 = await recomputeWorkerLegality(w!.id, "2026-09-02");
  assert.equal(r1?.overall, "legal");
  const [row1] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, w!.id));
  assert.equal(row1?.overall, "legal"); assert.equal(row1?.derivedLegalStatus, "powiadomienie"); assert.equal(row1?.nextExpiryAt, "2027-03-04");
  assert.equal(row1?.legacyMismatchKind, "cross_class"); // ручне NULL

  // перехід у ESO з 28.08 (журнал companyId) — старе powiadomienie більше не підстава
  await db.update(workersTable).set({ companyId: eso!.id }).where(eq(workersTable.id, w!.id));
  await db.insert(workerChangesTable).values({ workerId: w!.id, field: "companyId", oldValue: String(es!.id), newValue: String(eso!.id), effectiveDate: "2026-08-28" });
  assert.equal(await employerSinceOf({ id: w!.id, employmentStartDate: "2026-01-10" }), "2026-08-28");
  const r2 = await recomputeWorkerLegality(w!.id, "2026-09-02");
  assert.equal(r2?.work.status, "illegal");
  assert.ok(r2?.reasons.some(x => x.code === "employer_mismatch"));
  assert.equal(r2?.obligations[0]?.dueAt, "2026-09-04");
  const [row2] = await db.select().from(workerLegalityTable).where(eq(workerLegalityTable.workerId, w!.id));
  assert.equal(row2?.work, "illegal"); assert.notEqual(row2?.inputHash, row1?.inputHash);
});

test("TRC «z dostępem do rynku pracy» (attrs.laborMarketAccess) дає й працю; без атрибута — лише перебування", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Trc Georgia", nationality: "georgia", isActive: true }).returning();
  const [trc] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: await typeId("trc"), title: "TRC", status: "present", expiresAt: "2027-06-01" }).returning();
  const plain = await recomputeWorkerLegality(w!.id, "2026-09-03");
  assert.equal(plain?.stay.status, "legal"); assert.equal(plain?.work.status, "unknown");
  await db.update(workerDocumentsTable).set({ attrs: { laborMarketAccess: true } }).where(eq(workerDocumentsTable.id, trc!.id));
  const access = await recomputeWorkerLegality(w!.id, "2026-09-03");
  assert.equal(access?.work.status, "legal"); assert.equal(access?.work.basisDocId, trc!.id);
  assert.equal(access?.legacy.derivedLegalStatus, "karta_pobytu");
});

test("zaświadczenie студента: лише stationary дає працю; part_time/school — ні (payroll-ставка окремо)", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Student Georgia", nationality: "georgia", isActive: true }).returning();
  const [cert] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: await typeId("student_cert"), title: "Student", status: "present", expiresAt: "2027-02-28" }).returning();
  assert.equal((await recomputeWorkerLegality(w!.id, "2026-09-03"))?.work.status, "unknown", "без типу навчання — не підстава");
  await db.update(workerDocumentsTable).set({ attrs: { studyMode: "school" } }).where(eq(workerDocumentsTable.id, cert!.id));
  assert.equal((await recomputeWorkerLegality(w!.id, "2026-09-03"))?.work.status, "unknown", "школа/policealna — не підстава");
  await db.update(workerDocumentsTable).set({ attrs: { studyMode: "stationary" } }).where(eq(workerDocumentsTable.id, cert!.id));
  const r = await recomputeWorkerLegality(w!.id, "2026-09-03");
  assert.equal(r?.work.status, "legal"); assert.equal(r?.work.basisDocId, cert!.id);
});

test("recomputeAllActive: рахує активних, прибирає кеш звільнених, не чіпає workers.legal_status", opts, async () => {
  const [a, b] = await db.insert(workersTable).values([
    { fullName: "Active PL", nationality: "poland", isActive: true, legalStatus: "zus" },
    { fullName: "Fired", nationality: "poland", isActive: false },
  ]).returning();
  await db.insert(workerLegalityTable).values({ workerId: b!.id, stay: "legal", work: "legal", overall: "legal", computedAt: new Date() });
  const s = await recomputeAllActiveLegality("2026-09-02");
  assert.equal(s.total, 1); assert.equal(s.byOverall.legal, 1);
  const rows = await db.select().from(workerLegalityTable);
  assert.deepEqual(rows.map(r => r.workerId), [a!.id]);
  assert.equal(rows[0]?.derivedLegalStatus, "polak"); assert.equal(rows[0]?.legacyMismatchKind, "within_class");
  const [wa] = await db.select({ legalStatus: workersTable.legalStatus }).from(workersTable).where(eq(workersTable.id, a!.id));
  assert.equal(wa?.legalStatus, "zus", "движок не пише legal_status");
});
