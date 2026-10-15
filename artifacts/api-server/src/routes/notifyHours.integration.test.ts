import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { app, hasTestDb, resetDb, seedAdmin, closeDb, db, svodniRowsTable, workersTable, factoriesTable, companiesTable, workerChangesTable, workerNotifyHoursTable } from "../test/harness.ts";

// Години в повідомленні ПО ФАБРИЦІ (15.10.2026): ліміт konto в рядку сводної саме цієї фабрики;
// повідомлення пише години в профіль лише туди, де нема ручного значення; у форму — з фабрики.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

// людина «dyplom» на двох фабриках, червень: 160 год × 25,35 = 4056; без годин повідомлення — усе на konto
async function seedTwoFactories(workerOver: Record<string, unknown> = {}) {
  const [a] = await db.insert(factoriesTable).values({ name: "FABRYKA A" } as any).returning();
  const [b] = await db.insert(factoriesTable).values({ name: "FABRYKA B" } as any).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Kowalenko Taras", legalStatus: "dyplom", factoryId: a!.id, ...workerOver } as any).returning();
  const row = (fac: typeof a, label: string) => ({
    periodMonth: "2026-06", city: "Люблін", firm: "ES", factoryLabel: label, factoryId: fac!.id,
    rawName: "KOWALENKO TARAS", workerId: w!.id, linkStatus: "confirmed", legalStatus: "dyplom",
    hours: 160, rateBrutto: 31.4, rateNetto: 25.35, doWyplaty: 4056, konto: 4056, gotowka: 0,
    extras: {}, hr: {}, sheetValues: {},
  });
  const [ra] = await db.insert(svodniRowsTable).values(row(a, "FABRYKA A") as any).returning();
  const [rb] = await db.insert(svodniRowsTable).values(row(b, "FABRYKA B") as any).returning();
  return { a: a!, b: b!, w: w!, ra: ra!, rb: rb! };
}
const rowOf = async (id: number) => (await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, id)))[0]!;

test("зміна годин по фабриці: лише рядок цієї фабрики, рядок у worker_notify_hours, журнал з фабрикою; відкат повертає", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const { a, w, ra, rb } = await seedTwoFactories();

  const ap = await request(app).post("/api/svodni/profile-apply").set("Cookie", owner).set(H)
    .send({ workerId: w.id, from: "2026-06-01", rowIds: [ra.id, rb.id], changes: { notifyHours: 100, notifyHoursFactoryId: a.id } });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.applied, 1, "зачеплено лише рядок фабрики A");

  const rA = await rowOf(ra.id), rB = await rowOf(rb.id);
  assert.equal(rA.hoursNotified, 100);
  assert.equal(rA.konto, 2535, "konto = 100 × 25,35");
  assert.equal(rA.gotowka, 1521);
  assert.equal(rB.hoursNotified, null, "фабрика B не змінилась");
  assert.equal(rB.konto, 4056);

  const [own] = await db.select().from(workerNotifyHoursTable).where(eq(workerNotifyHoursTable.workerId, w.id));
  assert.equal(own?.factoryId, a.id); assert.equal(own?.hours, 100); assert.equal(own?.source, "manual");
  const [wAfter] = await db.select({ notifyHours: workersTable.notifyHours }).from(workersTable).where(eq(workersTable.id, w.id));
  assert.equal(wAfter?.notifyHours, null, "спільне поле профілю не чіпається");
  const [ch] = await db.select().from(workerChangesTable).where(and(eq(workerChangesTable.workerId, w.id), eq(workerChangesTable.field, "notifyHours")));
  assert.equal(ch?.factoryId, a.id); assert.equal(ch?.newValue, "100"); assert.equal(ch?.oldValue, null);

  const hist = await request(app).get(`/api/workers/${w.id}/changes`).set("Cookie", owner);
  assert.equal(hist.body[0].factoryName, "FABRYKA A");

  const undo = await request(app).delete(`/api/svodni/profile-change/${ch!.id}`).set("Cookie", owner).set(H);
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal((await rowOf(ra.id)).hoursNotified, null, "відкат: години рядка повернулись");
  assert.equal((await rowOf(ra.id)).konto, 4056);
  assert.equal((await db.select().from(workerNotifyHoursTable)).length, 0, "рядок фабрики прибрано");
});

test("години з повідомлення → профіль на фабрику + незалочена сводна; ручне й спільне не перезаписуються", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const { a, b, w, ra, rb } = await seedTwoFactories();
  const { applyNotificationHours } = await import("../services/notifyHours.ts");

  const r1 = await applyNotificationHours({ workerId: w.id, factoryId: a.id, hours: 120, documentId: null, effectiveDate: "2026-06-01" });
  assert.equal(r1.applied, true);
  const rA = await rowOf(ra.id);
  assert.equal(rA.hoursNotified, 120, "незалочений рядок фабрики отримав години одразу");
  assert.equal(rA.konto, 3042, "120 × 25,35");
  assert.equal((await rowOf(rb.id)).hoursNotified, null);
  const [own] = await db.select().from(workerNotifyHoursTable).where(eq(workerNotifyHoursTable.factoryId, a.id));
  assert.equal(own?.source, "powiadomienie");
  const [ch] = await db.select().from(workerChangesTable).where(eq(workerChangesTable.field, "notifyHours"));
  assert.equal(ch?.adminId, null, "автоматично");
  assert.deepEqual(ch?.appliedRows, [{ month: "2026-06", city: "Люблін", factoryLabel: "FABRYKA A" }]);

  // профіль: рядок на кожну фабрику з джерелом
  const prof = await request(app).get(`/api/workers/${w.id}`).set("Cookie", owner);
  const byFac = Object.fromEntries((prof.body.notifyHoursByFactory as any[]).map(x => [x.factoryId, x]));
  assert.equal(byFac[a.id].hours, 120); assert.equal(byFac[a.id].source, "powiadomienie");

  // ручне значення фабрики (PUT без превʼю) — нове повідомлення його не перезапише
  const put = await request(app).put(`/api/workers/${w.id}/notify-hours`).set("Cookie", owner).set(H).send({ factoryId: a.id, hours: 90 });
  assert.equal(put.status, 200);
  const r2 = await applyNotificationHours({ workerId: w.id, factoryId: a.id, hours: 150, documentId: null, effectiveDate: "2026-06-01" });
  assert.deepEqual(r2, { applied: false, reason: "manual" });
  const [own2] = await db.select().from(workerNotifyHoursTable).where(eq(workerNotifyHoursTable.factoryId, a.id));
  assert.equal(own2?.hours, 90); assert.equal(own2?.source, "manual");

  // друга фабрика без свого значення, але зі спільним (старим ручним) — теж не перезаписується
  await db.update(workersTable).set({ notifyHours: 160 }).where(eq(workersTable.id, w.id));
  const r3 = await applyNotificationHours({ workerId: w.id, factoryId: b.id, hours: 100, documentId: null, effectiveDate: "2026-06-01" });
  assert.deepEqual(r3, { applied: false, reason: "manual-shared" });
});

test("залочена вкладка: години з повідомлення чекають ревʼю розлоку, рядок не змінюється", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const { a, w, ra } = await seedTwoFactories();
  const lock = await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H).send({ month: "2026-06", city: "Люблін", factoryLabel: "FABRYKA A" });
  assert.equal(lock.status, 200, JSON.stringify(lock.body));
  const { applyNotificationHours } = await import("../services/notifyHours.ts");
  await applyNotificationHours({ workerId: w.id, factoryId: a.id, hours: 120, documentId: null, effectiveDate: "2026-06-01" });
  assert.equal((await rowOf(ra.id)).hoursNotified, null, "залочений рядок не чіпається");
  const [ch] = await db.select().from(workerChangesTable).where(eq(workerChangesTable.field, "notifyHours"));
  assert.deepEqual(ch?.skippedLocked, [{ month: "2026-06", city: "Люблін", factoryLabel: "FABRYKA A" }]);
  const pend = await request(app).post("/api/svodni/lock-pending").set("Cookie", owner).set(H).send({ month: "2026-06", city: "Люблін", factoryLabel: "FABRYKA A" });
  const entry = pend.body.changes.find((c: any) => c.field === "notifyHours");
  assert.equal(entry?.factoryName, "FABRYKA A");
  assert.equal(entry?.items?.[0]?.diffs?.find((d: any) => d.key === "hoursNotified")?.to, 120, "ревʼю показує нові години рядка");
  // розлок із прийняттям зміни — рядок фабрики отримує години, скоуп переходить у appliedRows
  const unlock = await request(app).post("/api/svodni/lock").set("Cookie", owner).set(H)
    .send({ month: "2026-06", city: "Люблін", factoryLabel: "FABRYKA A", applyChangeIds: [entry.id] });
  assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
  assert.equal((await rowOf(ra.id)).hoursNotified, 120);
  assert.equal((await rowOf(ra.id)).konto, 3042);
  const [ch2] = await db.select().from(workerChangesTable).where(eq(workerChangesTable.id, ch!.id));
  assert.equal(ch2?.skippedLocked, null);
});

test("форма повідомлення: години лише з налаштувань фабрики, umowa o pracę порожня = 0", opts, async () => {
  const [co] = await db.insert(companiesTable).values({ name: "ES", legalName: "Eurosupport Group Sp. z o.o.", city: "Lublin", headcountCivil: 40 } as any).returning();
  const [f] = await db.insert(factoriesTable).values({ name: "FABRYKA A", companyId: co!.id, uaNotifyHours: 160, contractRateBrutto: 31.4 } as any).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Kowalenko Taras", factoryId: f!.id, companyId: co!.id, notifyHours: 40 } as any).returning();
  const { buildUaFormPayload } = await import("../services/pracaGov/payload.ts");
  const { payload } = await buildUaFormPayload(w!.id, co!.id);
  assert.equal(payload.praca.godzinMiesiac, "160", "з фабрики, не з профілю (40)");
  assert.equal(payload.praca.stawkaMies, "5024,00", "31,40 × 160");
  assert.equal(payload.factoryId, f!.id);
  assert.equal(payload.liczby.umowaOPrace, "0");

  await db.update(factoriesTable).set({ uaNotifyHours: null }).where(eq(factoriesTable.id, f!.id));
  const { payload: p2, missing } = await buildUaFormPayload(w!.id, co!.id);
  assert.equal(p2.praca.godzinMiesiac, "", "фабрика без годин — порожньо, профіль не підставляється");
  assert.ok(missing.some(m => m.startsWith("години в повідомленні")));
});

test("порізаний на сегменти рядок: нові години повідомлення доходять до батька й розкладу konto", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const { a, w, ra } = await seedTwoFactories();
  // зміна ставки з середини місяця → рядок фабрики A ріжеться на сегменти
  const split = await request(app).post("/api/svodni/profile-apply").set("Cookie", owner).set(H)
    .send({ workerId: w.id, from: "2026-06-15", rowIds: [ra.id], changes: { hourlyRateNetto: 27 } });
  assert.equal(split.status, 200, JSON.stringify(split.body));
  const segs = (await db.select().from(svodniRowsTable)).filter(r => r.segmentOf === ra.id);
  assert.ok(segs.length >= 2, "рядок порізано");
  const kontoBefore = (await rowOf(ra.id)).konto!;

  const ap = await request(app).post("/api/svodni/profile-apply").set("Cookie", owner).set(H)
    .send({ workerId: w.id, from: "2026-06-01", rowIds: [ra.id], changes: { notifyHours: 100, notifyHoursFactoryId: a.id } });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const parent = await rowOf(ra.id);
  assert.equal(parent.hoursNotified, 100, "години записано в батька");
  assert.ok(parent.konto! < kontoBefore, `konto обмежено 100 год (${parent.konto} < ${kontoBefore})`);
  assert.ok(Math.abs(parent.konto! + parent.gotowka! - parent.doWyplaty!) < 0.02, "konto + готівка = до виплати");
});

test("документ про іншу фабрику не пише години; відкат ручної правки повертає «з повідомлення»", opts, async () => {
  const owner = (await seedAdmin({ role: "owner" })).cookie;
  const { a, w } = await seedTwoFactories();
  const { notifyFactoryOfDocument, applyNotificationHours } = await import("../services/notifyHours.ts");
  assert.equal(await notifyFactoryOfDocument(w.id, { factory: "ZUPEŁNIE INNA" }), null, "назва не збіглась — не вгадуємо");
  assert.equal(await notifyFactoryOfDocument(w.id, { factory: "fabryka a" }), a.id, "без регістру");

  await applyNotificationHours({ workerId: w.id, factoryId: a.id, hours: 120, documentId: null, effectiveDate: "2026-06-01" });
  const ap = await request(app).post("/api/svodni/profile-apply").set("Cookie", owner).set(H)
    .send({ workerId: w.id, from: "2026-06-01", rowIds: [], changes: { notifyHours: 90, notifyHoursFactoryId: a.id } });
  assert.equal(ap.status, 200);
  const manualEntry = (await db.select().from(workerChangesTable).where(eq(workerChangesTable.newValue, "90")))[0]!;
  const undo = await request(app).delete(`/api/svodni/profile-change/${manualEntry.id}`).set("Cookie", owner).set(H);
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  const [own] = await db.select().from(workerNotifyHoursTable).where(eq(workerNotifyHoursTable.factoryId, a.id));
  assert.equal(own?.hours, 120); assert.equal(own?.source, "powiadomienie", "наступні повідомлення й далі оновлюють");
  const r = await applyNotificationHours({ workerId: w.id, factoryId: a.id, hours: 140, documentId: null, effectiveDate: "2026-06-01" });
  assert.equal(r.applied, true);
});
