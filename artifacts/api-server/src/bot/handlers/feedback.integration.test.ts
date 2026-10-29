// Бот-кнопки модуля «Зголошення» (bot/handlers/feedback.ts) через бот-харнес: головний
// приймає / уточнює / відхиляє / «виправлено», автор відповідає / «працює» / «досі ні»;
// хук виконаної задачі; крон-функції (нагадування, автопідтвердження, вечірній підсумок, рядок тижня).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { hasTestDb, resetDb, closeDb, db, pressButton, sendText, resetSent, sent, sentText } from "../../test/botHarness.ts";
import { seedAdmin, seedRole, adminsTable } from "../../test/harness.ts";
import { feedbackReportsTable, feedbackCommentsTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createReport, loadReport, setStatus, createTaskFromReport, feedbackDailyTick, sendFeedbackEveningSummary, feedbackWeeklyLine, saveFeedbackSettings } from "../../services/feedback.ts";
import { setTaskStatus, loadTask } from "../../services/tasks.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });

async function seed() {
  await seedRole("owner", [], [], ["feedback"]);
  await seedRole("scheduler", ["editData"], ["/", "/schedule"], []);
  const main = await seedAdmin({ role: "owner", isMain: true, name: "Yuriy" });
  const author = await seedAdmin({ role: "scheduler", name: "Marta" });
  // харнес генерує hex telegram_id, а Telegram-апдейт несе числовий from.id — ставимо числові
  const mainTid = "910100", authorTid = "910200";
  await db.update(adminsTable).set({ telegramId: mainTid }).where(eq(adminsTable.id, main.adminId));
  await db.update(adminsTable).set({ telegramId: authorTid }).where(eq(adminsTable.id, author.adminId));
  const r = await createReport({ kind: "bug", severity: "hinders", description: "Тиждень скочив назад", steps: "змінила фабрику", aboutPage: true, pagePath: "/schedule", pageLabel: "Графіки", breadcrumbs: [], context: {} }, { adminId: author.adminId, role: "scheduler", isMain: false });
  return { main, author, mainTid, authorTid, r };
}
const status = async (id: number) => (await db.select({ s: feedbackReportsTable.status }).from(feedbackReportsTable).where(eq(feedbackReportsTable.id, id)))[0]!.s;
const comments = (id: number) => db.select().from(feedbackCommentsTable).where(eq(feedbackCommentsTable.reportId, id));

test("бот: прийняти → уточнити (текст) → автор відповідає → виправлено → «досі ні» → «працює»", opts, async () => {
  const { main, mainTid, authorTid, r } = await seed();
  // не головний — кнопки головного не діють
  await pressButton(authorTid, `fb:accept:${r.id}`);
  assert.equal(await status(r.id), "new");
  await pressButton(mainTid, `fb:accept:${r.id}`);
  assert.equal(await status(r.id), "review");
  assert.match(sentText(), /Прийнято/);
  // уточнити: кнопка → текст → clarify + пуш автору з кнопкою відповіді
  resetSent();
  await pressButton(mainTid, `fb:ask:${r.id}`);
  await sendText(mainTid, "Це на всіх фабриках чи лише Agram?");
  assert.equal(await status(r.id), "clarify");
  const toAuthor = sent.find(s => String(s.chatId) === authorTid && /Запитання по зголошенню/.test(s.text ?? ""));
  assert.ok(toAuthor, "автор не отримав запитання: " + sentText());
  assert.ok(JSON.stringify(toAuthor!.extra).includes(`fb:reply:${r.id}`));
  // автор відповідає з бота → review + пуш головному
  resetSent();
  await pressButton(authorTid, `fb:reply:${r.id}`);
  await sendText(authorTid, "Лише Agram");
  assert.equal(await status(r.id), "review");
  assert.ok((await comments(r.id)).some(c => c.kind === "comment" && c.via === "bot" && c.body === "Лише Agram"));
  assert.ok(sent.some(s => String(s.chatId) === mainTid && /Коментар автора/.test(s.text ?? "")));
  // виправлено → автору кнопки працює/досі ні
  resetSent();
  await setStatus((await loadReport(r.id))!, "fixed", main.adminId, { via: "web", reply: "Виправили" });
  const fixedMsg = sent.find(s => String(s.chatId) === authorTid && /виправлено/i.test(s.text ?? ""));
  assert.ok(fixedMsg && JSON.stringify(fixedMsg.extra).includes(`fb:ok:${r.id}`) && /Виправили/.test(fixedMsg.text ?? ""));
  // «досі ні» + текст → in_progress + пуш головному
  resetSent();
  await pressButton(authorTid, `fb:no:${r.id}`);
  await sendText(authorTid, "досі скаче");
  assert.equal(await status(r.id), "in_progress");
  assert.ok(sent.some(s => String(s.chatId) === mainTid && /не виправлено/.test(s.text ?? "")));
  // знову виправлено → «працює» → confirmed; повторне натискання — нічого
  await setStatus((await loadReport(r.id))!, "fixed", main.adminId, { via: "web" });
  await pressButton(authorTid, `fb:ok:${r.id}`);
  assert.equal(await status(r.id), "confirmed");
  await pressButton(authorTid, `fb:no:${r.id}`);
  assert.equal(await status(r.id), "confirmed");
});

test("бот: відхилити з причиною; fb:fixed з пушу про виконану задачу", opts, async () => {
  const { main, mainTid, authorTid, r } = await seed();
  resetSent();
  await pressButton(mainTid, `fb:reject:${r.id}`);
  await sendText(mainTid, "Суперечить правилу скоупу");
  assert.equal(await status(r.id), "rejected");
  const row = (await loadReport(r.id))!;
  assert.equal(row.reply, "Суперечить правилу скоупу");
  assert.ok(sent.some(s => String(s.chatId) === authorTid && /відхилено/.test(s.text ?? "") && /Суперечить/.test(s.text ?? "")));
  // друге зголошення → задача → виконано → головному пуш з fb:fixed → натиснув → fixed + автору кнопки
  const r2 = await createReport({ kind: "wish", description: "Фільтр по фірмі в експорті", aboutPage: true, pagePath: "/workers", breadcrumbs: [], context: {} }, { adminId: row.authorAdminId, role: "scheduler", isMain: false });
  const taskId = await createTaskFromReport(r2, main.adminId);
  resetSent();
  await setTaskStatus((await loadTask(taskId))!, "done", main.adminId);
  const hook = sent.find(s => String(s.chatId) === mainTid && /Задачу по зголошенню виконано/.test(s.text ?? ""));
  assert.ok(hook && JSON.stringify(hook.extra).includes(`fb:fixed:${r2.id}`), sentText());
  assert.ok((await comments(r2.id)).some(c => c.kind === "system" && /задачу #/.test(c.body)));
  resetSent();
  await pressButton(mainTid, `fb:fixed:${r2.id}`);
  assert.equal(await status(r2.id), "fixed");
  assert.ok(sent.some(s => String(s.chatId) === authorTid && JSON.stringify(s.extra).includes(`fb:ok:${r2.id}`)));
});

test("крони: нагадування й автопідтвердження, вечірній підсумок, рядок тижневого звіту", opts, async () => {
  const { main, mainTid, authorTid, r } = await seed();
  await saveFeedbackSettings({ remindDays: 3, confirmDays: 7 }); // settings не чистяться resetDb — задаємо явно
  await setStatus((await loadReport(r.id))!, "fixed", main.adminId, { via: "web", notify: false });
  // 4 дні тому → нагадування (remind_days=3), ще не автопідтвердження (confirm_days=7)
  const d4 = new Date(Date.now() - 4 * 86400_000);
  await db.update(feedbackReportsTable).set({ confirmRequestedAt: d4 }).where(eq(feedbackReportsTable.id, r.id));
  resetSent();
  let t = await feedbackDailyTick();
  assert.deepEqual(t, { reminded: 1, autoConfirmed: 0 });
  assert.ok(sent.some(s => String(s.chatId) === authorTid && /Нагадування/.test(s.text ?? "")));
  t = await feedbackDailyTick();
  assert.deepEqual(t, { reminded: 0, autoConfirmed: 0 }, "нагадування лише раз");
  const d8 = new Date(Date.now() - 8 * 86400_000);
  await db.update(feedbackReportsTable).set({ confirmRequestedAt: d8 }).where(eq(feedbackReportsTable.id, r.id));
  t = await feedbackDailyTick();
  assert.deepEqual(t, { reminded: 0, autoConfirmed: 1 });
  assert.equal(await status(r.id), "confirmed");
  // вечірній підсумок: є нове за сьогодні → головному; другий виклик того ж дня — дедуп
  await createReport({ kind: "question", description: "Як поставити виповідзення?", aboutPage: false, breadcrumbs: [], context: {} }, { adminId: (await loadReport(r.id))!.authorAdminId, role: "scheduler", isMain: false });
  resetSent();
  await db.delete(settingsTable).where(eq(settingsTable.key, "feedback.evening.sent")); // resetDb не чистить settings — дедуп-ключ з попереднього прогону
  assert.equal(await sendFeedbackEveningSummary(), true);
  assert.ok(sent.some(s => String(s.chatId) === mainTid && /Вечірній підсумок зголошень/.test(s.text ?? "") && /Нових за день/.test(s.text ?? "")), sentText());
  assert.equal(await sendFeedbackEveningSummary(), false);
  // рядок тижневого звіту
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
  const line = await feedbackWeeklyLine(today, today);
  assert.ok(line && /Зголошення: нових 2/.test(line) && /закрито 1/.test(line), line ?? "null");
});
