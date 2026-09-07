// Ланцюжок звільнення (08.09.2026): після fireWorker() —
//   1) документ про звільнення з шаблону kind='wypowiedzenie' (коли такий шаблон є в
//      бібліотеці й анкета підтверджена) → чернетка пакета → задача графіковій
//      «Затвердити документ звільнення» (правило termination_doc; після затвердження
//      документ іде працівнику на email/Telegram — services/documentDelivery.ts);
//   2) задача «Виреєструвати з ZUS (ZWUA)» виконавцю правила termination_zus
//      (фолбек правила → головний), строк 7 днів від дати звільнення; закривається сама,
//      коли в профілі зʼявляється документ типу zus_zwua (нічний синк у taskAutoRules).
import { db, tasksTable, documentTemplatesTable, workerQuestionnairesTable, type Worker } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { addDaysStr } from "../lib/dates";
import { createTask, resolveAssignee, OPEN_STATUSES } from "./tasks";
import { normalizeChecklist } from "./taskUtils";
import { logger } from "../lib/logger";

export const TERMINATION_TEMPLATE_KIND = "wypowiedzenie";

export async function startTerminationFlow(worker: Worker, fireDate: string, actorAdminId: number | null): Promise<void> {
  // 2) ZUS ZWUA — завжди
  const zwuaKey = `zwua:${worker.id}`;
  const [exZ] = await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.sourceKey, zwuaKey), inArray(tasksTable.status, OPEN_STATUSES)));
  if (!exZ) {
    const assignee = await resolveAssignee({ factoryId: null, ruleCode: "termination_zus" });
    await createTask({
      kind: "task", title: `Виреєструвати з ZUS (ZWUA): ${worker.fullName}`, priority: "high", dueAt: addDaysStr(fireDate, 7), assigneeAdminId: assignee,
      workerId: worker.id, factoryId: worker.factoryId, source: "auto:termination_zus", sourceKey: zwuaKey,
      autoParams: { workerName: worker.fullName, fireDate, docTypeCode: "zus_zwua" },
      checklist: normalizeChecklist([{ id: "", text: "Подати ZUS ZWUA (Płatnik / PUE ZUS)", done: false }, { id: "", text: "Внести підтвердження ZWUA в профіль", done: false, auto: "entered" }]),
    }, actorAdminId);
  }

  // 1) документ про звільнення — лише коли є шаблон і підтверджена анкета
  const tpls = await db.select({ id: documentTemplatesTable.id }).from(documentTemplatesTable).where(and(eq(documentTemplatesTable.kind, TERMINATION_TEMPLATE_KIND), eq(documentTemplatesTable.isActive, true)));
  if (!tpls.length) return;
  const [q] = await db.select({ status: workerQuestionnairesTable.status }).from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, worker.id));
  if (q?.status !== "verified") { logger.info({ workerId: worker.id }, "termination doc skipped: questionnaire not verified"); return; }
  const docKey = `termdoc:${worker.id}:${fireDate}`;
  const [exD] = await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.sourceKey, docKey), inArray(tasksTable.status, OPEN_STATUSES)));
  if (exD) return;
  try {
    const { generateContract } = await import("./contracts");
    const contract = await generateContract({ workerId: worker.id, factoryId: worker.factoryId, templateIds: tpls.map(t => t.id), dateFrom: null, dateTo: fireDate });
    const assignee = await resolveAssignee({ factoryId: worker.factoryId, ruleCode: "termination_doc", useScheduler: true });
    await createTask({
      kind: "task", title: `Затвердити документ звільнення: ${worker.fullName}`, priority: "high", dueAt: addDaysStr(fireDate, 3), assigneeAdminId: assignee,
      workerId: worker.id, factoryId: worker.factoryId, contractId: contract.id, source: "auto:termination_doc", sourceKey: docKey,
      autoParams: { workerName: worker.fullName, fireDate, contractId: contract.id },
      checklist: normalizeChecklist([{ id: "", text: "Переглянути документ", done: false }, { id: "", text: "Затвердити й надіслати працівнику (email / Telegram)", done: false, auto: "sent" }]),
    }, actorAdminId);
  } catch (e: any) { logger.warn({ err: e?.message, workerId: worker.id }, "termination document generation failed"); }
}
