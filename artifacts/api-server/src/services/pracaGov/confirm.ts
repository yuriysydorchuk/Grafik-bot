// Після підпису й відправки powiadomienia (етап 3): PDF потвердження (UPP/Wydruk) → документ
// powiadomienie_ua у профілі з даними з подачі — фірма-роботодавець, фабрика, від якої дати,
// скільки годин/міс. (attrs + читабельна назва), обовʼязок закривається, задача ступеня 2 синкається.
// Викликається з робота одразу після «Wyślij»; той самий шлях, що й ручне «Додати підтвердження».
import fs from "node:fs";
import path from "node:path";
import { db, tasksTable, workerDocumentsTable, type UaSubmission } from "@workspace/db";
import { eq } from "drizzle-orm";
import { WORKER_DOCS_DIR, makeStoredName } from "../../lib/uploads";
import { uaUploadConfirmation } from "../uaNotification";
import type { UaFormPayload } from "./payload";
import { setSubmission } from "./submissions";

export async function attachConfirmation(sub: UaSubmission, file: { absPath: string; fileName: string; mime: string }, submittedAt: string, confirmationNo: string | null, adminId: number): Promise<number | null> {
  const p = sub.payload as UaFormPayload | null;
  if (!p || !sub.workerId) return null;
  const stored = makeStoredName(file.fileName);
  fs.mkdirSync(WORKER_DOCS_DIR, { recursive: true });
  fs.copyFileSync(file.absPath, path.join(WORKER_DOCS_DIR, stored));
  const [task] = sub.taskId ? await db.select().from(tasksTable).where(eq(tasksTable.id, sub.taskId)) : [undefined];
  let docId: number | null = null;
  if (task) {
    await uaUploadConfirmation(task, sub.workerId, { relPath: path.join("worker-documents", stored), fileName: file.fileName, mime: file.mime }, submittedAt, { adminId }, p.companyId);
    const [d] = await db.select({ id: workerDocumentsTable.id }).from(workerDocumentsTable).where(eq(workerDocumentsTable.filePath, path.join("worker-documents", stored)));
    docId = d?.id ?? null;
  }
  if (docId) {
    const title = `Powiadomienie UA — ${p.companyName}${p.praca.infoDodatkowe ? ` · ${p.praca.infoDodatkowe.split(" — ")[0]}` : ""} · od ${p.praca.dataPodjecia} · ${p.praca.godzinMiesiac} h/mies.`;
    await db.update(workerDocumentsTable).set({
      title, number: confirmationNo, validFrom: p.praca.dataPodjecia,
      attrs: { source: "praca_gov_robot", submissionId: sub.id, companyId: p.companyId, companyName: p.companyName, factory: p.praca.infoDodatkowe.split(" — ")[0] || null,
        dateFrom: p.praca.dataPodjecia, dateFromActual: p.praca.dataPodjeciaFakt ?? p.praca.dataPodjecia, hoursPerMonth: Number(p.praca.godzinMiesiac) || null, hourlyRate: p.praca.stawkaGodz, position: p.praca.stanowisko, kzis: p.praca.zawodKod, confirmationNo },
    }).where(eq(workerDocumentsTable.id, docId));
  }
  await setSubmission(sub.id, { documentId: docId, confirmationNo });
  return docId;
}
