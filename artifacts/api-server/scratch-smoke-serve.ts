// Одноразовий смоук-сервер: реальний Express `app` на ОДНОРАЗОВІЙ тестовій БД
// (TEST_DATABASE_URL, форсується харнесом) + сідовані дані для /driver-shifts.
// Запуск: WEB_DIST=../web/dist TEST_DATABASE_URL=postgres://localhost/grafik_bot_test \
//   node --import ./test-hooks.mjs scratch-smoke-serve.ts
import {
  app, resetDb, seedAdmin, db, factoriesTable, workersTable, driversTable,
  scheduleWeeksTable, scheduleEntriesTable, driverShiftAssignmentsTable,
} from "./src/test/harness.ts";

const monday = (() => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

await resetDb();
const [f1] = await db.insert(factoriesTable).values({
  name: "Agram", shiftCount: 2, shifts: [{ start: "06:00", end: "14:00" }, { start: "14:00", end: "22:00" }],
}).returning();
const [f2] = await db.insert(factoriesTable).values({
  name: "InPost", shiftCount: 1, shifts: [{ start: "22:00", end: "06:00" }],
}).returning();
const workers = await db.insert(workersTable).values(
  Array.from({ length: 8 }, (_, i) => ({ fullName: `Testowy Worker ${i + 1}` })),
).returning();
const [head] = await db.insert(driversTable).values({ name: "Vitalii", seats: 20, isHeadDriver: true, inviteCode: "SMK1", telegramId: "900001" }).returning();
const [drv2] = await db.insert(driversTable).values({ name: "Andrii", seats: 9, inviteCode: "SMK2", telegramId: "900002" }).returning();
const [week] = await db.insert(scheduleWeeksTable).values({ weekStart: monday, status: "approved" }).returning();

const entries: (typeof scheduleEntriesTable.$inferInsert)[] = [];
for (const day of ["mon", "tue", "wed", "thu", "fri"] as const) {
  for (const w of workers.slice(0, 3)) entries.push({ weekId: week!.id, workerId: w.id, factoryId: f1!.id, dayOfWeek: day, shift: "1" });
  for (const w of workers.slice(3, 5)) entries.push({ weekId: week!.id, workerId: w.id, factoryId: f1!.id, dayOfWeek: day, shift: "2" });
  for (const w of workers.slice(5, 8)) entries.push({ weekId: week!.id, workerId: w.id, factoryId: f2!.id, dayOfWeek: day, shift: "1" });
}
await db.insert(scheduleEntriesTable).values(entries);
await db.insert(driverShiftAssignmentsTable).values([
  { weekId: week!.id, factoryId: f1!.id, dayOfWeek: "thu", shift: "1", driverId: drv2!.id, kind: "delivery" },
  { weekId: week!.id, factoryId: f1!.id, dayOfWeek: "thu", shift: "2", driverId: head!.id, kind: "pickup" },
]);

const { cookie } = await seedAdmin({ role: "owner", name: "Smoke" });
console.log("COOKIE::" + cookie);
app.listen(8099, () => console.log("SMOKE-READY 8099 week " + monday));
