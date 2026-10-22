// Історія анкети (20.10.2026): кожна зміна поля анкети — worker_changes `q.<поле>` (хто / з чого
// на що); незмінені поля не пишуться; працівник (onlyOverwrites) — лише заміна вписаного; записи
// q.* не відкочуються «Видалити зміну» і в історії профілю видні лише з cap workerDocs.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { and, eq, like } from "drizzle-orm";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, db, workersTable, workerChangesTable, rolesTable } from "../test/harness.ts";
import { journalQuestionnaire } from "../services/questionnaireJournal.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });
const H = { "X-Requested-With": "grafik" };

const qRows = (workerId: number) => db.select().from(workerChangesTable)
  .where(and(eq(workerChangesTable.workerId, workerId), like(workerChangesTable.field, "q.%")))
  .orderBy(workerChangesTable.id);

test("офісна правка анкети пише історію: хто, з чого на що; незмінене — ні", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  const [w] = await db.insert(workersTable).values({ fullName: "Kowal Taras", firstName: "Taras", lastName: "Kowal", isActive: true }).returning();
  const put = (body: object) => request(app).put(`/api/workers/${w!.id}/questionnaire`).set("Cookie", owner.cookie).set(H).send(body);

  assert.equal((await put({ phone: "+48 500 111 222" })).status, 200);
  assert.equal((await put({ phone: "+48 500 111 222", email: "t@k.pl", firstName: "Taras" })).status, 200);
  assert.equal((await put({ phone: "+48 600 333 444", firstName: "Tarass" })).status, 200);

  const rows = await qRows(w!.id);
  assert.deepEqual(rows.map(r => [r.field, r.oldValue, r.newValue]), [
    ["q.phone", null, "+48 500 111 222"],
    ["q.email", null, "t@k.pl"],
    ["q.phone", "+48 500 111 222", "+48 600 333 444"],
    ["q.firstName", "Taras", "Tarass"],
  ]);
  assert.ok(rows.every(r => r.adminId === owner.adminId));

  // підтвердження — статус в історію один раз
  await request(app).post(`/api/workers/${w!.id}/questionnaire/verify`).set("Cookie", owner.cookie).set(H);
  await request(app).post(`/api/workers/${w!.id}/questionnaire/verify`).set("Cookie", owner.cookie).set(H);
  const st = (await qRows(w!.id)).filter(r => r.field === "q.status");
  assert.deepEqual(st.map(r => [r.oldValue, r.newValue]), [["draft", "verified"]]);
  // перевірену анкету можна правити далі (статус не шлемо — він лишається verified)
  assert.equal((await put({ phone: "+48 700 000 000" })).status, 200);
});

test("працівник (onlyOverwrites): перше заповнення — не зміна; галочки — лише після першої подачі", opts, async () => {
  const [w] = await db.insert(workersTable).values({ fullName: "Nowak Anna", isActive: true }).returning();
  const before = { phone: null, email: "old@x.pl", isStudent: false, submittedAt: null };
  await journalQuestionnaire(w!.id, before, { phone: "+48 1", email: "new@x.pl", isStudent: true, consentsAt: new Date() }, null, { onlyOverwrites: true });
  assert.deepEqual((await qRows(w!.id)).map(r => [r.field, r.oldValue, r.newValue, r.adminId]), [["q.email", "old@x.pl", "new@x.pl", null]]);

  await journalQuestionnaire(w!.id, { ...before, submittedAt: new Date() }, { isStudent: true }, null, { onlyOverwrites: true });
  assert.deepEqual((await qRows(w!.id)).map(r => [r.field, r.oldValue, r.newValue]).at(-1), ["q.isStudent", "false", "true"]);

  // галочку до першої подачі поставив офіс — зняття працівником теж в історії
  await journalQuestionnaire(w!.id, { ...before, pit0: true }, { pit0: false }, null, { onlyOverwrites: true });
  assert.deepEqual((await qRows(w!.id)).map(r => [r.field, r.oldValue, r.newValue]).at(-1), ["q.pit0", "true", "false"]);
});

test("історія анкети: без workerDocs не видна, «Видалити зміну» — 400", opts, async () => {
  const owner = await seedAdmin({ role: "owner" });
  await db.insert(rolesTable).values({ key: "clerk", label: "clerk", caps: ["editData"], pages: ["/workers"] });
  const clerk = await seedAdmin({ role: "clerk" });
  const [w] = await db.insert(workersTable).values({ fullName: "Lis Olga", isActive: true }).returning();
  await request(app).put(`/api/workers/${w!.id}/questionnaire`).set("Cookie", owner.cookie).set(H).send({ bankIban: "PL61109010140000071219812874" });

  const asOwner = await request(app).get(`/api/workers/${w!.id}/changes`).set("Cookie", owner.cookie);
  assert.ok(asOwner.body.some((c: any) => c.field === "q.bankIban"));
  const asClerk = await request(app).get(`/api/workers/${w!.id}/changes`).set("Cookie", clerk.cookie);
  assert.equal(asClerk.status, 200);
  assert.ok(!asClerk.body.some((c: any) => c.field.startsWith("q.")), "IBAN/паспорт з історії анкети — лише з workerDocs");

  const [row] = await qRows(w!.id);
  const del = await request(app).delete(`/api/svodni/profile-change/${row!.id}`).set("Cookie", owner.cookie).set(H);
  assert.equal(del.status, 400);
  assert.equal((await qRows(w!.id)).length, 1);
});

test("новий паспорт підтверджено → розбіжність з анкетою; «Оновити анкету» — дані + історія, анкета лишається перевіреною", opts, async () => {
  const { documentTypesTable, workerDocumentsTable, workerQuestionnairesTable } = await import("../test/harness.ts");
  const owner = await seedAdmin({ role: "owner" });
  const [w] = await db.insert(workersTable).values({ fullName: "Koshmak Kira", isActive: true }).returning();
  await db.insert(workerQuestionnairesTable).values({ workerId: w!.id, status: "verified", passportNumber: "WR999667", passportExpiresAt: "2027-10-11" });
  const [pt] = await db.insert(documentTypesTable).values({ name: "Paszport", code: "passport", required: true, hasExpiry: true }).returning();
  const [doc] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: pt!.id, title: "Paszport", status: "pending", source: "worker_bot", number: "GM123354", expiresAt: "2035-07-14" }).returning();

  const v = await request(app).post(`/api/worker-documents/${doc!.id}/verify`).set("Cookie", owner.cookie).set(H);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual(v.body.questionnaireDiff.rows.map((r: any) => [r.field, r.questionnaire, r.document]), [
    ["passportNumber", "WR999667", "GM123354"], ["passportExpiresAt", "2027-10-11", "2035-07-14"],
  ]);
  const a = await request(app).post(`/api/worker-documents/${doc!.id}/apply-to-questionnaire`).set("Cookie", owner.cookie).set(H);
  assert.equal(a.status, 200);
  const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, w!.id));
  assert.equal(q!.passportNumber, "GM123354"); assert.equal(q!.passportExpiresAt, "2035-07-14"); assert.equal(q!.status, "verified");
  assert.deepEqual((await qRows(w!.id)).map(r => [r.field, r.oldValue, r.newValue, r.adminId]), [
    ["q.passportNumber", "WR999667", "GM123354", owner.adminId], ["q.passportExpiresAt", "2027-10-11", "2035-07-14", owner.adminId],
  ]);
  // повторне підтвердження — розбіжностей уже нема
  const v2 = await request(app).post(`/api/worker-documents/${doc!.id}/verify`).set("Cookie", owner.cookie).set(H);
  assert.equal(v2.body.questionnaireDiff, null);
});

test("оновити анкету можна лише з підтвердженого паспорта (pending/відхилений — 400)", opts, async () => {
  const { documentTypesTable, workerDocumentsTable } = await import("../test/harness.ts");
  const owner = await seedAdmin({ role: "owner" });
  const [w] = await db.insert(workersTable).values({ fullName: "Nowak Ola", isActive: true }).returning();
  const [pt] = await db.insert(documentTypesTable).values({ name: "Paszport", code: "passport", required: true, hasExpiry: true }).returning();
  const [doc] = await db.insert(workerDocumentsTable).values({ workerId: w!.id, docTypeId: pt!.id, title: "Paszport", status: "pending", source: "worker_bot", number: "GM1" }).returning();
  const a = await request(app).post(`/api/worker-documents/${doc!.id}/apply-to-questionnaire`).set("Cookie", owner.cookie).set(H);
  assert.equal(a.status, 400);
  assert.equal((await qRows(w!.id)).length, 0);
});
