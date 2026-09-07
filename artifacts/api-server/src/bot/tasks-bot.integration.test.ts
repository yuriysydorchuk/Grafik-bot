// Бот модуля «Задачі»: кнопка «📋 Задачі» лише зі сторінкою /tasks, списки з кнопками,
// швидке створення задачі текстом, інлайн-дії (готово / завтра / буду), дайджести:
// ранковий, вечірній з «усе на завтра», тижневий звіт головному.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { hasTestDb, resetDb, closeDb, db, sendStart, sendText, pressButton, resetSent, sent, sentText } from "../test/botHarness.ts";
import { seedRole, adminsTable, tasksTable, taskAssigneesTable, rolesTable } from "../test/harness.ts";
import { createTask } from "../services/tasks.ts";
import { buildMorningDigest, buildEveningSummary, sendMorningDigests, sendWeeklyControlReport, runTaskDigestTick } from "../services/taskDigest.ts";
import { addDaysStr } from "../lib/dates.ts";
import { invalidateRolesCache } from "../lib/auth.ts";

const opts = { skip: hasTestDb ? false : "set TEST_DATABASE_URL to run integration tests" };
beforeEach(async () => { if (hasTestDb) { await resetDb(); resetSent(); } });
after(async () => { if (hasTestDb) await closeDb(); });
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const lastKeyboard = (): string[] => { const s = [...sent].reverse().find(x => x.extra?.reply_markup?.keyboard); return s ? (s.extra.reply_markup.keyboard as any[]).flat().map(b => typeof b === "string" ? b : b.text) : []; };
const lastInline = (): string[] => { const s = [...sent].reverse().find(x => x.extra?.reply_markup?.inline_keyboard); return s ? (s.extra.reply_markup.inline_keyboard as any[]).flat().map(b => b.callback_data ?? b.url) : []; };

test("меню: «📋 Задачі» лише зі сторінкою /tasks; зведення, список на сьогодні з кнопками, готово через кнопку", opts, async () => {
  await seedRole("office", ["editData"], ["/workers", "/tasks"], ["tasks"]);
  await seedRole("noaccess", ["editData"], ["/workers"], []);
  const [a] = await db.insert(adminsTable).values({ name: "Office", role: "office", telegramId: "810100" }).returning();
  await db.insert(adminsTable).values({ name: "NoAccess", role: "noaccess", telegramId: "810200" });
  await sendStart("810100");
  assert.ok(lastKeyboard().includes("📋 Задачі"), `є кнопка: ${lastKeyboard().join(" | ")}`);
  resetSent(); await sendStart("810200");
  assert.ok(!lastKeyboard().includes("📋 Задачі"), "без /tasks кнопки нема");

  const t1 = await createTask({ title: "Перевірити скан", dueAt: today, assigneeAdminId: a!.id, notify: false }, a!.id);
  await createTask({ title: "Стара", dueAt: addDaysStr(today, -3), assigneeAdminId: a!.id, notify: false }, a!.id);
  resetSent(); await sendText("810100", "📋 Задачі");
  assert.match(sentText(), /Мої задачі/); assert.match(sentText(), /Прострочено 1/); assert.match(sentText(), /Сьогодні 1/);
  assert.ok(lastInline().includes("tskm:today"));
  resetSent(); await pressButton("810100", "tskm:today");
  assert.match(sentText(), /Перевірити скан/);
  assert.ok(lastInline().includes(`tsk:done:${t1.id}`));
  await pressButton("810100", `tsk:done:${t1.id}`);
  const [after1] = await db.select().from(tasksTable).where(eq(tasksTable.id, t1.id));
  assert.equal(after1?.status, "done");
});

test("швидка задача текстом: «завтра 10:00 подзвонити» → строк завтра, час 10:00", opts, async () => {
  await seedRole("office", ["editData"], ["/tasks"], ["tasks"]);
  const [a] = await db.insert(adminsTable).values({ name: "Office", role: "office", telegramId: "810300" }).returning();
  await sendStart("810300"); resetSent();
  await sendText("810300", "📋 Задачі");
  await pressButton("810300", "tskm:new");
  assert.match(sentText(), /Напиши назву/);
  resetSent(); await sendText("810300", "завтра 10:00 подзвонити в urząd");
  assert.match(sentText(), /Задачу створено/);
  const [t] = await db.select().from(tasksTable).where(eq(tasksTable.creatorAdminId, a!.id));
  assert.equal(t?.title, "подзвонити в urząd"); assert.equal(String(t?.dueAt), addDaysStr(today, 1)); assert.equal(t?.dueTime, "10:00"); assert.equal(t?.assigneeAdminId, a!.id);
});

test("зустріч: запрошення з кнопками, «Не зможу» → автору сповіщення; групова: моя частина", opts, async () => {
  await seedRole("office", ["editData", "tasksGroup"], ["/tasks"], ["tasks"]);
  const [lead] = await db.insert(adminsTable).values({ name: "Lead", role: "office", telegramId: "810400" }).returning();
  const [p] = await db.insert(adminsTable).values({ name: "Part", role: "office", telegramId: "810500" }).returning();
  resetSent();
  const m = await createTask({ kind: "meeting", title: "Збори", dueAt: addDaysStr(today, 1), dueTime: "15:00", assigneeIds: [p!.id] }, lead!.id);
  const invite = sent.find(s => String(s.chatId) === "810500");
  assert.ok(invite, "учасник отримав запрошення"); assert.match(invite!.text ?? "", /Запрошення: Збори/);
  resetSent(); await pressButton("810500", `tsk:no:${m.id}`);
  const [pa] = await db.select().from(taskAssigneesTable).where(eq(taskAssigneesTable.taskId, m.id));
  assert.equal(pa?.status, "declined");
  assert.ok(sent.some(s => String(s.chatId) === "810400" && /не зможе/.test(s.text ?? "")), "автор дізнався");
  const g = await createTask({ kind: "group", title: "Здати звіти", assigneeIds: [p!.id], notify: false }, lead!.id);
  await pressButton("810500", `tsk:part:${g.id}`);
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, g.id)))[0]?.status, "done", "єдиний учасник відмітив → виконано");
});

test("дайджести: ранковий (топ-5 з кнопками, порожній → не шлеться), вечірній з «усе на завтра», тижневий звіт головному, дедуп тіку", opts, async () => {
  await seedRole("office", ["editData"], ["/tasks"], ["tasks"]);
  await seedRole("owner", [], ["/tasks"], ["tasks"]);
  await db.update(rolesTable).set({ pages: ["/tasks", "/workers"], notify: ["tasks"] }).where(eq(rolesTable.key, "owner"));
  invalidateRolesCache();
  const [a] = await db.insert(adminsTable).values({ name: "Office", role: "office", telegramId: "810600" }).returning();
  const [main] = await db.insert(adminsTable).values({ name: "Main", role: "owner", telegramId: "810700", isMain: true }).returning();
  assert.equal(await buildMorningDigest(a!.id, today), null, "без задач дайджесту нема");
  await createTask({ title: "Прострочене", dueAt: addDaysStr(today, -2), assigneeAdminId: a!.id, notify: false }, main!.id);
  await createTask({ title: "На сьогодні", dueAt: today, assigneeAdminId: a!.id, notify: false }, main!.id);
  await createTask({ kind: "meeting", title: "Дзвінок", dueAt: today, dueTime: "14:00", assigneeIds: [a!.id], notify: false }, main!.id);
  const d = await buildMorningDigest(a!.id, today);
  assert.ok(d); assert.match(d!.text, /прострочено \*1\*/); assert.match(d!.text, /зустрічей \*1\*/); assert.match(d!.text, /14:00/);
  assert.ok(d!.kb.flat().some((b: any) => String(b.callback_data).startsWith("tsk:done:")));
  resetSent();
  assert.equal(await sendMorningDigests(today), 1, "лише той, у кого є задачі (у Main їх нема)");
  assert.equal(sent.filter(s => String(s.chatId) === "810600").length, 1);

  const e = await buildEveningSummary(a!.id, today);
  assert.ok(e); assert.match(e!.text, /лишилось \*2\*/);
  resetSent(); await pressButton("810600", "tsk:allTomorrow");
  const rows = await db.select().from(tasksTable).where(eq(tasksTable.assigneeAdminId, a!.id));
  assert.ok(rows.every(r => String(r.plannedFor) === addDaysStr(today, 1)), "усе перенесено на завтра");

  resetSent();
  assert.equal(await sendWeeklyControlReport(today), true);
  const rep = sent.find(s => String(s.chatId) === "810700");
  assert.ok(rep && /Задачі за тиждень/.test(rep.text ?? "") && /Office: виконано 0 · відкрито 3 · прострочено \*1\*/.test(rep.text ?? ""), rep?.text);

  // тік: у час дайджесту шле раз на день (дедуп-ключі в settings переживають resetDb — чистимо)
  await db.execute(sql`delete from settings where key like 'tasks.%'`);
  resetSent();
  const at = (h: string) => { const d = new Date(); const [hh, mm] = h.split(":").map(Number); const w = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Warsaw" })); const off = d.getTime() - w.getTime(); const x = new Date(w); x.setHours(hh!, mm!, 0, 0); return new Date(x.getTime() + off); };
  await runTaskDigestTick(at("07:31"));
  const isWeekend = [0, 6].includes(new Date(today + "T00:00:00Z").getUTCDay());
  if (!isWeekend) {
    assert.equal(sent.filter(s => String(s.chatId) === "810600" && /Доброго ранку/.test(s.text ?? "")).length, 1);
    resetSent(); await runTaskDigestTick(at("07:33"));
    assert.equal(sent.length, 0, "дедуп: другий тік того ж дня не шле");
  }
});
