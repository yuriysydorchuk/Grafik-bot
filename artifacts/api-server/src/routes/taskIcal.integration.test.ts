// Підписка iCal (публічний лінк з HMAC-токеном) + масова дія «на дату» (підсумок дня в панелі).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import { hasTestDb, resetDb, closeDb, db, app, seedAdmin, tasksTable } from "../test/harness.ts";
import { createTask } from "../services/tasks.ts";
import { addDaysStr } from "../lib/dates.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const H = { "X-Requested-With": "grafik" };

test("iCal: лінк з панелі, публічний фід із зустріччю (час+тривалість) і задачею (весь день); чужий/зіпсований токен → 404", opts, async () => {
  const me = await seedAdmin({ name: "Yuriy" });
  await createTask({ title: "Замовити одяг", dueAt: addDaysStr(today, 3), assigneeAdminId: me.adminId, notify: false }, me.adminId);
  await createTask({ kind: "meeting", title: "Збори", dueAt: addDaysStr(today, 1), dueTime: "15:00", durationMin: 45, place: "офіс", assigneeIds: [me.adminId], agenda: ["Документи", "Умови"], notify: false }, me.adminId);
  const l = await request(app).get("/api/tasks/ical-link").set("Cookie", me.cookie);
  assert.equal(l.status, 200); assert.match(l.body.url, /\/api\/calendar\/\d+\.[0-9a-f]{32}\.ics$/);
  const path = l.body.url.slice(l.body.url.indexOf("/api"));
  const f = await request(app).get(path);
  assert.equal(f.status, 200); assert.match(f.headers["content-type"], /text\/calendar/);
  const body = f.text;
  assert.match(body, /BEGIN:VCALENDAR/); assert.match(body, /SUMMARY:🗓 Збори/); assert.match(body, /DTSTART;TZID=Europe\/Warsaw:\d{8}T150000/); assert.match(body, /DTEND;TZID=Europe\/Warsaw:\d{8}T154500/);
  assert.match(body, /SUMMARY:Замовити одяг/); assert.match(body, /DTSTART;VALUE=DATE:\d{8}/); assert.match(body, /LOCATION:офіс/); assert.match(body, /DESCRIPTION:1\. Документи\\n2\. Умови/);
  assert.equal((await request(app).get(path.replace(/\.[0-9a-f]{32}\.ics$/, ".deadbeefdeadbeefdeadbeefdeadbeef.ics"))).status, 404);
  assert.equal((await request(app).get("/api/calendar/abc.ics")).status, 404);
});

test("bulk plan_date: усе невиконане → понеділок", opts, async () => {
  const me = await seedAdmin();
  const t1 = await createTask({ title: "A", dueAt: today, assigneeAdminId: me.adminId, notify: false }, me.adminId);
  const t2 = await createTask({ title: "B", dueAt: addDaysStr(today, -1), assigneeAdminId: me.adminId, notify: false }, me.adminId);
  const monday = addDaysStr(today, 7 - ((new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7));
  const r = await request(app).post("/api/tasks/bulk").set("Cookie", me.cookie).set(H).send({ ids: [t1.id, t2.id], action: "plan_date", date: monday });
  assert.equal(r.status, 200);
  for (const id of [t1.id, t2.id]) assert.equal(String((await db.select().from(tasksTable).where(eq(tasksTable.id, id)))[0]?.plannedFor), monday);
  assert.equal((await request(app).post("/api/tasks/bulk").set("Cookie", me.cookie).set(H).send({ ids: [t1.id], action: "plan_date", date: "bad" })).status, 400);
});
