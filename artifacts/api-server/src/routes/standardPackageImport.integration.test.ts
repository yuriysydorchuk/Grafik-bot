// Імпорт сканів підписаного сталого пакета: POST /workers/:id/standard-package/import →
// contracts (factory_id NULL, signed, data.importedPackage) + файли як signedPath; вісь «умова»
// пакет умовою НЕ вважає; повторний скан того самого шаблону замінює файл; umowa-шаблон — 400.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, documentTemplatesTable, contractsTable, contractFilesTable } from "../test/harness.ts";
import { ensureUploadDirs, UPLOADS_ROOT } from "../lib/uploads.ts";
import { loadWorkerContracts } from "../services/legalityRecompute.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");
const PDF2 = Buffer.from("%PDF-1.4\n2 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");

let owner = "";
beforeEach(async () => { if (!hasTestDb) return; await resetDb(); ensureUploadDirs(); owner = (await seedAdmin({ role: "owner" })).cookie; });
after(async () => { if (hasTestDb) await closeDb(); });

test("сталий пакет подокументно: signed без фабрики, не umowa, повторний скан замінює, umowa-шаблон — 400", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Erik A", isActive: true }).returning();
  const [zus] = await db.insert(documentTemplatesTable).values({ kind: "zus", title: "Oświadczenie ZUS", body: { pl: "<p>x</p>" } }).returning();
  const [tax] = await db.insert(documentTemplatesTable).values({ kind: "tax", title: "PIT-2", body: { pl: "<p>x</p>" } }).returning();
  const [umowa] = await db.insert(documentTemplatesTable).values({ kind: "umowa", title: "Umowa", body: { pl: "<p>x</p>" } }).returning();

  const r = await request(app).post(`/api/workers/${w!.id}/standard-package/import`).set("Cookie", owner).set(H)
    .field("items", JSON.stringify([{ templateId: zus!.id }, { templateId: tax!.id }])).field("signedAt", "2026-06-01").field("note", "скан з папки")
    .attach("files", PDF, "zus.pdf").attach("files", PDF, "pit.pdf");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "signed"); assert.equal(r.body.factoryId, null); assert.equal(r.body.created, true); assert.equal(r.body.added, 2);
  const [c] = await db.select().from(contractsTable).where(eq(contractsTable.id, r.body.id));
  assert.equal((c!.data as any).importedPackage, true); assert.equal((c!.data as any).imported, undefined, "НЕ позначка умови");
  assert.ok(c!.companySignedAt);
  const files = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, c!.id)).orderBy(contractFilesTable.sortOrder);
  assert.equal(files.length, 2);
  assert.equal(files[0]!.title, "Oświadczenie ZUS (skan podpisany)"); assert.equal(files[0]!.templateId, zus!.id);
  for (const f of files) { assert.ok(f.signedPath && f.signedSha256); assert.ok(fs.existsSync(path.join(UPLOADS_ROOT, f.signedPath!))); }
  // вісь «умова»: сталий пакет — не umowa
  const lc = await loadWorkerContracts(w!.id);
  assert.equal(lc.length, 1); assert.equal(lc[0]!.hasUmowa, false);
  // віддається тим самим маршрутом файлів
  const dl = await request(app).get(`/api/contracts/${c!.id}/files/${files[0]!.id}`).set("Cookie", owner);
  assert.equal(dl.status, 200); assert.equal(dl.headers["content-type"], "application/pdf");

  // повторний скан ZUS → замінює файл (той самий рядок, інший sha), старий файл з диска прибрано
  const oldPath = files[0]!.signedPath!;
  const r2 = await request(app).post(`/api/workers/${w!.id}/standard-package/import`).set("Cookie", owner).set(H)
    .field("items", JSON.stringify([{ templateId: zus!.id }])).attach("files", PDF2, "zus-v2.pdf");
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.id, c!.id); assert.equal(r2.body.created, false); assert.equal(r2.body.replaced, 1); assert.equal(r2.body.added, 0);
  const files2 = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, c!.id)).orderBy(contractFilesTable.sortOrder);
  assert.equal(files2.length, 2);
  assert.notEqual(files2[0]!.signedSha256, files[0]!.signedSha256);
  assert.equal(fs.existsSync(path.join(UPLOADS_ROOT, oldPath)), false, "старий скан прибрано");

  // шаблон виду umowa — не частина пакета
  const bad = await request(app).post(`/api/workers/${w!.id}/standard-package/import`).set("Cookie", owner).set(H)
    .field("items", JSON.stringify([{ templateId: umowa!.id }])).attach("files", PDF, "u.pdf");
  assert.equal(bad.status, 400);
  assert.equal((await db.select().from(contractsTable)).length, 1, "нового рядка не зʼявилось");
});

test("весь пакет одним файлом без типу; без файлів і не-PDF — 400", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Erik A", isActive: true }).returning();
  const r = await request(app).post(`/api/workers/${w!.id}/standard-package/import`).set("Cookie", owner).set(H)
    .field("items", JSON.stringify([{ templateId: null, title: "Pakiet standardowy (skan podpisany)" }])).field("dateTo", "2027-01-31")
    .attach("files", PDF, "pakiet.pdf");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.files.length, 1); assert.equal(r.body.files[0].title, "Pakiet standardowy (skan podpisany)"); assert.equal(r.body.files[0].templateId, null);
  assert.equal(r.body.dateTo, "2027-01-31");

  const none = await request(app).post(`/api/workers/${w!.id}/standard-package/import`).set("Cookie", owner).set(H).field("items", "[]");
  assert.equal(none.status, 400);
  const notPdf = await request(app).post(`/api/workers/${w!.id}/standard-package/import`).set("Cookie", owner).set(H)
    .attach("files", Buffer.from("<html>"), "x.pdf");
  assert.equal(notPdf.status, 400);
  const badDate = await request(app).post(`/api/workers/${w!.id}/standard-package/import`).set("Cookie", owner).set(H)
    .field("dateTo", "2026-02-31").attach("files", PDF, "p.pdf");
  assert.equal(badDate.status, 400);
  const badMonth = await request(app).post(`/api/workers/${w!.id}/standard-package/import`).set("Cookie", owner).set(H)
    .field("signedAt", "2026-13-01").attach("files", PDF, "p.pdf");
  assert.equal(badMonth.status, 400, "невалідний місяць — 400, не 500");
  const twiceItems = await request(app).post(`/api/workers/${w!.id}/standard-package/import`).set("Cookie", owner).set(H)
    .field("items", "[]").field("items", "[]").attach("files", PDF, "p.pdf");
  assert.equal(twiceItems.status, 400, "повторне поле items — 400");
  assert.equal((await db.select().from(contractsTable)).length, 1);
  // довантаження в імпортований пакет оновлює «дійсний до»
  const more = await request(app).post(`/api/workers/${w!.id}/standard-package/import`).set("Cookie", owner).set(H)
    .field("items", JSON.stringify([{ templateId: null, title: "Załącznik" }])).field("dateTo", "2027-06-30").attach("files", PDF2, "z.pdf");
  assert.equal(more.status, 200, JSON.stringify(more.body));
  assert.equal(more.body.id, r.body.id); assert.equal(more.body.dateTo, "2027-06-30"); assert.equal(more.body.files.length, 2);
});
