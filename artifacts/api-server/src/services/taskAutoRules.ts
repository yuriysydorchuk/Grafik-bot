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
  mainAdminId, adminName, taskContextButtons, taskPanelUrl, OPEN_STATUSES, type TaskPriority,
} from "./tasks";
import { defaultChecklist } from "./taskResolve";
import { normalizeChecklist } from "./taskUtils";
import { autoRequestDocuments, selfServiceTypeIds, silenceDays } from "./docRequests";
import { loadLeadDays } from "./legalityRecompute";
import { loadLegacyWorkerIds } from "./taskLegacy";
import { notifyAdminById } from "../bot/notify";
import { logger } from "../lib/logger";

export interface AutoRuleDef { code: string; label: string; description: string; leadDays: number | null; enabledByDefault: boolean; scheduler?: boolean }
export const AUTO_RULE_DEFS: AutoRuleDef[] = [
  { code: "doc_expiring", label: "Документ спливає", description: "Строк документа у жовтій зоні (правило легальності «Строки та нагадування», або власний строк типу, або це поле)", leadDays: null, enabledByDefault: true },
  { code: "doc_expired", label: "Документ прострочений", description: "Строк минув, заміни немає", leadDays: null, enabledByDefault: true },
  { code: "contract", label: "Умова спливає або відсутня", description: "Вісь «умова» движка жовта чи червона", leadDays: 7, enabledByDefault: true },
  { code: "obligation", label: "Обов'язок з терміном", description: "Напр. powiadomienie для UA — 7 днів від початку праці", leadDays: null, enabledByDefault: true },
  { code: "required_missing", label: "Бракує обов'язкового документа", description: "Движок каже «немає підстави» (перебування/праця)", leadDays: null, enabledByDefault: true },
  { code: "pending_doc", label: "Перевірити завантажений документ", description: "Працівник надіслав файл за запитом — підтвердити або відхилити", leadDays: null, enabledByDefault: true },
  { code: "payroll_change", label: "Прийняти зміну статусу виплат", description: "Резолвер знайшов зміну за документами — прийняти або відхилити в профілі", leadDays: null, enabledByDefault: true },
  { code: "review_required", label: "Потребує перевірки (движок)", description: "Конфлікт громадянства, кілька підстав тощо", leadDays: null, enabledByDefault: true },
  { code: "absence_unexplained", label: "Пропуск без пояснення", description: "Пропуск без пояснення понад N днів (графікова фабрики)", leadDays: 2, enabledByDefault: true, scheduler: true },
  { code: "candidate_stale", label: "Кандидат без руху", description: "Дата наступної дії в рекрутингу минула", leadDays: 1, enabledByDefault: false },
  { code: "doc_no_response", label: "Працівник не надіслав документ", description: "Автозапит і нагадування в бот минули, файлу немає — звʼязатись самостійно", leadDays: null, enabledByDefault: true },
  // ланцюжок powiadomienie UA (services/uaNotification.ts): ступінь 1 графіковій на N-й день роботи → ступінь 2 виконавцю з params.stage2AdminId
  { code: "ua_notification", label: "Powiadomienie для UA (2 ступені)", description: "На N-й робочий день графіковій список нових людей → «Вислати» → задача подачі на praca.gov.pl виконавцю ступеня 2 (картка PSZ-PPWPU, завантаження підтвердження)", leadDays: null, enabledByDefault: true, scheduler: true },
  // ланцюжок звільнення (services/terminationFlow.ts)
  { code: "termination_doc", label: "Документ звільнення — затвердити", description: "Після звільнення świadectwo із шаблону «Świadectwo (звільнення)» → графікова переглядає й надсилає працівнику (email з анкети або Telegram)", leadDays: null, enabledByDefault: true, scheduler: true },
  { code: "termination_zus", label: "Виреєструвати з ZUS (ZWUA)", description: "Після звільнення — 7 днів на ZWUA; закривається, коли документ ZUS ZWUA внесено в профіль", leadDays: 7, enabledByDefault: true },
];

// Ідемпотентний сід правил (нові коди додаються, наявні не чіпаються).
const RELATIVE_DUE_RULES = new Set(["required_missing", "review_required", "pending_doc", "payroll_change", "doc_no_response", "absence_unexplained"]);

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

const REQUIRED_LABEL: Record<string, string> = { stay_basis: "документ на право перебування", work_basis: "документ на право працювати" }; // проста мова (запит власника 10.09.2026)
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

  const workers = await db.select({ id: workersTable.id, fullName: workersTable.fullName, factoryId: workersTable.factoryId, nationality: workersTable.nationality, telegramId: workersTable.telegramId })
    .from(workersTable).where(eq(workersTable.isActive, true));
  const wById = new Map(workers.map(w => [w.id, w]));
  const ids = workers.map(w => w.id);
  // ланцюжок звільнення — по звільнених, тож ДО раннього виходу «немає активних»
  // 11. Ланцюжок звільнення: ZWUA — звільнені за 90 днів без документа zus_zwua (задачу створює
  // startTerminationFlow одразу; тут — підтримка/auto_resolved, коли документ зʼявився)
  const settings = await loadTaskSettings();
  if (on("termination_zus")) {
    const lead = rules.get("termination_zus")?.leadDays ?? 7;
    // звільнені до дати запуску модуля (settings.legacyBefore) — не ретроактивно (taskLegacy.ts)
    const firedFrom = new Date(Date.now() - 90 * 86400000);
    const fired = (await db.select({ id: workersTable.id, fullName: workersTable.fullName, factoryId: workersTable.factoryId, firedAt: workersTable.firedAt })
      .from(workersTable).where(and(eq(workersTable.isActive, false), gte(workersTable.firedAt, firedFrom))))
      .filter(f => !settings.legacyBefore || (dateStr(f.firedAt) ?? "") >= settings.legacyBefore);
    const zwua = (await db.select().from(documentTypesTable).where(eq(documentTypesTable.code, "zus_zwua")))[0];
    const firedIds = fired.map(f => f.id);
    const have = new Set(zwua && firedIds.length ? (await db.select({ workerId: workerDocumentsTable.workerId }).from(workerDocumentsTable).where(and(inArray(workerDocumentsTable.workerId, firedIds), eq(workerDocumentsTable.docTypeId, zwua.id), ne(workerDocumentsTable.status, "missing")))).map(d => d.workerId) : []);
    for (const f of fired) {
      if (have.has(f.id)) continue;
      const fireDate = dateStr(f.firedAt)!;
      const due = addDaysStr(fireDate, lead);
      out.push({ sourceKey: `zwua:${f.id}`, rule: "termination_zus", title: `Виреєструвати з ZUS (ZWUA): ${f.fullName}`, priority: diffDays(due, today) < 0 ? "urgent" : "high", dueAt: due,
        workerId: f.id, factoryId: f.factoryId, autoParams: { workerName: f.fullName, fireDate, docTypeCode: "zus_zwua" }, assign: { factoryId: null } });
    }
  }
  // 12. Документ звільнення: задача живе, поки пакет не надіслано/підписано (інакше auto_resolved)
  if (on("termination_doc")) {
    const openDoc = await db.select().from(tasksTable).where(and(eq(tasksTable.source, "auto:termination_doc"), inArray(tasksTable.status, OPEN_STATUSES)));
    for (const t of openDoc) {
      if (!t.sourceKey || !t.contractId) continue;
      const { contractsTable } = await import("@workspace/db");
      const [c] = await db.select({ status: contractsTable.status }).from(contractsTable).where(eq(contractsTable.id, t.contractId));
      if (!c || !["draft", "pending_approval", "approved"].includes(c.status)) continue; // надіслано/підписано/скасовано → зникне
      out.push({ sourceKey: t.sourceKey, rule: "termination_doc", title: t.title, priority: t.priority as TaskPriority, dueAt: dateStr(t.dueAt), workerId: t.workerId, factoryId: t.factoryId, contractId: t.contractId, autoParams: (t.autoParams ?? {}) as Record<string, unknown>, assign: { factoryId: t.factoryId, useScheduler: true } });
    }
  }

  if (!ids.length) return out;
  // автозапит документів: self-service тип + Telegram → офісна задача лише при мовчанні
  // (silenceDays) або коли до строку ≤ officeThresholdDays; інакше система сама просить/нагадує
  const ld = await loadLeadDays(); // жовта/червона зона з правила легальності
  const legacy = await loadLegacyWorkerIds(ids, settings.legacyBefore); // «старі» без слідів у модулі — без движкових задач
  const selfIds = settings.autoRequest ? await selfServiceTypeIds() : new Set<number>();
  const allDocs = await db.select().from(workerDocumentsTable).where(inArray(workerDocumentsTable.workerId, ids));
  const docsOf = (workerId: number, docTypeId: number | null) => allDocs.filter(d => d.workerId === workerId && d.docTypeId === docTypeId);
  const selfServed = (w: { telegramId: string | null }, docTypeId: number | null | undefined) => !!w.telegramId && docTypeId != null && selfIds.has(docTypeId);
  const noResponse = (w: { id: number; fullName: string; factoryId: number | null }, d: { id: number; docTypeId: number | null; requestedAt: Date | null; requestRemindCount: number; status: string; expiresAt: unknown }, typeName: string): Candidate | null => {
    const silence = silenceDays(d, today);
    if (silence == null || silence < settings.silenceDays) return null;
    return { sourceKey: `nores:${w.id}:${d.docTypeId}`, rule: "doc_no_response", title: `Не надіслав документ: ${typeName} (запитано ${fmtDate(dateStr(d.requestedAt)!)}, нагадувань ${d.requestRemindCount})`, priority: "high", dueAt: addDaysStr(today, 3),
      workerId: w.id, factoryId: w.factoryId, documentId: d.id, autoParams: { docTypeCode: null, typeName, requestedAt: dateStr(d.requestedAt), reminders: d.requestRemindCount, silenceDays: silence, expiresAt: dateStr(d.expiresAt), workerName: w.fullName }, assign: { factoryId: w.factoryId } };
  };
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
      const leadDays = ty?.renewalLeadDays ?? lead("doc_expiring") ?? ld.warn;
      const name = ty?.name ?? d.title;
      if (daysLeft < 0 && on("doc_expired")) {
        out.push({ sourceKey: `doc:${d.id}`, rule: "doc_expired", title: `${name} прострочений з ${fmtDate(exp)}`, priority: "urgent", dueAt: exp, workerId: w.id, factoryId: w.factoryId, documentId: d.id,
          autoParams: { docTypeCode: ty?.code ?? null, expiresAt: exp, daysLeft, workerName: w.fullName }, assign: { factoryId: w.factoryId } });
      } else if (daysLeft >= 0 && daysLeft <= leadDays && on("doc_expiring")) {
        // self-service + Telegram: система сама просить; офісу — лише «не надіслав» після мовчання або коли строк впритул
        if (selfServed(w, d.docTypeId) && daysLeft > settings.officeThresholdDays) {
          const pendingSame = docsOf(w.id, d.docTypeId).some(x => x.status === "pending");
          if (pendingSame) continue; // файл уже на перевірці → задача pending_doc
          const nr = on("doc_no_response") ? noResponse(w, { ...d, docTypeId: d.docTypeId ?? null }, name) : null;
          if (nr) out.push(nr);
          continue;
        }
        out.push({ sourceKey: `doc:${d.id}`, rule: "doc_expiring", title: `${name} спливає ${fmtDate(exp)}`, priority: priorityForDays(daysLeft, ld.urgent, ld.warn), dueAt: exp, workerId: w.id, factoryId: w.factoryId, documentId: d.id,
          autoParams: { docTypeCode: ty?.code ?? null, expiresAt: exp, daysLeft, workerName: w.fullName }, assign: { factoryId: w.factoryId } });
      }
    }
  }

  // 3–5, 8. З кешу легальності: умова, обов'язки, бракує підстави, review
  const lg = await db.select().from(workerLegalityTable).where(inArray(workerLegalityTable.workerId, ids));
  for (const l of lg) {
    if (legacy.has(l.workerId)) continue;
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
        const prio: TaskPriority = r.code === "contract_expiring" ? priorityForDays(daysLeft, ld.urgent, ld.warn) : r.code === "contract_awaiting_company" ? "high" : "high";
        out.push({ sourceKey: `contract:${w.id}:${fid ?? 0}`, rule: "contract", title: REASON_TITLE[r.code]!(facName(fid), r.params), priority: prio, dueAt: exp ?? addDaysStr(today, 14),
          workerId: w.id, factoryId: fid, contractId: typeof r.params.contractId === "number" ? (r.params.contractId as number) : null,
          autoParams: { code: r.code, ...r.params, workerName: w.fullName }, assign: { factoryId: fid ?? w.factoryId } });
      }
    }
    if (on("obligation")) {
      for (const o of (l.obligations ?? []) as { code: string; dueAt: string; overdue: boolean; satisfied?: boolean; params?: Record<string, unknown> }[]) {
        if (o.satisfied) continue;
        if (o.code === "obligation.ua_notification" && on("ua_notification")) continue; // веде двоступеневий ланцюжок (uaNotification.ts)
        const due = String(o.dueAt).slice(0, 10);
        const daysLeft = diffDays(due, today);
        const what = o.code === "obligation.ua_notification" || o.params?.docCode === "powiadomienie_ua" ? "Подати powiadomienie" : `Виконати обов'язок ${o.code}`;
        out.push({ sourceKey: `obl:${w.id}:${o.code}`, rule: "obligation", title: `${what} до ${fmtDate(due)}${o.overdue ? " (прострочено)" : ""}`, priority: o.overdue ? "urgent" : priorityForDays(daysLeft, ld.urgent, ld.warn), dueAt: due,
          workerId: w.id, factoryId: w.factoryId, autoParams: { code: o.code, ...(o.params ?? {}), workerName: w.fullName }, assign: { factoryId: w.factoryId } });
      }
    }
    if (on("required_missing")) {
      // одна задача на людину з усіма пунктами, що бракує (не по пункту)
      // відсутні документи система НЕ просить (рішення 07.09.2026) — усі пункти в задачу офісу
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

export interface AutoRunStats { created: number; reopened: number; updated: number; resolved: number; reminded: number; escalated: number; checked: number; autoRequested: number; autoReminded: number }

// Файл від працівника → задача «Перевірити завантажений документ» одразу (не чекаючи ночі).
export async function ensurePendingDocTask(documentId: number): Promise<Task | null> {
  const [d] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, documentId));
  if (!d || d.status !== "pending") return null;
  const sourceKey = `pending:${d.id}`;
  const [ex] = await db.select().from(tasksTable).where(and(eq(tasksTable.sourceKey, sourceKey), inArray(tasksTable.status, OPEN_STATUSES)));
  if (ex) return ex;
  const [w] = await db.select({ id: workersTable.id, fullName: workersTable.fullName, factoryId: workersTable.factoryId }).from(workersTable).where(eq(workersTable.id, d.workerId));
  if (!w) return null;
  const ty = d.docTypeId ? (await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, d.docTypeId)))[0] : undefined;
  const assignee = await resolveAssignee({ factoryId: w.factoryId, ruleCode: "pending_doc", prefer: d.requestedBy ?? null });
  const { defaultChecklist: dc } = await import("./taskResolve");
  return createTask({ kind: "task", title: `Перевірити завантажений документ: ${ty?.name ?? d.title}`, priority: "high", dueAt: addDaysStr(warsawToday(), 2), assigneeAdminId: assignee, workerId: w.id, factoryId: w.factoryId, documentId: d.id,
    source: "auto:pending_doc", sourceKey, autoParams: { workerName: w.fullName, source: d.source }, checklist: dc("pending_doc", null) }, null);
}

export async function runAutoTasks(today = warsawToday()): Promise<AutoRunStats> {
  await ensureAutoRules();
  const stats: AutoRunStats = { created: 0, reopened: 0, updated: 0, resolved: 0, reminded: 0, escalated: 0, checked: 0, autoRequested: 0, autoReminded: 0 };
  // спершу автозапити працівникам (self-service типи), потім задачі офісу
  try { const ar = await autoRequestDocuments(today); stats.autoRequested = ar.requested; stats.autoReminded = ar.reminded; }
  catch (e: any) { logger.warn({ err: e?.message }, "doc auto-request failed"); }
  const candidates = await collectCandidates(today);
  // групові задачі ланцюжка powiadomienie живуть своїм синком (списки людей), не кандидатами
  const existing = (await db.select().from(tasksTable).where(like(tasksTable.source, "auto:%"))).filter(t => t.source !== "auto:ua_notification");
  try { const ua = await (await import("./uaNotification")).syncUaNotificationTasks(today); stats.created += ua.created; stats.updated += ua.updated; stats.resolved += ua.resolved; }
  catch (e: any) { logger.warn({ err: e?.message }, "ua notification sync failed"); }
  const byKey = new Map(existing.filter(t => t.sourceKey).map(t => [t.sourceKey!, t]));
  const seen = new Set<string>();
  for (const c of candidates) {
    seen.add(c.sourceKey);
    const ex = byKey.get(c.sourceKey);
    if (!ex) {
      const assignee = await resolveAssignee({ factoryId: c.assign.factoryId, ruleCode: c.rule, prefer: c.assign.prefer, useScheduler: c.assign.useScheduler });
      await createTask({ kind: "task", title: c.title, priority: c.priority, dueAt: c.dueAt, assigneeAdminId: assignee, workerId: c.workerId, factoryId: c.factoryId, documentId: c.documentId, contractId: c.contractId, candidateId: c.candidateId, source: `auto:${c.rule}`, sourceKey: c.sourceKey, autoParams: c.autoParams, checklist: c.autoParams.grouped ? [] : defaultChecklist(c.rule, c.autoParams) }, null);
      stats.created++;
      // «Документ прострочений: копія головному» (макет) — коли виконавець не головний
      if (c.rule === "doc_expired") { const main = await mainAdminId(); if (main && assignee !== main) await notifyAdminById(main, "tasks", `📄 *Прострочений документ* (копія): ${mdEsc(c.title)}\n${mdEsc(String(c.autoParams.workerName ?? ""))} · виконавець: ${mdEsc(await adminName(assignee))}`, { parse_mode: "Markdown" }).catch(() => {}); }
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
    // правила зі строком «сьогодні + N» (не з дати документа) інакше щодня переписували б dueAt і
    // задача ніколи не ставала простроченою — тримаємо перший призначений строк
    const dueAt = RELATIVE_DUE_RULES.has(c.rule) && ex.dueAt ? dateStr(ex.dueAt) : c.dueAt;
    const changed = ex.title !== c.title || dateStr(ex.dueAt) !== dueAt || ex.priority !== c.priority;
    // бекфіл дефолтного чекліста для задач, створених до появи чеклістів (лише якщо порожній)
    // (і заміна старого чекліста без auto-ключів, поки в ньому нічого не відмічено)
    const exList = (ex.checklist ?? []) as { done: boolean; auto?: string }[];
    const stale = exList.length > 0 && !exList.some(x => x.auto) && !exList.some(x => x.done);
    const defaults = (!exList.length || stale) && !c.autoParams.grouped ? defaultChecklist(c.rule, c.autoParams) : [];
    if (changed || defaults.length) {
      await db.update(tasksTable).set({ title: c.title, priority: c.priority, dueAt, autoParams: c.autoParams, updatedAt: new Date(), ...(defaults.length ? { checklist: normalizeChecklist(defaults) } : {}) }).where(eq(tasksTable.id, ex.id));
      if (ex.priority !== c.priority) await logTaskEvent(ex.id, "priority", null, { from: ex.priority, to: c.priority });
      if (changed) stats.updated++;
    }
  }
  // причина зникла → вирішено автоматично
  for (const ex of existing) {
    if (!ex.sourceKey || seen.has(ex.sourceKey) || !OPEN_STATUSES.includes(ex.status as any)) continue;
    await db.update(tasksTable).set({ status: "auto_resolved", completedAt: new Date(), resolutionNote: "причина зникла (перевірка системи)", updatedAt: new Date() }).where(eq(tasksTable.id, ex.id));
    await logTaskEvent(ex.id, "auto_resolved", null);
    stats.resolved++;
  }
  // авто-чекліст відкритих автозадач (запит надіслано / файл прийшов / підтверджено / умова …)
  try {
    const { buildTaskResolution } = await import("./taskResolve");
    const openAuto = await db.select().from(tasksTable).where(and(inArray(tasksTable.status, OPEN_STATUSES), sql`${tasksTable.source} like 'auto:%'`, sql`jsonb_array_length(${tasksTable.checklist}) > 0`));
    for (const t of openAuto) { try { if ((await buildTaskResolution(t)).checklistChanged) stats.checked++; } catch { /* best-effort */ } }
  } catch (e: any) { logger.warn({ err: e?.message }, "auto checklist sync failed"); }
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
      const rows: { text: string; callback_data?: string; url?: string }[][] = [[{ text: "✅ Готово", callback_data: `tsk:done:${t.id}` }, { text: "⏰ Завтра", callback_data: `tsk:snooze:${t.id}` }, ...(taskPanelUrl() ? [{ text: "🔗 Відкрити", url: `${taskPanelUrl()}/tasks?task=${t.id}` }] : [])]];
      const ctxButtons = await taskContextButtons(t);
      if (ctxButtons.length) rows.push(ctxButtons);
      await notifyAdminById(adminId, "tasks", `⏰ *${mdEsc(label)}*: ${mdEsc(t.title)}${(t.autoParams as any)?.workerName ? `\n${mdEsc(String((t.autoParams as any).workerName))}` : ""}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }).catch(() => {});
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
