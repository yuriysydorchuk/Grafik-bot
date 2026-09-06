// Модуль «Задачі» — «Як вирішити»: контекст автозадачі (документ, файли від працівника,
// умова, зміна виплат, пропуски, відсутні документи, причини движка) + дії, що закривають
// причину без переходів (запит скану в бот, підтвердити/відхилити файл, прийняти/відхилити
// зміну, перерахунок, повідомлення працівнику). Дії виконує runTaskAction і пише в журнал.
// Чекліст під правило має ключі `auto` — кроки відмічаються самі за фактом (запит надіслано,
// файл прийшов, підтверджено, умова згенерована/надіслана/підписана …) — syncAutoChecklist.
// Файл, який працівник надіслав у відповідь на запит, показується в цій же задачі (uploads)
// з кнопками підтвердити/відхилити, а виконавець одразу отримує сповіщення в бот.
import {
  db, tasksTable, workersTable, workerDocumentsTable, documentTypesTable, contractsTable, workerLegalityTable, workerChangesTable,
  workerQuestionnairesTable, factoriesTable, taskEventsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Task } from "@workspace/db";
import { bot } from "../bot/instance";
import { sendDocsInviteLink, notifyAdminById } from "../bot/notify";
import { documentChanged } from "./documentEvents";
import { recomputeWorkerLegality } from "./legalityRecompute";
import { logTaskEvent } from "./tasks";
import { fmtDate, dateStr, diffDays, mdEsc, normalizeChecklist, OPEN_STATUSES, type ChecklistItem } from "./taskUtils";
import { logger } from "../lib/logger";

export type TaskActionKind = "api" | "link" | "modal";
export interface TaskAction { code: string; label: string; kind: TaskActionKind; href?: string; needsNote?: boolean; notePlaceholder?: string; confirm?: string; primary?: boolean; done?: string | null; bot?: boolean }
export interface UploadInfo { id: number; title: string; typeName: string | null; fileUrl: string; isImage: boolean; uploadedAt: string | null; status: string }
export interface TaskContext {
  rule: string | null; why: string; closesWhen: string | null;
  worker?: { id: number; fullName: string; telegram: boolean; nationality: string | null; language: string | null; factoryId: number | null } | null;
  document?: { id: number; title: string; typeName: string | null; typeCode: string | null; docTypeId: number | null; number: string | null; expiresAt: string | null; status: string; fileUrl: string | null; hasFile: boolean; isImage: boolean; requestedAt: string | null; reviewNote: string | null; updatedAt: string | null } | null;
  uploads?: UploadInfo[]; // файли від працівника на перевірці (будь-якого типу) — переглянути/підтвердити/відхилити звідси
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
const DOC_RULES = new Set(["doc_expiring", "doc_expired", "required_missing", "obligation", "pending_doc"]);
const isImageMime = (m: string | null | undefined) => !!m && m.startsWith("image/");

// Дефолтний чекліст під правило: text + auto-ключ (відмічається сам, коли стан підтверджує крок).
type Step = { text: string; auto?: string };
export function defaultChecklist(rule: string, params: Record<string, unknown> | null | undefined): ChecklistItem[] {
  const code = String(params?.docTypeCode ?? "");
  let steps: Step[] = [];
  switch (rule) {
    case "doc_expiring": case "doc_expired":
      if (CARD_CODES.has(code)) steps = [{ text: "Запитати в працівника, чи подано wniosek", auto: "requested" }, { text: "Отримати zaświadczenie о złożeniu wniosku", auto: "uploaded" }, { text: "Завантажити zaświadczenie в профіль і підтвердити", auto: "verified" }, { text: "Перевірити, що вісь «перебування» стала зеленою", auto: "axis_stay" }];
      else if (code === "passport") steps = [{ text: "Запросити скан нового паспорта в бот", auto: "requested" }, { text: "Отримати скан від працівника", auto: "uploaded" }, { text: "Перевірити дані (номер, строк) і підтвердити", auto: "verified" }, { text: "Оновити паспорт в анкеті, якщо змінився номер" }];
      else if (code === "student_cert") steps = [{ text: "Запросити нову довідку в бот", auto: "requested" }, { text: "Отримати довідку від працівника", auto: "uploaded" }, { text: "Перевірити форму навчання (stacjonarne), строк і підтвердити", auto: "verified" }];
      else if (code === "medical_exam" || code === "sanepid") steps = [{ text: "Записати працівника на badania" }, { text: "Отримати результат і завантажити скан", auto: "uploaded" }, { text: "Підтвердити документ у профілі", auto: "verified" }];
      else steps = [{ text: "Запросити оновлений документ у працівника", auto: "requested" }, { text: "Отримати документ від працівника", auto: "uploaded" }, { text: "Перевірити і підтвердити в профілі", auto: "verified" }];
      break;
    case "contract": steps = [{ text: "Перевірити, що анкета заповнена і підтверджена", auto: "questionnaire" }, { text: "Згенерувати умову на фабрику", auto: "generated" }, { text: "Надіслати на підпис у бот", auto: "sent" }, { text: "Після підпису працівника підписати від фірми", auto: "signed" }]; break;
    case "required_missing": steps = [{ text: "Запросити документи в бот", auto: "requested" }, { text: "Отримати файли від працівника", auto: "uploaded" }, { text: "Перевірити і підтвердити в профілі", auto: "verified" }]; break;
    case "pending_doc": steps = [{ text: "Відкрити файл" }, { text: "Звірити дані з профілем і анкетою" }, { text: "Підтвердити або відхилити з причиною", auto: "decided" }]; break;
    case "payroll_change": steps = [{ text: "Переглянути вплив на сводну" }, { text: "Прийняти або відхилити зміну", auto: "decided" }]; break;
    case "obligation": steps = [{ text: "Подати документ в urząd / на портал" }, { text: "Внести дату подачі й підтвердження в профіль", auto: "entered" }]; break;
    case "absence_unexplained": steps = [{ text: "Звʼязатись із працівником", auto: "contacted" }, { text: "Внести пояснення у відсутностях" }]; break;
    case "review_required": steps = [{ text: "Переглянути причини в легалізації" }, { text: "Виправити дані або документ" }, { text: "Перерахувати", auto: "recomputed" }]; break;
    case "candidate_stale": steps = [{ text: "Звʼязатись із кандидатом" }, { text: "Оновити етап або дату наступної дії" }]; break;
    default: steps = [];
  }
  return normalizeChecklist(steps.map(s => ({ id: "", text: s.text, done: false, auto: s.auto })));
}

const ruleOf = (t: Task) => (t.source.startsWith("auto:") ? t.source.slice(5) : null);
export const parseActionCode = (raw: string): { code: string; param: number | null } => { const [code, p] = raw.split("."); return { code: code!, param: p ? Number(p) : null }; };

export async function buildTaskResolution(task: Task): Promise<{ context: TaskContext; actions: TaskAction[]; checklistChanged: boolean }> {
  const rule = ruleOf(task);
  const p = (task.autoParams ?? {}) as Record<string, unknown>;
  const actions: TaskAction[] = [];
  const ctx: TaskContext = { rule, why: "", closesWhen: rule ? CLOSES_WHEN[rule] ?? null : null };
  const created = dateStr(task.createdAt)!;
  // «після створення задачі»: вік беремо з БД (now() - created_at), бо created_at пише Postgres у
  // локальному часі, а Drizzle читає timestamp як UTC — пряме порівняння з JS-датами зсунуте на TZ
  const [ageRow] = await db.select({ age: sql<number>`extract(epoch from (now() - ${tasksTable.createdAt}))` }).from(tasksTable).where(eq(tasksTable.id, task.id));
  const createdMs = Date.now() - Number(ageRow?.age ?? 0) * 1000;
  const after = (d: Date | null | undefined) => !!d && d.getTime() >= createdMs - 60_000;

  // чому створено
  if (rule) {
    const parts = [`Створено системою ${fmtDate(created)}`];
    if (task.dueAt) { const d = diffDays(dateStr(task.dueAt)!, created); parts[0] += d > 0 ? ` (за ${d} дн. до строку)` : d < 0 ? ` (строк уже минув на ${-d} дн.)` : " (у день строку)"; }
    const [pr] = await db.select({ createdAt: taskEventsTable.createdAt, payload: taskEventsTable.payload }).from(taskEventsTable).where(and(eq(taskEventsTable.taskId, task.id), eq(taskEventsTable.kind, "priority"))).orderBy(desc(taskEventsTable.id)).limit(1);
    if (pr) parts.push(`пріоритет піднято до «${String((pr.payload as any)?.to ?? task.priority)}» ${fmtDate(dateStr(pr.createdAt)!)}`);
    if (task.remindersSent.length) parts.push(`нагадування надіслані: ${[...task.remindersSent].sort((a, b) => b - a).join(" · ")} дн.`);
    if (task.escalatedAt) parts.push(`ескальовано головному ${fmtDate(dateStr(task.escalatedAt)!)}`);
    ctx.why = parts.join(". ") + ".";
  }

  const worker = task.workerId ? (await db.select({ id: workersTable.id, fullName: workersTable.fullName, telegramId: workersTable.telegramId, nationality: workersTable.nationality, language: workersTable.language, factoryId: workersTable.factoryId }).from(workersTable).where(eq(workersTable.id, task.workerId)))[0] ?? null : null;
  if (worker) ctx.worker = { id: worker.id, fullName: worker.fullName, telegram: !!worker.telegramId, nationality: worker.nationality, language: worker.language, factoryId: worker.factoryId };
  const prof = (open = "") => worker ? `/workers/${worker.id}${open ? `?open=${open}` : ""}` : "";
  const typeByCode = async (code: string) => (await db.select().from(documentTypesTable).where(eq(documentTypesTable.code, code)))[0] ?? null;
  const docCtx = (d: typeof workerDocumentsTable.$inferSelect, typeName: string | null, typeCode: string | null) => ({
    id: d.id, title: d.title, typeName, typeCode, docTypeId: d.docTypeId, number: d.number, expiresAt: dateStr(d.expiresAt), status: d.status,
    fileUrl: d.filePath || d.fileUrl ? `/api/worker-documents/${d.id}/file` : null, hasFile: !!(d.filePath || d.fileUrl), isImage: isImageMime(d.fileMime),
    requestedAt: d.requestedAt ? d.requestedAt.toISOString() : null, reviewNote: d.reviewNote, updatedAt: d.updatedAt ? d.updatedAt.toISOString() : null,
  });
  const loadDoc = async () => {
    let d = task.documentId ? (await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, task.documentId)))[0] : undefined;
    if (!d && worker && p.docTypeCode) {
      const ty = await typeByCode(String(p.docTypeCode));
      if (ty) d = (await db.select().from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, worker.id), eq(workerDocumentsTable.docTypeId, ty.id))).orderBy(desc(workerDocumentsTable.id)))[0];
    }
    if (!d) return null;
    const ty = d.docTypeId ? (await db.select().from(documentTypesTable).where(eq(documentTypesTable.id, d.docTypeId)))[0] : null;
    return { raw: d, ctx: docCtx(d, ty?.name ?? null, ty?.code ?? null) };
  };
  const requested = (at: string | null) => (at ? `запитано ${fmtDate(at.slice(0, 10))}` : null);
  // файли від працівника на перевірці (усі типи) — для документних правил
  const workerDocs = worker && rule && DOC_RULES.has(rule)
    ? await db.select({ d: workerDocumentsTable, typeName: documentTypesTable.name }).from(workerDocumentsTable).leftJoin(documentTypesTable, eq(workerDocumentsTable.docTypeId, documentTypesTable.id)).where(eq(workerDocumentsTable.workerId, worker.id)).orderBy(desc(workerDocumentsTable.updatedAt))
    : [];
  const pendingUploads = workerDocs.filter(x => x.d.status === "pending" && (x.d.filePath || x.d.fileUrl));
  if (rule && DOC_RULES.has(rule) && rule !== "pending_doc") {
    ctx.uploads = pendingUploads.map(x => ({ id: x.d.id, title: x.d.title, typeName: x.typeName, fileUrl: `/api/worker-documents/${x.d.id}/file`, isImage: isImageMime(x.d.fileMime), uploadedAt: x.d.updatedAt?.toISOString() ?? null, status: x.d.status }));
  }
  // журнал дій задачі (для авто-чекліста)
  const actionEvents = await db.select({ payload: taskEventsTable.payload, kind: taskEventsTable.kind }).from(taskEventsTable).where(and(eq(taskEventsTable.taskId, task.id), inArray(taskEventsTable.kind, ["action", "worker_upload"])));
  const acted = (code: string) => actionEvents.some(e => e.kind === "action" && String((e.payload as any)?.code ?? "").split(".")[0] === code);
  const satisfied = new Set<string>();

  switch (rule) {
    case "doc_expiring": case "doc_expired": {
      const doc = await loadDoc(); ctx.document = doc?.ctx ?? null;
      const raw = doc?.raw;
      if (raw?.requestedAt || acted("invite_scan") || acted("request_doc")) satisfied.add("requested");
      const sameType = workerDocs.filter(x => x.d.docTypeId && x.d.docTypeId === raw?.docTypeId);
      const uploadedNew = sameType.some(x => (x.d.filePath || x.d.fileUrl) && after(x.d.updatedAt) && (x.d.source === "worker_bot" || x.d.status === "pending" || after(x.d.verifiedAt)))
        || (CARD_CODES.has(doc?.ctx.typeCode ?? "") && workerDocs.some(x => x.d.title.toLowerCase().includes("zaświadczenie") && after(x.d.updatedAt)));
      if (uploadedNew || pendingUploads.length) satisfied.add("uploaded");
      if (sameType.some(x => x.d.status === "present" && after(x.d.verifiedAt))) satisfied.add("verified");
      if (worker) {
        const [lg] = await db.select({ stay: workerLegalityTable.stay, work: workerLegalityTable.work }).from(workerLegalityTable).where(eq(workerLegalityTable.workerId, worker.id));
        if (lg?.stay === "legal" && satisfied.has("verified")) satisfied.add("axis_stay");
        if (doc?.ctx.docTypeId) actions.push({ code: "request_doc", label: "Запросити скан у бот", kind: "api", primary: !pendingUploads.length, done: requested(doc.ctx.requestedAt), bot: !!worker.telegramId });
        actions.push({ code: "invite_scan", label: "Запросити скан+анкету", kind: "api", bot: !!worker.telegramId });
        if (doc?.ctx.typeCode && CARD_CODES.has(doc.ctx.typeCode)) actions.push({ code: "scan_card", label: "Сканувати картку", kind: "link", href: prof("scan-card") });
        actions.push({ code: "add_doc", label: "Додати документ вручну", kind: "link", href: prof(doc?.ctx.docTypeId ? `add-doc:${doc.ctx.docTypeId}` : "add-doc") });
      }
      break;
    }
    case "required_missing": {
      const codes = Array.isArray(p.codes) ? (p.codes as string[]) : [];
      const types = codes.length ? await db.select().from(documentTypesTable).where(inArray(documentTypesTable.code, codes)) : [];
      ctx.missing = codes.map(c => { const ty = types.find(t => t.code === c); return { code: c, name: ty?.name ?? MISSING_LABEL[c] ?? c, docTypeId: ty?.id ?? null }; });
      if (workerDocs.some(x => after(x.d.requestedAt)) || acted("invite_scan") || acted("request_docs")) satisfied.add("requested");
      if (pendingUploads.length || workerDocs.some(x => x.d.source === "worker_bot" && after(x.d.updatedAt))) satisfied.add("uploaded");
      if (workerDocs.some(x => x.d.status === "present" && after(x.d.verifiedAt))) satisfied.add("verified");
      if (worker) {
        actions.push({ code: "request_docs", label: "Запросити документи в бот", kind: "api", primary: !pendingUploads.length, bot: !!worker.telegramId, done: satisfied.has("requested") && !pendingUploads.length ? "запитано" : null });
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
        const [q] = await db.select({ verifiedAt: workerQuestionnairesTable.verifiedAt }).from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, worker.id));
        if (q?.verifiedAt) satisfied.add("questionnaire");
        const st = c?.status ?? null;
        if (c && after(c.generatedAt ?? c.createdAt) && st !== "signed") satisfied.add("generated");
        if (c && after(c.sentAt) && ["sent", "viewed", "worker_signed"].includes(st ?? "")) satisfied.add("sent");
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
        const d = workerDocs.find(x => x.d.docTypeId === ty.id)?.d;
        ctx.document = d ? docCtx(d, ty.name, ty.code) : null;
        if (d && after(d.updatedAt) && (d.submittedAt || d.issuedAt || d.filePath)) satisfied.add("entered");
        actions.push({ code: "add_doc", label: `Внести ${ty.name} (дата подачі)`, kind: "link", href: prof(`add-doc:${ty.id}`), primary: true });
      }
      break;
    }
    case "pending_doc": {
      const doc = await loadDoc(); ctx.document = doc?.ctx ?? null;
      if (doc && doc.ctx.status !== "pending") satisfied.add("decided");
      if (doc && doc.ctx.status === "pending") {
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
        if (!openCh) satisfied.add("decided");
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
        if (acted("recompute")) satisfied.add("recomputed");
        actions.push({ code: "recompute", label: "Перерахувати легальність", kind: "api", primary: true });
      }
      break;
    }
    case "absence_unexplained": {
      ctx.absences = Array.isArray(p.dates) ? (p.dates as string[]) : [];
      if (acted("message_worker")) satisfied.add("contacted");
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
  // файли від працівника: підтвердити/відхилити прямо звідси (на перше місце)
  if (ctx.uploads?.length) {
    const up = ctx.uploads.slice().reverse();
    for (const u of up) actions.unshift({ code: `reject_doc.${u.id}`, label: `Відхилити «${u.typeName ?? u.title}»`, kind: "api", needsNote: true, notePlaceholder: "Причина відхилення — працівник побачить її в боті" });
    for (const u of up) actions.unshift({ code: `verify_doc.${u.id}`, label: `Підтвердити «${u.typeName ?? u.title}»`, kind: "api", primary: true, confirm: "Підтвердити документ як дійсний?" });
  }
  if (worker) {
    if (!actions.some(a => a.code === "message_worker")) actions.push({ code: "message_worker", label: "Написати працівнику", kind: "api", needsNote: true, bot: !!worker.telegramId, notePlaceholder: "Текст повідомлення в бот" });
    actions.push({ code: "profile", label: "Профіль", kind: "link", href: prof() });
    if (rule && rule !== "absence_unexplained" && rule !== "candidate_stale") actions.push({ code: "legalization", label: "Легалізація", kind: "link", href: `/legalization?q=${encodeURIComponent(worker.fullName)}` });
  }
  const checklistChanged = await syncAutoChecklist(task, satisfied);
  return { context: ctx, actions, checklistChanged };
}

// Авто-чекліст: кроки з ключем `auto`, чий стан підтверджено, відмічаються системою (doneBy=null).
// Знімати відмітку назад не будемо — лише ставимо (людина могла відмітити вручну раніше).
async function syncAutoChecklist(task: Task, satisfied: Set<string>): Promise<boolean> {
  const list = (task.checklist ?? []) as (ChecklistItem & { auto?: string })[];
  const next = list.map(c => (c.auto && !c.done && satisfied.has(c.auto)) ? { ...c, done: true, doneBy: null, doneAt: new Date().toISOString() } : c);
  const changedKeys = next.filter((c, i) => c.done !== list[i]!.done).map(c => (c as any).auto as string);
  if (!changedKeys.length) return false;
  await db.update(tasksTable).set({ checklist: next, updatedAt: new Date() }).where(eq(tasksTable.id, task.id));
  await logTaskEvent(task.id, "auto_check", null, { keys: changedKeys });
  task.checklist = next;
  return true;
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

// Виконання дії. code може нести параметр: `verify_doc.123` (id документа). Повертає текст для тосту/бота.
export async function runTaskAction(task: Task, rawCode: string, actor: { adminId: number; name?: string | null }, body: { note?: string } = {}): Promise<string> {
  const { code, param } = parseActionCode(rawCode);
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
      const docId = param ?? context.document?.id ?? null;
      if (!docId) throw new Error("Документ не знайдено");
      if (param && !(context.uploads?.some(u => u.id === param) || context.document?.id === param)) throw new Error("Документ не належить цій задачі");
      const [before] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, docId));
      if (!before) throw new Error("Документ не знайдено");
      if (code === "verify_doc") {
        const patch = { verifiedAt: new Date(), verifiedBy: actor.adminId, reviewNote: null, status: before.status === "pending" ? "present" : before.status, updatedAt: new Date() };
        await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, docId));
        await documentChanged({ id: docId, workerId: before.workerId }, "verified", actor);
        message = `Документ «${before.title}» підтверджено`;
      } else {
        if (!note) throw new Error("Вкажіть причину відхилення");
        const patch = { status: "missing", reviewNote: note, verifiedAt: null, verifiedBy: null, updatedAt: new Date() };
        await db.update(workerDocumentsTable).set(patch).where(eq(workerDocumentsTable.id, docId));
        await documentChanged({ id: docId, workerId: before.workerId }, "rejected", actor);
        message = `Документ «${before.title}» відхилено — працівник отримає причину`;
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
      await bot.telegram.sendMessage(row.telegramId, `✉️ ${actor.name ?? "Офіс"}:\n${note}`);
      message = "Повідомлення надіслано в бот";
      break;
    }
    default: throw new Error("Невідома дія");
  }
  await logTaskEvent(task.id, "action", actor.adminId, { code: rawCode, note: note || undefined, message });
  await db.update(tasksTable).set({ updatedAt: new Date() }).where(eq(tasksTable.id, task.id));
  const [fresh] = await db.select().from(tasksTable).where(eq(tasksTable.id, task.id));
  if (fresh) await buildTaskResolution(fresh); // авто-чекліст після дії
  return message;
}

// Кнопки контекстних дій для бота (лише api-дії без примітки) — до 2 штук.
export function botActionButtons(taskId: number, actions: TaskAction[]): { text: string; callback_data: string }[] {
  const pick = actions.filter(a => a.kind === "api" && !a.needsNote && !a.done && (a.bot !== false)).slice(0, 2);
  const icon = (code: string) => code.startsWith("verify_doc") ? "✅" : ({ request_doc: "📨", request_docs: "📨", invite_scan: "🪪", recompute: "🔄", dismiss_change: "✖️" } as Record<string, string>)[code] ?? "▫️";
  return pick.map(a => ({ text: `${icon(a.code)} ${a.label}`.slice(0, 60), callback_data: `tska:${a.code}:${taskId}` }));
}

// Працівник надіслав файл через бот → відкриті документні задачі цього працівника: журнал
// «файл отримано», авто-чекліст, сповіщення виконавцю з кнопками переглянути/підтвердити.
export async function notifyTasksOnWorkerUpload(workerId: number, documentId: number, title: string): Promise<number> {
  const open = await db.select().from(tasksTable).where(and(eq(tasksTable.workerId, workerId), inArray(tasksTable.status, OPEN_STATUSES), sql`${tasksTable.source} like 'auto:%'`));
  const related = open.filter(t => DOC_RULES.has(ruleOf(t) ?? "") && ruleOf(t) !== "pending_doc");
  if (!related.length) return 0;
  const [w] = await db.select({ fullName: workersTable.fullName }).from(workersTable).where(eq(workersTable.id, workerId));
  const panel = (process.env.WEB_APP_URL ?? "").replace(/\/$/, "");
  let sent = 0;
  for (const t of related) {
    try {
      await logTaskEvent(t.id, "worker_upload", null, { documentId, title });
      const [fresh] = await db.select().from(tasksTable).where(eq(tasksTable.id, t.id));
      if (fresh) await buildTaskResolution(fresh);
      if (!t.assigneeAdminId) continue;
      const kb: any[][] = [[{ text: "✅ Підтвердити", callback_data: `tska:verify_doc.${documentId}:${t.id}` }, { text: "✔ Задача готова", callback_data: `tsk:done:${t.id}` }]];
      if (panel) kb.push([{ text: "👁 Переглянути файл у панелі", url: `${panel}/tasks?task=${t.id}` }]);
      const ok = await notifyAdminById(t.assigneeAdminId, "tasks", `📎 *${mdEsc(w?.fullName ?? "")}* надіслав(ла) файл: *${mdEsc(title)}*\nЗадача: ${mdEsc(t.title)}\nВідхилити з причиною можна в панелі.`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } });
      if (ok) sent++;
    } catch (e: any) { logger.warn({ err: e?.message, taskId: t.id }, "task upload notify failed"); }
  }
  return sent;
}
