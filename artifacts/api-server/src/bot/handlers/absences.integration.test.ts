import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hasTestDb, resetDb, closeDb, db, pressButton, sendText, sendPhoto, resetSent, sent, sentText } from "../../test/botHarness.ts";
import { workersTable, scheduleWeeksTable, scheduleEntriesTable, factoriesTable, seedAdmin, seedRole } from "../../test/harness.ts";
import { absenceAttachmentsTable } from "@workspace/db";
import { UPLOADS_ROOT } from "../../lib/uploads.ts";
import { getState } from "../state.ts";
import { eq } from "drizzle-orm";

// «🚫 Мої пропуски»: список за поточний місяць + одноразове пояснення пропуску.
const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const TID = "800200";

beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

// Тиждень з понеділком = 1-ше число поточного місяця: entryDateStr(mon) = 1-ше → у поточному місяці.
const now = new Date();
const MONTH_FIRST = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

async function seed(entryOver: Record<string, unknown> = {}) {
  const [f] = await db.insert(factoriesTable).values({ name: "Fabryka" }).returning({ id: factoriesTable.id });
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski", telegramId: TID, language: "uk" }).returning({ id: workersTable.id });
  const [wk] = await db.insert(scheduleWeeksTable).values({ weekStart: MONTH_FIRST, status: "approved" }).returning({ id: scheduleWeeksTable.id });
  const [e] = await db.insert(scheduleEntriesTable).values({ weekId: wk!.id, workerId: w!.id, factoryId: f!.id, dayOfWeek: "mon" as any, shift: "1" as any, status: "absent", ...entryOver }).returning({ id: scheduleEntriesTable.id });
  return { workerId: w!.id, entryId: e!.id };
}

test("my absences: lists the month's absence as unjustified with an explain button", opts, async () => {
  const { entryId } = await seed();
  await sendText(TID, "🚫 Мої пропуски");
  const txt = sentText();
  assert.match(txt, /Мої пропуски/);
  assert.match(txt, /Невиправдані \(1\)/);
  assert.match(txt, /без пояснення/);
  const kb = sent.at(-1)!.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.ok(kb.includes(`wabs:ex:${entryId}`), "explain button is offered for an unexplained absence");
  assert.ok(kb.some((d: string) => /^wabs:m:\d{4}-\d{2}$/.test(d)), "previous-month button is offered");
});

test("my absences: explained + justified absence is listed as justified without an explain button", opts, async () => {
  const { entryId } = await seed({ absenceReason: "хворів", absenceExcused: true });
  await sendText(TID, "🚫 Мої пропуски");
  assert.match(sentText(), /Виправдані \(1\)[\s\S]*хворів/);
  const kb = sent.at(-1)!.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.ok(!kb.includes(`wabs:ex:${entryId}`));
});

test("explain flow: the reason alone finishes the explanation, notifies admins and offers an optional attach button", opts, async () => {
  await seedRole("owner", [], [], ["no_show"]); // офісні сповіщення — опт-ін по ролі
  await seedAdmin();
  const { entryId } = await seed();
  await pressButton(TID, `wabs:ex:${entryId}`);
  assert.equal(getState(TID)?.action, "absent:explain_reason");

  resetSent();
  await sendText(TID, "проспав");
  assert.equal(getState(TID), undefined, "no extra step — state is cleared right after the reason");
  const [e] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, entryId));
  assert.equal(e!.absenceReason, "проспав");
  assert.ok(e!.absenceExplainedAt, "explanation timestamp is recorded");
  assert.match(sentText(), /Пояснення відсутності[\s\S]*проспав/, "admins get the explanation");
  assert.match(sentText(), /передано адміністратору/);
  const btns = sent.flatMap(m => m.extra?.reply_markup?.inline_keyboard?.flat() ?? []).map((b: any) => b.callback_data);
  assert.ok(btns.includes(`wabs:att:${entryId}`), "optional «add photo/document» button is offered");

  // Повторне пояснення заборонене
  resetSent();
  await pressButton(TID, `wabs:ex:${entryId}`);
  assert.match(sentText(), /уже пояснено/);
  assert.equal(getState(TID), undefined);
});

test("explain flow (push): a stale reason state never overwrites an existing reason", opts, async () => {
  const { entryId } = await seed({ absenceReason: "заміна: вийшов Piotr" });
  const { setState } = await import("../state.ts");
  setState(TID, "absent:explain_reason", { entryId, day: "mon", shift: "1", name: "Jan Kowalski" });
  await sendText(TID, "інша причина");
  const [e] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, entryId));
  assert.equal(e!.absenceReason, "заміна: вийшов Piotr");
  assert.equal(getState(TID), undefined);
});

test("explain flow: a menu/cancel button pressed instead of a reason is never stored as the reason", opts, async () => {
  const { entryId } = await seed();
  await pressButton(TID, `wabs:ex:${entryId}`);
  await sendText(TID, "✖️ Скасувати");
  const [e] = await db.select().from(scheduleEntriesTable).where(eq(scheduleEntriesTable.id, entryId));
  assert.equal(e!.absenceReason, null);
  assert.equal(getState(TID), undefined);
  assert.match(sentText(), /Головне меню/);
});

test("attach option: one photo is stored shrunk, forwarded to admins, and a second one is refused", opts, async () => {
  await seedRole("owner", [], [], ["no_show"]); // офісні сповіщення — опт-ін по ролі
  await seedAdmin();
  const { entryId } = await seed({ absenceReason: "хворів", absenceExplainedAt: new Date() });
  await pressButton(TID, `wabs:att:${entryId}`);
  assert.equal(getState(TID)?.action, "absent:attach");

  // Telegram file download is stubbed: getFile → fake path, fetch → a tiny real JPEG.
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#f00" } }).jpeg().toBuffer();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(jpeg)) as any;
  try {
    resetSent();
    await sendPhoto(TID, "AgACAgIAAxkBAAI-fake");
  } finally { globalThis.fetch = realFetch; }

  assert.equal(getState(TID), undefined);
  const files = await db.select().from(absenceAttachmentsTable).where(eq(absenceAttachmentsTable.entryId, entryId));
  assert.equal(files.length, 1);
  assert.equal(files[0]!.fileMime, "image/jpeg");
  assert.equal(files[0]!.tgKind, "photo");
  assert.ok(fs.existsSync(path.join(UPLOADS_ROOT, files[0]!.filePath)), "file is written to disk");
  fs.rmSync(path.join(UPLOADS_ROOT, files[0]!.filePath), { force: true });
  assert.ok(sent.some(m => m.method === "sendPhoto"), "photo is forwarded to admins by file_id");
  assert.match(sentText(), /Документ до пояснення[\s\S]*хворів/);
  assert.match(sentText(), /Документ додано/);

  // Другий документ до того ж пропуску не приймається; у списку кнопки «📎» уже нема
  resetSent();
  await pressButton(TID, `wabs:att:${entryId}`);
  assert.match(sentText(), /уже додано/);
  assert.equal(getState(TID), undefined);
  resetSent();
  await sendText(TID, "🚫 Мої пропуски");
  const kb = sent.at(-1)!.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.ok(!kb.includes(`wabs:att:${entryId}`));
  assert.match(sentText(), /📎 1/);
});

test("attach option: not offered for a reason set by the driver/admin (no explained_at)", opts, async () => {
  const { entryId } = await seed({ absenceReason: "заміна: вийшов Piotr" });
  await sendText(TID, "🚫 Мої пропуски");
  const kb = sent.at(-1)!.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.ok(!kb.includes(`wabs:att:${entryId}`));
  await pressButton(TID, `wabs:att:${entryId}`);
  assert.equal(getState(TID), undefined, "the action is a no-op");
});

test("my absences: an explanation entered later shows the date it was entered", opts, async () => {
  const explainedAt = new Date(`${MONTH_FIRST}T12:00:00`); explainedAt.setDate(explainedAt.getDate() + 3);
  await seed({ absenceReason: "був у лікаря", absenceExplainedAt: explainedAt });
  await sendText(TID, "🚫 Мої пропуски");
  const dd = String(explainedAt.getDate()).padStart(2, "0"), mm = String(explainedAt.getMonth() + 1).padStart(2, "0");
  assert.match(sentText(), new RegExp(`був у лікаря.*пояснено ${dd}\\.${mm}`));
});
