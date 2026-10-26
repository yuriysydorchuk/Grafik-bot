import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, seedAdmin, closeDb, db, workersTable, workerDocumentsTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";
import { ensureUploadDirs } from "../lib/uploads.ts";

// Worker-document files: metadata CRUD plus the upload/download path that carries the
// stored-XSS hardening (content is validated by magic bytes, served with nosniff).
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

const PNG = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "latin1");

let owner = "";
before(() => { if (hasTestDb) ensureUploadDirs(); });
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  owner = (await seedAdmin({ role: "owner" })).cookie;
});
after(async () => { if (hasTestDb) await closeDb(); });

async function mkDoc(): Promise<number> {
  const [w] = await db.insert(workersTable).values({ fullName: "W" }).returning({ id: workersTable.id });
  const res = await request(app).post(`/api/workers/${w!.id}/documents`).set("Cookie", owner).set(H).send({ title: "Paszport" });
  return res.body.id;
}

test("document metadata: create requires a title", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "W" }).returning({ id: workersTable.id });
  const bad = await request(app).post(`/api/workers/${w!.id}/documents`).set("Cookie", owner).set(H).send({});
  assert.equal(bad.status, 400);
  const good = await request(app).post(`/api/workers/${w!.id}/documents`).set("Cookie", owner).set(H).send({ title: "Umowa" });
  assert.equal(good.status, 200);
});

test("upload accepts a real PNG and records its detected MIME", opts, async () => {
  const id = await mkDoc();
  const res = await request(app).post(`/api/worker-documents/${id}/file`).set("Cookie", owner).set(H)
    .attach("file", PNG, "scan.png");
  assert.equal(res.status, 200);
  const [doc] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  assert.equal(doc!.fileMime, "image/png");
  assert.ok(doc!.filePath, "a stored file path is recorded");
});

test("upload rejects HTML content mislabeled as a PDF (magic-byte check)", opts, async () => {
  const id = await mkDoc();
  const res = await request(app).post(`/api/worker-documents/${id}/file`).set("Cookie", owner).set(H)
    .attach("file", Buffer.from("<html><script>alert(1)</script></html>"), { filename: "evil.pdf", contentType: "application/pdf" });
  assert.equal(res.status, 400);
});

test("download streams the file with X-Content-Type-Options: nosniff", opts, async () => {
  const id = await mkDoc();
  await request(app).post(`/api/worker-documents/${id}/file`).set("Cookie", owner).set(H).attach("file", PNG, "scan.png");

  const res = await request(app).get(`/api/worker-documents/${id}/file`).set("Cookie", owner);
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["content-type"], "image/png");
  assert.ok(res.body.equals(PNG), "the served bytes match what was uploaded");
});

test("document file endpoints require authentication", opts, async () => {
  const id = await mkDoc();
  assert.equal((await request(app).get(`/api/worker-documents/${id}/file`)).status, 401);
});

test("PATCH: «власний» документ можна перевести в каталожний тип — doc_type_id і назва оновлюються (баг 10.09.2026)", opts, async () => {
  const { documentTypesTable } = await import("../test/harness.ts");
  const { seedLegalizationCatalog } = await import("../services/legalizationSeed.ts");
  await seedLegalizationCatalog();
  const id = await mkDoc(); // docTypeId = null, title "Paszport"
  const [zez] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.code, "zezwolenie_a"));
  const r = await request(app).patch(`/api/worker-documents/${id}`).set("Cookie", owner).set(H).send({ docTypeId: zez!.id, title: zez!.name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [d] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  assert.equal(d!.docTypeId, zez!.id); assert.equal(d!.title, zez!.name);
  // назад у «власний» — тип знімається; неіснуючий тип — 404
  assert.equal((await request(app).patch(`/api/worker-documents/${id}`).set("Cookie", owner).set(H).send({ docTypeId: null, title: "Inny" })).status, 200);
  assert.equal((await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id)))[0]!.docTypeId, null);
  assert.equal((await request(app).patch(`/api/worker-documents/${id}`).set("Cookie", owner).set(H).send({ docTypeId: 999999 })).status, 404);
});

// Заміна файлу не видаляє попередній (рішення власника 26.10.2026): старий лягає в attrs.previousFiles,
// віддається GET /worker-documents/:id/file/prev/:idx; PATCH /legal {attrs:null} історію не стирає
test("replace keeps the previous file as a version; legal attrs reset keeps the history", opts, async () => {
  const id = await mkDoc();
  await request(app).post(`/api/worker-documents/${id}/file`).set("Cookie", owner).set(H).attach("file", PNG, "v1.png");
  const [d1] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  const r = await request(app).post(`/api/worker-documents/${id}/file`).set("Cookie", owner).set(H).attach("file", PNG, "v2.png");
  assert.equal(r.status, 200);
  const [d2] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  assert.notEqual(d2!.filePath, d1!.filePath);
  const prev = (d2!.attrs as any)?.previousFiles as any[];
  assert.equal(prev?.length, 1); assert.equal(prev[0].filePath, d1!.filePath); assert.equal(prev[0].fileName, "v1.png");
  const dl = await request(app).get(`/api/worker-documents/${id}/file/prev/0?download=1`).set("Cookie", owner);
  assert.equal(dl.status, 200); assert.match(dl.headers["content-disposition"] ?? "", /attachment/);
  assert.equal((await request(app).get(`/api/worker-documents/${id}/file/prev/5`).set("Cookie", owner)).status, 404);
  const reset = await request(app).patch(`/api/worker-documents/${id}/legal`).set("Cookie", owner).set(H).send({ attrs: null });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const [d3] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  assert.equal(((d3!.attrs as any)?.previousFiles as any[])?.length, 1, "історія файлів пережила скидання attrs");
});
