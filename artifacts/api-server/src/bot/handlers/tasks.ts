// Модуль «Задачі» в боті офісу: кнопка «📋 Задачі» (зведення + списки), інлайн-дії на
// сповіщеннях і дайджестах (беру в роботу / готово / завтра / буду / не зможу / моя
// частина / прийняти / повернути / усе на завтра), швидке створення задачі собі.
// Лише адміни зі сторінкою /tasks. Дайджести — services/taskDigest.ts.
// Реєструється РАНІШЕ за загальні text-хендлери: свій стан пропускає чужі через next().
import { Markup, type Telegraf } from "telegraf";
import { getAdmin, adminHasPage, adminMenuFor } from "../roles";
import { tb, bhears, oLang, type Lang } from "../i18n";
import { setState, getState, clearState } from "../state";
import {
  loadTask, setTaskStatus, respondAssignee, snoozeTask, planTask, isParticipant, createTask, addComment, myCounters, mdEsc, warsawToday, fmtDate, dateStr, diffDays, OPEN_STATUSES,
} from "../../services/tasks";
import { db, tasksTable } from "@workspace/db";
import { and, eq, inArray, or, sql, lte, isNull } from "drizzle-orm";
import { addDaysStr } from "../../lib/dates";
import { hasCap } from "../../lib/roles";
import { loadRolesCache } from "../../lib/auth";

const S_NEW = "task:new_title";
const S_REPLY = "task:reply"; // «💬 Відповісти» під сповіщенням → наступний текст = коментар до задачі
const panelUrl = () => (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");

async function adminCanManage(admin: { role: string }): Promise<boolean> {
  const cache = await loadRolesCache();
  return hasCap(admin.role, cache.get(admin.role)?.caps ?? [], "tasksManage");
}

async function myOpen(adminId: number, today: string) {
  const rows = await db.select().from(tasksTable).where(and(
    inArray(tasksTable.status, OPEN_STATUSES),
    or(eq(tasksTable.assigneeAdminId, adminId), sql`exists (select 1 from task_assignees a where a.task_id = ${tasksTable.id} and a.admin_id = ${adminId})`),
    or(isNull(tasksTable.snoozedUntil), lte(tasksTable.snoozedUntil, today)),
  ));
  return rows.map(t => ({ ...t, due: dateStr(t.dueAt), planned: dateStr(t.plannedFor) }));
}

function summaryKb(lang: Lang) {
  const rows: any[][] = [
    [{ text: tb(lang, "🔴 Прострочені"), callback_data: "tskm:overdue" }, { text: tb(lang, "🟠 На сьогодні"), callback_data: "tskm:today" }],
    [{ text: tb(lang, "⚪ Цього тижня"), callback_data: "tskm:week" }, { text: tb(lang, "➕ Нова задача"), callback_data: "tskm:new" }],
  ];
  if (panelUrl()) rows.push([{ text: tb(lang, "🔗 Відкрити панель"), url: `${panelUrl()}/tasks` }]);
  return rows;
}

export function registerTaskActions(bot: Telegraf<any>) {
  // «📋 Задачі» — зведення
  bot.hears(bhears("📋 Задачі"), async (ctx, next) => {
    const admin = await getAdmin(String(ctx.from.id));
    if (!admin) return next();
    const lang = oLang(admin.language);
    if (!(await adminHasPage(admin, "/tasks"))) return ctx.reply(tb(lang, "⛔️ Ця дія недоступна для твоєї ролі. Доступ вмикає головний адмін у налаштуваннях ролей."), await adminMenuFor(admin, lang));
    const c = await myCounters(admin.id);
    return ctx.reply(
      `📋 *${tb(lang, "Мої задачі")}*\n🔴 ${tb(lang, "Прострочено")} ${c.overdue} · 🟠 ${tb(lang, "Сьогодні")} ${c.today} · ⚪ ${tb(lang, "Тиждень")} ${c.week}${c.meetingsToday ? ` · 🗓 ${c.meetingsToday}` : ""}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: summaryKb(lang) } },
    );
  });

  // списки: прострочені / сьогодні / тиждень — до 10 з кнопками
  bot.action(/^tskm:(overdue|today|week)$/, async (ctx) => {
    const admin = await getAdmin(String(ctx.from!.id));
    if (!admin) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    const lang = oLang(admin.language);
    const kind = (ctx.match as RegExpMatchArray)[1]!;
    const today = warsawToday();
    const all = await myOpen(admin.id, today);
    const list = kind === "overdue" ? all.filter(t => t.due && t.due < today && t.kind !== "meeting")
      : kind === "today" ? all.filter(t => t.due === today || t.planned === today)
      : all.filter(t => t.due && t.due > today && t.due <= addDaysStr(today, 6));
    list.sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9") || (a.dueTime ?? "").localeCompare(b.dueTime ?? ""));
    const title = kind === "overdue" ? tb(lang, "🔴 Прострочені") : kind === "today" ? tb(lang, "🟠 На сьогодні") : tb(lang, "⚪ Цього тижня");
    if (!list.length) return ctx.reply(`${title}: ${tb(lang, "нічого немає")} ✓`);
    const lines = [`*${title}* · ${list.length}`];
    const kb: any[][] = [];
    list.slice(0, 10).forEach((t, i) => {
      const sfx = t.kind === "meeting" ? ` · ${t.dueTime ?? ""}` : t.due ? (t.due < today ? ` · −${diffDays(today, t.due)} дн.` : ` · ${fmtDate(t.due)}`) : "";
      lines.push(`*${i + 1}.* ${t.kind === "meeting" ? "🗓 " : ""}${mdEsc(t.title)}${(t.autoParams as any)?.workerName ? ` · ${mdEsc(String((t.autoParams as any).workerName))}` : ""}${sfx}`);
      if (t.kind !== "meeting") kb.push([{ text: `✅ ${i + 1}`, callback_data: `tsk:done:${t.id}` }, { text: `▶ ${i + 1}`, callback_data: `tsk:start:${t.id}` }, { text: `⏰ ${i + 1}`, callback_data: `tsk:snooze:${t.id}` }]);
    });
    if (list.length > 10) lines.push(`…${tb(lang, "ще")} ${list.length - 10} ${tb(lang, "у панелі")}`);
    return ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } });
  });

  // швидка задача собі: назва одним повідомленням («завтра …» / «дд.мм …» / «HH:MM …» як у панелі)
  bot.action("tskm:new", async (ctx) => {
    const tid = String(ctx.from!.id);
    const admin = await getAdmin(tid);
    if (!admin) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    const lang = oLang(admin.language);
    setState(tid, S_NEW, {});
    return ctx.reply(tb(lang, "Напиши назву задачі. Можна з датою: «завтра 10:00 подзвонити в urząd», «12.09 замовити одяг»."), Markup.keyboard([[tb(lang, "✖️ Скасувати")]]).resize());
  });
  bot.action(/^tsk:reply:(\d+)$/, async (ctx) => {
    const tid = String(ctx.from!.id);
    const admin = await getAdmin(tid);
    if (!admin) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    const task = await loadTask(Number((ctx.match as RegExpMatchArray)[1]));
    if (!task) return ctx.reply("Задачу не знайдено");
    setState(tid, S_REPLY, { taskId: task.id });
    return ctx.reply(`💬 ${tb(oLang(admin.language), "Напишіть коментар до задачі")}: *${mdEsc(task.title)}*`, { parse_mode: "Markdown", ...Markup.keyboard([[tb(oLang(admin.language), "✖️ Скасувати")]]).resize() });
  });
  bot.on("text", async (ctx, next) => {
    const tid = String(ctx.from.id);
    const st = getState(tid);
    if (st?.action === S_REPLY) {
      const admin = await getAdmin(tid);
      if (!admin) { clearState(tid); return next(); }
      const lang = oLang(admin.language);
      const text = ctx.message.text.trim();
      clearState(tid);
      if (/^✖️|^❌|скасувати|cancel/i.test(text)) return ctx.reply(tb(lang, "Скасовано"), await adminMenuFor(admin, lang));
      const task = await loadTask(Number((st.data as any)?.taskId));
      if (!task) return ctx.reply("Задачу не знайдено", await adminMenuFor(admin, lang));
      await addComment(task, admin.id, text);
      return ctx.reply(`✅ ${tb(lang, "Коментар додано")}`, await adminMenuFor(admin, lang));
    }
    if (st?.action !== S_NEW) return next();
    const admin = await getAdmin(tid);
    if (!admin) { clearState(tid); return next(); }
    const lang = oLang(admin.language);
    let s = ctx.message.text.trim();
    if (/^✖️|^❌|скасувати|cancel/i.test(s)) { clearState(tid); return ctx.reply(tb(lang, "Скасовано"), await adminMenuFor(admin, lang)); }
    const today = warsawToday(); let dueAt = today; let dueTime: string | null = null;
    const m1 = s.match(/^(сьогодні|завтра|післязавтра|today|tomorrow)\s+/i);
    if (m1) { const w = m1[1]!.toLowerCase(); dueAt = w === "завтра" || w === "tomorrow" ? addDaysStr(today, 1) : w === "післязавтра" ? addDaysStr(today, 2) : today; s = s.slice(m1[0].length); }
    const m2 = s.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{4})?\s+/);
    if (m2) { dueAt = `${m2[3] ?? today.slice(0, 4)}-${m2[2]!.padStart(2, "0")}-${m2[1]!.padStart(2, "0")}`; s = s.slice(m2[0].length); }
    const m3 = s.match(/^(\d{1,2}):(\d{2})\s+/);
    if (m3) { dueTime = `${m3[1]!.padStart(2, "0")}:${m3[2]}`; s = s.slice(m3[0].length); }
    clearState(tid);
    const t = await createTask({ title: s || ctx.message.text.trim(), dueAt, dueTime, plannedFor: dueAt === today ? today : null, notify: false }, admin.id);
    return ctx.reply(`✅ ${tb(lang, "Задачу створено")}: *${mdEsc(t.title)}* · ${fmtDate(dueAt)}${dueTime ? ` ${dueTime}` : ""}`, { parse_mode: "Markdown", ...(await adminMenuFor(admin, lang)) });
  });

  // вечірній підсумок: усе невиконане сьогодні → завтра
  bot.action("tsk:allTomorrow", async (ctx) => {
    const admin = await getAdmin(String(ctx.from!.id));
    if (!admin) return ctx.answerCbQuery().catch(() => {});
    const today = warsawToday(), tomorrow = addDaysStr(today, 1);
    const all = await myOpen(admin.id, today);
    const left = all.filter(t => t.kind !== "meeting" && ((t.due && t.due <= today) || t.planned === today));
    for (const t of left) await planTask(t, tomorrow, null, admin.id);
    await ctx.answerCbQuery(`→ ${left.length}`).catch(() => {});
    const old = (ctx.callbackQuery as any)?.message?.text as string | undefined;
    if (old) await ctx.editMessageText(`${old}\n\n— ${tb(oLang(admin.language), "перенесено на завтра")}: ${left.length}`).catch(() => {});
  });

  // вечірній підсумок: усе невиконане → понеділок (наступний)
  bot.action("tsk:allMonday", async (ctx) => {
    const admin = await getAdmin(String(ctx.from!.id));
    if (!admin) return ctx.answerCbQuery().catch(() => {});
    const today = warsawToday();
    const wd = (new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7; // 0=Пн
    const monday = addDaysStr(today, 7 - wd);
    const all = await myOpen(admin.id, today);
    const left = all.filter(t => t.kind !== "meeting" && ((t.due && t.due <= today) || t.planned === today));
    for (const t of left) await planTask(t, monday, null, admin.id);
    await ctx.answerCbQuery(`→ ${left.length}`).catch(() => {});
    const old = (ctx.callbackQuery as any)?.message?.text as string | undefined;
    if (old) await ctx.editMessageText(`${old}\n\n— ${tb(oLang(admin.language), "перенесено на понеділок")}: ${left.length}`).catch(() => {});
  });

  // контекстні дії «Як вирішити» (запит скану, підтвердити файл, перерахунок …) — services/taskResolve
  bot.action(/^tska:([a-z_]+(?:\.\d+)?):(\d+)$/, async (ctx) => {
    const admin = await getAdmin(String(ctx.from!.id));
    if (!admin) return ctx.answerCbQuery("Лише для офісу").catch(() => {});
    const code = (ctx.match as RegExpMatchArray)[1]!;
    const task = await loadTask(Number((ctx.match as RegExpMatchArray)[2]));
    if (!task) return ctx.answerCbQuery("Задачу не знайдено").catch(() => {});
    if (!(await isParticipant(task, admin.id)) && task.creatorAdminId !== admin.id && !(await adminCanManage(admin))) return ctx.answerCbQuery("⛔ не ваша задача").catch(() => {});
    try {
      const { runTaskAction } = await import("../../services/taskResolve");
      const msg = await runTaskAction(task, code, { adminId: admin.id, name: admin.name });
      await ctx.answerCbQuery(msg.slice(0, 190)).catch(() => {});
      const old = (ctx.callbackQuery as any)?.message?.text as string | undefined;
      if (old) await ctx.editMessageText(`${old}\n\n— ${msg} · ${admin.name ?? ""}`, { reply_markup: (ctx.callbackQuery as any).message.reply_markup }).catch(() => {});
    } catch (e: any) { await ctx.answerCbQuery(`⛔ ${e?.message ?? "помилка"}`).catch(() => {}); }
  });

  // інлайн-дії на сповіщеннях/дайджестах
  bot.action(/^tsk:(start|done|snooze|yes|no|part|accept|return):(\d+)$/, async (ctx) => {
    const tid = String(ctx.from!.id);
    const admin = await getAdmin(tid);
    if (!admin) return ctx.answerCbQuery("Лише для офісу").catch(() => {});
    const action = (ctx.match as RegExpMatchArray)[1]!;
    const task = await loadTask(Number((ctx.match as RegExpMatchArray)[2]));
    if (!task) return ctx.answerCbQuery("Задачу не знайдено").catch(() => {});
    const participant = await isParticipant(task, admin.id);
    const manage = await adminCanManage(admin);
    let stamp = "";
    try {
      if (action === "start") { if (!participant && !manage) throw new Error("не ваша задача"); await setTaskStatus(task, "in_progress", admin.id); stamp = "▶ у роботі"; }
      else if (action === "done") { if (!participant && !manage) throw new Error("не ваша задача"); const u = await setTaskStatus(task, "done", admin.id); stamp = u.status === "review" ? "🔎 на перевірці в автора" : "✅ виконано"; }
      else if (action === "snooze") { if (!participant && !manage) throw new Error("не ваша задача"); await snoozeTask(task, 1, admin.id); stamp = "⏰ нагадаю завтра"; }
      else if (action === "yes" || action === "no") { if (!participant) throw new Error("ви не учасник"); await respondAssignee(task, admin.id, action === "yes" ? "accepted" : "declined"); stamp = action === "yes" ? "✅ буду" : "❌ не зможу"; }
      else if (action === "part") { if (!participant) throw new Error("ви не учасник"); await respondAssignee(task, admin.id, "done"); stamp = "✅ моя частина готова"; }
      else if (action === "accept" || action === "return") {
        if (task.creatorAdminId !== admin.id && !manage) throw new Error("лише автор");
        if (task.status !== "review") throw new Error("задача не на перевірці");
        await setTaskStatus(task, action === "accept" ? "done" : "in_progress", admin.id, action === "return" ? "повернуто з бота" : null);
        stamp = action === "accept" ? "✅ прийнято" : "↩️ повернуто виконавцю";
      }
    } catch (e: any) { return ctx.answerCbQuery(`⛔ ${e?.message ?? "помилка"}`).catch(() => {}); }
    await ctx.answerCbQuery(stamp).catch(() => {});
    // штамп на повідомленні; у списках/дайджестах (кілька задач) кнопки лишаються, лише дописуємо рядок
    const old = (ctx.callbackQuery as any)?.message?.text as string | undefined;
    const multi = !!(ctx.callbackQuery as any)?.message?.reply_markup?.inline_keyboard?.some((r: any[]) => r.length && String(r[0]?.callback_data ?? "").match(/^tsk:(done|start|snooze):\d+$/) && r[0].text.match(/\d/));
    if (old) {
      if (multi) await ctx.editMessageText(`${old}\n— ${stamp}: ${mdEsc(task.title).slice(0, 60)}`, { reply_markup: (ctx.callbackQuery as any).message.reply_markup }).catch(() => {});
      else await ctx.editMessageText(`${old}\n\n— ${stamp} · ${mdEsc(admin.name ?? "")}`).catch(() => {});
    }
  });
}
