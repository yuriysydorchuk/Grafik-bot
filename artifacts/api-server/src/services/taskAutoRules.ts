// Автозадачі (модуль «Задачі», 06.09.2026): нічний генератор із кешу легальності
// (worker_legality) та інших джерел. Одна задача на випадок (source_key), повторний
// прогін оновлює строк/пріоритет, зникла причина → auto_resolved. Нагадування за
// драбиною днів (60/30/14/7/0 з налаштувань), ескалація головному після N днів
// прострочення. Джерела вмикаються/вимикаються в task_auto_rules.
import {
  db, tasksTable, workersTable, workerLegalityTable, workerDocumentsTable, documentTypesTable, factoriesTable,
  workerChangesTable, scheduleEntriesTable, scheduleWeeksTable, candidatesTable, taskAutoRulesTable, adminsTable,
  type Task,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, like, lt, lte, ne, sql } from "drizzle-orm";
import { entryDateStr, addDaysStr } from "../lib/dates";
import {
  createTask, logTaskEvent, resolveAssignee, priorityForDays, loadTaskSettings, warsawToday, diffDays, dateStr, fmtDate, mdEsc,
  mainAdminId, adminName, OPEN_STATUSES, type TaskPriority,
} from "./tasks";
import { notifyAdminById } from "../bot/notify";
import { logger } from "../lib/logger";

export interface AutoRuleDef { code: string; label: string; description: string; leadDays: number | null; enabledByDefault: boolean; scheduler?: boolean }
export const AUTO_RULE_DEFS: AutoRuleDef[] = [
  { code: "doc_expiring", label: "Документ спливає", description: "Строк документа ≤ lead-днів типу (renewal_lead_days) або цього правила", leadDays: 30, enabledByDefault: true },
  { code: "doc_expired", label: "Документ прострочений", description: "Строк минув, заміни немає", leadDays: null, enabledByDefault: true },
  { code: "contract", label: "Умова спливає або відсутня", description: "Вісь «умова» движка жовта чи червона", leadDays: 30, enabledByDefault: true },
  { code: "obligation", label: "Обов'язок з терміном", description: "Напр. powiadomienie для UA — 7 днів від початку праці", leadDays: null, enabledByDefault: true },
  { code: "required_missing", label: "Бракує обов'язкового документа", description: "Движок каже «немає підстави» (перебування/праця)", leadDays: null, enabledByDefault: true },
  { code: "pending_doc", label: "Перевірити завантажений документ", description: "Працівник надіслав файл за запитом — підтвердити або відхилити", leadDays: null, enabledByDefault: true },
  { code: "payroll_change", label: "Прийняти зміну статусу виплат", description: "Резолвер знайшов зміну за документами — прийняти або відхилити в профілі", leadDays: null, enabledByDefault: true },
  { code: "review_required", label: "Потребує перевірки (движок)", description: "Конфлікт громадянства, кілька підстав тощо", leadDays: null, enabledByDefault: true },
  { code: "absence_unexplained", label: "Пропуск без пояснення", description: "Пропуск без пояснення понад N днів (графікова фабрики)", leadDays: 2, enabledByDefault: true, scheduler: true },
  { code: "candidate_stale", label: "Кандидат без руху", description: "Дата наступної дії в рекрутингу минула", leadDays: 1, enabledByDefault: false },
];

// Ідемпотентний сід правил (нові коди додаються, наявні не чіпаються).
export async function ensureAutoRules(): Promise<void> {
  const have = new Set((await db.select({ code: taskAutoRulesTable.code }).from(taskAutoRulesTable)).map(r => r.code));
  const rows = AUTO_RULE_DEFS.filter(d => !have.has(d.code)).map(d => ({ code: d.code, enabled: d.enabledByDefault, leadDays: d.leadDays, params: {} }));
  if (!have.has("settings")) rows.push({ code: "settings", enabled: true, leadDays: null, params: {} });
  if (rows.length) await db.insert(taskAutoRulesTable).values(rows);
}

interface Candidate {
  sourceKey: string; rule: string; title: string; priority: TaskPriority; dueAt: string | null;
  workerId?: number | null; factoryId?: number | null; documentId?: number | null; contractId?: number | null; candidateId?: number | null;
  autoParams: Record<string, unknown>; assign: { factoryId?: number | null; prefer?: number | null; useScheduler?: boolean };
}

const REQUIRED_LABEL: Record<string, string> = { stay_basis: "підстава перебування", work_basis: "підстава праці" };
const REASON_TITLE: Record<string, (f: string, p: Record<string, unknown>) => string> = {
  contract_missing: f => `Немає чинної умови на ${f}`,
  contract_expired: (f, p) => `Умова на ${f} закінчилась${p.expiresAt ? ` ${fmtDate(String(p.expiresAt))}` : ""}`,
  contract_expiring: (f, p) => `Умова на ${f} спливає${p.expiresAt ? ` ${fmtDate(String(p.expiresAt))}` : ""}`,
  contract_wrong_company: f => `Умова на ${f} від іншої нашої фірми`,
  contract_awaiting_company: f => `Підписати умову від компанії: ${f}`,
};

export async function collectCandidates(today = warsawToday()): Promise<Candidate[]> {
  const rules = new Map((await db.select().from(taskAutoRulesTable)).map(r => [r.code, r]));
  const on = (code: string) => rules.get(code)?.enabled ?? AUTO_RULE_DEFS.find(d => d.code === code)?.enabledByDefault ?? false;
  const lead = (code: string) => rules.get(code)?.leadDays ?? AUTO_RULE_DEFS.find(d => d.code === code)?.leadDays ?? null;
  const out: Candidate[] = [];

  const workers = await db.select({ id: workersTable.id, fullName: workersTable.fullName, factoryId: workersTable.factoryId, nationality: workersTable.nationality })
    .from(workersTable).where(eq(workersTable.isActive, true));
  const wById = new Map(workers.map(w => [w.id, w]));
  const ids = workers.map(w => w.id);
  if (!ids.length) return out;
  const facs = new Map((await db.select({ id: factoriesTable.id, name: factoriesTable.name }).from(factoriesTable)).map(f => [f.id, f.name]));
  const facName = (id: number | null | undefined) => (id != null ? facs.get(id) ?? `#${id}` : "—");
  const types = new Map((await db.select().from(documentTypesTable)).map(t => [t.id, t]));

  // 1–2. Документи: спливають / прострочені (present з датою)
  if (on("doc_expiring") || on("doc_expired")) {
    const docs = await db.select().from(workerDocumentsTable).where(and(inArray(workerDocumentsTable.workerId, ids), eq(workerDocumentsTable.status, "present")));
    // заміна того ж типу з пізнішим строком гасить стару
    const latestByWorkerType = new Map<string, string>();
    for (const d of docs) { const e = dateStr(d.expiresAt); if (!e) continue; const k = `${d.workerId}:${d.docTypeId}`; if (!latestByWorkerType.has(k) || latestByWorkerType.get(k)! < e) latestByWorkerType.set(k, e); }
    for (const d of docs) {
      const exp = dateStr(d.expiresAt); if (!exp) continue;
      if (latestByWorkerType.get(`${d.workerId}:${d.docTypeId}`) !== exp) continue; // є новіший документ того ж типу
      const w = wById.get(d.workerId)!; const ty = d.docTypeId != null ? types.get(d.docTypeId) : undefined;
      const daysLeft = diffDays(exp, today);
      const leadDays = ty?.renewalLeadDays ?? lead("doc_expiring") ?? 30;
      const name = ty?.name ?? d.title;
      if (daysLeft < 0 && on("doc_expired")) {
        out.push({ sourceKey: `doc:${d.id}`, rule: "doc_expired", title: `${name} прострочений з ${fmtDate(exp)}`, priority: "urgent", dueAt: exp, workerId: w.id, factoryId: w.factoryId, documentId: d.id,
          autoParams: { docTypeCode: ty?.code ?? null, expiresAt: exp, daysLeft, workerName: w.fullName }, assign: { factoryId: w.factoryId } });
      } else if (daysLeft >= 0 && daysLeft <= leadDays && on("doc_expiring")) {
        out.push({ sourceKey: `doc:${d.id}`, rule: "doc_expiring", title: `${name} спливає ${fmtDate(exp)}`, priority: priorityForDays(daysLeft), dueAt: exp, workerId: w.id, factoryId: w.factoryId, documentId: d.id,
          autoParams: { docTypeCode: ty?.code ?? null, expiresAt: exp, daysLeft, workerName: w.fullName }, assign: { factoryId: w.factoryId } });
      }
    }
  }

  // 3–5, 8. З кешу легальності: умова, обов'язки, бракує підстави, review
  const lg = await db.select().from(workerLegalityTable).where(inArray(workerLegalityTable.workerId, ids));
  for (const l of lg) {
    const w = wById.get(l.workerId)!;
    const reasons = (l.reasons ?? []) as { code: string; axis: string; params?: Record<string, unknown> }[];
    if (on("contract")) {
      const byFactory = new Map<number | null, { code: string; params: Record<string, unknown> }>();
      for (const r of reasons) {
        if (!REASON_TITLE[r.code]) continue;
        const fid = typeof r.params?.factoryId === "number" ? (r.params.factoryId as number) : (w.factoryId ?? null);
        const prev = byFactory.get(fid);
        const rank = (c: string) => (c === "contract_missing" || c === "contract_expired" ? 3 : c === "contract_wrong_company" ? 2 : 1);
        if (!prev || rank(r.code) > rank(prev.code)) byFactory.set(fid, { code: r.code, params: r.params ?? {} });
      }
      for (const [fid, r] of byFactory) {
        const exp = r.params.expiresAt ? String(r.params.expiresAt).slice(0, 10) : null;
        const daysLeft = exp ? diffDays(exp, today) : null;
        const leadDays = lead("contract") ?? 30;
        if (r.code === "contract_expiring" && daysLeft != null && daysLeft > leadDays) continue;
        const prio: TaskPriority = r.code === "contract_expiring" ? priorityForDays(daysLeft) : r.code === "contract_awaiting_company" ? "high" : "high";
        out.push({ sourceKey: `contract:${w.id}:${fid ?? 0}`, rule: "contract", title: REASON_TITLE[r.code]!(facName(fid), r.params), priority: prio, dueAt: exp ?? addDaysStr(today, 14),
          workerId: w.id, factoryId: fid, contractId: typeof r.params.contractId === "number" ? (r.params.contractId as number) : null,
          autoParams: { code: r.code, ...r.params, workerName: w.fullName }, assign: { factoryId: fid ?? w.factoryId } });
      }
    }
    if (on("obligation")) {
      for (const o of (l.obligations ?? []) as { code: string; dueAt: string; overdue: boolean; satisfied?: boolean; params?: Record<string, unknown> }[]) {
        if (o.satisfied) continue;
        const due = String(o.dueAt).slice(0, 10);
        const daysLeft = diffDays(due, today);
        const what = o.code === "obligation.ua_notification" || o.params?.docCode === "powiadomienie_ua" ? "Подати powiadomienie" : `Виконати обов'язок ${o.code}`;
        out.push({ sourceKey: `obl:${w.id}:${o.code}`, rule: "obligation", title: `${what} до ${fmtDate(due)}${o.overdue ? " (прострочено)" : ""}`, priority: o.overdue ? "urgent" : priorityForDays(daysLeft), dueAt: due,
          workerId: w.id, factoryId: w.factoryId, autoParams: { code: o.code, ...(o.params ?? {}), workerName: w.fullName }, assign: { factoryId: w.factoryId } });
      }
    }
    if (on("required_missing")) {
      // одна задача на людину з усіма пунктами, що бракує (не по пункту)
      const codes = ((l.requiredMissing ?? []) as string[]);
      if (codes.length) {
        const labels = codes.map(code => REQUIRED_LABEL[code] ?? [...types.values()].find(t => t.code === code)?.name ?? code);
        out.push({ sourceKey: `req:${w.id}`, rule: "required_missing", title: `Бракує: ${labels.join(", ")}`, priority: "high", dueAt: addDaysStr(today, 7),
          workerId: w.id, factoryId: w.factoryId, autoParams: { codes, workerName: w.fullName }, assign: { factoryId: w.factoryId } });
      }
    }
    if (on("review_required") && l.reviewRequired) {
      out.push({ sourceKey: `review:${w.id}`, rule: "review_required", title: "Перевірити легалізацію (потребує перевірки)", priority: "normal", dueAt: addDaysStr(today, 7),
        workerId: w.id, factoryId: w.factoryId, autoParams: { reasons: reasons.map(r => r.code), workerName: w.fullName }, assign: { factoryId: w.factoryId } });
    }
  }

  // 6. Завантажені файли на перевірці
  if (on("pending_doc")) {
    const pend = await db.select().from(workerDocumentsTable).where(and(inArray(workerDocumentsTable.workerId, ids), eq(workerDocumentsTable.status, "pending")));
    for (const d of pend) {
      const w = wById.get(d.workerId)!; const ty = d.docTypeId != null ? types.get(d.docTypeId) : undefined;
      out.push({ sourceKey: `pending:${d.id}`, rule: "pending_doc", title: `Перевірити завантажений документ: ${ty?.name ?? d.title}`, priority: "high", dueAt: addDaysStr(today, 2),
        workerId: w.id, factoryId: w.factoryId, documentId: d.id, autoParams: { workerName: w.fullName, source: d.source }, assign: { factoryId: w.factoryId, prefer: d.requestedBy ?? null } });
    }
  }

  // 7. Зміна статусу виплат за документами (відкритий запис журналу)
  if (on("payroll_change")) {
    const ch = await db.select().from(workerChangesTable).where(and(inArray(workerChangesTable.workerId, ids), eq(workerChangesTable.field, "effectiveLegalStatus"), isNull(workerChangesTable.reviewDismissedAt), isNull(workerChangesTable.appliedRows)));
    for (const c of ch) {
      const w = wById.get(c.workerId)!;
      out.push({ sourceKey: `payroll:${c.id}`, rule: "payroll_change", title: `Прийняти зміну статусу виплат: ${c.oldValue ?? "не зголошений"} → ${c.newValue ?? "не зголошений"}`, priority: "high", dueAt: addDaysStr(today, 3),
        workerId: w.id, factoryId: w.factoryId, autoParams: { changeId: c.id, effectiveDate: dateStr(c.effectiveDate), workerName: w.fullName }, assign: { factoryId: null, prefer: null } });
    }
  }

  // 9. Пропуски без пояснення (графікова фабрики)
  if (on("absence_unexplained")) {
    const after = lead("absence_unexplained") ?? 2;
    const from = addDaysStr(today, -30);
    const rows = await db.select({ id: scheduleEntriesTable.id, workerId: scheduleEntriesTable.workerId, factoryId: scheduleEntriesTable.factoryId, day: scheduleEntriesTable.dayOfWeek, weekStart: scheduleWeeksTable.weekStart })
      .from(scheduleEntriesTable).innerJoin(scheduleWeeksTable, eq(scheduleEntriesTable.weekId, scheduleWeeksTable.id))
      .where(and(eq(scheduleEntriesTable.status, "absent"), isNull(scheduleEntriesTable.absenceExplainedAt), eq(scheduleEntriesTable.absenceExcused, false), inArray(scheduleEntriesTable.workerId, ids), gte(scheduleWeeksTable.weekStart, addDaysStr(from, -7))));
    const byWorker = new Map<number, { dates: string[]; factoryId: number | null; ids: number[] }>();
    for (const r of rows) {
      const d = entryDateStr(String(r.weekStart), r.day);
      if (d < from || d > addDaysStr(today, -after)) continue;
      const g = byWorker.get(r.workerId) ?? { dates: [], factoryId: r.factoryId, ids: [] };
      g.dates.push(d); g.ids.push(r.id); byWorker.set(r.workerId, g);
    }
    for (const [wid, g] of byWorker) {
      const w = wById.get(wid)!; g.dates.sort();
      out.push({ sourceKey: `absence:${wid}:${g.dates[0]}`, rule: "absence_unexplained", title: `Пропуск без пояснення ${g.dates.map(fmtDate).join(", ")}`, priority: "normal", dueAt: addDaysStr(today, 2),
        workerId: wid, factoryId: g.factoryId ?? w.factoryId, autoParams: { dates: g.dates, entryIds: g.ids, workerName: w.fullName }, assign: { factoryId: g.factoryId ?? w.factoryId, useScheduler: true } });
    }
  }

  // Масові випадки (умови / бракує підстав) по фабриці згортаються в одну задачу на
  // фабрику, коли їх більше за поріг (settings.groupAbove, типово 5) — інакше день
  // деплою дав би сотні однакових задач одній людині. Індивідуальні лишаються, коли
  // випадків мало (їх реально робити по одному).
  const groupAbove = Number((rules.get("settings")?.params as any)?.groupAbove ?? 5);
  const grouped: Candidate[] = [];
  for (const rule of ["contract", "required_missing"] as const) {
    const mine = out.filter(c => c.rule === rule);
    const byFac = new Map<number | null, Candidate[]>();
    for (const c of mine) { const l = byFac.get(c.factoryId ?? null) ?? []; l.push(c); byFac.set(c.factoryId ?? null, l); }
    for (const [fid, list] of byFac) {
      if (list.length <= groupAbove) { grouped.push(...list); continue; }
      const names = [...new Set(list.map(c => String(c.autoParams.workerName ?? "")))].filter(Boolean);
      const workerIds = [...new Set(list.map(c => c.workerId).filter((x): x is number => x != null))];
      grouped.push({
        sourceKey: `${rule}:factory:${fid ?? 0}`, rule, priority: "high", dueAt: addDaysStr(today, 14), factoryId: fid, workerId: null,
        title: rule === "contract" ? `Умови на ${facName(fid)}: ${workerIds.length} працівників без чинної умови` : `Бракує підстав у ${workerIds.length} працівників на ${facName(fid)}`,
        autoParams: { grouped: true, count: workerIds.length, workerIds, workerNames: names.slice(0, 15) }, assign: { factoryId: fid },
      });
    }
  }
  const restRules = out.filter(c => c.rule !== "contract" && c.rule !== "required_missing");
  out.length = 0; out.push(...restRules, ...grouped);

  // 10. Кандидати без руху
  if (on("candidate_stale")) {
    const after = lead("candidate_stale") ?? 1;
    const cands = await db.select().from(candidatesTable).where(and(isNull(candidatesTable.workerId), lt(candidatesTable.nextActionAt, new Date(Date.now() - after * 86400000))));
    for (const c of cands) {
      out.push({ sourceKey: `cand:${c.id}:${dateStr(c.nextActionAt)}`, rule: "candidate_stale", title: `Кандидат без руху: ${c.fullName}`, priority: "normal", dueAt: today,
        candidateId: c.id, factoryId: c.factoryId, autoParams: { stage: c.stage, nextActionAt: dateStr(c.nextActionAt) }, assign: { factoryId: c.factoryId, prefer: c.assignedAdminId ?? null } });
    }
  }
  return out;
}

export interface AutoRunStats { created: number; reopened: number; updated: number; resolved: number; reminded: number; escalated: number }

export async function runAutoTasks(today = warsawToday()): Promise<AutoRunStats> {
  await ensureAutoRules();
  const stats: AutoRunStats = { created: 0, reopened: 0, updated: 0, resolved: 0, reminded: 0, escalated: 0 };
  const candidates = await collectCandidates(today);
  const existing = await db.select().from(tasksTable).where(like(tasksTable.source, "auto:%"));
  const byKey = new Map(existing.filter(t => t.sourceKey).map(t => [t.sourceKey!, t]));
  const seen = new Set<string>();
  for (const c of candidates) {
    seen.add(c.sourceKey);
    const ex = byKey.get(c.sourceKey);
    if (!ex) {
      const assignee = await resolveAssignee({ factoryId: c.assign.factoryId, ruleCode: c.rule, prefer: c.assign.prefer, useScheduler: c.assign.useScheduler });
      await createTask({ kind: "task", title: c.title, priority: c.priority, dueAt: c.dueAt, assigneeAdminId: assignee, workerId: c.workerId, factoryId: c.factoryId, documentId: c.documentId, contractId: c.contractId, candidateId: c.candidateId, source: `auto:${c.rule}`, sourceKey: c.sourceKey, autoParams: c.autoParams }, null);
      stats.created++;
      continue;
    }
    if (ex.status === "auto_resolved") {
      // причина повернулась — та сама задача оживає
      await db.update(tasksTable).set({ status: "open", title: c.title, priority: c.priority, dueAt: c.dueAt, autoParams: c.autoParams, remindersSent: [], completedAt: null, completedById: null, resolutionNote: null, escalatedAt: null, updatedAt: new Date() }).where(eq(tasksTable.id, ex.id));
      await logTaskEvent(ex.id, "reopened", null, { rule: c.rule });
      if (ex.assigneeAdminId) await notifyAdminById(ex.assigneeAdminId, "tasks", `🔁 *Знову актуально*: ${mdEsc(c.title)}${c.dueAt ? `\nдо ${fmtDate(c.dueAt)}` : ""}`, { parse_mode: "Markdown" }).catch(() => {});
      stats.reopened++;
      continue;
    }
    if (ex.status === "done" || ex.status === "cancelled") continue; // закрив офіс — не воскрешаємо
    const changed = ex.title !== c.title || dateStr(ex.dueAt) !== c.dueAt || ex.priority !== c.priority;
    if (changed) {
      await db.update(tasksTable).set({ title: c.title, priority: c.priority, dueAt: c.dueAt, autoParams: c.autoParams, updatedAt: new Date() }).where(eq(tasksTable.id, ex.id));
      if (ex.priority !== c.priority) await logTaskEvent(ex.id, "priority", null, { from: ex.priority, to: c.priority });
      stats.updated++;
    }
  }
  // причина зникла → вирішено автоматично
  for (const ex of existing) {
    if (!ex.sourceKey || seen.has(ex.sourceKey) || !OPEN_STATUSES.includes(ex.status as any)) continue;
    await db.update(tasksTable).set({ status: "auto_resolved", completedAt: new Date(), resolutionNote: "причина зникла (перевірка системи)", updatedAt: new Date() }).where(eq(tasksTable.id, ex.id));
    await logTaskEvent(ex.id, "auto_resolved", null);
    stats.resolved++;
  }
  const rem = await sendReminders(today);
  stats.reminded = rem.reminded; stats.escalated = rem.escalated;
  logger.info(stats, "auto tasks run");
  return stats;
}

// Нагадування за драбиною (автозадачі: 60/30/14/7/0; ручні: 1/0) + ескалація головному.
// Кроки 60/30 лише фіксуються (їх видно в дайджесті й у панелі); окреме повідомлення в
// бот — від кроку ≤14 днів, не більше MAX_INDIVIDUAL на людину за прогін, решта одним
// підсумком («…і ще N у панелі») — інакше перший прогін засипав би чат сотнями.
const MAX_INDIVIDUAL = 10;
export async function sendReminders(today = warsawToday()): Promise<{ reminded: number; escalated: number }> {
  const s = await loadTaskSettings();
  let reminded = 0, escalated = 0;
  const open = await db.select().from(tasksTable).where(and(inArray(tasksTable.status, OPEN_STATUSES), sql`${tasksTable.dueAt} is not null`));
  const main = await mainAdminId();
  const escalations: Task[] = [];
  const perAdmin = new Map<number, { t: Task; daysLeft: number }[]>();
  for (const t of open) {
    const due = dateStr(t.dueAt)!;
    if (t.snoozedUntil && dateStr(t.snoozedUntil)! > today) continue;
    const daysLeft = diffDays(due, today);
    const ladder = t.source.startsWith("auto:") ? s.ladder : s.manualLadder;
    const sent = (t.remindersSent ?? []) as number[];
    const dueSteps = ladder.filter(step => daysLeft <= step && !sent.includes(step));
    if (dueSteps.length && t.assigneeAdminId && t.kind !== "meeting") {
      await db.update(tasksTable).set({ remindersSent: [...sent, ...dueSteps] }).where(eq(tasksTable.id, t.id));
      await logTaskEvent(t.id, "reminder", null, { steps: dueSteps, daysLeft });
      if (Math.min(...dueSteps) <= 14) { const l = perAdmin.get(t.assigneeAdminId) ?? []; l.push({ t, daysLeft }); perAdmin.set(t.assigneeAdminId, l); }
      reminded++;
    }
    if (t.kind === "meeting" && daysLeft === 1 && !sent.includes(1)) {
      // зустріч: за день учасникам
      const parts = await db.select({ adminId: sql<number>`admin_id` }).from(sql`task_assignees`).where(sql`task_id = ${t.id}`);
      for (const p of parts) await notifyAdminById(p.adminId, "tasks", `🗓 Завтра${t.dueTime ? ` о ${t.dueTime}` : ""}: *${mdEsc(t.title)}*${t.place ? ` · ${mdEsc(t.place)}` : ""}`, { parse_mode: "Markdown" }).catch(() => {});
      await db.update(tasksTable).set({ remindersSent: [...sent, 1] }).where(eq(tasksTable.id, t.id));
      reminded++;
    }
    if (daysLeft <= -s.escalationDays && !t.escalatedAt && main && t.assigneeAdminId !== main) escalations.push(t);
  }
  for (const [adminId, list] of perAdmin) {
    list.sort((a, b) => a.daysLeft - b.daysLeft);
    for (const { t, daysLeft } of list.slice(0, MAX_INDIVIDUAL)) {
      const label = daysLeft < 0 ? `прострочено ${-daysLeft} дн.` : daysLeft === 0 ? "строк сьогодні" : `за ${daysLeft} дн.`;
      await notifyAdminById(adminId, "tasks", `⏰ *${mdEsc(label)}*: ${mdEsc(t.title)}${(t.autoParams as any)?.workerName ? `\n${mdEsc(String((t.autoParams as any).workerName))}` : ""}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Готово", callback_data: `tsk:done:${t.id}` }, { text: "⏰ Завтра", callback_data: `tsk:snooze:${t.id}` }]] } }).catch(() => {});
    }
    if (list.length > MAX_INDIVIDUAL) await notifyAdminById(adminId, "tasks", `📋 …і ще ${list.length - MAX_INDIVIDUAL} нагадувань — у панелі «Задачі»`, {}).catch(() => {});
  }
  if (escalations.length && main) {
    const lines: string[] = [];
    for (const t of escalations) {
      const who = await adminName(t.assigneeAdminId);
      lines.push(`• ${mdEsc(t.title)} · *${mdEsc(who)}* · −${-diffDays(dateStr(t.dueAt)!, today)} дн.`);
      await db.update(tasksTable).set({ escalatedAt: new Date() }).where(eq(tasksTable.id, t.id));
      await logTaskEvent(t.id, "escalated", null, { to: main });
    }
    await notifyAdminById(main, "tasks", `⚠️ *Прострочено понад ${s.escalationDays} дн.*\n${lines.join("\n")}`, { parse_mode: "Markdown" }).catch(() => {});
    escalated = escalations.length;
  }
  return { reminded, escalated };
}

// Список адмінів для пікерів (без web-only водіїв) — той самий фільтр, що бот
export async function officeAdmins() {
  return db.select({ id: adminsTable.id, name: adminsTable.name, role: adminsTable.role, isMain: adminsTable.isMain, hasTelegram: sql<boolean>`${adminsTable.telegramId} is not null` })
    .from(adminsTable).where(ne(adminsTable.role, "driver")).orderBy(adminsTable.name);
}
export { lte };
