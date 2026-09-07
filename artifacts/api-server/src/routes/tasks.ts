// Модуль «Задачі» (06.09.2026): API задач офісу, «Мого дня», календаря, контролю,
// шаблонів і автоправил. Гейт — сторінка /tasks (requirePage), per-route;
// групові/зустрічі для інших — cap tasksGroup; чужі перепризначення, автоправила,
// контроль — cap tasksManage (owner і головний — усе).
import { Router, type IRouter } from "express";
import {
  db, tasksTable, taskAssigneesTable, taskCommentsTable, taskEventsTable, taskTemplatesTable, taskAutoRulesTable,
  adminsTable, workersTable, factoriesTable, workerDocumentsTable, contractsTable, candidatesTable } from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { authRequired, requirePage, type AuthedRequest } from "../lib/auth";
import { hasCap } from "../lib/roles";
import {
  createTask, loadTask, loadAssignees, isParticipant, setTaskStatus, respondAssignee, snoozeTask, planTask, addComment, myCounters, controlStats,
  normalizeChecklist, warsawToday, dateStr, OPEN_STATUSES, TASK_KINDS, TASK_PRIORITIES, TASK_STATUSES, loadTaskSettings, DEFAULT_TASK_SETTINGS,
  type TaskKind, type TaskPriority, type TaskStatus, type Recurrence, setWatchers, remindGroup } from "../services/tasks";
import { runAutoTasks, ensureAutoRules, AUTO_RULE_DEFS, officeAdmins } from "../services/taskAutoRules";
import { recomputeAllActiveLegality } from "../services/legalityRecompute";
import { buildTaskResolution, runTaskAction } from "../services/taskResolve";
import { addDaysStr } from "../lib/dates";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { TASK_ATTACH_DIR, makeStoredName, sniffDocMime, compressUploadImage } from "../lib/uploads";
const DOC_MIME_WHITELIST = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]); // вкладення коментарів: фото і PDF

const router: IRouter = Router();
router.use(authRequired);
const TP = requirePage("/tasks");
const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });
const me = (req: AuthedRequest) => req.admin!.adminId;
const canManage = (req: AuthedRequest) => hasCap(req.admin!.role, req.admin!.caps, "tasksManage");
const canGroup = (req: AuthedRequest) => hasCap(req.admin!.role, req.admin!.caps, "tasksGroup");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const s = (v: unknown) => (v == null ? null : String(v).trim() || null);
const n = (v: unknown) => (v == null || v === "" ? null : Number(v));

// ── список / картки ──────────────────────────────────────────────────────────
async function decorate(rows: (typeof tasksTable.$inferSelect)[]) {
  if (!rows.length) return [];
  const adminIds = [...new Set(rows.flatMap(t => [t.assigneeAdminId, t.creatorAdminId, t.completedById]).filter((x): x is number => x != null))];
  const admins = adminIds.length ? await db.select({ id: adminsTable.id, name: adminsTable.name }).from(adminsTable).where(inArray(adminsTable.id, adminIds)) : [];
  const aName = new Map(admins.map(a => [a.id, a.name]));
  const workerIds = [...new Set(rows.map(t => t.workerId).filter((x): x is number => x != null))];
  const workers = workerIds.length ? await db.select({ id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode }).from(workersTable).where(inArray(workersTable.id, workerIds)) : [];
  const wName = new Map(workers.map(w => [w.id, w]));
  const facIds = [...new Set(rows.map(t => t.factoryId).filter((x): x is number => x != null))];
  const facs = facIds.length ? await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable).where(inArray(factoriesTable.id, facIds)) : [];
  const fName = new Map(facs.map(f => [f.id, f.name]));
  const groupIds = rows.map(t => t.id); // учасники + спостерігачі (усі види)
  // привʼязки: назви документа / умови / кандидата
  const docIds = [...new Set(rows.map(t => t.documentId).filter((x): x is number => x != null))];
  const dTitle = new Map((docIds.length ? await db.select({ id: workerDocumentsTable.id, title: workerDocumentsTable.title }).from(workerDocumentsTable).where(inArray(workerDocumentsTable.id, docIds)) : []).map(d => [d.id, d.title]));
  const contractIds = [...new Set(rows.map(t => t.contractId).filter((x): x is number => x != null))];
  const cLabel = new Map((contractIds.length ? await db.select({ id: contractsTable.id, status: contractsTable.status, fname: factoriesTable.name }).from(contractsTable).leftJoin(factoriesTable, eq(contractsTable.factoryId, factoriesTable.id)).where(inArray(contractsTable.id, contractIds)) : []).map(c => [c.id, `Umowa${c.fname ? ` — ${c.fname}` : ""} · ${c.status}`]));
  const candIds = [...new Set(rows.map(t => t.candidateId).filter((x): x is number => x != null))];
  const cName = new Map((candIds.length ? await db.select({ id: candidatesTable.id, fullName: candidatesTable.fullName }).from(candidatesTable).where(inArray(candidatesTable.id, candIds)) : []).map(c => [c.id, c.fullName]));
  const parts = groupIds.length ? await db.select({ taskId: taskAssigneesTable.taskId, adminId: taskAssigneesTable.adminId, status: taskAssigneesTable.status, name: adminsTable.name })
    .from(taskAssigneesTable).leftJoin(adminsTable, eq(taskAssigneesTable.adminId, adminsTable.id)).where(inArray(taskAssigneesTable.taskId, groupIds)) : [];
  const byTask = new Map<number, typeof parts>();
  for (const p of parts) { const l = byTask.get(p.taskId) ?? []; l.push(p); byTask.set(p.taskId, l); }
  const today = warsawToday();
  return rows.map(t => ({
    ...t, dueAt: dateStr(t.dueAt), plannedFor: dateStr(t.plannedFor), snoozedUntil: dateStr(t.snoozedUntil),
    assigneeName: t.assigneeAdminId ? aName.get(t.assigneeAdminId) ?? null : null,
    creatorName: t.creatorAdminId ? aName.get(t.creatorAdminId) ?? null : "Система",
    completedByName: t.completedById ? aName.get(t.completedById) ?? null : null,
    worker: t.workerId ? wName.get(t.workerId) ?? null : null,
    factoryName: t.factoryId ? fName.get(t.factoryId) ?? null : null,
    assignees: (byTask.get(t.id) ?? []).filter(p => p.status !== "watcher").map(p => ({ adminId: p.adminId, name: p.name, status: p.status })),
    watchers: (byTask.get(t.id) ?? []).filter(p => p.status === "watcher").map(p => ({ adminId: p.adminId, name: p.name })),
    documentTitle: t.documentId ? dTitle.get(t.documentId) ?? null : null, contractLabel: t.contractId ? cLabel.get(t.contractId) ?? null : null, candidateName: t.candidateId ? cName.get(t.candidateId) ?? null : null,
    overdue: !!t.dueAt && dateStr(t.dueAt)! < today && OPEN_STATUSES.includes(t.status as TaskStatus),
    checklistDone: (t.checklist as any[]).filter(c => c.done).length, checklistTotal: (t.checklist as any[]).length,
  }));
}

const mineCond = (adminId: number) => or(
  eq(tasksTable.assigneeAdminId, adminId),
  sql`exists (select 1 from task_assignees a where a.task_id = ${tasksTable.id} and a.admin_id = ${adminId} and a.status <> 'watcher')`,
);
const watchCond = (adminId: number) => sql`exists (select 1 from task_assignees a where a.task_id = ${tasksTable.id} and a.admin_id = ${adminId} and a.status = 'watcher')`;

router.get("/tasks", TP, async (req: AuthedRequest, res) => { ok(res, await listTasks(req)); });

// Excel-експорт списку (ті самі фільтри, що й GET /tasks) — польська шапка не потрібна: внутрішній документ офісу
router.get("/tasks/export.xlsx", TP, async (req: AuthedRequest, res) => {
  const rows = await listTasks(req);
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Задачі");
  const cols = [
    { header: "#", get: (r: any) => r.id }, { header: "Задача", get: (r: any) => r.title }, { header: "Вид", get: (r: any) => r.kind },
    { header: "Статус", get: (r: any) => r.status }, { header: "Пріоритет", get: (r: any) => r.priority }, { header: "Строк", get: (r: any) => r.dueAt ?? "" },
    { header: "Виконавець", get: (r: any) => r.assigneeName ?? (r.assignees?.map((a: any) => a.name).join(", ") ?? "") }, { header: "Автор", get: (r: any) => r.creatorName ?? "Система" },
    { header: "Працівник", get: (r: any) => r.worker?.fullName ?? "" }, { header: "Фабрика", get: (r: any) => r.factoryName ?? "" },
    { header: "Джерело", get: (r: any) => r.source }, { header: "Чекліст", get: (r: any) => (r.checklistTotal ? `${r.checklistDone}/${r.checklistTotal}` : "") },
    { header: "Створено", get: (r: any) => dateStr(r.createdAt) ?? "" }, { header: "Виконано", get: (r: any) => dateStr(r.completedAt) ?? "" },
  ];
  ws.addRow(cols.map(c => c.header)).font = { bold: true };
  for (const r of rows) ws.addRow(cols.map(c => c.get(r)));
  ws.columns.forEach((c, i) => { c.width = i === 1 ? 48 : i === 8 ? 28 : 16; });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`Zadania ${warsawToday()}.xlsx`)}"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

async function listTasks(req: AuthedRequest) {
  const q = req.query as Record<string, string | undefined>;
  const conds: any[] = [];
  const scope = q.scope ?? "mine";
  if (scope === "mine") conds.push(mineCond(me(req)));
  else if (scope === "created") conds.push(eq(tasksTable.creatorAdminId, me(req)));
  else if (scope === "watching") conds.push(or(eq(tasksTable.creatorAdminId, me(req)), watchCond(me(req))));
  const status = q.status ?? "open";
  if (status === "open") conds.push(inArray(tasksTable.status, OPEN_STATUSES));
  else if (status === "closed") conds.push(inArray(tasksTable.status, ["done", "cancelled", "auto_resolved"]));
  else if (status !== "all" && TASK_STATUSES.includes(status as TaskStatus)) conds.push(eq(tasksTable.status, status));
  if (q.assignee) conds.push(eq(tasksTable.assigneeAdminId, Number(q.assignee)));
  if (q.factoryId) conds.push(eq(tasksTable.factoryId, Number(q.factoryId)));
  if (q.city) conds.push(sql`exists (select 1 from factories f where f.id = ${tasksTable.factoryId} and f.city = ${String(q.city)})`);
  if (q.workerId) conds.push(eq(tasksTable.workerId, Number(q.workerId)));
  if (q.kind && TASK_KINDS.includes(q.kind as TaskKind)) conds.push(eq(tasksTable.kind, q.kind));
  if (q.priority && TASK_PRIORITIES.includes(q.priority as TaskPriority)) conds.push(eq(tasksTable.priority, q.priority));
  if (q.source === "auto") conds.push(sql`${tasksTable.source} like 'auto:%'`);
  else if (q.source === "manual") conds.push(eq(tasksTable.source, "manual"));
  else if (q.source) conds.push(eq(tasksTable.source, `auto:${q.source}`));
  if (q.from && DATE_RE.test(q.from)) conds.push(gte(tasksTable.dueAt, q.from));
  if (q.to && DATE_RE.test(q.to)) conds.push(lte(tasksTable.dueAt, q.to));
  if (q.overdue === "1") conds.push(and(sql`${tasksTable.dueAt} < ${warsawToday()}`, inArray(tasksTable.status, OPEN_STATUSES)));
  if (q.q) conds.push(sql`(${tasksTable.title} ilike ${"%" + q.q + "%"} or exists (select 1 from workers w where w.id = ${tasksTable.workerId} and w.full_name ilike ${"%" + q.q + "%"}))`);
  if (q.hideSnoozed !== "0") conds.push(or(isNull(tasksTable.snoozedUntil), lte(tasksTable.snoozedUntil, warsawToday())));
  const rows = await db.select().from(tasksTable).where(conds.length ? and(...conds) : undefined)
    .orderBy(sql`case ${tasksTable.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`, asc(tasksTable.dueAt), desc(tasksTable.id)).limit(500);
  return decorate(rows);
}

// Мій день: прострочене, сьогодні, заплановане по годинах, зустрічі, нове за ніч, лічильники
router.get("/tasks/my-day", TP, async (req: AuthedRequest, res) => {
  const date = typeof req.query.date === "string" && DATE_RE.test(req.query.date) ? req.query.date : warsawToday();
  const adminId = me(req);
  const base = and(mineCond(adminId), or(isNull(tasksTable.snoozedUntil), lte(tasksTable.snoozedUntil, date)));
  const rows = await decorate(await db.select().from(tasksTable).where(and(base, or(
    inArray(tasksTable.status, OPEN_STATUSES),
    and(eq(tasksTable.status, "done"), sql`${tasksTable.completedAt}::date = ${date}`),
  ))).orderBy(asc(tasksTable.plannedTime), asc(tasksTable.dueTime), asc(tasksTable.dueAt)));
  const open = rows.filter(t => OPEN_STATUSES.includes(t.status as TaskStatus));
  const overdue = open.filter(t => t.dueAt && t.dueAt < date && t.kind !== "meeting");
  const meetings = rows.filter(t => t.kind === "meeting" && t.dueAt === date);
  const todayTasks = open.filter(t => t.kind !== "meeting" && (t.dueAt === date || t.plannedFor === date) && !(t.dueAt && t.dueAt < date));
  const planned = rows.filter(t => t.plannedFor === date && t.plannedTime).sort((a, b) => (a.plannedTime! < b.plannedTime! ? -1 : 1));
  const doneToday = rows.filter(t => t.status === "done");
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const fresh = open.filter(t => t.source.startsWith("auto:") && t.createdAt > since && t.plannedFor !== date && !(t.dueAt && t.dueAt <= date));
  const plannedMin = [...todayTasks, ...meetings].reduce((a, t) => a + (t.durationMin ?? 30), 0);
  ok(res, { date, overdue, today: todayTasks, meetings, planned, newOvernight: fresh, doneToday, stats: { done: doneToday.length, total: doneToday.length + todayTasks.length, plannedMin }, counters: await myCounters(adminId, date) });
});

router.get("/tasks/counters", TP, async (req: AuthedRequest, res) => ok(res, await myCounters(me(req))));

// Календар: задачі й зустрічі в діапазоні (мої або команда)
router.get("/tasks/calendar", TP, async (req: AuthedRequest, res) => {
  const q = req.query as Record<string, string | undefined>;
  if (!q.from || !q.to || !DATE_RE.test(q.from) || !DATE_RE.test(q.to)) return fail(res, 400, "from/to = YYYY-MM-DD");
  const conds: any[] = [gte(tasksTable.dueAt, q.from), lte(tasksTable.dueAt, q.to)];
  if (q.scope !== "team") conds.push(mineCond(me(req)));
  if (q.status !== "all") conds.push(inArray(tasksTable.status, [...OPEN_STATUSES, "done"]));
  const rows = await db.select().from(tasksTable).where(and(...conds)).orderBy(asc(tasksTable.dueAt), asc(tasksTable.dueTime));
  ok(res, await decorate(rows));
});

// Контроль: показники по адмінах (cap tasksManage)
router.get("/tasks/control", TP, async (req: AuthedRequest, res) => {
  if (!canManage(req)) return fail(res, 403, "forbidden");
  const weeks = Math.min(12, Math.max(1, Number(req.query.weeks ?? 1)));
  ok(res, await controlStats(weeks));
});

router.get("/tasks/admins", TP, async (_req, res) => ok(res, await officeAdmins()));

router.get("/tasks/:id", TP, async (req: AuthedRequest, res) => {
  const t = await loadTask(Number(req.params.id));
  if (!t) return fail(res, 404, "Задачу не знайдено");
  const [row] = await decorate([t]);
  const comments = await db.select({ id: taskCommentsTable.id, adminId: taskCommentsTable.adminId, name: adminsTable.name, body: taskCommentsTable.body, mentions: taskCommentsTable.mentions, attachments: taskCommentsTable.attachments, createdAt: taskCommentsTable.createdAt })
    .from(taskCommentsTable).leftJoin(adminsTable, eq(taskCommentsTable.adminId, adminsTable.id)).where(eq(taskCommentsTable.taskId, t.id)).orderBy(asc(taskCommentsTable.id));
  const events = await db.select({ id: taskEventsTable.id, adminId: taskEventsTable.adminId, name: adminsTable.name, kind: taskEventsTable.kind, payload: taskEventsTable.payload, createdAt: taskEventsTable.createdAt })
    .from(taskEventsTable).leftJoin(adminsTable, eq(taskEventsTable.adminId, adminsTable.id)).where(eq(taskEventsTable.taskId, t.id)).orderBy(desc(taskEventsTable.id)).limit(100);
  const meId = me(req);
  const resolution = await buildTaskResolution(t);
  ok(res, { ...row, comments, events, resolution, can: { edit: canManage(req) || t.creatorAdminId === meId || t.assigneeAdminId === meId, reassign: canManage(req) || t.creatorAdminId === meId, review: canManage(req) || t.creatorAdminId === meId, participant: await isParticipant(t, meId) } });
});

// Контекстна дія «Як вирішити» (запит скану, підтвердити/відхилити файл, відхилити зміну,
// перерахунок, повідомлення працівнику). Учасник задачі або tasksManage.
router.post("/tasks/:id/action/:code", TP, async (req: AuthedRequest, res) => {
  const t = await loadTask(Number(req.params.id));
  if (!t) return fail(res, 404, "Задачу не знайдено");
  if (!canManage(req) && !(await isParticipant(t, me(req))) && t.creatorAdminId !== me(req)) return fail(res, 403, "Не ваша задача");
  try {
    const message = await runTaskAction(t, String(req.params.code), { adminId: me(req), name: req.admin!.name }, { note: req.body?.note });
    ok(res, { ok: true, message });
  } catch (e: any) { fail(res, 400, e?.message ?? "Помилка"); }
});

function parseTaskBody(body: Record<string, unknown>) {
  const kind = TASK_KINDS.includes(body.kind as TaskKind) ? (body.kind as TaskKind) : "task";
  const priority = TASK_PRIORITIES.includes(body.priority as TaskPriority) ? (body.priority as TaskPriority) : "normal";
  const dueAt = s(body.dueAt); if (dueAt && !DATE_RE.test(dueAt)) throw new Error("Строк — YYYY-MM-DD");
  const dueTime = s(body.dueTime); if (dueTime && !TIME_RE.test(dueTime)) throw new Error("Час — HH:MM");
  const rec = body.recurrence && typeof body.recurrence === "object" ? (body.recurrence as Recurrence) : null;
  if (rec && !["daily", "weekly", "monthly"].includes(rec.freq)) throw new Error("Невідоме повторення");
  return {
    kind, priority, dueAt, dueTime, durationMin: n(body.durationMin), place: s(body.place), title: String(body.title ?? "").trim(), description: s(body.description),
    assigneeAdminId: n(body.assigneeAdminId), assigneeIds: Array.isArray(body.assigneeIds) ? (body.assigneeIds as unknown[]).map(Number).filter(Number.isFinite) : [],
    reviewRequired: !!body.reviewRequired, workerId: n(body.workerId), factoryId: n(body.factoryId), documentId: n(body.documentId), contractId: n(body.contractId), candidateId: n(body.candidateId),
    checklist: Array.isArray(body.checklist) ? (body.checklist as any[]) : [], recurrence: rec, plannedFor: s(body.plannedFor), templateId: n(body.templateId),
    watcherIds: Array.isArray(body.watcherIds) ? (body.watcherIds as unknown[]).map(Number).filter(Number.isFinite) : [],
    agenda: Array.isArray(body.agenda) ? (body.agenda as unknown[]).map(x => String(x).trim()).filter(Boolean) : [],
  };
}

router.post("/tasks", TP, async (req: AuthedRequest, res) => {
  let p; try { p = parseTaskBody(req.body ?? {}); } catch (e: any) { return fail(res, 400, e.message); }
  if (!p.title) return fail(res, 400, "Вкажіть назву");
  if (p.kind !== "task") {
    if (!p.assigneeIds.length) return fail(res, 400, "Вкажіть учасників");
    if (!canGroup(req) && p.assigneeIds.some(id => id !== me(req))) return fail(res, 403, "Групові задачі та зустрічі для інших — лише з правом «групові задачі та зустрічі»");
    if (p.kind === "meeting" && (!p.dueAt || !p.dueTime)) return fail(res, 400, "Зустріч потребує дати і часу");
  }
  if (p.templateId) {
    const [tpl] = await db.select().from(taskTemplatesTable).where(eq(taskTemplatesTable.id, p.templateId));
    if (tpl) { if (!p.checklist.length) p.checklist = tpl.checklist as string[]; if (!p.reviewRequired) p.reviewRequired = tpl.reviewRequired; if (!p.description) p.description = tpl.description; }
  }
  const t = await createTask({ ...p, notify: req.body?.notify !== false }, me(req));
  const [row] = await decorate([t]);
  ok(res, row);
});

router.patch("/tasks/:id", TP, async (req: AuthedRequest, res) => {
  const t = await loadTask(Number(req.params.id));
  if (!t) return fail(res, 404, "Задачу не знайдено");
  const meId = me(req);
  const isCreator = t.creatorAdminId === meId, isAssignee = t.assigneeAdminId === meId;
  if (!(canManage(req) || isCreator || isAssignee || (await isParticipant(t, meId)))) return fail(res, 403, "forbidden");
  const b = req.body ?? {};
  const patch: Partial<typeof tasksTable.$inferInsert> = { updatedAt: new Date() };
  const ev: Record<string, unknown> = {};
  if (b.title !== undefined) { const v = String(b.title).trim(); if (!v) return fail(res, 400, "Порожня назва"); patch.title = v; }
  if (b.description !== undefined) patch.description = s(b.description);
  if (b.priority !== undefined && TASK_PRIORITIES.includes(b.priority)) patch.priority = b.priority;
  if (b.dueAt !== undefined) { const v = s(b.dueAt); if (v && !DATE_RE.test(v)) return fail(res, 400, "Строк — YYYY-MM-DD"); patch.dueAt = v; ev.dueAt = { from: dateStr(t.dueAt), to: v }; }
  if (b.dueTime !== undefined) { const v = s(b.dueTime); if (v && !TIME_RE.test(v)) return fail(res, 400, "Час — HH:MM"); patch.dueTime = v; }
  if (b.durationMin !== undefined) patch.durationMin = n(b.durationMin);
  if (b.place !== undefined) patch.place = s(b.place);
  if (b.reviewRequired !== undefined && (isCreator || canManage(req))) patch.reviewRequired = !!b.reviewRequired;
  if (b.recurrence !== undefined && (isCreator || canManage(req))) patch.recurrence = b.recurrence ?? null;
  if (b.checklist !== undefined) patch.checklist = normalizeChecklist(b.checklist);
  if (Array.isArray(b.agenda)) patch.agenda = (b.agenda as unknown[]).map(x => String(x).trim()).filter(Boolean);
  if (b.summary !== undefined) patch.summary = s(b.summary);
  if (Array.isArray(b.watcherIds) && (isCreator || isAssignee || canManage(req))) await setWatchers(t, (b.watcherIds as unknown[]).map(Number), meId);
  if (b.assigneeAdminId !== undefined) {
    if (!(isCreator || canManage(req))) return fail(res, 403, "Перепризначати може автор або роль з правом «керувати задачами»");
    patch.assigneeAdminId = n(b.assigneeAdminId); ev.assignee = { from: t.assigneeAdminId, to: patch.assigneeAdminId };
  }
  if (Array.isArray(b.assigneeIds) && t.kind !== "task") {
    if (!(isCreator || canManage(req))) return fail(res, 403, "forbidden");
    const ids = [...new Set((b.assigneeIds as unknown[]).map(Number).filter(Number.isFinite))];
    const cur = (await loadAssignees(t.id)).filter(a => a.status !== "watcher").map(a => a.adminId);
    const add = ids.filter(id => !cur.includes(id)), del = cur.filter(id => !ids.includes(id));
    if (add.length) await db.insert(taskAssigneesTable).values(add.map(adminId => ({ taskId: t.id, adminId })));
    if (del.length) await db.delete(taskAssigneesTable).where(and(eq(taskAssigneesTable.taskId, t.id), inArray(taskAssigneesTable.adminId, del)));
    ev.assignees = { add, del };
  }
  const [updated] = await db.update(tasksTable).set(patch).where(eq(tasksTable.id, t.id)).returning();
  await db.insert(taskEventsTable).values({ taskId: t.id, adminId: meId, kind: "edited", payload: ev });
  if (ev.assignee && (ev.assignee as any).to) { const { notifyTaskAssigned } = await import("../services/tasks"); await notifyTaskAssigned(updated!, meId, []); }
  if (ev.assignees && (ev.assignees as any).add?.length) { const { notifyTaskAssigned } = await import("../services/tasks"); await notifyTaskAssigned(updated!, meId, (ev.assignees as any).add); }
  const [row] = await decorate([updated!]);
  ok(res, row);
});

router.post("/tasks/:id/status", TP, async (req: AuthedRequest, res) => {
  const t = await loadTask(Number(req.params.id));
  if (!t) return fail(res, 404, "Задачу не знайдено");
  const next = String(req.body?.status ?? "") as TaskStatus;
  if (!["open", "in_progress", "review", "done", "cancelled"].includes(next)) return fail(res, 400, "Невідомий статус");
  const meId = me(req);
  const isCreator = t.creatorAdminId === meId;
  if (t.status === "review" && (next === "done" || next === "in_progress") && !(isCreator || canManage(req))) return fail(res, 403, "Прийняти або повернути може лише автор");
  if (next === "cancelled" && !(isCreator || canManage(req) || t.assigneeAdminId === meId)) return fail(res, 403, "forbidden");
  if (!(isCreator || canManage(req) || (await isParticipant(t, meId)))) return fail(res, 403, "forbidden");
  const updated = await setTaskStatus(t, next, meId, s(req.body?.note));
  const [row] = await decorate([updated]);
  ok(res, row);
});

// групова / зустріч: моя відповідь (accepted | declined | done)
router.post("/tasks/:id/respond", TP, async (req: AuthedRequest, res) => {
  const t = await loadTask(Number(req.params.id));
  if (!t || t.kind === "task") return fail(res, 404, "Не групова задача");
  const st = String(req.body?.status ?? "");
  if (!["accepted", "declined", "done"].includes(st)) return fail(res, 400, "Невідома відповідь");
  const [row] = await db.select().from(taskAssigneesTable).where(and(eq(taskAssigneesTable.taskId, t.id), eq(taskAssigneesTable.adminId, me(req))));
  if (!row) return fail(res, 403, "Ви не учасник");
  await respondAssignee(t, me(req), st as any, s(req.body?.note));
  const [out] = await decorate([(await loadTask(t.id))!]);
  ok(res, out);
});

router.post("/tasks/:id/snooze", TP, async (req: AuthedRequest, res) => {
  const t = await loadTask(Number(req.params.id));
  if (!t) return fail(res, 404, "Задачу не знайдено");
  if (!(canManage(req) || (await isParticipant(t, me(req))))) return fail(res, 403, "forbidden");
  await snoozeTask(t, Number(req.body?.days ?? 1), me(req));
  const [row] = await decorate([(await loadTask(t.id))!]);
  ok(res, row);
});

// «Мій день»: взяти в план на дату (з часом або без); date=null знімає з плану
router.post("/tasks/:id/plan", TP, async (req: AuthedRequest, res) => {
  const t = await loadTask(Number(req.params.id));
  if (!t) return fail(res, 404, "Задачу не знайдено");
  if (!(canManage(req) || (await isParticipant(t, me(req))))) return fail(res, 403, "forbidden");
  const date = s(req.body?.date), time = s(req.body?.time);
  if (date && !DATE_RE.test(date)) return fail(res, 400, "date — YYYY-MM-DD");
  if (time && !TIME_RE.test(time)) return fail(res, 400, "time — HH:MM");
  await planTask(t, date, time, me(req));
  const [row] = await decorate([(await loadTask(t.id))!]);
  ok(res, row);
});

// масово: перенести прострочене на сьогодні / все на завтра
router.post("/tasks/bulk", TP, async (req: AuthedRequest, res) => {
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(Number).filter(Number.isFinite) : [];
  const action = String(req.body?.action ?? "");
  if (!ids.length) return fail(res, 400, "ids");
  let done = 0;
  for (const id of ids) {
    const t = await loadTask(id); if (!t) continue;
    if (!(canManage(req) || (await isParticipant(t, me(req))))) continue;
    if (action === "plan_today") await planTask(t, warsawToday(), null, me(req));
    else if (action === "plan_tomorrow") await planTask(t, addDaysStr(warsawToday(), 1), null, me(req));
    else if (action === "done") await setTaskStatus(t, "done", me(req));
    else if (action === "due") { const d = s(req.body?.date); if (!d || !DATE_RE.test(d)) return fail(res, 400, "date"); await db.update(tasksTable).set({ dueAt: d, updatedAt: new Date() }).where(eq(tasksTable.id, id)); await db.insert(taskEventsTable).values({ taskId: id, adminId: me(req), kind: "edited", payload: { dueAt: { to: d } } }); }
    else if (action === "assign") { if (!canManage(req) && t.creatorAdminId !== me(req)) continue; const a = n(req.body?.assigneeAdminId); await db.update(tasksTable).set({ assigneeAdminId: a, updatedAt: new Date() }).where(eq(tasksTable.id, id)); await db.insert(taskEventsTable).values({ taskId: id, adminId: me(req), kind: "edited", payload: { assignee: { to: a } } }); }
    else return fail(res, 400, "Невідома дія");
    done++;
  }
  ok(res, { done });
});

// Групова: нагадати всім, хто ще не відмітив (автор або tasksManage)
router.post("/tasks/:id/remind", TP, async (req: AuthedRequest, res) => {
  const t = await loadTask(Number(req.params.id));
  if (!t) return fail(res, 404, "Задачу не знайдено");
  if (t.kind !== "group") return fail(res, 400, "Лише для групових задач");
  if (!(canManage(req) || t.creatorAdminId === me(req))) return fail(res, 403, "forbidden");
  ok(res, { reminded: await remindGroup(t, me(req)) });
});

// Коментар із файлами (multipart: body, mentions=JSON, files[]) — вкладення в uploads/task-attachments
const attachUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 5 } });
router.post("/tasks/:id/comments/upload", TP, attachUpload.array("files", 5), async (req: AuthedRequest, res) => {
  const t = await loadTask(Number(req.params.id));
  if (!t) return fail(res, 404, "Задачу не знайдено");
  const body = String(req.body?.body ?? "").trim();
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!body && !files.length) return fail(res, 400, "Порожній коментар");
  let mentions: number[] = [];
  try { mentions = JSON.parse(String(req.body?.mentions ?? "[]")).map(Number).filter(Number.isFinite); } catch { mentions = []; }
  const attachments: { path: string; name: string; mime: string; size: number }[] = [];
  for (const f of files) {
    const mime = sniffDocMime(f.buffer);
    if (!mime || !DOC_MIME_WHITELIST.has(mime)) return fail(res, 400, `Файл «${f.originalname}»: тип не підтверджено вмістом (дозволено фото і PDF)`);
    const originalName = Buffer.from(f.originalname ?? "file", "latin1").toString("utf8");
    const { buffer, fileName } = await compressUploadImage(f.buffer, mime, originalName);
    const stored = makeStoredName(fileName);
    await fs.promises.writeFile(path.join(TASK_ATTACH_DIR, stored), buffer);
    attachments.push({ path: stored, name: fileName, mime, size: buffer.length });
  }
  await addComment(t, me(req), body || `📎 ${attachments.map(a => a.name).join(", ")}`, mentions, attachments);
  ok(res, { ok: true });
});
router.get("/tasks/:id/attachments/:cid/:idx", TP, async (req: AuthedRequest, res) => {
  const [c] = await db.select().from(taskCommentsTable).where(and(eq(taskCommentsTable.id, Number(req.params.cid)), eq(taskCommentsTable.taskId, Number(req.params.id))));
  const a = c?.attachments?.[Number(req.params.idx)];
  if (!a) return fail(res, 404, "Файл не знайдено");
  res.setHeader("Content-Type", a.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  res.sendFile(path.join(TASK_ATTACH_DIR, path.basename(a.path)));
});

router.post("/tasks/:id/comments", TP, async (req: AuthedRequest, res) => {
  const t = await loadTask(Number(req.params.id));
  if (!t) return fail(res, 404, "Задачу не знайдено");
  const body = String(req.body?.body ?? "").trim();
  if (!body) return fail(res, 400, "Порожній коментар");
  const mentions = Array.isArray(req.body?.mentions) ? (req.body.mentions as unknown[]).map(Number).filter(Number.isFinite) : [];
  await addComment(t, me(req), body, mentions);
  ok(res, { ok: true });
});

// ── шаблони ──────────────────────────────────────────────────────────────────
router.get("/task-templates", TP, async (_req, res) => ok(res, await db.select().from(taskTemplatesTable).orderBy(asc(taskTemplatesTable.name))));
router.post("/task-templates", TP, async (req: AuthedRequest, res) => {
  if (!canManage(req)) return fail(res, 403, "forbidden");
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim(); if (!name) return fail(res, 400, "Вкажіть назву");
  const [row] = await db.insert(taskTemplatesTable).values({
    name, kind: TASK_KINDS.includes(b.kind) ? b.kind : "task", titleTemplate: String(b.titleTemplate ?? name), description: s(b.description),
    checklist: Array.isArray(b.checklist) ? b.checklist.map(String) : [], defaultAssigneeAdminId: n(b.defaultAssigneeAdminId), reviewRequired: !!b.reviewRequired,
    dueInDays: n(b.dueInDays), recurrence: b.recurrence ?? null, trigger: ["manual", "worker_created", "worker_fired"].includes(b.trigger) ? b.trigger : "manual",
  }).returning();
  ok(res, row);
});
router.patch("/task-templates/:id", TP, async (req: AuthedRequest, res) => {
  if (!canManage(req)) return fail(res, 403, "forbidden");
  const b = req.body ?? {}; const patch: any = {};
  for (const k of ["name", "titleTemplate", "description", "trigger", "kind"]) if (b[k] !== undefined) patch[k] = s(b[k]);
  if (b.checklist !== undefined) patch.checklist = Array.isArray(b.checklist) ? b.checklist.map(String) : [];
  if (b.defaultAssigneeAdminId !== undefined) patch.defaultAssigneeAdminId = n(b.defaultAssigneeAdminId);
  if (b.reviewRequired !== undefined) patch.reviewRequired = !!b.reviewRequired;
  if (b.dueInDays !== undefined) patch.dueInDays = n(b.dueInDays);
  if (b.recurrence !== undefined) patch.recurrence = b.recurrence ?? null;
  if (b.isActive !== undefined) patch.isActive = !!b.isActive;
  const [row] = await db.update(taskTemplatesTable).set(patch).where(eq(taskTemplatesTable.id, Number(req.params.id))).returning();
  ok(res, row ?? null);
});
router.delete("/task-templates/:id", TP, async (req: AuthedRequest, res) => {
  if (!canManage(req)) return fail(res, 403, "forbidden");
  await db.delete(taskTemplatesTable).where(eq(taskTemplatesTable.id, Number(req.params.id)));
  ok(res, { ok: true });
});

// ── автоправила + налаштування ───────────────────────────────────────────────
router.get("/task-auto-rules", TP, async (_req, res) => {
  await ensureAutoRules();
  const rows = await db.select().from(taskAutoRulesTable);
  const byCode = new Map(rows.map(r => [r.code, r]));
  ok(res, {
    rules: AUTO_RULE_DEFS.map(d => ({ ...d, enabled: byCode.get(d.code)?.enabled ?? d.enabledByDefault, leadDays: byCode.get(d.code)?.leadDays ?? d.leadDays, fallbackAdminId: byCode.get(d.code)?.fallbackAdminId ?? null })),
    settings: { ...DEFAULT_TASK_SETTINGS, ...((byCode.get("settings")?.params ?? {}) as object) },
  });
});
router.patch("/task-auto-rules/:code", TP, async (req: AuthedRequest, res) => {
  if (!canManage(req)) return fail(res, 403, "forbidden");
  await ensureAutoRules();
  const code = String(req.params.code); const b = req.body ?? {};
  if (code === "settings") {
    const cur = await loadTaskSettings();
    const next = { ...cur };
    if (Array.isArray(b.ladder)) next.ladder = b.ladder.map(Number).filter((x: number) => Number.isInteger(x) && x >= 0).sort((a: number, z: number) => z - a);
    if (b.escalationDays !== undefined) next.escalationDays = Math.max(0, Number(b.escalationDays) || 0);
    if (typeof b.digestTime === "string" && TIME_RE.test(b.digestTime)) next.digestTime = b.digestTime;
    if (typeof b.eveningTime === "string" && TIME_RE.test(b.eveningTime)) next.eveningTime = b.eveningTime;
    if (b.skipWeekends !== undefined) next.skipWeekends = !!b.skipWeekends;
    if (b.rollover !== undefined) next.rollover = !!b.rollover;
    if (b.autoRequest !== undefined) next.autoRequest = !!b.autoRequest;
    if (Array.isArray(b.workerLadder)) next.workerLadder = b.workerLadder.map(Number).filter((x: number) => Number.isInteger(x) && x > 0).sort((a: number, z: number) => a - z);
    if (b.silenceDays !== undefined) next.silenceDays = Math.max(1, Number(b.silenceDays) || 14);
    if (b.officeThresholdDays !== undefined) next.officeThresholdDays = Math.max(0, Number(b.officeThresholdDays) || 0);
    await db.update(taskAutoRulesTable).set({ params: next as any, updatedAt: new Date() }).where(eq(taskAutoRulesTable.code, "settings"));
    return ok(res, next);
  }
  if (!AUTO_RULE_DEFS.some(d => d.code === code)) return fail(res, 404, "Невідоме правило");
  const patch: any = { updatedAt: new Date() };
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.leadDays !== undefined) patch.leadDays = n(b.leadDays);
  if (b.fallbackAdminId !== undefined) patch.fallbackAdminId = n(b.fallbackAdminId);
  const [row] = await db.update(taskAutoRulesTable).set(patch).where(eq(taskAutoRulesTable.code, code)).returning();
  ok(res, row);
});
// ручний запуск генератора (після перерахунку легальності)
router.post("/tasks/auto-run", TP, async (req: AuthedRequest, res) => {
  if (!canManage(req)) return fail(res, 403, "forbidden");
  if (req.body?.recompute) await recomputeAllActiveLegality();
  ok(res, await runAutoTasks());
});

export default router;
