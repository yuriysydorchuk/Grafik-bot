// Відповіді на запит «підтверди свої години фабрики» (зголошення #15 і #24, 05.11.2026):
//  • «Є помилка» без рапорту за місяць×фабрику — спір НЕ пишеться, бот просить здати рапорт
//    (кнопка відкриває рапорт саме за цей місяць×фабрику); з рапортом — спір + пояснення;
//  • після рапорту розбіжність з годинами фабрики сама стає спором, збіг — підтвердженням;
//  • звільнений (is_active=false) відповідає на запит, як і активний.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { hasTestDb, resetDb, closeDb, db, pressButton, sendText, resetSent, sent, sentText } from "../../test/botHarness.ts";
import { workersTable, factoriesTable, factoryHoursTable, monthlyReportsTable } from "../../test/harness.ts";
import { getState } from "../state.ts";
import { ackAfterMonthlyReport } from "./factoryHoursAck.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
const TID = "800515";
beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

async function seed(over: Record<string, unknown> = {}) {
  const [f] = await db.insert(factoriesTable).values({ name: "SUSHI" }).returning();
  const [w] = await db.insert(workersTable).values({ fullName: "Jan Kowalski", telegramId: TID, language: "uk", factoryId: f!.id, isActive: true, ...over } as any).returning();
  const [fh] = await db.insert(factoryHoursTable).values({ workerId: w!.id, month: "2026-10", factoryId: f!.id, hours: 160, askSentAt: new Date() } as any).returning();
  return { f: f!, w: w!, fh: fh! };
}
const row = async (id: number) => (await db.select().from(factoryHoursTable).where(eq(factoryHoursTable.id, id)))[0]!;
const buttons = () => (sent.at(-1)?.extra?.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data);

test("«Є помилка» без рапорту: спору немає, бот просить рапорт і відкриває його за місяць×фабрику запиту", opts, async () => {
  const { f, w, fh } = await seed();
  await pressButton(TID, `fh:no:${fh.id}`);
  assert.equal((await row(fh.id)).workerResponse, null, "спір без рапорту не записується");
  assert.match(sentText(), /спершу здай рапорт/);
  assert.deepEqual(buttons(), [`fhr:${fh.id}`]);
  assert.ok(!sent.some(s => s.method === "editMessageReplyMarkup"), "кнопки запиту лишаються — після рапорту можна відповісти ще раз");

  resetSent();
  await pressButton(TID, `fhr:${fh.id}`);
  const st = getState(TID)!;
  assert.equal(st.action, "report:awaiting_hours");
  assert.deepEqual([st.data.month, st.data.factoryId, st.data.workerId, st.data.fhAck], ["2026-10", f.id, w.id, fh.id]);
  await sendText(TID, "152");
  assert.deepEqual([getState(TID)!.action, getState(TID)!.data.fhAck, getState(TID)!.data.reportHours], ["report:awaiting_photo", fh.id, 152], "маркер доїжджає до збереження рапорту");
});

test("після рапорту: розбіжність → спір із приміткою й повідомленням працівнику; збіг → підтверджено", opts, async () => {
  const { w, fh } = await seed();
  const replies: string[] = [];
  const ctx = { reply: async (text: string) => { replies.push(text); return {}; } } as any;
  await ackAfterMonthlyReport(ctx, "uk", { fhId: fh.id, workerId: w.id, reportHours: 152 });
  let r = await row(fh.id);
  assert.deepEqual([r.workerResponse, r.workerNote], ["dispute", "Рапорт працівника: 152 год (фабрика: 160 год)"]);
  assert.match(replies[0]!, /152.*160/s);
  // відповідь уже є — повторний виклик (друге фото, застарілий маркер) нічого не перезаписує
  await ackAfterMonthlyReport(ctx, "uk", { fhId: fh.id, workerId: w.id, reportHours: 160 });
  assert.equal((await row(fh.id)).workerResponse, "dispute");
  assert.equal(replies.length, 1);
  // збіг на свіжому запиті → підтверджено; чужий рядок не чіпаємо
  await db.update(factoryHoursTable).set({ workerResponse: null, workerNote: null }).where(eq(factoryHoursTable.id, fh.id));
  await ackAfterMonthlyReport(ctx, "uk", { fhId: fh.id, workerId: w.id + 999, reportHours: 160 });
  assert.equal((await row(fh.id)).workerResponse, null);
  await ackAfterMonthlyReport(ctx, "uk", { fhId: fh.id, workerId: w.id, reportHours: 160 });
  r = await row(fh.id);
  assert.deepEqual([r.workerResponse, r.workerNote], ["confirmed", null]);
  assert.match(replies.at(-1)!, /збігаються/);
});

test("не працював на цій фабриці: у рапорті з підказки «0» одразу стає спором; друге натискання кнопок запиту нічого не міняє", opts, async () => {
  const { fh } = await seed();
  await pressButton(TID, `fh:no:${fh.id}`);
  assert.match(sentText(), /впиши \*0\*/);
  await pressButton(TID, `fhr:${fh.id}`);
  resetSent();
  await sendText(TID, "0");
  const r = await row(fh.id);
  assert.deepEqual([r.workerResponse, r.workerNote], ["dispute", "Рапорт працівника: 0 год (фабрика: 160 год)"]);
  assert.equal(getState(TID), undefined);
  // кнопки запиту ще на екрані: «Все вірно» після записаної відповіді спір не стирає, «Є помилка» не шле вдруге
  resetSent();
  await pressButton(TID, `fh:ok:${fh.id}`);
  assert.equal((await row(fh.id)).workerResponse, "dispute");
  await pressButton(TID, `fh:no:${fh.id}`);
  assert.equal(getState(TID), undefined, "пояснення вдруге не питаємо");
  assert.ok(sent.some(s => s.method === "answerCallbackQuery" && /уже записана/.test(String(s.extra?.text ?? ""))));
});

test("з рапортом «Є помилка» працює як раніше: спір + пояснення текстом", opts, async () => {
  const { f, w, fh } = await seed();
  await db.insert(monthlyReportsTable).values({ workerId: w.id, month: "2026-10", factoryId: f.id, hoursReported: 170 });
  await pressButton(TID, `fh:no:${fh.id}`);
  assert.equal((await row(fh.id)).workerResponse, "dispute");
  assert.equal(getState(TID)!.action, "fh:dispute_note");
  await sendText(TID, "Не враховано дві нічні зміни");
  assert.equal((await row(fh.id)).workerNote, "Не враховано дві нічні зміни");
  assert.equal(getState(TID), undefined);
});

test("звільнений відповідає на запит: «Все вірно» підтверджує, «Є помилка» без рапорту веде до рапорту (#24)", opts, async () => {
  const { fh } = await seed({ isActive: false, status: "fired", firedAt: new Date(Date.now() - 100 * 86400000) }); // давно звільнений — поза 60-денним вікном leaver
  await pressButton(TID, `fh:no:${fh.id}`);
  assert.match(sentText(), /спершу здай рапорт/);
  resetSent();
  await pressButton(TID, `fhr:${fh.id}`);
  assert.equal(getState(TID)!.action, "report:awaiting_hours", "звільнений може здати рапорт за місяць запиту");
  resetSent();
  await pressButton(TID, `fh:ok:${fh.id}`);
  assert.equal((await row(fh.id)).workerResponse, "confirmed");
  assert.match(sentText(), /підтверджено/i);
  // чужий запит — як і раніше «неактуальний»
  const [other] = await db.insert(workersTable).values({ fullName: "Inny", telegramId: "800516", isActive: true }).returning();
  const [fh2] = await db.insert(factoryHoursTable).values({ workerId: other!.id, month: "2026-10", factoryId: fh.factoryId, hours: 10 } as any).returning();
  await pressButton(TID, `fh:ok:${fh2!.id}`);
  assert.equal((await row(fh2!.id)).workerResponse, null);
});
