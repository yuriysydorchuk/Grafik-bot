// Ланцюжок powiadomienie для громадян України (правило задач `ua_notification`, 08.09.2026).
// Джерело — обовʼязок движка легальності obligation.ua_notification (7 днів від першого
// робочого дня, services/legality.ts). Дві ступені, обидві — ГРУПОВІ задачі (одна на
// виконавця, список людей в autoParams.workers):
//   1) графіковій фабрики (→ відповідальний → фолбек правила → головний) на
//      stage1Days-й день роботи: «нові люди чекають на powiadomienie», кнопки
//      «Вислати» по людині / «Вислати всіх» → людина переходить у ступінь 2;
//   2) виконавцю ступеня 2 (params.stage2AdminId → фолбек правила → головний):
//      по кожній людині кроки «дані зібрано» (авто з анкети/профілю), «подано на
//      praca.gov.pl» (руками або авто після завантаження), «підтвердження внесено»
//      (авто, коли документ powiadomienie_ua зʼявився); картка даних для форми
//      PSZ-PPWPU з копіюванням і завантаження PDF підтвердження прямо з задачі.
// Людина зникає зі списків, щойно обовʼязок виконано (документ у профілі) або профіль
// неактивний; порожній список → задача auto_resolved. Нічний syncUaNotificationTasks
// + миттєвий виклик після дій (send/upload).
import {
  db, tasksTable, workersTable, workerLegalityTable, workerDocumentsTable, documentTypesTable, factoriesTable, companiesTable,
  positionsTable, workerQuestionnairesTable, contractsTable, taskAutoRulesTable,
  type Task,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createTask, logTaskEvent, resolveAssignee, priorityForDays, warsawToday, diffDays, dateStr, fmtDate, mdEsc, mainAdminId, adminName, taskPanelUrl, loadTaskSettings, OPEN_STATUSES, type TaskPriority } from "./tasks";
import { loadLegacyWorkerIds } from "./taskLegacy";
import { normalizeChecklist } from "./taskUtils";
import { loadLeadDays } from "./legalityRecompute";
import { documentChanged } from "./documentEvents";
import { notifyAdminById } from "../bot/notify";
import { logger } from "../lib/logger";

export const UA_RULE = "ua_notification";
export const UA_SOURCE = `auto:${UA_RULE}`;
const DOC_CODE = "powiadomienie_ua";
const OBL_CODE = "obligation.ua_notification";

export interface UaRuleParams { stage1Days: number; stage2AdminId: number | null }
export const UA_PARAMS_DEFAULT: UaRuleParams = { stage1Days: 3, stage2AdminId: null };

export interface UaWorker {
  id: number; name: string; factoryId: number | null; factoryName: string | null;
  start: string | null;        // перший робочий день (точка відліку)
  dueAt: string;               // строк подачі (start + 7 з правила легальності)
  sentAt?: string | null;      // ступінь 1 → 2 (ISO)
  sentBy?: number | null;
  submittedAt?: string | null; // «подано» відмічено руками (ISO) — до появи документа
}
export interface UaParams { grouped: true; stage: 1 | 2; workers: UaWorker[]; count: number; workerNames: string[] }

export async function loadUaRule(): Promise<{ enabled: boolean; params: UaRuleParams; fallbackAdminId: number | null }> {
  const [r] = await db.select().from(taskAutoRulesTable).where(eq(taskAutoRulesTable.code, UA_RULE));
  const p = (r?.params ?? {}) as Partial<UaRuleParams>;
  return { enabled: r?.enabled ?? true, fallbackAdminId: r?.fallbackAdminId ?? null, params: { stage1Days: Math.max(1, Number(p.stage1Days ?? UA_PARAMS_DEFAULT.stage1Days) || 3), stage2AdminId: p.stage2AdminId ?? null } };
}

const isUa = (t: Task) => t.source === UA_SOURCE;
const paramsOf = (t: Task): UaParams => {
  const p = (t.autoParams ?? {}) as Partial<UaParams>;
  return { grouped: true, stage: (p.stage === 2 ? 2 : 1), workers: Array.isArray(p.workers) ? (p.workers as UaWorker[]) : [], count: p.workers?.length ?? 0, workerNames: [] };
};
const titleFor = (stage: 1 | 2, n: number) => stage === 1 ? `Powiadomienie: ${n} ${n === 1 ? "нова людина чекає" : "нових людей чекають"} на подачу` : `Подати powiadomienie: ${n} ${n === 1 ? "особа" : "осіб"}`;

async function pendingObligations(today: string): Promise<Map<number, { dueAt: string; start: string | null }>> {
  const rows = await db.select({ workerId: workerLegalityTable.workerId, obligations: workerLegalityTable.obligations, isActive: workersTable.isActive })
    .from(workerLegalityTable).innerJoin(workersTable, eq(workerLegalityTable.workerId, workersTable.id)).where(eq(workersTable.isActive, true));
  const out = new Map<number, { dueAt: string; start: string | null }>();
  // «старі» без документів/умов (додані до запуску модуля) — не ретроактивно (taskLegacy.ts)
  const legacy = await loadLegacyWorkerIds(rows.map(r => r.workerId), (await loadTaskSettings()).legacyBefore);
  for (const r of rows) {
    if (legacy.has(r.workerId)) continue;
    for (const o of (r.obligations ?? []) as { code: string; dueAt: string; satisfied?: boolean; params?: Record<string, unknown> }[]) {
      if (o.code !== OBL_CODE || o.satisfied) continue;
      const dueAt = String(o.dueAt).slice(0, 10);
      const days = typeof o.params?.days === "number" ? (o.params.days as number) : 7;
      out.set(r.workerId, { dueAt, start: dueAt ? addDays(dueAt, -days) : null });
    }
  }
  void today;
  return out;
}
function addDays(d: string, n: number): string { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }

async function writeTask(t: Task, workers: UaWorker[], today: string, ld: { urgent: number; warn: number }): Promise<void> {
  const p = paramsOf(t);
  if (!workers.length) {
    await db.update(tasksTable).set({ status: "auto_resolved", completedAt: new Date(), resolutionNote: "усі повідомлення подано (перевірка системи)", autoParams: { ...p, workers: [], count: 0, workerNames: [] }, updatedAt: new Date() }).where(eq(tasksTable.id, t.id));
    await logTaskEvent(t.id, "auto_resolved", null);
    return;
  }
  const dueAt = workers.map(w => w.dueAt).sort()[0]!;
  const minLeft = diffDays(dueAt, today);
  const priority: TaskPriority = minLeft < 0 ? "urgent" : priorityForDays(minLeft, ld.urgent, ld.warn);
  const title = titleFor(p.stage, workers.length);
  await db.update(tasksTable).set({ title, dueAt, priority, autoParams: { ...p, workers, count: workers.length, workerNames: workers.map(w => w.name).slice(0, 15) }, updatedAt: new Date() }).where(eq(tasksTable.id, t.id));
  if (t.priority !== priority) await logTaskEvent(t.id, "priority", null, { from: t.priority, to: priority });
}

async function openUaTasks(): Promise<Task[]> {
  return db.select().from(tasksTable).where(and(eq(tasksTable.source, UA_SOURCE), inArray(tasksTable.status, OPEN_STATUSES)));
}

async function stage2Assignee(rule: Awaited<ReturnType<typeof loadUaRule>>): Promise<number | null> {
  return rule.params.stage2AdminId ?? rule.fallbackAdminId ?? (await mainAdminId());
}

// Створити/доповнити задачу ступеня для виконавця. Повертає задачу.
async function upsertStageTask(stage: 1 | 2, assigneeId: number | null, add: UaWorker[], today: string, ld: { urgent: number; warn: number }, actorAdminId: number | null): Promise<Task> {
  const key = `ua${stage}:${assigneeId ?? 0}`;
  const [ex] = await db.select().from(tasksTable).where(and(eq(tasksTable.sourceKey, key), inArray(tasksTable.status, OPEN_STATUSES)));
  if (ex) {
    const cur = paramsOf(ex).workers;
    const merged = [...cur.filter(w => !add.some(a => a.id === w.id)), ...add];
    await writeTask(ex, merged, today, ld);
    const [fresh] = await db.select().from(tasksTable).where(eq(tasksTable.id, ex.id));
    return fresh!;
  }
  const dueAt = add.map(w => w.dueAt).sort()[0]!;
  const minLeft = diffDays(dueAt, today);
  const checklist = stage === 1
    ? [{ id: "", text: "Переглянути список і вислати людей до powiadomienia (кнопки нижче)", done: false, auto: "all_sent" }]
    : [{ id: "", text: "Зібрати дані по кожній людині (картка PSZ-PPWPU)", done: false, auto: "all_data" }, { id: "", text: "Подати повідомлення на praca.gov.pl по кожній людині", done: false, auto: "all_submitted" }, { id: "", text: "Завантажити підтвердження в профіль кожного", done: false, auto: "all_entered" }];
  const t = await createTask({
    kind: "task", title: titleFor(stage, add.length), priority: minLeft < 0 ? "urgent" : priorityForDays(minLeft, ld.urgent, ld.warn), dueAt, assigneeAdminId: assigneeId,
    factoryId: stage === 1 && add.every(w => w.factoryId === add[0]!.factoryId) ? add[0]!.factoryId ?? null : null,
    source: UA_SOURCE, sourceKey: key, autoParams: { grouped: true, stage, workers: add, count: add.length, workerNames: add.map(w => w.name).slice(0, 15) } satisfies UaParams,
    checklist: normalizeChecklist(checklist),
  }, actorAdminId);
  return t;
}

// Нічний/миттєвий синк: нові кандидати → ступінь 1; виконані/неактивні — геть зі списків.
export async function syncUaNotificationTasks(today = warsawToday()): Promise<{ created: number; updated: number; resolved: number }> {
  const rule = await loadUaRule();
  const stats = { created: 0, updated: 0, resolved: 0 };
  if (!rule.enabled) return stats;
  const ld = await loadLeadDays();
  const pending = await pendingObligations(today);
  const open = await openUaTasks();
  // 1) чистка списків: обовʼязок виконано / людина неактивна
  const listed = new Set<number>();
  for (const t of open) {
    const cur = paramsOf(t).workers;
    const keep = cur.filter(w => pending.has(w.id)).map(w => ({ ...w, dueAt: pending.get(w.id)!.dueAt, start: pending.get(w.id)!.start ?? w.start }));
    keep.forEach(w => listed.add(w.id));
    if (keep.length !== cur.length || keep.some((w, i) => w.dueAt !== cur[i]?.dueAt)) { await writeTask(t, keep, today, ld); keep.length ? stats.updated++ : stats.resolved++; }
  }
  // 2) нові: stage1Days-й день роботи настав → у ступінь 1 виконавцю фабрики
  const ids = [...pending.keys()].filter(id => !listed.has(id));
  if (!ids.length) return stats;
  const ws = await db.select({ id: workersTable.id, fullName: workersTable.fullName, factoryId: workersTable.factoryId, facName: factoriesTable.name })
    .from(workersTable).leftJoin(factoriesTable, eq(workersTable.factoryId, factoriesTable.id)).where(inArray(workersTable.id, ids));
  const byAssignee = new Map<number | null, UaWorker[]>();
  for (const w of ws) {
    const o = pending.get(w.id)!;
    const start = o.start;
    if (start && addDays(start, rule.params.stage1Days - 1) > today) continue; // ще рано
    const assignee = await resolveAssignee({ factoryId: w.factoryId, ruleCode: UA_RULE, useScheduler: true });
    const l = byAssignee.get(assignee) ?? []; l.push({ id: w.id, name: w.fullName, factoryId: w.factoryId, factoryName: w.facName ?? null, start, dueAt: o.dueAt }); byAssignee.set(assignee, l);
  }
  for (const [assignee, list] of byAssignee) {
    const before = (await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.sourceKey, `ua1:${assignee ?? 0}`), inArray(tasksTable.status, OPEN_STATUSES)))).length;
    const t = await upsertStageTask(1, assignee, list, today, ld, null);
    if (before) stats.updated++; else {
      stats.created++;
      if (assignee) await notifyAdminById(assignee, "tasks", `🪪 *${mdEsc(t.title)}*\n${list.map(w => `• ${mdEsc(w.name)} · до ${fmtDate(w.dueAt)}`).join("\n")}`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "📨 Вислати всіх до powiadomienia", callback_data: `tska:ua_send_all:${t.id}` }, ...(taskPanelUrl() ? [{ text: "🔗 Відкрити", url: `${taskPanelUrl()}/tasks?task=${t.id}` }] : [])]] } }).catch(() => {});
    }
  }
  return stats;
}

// Ступінь 1 → 2: вислати людину/всіх до powiadomienia.
export async function uaSend(task: Task, workerId: number | null, actor: { adminId: number; name?: string | null }): Promise<string> {
  if (!isUa(task) || paramsOf(task).stage !== 1) throw new Error("Це не задача ступеня 1");
  const today = warsawToday();
  const rule = await loadUaRule();
  const ld = await loadLeadDays();
  const cur = paramsOf(task).workers;
  const move = workerId ? cur.filter(w => w.id === workerId) : cur;
  if (!move.length) throw new Error("Людину в списку не знайдено");
  const rest = cur.filter(w => !move.some(m => m.id === w.id));
  const stamped = move.map(w => ({ ...w, sentAt: new Date().toISOString(), sentBy: actor.adminId }));
  const to = await stage2Assignee(rule);
  const t2 = await upsertStageTask(2, to, stamped, today, ld, actor.adminId);
  if (rest.length) await writeTask(task, rest, today, ld);
  else {
    await db.update(tasksTable).set({ status: "done", completedAt: new Date(), completedById: actor.adminId, resolutionNote: `усіх вислано до powiadomienia → задача #${t2.id}`, autoParams: { ...paramsOf(task), workers: [], count: 0, workerNames: [] }, updatedAt: new Date() }).where(eq(tasksTable.id, task.id));
    await logTaskEvent(task.id, "status", actor.adminId, { to: "done", via: "ua_send_all" });
  }
  await logTaskEvent(t2.id, "comment", actor.adminId, { system: true, text: `${actor.name ?? "Офіс"} вислав(ла) до powiadomienia: ${stamped.map(w => w.name).join(", ")}` }).catch(() => {});
  if (to) await notifyAdminById(to, "tasks", `🪪 *Podać powiadomienie* — від ${mdEsc(actor.name ?? "офісу")}:\n${stamped.map(w => `• ${mdEsc(w.name)}${w.factoryName ? ` · ${mdEsc(w.factoryName)}` : ""} · до ${fmtDate(w.dueAt)}`).join("\n")}`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[...(taskPanelUrl() ? [{ text: "🔗 Відкрити задачу", url: `${taskPanelUrl()}/tasks?task=${t2.id}` }] : [])]] } }).catch(() => {});
  return workerId ? `${stamped[0]!.name} → задача «${t2.title}» (${await adminName(to)})` : `${stamped.length} ос. → задача «${t2.title}» (${await adminName(to)})`;
}

// Ступінь 2: «подано» руками (до появи підтвердження).
export async function uaMarkSubmitted(task: Task, workerId: number, actor: { adminId: number }): Promise<string> {
  if (!isUa(task) || paramsOf(task).stage !== 2) throw new Error("Це не задача ступеня 2");
  const cur = paramsOf(task).workers;
  const w = cur.find(x => x.id === workerId);
  if (!w) throw new Error("Людину в списку не знайдено");
  const next = cur.map(x => x.id === workerId ? { ...x, submittedAt: x.submittedAt ? null : new Date().toISOString() } : x);
  await db.update(tasksTable).set({ autoParams: { ...paramsOf(task), workers: next }, updatedAt: new Date() }).where(eq(tasksTable.id, task.id));
  void actor;
  return w.submittedAt ? `${w.name}: позначку «подано» знято` : `${w.name}: подано на praca.gov.pl — лишилось внести підтвердження`;
}

// Ступінь 2: підтвердження (PDF/фото з praca.gov.pl) → документ powiadomienie_ua у профіль
// (present, verified, submitted_at) → перерахунок легальності → людина зникає зі списку.
export async function uaUploadConfirmation(task: Task, workerId: number, file: { relPath: string; fileName: string; mime: string | null }, submittedAt: string | null, actor: { adminId: number }): Promise<string> {
  if (!isUa(task) || paramsOf(task).stage !== 2) throw new Error("Це не задача ступеня 2");
  const w = paramsOf(task).workers.find(x => x.id === workerId);
  if (!w) throw new Error("Людину в списку не знайдено");
  const { ensureDocumentType } = await import("./workerDocuments");
  const ty = await ensureDocumentType(DOC_CODE);
  const [worker] = await db.select({ companyId: workersTable.companyId }).from(workersTable).where(eq(workersTable.id, workerId));
  const sub = submittedAt && /^\d{4}-\d{2}-\d{2}$/.test(submittedAt) ? submittedAt : warsawToday();
  const [d] = await db.insert(workerDocumentsTable).values({
    workerId, docTypeId: ty.id, title: ty.name, status: "present", filePath: file.relPath, fileName: file.fileName, fileMime: file.mime,
    submittedAt: sub, validFrom: sub, issuedAt: sub, employerCompanyId: worker?.companyId ?? null, source: "office", verifiedAt: new Date(), verifiedBy: actor.adminId,
  }).returning();
  await documentChanged({ id: d!.id, workerId }, "created", { adminId: actor.adminId });
  await logTaskEvent(task.id, "worker_upload", actor.adminId, { documentId: d!.id, title: `${ty.name} — ${w.name}` });
  await syncUaNotificationTasks().catch(() => {});
  return `${w.name}: підтвердження внесено в профіль (${ty.name})`;
}

// ── Контекст для «Як вирішити» ────────────────────────────────────────────────
export interface UaContextRow extends UaWorker {
  daysLeft: number; missing: string[]; docId: number | null; docFileUrl: string | null; nationality: string | null;
  steps: { data: boolean; submitted: boolean; entered: boolean };
}
export async function uaContext(task: Task): Promise<{ stage: 1 | 2; rows: UaContextRow[] }> {
  const p = paramsOf(task);
  const today = warsawToday();
  const ids = p.workers.map(w => w.id);
  const rows: UaContextRow[] = [];
  if (!ids.length) return { stage: p.stage, rows };
  const ty = (await db.select().from(documentTypesTable).where(eq(documentTypesTable.code, DOC_CODE)))[0];
  const docs = ty ? await db.select().from(workerDocumentsTable).where(and(inArray(workerDocumentsTable.workerId, ids), eq(workerDocumentsTable.docTypeId, ty.id))).orderBy(desc(workerDocumentsTable.id)) : [];
  const ws = await db.select().from(workersTable).where(inArray(workersTable.id, ids));
  for (const w of p.workers) {
    const doc = docs.find(d => d.workerId === w.id && d.status !== "missing");
    const missing = p.stage === 2 ? (await uaCard(w.id)).missing : [];
    rows.push({ ...w, daysLeft: diffDays(w.dueAt, today), missing, docId: doc?.id ?? null, docFileUrl: doc?.filePath ? `/api/worker-documents/${doc.id}/file` : null, nationality: ws.find(x => x.id === w.id)?.nationality ?? null,
      steps: { data: !missing.length, submitted: !!w.submittedAt || !!doc, entered: !!doc } });
  }
  return { stage: p.stage, rows };
}

export function uaSatisfied(stage: 1 | 2, rows: UaContextRow[]): Set<string> {
  const s = new Set<string>();
  if (stage === 1 && rows.length === 0) s.add("all_sent");
  if (stage === 2 && rows.length && rows.every(r => r.steps.data)) s.add("all_data");
  if (stage === 2 && rows.length && rows.every(r => r.steps.submitted)) s.add("all_submitted");
  if (stage === 2 && rows.length && rows.every(r => r.steps.entered)) s.add("all_entered");
  return s;
}

// ── Картка для форми PSZ-PPWPU (praca.gov.pl) ─────────────────────────────────
export interface UaCardField { key: string; label: string; value: string; required?: boolean; source?: string }
export interface UaCard { workerId: number; name: string; groups: { title: string; fields: UaCardField[] }[]; missing: string[] }
export async function uaCard(workerId: number): Promise<UaCard> {
  const [w] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!w) throw new Error("Працівника не знайдено");
  const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  const [f] = w.factoryId ? await db.select().from(factoriesTable).where(eq(factoriesTable.id, w.factoryId)) : [undefined];
  const cid = w.companyId ?? (f?.multiFirm ? null : f?.companyId ?? null);
  const [c] = cid ? await db.select().from(companiesTable).where(eq(companiesTable.id, cid)) : [undefined];
  const [pos] = w.positionId ? await db.select().from(positionsTable).where(eq(positionsTable.id, w.positionId)) : [undefined];
  const [contract] = await db.select().from(contractsTable).where(and(eq(contractsTable.workerId, workerId), w.factoryId ? eq(contractsTable.factoryId, w.factoryId) : isNull(contractsTable.factoryId), sql`${contractsTable.status} in ('signed','sent','viewed','worker_signed')`)).orderBy(desc(contractsTable.id)).limit(1);
  const { KSIEG_STD_BRUTTO } = await import("./svodni");
  const rate = f?.contractRateBrutto ?? KSIEG_STD_BRUTTO();
  const start = dateStr(w.firstWorkDate) ?? dateStr(w.employmentStartDate) ?? dateStr(contract?.dateFrom) ?? "";
  const addr = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");
  const regAddr = q ? addr([q.regUlica && q.regNumerDomu ? `ul. ${q.regUlica} ${q.regNumerDomu}` : q.regUlica, q.regKodPocztowy, q.regMiejscowosc, q.regGmina ? `gm. ${q.regGmina}` : null, q.regPowiat ? `pow. ${q.regPowiat}` : null, q.regWojewodztwo ? `woj. ${q.regWojewodztwo}` : null]) || (q.addressRegistered ?? "") : "";
  const plAddr = q?.addressPl || addr([q?.postalCode, q?.city]) || regAddr;
  const sex = w.gender === "male" ? "mężczyzna" : w.gender === "female" ? "kobieta" : (q?.sex === "M" ? "mężczyzna" : q?.sex === "F" ? "kobieta" : "");
  const groups: UaCard["groups"] = [
    { title: "Podmiot powierzający pracę (pracodawca)", fields: [
      { key: "company", label: "Nazwa", value: c?.legalName ?? c?.name ?? "", required: true, source: "компанія" },
      { key: "nip", label: "NIP", value: c?.nip ?? "", required: true, source: "компанія" },
      { key: "regon", label: "REGON", value: c?.regon ?? "", required: true, source: "компанія" },
      { key: "krs", label: "KRS", value: c?.krs ?? "", source: "компанія" },
      { key: "pkd", label: "PKD (przeważająca działalność)", value: c?.pkd ?? "", required: true, source: "компанія → PKD" },
      { key: "caddr", label: "Adres siedziby", value: addr([c?.street ? `ul. ${c.street}${c?.houseNumber ? " " + c.houseNumber : ""}` : null, c?.postalCode, c?.city]), required: true, source: "компанія" },
      { key: "rep", label: "Osoba reprezentująca", value: c?.representative ?? "", source: "компанія" },
    ] },
    { title: "Cudzoziemiec", fields: [
      { key: "first", label: "Imię (imiona)", value: [w.firstName ?? w.fullName.split(" ").slice(1).join(" "), w.middleName].filter(Boolean).join(" "), required: true, source: "профіль" },
      { key: "last", label: "Nazwisko", value: w.lastName ?? w.fullName.split(" ")[0] ?? "", required: true, source: "профіль" },
      { key: "sex", label: "Płeć", value: sex, required: true, source: "профіль → стать" },
      { key: "birth", label: "Data urodzenia", value: dateStr(w.birthDate) ?? "", required: true, source: "профіль" },
      { key: "citizen", label: "Obywatelstwo", value: q?.citizenship || (w.nationality === "ukraine" ? "UKR" : w.nationality ?? ""), required: true, source: "анкета / профіль" },
      { key: "pesel", label: "PESEL", value: w.pesel ?? "", source: "профіль" },
      { key: "passport", label: "Dokument podróży (paszport) — seria i numer", value: q?.passportNumber ?? "", required: true, source: "анкета" },
      { key: "passportExp", label: "Paszport ważny do", value: dateStr(q?.passportExpiresAt) ?? "", source: "анкета" },
      { key: "addr", label: "Adres zamieszkania w Polsce", value: plAddr, required: true, source: "анкета → адреса" },
      { key: "phone", label: "Telefon", value: q?.phone ?? "", source: "анкета" },
      { key: "email", label: "E-mail", value: q?.email ?? "", source: "анкета" },
    ] },
    { title: "Praca", fields: [
      { key: "contractType", label: "Rodzaj umowy", value: "umowa zlecenie", required: true },
      { key: "position", label: "Stanowisko / rodzaj pracy", value: f?.contractDuties ?? pos?.name ?? "", required: true, source: "фабрика → обовʼязки / посада" },
      { key: "place", label: "Miejsce wykonywania pracy", value: f ? addr([f.name, f.address ?? f.city]) : "", required: true, source: "фабрика → адреса" },
      { key: "client", label: "Podmiot, do którego kierowany (klient)", value: f?.name ?? "", source: "фабрика" },
      { key: "hours", label: "Wymiar czasu pracy / liczba godzin (mies.)", value: w.notifyHours != null ? String(w.notifyHours) : "", required: true, source: "профіль → години в повідомленні" },
      { key: "rate", label: "Wynagrodzenie (brutto, zł/h)", value: rate ? String(rate) : "", required: true, source: "фабрика → ставка в умові" },
      { key: "start", label: "Data rozpoczęcia pracy", value: start, required: true, source: "профіль → перший робочий день" },
      { key: "period", label: "Okres powierzenia pracy", value: contract ? `${dateStr(contract.dateFrom) ?? start} – ${dateStr(contract.dateTo) ?? "czas nieokreślony"}` : start ? `${start} – czas nieokreślony` : "", source: "умова" },
    ] },
  ];
  const missing = groups.flatMap(g => g.fields.filter(x => x.required && !x.value).map(x => x.label));
  return { workerId, name: w.fullName, groups, missing };
}
