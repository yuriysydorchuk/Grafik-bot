import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, sendText, pressButton, resetSent, sentText } from "../test/botHarness.ts";
import { workersTable, documentTypesTable, passportScanTokensTable } from "../test/harness.ts";
import { eq } from "drizzle-orm";

// «📄 Документи» — самообслуговування працівника (§6 плану worker-docs-signing):
// список документів з інлайн-кнопками «додати», і кнопка «заповнити анкету»,
// що надсилає лінк на веб-анкету (той самий /passport-scan/:token, purpose=
// anketa — сторінка одразу відкриває крок анкети, без кроку сканування).
// Анкета раніше була окремим розмовним флоу в чаті — прибрано (§ рішення від
// 31.08.2026: три паралельні реалізації однієї форми — зайва складність).
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const TID = "830200";

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

async function seedWorker(): Promise<number> {
  const [w] = await db.insert(workersTable).values({ fullName: "Jan", telegramId: TID, isActive: true, language: "uk" }).returning({ id: workersTable.id });
  return w!.id;
}

test("«📄 Документи»: список показує відсутній тип з кнопкою додавання", opts, async () => {
  await seedWorker();
  await db.insert(documentTypesTable).values({ name: "Karta pobytu", required: true });
  await sendText(TID, "📄 Документи");
  assert.match(sentText(), /Karta pobytu/);
  assert.match(sentText(), /відсутній/);
});

test("«Заповнити анкету»: надсилає лінк на /passport-scan/, токен purpose=anketa і прив'язаний до працівника", opts, async () => {
  const workerId = await seedWorker();
  await sendText(TID, "📄 Документи");
  await pressButton(TID, "wdoc:ank");

  assert.match(sentText(), /\/passport-scan\//, "має надіслати лінк на веб-анкету");

  const [row] = await db.select().from(passportScanTokensTable).where(eq(passportScanTokensTable.workerId, workerId));
  assert.ok(row, "токен має створитись і бути прив'язаним до працівника");
  assert.equal(row!.purpose, "anketa");
  assert.equal(row!.usedAt, null, "usedAt НЕ ставимо — анкету можна дозаповнювати кілька разів у межах TTL");
});

test("«Заповнити анкету» без профілю — next(), нічого не падає", opts, async () => {
  // немає seedWorker() — цей telegramId не привʼязаний до жодного працівника
  await sendText(TID, "📄 Документи");
  assert.equal(sentText(), "", "без профілю меню документів взагалі не показується");
});
