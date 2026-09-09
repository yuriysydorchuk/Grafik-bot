// Імпорт уже підписаної умови (скан PDF): POST /workers/:id/contracts/import →
// status=signed, файл як signedPath пакета, вісь «умова» бачить її як umowa (data.imported).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, factoriesTable, companiesTable, contractsTable, contractFilesTable } from "../test/harness.ts";
import { ensureUploadDirs, UPLOADS_ROOT } from "../lib/uploads.ts";
import { loadWorkerContracts } from "../services/legalityRecompute.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");

let owner = "";
beforeEach(async () => { if (!hasTestDb) return; await resetDb(); ensureUploadDirs(); owner = (await seedAdmin({ role: "owner" })).cookie; });
after(async () => { if (hasTestDb) await closeDb(); });

test("імпорт підписаної умови: signed + файл + hasUmowa; не-PDF і без фабрики — 400", opts, async () => {
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "LST", companyId: co!.id }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Erik A", factoryId: fa!.id, companyId: co!.id, isActive: true }).returning();
  const r = await request(app).post(`/api/workers/${w!.id}/contracts/import`).set("Cookie", owner).set(H)
    .field("factoryId", String(fa!.id)).field("companyId", String(co!.id)).field("dateFrom", "2026-06-01").field("dateTo", "2027-03-24").field("note", "скан з папки")
    .attach("file", PDF, "umowa Erik.pdf");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "signed"); assert.equal(r.body.factoryName, "LST"); assert.equal(r.body.dateFrom, "2026-06-01");
  const [c] = await db.select().from(contractsTable).where(eq(contractsTable.id, r.body.id));
  assert.equal((c!.data as any).imported, true); assert.ok(c!.companySignedAt);
  const [f] = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, c!.id));
  assert.ok(f?.signedPath && f.signedSha256, "файл записано як підписаний");
  assert.ok(fs.existsSync(path.join(UPLOADS_ROOT, f!.signedPath!)));
  // віддається тим самим маршрутом, що й згенеровані пакети
  const dl = await request(app).get(`/api/contracts/${c!.id}/files/${f!.id}`).set("Cookie", owner);
  assert.equal(dl.status, 200); assert.equal(dl.headers["content-type"], "application/pdf");
  // вісь «умова»: імпортована — це umowa
  const lc = await loadWorkerContracts(w!.id);
  assert.equal(lc.length, 1); assert.equal(lc[0]!.hasUmowa, true); assert.equal(lc[0]!.status, "signed");

  const bad = await request(app).post(`/api/workers/${w!.id}/contracts/import`).set("Cookie", owner).set(H)
    .field("factoryId", String(fa!.id)).field("companyId", String(co!.id)).field("dateFrom", "2026-06-01").attach("file", Buffer.from("<html>"), "x.pdf");
  assert.equal(bad.status, 400, "не PDF за вмістом");
  const noFactory = await request(app).post(`/api/workers/${w!.id}/contracts/import`).set("Cookie", owner).set(H)
    .field("companyId", String(co!.id)).field("dateFrom", "2026-06-01").attach("file", PDF, "u.pdf");
  assert.equal(noFactory.status, 400);
});

test("імпорт: невалідна дата → 400, а не тиха безстрокова", opts, async () => {
  const [co] = await db.insert(companiesTable).values({ name: "ES" }).returning();
  const [fa] = await db.insert(factoriesTable).values({ name: "LST", companyId: co!.id }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Erik A", factoryId: fa!.id, isActive: true }).returning();
  const r = await request(app).post(`/api/workers/${w!.id}/contracts/import`).set("Cookie", owner).set(H)
    .field("factoryId", String(fa!.id)).field("companyId", String(co!.id)).field("dateFrom", "2026-06-01").field("dateTo", "2026-02-31").attach("file", PDF, "u.pdf");
  assert.equal(r.status, 400);
  assert.equal((await db.select().from(contractsTable)).length, 0);
});
