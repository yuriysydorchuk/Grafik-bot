// Zaświadczenie o zatrudnieniu na umowie zlecenie (нотатка власника 10.09.2026):
// коли умова працівника закінчилась (date_to настав — планово або звільненням),
// з шаблону kind='zaswiadczenie' фірми умови генерується документ, на ньому ОДРАЗУ
// печатка+підпис фірми (stampDraftWithCompany), і графіковій іде задача «Надіслати
// на підпис» (правило termination_doc, дія send_sign). Після підпису працівника
// компанія підписує автоматично (DATA_AUTO_FINALIZE у routes/sign.ts).
// Один документ на умову (sourceKey zasw:<contractId>, у будь-якому статусі задачі).
import { db, contractsTable, contractFilesTable, documentTemplatesTable, tasksTable, workersTable } from "@workspace/db";
import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { addDaysStr } from "../lib/dates";
import { createTask, resolveAssignee, warsawToday, dateStr, mdEsc } from "./tasks";
import { notifyAdminById } from "../bot/notify";
import { normalizeChecklist } from "./taskUtils";
import { generateContract, stampDraftWithCompany, EVENT_KINDS, DATA_AUTO_FINALIZE, DATA_SOURCE_CONTRACT } from "./contracts";
import { logger } from "../lib/logger";

export const ZASW_KIND = "zaswiadczenie";
const LOOKBACK_DAYS = 30; // умови, що закінчились давніше, не бекфілимо (модуль запустився 08.09.2026)

export async function generateContractEndCertificates(today = warsawToday()): Promise<{ created: number; skipped: number }> {
  const stats = { created: 0, skipped: 0 };
  const tpls = await db.select().from(documentTemplatesTable)
    .where(and(eq(documentTemplatesTable.kind, ZASW_KIND), eq(documentTemplatesTable.isActive, true)));
  if (!tpls.length) return stats;
  // найспецифічніший шаблон для фірми/фабрики умови (factory > company > all), як у resolveDocumentSet —
  // generateContract з явними templateIds scope не фільтрує
  const pickTemplate = (factoryId: number | null, companyId: number | null) => {
    const score = (t: typeof tpls[number]) =>
      t.scope === "factory" && factoryId != null && (t.scopeFactoryIds as number[]).includes(factoryId) ? 3
      : t.scope === "company" && companyId != null && (t.scopeCompanyIds as number[]).includes(companyId) ? 2
      : t.scope === "all" ? 1 : 0;
    return tpls.map(t => ({ t, s: score(t) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s)[0]?.t ?? null;
  };

  const ended = await db.select().from(contractsTable).where(and(
    eq(contractsTable.status, "signed"), isNotNull(contractsTable.factoryId), isNotNull(contractsTable.dateTo),
    lte(contractsTable.dateTo, today), gte(contractsTable.dateTo, addDaysStr(today, -LOOKBACK_DAYS)),
  ));
  if (!ended.length) return stats;

  // подієві документи самі — не «умови» (їхні файли — з шаблонів EVENT_KINDS)
  const eventContractIds = new Set((await db.select({ contractId: contractFilesTable.contractId })
    .from(contractFilesTable).innerJoin(documentTemplatesTable, eq(contractFilesTable.templateId, documentTemplatesTable.id))
    .where(and(inArray(contractFilesTable.contractId, ended.map(c => c.id)), inArray(documentTemplatesTable.kind, [...EVENT_KINDS])))).map(r => r.contractId));
  const done = new Set((await db.select({ sourceKey: tasksTable.sourceKey }).from(tasksTable)
    .where(inArray(tasksTable.sourceKey, ended.map(c => `zasw:${c.id}`)))).map(r => r.sourceKey));

  for (const c of ended) {
    if (eventContractIds.has(c.id) || done.has(`zasw:${c.id}`)) { stats.skipped++; continue; }
    const tpl = pickTemplate(c.factoryId, c.companyId ?? null);
    if (!tpl) { stats.skipped++; continue; }
    const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, c.workerId));
    if (!worker) continue;
    // Ідемпотентність: СПЕРШУ задача (unique source_key = замок), потім документ; збій генерації →
    // задачу прибираємо, наступний прогін спробує знову. Так ні паралельний прогін, ні падіння між
    // генерацією і задачею не дублюють пакет (ревʼю codex 10.09.2026).
    const assignee = await resolveAssignee({ factoryId: c.factoryId, ruleCode: "termination_doc", useScheduler: true });
    let task: { id: number };
    try {
      task = await createTask({
        kind: "task", title: `Zaświadczenie o zatrudnieniu — надіслати на підпис: ${worker.fullName}`, priority: "normal",
        dueAt: addDaysStr(today, 3), assigneeAdminId: assignee, workerId: c.workerId, factoryId: c.factoryId,
        source: "auto:termination_doc", sourceKey: `zasw:${c.id}`,
        autoParams: { workerName: worker.fullName, forContractId: c.id, dateFrom: dateStr(c.dateFrom), dateTo: dateStr(c.dateTo), signRequired: true, docKind: ZASW_KIND },
        checklist: normalizeChecklist([
          { id: "", text: "Переглянути zaświadczenie (PDF у задачі, печатка фірми вже стоїть)", done: false },
          { id: "", text: "Надіслати працівнику на підпис", done: false, auto: "sent" },
        ]),
        notify: false,
      }, null);
    } catch { stats.skipped++; continue; } // дубль source_key — уже взято іншим прогоном
    try {
      const doc = await generateContract({
        workerId: c.workerId, factoryId: c.factoryId, companyId: c.companyId ?? null, templateIds: [tpl.id],
        dateFrom: dateStr(c.dateFrom), dateTo: dateStr(c.dateTo), allowUnverified: true,
      });
      await db.update(contractsTable).set({
        data: sql`${contractsTable.data} || ${JSON.stringify({ [DATA_AUTO_FINALIZE]: "1", [DATA_SOURCE_CONTRACT]: String(c.id) })}::jsonb`, updatedAt: new Date(),
      }).where(eq(contractsTable.id, doc.id));
      const { stamped } = await stampDraftWithCompany(doc.id, null);
      await db.update(tasksTable).set({ contractId: doc.id, autoParams: sql`${tasksTable.autoParams} || ${JSON.stringify({ contractId: doc.id, stamped })}::jsonb`, updatedAt: new Date() }).where(eq(tasksTable.id, task.id));
      if (assignee) await notifyAdminById(assignee, "tasks", `📄 *Zaświadczenie o zatrudnieniu* — ${mdEsc(worker.fullName)}: документ готовий, надішли на підпис (задача)`, { parse_mode: "Markdown" }).catch(() => {});
      stats.created++;
    } catch (e: any) {
      await db.delete(tasksTable).where(eq(tasksTable.id, task.id)).catch(() => {});
      logger.warn({ err: e?.message, contractId: c.id, workerId: c.workerId }, "zaświadczenie generation failed");
    }
  }
  return stats;
}
