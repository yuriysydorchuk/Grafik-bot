import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  app, hasTestDb, resetDb, seedAdmin, seedRole, closeDb, db,
  workersTable, factoriesTable, penaltiesTable, scheduleWeeksTable, scheduleEntriesTable,
  svodniRowsTable, svodniLocksTable,
} from "../test/harness.ts";

// Перенесення штрафів у колонку Kara сводної (формат — як бадання → Zaliczka BD):
// джерела — ручний реєстр /penalties і штрафи за пропуски /absences
// (schedule_entries). Сума ДОДАЄТЬСЯ до наявної Kara; ціль — рядок пари
// працівник+фабрика джерела, фолбек — рядок «основної» фабрики (найбільше
// годин); локи пропускаються; відміна віднімає своє і повертає запис у pending.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const H = { "X-Requested-With": "grafik" } as const;
const MONTH = "2026-06";

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

async function svodniCookie() {
  // editData — для PATCH /absences/:entryId (гейт RW), svodni — для переносів
  await seedRole("svodniBase", ["svodni", "editData"], ["/svodni", "/penalties"]);
  return (await seedAdmin({ role: "svodniBase", name: "Svod" })).cookie;
}

const seedRow = (workerId: number, fac: { id: number; name: string }, hours: number, over: Record<string, unknown> = {}) =>
  db.insert(svodniRowsTable).values({
    periodMonth: MONTH, city: "Люблін", factoryLabel: fac.name, factoryId: fac.id,
    rawName: `W${workerId}`, workerId, linkStatus: "confirmed",
    hours, rateNetto: 25, doWyplaty: hours * 25, extras: {}, hr: {}, sheetValues: {},
    ...over,
  } as any);

test("штрафи → Kara: рядок пари фабрики штрафу (не max-годин), додається до наявного; лок/без-рядка — у звіт; PATCH/DELETE блокуються; відміна вертає", opts, async () => {
  const cookie = await svodniCookie();
  const [w1] = await db.insert(workersTable).values({ fullName: "Kowalski Jan" }).returning();
  const [w2] = await db.insert(workersTable).values({ fullName: "Bez Wiersza" }).returning();
  const [w3] = await db.insert(workersTable).values({ fullName: "Pod Lockiem" }).returning();
  const [facA] = await db.insert(factoriesTable).values({ name: "FAB A" } as any).returning();
  const [facB] = await db.insert(factoriesTable).values({ name: "FAB B" } as any).returning();
  const [facC] = await db.insert(factoriesTable).values({ name: "FAB C" } as any).returning();
  // w1: штраф привʼязаний до FAB A — має лягти в рядок ПАРИ (FAB A),
  // хоч на FAB B годин більше; у клітинці вже є ручна Kara 30 — додається
  await seedRow(w1!.id, facA!, 40, { kara: 30, doWyplaty: 40 * 25 - 30 });
  await seedRow(w1!.id, facB!, 120);
  // w3 — під точковим локом FAB C (лок FAB A зачепив би і w1)
  await seedRow(w3!.id, facC!, 80);
  await db.insert(svodniLocksTable).values({ periodMonth: MONTH, city: "Люблін", factoryLabel: "FAB C" } as any);

  const [p1] = await db.insert(penaltiesTable).values({ periodMonth: MONTH, workerId: w1!.id, factoryId: facA!.id, factoryLabel: "FAB A", city: "Люблін", amount: 100 }).returning();
  const [p2] = await db.insert(penaltiesTable).values({ periodMonth: MONTH, workerId: w2!.id, amount: 60 }).returning();
  const [p3] = await db.insert(penaltiesTable).values({ periodMonth: MONTH, workerId: w3!.id, factoryId: facC!.id, factoryLabel: "FAB C", city: "Люблін", amount: 40 }).returning();

  const res = await request(app).post("/api/svodni/apply-penalty-deductions").set("Cookie", cookie).set(H)
    .send({ month: MONTH, ids: [p1!.id, p2!.id, p3!.id] });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 1, "лише w1 (w2 без рядка, w3 під локом)");
  assert.equal(res.body.itemsMarked, 1);
  assert.equal(res.body.skippedLocked, 1);
  assert.equal(res.body.unmatched.length, 1);
  assert.deepEqual(res.body.verifyMismatches, []);

  const rows = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w1!.id));
  const rowA = rows.find(r => r.factoryLabel === "FAB A");
  const rowB = rows.find(r => r.factoryLabel === "FAB B");
  assert.equal(rowA?.kara, 130, "30 наявних + 100 перенесених у рядок ПАРИ");
  assert.equal(rowA?.doWyplaty, 40 * 25 - 130);
  assert.equal(rowB?.kara, null, "max-годинна фабрика не чіпалась — штраф має фабрику");

  const [p1r] = await db.select().from(penaltiesTable).where(eq(penaltiesTable.id, p1!.id));
  assert.equal(p1r!.deducted, true);
  assert.equal(p1r!.deductedMonth, MONTH);
  const [p3r] = await db.select().from(penaltiesTable).where(eq(penaltiesTable.id, p3!.id));
  assert.equal(p3r!.deducted, false, "залочене не позначено");

  // перенесений штраф не правиться і не видаляється
  assert.equal((await request(app).patch(`/api/penalties/${p1!.id}`).set("Cookie", cookie).set(H).send({ amount: 999 })).status, 409);
  assert.equal((await request(app).delete(`/api/penalties/${p1!.id}`).set("Cookie", cookie).set(H)).status, 409);
  // GET віддає стан переносу
  const list = (await request(app).get(`/api/penalties?month=${MONTH}`).set("Cookie", cookie)).body;
  assert.equal(list.rows.find((r: any) => r.id === p1!.id).deductedMonth, MONTH);

  // ↩ відміна: Kara повертається до 30, до виплати відновлюється, запис у pending
  const undo = await request(app).post("/api/svodni/undo-penalty-deduction").set("Cookie", cookie).set(H).send({ id: p1!.id });
  assert.equal(undo.status, 200);
  assert.equal(undo.body.subtracted.newValue, 30);
  const [rowAfter] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.id, rowA!.id));
  assert.equal(rowAfter?.kara, 30);
  assert.equal(rowAfter?.doWyplaty, 40 * 25 - 30);
  const [p1After] = await db.select().from(penaltiesTable).where(eq(penaltiesTable.id, p1!.id));
  assert.equal(p1After!.deducted, false);
  assert.equal(p1After!.deductedMonth, null);
  // після відміни редагування знову дозволене
  assert.equal((await request(app).patch(`/api/penalties/${p1!.id}`).set("Cookie", cookie).set(H).send({ amount: 120 })).status, 200);
});

test("пропуски → Kara: сума ефективних штрафів пари (override/виправдані/зняті фільтруються), фіксація суми на пропуску; відміна віднімає зафіксоване; PATCH пропуску блокується", opts, async () => {
  const cookie = await svodniCookie();
  const [w1] = await db.insert(workersTable).values({ fullName: "Kowalski Jan" }).returning();
  const [fac] = await db.insert(factoriesTable).values({ name: "FAB A" } as any).returning();
  await seedRow(w1!.id, fac!, 100);
  const [week] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-06-01", status: "approved" } as any).returning();
  const entry = (over: Record<string, unknown> = {}) => db.insert(scheduleEntriesTable).values({
    weekId: week!.id, workerId: w1!.id, factoryId: fac!.id,
    dayOfWeek: "mon", shift: "1", status: "absent", ...over,
  } as any).returning();
  const [e1] = await entry();                                    // стандарт 200
  const [e2] = await entry({ dayOfWeek: "tue", absencePenalty: 50 }); // override 50
  const [e3] = await entry({ dayOfWeek: "wed", absenceExcused: true });      // виправданий — не переноситься
  const [e4] = await entry({ dayOfWeek: "thu", absencePenalty: 0 });         // анульований — не переноситься

  const res = await request(app).post("/api/svodni/apply-absence-deductions").set("Cookie", cookie).set(H)
    .send({ month: MONTH, entryIds: [e1!.id, e2!.id, e3!.id, e4!.id] });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 1);
  assert.equal(res.body.itemsMarked, 2, "лише e1+e2 (виправданий і нульовий відфільтровані)");
  assert.deepEqual(res.body.verifyMismatches, []);

  const [row] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w1!.id));
  assert.equal(row?.kara, 250, "200 стандарт + 50 override");
  assert.equal(row?.doWyplaty, 100 * 25 - 250);
  const [e1r] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, e1!.id));
  assert.equal(e1r!.absenceDeductedMonth, MONTH);
  assert.equal(e1r!.absenceDeductedAmount, 200);
  const [e2r] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, e2!.id));
  assert.equal(e2r!.absenceDeductedAmount, 50);
  const [e3r] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, e3!.id));
  assert.equal(e3r!.absenceDeductedMonth, null);

  // повторний виклик тих самих ids — уже зняті відфільтровані
  const again = await request(app).post("/api/svodni/apply-absence-deductions").set("Cookie", cookie).set(H)
    .send({ month: MONTH, entryIds: [e1!.id, e2!.id] });
  assert.equal(again.status, 400);

  // перенесений пропуск не виправдовується і штраф не правиться
  assert.equal((await request(app).patch(`/api/absences/${e1!.id}`).set("Cookie", cookie).set(H).send({ justified: true })).status, 409);

  // ↩ відміна e2: віднімається зафіксовані 50
  const undo = await request(app).post("/api/svodni/undo-absence-deduction").set("Cookie", cookie).set(H).send({ entryId: e2!.id });
  assert.equal(undo.status, 200);
  assert.equal(undo.body.subtracted.newValue, 200);
  const [rowAfter] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w1!.id));
  assert.equal(rowAfter?.kara, 200);
  assert.equal(rowAfter?.doWyplaty, 100 * 25 - 200);
  const [e2After] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, e2!.id));
  assert.equal(e2After!.absenceDeductedMonth, null);
  assert.equal(e2After!.absenceDeductedAmount, null);
  // після відміни виправдання знову дозволене
  assert.equal((await request(app).patch(`/api/absences/${e2!.id}`).set("Cookie", cookie).set(H).send({ justified: true })).status, 200);
});

test("lock-pending: незняті штрафи області в ревʼю розлоку (пропуск + реєстр), чужа фабрика — ні, без рядка — в unrowed; після розлоку переносяться", opts, async () => {
  const { svodniLocksTable: locksT } = await import("../test/harness.ts");
  const cookie = await svodniCookie();
  const [w1] = await db.insert(workersTable).values({ fullName: "Kowalski Jan" }).returning();
  const [w2] = await db.insert(workersTable).values({ fullName: "Bez Wiersza" }).returning();
  const [w3] = await db.insert(workersTable).values({ fullName: "Cudza Fabryka" }).returning();
  const [facA] = await db.insert(factoriesTable).values({ name: "FAB A", city: "Люблін" } as any).returning();
  const [facB] = await db.insert(factoriesTable).values({ name: "FAB B", city: "Люблін" } as any).returning();
  await seedRow(w1!.id, facA!, 100);
  await seedRow(w3!.id, facB!, 100);
  await db.insert(locksT).values({ periodMonth: MONTH, city: "Люблін", factoryLabel: "FAB A" } as any);

  const [week] = await db.insert(scheduleWeeksTable).values({ weekStart: "2026-06-01", status: "approved" } as any).returning();
  const entry = (workerId: number, factoryId: number, over: Record<string, unknown> = {}) => db.insert(scheduleEntriesTable).values({
    weekId: week!.id, workerId, factoryId, dayOfWeek: "mon", shift: "1", status: "absent", ...over,
  } as any).returning();
  const [e1] = await entry(w1!.id, facA!.id);                      // → ревʼю FAB A
  await entry(w2!.id, facA!.id, { dayOfWeek: "tue" });             // без рядка → unrowed
  await entry(w3!.id, facB!.id, { dayOfWeek: "wed" });             // ціль FAB B (не залочена) → не в ревʼю
  const [p1] = await db.insert(penaltiesTable).values({ periodMonth: MONTH, workerId: w1!.id, factoryId: facA!.id, factoryLabel: "FAB A", amount: 150 }).returning();

  const res = await request(app).post("/api/svodni/lock-pending").set("Cookie", cookie).set(H)
    .send({ month: MONTH, city: "Люблін", factoryLabel: "FAB A" });
  assert.equal(res.status, 200);
  const k = res.body.pendingKara;
  assert.equal(k.absences.length, 1);
  assert.deepEqual(k.absences[0].entryIds, [e1!.id]);
  assert.equal(k.absences[0].amount, 200);
  assert.equal(k.absences[0].targetFactoryLabel, "FAB A");
  assert.equal(k.penalties.length, 1);
  assert.equal(k.penalties[0].id, p1!.id);
  assert.equal(k.unrowed.length, 1);
  assert.equal(k.unrowed[0].workerName, "Bez Wiersza");
  assert.equal(k.unrowed[0].count, 1);

  // другий пропуск w1 НЕ плодить другий рядок ревʼю — та сама група, сума росте
  const [e1b] = await entry(w1!.id, facA!.id, { dayOfWeek: "fri" });
  const grouped = await request(app).post("/api/svodni/lock-pending").set("Cookie", cookie).set(H)
    .send({ month: MONTH, city: "Люблін", factoryLabel: "FAB A" });
  const gk = grouped.body.pendingKara;
  assert.equal(gk.absences.length, 1, "одна група на людину, не рядок на дату");
  assert.deepEqual([...gk.absences[0].entryIds].sort(), [e1!.id, e1b!.id].sort());
  assert.equal(gk.absences[0].amount, 400);
  assert.equal(gk.absences[0].dates.length, 2);
  await db.delete(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, e1b!.id));

  // міський лок (factoryLabel "") накриває ВСІ вкладки міста: у ревʼю тепер
  // і штраф w3 з FAB B, unrowed w2 матчиться по місту фабрики джерела
  await db.insert(locksT).values({ periodMonth: MONTH, city: "Люблін", factoryLabel: "" } as any);
  const cityRes = await request(app).post("/api/svodni/lock-pending").set("Cookie", cookie).set(H)
    .send({ month: MONTH, city: "Люблін", factoryLabel: "" });
  assert.equal(cityRes.status, 200);
  const ck = cityRes.body.pendingKara;
  assert.equal(ck.absences.length, 2, "пропуски w1 (FAB A) і w3 (FAB B)");
  assert.deepEqual(ck.absences.map((a: any) => a.targetFactoryLabel).sort(), ["FAB A", "FAB B"]);
  assert.equal(ck.penalties.length, 1);
  assert.equal(ck.unrowed.length, 1);
  await db.delete(locksT).where(eq(locksT.factoryLabel, ""));

  // флоу модалки: розлок → прийняті штрафи переносяться apply-ендпойнтами
  const unlock = await request(app).post("/api/svodni/lock").set("Cookie", cookie).set(H)
    .send({ month: MONTH, city: "Люблін", factoryLabel: "FAB A" });
  assert.equal(unlock.body.locked, false);
  const applyAbs = await request(app).post("/api/svodni/apply-absence-deductions").set("Cookie", cookie).set(H)
    .send({ month: MONTH, entryIds: [e1!.id] });
  assert.equal(applyAbs.body.updated, 1);
  const applyPen = await request(app).post("/api/svodni/apply-penalty-deductions").set("Cookie", cookie).set(H)
    .send({ month: MONTH, ids: [p1!.id] });
  assert.equal(applyPen.body.updated, 1);
  const [row] = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w1!.id));
  assert.equal(row?.kara, 350, "200 пропуск + 150 реєстр");
});

test("фолбек без фабрики штрафу: сума лягає в рядок фабрики з найбільшими годинами; дві групи людини складаються в той самий рядок", opts, async () => {
  const cookie = await svodniCookie();
  const [w1] = await db.insert(workersTable).values({ fullName: "Kowalski Jan" }).returning();
  const [facA] = await db.insert(factoriesTable).values({ name: "FAB A" } as any).returning();
  const [facB] = await db.insert(factoriesTable).values({ name: "FAB B" } as any).returning();
  await seedRow(w1!.id, facA!, 40);
  await seedRow(w1!.id, facB!, 120);
  // штраф без фабрики → фолбек у FAB B (120 год); штраф із FAB B → та сама
  // клітинка — друга група мусить додатись до свіжого значення першої
  const [p1] = await db.insert(penaltiesTable).values({ periodMonth: MONTH, workerId: w1!.id, amount: 70 }).returning();
  const [p2] = await db.insert(penaltiesTable).values({ periodMonth: MONTH, workerId: w1!.id, factoryId: facB!.id, factoryLabel: "FAB B", amount: 30 }).returning();

  const res = await request(app).post("/api/svodni/apply-penalty-deductions").set("Cookie", cookie).set(H)
    .send({ month: MONTH, ids: [p1!.id, p2!.id] });
  assert.equal(res.status, 200);
  assert.equal(res.body.itemsMarked, 2);
  assert.deepEqual(res.body.verifyMismatches, [], "самозвірка бачить суму обох груп");

  const rows = await db.select().from(svodniRowsTable).where(eq(svodniRowsTable.workerId, w1!.id));
  assert.equal(rows.find(r => r.factoryLabel === "FAB B")?.kara, 100, "70 фолбек + 30 пара — один рядок");
  assert.equal(rows.find(r => r.factoryLabel === "FAB A")?.kara, null);
});
