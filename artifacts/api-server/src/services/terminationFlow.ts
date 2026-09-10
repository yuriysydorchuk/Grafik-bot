// Ланцюжок звільнення (08.09.2026): після fireWorker() —
//   1) документ при звільненні з шаблону kind='swiadectwo' (świadectwo pracy за pomocniczym
//      wzorem; міграція 2026-09-09-swiadectwo-template) → чернетка пакета (без підпису
//      працівника; анкета може бути непідтверджена — allowUnverified) → задача графіковій
//      «Затвердити документ звільнення» (правило termination_doc) з дією «Надіслати працівнику»
//      (email з анкети або Telegram — services/documentDelivery.ts);
//   2) задача «Виреєструвати з ZUS (ZWUA)» виконавцю правила termination_zus
//      (фолбек правила → головний), строк 7 днів від дати звільнення; закривається сама,
//      коли в профілі зʼявляється документ типу zus_zwua (нічний синк у taskAutoRules).
import { db, tasksTable, documentTemplatesTable, contractsTable, type Worker } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { addDaysStr } from "../lib/dates";
import { createTask, resolveAssignee, loadTaskSettings, OPEN_STATUSES } from "./tasks";
import { normalizeChecklist, dateStr } from "./taskUtils";
import { logger } from "../lib/logger";


export async function startTerminationFlow(worker: Worker, fireDate: string, actorAdminId: number | null, earlyContractIds: number[] = []): Promise<void> {
  // 2) ZUS ZWUA — завжди, крім звільнення датою ДО запуску модуля (settings.legacyBefore):
  //    таке заднім числом = історія, нічний скан (taskAutoRules) її теж не бере — інакше
  //    задача зʼявилась би тут і зникла наступної ночі
  const zwuaKey = `zwua:${worker.id}`;
  const legacyBefore = (await loadTaskSettings()).legacyBefore;
  const [exZ] = await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.sourceKey, zwuaKey), inArray(tasksTable.status, OPEN_STATUSES)));
  if (!exZ && !(legacyBefore && fireDate < legacyBefore)) {
    const assignee = await resolveAssignee({ factoryId: null, ruleCode: "termination_zus" });
    await createTask({
      kind: "task", title: `Виреєструвати з ZUS (ZWUA): ${worker.fullName}`, priority: "high", dueAt: addDaysStr(fireDate, 7), assigneeAdminId: assignee,
      workerId: worker.id, factoryId: worker.factoryId, source: "auto:termination_zus", sourceKey: zwuaKey,
      autoParams: { workerName: worker.fullName, fireDate, docTypeCode: "zus_zwua" },
      checklist: normalizeChecklist([{ id: "", text: "Подати ZUS ZWUA (Płatnik / PUE ZUS)", done: false }, { id: "", text: "Внести підтвердження ZWUA в профіль", done: false, auto: "entered" }]),
    }, actorAdminId);
  }

  // 1) документи звільнення (рішення власника 10.09.2026: świadectwo pracy НЕ видаємо):
  //    zaświadczenie o zatrudnieniu на кожну умову + wypowiedzenie (від працівника), якщо
  //    звільнення раніше кінця умови — services/contractEndDocs.ts
  try {
    const { issueTerminationDocs } = await import("./contractEndDocs");
    const r = await issueTerminationDocs(worker, fireDate, earlyContractIds, actorAdminId);
    if (r.zaswiadczenie || r.wypowiedzenie) logger.info({ workerId: worker.id, ...r }, "termination documents issued");
  } catch (e: any) { logger.warn({ err: e?.message, workerId: worker.id }, "termination documents failed"); }
}

// Дія задачі termination_doc: надіслати згенерований файл працівнику (email з анкети, інакше Telegram),
// журнал signature_events file_sent, статус пакета → sent (задача закриється нічним синком / одразу через auto-чекліст).
export async function deliverTerminationDoc(contractId: number, actor: { adminId: number; name?: string | null }): Promise<string> {
  const { contractFilesTable, signatureEventsTable } = await import("@workspace/db");
  const [c] = await db.select().from(contractsTable).where(eq(contractsTable.id, contractId));
  if (!c) throw new Error("Пакет не знайдено");
  const [file] = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, contractId)).orderBy(contractFilesTable.sortOrder).limit(1);
  const relPath = file?.signedPath ?? file?.unsignedPath;
  if (!file || !relPath) throw new Error("Файл документа не знайдено");
  const { deliveryTargets, deliverFile, readUploadFile } = await import("./documentDelivery");
  const buf = readUploadFile(relPath);
  if (!buf) throw new Error("Файл документа не знайдено на диску");
  const targets = await deliveryTargets(c.workerId);
  const via = targets?.email ? "email" : targets?.telegram ? "telegram" : null;
  if (!via) throw new Error("У працівника немає ні email в анкеті, ні Telegram — надішли файл вручну з профілю");
  const r = await deliverFile({ workerId: c.workerId, via, buffer: buf, fileName: `${file.title || "swiadectwo"}.pdf`, title: file.title || "Świadectwo pracy" });
  await db.insert(signatureEventsTable).values({
    contractId, event: "file_sent", docSha256: file.signedSha256 ?? file.unsignedSha256 ?? null,
    extra: { fileId: file.id, via, to: r.to, adminId: actor.adminId, signed: !!file.signedPath, source: "task" },
  }).catch(err => logger.warn({ err: String(err), contractId }, "file_sent event failed"));
  await db.update(contractsTable).set({ status: "sent", sentAt: new Date(), updatedAt: new Date() }).where(eq(contractsTable.id, contractId));
  return via === "email" ? `Надіслано на ${r.to}` : "Надіслано в Telegram";
}
