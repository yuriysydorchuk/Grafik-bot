import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { PDFDocument } from "pdf-lib";
import {
  app, hasTestDb, resetDb, closeDb, seedAdmin, seedRole, db,
  workersTable, factoriesTable, companiesTable, workerQuestionnairesTable,
  contractsTable, contractFilesTable, signatureTokensTable, signatureEventsTable,
} from "../test/harness.ts";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { ensureUploadDirs, UPLOADS_ROOT } from "../lib/uploads.ts";
import { seedTestDocumentTemplates } from "../services/testTemplateFixtures.ts";
import { closeBrowser } from "../services/contracts.ts";

// Онлайн-підписання (§5/§10 плану worker-docs-signing): send створює токен,
// публічний /api/sign/:token (БЕЗ сесії) — перегляд/згода/підпис/відмова,
// одноразовість токена, supersedes при підписанні нової умови.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
// Мінімальний валідний 1×1 PNG (загальновідома тестова константа) — потрібен
// pdf-lib.embedPng, який (на відміну від sniffDocMime) парсить реальні чанки.
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let owner = "";
before(() => { if (hasTestDb) ensureUploadDirs(); });
beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb();
  owner = (await seedAdmin({ role: "owner" })).cookie;
  await seedTestDocumentTemplates();
});
after(async () => { if (hasTestDb) { await closeBrowser(); await closeDb(); } });

async function mkFactory(name = "Fabryka Testowa"): Promise<{ factoryId: number; companyId: number }> {
  const [co] = await db.insert(companiesTable).values({ name: "Euro Support", legalName: "Euro Support Sp. z o.o.", nip: "9462698100" }).returning({ id: companiesTable.id });
  const [fa] = await db.insert(factoriesTable).values({ name, address: "Poznań", companyId: co!.id }).returning({ id: factoriesTable.id });
  return { factoryId: fa!.id, companyId: co!.id };
}

async function mkVerifiedWorker(companyId: number, factoryId?: number): Promise<number> {
  const [w] = await db.insert(workersTable).values({
    fullName: "JAN KOWALSKI", pesel: "90010112345", birthDate: "1990-01-01", hourlyRate: 28.5, companyId, factoryId,
  }).returning({ id: workersTable.id });
  await db.insert(workerQuestionnairesTable).values({
    workerId: w!.id, status: "verified",
    passportNumber: "AB1234567", addressPl: "ul. Testowa 1, Warszawa",
    taxOffice: "US Poznań", nfzBranch: "Wielkopolski",
  });
  return w!.id;
}

// draft → approved → sent, повертає {contractId, token}
async function mkSentContract(workerId: number, factoryId: number): Promise<{ contractId: number; token: string }> {
  const gen = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId, dateFrom: "2026-09-01" });
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  const id = gen.body.id;
  await request(app).post(`/api/contracts/${id}/approve`).set("Cookie", owner).set(H);
  const sent = await request(app).post(`/api/contracts/${id}/send`).set("Cookie", owner).set(H);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return { contractId: id, token: sent.body.token };
}

test("send: працює одразу з draft (submit/approve НЕ обов'язкові — одна кнопка «Надіслати на підпис»); термінальний статус — 400", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const gen = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H).send({ factoryId, dateFrom: "2026-09-01" });

  const sent = await request(app).post(`/api/contracts/${gen.body.id}/send`).set("Cookie", owner).set(H);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.status, "sent");
  assert.ok(sent.body.token);
  assert.equal(sent.body.notified, false, "без WEB_APP_URL/telegramId у тестовому середовищі — не надіслано");

  await request(app).post(`/api/contracts/${gen.body.id}/cancel`).set("Cookie", owner).set(H);
  const tooLate = await request(app).post(`/api/contracts/${gen.body.id}/send`).set("Cookie", owner).set(H);
  assert.equal(tooLate.status, 400, "термінальний статус — надіслати вже не можна");
});

test("send: submit/approve лишились доступні окремо (draft → pending_approval → approved → send), для команд з внутрішнім рев'ю", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const gen = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H).send({ factoryId, dateFrom: "2026-09-01" });

  await request(app).post(`/api/contracts/${gen.body.id}/submit`).set("Cookie", owner).set(H);
  await request(app).post(`/api/contracts/${gen.body.id}/approve`).set("Cookie", owner).set(H);
  const sent = await request(app).post(`/api/contracts/${gen.body.id}/send`).set("Cookie", owner).set(H);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, "sent");
});

test("send: гейт workerDocs — 403 без capability", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const gen = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H).send({ factoryId, dateFrom: "2026-09-01" });
  await request(app).post(`/api/contracts/${gen.body.id}/approve`).set("Cookie", owner).set(H);
  await seedRole("plain4", [], ["/"]);
  const plain = (await seedAdmin({ role: "plain4" })).cookie;
  const res = await request(app).post(`/api/contracts/${gen.body.id}/send`).set("Cookie", plain).set(H);
  assert.equal(res.status, 403);
});

test("публічний /api/sign/:token: працює БЕЗ будь-якого cookie (токен — єдина авторизація)", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const { token } = await mkSentContract(workerId, factoryId);

  const meta = await request(app).get(`/api/sign/${token}`); // без .set("Cookie", ...)
  assert.equal(meta.status, 200);
  assert.equal(meta.body.workerName, "JAN KOWALSKI");
  assert.equal(meta.body.files.length, 2, "факторі-пакет: umowa+regulamin");

  const [row] = await db.select().from(signatureTokensTable).where(eq(signatureTokensTable.token, token));
  assert.equal(row!.viewCount, 1);
});

test("повний цикл: перегляд файлу → consent → sign → contract=worker_signed (НЕ signed — компанія ще не підписала), файли мають signedSha256, токен одноразовий", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const { contractId, token } = await mkSentContract(workerId, factoryId);

  const meta = await request(app).get(`/api/sign/${token}`);
  const fileId = meta.body.files[0].id;

  const fileRes = await request(app).get(`/api/sign/${token}/file/${fileId}`);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers["x-content-type-options"], "nosniff");
  assert.equal(fileRes.headers["cache-control"], "no-store");
  assert.ok((fileRes.body as Buffer).toString("latin1", 0, 4) === "%PDF");

  // без consent_given — сервер відмовляє, не довіряючи лише клієнтському стану
  const tooEarly = await request(app).post(`/api/sign/${token}`).set(H).send({ signature: TINY_PNG });
  assert.equal(tooEarly.status, 400);

  const consent = await request(app).post(`/api/sign/${token}/consent`).set(H);
  assert.equal(consent.status, 200);

  const signed = await request(app).post(`/api/sign/${token}`).set(H).send({ signature: TINY_PNG });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.signedFiles, 2, "обидва файли мають {%Podpis odręczny pracownika%}");

  const [contract] = await db.select().from(contractsTable).where(eq(contractsTable.id, contractId));
  assert.equal(contract!.status, "worker_signed", "компанія ще не підписала — умова не термінальна");
  assert.ok(contract!.signedAt, "дата підпису ПРАЦІВНИКА фіксується одразу");
  assert.equal(contract!.companySignedAt, null);

  const files = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, contractId));
  for (const f of files) {
    assert.ok(f.signedPath, `${f.title}: signedPath має бути записаний`);
    assert.ok(f.signedSha256, `${f.title}: signedSha256 має бути записаний`);
  }

  // сфлетенений підписаний PDF — без живих AcroForm-полів
  const signedFile = await request(app).get(`/api/sign/${token}/file/${fileId}`);
  assert.equal(signedFile.status, 404, "токен уже використаний — повторний перегляд за ним недоступний");

  const signedBytes = await fs.promises.readFile(path.join(UPLOADS_ROOT, files[0]!.signedPath!));
  const doc = await PDFDocument.load(signedBytes);
  assert.equal(doc.getForm().getFields().length, 0, "підписаний файл мусить бути сфлетенений");

  const [tokenRow] = await db.select().from(signatureTokensTable).where(eq(signatureTokensTable.token, token));
  assert.ok(tokenRow!.usedAt, "токен має стати використаним");

  const events = await db.select({ event: signatureEventsTable.event }).from(signatureEventsTable).where(eq(signatureEventsTable.contractId, contractId));
  assert.ok(events.some(e => e.event === "signed"));
  assert.ok(events.some(e => e.event === "consent_given"));
  assert.ok(events.some(e => e.event === "doc_viewed"));
});

test("комплект (факторі-пакет + сталий пакет) підписується ОДНІЄЮ сесією — один send, один token, одне sign на обидва", opts, async () => {
  const { factoryId, companyId } = await mkFactory("AGRAM LUBLIN");
  const workerId = await mkVerifiedWorker(companyId, factoryId);

  const genFactory = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId, dateFrom: "2026-09-01" });
  assert.equal(genFactory.status, 200, JSON.stringify(genFactory.body));
  const genStandard = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId: null });
  assert.equal(genStandard.status, 200, JSON.stringify(genStandard.body));

  // Надсилаємо лише факторі-пакет — сталий (той самий workerId, теж sendable) мусить піти РАЗОМ, одним токеном.
  const sent = await request(app).post(`/api/contracts/${genFactory.body.id}/send`).set("Cookie", owner).set(H);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.bundledCount, 1, "сталий пакет мав приєднатися до відправки");
  const token = sent.body.token;

  const [factoryContract] = await db.select().from(contractsTable).where(eq(contractsTable.id, genFactory.body.id));
  const [standardContract] = await db.select().from(contractsTable).where(eq(contractsTable.id, genStandard.body.id));
  assert.equal(factoryContract!.status, "sent");
  assert.equal(standardContract!.status, "sent", "сталий пакет теж мав стати sent — не лишається draft окремо");

  // Один /sign/:token бачить файли ОБОХ пакетів, з групуванням по назві пакета.
  const meta = await request(app).get(`/api/sign/${token}`);
  assert.equal(meta.status, 200);
  const groups = new Set(meta.body.files.map((f: any) => f.groupLabel));
  assert.ok(groups.has("AGRAM LUBLIN"), "файли факторі-пакета позначені назвою фабрики");
  assert.ok(groups.has("Стандартний пакет"), "файли сталого пакета позначені як стандартний");
  assert.equal(meta.body.files.length, 4, "2 файли факторі-пакета (umowa+regulamin) + 2 файли сталого (zus+ppk)");

  await request(app).post(`/api/sign/${token}/consent`).set(H);
  const signed = await request(app).post(`/api/sign/${token}`).set(H).send({ signature: TINY_PNG });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.signedFiles, 4, "усі 4 файли обох пакетів мають бути підписані однією дією");

  const [factoryAfter] = await db.select().from(contractsTable).where(eq(contractsTable.id, genFactory.body.id));
  const [standardAfter] = await db.select().from(contractsTable).where(eq(contractsTable.id, genStandard.body.id));
  assert.equal(factoryAfter!.status, "worker_signed");
  assert.equal(standardAfter!.status, "worker_signed", "сталий пакет теж worker_signed — не лишився sent, чекаючи окремого підпису");
});

// ── /contracts/:id/finalize (компанія підписує У ВІДПОВІДЬ, §ще один план) ──
test("finalize: дозволено лише з worker_signed; ставить companySignedAt/By, статус → signed", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const { contractId, token } = await mkSentContract(workerId, factoryId);

  const tooEarly = await request(app).post(`/api/contracts/${contractId}/finalize`).set("Cookie", owner).set(H);
  assert.equal(tooEarly.status, 400, "компанія не може підписати раніше за працівника");

  await request(app).post(`/api/sign/${token}/consent`).set(H);
  await request(app).post(`/api/sign/${token}`).set(H).send({ signature: TINY_PNG });

  const finalized = await request(app).post(`/api/contracts/${contractId}/finalize`).set("Cookie", owner).set(H);
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  assert.equal(finalized.body.status, "signed");
  assert.ok(finalized.body.companySignedAt);
  assert.ok(finalized.body.companySignedBy);

  const again = await request(app).post(`/api/contracts/${contractId}/finalize`).set("Cookie", owner).set(H);
  assert.equal(again.status, 400, "signed — уже термінальний, повторний finalize неможливий");
});

test("finalize: гейт workerDocs — 403 без capability", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const { contractId, token } = await mkSentContract(workerId, factoryId);
  await request(app).post(`/api/sign/${token}/consent`).set(H);
  await request(app).post(`/api/sign/${token}`).set(H).send({ signature: TINY_PNG });

  await seedRole("plain5", [], ["/"]);
  const plain = (await seedAdmin({ role: "plain5" })).cookie;
  const res = await request(app).post(`/api/contracts/${contractId}/finalize`).set("Cookie", plain).set(H);
  assert.equal(res.status, 403);
});

test("decline: статус → declined, токен ревокується", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const { contractId, token } = await mkSentContract(workerId, factoryId);

  const res = await request(app).post(`/api/sign/${token}/decline`).set(H).send({ reason: "не згоден зі ставкою" });
  assert.equal(res.status, 200);

  const [contract] = await db.select().from(contractsTable).where(eq(contractsTable.id, contractId));
  assert.equal(contract!.status, "declined");
  assert.equal(contract!.declineReason, "не згоден зі ставкою");

  const again = await request(app).get(`/api/sign/${token}`);
  assert.equal(again.status, 404);
});

test("протермінований токен відхиляється", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const { token } = await mkSentContract(workerId, factoryId);
  await db.update(signatureTokensTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(signatureTokensTable.token, token));

  const res = await request(app).get(`/api/sign/${token}`);
  assert.equal(res.status, 404);
});

test("повторний send ревокує попередній токен цієї умови", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const { contractId, token: firstToken } = await mkSentContract(workerId, factoryId);

  // повертаємо статус на approved, щоб дозволити повторний send (сервер вимагає approved)
  await db.update(contractsTable).set({ status: "approved" }).where(eq(contractsTable.id, contractId));
  const second = await request(app).post(`/api/contracts/${contractId}/send`).set("Cookie", owner).set(H);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.token, firstToken);

  const oldStillWorks = await request(app).get(`/api/sign/${firstToken}`);
  assert.equal(oldStillWorks.status, 404, "старий токен має бути ревокований новим send");
});

test("supersedes: супersede-ить лише коли компанія ЗАВЕРШИЛА підпис нової умови (finalize), не при самому підписі працівника", opts, async () => {
  const { factoryId, companyId } = await mkFactory();
  const workerId = await mkVerifiedWorker(companyId);
  const { contractId: firstId, token: firstToken } = await mkSentContract(workerId, factoryId);
  await request(app).post(`/api/sign/${firstToken}/consent`).set(H);
  await request(app).post(`/api/sign/${firstToken}`).set(H).send({ signature: TINY_PNG });

  const gen2 = await request(app).post(`/api/workers/${workerId}/contracts`).set("Cookie", owner).set(H)
    .send({ factoryId, dateFrom: "2026-12-01", supersedesId: firstId });
  assert.equal(gen2.status, 200);
  await request(app).post(`/api/contracts/${gen2.body.id}/approve`).set("Cookie", owner).set(H);
  const sent2 = await request(app).post(`/api/contracts/${gen2.body.id}/send`).set("Cookie", owner).set(H);
  await request(app).post(`/api/sign/${sent2.body.token}/consent`).set(H);
  await request(app).post(`/api/sign/${sent2.body.token}`).set(H).send({ signature: TINY_PNG });

  const [stillOld] = await db.select().from(contractsTable).where(eq(contractsTable.id, firstId));
  assert.equal(stillOld!.status, "worker_signed", "стара умова НЕ супersede-иться, поки нова не пройде finalize");

  await request(app).post(`/api/contracts/${gen2.body.id}/finalize`).set("Cookie", owner).set(H);

  const [old] = await db.select().from(contractsTable).where(eq(contractsTable.id, firstId));
  assert.equal(old!.status, "superseded");
  assert.ok(old!.supersededAt);
});
