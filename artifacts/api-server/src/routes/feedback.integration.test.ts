// Зголошення з панелі (routes/feedback.ts): створення будь-якою роллю (вкл. readOnly),
// «мої»/по сторінці/голос, адмінські статуси, підтвердження автора, імпорт результату тріажу.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, hasTestDb, resetDb, closeDb, seedAdmin, seedRole, db } from "../test/harness.ts";
import { feedbackReportsTable, feedbackCommentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" };

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

const body = (over: Record<string, unknown> = {}) => ({
  kind: "bug", severity: "hinders", aboutPage: true, pagePath: "/schedule", pageLabel: "Графіки", pageUrl: "http://x/schedule?factoryId=3",
  pageFilters: { factoryId: "3", selects: { "Фабрика": "AGRAM LUBLIN" } },
  description: "Тиждень скочив назад після зміни фабрики", steps: "Змінила фабрику", expected: "Тиждень лишається",
  context: { ua: "test", screen: "1x1", failedRequests: [{ method: "POST", path: "/schedule/generate", status: 500, reqId: "abc", t: "t" }] },
  breadcrumbs: [{ t: "t", type: "click", text: "button «Доповнити»" }], buildVersion: "abc1234 2026-10-29", ...over,
});

test("feedback: будь-яка роль створює, бачить свої й по сторінці, інший голосує", opts, async () => {
  await seedRole("scheduler", ["editData"], ["/", "/schedule"], []);
  const a = await seedAdmin({ role: "scheduler", name: "Marta" });
  const b = await seedAdmin({ role: "scheduler", name: "Oksana" });
  const c = await request(app).post("/api/feedback").set("Cookie", a.cookie).set(H).send(body());
  assert.equal(c.status, 200, c.text);
  const id = c.body.id;
  const mine = await request(app).get("/api/feedback/mine").set("Cookie", a.cookie);
  assert.equal(mine.body.reports.length, 1);
  assert.equal(mine.body.reports[0].title, "Тиждень скочив назад після зміни фабрики");
  assert.equal(mine.body.unread, 0);
  // інший бачить по сторінці без контексту і голосує
  const page = await request(app).get("/api/feedback/page?path=/schedule").set("Cookie", b.cookie);
  assert.equal(page.body.length, 1); assert.equal(page.body[0].mine, false); assert.equal(page.body[0].context, undefined);
  const v = await request(app).post(`/api/feedback/${id}/vote`).set("Cookie", b.cookie).set(H);
  assert.equal(v.body.votes, 1);
  // чужу картку не відкрити
  assert.equal((await request(app).get(`/api/feedback/${id}`).set("Cookie", b.cookie)).status, 404);
  // автор бачить картку, але без крихт
  const card = await request(app).get(`/api/feedback/${id}`).set("Cookie", a.cookie);
  assert.equal(card.status, 200); assert.deepEqual(card.body.breadcrumbs, []);
  // підказка дубля для іншого
  const sim = await request(app).get("/api/feedback/similar?path=/schedule&q=тиждень скочив після фабрики").set("Cookie", b.cookie);
  assert.equal(sim.body.length, 1); assert.equal(sim.body[0].id, id);
});

test("feedback: чужі зголошення видно лише по сторінках, доступних ролі; remindDays=0 зберігається", opts, async () => {
  await seedRole("scheduler", ["editData"], ["/", "/schedule"], []);
  const main = await seedAdmin({ role: "owner", isMain: true, name: "Yuriy" });
  const sch = await seedAdmin({ role: "scheduler", name: "Marta" });
  await request(app).post("/api/feedback").set("Cookie", main.cookie).set(H).send(body({ pagePath: "/finance", pageLabel: "Фінанси", description: "Виплата по фірмі відображається неправильно" }));
  await request(app).post("/api/feedback").set("Cookie", main.cookie).set(H).send(body({ description: "Тиждень скаче на графіку" }));
  assert.equal((await request(app).get("/api/feedback/page?path=/finance").set("Cookie", sch.cookie)).body.length, 0, "сторінка поза ролями — порожньо");
  assert.equal((await request(app).get("/api/feedback/page?path=/schedule").set("Cookie", sch.cookie)).body.length, 1);
  const sim = await request(app).get("/api/feedback/similar?path=/schedule&q=виплата відображається неправильно фірмі").set("Cookie", sch.cookie);
  assert.equal(sim.body.length, 0, "підказка дубля не витікає з /finance");
  assert.equal((await request(app).get("/api/feedback/similar?path=/finance&q=виплата відображається неправильно фірмі").set("Cookie", main.cookie)).body.length, 1);
  const s = await request(app).put("/api/feedback/admin/settings").set("Cookie", main.cookie).set(H).send({ remindDays: 0 });
  assert.equal(s.body.remindDays, 0);
});

test("feedback: readOnly-роль може зголосити, адмінські шляхи — лише головний", opts, async () => {
  await seedRole("owner_view", ["readOnly"], ["/", "/schedule"], []);
  const ro = await seedAdmin({ role: "owner_view", name: "View" });
  const c = await request(app).post("/api/feedback").set("Cookie", ro.cookie).set(H).send(body({ kind: "wish", description: "Хочу фільтр по фірмі в експорті" }));
  assert.equal(c.status, 200, c.text);
  assert.equal((await request(app).get("/api/feedback/admin/list").set("Cookie", ro.cookie)).status, 403);
  assert.equal((await request(app).patch(`/api/feedback/admin/${c.body.id}`).set("Cookie", ro.cookie).set(H).send({ status: "fixed" })).status, 403);
});

test("feedback: головний міняє статуси, автор підтверджує, імпорт результату", opts, async () => {
  await seedRole("scheduler", ["editData"], ["/", "/schedule"], []);
  const a = await seedAdmin({ role: "scheduler", name: "Marta" });
  const main = await seedAdmin({ role: "owner", isMain: true, name: "Yuriy" });
  const id = (await request(app).post("/api/feedback").set("Cookie", a.cookie).set(H).send(body())).body.id;
  const id2 = (await request(app).post("/api/feedback").set("Cookie", a.cookie).set(H).send(body({ description: "Те саме, тиждень скаче" }))).body.id;
  const list = await request(app).get("/api/feedback/admin/list").set("Cookie", main.cookie);
  assert.equal(list.status, 200, list.text); assert.equal(list.body.rows.length, 2); assert.equal(list.body.facets.pages[0].path, "/schedule");
  const cnt = await request(app).get("/api/feedback/admin/counters").set("Cookie", main.cookie);
  assert.equal(cnt.body.new, 2, cnt.text); assert.equal(cnt.body.closed30, 0);
  // прийняти + відповісти
  const p = await request(app).patch(`/api/feedback/admin/${id}`).set("Cookie", main.cookie).set(H).send({ status: "review", reply: "Дивимось сьогодні" });
  assert.equal(p.status, 200, p.text); assert.equal(p.body.status, "review"); assert.equal(p.body.reply, "Дивимось сьогодні");
  const mine = await request(app).get("/api/feedback/mine").set("Cookie", a.cookie);
  assert.equal(mine.body.unread, 1);
  await request(app).post("/api/feedback/mine/seen").set("Cookie", a.cookie).set(H);
  assert.equal((await request(app).get("/api/feedback/mine").set("Cookie", a.cookie)).body.unread, 0);
  // дубль без оригіналу — помилка; з оригіналом — ок
  assert.equal((await request(app).patch(`/api/feedback/admin/${id2}`).set("Cookie", main.cookie).set(H).send({ status: "duplicate" })).status, 400);
  assert.equal((await request(app).patch(`/api/feedback/admin/${id2}`).set("Cookie", main.cookie).set(H).send({ status: "duplicate", duplicateOfId: id })).body.duplicateOfId, id);
  // імпорт результату тріажу → fixed + confirm_requested_at
  const imp = await request(app).post("/api/feedback/admin/import").set("Cookie", main.cookie).set(H)
    .send({ commit: "deadbee", items: [{ id, status: "fixed", reply: "Виправлено: тиждень тепер лишається", triage: { verdict: "треба", effort: "S" } }, { id: 999, status: "fixed" }] });
  assert.equal(imp.status, 200, imp.text); assert.deepEqual(imp.body.applied, [id]); assert.equal(imp.body.skipped.length, 1);
  const [r] = await db.select().from(feedbackReportsTable).where(eq(feedbackReportsTable.id, id));
  assert.equal(r!.status, "fixed"); assert.ok(r!.confirmRequestedAt); assert.equal(r!.deployedCommit, "deadbee"); assert.equal(r!.triage?.verdict, "треба");
  const answers = await db.select().from(feedbackCommentsTable).where(eq(feedbackCommentsTable.reportId, id));
  assert.ok(answers.some(c => c.kind === "answer" && c.via === "triage"));
  // автор: «досі ні» → in_progress; потім fixed → «працює» → confirmed
  const no = await request(app).post(`/api/feedback/${id}/confirm`).set("Cookie", a.cookie).set(H).send({ ok: false, note: "досі скаче" });
  assert.equal(no.body.status, "in_progress");
  await request(app).patch(`/api/feedback/admin/${id}`).set("Cookie", main.cookie).set(H).send({ status: "fixed" });
  const yes = await request(app).post(`/api/feedback/${id}/confirm`).set("Cookie", a.cookie).set(H).send({ ok: true });
  assert.equal(yes.body.status, "confirmed");
  // задача зі зголошення
  const t = await request(app).post(`/api/feedback/admin/${id}/task`).set("Cookie", main.cookie).set(H);
  assert.ok(t.body.taskId > 0);
  // пакет — zip
  const z = await request(app).get("/api/feedback/admin/pack.zip?status=all").set("Cookie", main.cookie).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
  assert.equal(z.status, 200); assert.equal(z.headers["content-type"], "application/zip"); assert.ok((z.body as Buffer).length > 100);
});
