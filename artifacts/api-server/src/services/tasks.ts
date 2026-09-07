// Модуль «Задачі» (06.09.2026) — ядро: створення, статуси, учасники, повторення,
// «Мій день», ланцюжок відповідальних. Лише для офісу (адміни). Три види:
//   task    — один виконавець (assignee_admin_id)
//   group   — кілька виконавців (task_assignees), кожен відмічає свою частину
//   meeting — дата/час/тривалість/місце, учасники відповідають «буду / не зможу»
// Автозадачі (source=auto:<code>) створює services/taskAutoRules.ts тими самими
// хелперами. Сповіщення в бот — персональні (notifyAdminById, тип `tasks`).
import {
  db, tasksTable, taskAssigneesTable, taskEventsTable, taskCommentsTable, adminsTable, factoriesTable, taskAutoRulesTable,
  type Task, taskTemplatesTable } from "@workspace/db";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { addDaysStr } from "../lib/dates";
import { notifyAdminById } from "../bot/notify";
import { logger } from "../lib/logger";
import {
  warsawToday, fmtDate, dateStr, diffDays, mdEsc, priorityForDays, nextOccurrence, normalizeChecklist,
  OPEN_STATUSES, PRIORITY_LABEL, DEFAULT_LADDER,
  type TaskKind, type TaskStatus, type TaskPriority, type Recurrence, type ChecklistItem,
} from "./taskUtils";
export * from "./taskUtils";

// Загальні параметри модуля — рядок task_auto_rules.code='settings' (params), дефолти тут.
export interface TaskSettings {
  ladder: number[]; manualLadder: number[]; escalationDays: number; digestTime: string; eveningTime: string; skipWeekends: boolean; rollover: boolean; groupAbove?: number;
  // автозапит документів у працівника (services/docRequests.ts): нагадування працівнику через N днів після запиту,
  // задача офісу «не надіслав» після silenceDays мовчання, і завжди офісу, якщо до строку ≤ officeThresholdDays
  autoRequest: boolean; workerLadder: number[]; silenceDays: number; officeThresholdDays: number;
}
export const DEFAULT_TASK_SETTINGS: TaskSettings = { ladder: DEFAULT_LADDER, manualLadder: [1, 0], escalationDays: 3, digestTime: "07:30", eveningTime: "17:30", skipWeekends: true, rollover: true, autoRequest: true, workerLadder: [3, 7], silenceDays: 7, officeThresholdDays: 7 };
export async function loadTaskSettings(): Promise<TaskSettings> {
  const [row] = await db.select().from(taskAutoRulesTable).where(eq(taskAutoRulesTable.code, "settings"));
  return { ...DEFAULT_TASK_SETTINGS, ...((row?.params ?? {}) as Partial<TaskSettings>) };
}

// Шаблони з тригером (worker_created / worker_fired): задача з чеклістом шаблону при події.
// Виконавець: дефолт шаблону → відповідальний фабрики → головний. Один раз на подію (sourceKey).
export async function applyTemplateTriggers(trigger: "worker_created" | "worker_fired", worker: { id: number; fullName: string; factoryId: number | null }): Promise<number> {
  const tpls = await db.select().from(taskTemplatesTable).where(and(eq(taskTemplatesTable.trigger, trigger), eq(taskTemplatesTable.isActive, true)));
  let n = 0;
  for (const tpl of tpls) {
    const sourceKey = `tpl:${tpl.id}:${worker.id}:${trigger}`;
    const [ex] = await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.sourceKey, sourceKey), inArray(tasksTable.status, OPEN_STATUSES)));
    if (ex) continue;
    const assignee = tpl.defaultAssigneeAdminId ?? await resolveAssignee({ factoryId: worker.factoryId, ruleCode: `template:${tpl.id}` });
    await createTask({
      kind: (tpl.kind as TaskKind) ?? "task", title: tpl.titleTemplate.replace("{worker}", worker.fullName).trim() || tpl.name, description: tpl.description,
      dueAt: tpl.dueInDays != null ? addDaysStr(warsawToday(), tpl.dueInDays) : null, assigneeAdminId: assignee, reviewRequired: tpl.reviewRequired,
      workerId: worker.id, factoryId: worker.factoryId, checklist: tpl.checklist, recurrence: tpl.recurrence ?? null, templateId: tpl.id,
      source: "template", sourceKey,
    }, null);
    n++;
  }
  return n;
}
// Best-effort обгортка для точок створення/звільнення працівника (динамічний імпорт з роутів/бота).
export async function workerTrigger(trigger: "worker_created" | "worker_fired", worker: { id: number; fullName: string; factoryId: number | null } | undefined | null): Promise<void> {
  if (!worker) return;
  try { await applyTemplateTriggers(trigger, worker); } catch (e: any) { logger.warn({ err: e?.message, workerId: worker.id, trigger }, "template trigger failed"); }
}

// Контекстні кнопки «Як вирішити» для бот-сповіщень (динамічний імпорт — taskResolve імпортує цей модуль).
export async function taskContextButtons(task: Task): Promise<{ text: string; callback_data: string }[]> {
  if (!task.source.startsWith("auto:")) return [];
  try {
    const { buildTaskResolution, botActionButtons } = await import("./taskResolve");
    return botActionButtons(task.id, (await buildTaskResolution(task)).actions);
  } catch { return []; }
}

export const taskPanelUrl = () => (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");

export async function logTaskEvent(taskId: number, kind: string, adminId: number | null = null, payload?: Record<string, unknown>): Promise<void> {
  await db.insert(taskEventsTable).values({ taskId, kind, adminId, payload: payload ?? null });
}

export async function mainAdminId(): Promise<number | null> {
  const [m] = await db.select({ id: adminsTable.id }).from(adminsTable).where(eq(adminsTable.isMain, true));
  return m?.id ?? null;
}
export async function adminName(id: number | null): Promise<string> {
  if (id == null) return "Система";
  const [a] = await db.select({ name: adminsTable.name }).from(adminsTable).where(eq(adminsTable.id, id));
  return a?.name ?? `#${id}`;
}

// Ланцюжок відповідальних (D7): явно вказаний → відповідальний фабрики (для «графікових»
// джерел — графікова фабрики, потім відповідальний) → фолбек правила → головний адмін.
export async function resolveAssignee(opts: { factoryId?: number | null; ruleCode?: string | null; prefer?: number | null; useScheduler?: boolean }): Promise<number | null> {
  if (opts.prefer) return opts.prefer;
  if (opts.factoryId) {
    const [f] = await db.select({ r: factoriesTable.responsibleAdminId, s: factoriesTable.schedulerAdminId }).from(factoriesTable).where(eq(factoriesTable.id, opts.factoryId));
    const pick = opts.useScheduler ? (f?.s ?? f?.r ?? null) : (f?.r ?? null);
    if (pick) return pick;
  }
  if (opts.ruleCode) {
    const [r] = await db.select({ fb: taskAutoRulesTable.fallbackAdminId }).from(taskAutoRulesTable).where(eq(taskAutoRulesTable.code, opts.ruleCode));
    if (r?.fb) return r.fb;
  }
  return mainAdminId();
}



export interface CreateTaskInput {
  kind?: TaskKind; title: string; description?: string | null; priority?: TaskPriority;
  dueAt?: string | null; dueTime?: string | null; durationMin?: number | null; place?: string | null;
  assigneeAdminId?: number | null; assigneeIds?: number[]; reviewRequired?: boolean;
  workerId?: number | null; factoryId?: number | null; documentId?: number | null; contractId?: number | null; candidateId?: number | null;
  source?: string; sourceKey?: string | null; autoParams?: Record<string, unknown> | null;
  checklist?: (string | ChecklistItem)[]; recurrence?: Recurrence | null; recurrenceParentId?: number | null; templateId?: number | null;
  plannedFor?: string | null; notify?: boolean;
}


export async function createTask(input: CreateTaskInput, actorAdminId: number | null): Promise<Task> {
  const kind = input.kind ?? "task";
  const [row] = await db.insert(tasksTable).values({
    kind, title: input.title.trim(), description: input.description ?? null,
    status: "open", priority: input.priority ?? "normal",
    dueAt: input.dueAt ?? null, dueTime: input.dueTime ?? null, durationMin: input.durationMin ?? null, place: input.place ?? null,
    plannedFor: input.plannedFor ?? null,
    creatorAdminId: actorAdminId,
    assigneeAdminId: kind === "task" ? (input.assigneeAdminId ?? actorAdminId ?? null) : null,
    reviewRequired: !!input.reviewRequired,
    workerId: input.workerId ?? null, factoryId: input.factoryId ?? null, documentId: input.documentId ?? null,
    contractId: input.contractId ?? null, candidateId: input.candidateId ?? null,
    source: input.source ?? "manual", sourceKey: input.sourceKey ?? null, autoParams: input.autoParams ?? null,
    checklist: normalizeChecklist(input.checklist), recurrence: input.recurrence ?? null,
    recurrenceParentId: input.recurrenceParentId ?? null, templateId: input.templateId ?? null,
  }).returning();
  const task = row!;
  const ids = kind === "task" ? [] : [...new Set((input.assigneeIds ?? []).filter(n => Number.isFinite(n)))];
  if (ids.length) await db.insert(taskAssigneesTable).values(ids.map(adminId => ({ taskId: task.id, adminId })));
  await logTaskEvent(task.id, "created", actorAdminId, { kind, assignee: task.assigneeAdminId, assignees: ids.length ? ids : undefined, source: task.source });
  if (input.notify !== false) await notifyTaskAssigned(task, actorAdminId, ids);
  return task;
}

function whenLine(t: Task): string {
  if (!t.dueAt) return "";
  const d = fmtDate(dateStr(t.dueAt)!);
  return t.dueTime ? `${d} ${t.dueTime}${t.durationMin ? ` · ${t.durationMin} хв` : ""}` : d;
}

// Сповіщення виконавцям/учасникам про призначення (автор сам собі — не шлемо).
export async function notifyTaskAssigned(task: Task, actorAdminId: number | null, assigneeIds: number[]): Promise<void> {
  const targets = task.kind === "task" ? (task.assigneeAdminId ? [task.assigneeAdminId] : []) : assigneeIds;
  const who = await adminName(actorAdminId);
  for (const id of targets) {
    if (id === actorAdminId) continue;
    try {
      if (task.kind === "meeting") {
        const text = `🗓 *Запрошення: ${mdEsc(task.title)}*\n${whenLine(task)}${task.place ? ` · ${mdEsc(task.place)}` : ""} · скликав ${mdEsc(who)}` + (task.description ? `\n_${mdEsc(task.description.slice(0, 300))}_` : "");
        await notifyAdminById(id, "tasks", text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Буду", callback_data: `tsk:yes:${task.id}` }, { text: "❌ Не зможу", callback_data: `tsk:no:${task.id}` }]] } });
      } else if (task.kind === "group") {
        const text = `👥 *Групова задача від ${mdEsc(who)}*\n${mdEsc(task.title)}${task.dueAt ? `\nдо ${fmtDate(dateStr(task.dueAt)!)}` : ""} · ${PRIORITY_LABEL[task.priority as TaskPriority] ?? task.priority}`;
        await notifyAdminById(id, "tasks", text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Моя частина готова", callback_data: `tsk:part:${task.id}` }]] } });
      } else {
        const auto = task.source.startsWith("auto:");
        const text = `${auto ? "🤖 *Автозадача*" : `📌 *Нова задача від ${mdEsc(who)}*`}\n${mdEsc(task.title)}${task.dueAt ? `\nдо ${fmtDate(dateStr(task.dueAt)!)}` : ""} · ${PRIORITY_LABEL[task.priority as TaskPriority] ?? task.priority}`;
        const rows: { text: string; callback_data?: string; url?: string }[][] = [[{ text: "▶ Беру в роботу", callback_data: `tsk:start:${task.id}` }, { text: "✅ Готово", callback_data: `tsk:done:${task.id}` }, { text: "⏰ Завтра", callback_data: `tsk:snooze:${task.id}` }]];
        const ctxButtons = await taskContextButtons(task);
        if (ctxButtons.length) rows.push(ctxButtons);
        rows.push([{ text: "💬 Відповісти", callback_data: `tsk:reply:${task.id}` }, ...(taskPanelUrl() ? [{ text: "🔗 Відкрити", url: `${taskPanelUrl()}/tasks?task=${task.id}` }] : [])]);
        await notifyAdminById(id, "tasks", text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } });
      }
    } catch (e: any) { logger.warn({ err: e?.message, taskId: task.id, adminId: id }, "task assign notify failed"); }
  }
}

export async function loadTask(id: number): Promise<Task | undefined> {
  const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, id));
  return t;
}
export async function loadAssignees(taskId: number) {
  return db.select({ id: taskAssigneesTable.id, adminId: taskAssigneesTable.adminId, status: taskAssigneesTable.status, respondedAt: taskAssigneesTable.respondedAt, note: taskAssigneesTable.note, name: adminsTable.name })
    .from(taskAssigneesTable).leftJoin(adminsTable, eq(taskAssigneesTable.adminId, adminsTable.id)).where(eq(taskAssigneesTable.taskId, taskId));
}

// Чи стосується задача адміна (виконавець / учасник / автор) — для «Мої» і для
// прав відповіді на групову/зустріч.
export async function isParticipant(task: Task, adminId: number): Promise<boolean> {
  if (task.assigneeAdminId === adminId || task.creatorAdminId === adminId) return true;
  const [row] = await db.select({ id: taskAssigneesTable.id }).from(taskAssigneesTable).where(and(eq(taskAssigneesTable.taskId, task.id), eq(taskAssigneesTable.adminId, adminId)));
  return !!row;
}

// Зміна статусу з правилами контролю: «зроблено» виконавцем при reviewRequired →
// «на перевірці» (автор приймає/повертає); «зроблено» повторюваної → наступний екземпляр.
export async function setTaskStatus(task: Task, next: TaskStatus, actorAdminId: number | null, note?: string | null): Promise<Task> {
  let to: TaskStatus = next;
  if (next === "done" && task.reviewRequired && task.creatorAdminId != null && task.creatorAdminId !== actorAdminId && actorAdminId != null) to = "review";
  const patch: Partial<typeof tasksTable.$inferInsert> = { status: to, updatedAt: new Date() };
  if (to === "done" || to === "cancelled" || to === "auto_resolved") { patch.completedAt = new Date(); patch.completedById = actorAdminId; patch.resolutionNote = note ?? null; }
  if (to === "open" || to === "in_progress") { patch.completedAt = null; patch.completedById = null; }
  const [updated] = await db.update(tasksTable).set(patch).where(eq(tasksTable.id, task.id)).returning();
  await logTaskEvent(task.id, "status", actorAdminId, { from: task.status, to, note: note ?? undefined });
  const who = await adminName(actorAdminId);
  try {
    if (to === "review" && task.creatorAdminId) {
      await notifyAdminById(task.creatorAdminId, "tasks", `🔎 *На перевірку*: ${mdEsc(task.title)}\n${mdEsc(who)} позначив як зроблене${note ? `\n_${mdEsc(note)}_` : ""}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Прийняти", callback_data: `tsk:accept:${task.id}` }, { text: "↩️ Повернути", callback_data: `tsk:return:${task.id}` }]] } });
    } else if (to === "done" && task.creatorAdminId && task.creatorAdminId !== actorAdminId && task.source === "manual") {
      await notifyAdminById(task.creatorAdminId, "tasks", `✅ *Виконано*: ${mdEsc(task.title)}\n${mdEsc(who)}${note ? `\n_${mdEsc(note)}_` : ""}`, { parse_mode: "Markdown" });
    } else if (task.status === "review" && to === "in_progress" && task.assigneeAdminId && task.assigneeAdminId !== actorAdminId) {
      await notifyAdminById(task.assigneeAdminId, "tasks", `↩️ *Повернуто з перевірки*: ${mdEsc(task.title)}${note ? `\n_${mdEsc(note)}_` : ""}`, { parse_mode: "Markdown" });
    }
  } catch (e: any) { logger.warn({ err: e?.message, taskId: task.id }, "task status notify failed"); }
  // повторювана: наступний екземпляр після виконання (не після скасування)
  if (to === "done" && task.recurrence && task.source === "manual") {
    const r = task.recurrence as Recurrence;
    const base = dateStr(task.dueAt) ?? warsawToday();
    const nextDue = nextOccurrence(base, r);
    if (!r.until || nextDue <= r.until) {
      const assignees = task.kind === "task" ? [] : (await loadAssignees(task.id)).map(a => a.adminId);
      await createTask({
        kind: task.kind as TaskKind, title: task.title, description: task.description, priority: task.priority as TaskPriority,
        dueAt: nextDue, dueTime: task.dueTime, durationMin: task.durationMin, place: task.place,
        assigneeAdminId: task.assigneeAdminId, assigneeIds: assignees, reviewRequired: task.reviewRequired,
        workerId: task.workerId, factoryId: task.factoryId, checklist: (task.checklist as ChecklistItem[]).map(c => c.text),
        recurrence: r, recurrenceParentId: task.recurrenceParentId ?? task.id, templateId: task.templateId, notify: false,
      }, task.creatorAdminId);
      await logTaskEvent(task.id, "recurred", actorAdminId, { nextDue });
    }
  }
  return updated!;
}

// Відповідь учасника групової задачі / зустрічі. Групова: усі done → задача done
// (з контролем автора, якщо ввімкнено). Зустріч: відмова → автору.
export async function respondAssignee(task: Task, adminId: number, status: "accepted" | "declined" | "done", note?: string | null): Promise<void> {
  await db.update(taskAssigneesTable).set({ status, respondedAt: new Date(), note: note ?? null })
    .where(and(eq(taskAssigneesTable.taskId, task.id), eq(taskAssigneesTable.adminId, adminId)));
  await logTaskEvent(task.id, "respond", adminId, { status, note: note ?? undefined });
  if (task.kind === "group" && status === "done") {
    const all = await loadAssignees(task.id);
    if (all.length && all.every(a => a.status === "done") && OPEN_STATUSES.includes(task.status as TaskStatus)) await setTaskStatus(task, "done", adminId, "усі учасники відмітили");
  }
  if (task.kind === "meeting" && status === "declined" && task.creatorAdminId && task.creatorAdminId !== adminId) {
    const who = await adminName(adminId);
    await notifyAdminById(task.creatorAdminId, "tasks", `❌ ${mdEsc(who)} не зможе: *${mdEsc(task.title)}* (${whenLine(task)})${note ? `\n_${mdEsc(note)}_` : ""}`, { parse_mode: "Markdown" }).catch(() => {});
  }
}

export async function snoozeTask(task: Task, days: number, actorAdminId: number | null): Promise<void> {
  const until = addDaysStr(warsawToday(), Math.max(1, days));
  await db.update(tasksTable).set({ snoozedUntil: until, plannedFor: null, plannedTime: null, updatedAt: new Date() }).where(eq(tasksTable.id, task.id));
  await logTaskEvent(task.id, "snoozed", actorAdminId, { until });
}

export async function planTask(task: Task, date: string | null, time: string | null, actorAdminId: number | null): Promise<void> {
  await db.update(tasksTable).set({ plannedFor: date, plannedTime: date ? time : null, snoozedUntil: null, updatedAt: new Date() }).where(eq(tasksTable.id, task.id));
  await logTaskEvent(task.id, "planned", actorAdminId, { date, time });
}

// Нічний перенос: невиконане, взяте в план на минулі дні → сьогодні (+лічильник).
export async function rolloverPlanned(today = warsawToday()): Promise<number> {
  const rows = await db.select({ id: tasksTable.id, n: tasksTable.rolloverCount }).from(tasksTable)
    .where(and(inArray(tasksTable.status, OPEN_STATUSES), lt(tasksTable.plannedFor, today)));
  for (const r of rows) {
    await db.update(tasksTable).set({ plannedFor: today, plannedTime: null, rolloverCount: r.n + 1, updatedAt: new Date() }).where(eq(tasksTable.id, r.id));
    await logTaskEvent(r.id, "rollover", null, { to: today, count: r.n + 1 });
  }
  return rows.length;
}

export async function addComment(task: Task, adminId: number, body: string, mentions: number[] = []): Promise<void> {
  await db.insert(taskCommentsTable).values({ taskId: task.id, adminId, body, mentions });
  await logTaskEvent(task.id, "comment", adminId);
  const who = await adminName(adminId);
  const targets = new Set<number>(mentions);
  if (task.assigneeAdminId) targets.add(task.assigneeAdminId);
  if (task.creatorAdminId) targets.add(task.creatorAdminId);
  targets.delete(adminId);
  for (const id of targets) {
    await notifyAdminById(id, "tasks", `💬 ${mdEsc(who)} · *${mdEsc(task.title)}*\n${mdEsc(body.slice(0, 400))}`, { parse_mode: "Markdown" }).catch(() => {});
  }
}

// Контроль: показники по адмінах за N тижнів (сторінка «Контроль» і понеділковий звіт).
export async function controlStats(weeks = 1, today = warsawToday()) {
  const from = addDaysStr(today, -7 * Math.max(1, weeks));
  const admins = await db.select({ id: adminsTable.id, name: adminsTable.name, role: adminsTable.role }).from(adminsTable).where(sql`${adminsTable.role} <> 'driver'`).orderBy(adminsTable.name);
  const out: { adminId: number; name: string; role: string; open: number; overdue: number; done: number; avgDays: number | null; auto: number; manual: number }[] = [];
  for (const a of admins) {
    const mine = await db.select().from(tasksTable).where(sql`(${tasksTable.assigneeAdminId} = ${a.id} or exists (select 1 from task_assignees x where x.task_id = ${tasksTable.id} and x.admin_id = ${a.id}))`);
    const open = mine.filter(t => OPEN_STATUSES.includes(t.status as TaskStatus));
    const overdue = open.filter(t => t.dueAt && dateStr(t.dueAt)! < today);
    const done = mine.filter(t => t.status === "done" && t.completedAt && dateStr(t.completedAt)! >= from);
    const durs = done.map(t => Math.max(0, (t.completedAt!.getTime() - t.createdAt.getTime()) / 86400000));
    out.push({ adminId: a.id, name: a.name, role: a.role, open: open.length, overdue: overdue.length, done: done.length,
      avgDays: durs.length ? Math.round((durs.reduce((x, y) => x + y, 0) / durs.length) * 10) / 10 : null,
      auto: open.filter(t => t.source.startsWith("auto:")).length, manual: open.filter(t => t.source === "manual").length });
  }
  const [ar] = await db.select({ c: sql<number>`count(*)` }).from(tasksTable).where(and(eq(tasksTable.status, "auto_resolved"), sql`${tasksTable.completedAt} >= ${from}`));
  const [cr] = await db.select({ c: sql<number>`count(*)` }).from(tasksTable).where(sql`${tasksTable.createdAt} >= ${from}`);
  return { from, to: today, admins: out, autoResolved: Number(ar?.c ?? 0), created: Number(cr?.c ?? 0) };
}

// Лічильники для віджетів (мої: прострочено / сьогодні / тиждень / зустрічі).
export async function myCounters(adminId: number, today = warsawToday()) {
  const weekEnd = addDaysStr(today, 6);
  const rows = await db.execute(sql`
    select t.due_at, t.kind from tasks t
    left join task_assignees a on a.task_id = t.id and a.admin_id = ${adminId}
    where t.status in ('open','in_progress','review')
      and (t.assignee_admin_id = ${adminId} or a.id is not null)
      and (t.snoozed_until is null or t.snoozed_until <= ${today})`);
  let overdue = 0, todayN = 0, week = 0, meetingsToday = 0;
  for (const r of rows.rows as { due_at: string | null; kind: string }[]) {
    const d = dateStr(r.due_at);
    if (!d) continue;
    if (d < today) overdue++; else if (d === today) { todayN++; if (r.kind === "meeting") meetingsToday++; } else if (d <= weekEnd) week++;
  }
  return { overdue, today: todayN, week, meetingsToday };
}
