import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, workersTable, factoriesTable } from "../test/harness.ts";
import { findDataDrift, driftTotal, driftSummary } from "./dataDrift.ts";

// Сторож канону «полів-двійників»: прапорець «до 26» ↔ дата народження,
// студент без дати, активна фабрика без міста.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };

beforeEach(async () => { if (hasTestDb) await resetDb(); });
after(async () => { if (hasTestDb) await closeDb(); });

test("дрейф ловиться: застарілий прапорець, студент без дати, фабрика без міста", opts, async () => {
  const y = new Date().getFullYear();
  await db.insert(workersTable).values([
    // 27-річний із прапорцем «до 26» → дрейф
    { fullName: "Stale Flag", birthDate: `${y - 27}-01-01`, under26: true, isActive: true },
    // 23-річний без прапорця → теж дрейф (прапорець мав би стояти)
    { fullName: "Missing Flag", birthDate: `${y - 23}-01-01`, under26: false, isActive: true },
    // студент без дати народження → дрейф
    { fullName: "No Birth Student", legalStatus: "student", isActive: true },
    // все канонічно → не в списку
    { fullName: "Clean Worker", birthDate: `${y - 30}-01-01`, under26: false, isActive: true },
    // звільнений із дрейфом → ігнорується
    { fullName: "Fired Stale", birthDate: `${y - 30}-01-01`, under26: true, isActive: false },
  ]);
  const [noCity, withCity] = await db.insert(factoriesTable).values([
    { name: "NoCity Fab" },
    { name: "City Fab", city: "Люблін" },
    { name: "Dead Fab" }, // без активних працівників — ігнорується
  ]).returning({ id: factoriesTable.id });
  // «жива» фабрика = має активного працівника
  await db.insert(workersTable).values([
    { fullName: "At NoCity", factoryId: noCity!.id, isActive: true },
    { fullName: "At City", factoryId: withCity!.id, isActive: true },
  ]);
  const d = await findDataDrift();
  assert.deepEqual(d.under26Drift.map(w => w.fullName).sort(), ["Missing Flag", "Stale Flag"]);
  assert.deepEqual(d.studentNoBirthDate.map(w => w.fullName), ["No Birth Student"]);
  assert.deepEqual(d.factoryNoCity.map(f => f.name), ["NoCity Fab"]);
  assert.equal(driftTotal(d), 4);
  assert.match(driftSummary(d)!, /до 26.*Stale Flag/);
});

test("чисті дані → нуль дрейфу і null-звіт", opts, async () => {
  await db.insert(workersTable).values({ fullName: "Ok", birthDate: "1990-01-01", under26: false, isActive: true });
  await db.insert(factoriesTable).values({ name: "Ok Fab", city: "Лодзь", isActive: true });
  const d = await findDataDrift();
  assert.equal(driftTotal(d), 0);
  assert.equal(driftSummary(d), null);
});
