// Модуль «Задачі» — «Як вирішити»: контекст автозадачі (документ, умова, файл на перевірці,
// зміна виплат, пропуски, відсутні документи, причини движка) + дії, що закривають причину
// без переходів (запит скану в бот, підтвердити/відхилити файл, прийняти/відхилити зміну,
// перерахунок, повідомлення працівнику). Дії виконує runTaskAction і пише в журнал задачі.
// Веб показує блок у шухляді, бот — кнопки `tska:<code>:<id>`.
import {
  db, tasksTable, workersTable, workerDocumentsTable, documentTypesTable, contractsTable, workerLegalityTable, workerChangesTable,
  factoriesTable, taskEventsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { bot } from "../bot/instance";
import { sendDocsInviteLink } from "../bot/notify";
import { documentChanged } from "./documentEvents";
import { recomputeWorkerLegality } from "./legalityRecompute";
import { logTaskEvent } from "./tasks";
import type { Task } from "@workspace/db";
import { fmtDate, dateStr, diffDays, mdEsc } from "./taskUtils";

export type TaskActionKind = "api" | "link" | "modal";
export interface TaskAction { code: string; label: string; kind: TaskActionKind; href?: string; needsNote?: boolean; notePlaceholder?: string; confirm?: string; primary?: boolean; done?: string | null; bot?: boolean }
export interface TaskContext {
  rule: string | null; why: string; closesWhen: string | null;
  worker?: { id: number; fullName: string; telegram: boolean; nationality: string | null; language: string | null; factoryId: number | null } | null;
  document?: { id: number; title: string; typeName: string | null; typeCode: string | null; docTypeId: number | null; number: string | null; expiresAt: string | null; status: string; fileUrl: string | null; hasFile: boolean; requestedAt: string | null; reviewNote: string | null; updatedAt: string | null } | null;
  contract?: { id: number | null; status: string | null; dateTo: string | null; factoryId: number | null; factoryName: string | null; code: string | null } | null;
  change?: { id: number; oldValue: string | null; newValue: string | null; effectiveDate: string | null } | null;
  missing?: { code: string; name: string; docTypeId: number | null }[];
  absences?: string[];
  reasons?: { code: string; axis?: string; severity?: string; params?: Record<string, unknown> }[];
}

const CARD_CODES = new Set(["trc", "karta_stalego_pobytu", "rezydent_ue", "eu_family_member_card", "refugee_status", "subsidiary_protection", "humanitarian_stay", "tolerated_stay"]);
const CLOSES_WHEN: Record<string, string> = {
  doc_expiring: "у профілі зʼявиться підтверджений документ цього типу з пізнішим строком",
  doc_expired: "у профілі зʼявиться підтверджений документ цього типу з пізнішим строком",
  contract: "на цю фабрику буде чинна підписана умова",
  obligation: "обовʼязок буде виконано — документ або дата подачі в профілі",
  required_missing: "движок побачить підтверджену підставу перебування і праці",
  pending_doc: "документ буде підтверджено або відхилено",
  payroll_change: "зміну буде прийнято або відхилено",
  review_required: "після перерахунку причини перевірки зникнуть",
  absence_unexplained: "пропуск отримає пояснення",
  candidate_stale: "у кандидата оновиться дата наступної дії або етап",
};
const OBLIGATION_DOC: Record<string, string> = { "obligation.ua_notification": "powiadomienie_ua" };
// коди requiredMissing, що не є типами документів (осі движка)
const MISSING_LABEL: Record<string, string> = { stay_basis: "підстава перебування", work_basis: "підстава праці", contract: "чинна умова", questionnaire: "анкета" };

// Дефолтний чекліст під правило (ставиться при створенні автозадачі, редагується як звичайний).
export function defaultChecklist(rule: string, params: Record<string, unknown> | null | undefined): string[] {
  const code = String(params?.docTypeCode ?? "");
  switch (rule) {
    case "doc_expiring": case "doc_expired":
      if (CARD_CODES.has(code)) return ["Запитати в працівника, чи подано wniosek", "Отримати zaświadczenie о złożeniu wniosku", "Завантажити zaświadczenie в профіль і підтвердити", "Перевірити, що вісь «перебування» стала зеленою"];
      if (code === "passport") return ["Запросити скан нового паспорта в бот", "Перевірити дані (номер, строк) і підтвердити", "Оновити паспорт в анкеті, якщо змінився номер"];
      if (code === "student_cert") return ["Запросити нову довідку в бот", "Перевірити форму навчання (stacjonarne) і строк", "Підтвердити документ у профілі"];
      if (code === "medical_exam" || code === "sanepid") return ["Записати працівника на badania", "Отримати результат і завантажити скан", "Підтвердити документ у профілі"];
      return ["Запросити оновлений документ у працівника", "Завантажити в профіль і підтвердити", "Перевірити, що вісь стала зеленою"];
    case "contract": return ["Перевірити, що анкета заповнена і підтверджена", "Згенерувати умову на фабрику", "Надіслати на підпис у бот", "Після підпису працівника підписати від фірми"];
    case "required_missing": return ["Запросити документи в бот", "Перевірити завантажене", "Підтвердити в профілі"];
    case "pending_doc": return ["Відкрити файл", "Звірити дані з профілем і анкетою", "Підтвердити або відхилити з причиною"];
    case "payroll_change": return ["Переглянути вплив на сводну", "Прийняти або відхилити зміну"];
    case "obligation": return ["Подати документ в urząd / на портал", "Внести дату подачі й підтвердження в профіль"];
    case "absence_unexplained": return ["Звʼязатись із працівником", "Внести пояснення у відсутностях"];
    case "review_required": return ["Переглянути причини в легалізації", "Виправити дані або документ", "Перерахувати"];
    case "candidate_stale": return ["Звʼязатись із кандидатом", "Оновити етап або дату наступної дії"];
    default: return [];
  }
}

const ruleOf = (t: Task) => (t.source.startsWith("auto:") ? t.source.slice(5) : null);

export async function buildTaskResolution(task: Task): Promise<{ context: TaskContext; actions: TaskAction[] }> {
  const rule = ruleOf(task);
  const p = (task.autoParams ?? {}) as Record<string, unknown>;
  const actions: TaskAction[] = [];
  const ctx: TaskContext = { rule, why: "", closesWhen: rule ? CLOSES_WHEN[rule] ?? null : null };

  // чому створено
  const created = dateStr(task.createdAt)!;
  if (rule) {
    const parts = [`Створено системою ${fmtDate(created)}`];
    if (task.dueAt) { const d = diffDays(dateStr(task.dueAt)!, created); parts[0] += d > 0 ? ` (за ${d} дн. до строку)` : d < 0 ? ` (строк уже минув на ${-d} дн.)` : " (у день строку)"; }
    const [pr] = await db.select({ createdAt: taskEventsTable.createdAt, payload: taskEventsTable.payload }).from(taskEventsTable).where(and(eq(taskEventsTable.taskId, task.id), eq(taskEventsTable.kind, "priority"))).orderBy(desc(taskEventsTable.id)).limit(1);
    if (pr) parts.push(`пріоритет піднято до «${String((pr.payload as any)?.to ?? task.priority)}» ${fmtDate(dateStr(pr.createdAt)!)}`);
    if (task.remindersSent.length) parts.push(`нагадування надіслані: ${[...task.remindersSent].sort((a, b) => b - a).join(" · ")} дн.`);
    if (task.escalatedAt) parts.push(`ескальовано головному ${fmtDate(dateStr(task.escalatedAt)!)}`);
    ctx.why = parts.join(". ") + ".";
  } else ctx.why = "";

  const worker = task.workerId ? (await db.select({ id: workersTable.id, fullName: workersTable.fullName, telegramId: workersTable.telegramId, nationality: workersTable.nationality, language: workersTable.language, factoryId: workersTable.factoryId }).from(workersTable).where(eq(workersTable.id, task.workerId)))[0] ?? null : null;
  if (worker) ctx.worker = { id: worker.id, fullName: worker.fullName, telegram: !!worker.telegramId, nationality: worker.nationality, language: worker.language, factoryId: worker.factoryId };
  const prof = (open = "") => worker ? `/workers/${worker.id}${open ? `?open=${open}` : ""}` : "";
  const typeByCode = async (code: string) => (await db.select().from(documentTypesTable).where(eq(documentTypesTable.code, code)))[0] ?? null;
  const docCtx = (d: typeof workerDocumentsTable.$inferSelect, typeName: string | null, typeCode: string | null) => ({
    id: d.id, title: d.title, typeName, typeCode, docTypeId: d.docTypeId, number: d.number, expiresAt: dateStr(d.expiresAt), status: d.status,
    fileUrl: d.filePath || d.fileUrl ? `/api/worker-documents/${d.id}/file` : null, hasFile: !!(d.filePath || d.fileUrl), requestedAt: d.requestedAt ? d.requestedAt.toISOString() : null, reviewNote: d.reviewNote, updatedAt: d.updatedAt ? d.updatedAt.toISOString() : null,
  });
  const loadDoc = async () => {
    let d = task.documentId ? (await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, task.documentId)))[0] : undefined;
    if (!d && worker && p.docTypeCode) {
      const ty = await typeByCode(String(p.docTypeCode));
      if (ty) d = (await db.select().from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, worker.id), eq(workerDocumentsTable.docTypeId, ty.id))).orderBy(desc(workerDocumentsTable.id)))[0];
    }
    if (!d) return null;
    const ty = d.docTypeId ? (await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, d.docTypeId)))[0] : null;
    return docCtx(d, ty?.name ?? null, ty?.code ?? null);
  };
  const requested = (at: string | null) => (at ? `запитано ${fmtDate(at.slice(0, 10))}` : null);

  switch (rule) {
    case "doc_expiring": case "doc_expired": {
      const doc = await loadDoc(); ctx.document = doc;
      if (worker) {
        if (doc?.docTypeId) actions.push({ code: "request_doc", label: "Запросити скан у бот", kind: "api", primary: true, done: requested(doc.requestedAt), bot: !!worker.telegramId });
        actions.push({ code: "invite_scan", label: "Запросити скан+анкету", kind: "api", bot: !!worker.telegramId });
        if (doc?.typeCode && CARD_CODES.has(doc.typeCode)) actions.push({ code: "scan_card", label: "Сканувати картку", kind: "link", href: prof("scan-card") });
        actions.push({ code: "add_doc", label: "Додати документ вручну", kind: "link", href: prof(doc?.docTypeId ? `add-doc:${doc.docTypeId}` : "add-doc") });
      }
      break;
    }
    case "required_missing": {
      const codes = Array.isArray(p.codes) ? (p.codes as string[]) : [];
      const types = codes.length ? await db.select().from(documentTypesTable).where(inArray(documentTypesTable.code, codes)) : [];
      ctx.missing = codes.map(c => { const ty = types.find(t => t.code === c); return { code: c, name: ty?.name ?? MISSING_LABEL[c] ?? c, docTypeId: ty?.id ?? null }; });
      if (worker) {
        actions.push({ code: "request_docs", label: "Запросити документи в бот", kind: "api", primary: true, bot: !!worker.telegramId });
        actions.push({ code: "invite_scan", label: "Запросити скан+анкету", kind: "api", bot: !!worker.telegramId });
        actions.push({ code: "add_doc", label: "Додати документ вручну", kind: "link", href: prof(ctx.missing[0]?.docTypeId ? `add-doc:${ctx.missing[0].docTypeId}` : "add-doc") });
      }
      break;
    }
    case "contract": {
      const fid = task.factoryId ?? null;
      let c = task.contractId ? (await db.select().from(contractsTable).where(eq(contractsTable.id, task.contractId)))[0] : undefined;
      if (!c && worker) c = (await db.select().from(contractsTable).where(and(eq(contractsTable.workerId, worker.id), fid ? eq(contractsTable.factoryId, fid) : isNull(contractsTable.factoryId), sql`${contractsTable.status} not in ('cancelled','declined','superseded','expired')`)).orderBy(desc(contractsTable.id)))[0];
      const fac = fid ? (await db.select({ name: factoriesTable.name }).from(factoriesTable).where(eq(factoriesTable.id, fid)))[0] : null;
      ctx.contract = { id: c?.id ?? null, status: c?.status ?? null, dateTo: c ? dateStr(c.dateTo) : null, factoryId: fid, factoryName: fac?.name ?? null, code: String(p.code ?? "") || null };
      if (worker) {
        const st = c?.status ?? null;
        if (!st || st === "signed") actions.push({ code: "generate", label: st === "signed" ? "Згенерувати нову версію" : "Згенерувати умову", kind: "link", href: prof(`generate:${fid ?? 0}`), primary: true });
        else if (["draft", "pending_approval", "approved"].includes(st)) actions.push({ code: "send_contract", label: "Надіслати на підпис", kind: "link", href: prof("contracts"), primary: true });
        else if (st === "worker_signed") actions.push({ code: "company_sign", label: "Підписати від фірми", kind: "link", href: prof("contracts"), primary: true });
        else actions.push({ code: "contracts", label: "Умови в профілі", kind: "link", href: prof("contracts") });
        actions.push({ code: "questionnaire", label: "Анкета", kind: "link", href: prof("anketa") });
      }
      break;
    }
    case "obligation": {
      const code = String(p.code ?? "");
      const tyCode = OBLIGATION_DOC[code];
      const ty = tyCode ? await typeByCode(tyCode) : null;
      if (ty && worker) {
        const [d] = await db.select().from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, worker.id), eq(workerDocumentsTable.docTypeId, ty.id))).orderBy(desc(workerDocumentsTable.id));
        ctx.document = d ? docCtx(d, ty.name, ty.code) : null;
        actions.push({ code: "add_doc", label: `Внести ${ty.name} (дата подачі)`, kind: "link", href: prof(`add-doc:${ty.id}`), primary: true });
      }
      break;
    }
    case "pending_doc": {
      const doc = await loadDoc(); ctx.document = doc;
      if (doc && doc.status === "pending") {
        actions.push({ code: "verify_doc", label: "Підтвердити документ", kind: "api", primary: true, confirm: "Підтвердити документ як дійсний?" });
        actions.push({ code: "reject_doc", label: "Відхилити", kind: "api", needsNote: true, notePlaceholder: "Причина відхилення — працівник побачить її в боті" });
      }
      break;
    }
    case "payroll_change": {
      const id = Number(p.changeId);
      const [ch] = id ? await db.select().from(workerChangesTable).where(eq(workerChangesTable.id, id)) : [];
      if (ch) {
        ctx.change = { id: ch.id, oldValue: ch.oldValue == null ? null : String(ch.oldValue), newValue: ch.newValue == null ? null : String(ch.newValue), effectiveDate: dateStr(ch.effectiveDate) };
        const openCh = !ch.reviewDismissedAt && !ch.appliedRows;
        if (openCh) {
          actions.push({ code: "apply_change", label: "Прийняти (превʼю сводної)", kind: "modal", primary: true });
          actions.push({ code: "dismiss_change", label: "Відхилити — сводна без змін", kind: "api", confirm: "Відхилити зміну? Сводна лишиться як була." });
        }
      }
      break;
    }
    case "review_required": {
      if (worker) {
        const [lg] = await db.select({ reasons: workerLegalityTable.reasons }).from(workerLegalityTable).where(eq(workerLegalityTable.workerId, worker.id));
        ctx.reasons = (lg?.reasons ?? []).filter(r => r.severity !== "info");
        actions.push({ code: "recompute", label: "Перерахувати легальність", kind: "api", primary: true });
      }
      break;
    }
    case "absence_unexplained": {
      ctx.absences = Array.isArray(p.dates) ? (p.dates as string[]) : [];
      if (worker) actions.push({ code: "message_worker", label: "Написати працівнику в бот", kind: "api", primary: true, needsNote: true, bot: !!worker.telegramId,
        notePlaceholder: `Ви пропустили зміну ${ctx.absences.map(fmtDate).join(", ")} без пояснення. Напишіть, будь ласка, причину.` });
      actions.push({ code: "absences", label: "Відсутності", kind: "link", href: "/absences" });
      break;
    }
    case "candidate_stale": {
      actions.push({ code: "candidate", label: "Відкрити кандидата", kind: "link", href: `/recruitment${task.candidateId ? `?candidate=${task.candidateId}` : ""}`, primary: true });
      break;
    }
    default: {
      if (worker) actions.push({ code: "invite_scan", label: "Запросити скан+анкету", kind: "api", bot: !!worker.telegramId });
    }
  }
  if (worker) {
    if (!actions.some(a => a.code === "message_worker")) actions.push({ code: "message_worker", label: "Написати працівнику", kind: "api", needsNote: true, bot: !!worker.telegramId, notePlaceholder: "Текст повідомлення в бот" });
    actions.push({ code: "profile", label: "Профіль", kind: "link", href: prof() });
    if (rule && rule !== "absence_unexplained" && rule !== "candidate_stale") actions.push({ code: "legalization", label: "Легалізація", kind: "link", href: `/legalization?q=${encodeURIComponent(worker.fullName)}` });
  }
  return { context: ctx, actions };
}

async function requestDocument(workerId: number, docTypeId: number, actor: { adminId: number; name?: string | null }) {
  const [t] = await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, docTypeId));
  if (!t) throw new Error("Тип документа не знайдено");
  let [doc] = await db.select().from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, workerId), eq(workerDocumentsTable.docTypeId, docTypeId)));
  const patch = { requestedAt: new Date(), requestedBy: actor.adminId, updatedAt: new Date() };
  if (doc) [doc] = await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, doc.id)).returning();
  else [doc] = await db.insert(workerDocumentsTable).values({ workerId, docTypeId, title: t.name, status: "missing", ...patch }).returning();
  await documentChanged({ id: doc!.id, workerId }, "requested", actor);
  return t.name;
}

// Виконання дії. Повертає текст для тосту/бота; кидає Error з людським текстом.
export async function runTaskAction(task: Task, code: string, actor: { adminId: number; name?: string | null }, body: { note?: string } = {}): Promise<string> {
  const { context } = await buildTaskResolution(task);
  const w = context.worker;
  const note = (body.note ?? "").trim();
  let message: string;
  switch (code) {
    case "request_doc": {
      if (!w || !context.document?.docTypeId) throw new Error("Немає типу документа для запиту");
      const name = await requestDocument(w.id, context.document.docTypeId, actor);
      message = w.telegram ? `Запит «${name}» надіслано в бот` : `Документ «${name}» позначено як запитаний (працівник без Telegram — лінк у профілі)`;
      break;
    }
    case "request_docs": {
      if (!w) throw new Error("Задача без працівника");
      const list = (context.missing ?? []).filter(m => m.docTypeId);
      if (!list.length) throw new Error("Немає типів документів для запиту");
      for (const m of list) await requestDocument(w.id, m.docTypeId!, actor);
      message = `Запитано: ${list.map(m => m.name).join(", ")}`;
      break;
    }
    case "invite_scan": {
      if (!w) throw new Error("Задача без працівника");
      const { createAnketaToken, passportScanLink } = await import("../routes/passportScan");
      const [row] = await db.select({ telegramId: workersTable.telegramId, language: workersTable.language }).from(workersTable).where(eq(workersTable.id, w.id));
      const link = passportScanLink(await createAnketaToken(w.id));
      const sent = row?.telegramId ? await sendDocsInviteLink(row.telegramId, row.language ?? "uk", link) : false;
      message = sent ? "Лінк на скан+анкету надіслано в бот" : `Працівник без Telegram — лінк: ${link}`;
      break;
    }
    case "verify_doc": case "reject_doc": {
      const d = context.document;
      if (!d) throw new Error("Документ не знайдено");
      const [before] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, d.id));
      if (!before) throw new Error("Документ не знайдено");
      if (code === "verify_doc") {
        const patch = { verifiedAt: new Date(), verifiedBy: actor.adminId, reviewNote: null, status: before.status === "pending" ? "present" : before.status, updatedAt: new Date() };
        await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, d.id));
        await documentChanged({ id: d.id, workerId: before.workerId }, "verified", actor);
        message = `Документ «${d.title}» підтверджено`;
      } else {
        if (!note) throw new Error("Вкажіть причину відхилення");
        const patch = { status: "missing", reviewNote: note, verifiedAt: null, verifiedBy: null, updatedAt: new Date() };
        await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, d.id));
        await documentChanged({ id: d.id, workerId: before.workerId }, "rejected", actor);
        message = `Документ відхилено — працівник отримає причину`;
      }
      break;
    }
    case "dismiss_change": {
      if (!context.change) throw new Error("Зміну не знайдено");
      await db.update(workerChangesTable).set({ reviewDismissedAt: new Date(), adminId: actor.adminId }).where(and(eq(workerChangesTable.id, context.change.id), isNull(workerChangesTable.reviewDismissedAt)));
      message = "Зміну відхилено — сводна без змін";
      break;
    }
    case "recompute": {
      if (!w) throw new Error("Задача без працівника");
      const r = await recomputeWorkerLegality(w.id);
      message = r ? `Перераховано: ${r.overall}${r.reviewRequired ? " · далі потребує перевірки" : ""}` : "Перераховано";
      break;
    }
    case "message_worker": {
      if (!w) throw new Error("Задача без працівника");
      if (!note) throw new Error("Порожнє повідомлення");
      const [row] = await db.select({ telegramId: workersTable.telegramId }).from(workersTable).where(eq(workersTable.id, w.id));
      if (!row?.telegramId) throw new Error("Працівник не привʼязаний до бота");
      await bot.telegram.sendMessage(row.telegramId, `✉️ ${mdEsc(actor.name ?? "Офіс")}:\n${note}`);
      message = "Повідомлення надіслано в бот";
      break;
    }
    default: throw new Error("Невідома дія");
  }
  await logTaskEvent(task.id, "action", actor.adminId, { code, note: note || undefined, message });
  await db.update(tasksTable).set({ updatedAt: new Date() }).where(eq(tasksTable.id, task.id));
  return message;
}

// Кнопки контекстних дій для бота (лише api-дії без примітки) — до 2 штук.
export function botActionButtons(taskId: number, actions: TaskAction[]): { text: string; callback_data: string }[] {
  const pick = actions.filter(a => a.kind === "api" && !a.needsNote && !a.done && (a.bot !== false)).slice(0, 2);
  const icon: Record<string, string> = { request_doc: "📨", request_docs: "📨", invite_scan: "🪪", verify_doc: "✅", recompute: "🔄", dismiss_change: "✖️" };
  return pick.map(a => ({ text: `${icon[a.code] ?? "▫️"} ${a.label}`, callback_data: `tska:${a.code}:${taskId}` }));
}
