// Модуль «Задачі» — бот-дайджести офісу: ранковий (settings.digestTime, типово 07:30),
// вечірній підсумок дня (eveningTime, 17:30), тижневий звіт контролю головному (пн 08:00).
// Тік крону кожні 5 хв звіряє час із налаштуваннями і дедупить по settings-ключах,
// щоб рестарт сервера не подвоював розсилку. Повага до notify-префів ролі (тип tasks).
import { db, tasksTable, adminsTable, settingsTable, taskEventsTable, taskAssigneesTable } from "@workspace/db";
import { and, eq, inArray, lte, or, isNull, sql } from "drizzle-orm";
import { addDaysStr } from "../lib/dates";
import { notifyAdminById } from "../bot/notify";
import { adminHasPage } from "../bot/roles";
import { loadTaskSettings, mainAdminId, controlStats, logTaskEvent, warsawToday, fmtDate, dateStr, diffDays, mdEsc, OPEN_STATUSES, type TaskStatus } from "./tasks";
import { logger } from "../lib/logger";

const panelUrl = () => (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");
const nowHm = (d = new Date()) => d.toLocaleTimeString("sv-SE", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" }).slice(0, 5);
const isWeekend = (day: string) => { const wd = new Date(day + "T00:00:00Z").getUTCDay(); return wd === 0 || wd === 6; };

async function getSetting(key: string): Promise<string | null> {
  const [r] = await db.select({ v: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, key));
  return r?.v ?? null;
}
async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}

async function openTasksOf(adminId: number, today: string) {
  const rows = await db.select().from(tasksTable).where(and(
    inArray(tasksTable.status, OPEN_STATUSES),
    or(eq(tasksTable.assigneeAdminId, adminId), sql`exists (select 1 from task_assignees a where a.task_id = ${tasksTable.id} and a.admin_id = ${adminId})`),
    or(isNull(tasksTable.snoozedUntil), lte(tasksTable.snoozedUntil, today)),
  ));
  return rows.map(t => ({ ...t, due: dateStr(t.dueAt), planned: dateStr(t.plannedFor) }));
}

const line = (t: { title: string; autoParams: unknown; kind: string; dueTime: string | null }, suffix = "") =>
  `${t.kind === "meeting" ? "🗓 " : ""}${mdEsc(t.title)}${(t.autoParams as any)?.workerName ? ` · ${mdEsc(String((t.autoParams as any).workerName))}` : ""}${suffix}`;

// ── ранковий дайджест ───────────────────────────────────────────────────────
export async function buildMorningDigest(adminId: number, today = warsawToday()): Promise<{ text: string; kb: any[][] } | null> {
  const [a] = await db.select({ name: adminsTable.name }).from(adminsTable).where(eq(adminsTable.id, adminId));
  const all = await openTasksOf(adminId, today);
  const overdue = all.filter(t => t.due && t.due < today && t.kind !== "meeting").sort((x, y) => (x.due! < y.due! ? -1 : 1));
  const todayL = all.filter(t => t.kind !== "meeting" && !(t.due && t.due < today) && (t.due === today || t.planned === today));
  const meetings = all.filter(t => t.kind === "meeting" && t.due === today).sort((x, y) => (x.dueTime ?? "").localeCompare(y.dueTime ?? ""));
  const week = all.filter(t => t.due && t.due > today && t.due <= addDaysStr(today, 6)).length;
  if (!overdue.length && !todayL.length && !meetings.length && !week) return null;
  const parts = [`☀️ Доброго ранку, ${mdEsc(a?.name ?? "")}. Сьогодні:`];
  if (overdue.length) parts.push(`🔴 прострочено *${overdue.length}*`);
  parts.push(`🟠 задач *${todayL.length}*`);
  if (meetings.length) parts.push(`🗓 зустрічей *${meetings.length}*${meetings[0]?.dueTime ? ` (перша о ${meetings[0].dueTime})` : ""}`);
  parts.push(`⚪ цього тижня *${week}*`);
  const lines: string[] = [parts.join(" · ")];
  const kb: any[][] = [];
  const top = [...overdue, ...meetings, ...todayL].slice(0, 5);
  top.forEach((t, i) => {
    const sfx = t.kind === "meeting" ? ` · ${t.dueTime ?? ""}` : t.due && t.due < today ? ` · −${diffDays(today, t.due)} дн.` : t.due === today ? " · сьогодні" : "";
    lines.push(`*${i + 1}.* ${line(t, sfx)}`);
    if (t.kind !== "meeting") kb.push([{ text: `✅ ${i + 1}`, callback_data: `tsk:done:${t.id}` }, { text: `⏰ ${i + 1} завтра`, callback_data: `tsk:snooze:${t.id}` }, ...(panelUrl() ? [{ text: `🔗 ${i + 1}`, url: `${panelUrl()}/tasks?task=${t.id}` }] : [])]);
  });
  const rest = overdue.length + todayL.length + meetings.length - top.length;
  if (rest > 0) lines.push(`…ще ${rest} у панелі`);
  kb.push(panelUrl() ? [{ text: "📋 Відкрити «Мій день»", url: `${panelUrl()}/tasks` }, { text: "Показати списком тут", callback_data: "tskm:today" }] : [{ text: "📋 Мої задачі", callback_data: "tskm:today" }]);
  return { text: lines.join("\n"), kb };
}

export async function sendMorningDigests(today = warsawToday()): Promise<number> {
  const admins = await db.select().from(adminsTable);
  let sent = 0;
  for (const a of admins) {
    if (!a.telegramId || a.role === "driver" || !(await adminHasPage(a, "/tasks"))) continue;
    const d = await buildMorningDigest(a.id, today);
    if (!d) continue;
    if (await notifyAdminById(a.id, "tasks", d.text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: d.kb } })) sent++;
  }
  return sent;
}

// ── вечірній підсумок ───────────────────────────────────────────────────────
export async function buildEveningSummary(adminId: number, today = warsawToday()): Promise<{ text: string; kb: any[][] } | null> {
  const all = await openTasksOf(adminId, today);
  const left = all.filter(t => t.kind !== "meeting" && ((t.due && t.due <= today) || t.planned === today));
  const doneToday = await db.select({ c: sql<number>`count(*)` }).from(tasksTable).where(and(
    eq(tasksTable.status, "done" as TaskStatus), eq(tasksTable.completedById, adminId), sql`${tasksTable.completedAt}::date = ${today}`));
  const done = Number(doneToday[0]?.c ?? 0);
  if (!left.length && !done) return null;
  const tomorrow = addDaysStr(today, 1);
  const tmr = all.filter(t => t.due === tomorrow || t.planned === tomorrow);
  const tmrMeet = tmr.filter(t => t.kind === "meeting");
  const lines = [`🌇 *Підсумок дня, ${fmtDate(today)}*`, `✅ Зроблено *${done}* · лишилось *${left.length}*`];
  for (const t of left.slice(0, 6)) lines.push(`• ${line(t, t.rolloverCount ? ` _(${t.rolloverCount + 1}-й перенос)_` : "")}`);
  if (left.length > 6) lines.push(`…ще ${left.length - 6}`);
  if (tmr.length) lines.push(`\nЗавтра: ${tmr.length - tmrMeet.length} задач${tmrMeet.length ? `, 🗓 ${tmrMeet.map(m => `${m.dueTime ?? ""} ${mdEsc(m.title)}`).join(", ")}` : ""}`);
  const kb: any[][] = [];
  if (left.length) {
    kb.push([{ text: "→ Усе на завтра", callback_data: "tsk:allTomorrow" }, { text: "📅 Вибрати по одній", callback_data: "tskm:today" }]);
    const wd = new Date(today + "T00:00:00Z").getUTCDay();
    if (wd === 5 || wd === 6 || wd === 0) kb.push([{ text: "→ На понеділок", callback_data: "tsk:allMonday" }]);
  }
  return { text: lines.join("\n"), kb };
}

// ── нагадування про зустрічі: за день (у час вечірнього підсумку) і за годину ─────
async function meetingReminded(taskId: number, kind: string): Promise<boolean> {
  const [r] = await db.select({ id: taskEventsTable.id }).from(taskEventsTable).where(and(eq(taskEventsTable.taskId, taskId), eq(taskEventsTable.kind, kind)));
  return !!r;
}
async function meetingParticipants(taskId: number): Promise<number[]> {
  return (await db.select({ adminId: taskAssigneesTable.adminId }).from(taskAssigneesTable).where(eq(taskAssigneesTable.taskId, taskId))).map(r => r.adminId);
}
async function confirmedCount(taskId: number): Promise<{ yes: number; total: number }> {
  const rows = await db.select({ status: taskAssigneesTable.status }).from(taskAssigneesTable).where(eq(taskAssigneesTable.taskId, taskId));
  return { yes: rows.filter(r => r.status === "accepted").length, total: rows.length };
}
export async function sendMeetingReminders(now = new Date(), today = warsawToday()): Promise<number> {
  const hm = nowHm(now);
  const [h, m] = hm.split(":").map(Number);
  const nowMin = h! * 60 + m!;
  let sent = 0;
  // за годину: зустрічі сьогодні з часом у вікні [+60, +65) хв
  const todays = await db.select().from(tasksTable).where(and(eq(tasksTable.kind, "meeting"), eq(tasksTable.dueAt, today), inArray(tasksTable.status, OPEN_STATUSES)));
  for (const t of todays) {
    if (!t.dueTime) continue;
    const [th, tm] = t.dueTime.split(":").map(Number);
    const diff = th! * 60 + tm! - nowMin;
    if (diff < 60 || diff >= 65 || (await meetingReminded(t.id, "meeting_reminder_hour"))) continue;
    await logTaskEvent(t.id, "meeting_reminder_hour", null);
    const c = await confirmedCount(t.id);
    const text = `⏰ Через годину: *${mdEsc(t.title)}*, ${t.dueTime}${t.place ? `, ${mdEsc(t.place)}` : ""}. Підтвердили ${c.yes} з ${c.total}.`;
    for (const id of [...new Set([...(await meetingParticipants(t.id)), ...(t.creatorAdminId ? [t.creatorAdminId] : [])])]) if (await notifyAdminById(id, "tasks", text, { parse_mode: "Markdown" })) sent++;
  }
  // за день: у час вечірнього підсумку — зустрічі завтра
  const s = await loadTaskSettings();
  const [eh, em] = s.eveningTime.split(":").map(Number);
  const ed = nowMin - (eh! * 60 + em!);
  if (ed >= 0 && ed < 5) {
    const tomorrow = addDaysStr(today, 1);
    const tmr = await db.select().from(tasksTable).where(and(eq(tasksTable.kind, "meeting"), eq(tasksTable.dueAt, tomorrow), inArray(tasksTable.status, OPEN_STATUSES)));
    for (const t of tmr) {
      if (await meetingReminded(t.id, "meeting_reminder_day")) continue;
      await logTaskEvent(t.id, "meeting_reminder_day", null);
      const c = await confirmedCount(t.id);
      const text = `🗓 Завтра: *${mdEsc(t.title)}*${t.dueTime ? `, ${t.dueTime}` : ""}${t.place ? `, ${mdEsc(t.place)}` : ""}. Підтвердили ${c.yes} з ${c.total}.`;
      const kb = [[{ text: "✅ Буду", callback_data: `tsk:yes:${t.id}` }, { text: "❌ Не зможу", callback_data: `tsk:no:${t.id}` }]];
      for (const id of await meetingParticipants(t.id)) if (await notifyAdminById(id, "tasks", text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } })) sent++;
    }
  }
  return sent;
}

export async function sendEveningSummaries(today = warsawToday()): Promise<number> {
  const admins = await db.select().from(adminsTable);
  let sent = 0;
  for (const a of admins) {
    if (!a.telegramId || a.role === "driver" || !(await adminHasPage(a, "/tasks"))) continue;
    const d = await buildEveningSummary(a.id, today);
    if (!d) continue;
    if (await notifyAdminById(a.id, "tasks", d.text, { parse_mode: "Markdown", reply_markup: d.kb.length ? { inline_keyboard: d.kb } : undefined })) sent++;
  }
  return sent;
}

// ── тижневий звіт контролю головному (пн 08:00) ─────────────────────────────
export async function sendWeeklyControlReport(today = warsawToday()): Promise<boolean> {
  const main = await mainAdminId();
  if (!main) return false;
  const s = await controlStats(1, today);
  const lines = [`📊 *Задачі за тиждень ${fmtDate(s.from)} – ${fmtDate(s.to)}*`];
  for (const a of s.admins) {
    if (!a.open && !a.done && !a.overdue) continue;
    lines.push(`${mdEsc(a.name)}: виконано ${a.done} · відкрито ${a.open} · прострочено ${a.overdue ? `*${a.overdue}*` : "0"}${a.avgDays != null ? ` · сер. ${a.avgDays} дн.` : ""}`);
  }
  lines.push(`Авто закрилось само: ${s.autoResolved} · створено нових: ${s.created}`);
  const kb = panelUrl() ? [[{ text: "🔗 Контроль задач", url: `${panelUrl()}/tasks` }]] : [];
  return notifyAdminById(main, "tasks", lines.join("\n"), { parse_mode: "Markdown", ...(kb.length ? { reply_markup: { inline_keyboard: kb } } : {}) });
}

// ── тік крону (кожні 5 хв): час з налаштувань + дедуп по settings ──────────
export async function runTaskDigestTick(now = new Date()): Promise<void> {
  const s = await loadTaskSettings();
  const today = warsawToday();
  const hm = nowHm(now);
  const within = (target: string) => { const [th, tm] = target.split(":").map(Number); const [h, m] = hm.split(":").map(Number); const d = (h! * 60 + m!) - (th! * 60 + tm!); return d >= 0 && d < 5; };
  try { await sendMeetingReminders(now, today); } catch (e: any) { logger.warn({ err: e?.message }, "meeting reminders failed"); }
  if (s.skipWeekends && isWeekend(today)) return;
  try {
    if (within(s.digestTime) && (await getSetting("tasks.digest.sent")) !== today) {
      await setSetting("tasks.digest.sent", today);
      const n = await sendMorningDigests(today);
      logger.info({ n }, "🗂 task morning digests");
    }
    if (within(s.eveningTime) && (await getSetting("tasks.evening.sent")) !== today) {
      await setSetting("tasks.evening.sent", today);
      const n = await sendEveningSummaries(today);
      logger.info({ n }, "🗂 task evening summaries");
    }
  } catch (e: any) { logger.warn({ err: e?.message }, "task digest tick failed"); }
}
