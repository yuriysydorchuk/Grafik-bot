// Зголошення нового працівника (рішення власника 09.10.2026): одразу після того, як
// ПРАЦІВНИК підписав умову (routes/sign.ts, bundle з файлом виду umowa) або офіс імпортував
// скан уже підписаної умови (routes/contracts.ts import) — задача виконавцю ZUS
// (правило hire_zus: фолбек правила → головний):
//   • перевірити умову (фірма/фабрика/дати/ставка, підпис від компанії) і документи
//     (паспорт, підстава перебування/праці, анкета);
//   • НЕ студент до 26 → зголосити до ZUS (ZUA) по фірмі умови + додати в Gratyfikant;
//     закривається сама, коли в профілі зʼявляється документ zus_zua цієї фірми (одразу з
//     documentEvents, інакше нічним синком). БЕЗ порівняння часових міток: на момент задачі
//     ZUA фірми в профілі нема (інакше гілка «вже є», без авто-закриття), тож «внесено» =
//     будь-яка не-missing ZUA фірми. (DB-default created_at і JS-записаний updated_at
//     зберігаються в різних поясах — Berlin vs UTC — порівняння з задачею дало б 2-год лаг.)
//   • студент до 26 → до ZUS НЕ зголошувати, лише додати в Gratyfikant; закриває офіс вручну.
// Дзеркало ланцюжка звільнення (terminationFlow.ts: ZWUA). Один відкритий рядок на пару
// працівник×фірма: ключ hire:<worker>:<company> (unique source_key = атомний дедуп паралельних
// викликів); закрита задача з тим самим ключем звільняє ключ суфіксом (патерн zcna.ts).
// Вимкнене правило hire_zus — задачі не створюються.
import { db, tasksTable, contractsTable, contractFilesTable, documentTemplatesTable, documentTypesTable, workerDocumentsTable, workersTable, factoriesTable, companiesTable } from "@workspace/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { addDaysStr } from "../lib/dates";
import { createTask, resolveAssignee, logTaskEvent, OPEN_STATUSES } from "./tasks";
import { normalizeChecklist, dateStr, warsawToday } from "./taskUtils";
import { taskAutoRulesTable } from "@workspace/db";
import { effectiveViewOf } from "./effectiveStatus";
import { isUnder26 } from "./svodniSync";
import { logger } from "../lib/logger";

export const HIRE_SOURCE = "auto:hire_zus";
const UMOWA_KINDS = ["umowa", "sprzatanie_umowa"];

type Task = typeof tasksTable.$inferSelect;

const fmtDate = (d: string | null | undefined) => d ? d.split("-").reverse().join(".") : "";

// Умови з переліку, що є «умовою» (файл шаблону виду umowa або імпортований скан) — сталий
// пакет ZUS/PPK/BHP без umowy зголошення не запускає (той самий критерій, що в legalityRecompute).
async function umowaContracts(contractIds: number[]) {
  if (!contractIds.length) return [];
  const rows = await db.select({
    id: contractsTable.id, workerId: contractsTable.workerId, factoryId: contractsTable.factoryId, status: contractsTable.status,
    companyId: contractsTable.companyId, factoryCompanyId: factoriesTable.companyId, factoryName: factoriesTable.name,
    dateFrom: contractsTable.dateFrom, dateTo: contractsTable.dateTo, data: contractsTable.data,
  }).from(contractsTable).leftJoin(factoriesTable, eq(contractsTable.factoryId, factoriesTable.id)).where(inArray(contractsTable.id, contractIds));
  const withUmowa = new Set((await db.select({ contractId: contractFilesTable.contractId })
    .from(contractFilesTable).innerJoin(documentTemplatesTable, eq(contractFilesTable.templateId, documentTemplatesTable.id))
    .where(and(inArray(contractFilesTable.contractId, contractIds), inArray(documentTemplatesTable.kind, UMOWA_KINDS)))).map(r => r.contractId));
  return rows.filter(r => withUmowa.has(r.id) || (r.data as Record<string, unknown> | null)?.imported === true);
}

async function zuaType() {
  const [ty] = await db.select({ id: documentTypesTable.id }).from(documentTypesTable).where(eq(documentTypesTable.code, "zus_zua"));
  return ty ?? null;
}

// Документи ZUA працівника (крім missing) — для «вже в профілі» при створенні й для авторезолву.
async function zuaDocs(workerId: number) {
  const ty = await zuaType();
  if (!ty) return [];
  return db.select({ id: workerDocumentsTable.id, createdAt: workerDocumentsTable.createdAt, companyId: workerDocumentsTable.employerCompanyId, issuedAt: workerDocumentsTable.issuedAt, submittedAt: workerDocumentsTable.submittedAt })
    .from(workerDocumentsTable).where(and(eq(workerDocumentsTable.workerId, workerId), eq(workerDocumentsTable.docTypeId, ty.id), ne(workerDocumentsTable.status, "missing")));
}

// Чинні (підписані працівником або обома) умови-umowa працівника з цією фірмою — для «ще є що зголошувати».
async function liveUmowaContracts(workerId: number, companyId: number | null) {
  const ids = (await db.select({ id: contractsTable.id }).from(contractsTable)
    .where(and(eq(contractsTable.workerId, workerId), inArray(contractsTable.status, ["worker_signed", "signed"])))).map(r => r.id);
  return (await umowaContracts(ids)).filter(c => (c.companyId ?? c.factoryCompanyId ?? null) === companyId);
}

const docForCompany = (d: { companyId: number | null }, companyId: number | null) => d.companyId == null || companyId == null || d.companyId === companyId;

/** Після підпису працівником (або імпорту підписаного скана): задача «зголосити» на кожну пару працівник×фірма. */
export async function startHireRegistrationFlow(contractIds: number[], actorAdminId: number | null): Promise<number> {
  const [rule] = await db.select({ enabled: taskAutoRulesTable.enabled, leadDays: taskAutoRulesTable.leadDays }).from(taskAutoRulesTable).where(eq(taskAutoRulesTable.code, "hire_zus"));
  if (rule && !rule.enabled) return 0; // правило вимкнене в Налаштуваннях задач (без рядка = enabledByDefault)
  const lead = rule?.leadDays ?? 7;
  const contracts = await umowaContracts(contractIds);
  let created = 0;
  for (const c of contracts) {
    if (!["worker_signed", "signed"].includes(c.status)) continue;
    const companyId = c.companyId ?? c.factoryCompanyId ?? null;
    const sourceKey = `hire:${c.workerId}:${companyId ?? 0}`;
    try {
      // один відкритий рядок на працівник×фірма (друга умова тієї ж фірми — не дублюємо); unique source_key
      // робить дедуп атомним для паралельних викликів, закритий рядок з тим самим ключем звільняє ключ (нижче)
      const [ex] = await db.select({ id: tasksTable.id, status: tasksTable.status }).from(tasksTable).where(eq(tasksTable.sourceKey, sourceKey));
      if (ex && OPEN_STATUSES.includes(ex.status as any)) continue;
      if (ex) await db.update(tasksTable).set({ sourceKey: `${sourceKey}:${ex.id}` }).where(eq(tasksTable.id, ex.id));

      const [raw] = await db.select().from(workersTable).where(eq(workersTable.id, c.workerId));
      if (!raw) continue;
      const w = await effectiveViewOf(raw);
      const bd = dateStr(raw.birthDate);
      const under26 = bd ? isUnder26(bd) : !!raw.under26;
      const student26 = !!w.isStudent && under26;
      const [co] = companyId != null ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, companyId)) : [undefined];
      const coLabel = companyId != null ? (co?.name ?? `фірма #${companyId}`) : null;
      const zuaHave = (await zuaDocs(c.workerId)).filter(d => docForCompany(d, companyId));
      const zuaAt = zuaHave.map(d => dateStr(d.submittedAt) ?? dateStr(d.issuedAt) ?? dateStr(d.createdAt)).filter(Boolean).sort().pop() ?? null;

      const dateFrom = dateStr(c.dateFrom);
      const today = warsawToday();
      const dueAt = addDaysStr(dateFrom && dateFrom > today ? dateFrom : today, lead);

      const period = dateFrom ? `${fmtDate(dateFrom)}${c.dateTo ? ` – ${fmtDate(dateStr(c.dateTo))}` : " – безстроково"}` : "дати не вказані";
      const srcLabel = w.legalSource === "documents" ? "за документами" : w.legalSource === "manual" ? "вручну" : "не визначено";
      const description = [
        `Працівник підписав умову${coLabel ? ` з ${coLabel}` : ""}${c.factoryName ? ` на ${c.factoryName}` : ""} (${period}).`,
        `Статус для виплат: ${w.legalStatus ?? "—"} (${srcLabel}). Студент до 26: ${student26 ? "ТАК — до ZUS не зголошувати, лише Gratyfikant" : "ні"}.`,
        zuaAt ? `ZUS ZUA${coLabel ? ` (${coLabel})` : ""} уже є в профілі від ${fmtDate(zuaAt)} — повторно не подавати, лише перевірити.` : null,
      ].filter(Boolean).join("\n");

      const steps: { text: string; auto?: string }[] = [
        { text: "Перевірити умову: фірма, фабрика, дати, ставка, підпис від компанії" },
        { text: "Перевірити документи: паспорт, підстава перебування/праці, анкета (PESEL, адреса, рахунок, NFZ)" },
      ];
      if (student26) steps.push({ text: "Студент до 26 — до ZUS НЕ зголошувати (без składek)" });
      else if (zuaAt) steps.push({ text: `ZUA вже в профілі (${fmtDate(zuaAt)}) — перевірити, що зголошення чинне` });
      else steps.push({ text: `Зголосити до ZUS (ZUA${coLabel ? `, ${coLabel}` : ""}) — Płatnik / PUE ZUS` });
      steps.push({ text: "Додати працівника в Gratyfikant nexo" });
      if (!student26 && !zuaAt) steps.push({ text: "Внести підтвердження ZUA в профіль", auto: "entered" });

      const title = student26
        ? `Новий працівник — студент до 26, лише Gratyfikant${coLabel ? ` (${coLabel})` : ""}: ${raw.fullName}`
        : `Зголосити нового працівника (ZUS ZUA${coLabel ? `, ${coLabel}` : ""}): ${raw.fullName}`;
      const assignee = await resolveAssignee({ factoryId: null, ruleCode: "hire_zus" });
      await createTask({
        kind: "task", title, description, priority: "high", dueAt, assigneeAdminId: assignee,
        workerId: c.workerId, factoryId: c.factoryId, contractId: c.id, source: HIRE_SOURCE, sourceKey,
        autoParams: { workerName: raw.fullName, contractId: c.id, companyId, dateFrom, student26, zuaAlreadyAt: zuaAt, ...(student26 || zuaAt ? {} : { docTypeCode: "zus_zua" }) },
        checklist: normalizeChecklist(steps.map(s => ({ id: "", text: s.text, done: false, ...(s.auto ? { auto: s.auto } : {}) }))),
      }, actorAdminId);
      created++;
      logger.info({ workerId: c.workerId, contractId: c.id, companyId, student26, zuaAlready: !!zuaAt }, "hire registration task created");
    } catch (e: any) {
      // дубль ключа від паралельного виклику = задача вже є; решта — у лог
      const [dup] = await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.sourceKey, sourceKey), inArray(tasksTable.status, OPEN_STATUSES)));
      if (!dup) logger.warn({ err: e?.message, contractId: c.id, workerId: c.workerId }, "hire registration task failed");
    }
  }
  return created;
}

// Задача «зголосити» виконана документом: є не-missing ZUA цієї фірми (на момент задачі її не було —
// інакше гілка «ZUA вже була» без docTypeCode; студент теж без docTypeCode → лише вручну).
function hireSatisfied(t: Task, docs: { companyId: number | null }[]): boolean {
  const p = (t.autoParams ?? {}) as { companyId?: number | null; docTypeCode?: string };
  if (p.docTypeCode !== "zus_zua") return false;
  return docs.some(d => docForCompany(d, p.companyId ?? null));
}

/** Нічний синк (taskAutoRules): відкриті задачі, що ще чекають — лишаються; решта → auto_resolved. */
export async function openHireTasksStillPending(): Promise<{ sourceKey: string; task: Task }[]> {
  const open = await db.select().from(tasksTable).where(and(eq(tasksTable.source, HIRE_SOURCE), inArray(tasksTable.status, OPEN_STATUSES)));
  const out: { sourceKey: string; task: Task }[] = [];
  for (const t of open) {
    if (!t.sourceKey || !t.workerId) continue;
    // умову відкликали/скасували — зголошувати нема чого, якщо в людини не лишилось іншої чинної умови з цією фірмою
    // (умова A скасована після підпису B: задача лишається і перепривʼязується до B)
    const [c] = t.contractId ? await db.select({ status: contractsTable.status }).from(contractsTable).where(eq(contractsTable.id, t.contractId)) : [];
    if (c && ["declined", "cancelled", "expired", "superseded"].includes(c.status)) {
      const companyId = ((t.autoParams ?? {}) as { companyId?: number | null }).companyId ?? null;
      const [live] = await liveUmowaContracts(t.workerId, companyId);
      if (!live) continue;
      await db.update(tasksTable).set({ contractId: live.id, updatedAt: new Date() }).where(eq(tasksTable.id, t.id));
      t.contractId = live.id;
    }
    if (hireSatisfied(t, await zuaDocs(t.workerId))) continue;
    out.push({ sourceKey: t.sourceKey, task: t });
  }
  return out;
}

/** Одразу після внесення документа (documentEvents): закрити задачі зголошення цього працівника. */
export async function resolveHireTasksNow(workerId: number): Promise<number> {
  const open = await db.select().from(tasksTable).where(and(eq(tasksTable.source, HIRE_SOURCE), eq(tasksTable.workerId, workerId), inArray(tasksTable.status, OPEN_STATUSES)));
  if (!open.length) return 0;
  const docs = await zuaDocs(workerId);
  let n = 0;
  for (const t of open) {
    if (!hireSatisfied(t, docs)) continue;
    await db.update(tasksTable).set({ status: "auto_resolved", completedAt: new Date(), resolutionNote: "документ ZUS ZUA внесено в профіль", updatedAt: new Date() }).where(eq(tasksTable.id, t.id));
    await logTaskEvent(t.id, "auto_resolved", null);
    n++;
  }
  return n;
}
