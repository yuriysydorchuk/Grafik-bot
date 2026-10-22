// Після підпису й відправки powiadomienia (етап 3): PDF потвердження (UPP/Wydruk) → документ
// powiadomienie_ua у профілі з даними з подачі — фірма-роботодавець, фабрика, від якої дати,
// скільки годин/міс. (attrs + читабельна назва), обовʼязок закривається, задача ступеня 2 синкається.
// Викликається з робота одразу після «Wyślij»; той самий шлях, що й ручне «Додати підтвердження».
// Подача з профілю (без задачі, 14.10.2026) кладе документ напряму — задачі ступеня 1/2 закриє синк.
import fs from "node:fs";
import path from "node:path";
import { db, tasksTable, workerDocumentsTable, type UaSubmission } from "@workspace/db";
import { eq } from "drizzle-orm";
import { WORKER_DOCS_DIR, makeStoredName } from "../../lib/uploads";
import { uaUploadConfirmation, uaInsertConfirmationDoc, syncUaNotificationTasks } from "../uaNotification";
import type { UaFormPayload } from "./payload";
import { setSubmission } from "./submissions";
import { logger } from "../../lib/logger";
import { applyNotificationHours, notifyFactoryOfDocument } from "../notifyHours";

export async function attachConfirmation(sub: UaSubmission, file: { absPath: string; fileName: string; mime: string }, submittedAt: string, confirmationNo: string | null, adminId: number): Promise<number | null> {
  const p = sub.payload as UaFormPayload | null;
  if (!p || !sub.workerId) return null;
  const stored = makeStoredName(file.fileName);
  fs.mkdirSync(WORKER_DOCS_DIR, { recursive: true });
  fs.copyFileSync(file.absPath, path.join(WORKER_DOCS_DIR, stored));
  const relPath = path.join("worker-documents", stored);
  const [task] = sub.taskId ? await db.select().from(tasksTable).where(eq(tasksTable.id, sub.taskId)) : [undefined];
  // людини (рядка людина×фірма) вже нема в задачі подачі — поки робот працював, графікова «вислала» її в ступінь 2
  // або синк прибрав. Подачу вже зроблено на порталі, тож документ кладемо напряму, а не падаємо на «не в списку».
  // Умова — дзеркало пошуку рядка в uaUploadConfirmation.
  const inTask = !!task && (((task.autoParams as { workers?: { id: number; companyId?: number | null }[] } | null)?.workers ?? [])
    .some(w => w.id === sub.workerId && (p.companyId == null || (w.companyId ?? null) === p.companyId)));
  let docId: number | null = null;
  if (task && inTask) {
    await uaUploadConfirmation(task, sub.workerId, { relPath, fileName: file.fileName, mime: file.mime }, submittedAt, { adminId }, p.companyId);
    const [d] = await db.select({ id: workerDocumentsTable.id }).from(workerDocumentsTable).where(eq(workerDocumentsTable.filePath, relPath));
    docId = d?.id ?? null;
  } else {
    docId = (await uaInsertConfirmationDoc(sub.workerId, { relPath, fileName: file.fileName, mime: file.mime }, submittedAt, { adminId }, p.companyId)).id;
    await syncUaNotificationTasks().catch(() => {});
  }
  if (docId) {
    const title = `Powiadomienie UA — ${p.companyName}${p.praca.infoDodatkowe ? ` · ${p.praca.infoDodatkowe.split(" — ")[0]}` : ""} · od ${p.praca.dataPodjecia} · ${p.praca.godzinMiesiac} h/mies.`;
    await db.update(workerDocumentsTable).set({
      title, number: confirmationNo, validFrom: p.praca.dataPodjecia,
      attrs: { source: "praca_gov_robot", submissionId: sub.id, companyId: p.companyId, companyName: p.companyName, factoryId: p.factoryId ?? null, factory: p.praca.infoDodatkowe.split(" — ")[0] || null,
        dateFrom: p.praca.dataPodjecia, dateFromActual: p.praca.dataPodjeciaFakt ?? p.praca.dataPodjecia, hoursPerMonth: Number(p.praca.godzinMiesiac) || null, hourlyRate: p.praca.stawkaGodz, position: p.praca.stanowisko, kzis: p.praca.zawodKod, confirmationNo },
    }).where(eq(workerDocumentsTable.id, docId));
    // години з повідомлення → профіль на фабрику подачі (якщо там нема ручного значення) + сводна
    try {
      const factoryId = p.factoryId ?? await notifyFactoryOfDocument(sub.workerId, { factory: p.praca.infoDodatkowe.split(" — ")[0] || null });
      await applyNotificationHours({ workerId: sub.workerId, factoryId, hours: Number(p.praca.godzinMiesiac) || null, documentId: docId, effectiveDate: p.praca.dataPodjeciaFakt ?? p.praca.dataPodjecia });
    } catch (e) { logger.warn({ err: String(e), workerId: sub.workerId }, "powiadomienie: hours → profile failed"); }
  }
  await setSubmission(sub.id, { documentId: docId, confirmationNo });
  return docId;
}
