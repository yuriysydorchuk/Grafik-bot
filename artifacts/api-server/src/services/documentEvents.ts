// Події документів/профілю → журнал document_audit + перерахунок кешу worker_legality.
// Єдина точка, яку викликають усі мутації документів (admin-api, legalization,
// бот-аплоуд) і зміни профілю, що впливають на легальність. Best-effort: помилка
// тут ніколи не валить основну операцію. Пише document_audit, worker_legality і (при зміні
// ефективного статусу виплат) запис у worker_changes на ревʼю офісу — НЕ workers.legal_status.
import { logDocumentAudit, type DocumentAuditAction, type DocumentAuditChange, type DocumentAuditSource } from "./documentAudit";
import { recomputeWorkerLegality } from "./legalityRecompute";
import { logger } from "../lib/logger";
import { db, workersTable, workerDocumentsTable, documentTypesTable } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { peselChecksumOk } from "../lib/questionnaireRules";

export async function documentChanged(
  doc: { id: number; workerId: number }, action: DocumentAuditAction,
  actor: { adminId?: number | null; name?: string | null; source?: DocumentAuditSource },
  changes?: DocumentAuditChange[] | null,
): Promise<void> {
  await logDocumentAudit(doc, action, actor, changes);
  await workerLegalityChanged(doc.workerId);
  // внесено ZWUA → задача виреєстрування закривається одразу, не нічним прогоном
  if (action !== "deleted") {
    try { await (await import("./taskAutoRules")).resolveZwuaTasksNow(doc.workerId); }
    catch (e) { logger.warn({ err: String(e), workerId: doc.workerId }, "zwua task resolve after doc change failed"); }
    // внесено ZUA → задача зголошення нового працівника закривається одразу
    try { await (await import("./hireRegistration")).resolveHireTasksNow(doc.workerId); }
    catch (e) { logger.warn({ err: String(e), workerId: doc.workerId }, "hire task resolve after doc change failed"); }
    try { await peselToProfile(doc.id, doc.workerId); }
    catch (e) { logger.warn({ err: String(e), workerId: doc.workerId }, "pesel from document failed"); }
  }
}

// Документ типу «PESEL» з номером (15.10.2026, рішення власника) → workers.pesel, лише якщо в профілі
// порожньо і номер проходить контрольну суму; наявний PESEL профілю не перезаписується.
async function peselToProfile(docId: number, workerId: number): Promise<void> {
  const [r] = await db.select({ number: workerDocumentsTable.number, code: documentTypesTable.code })
    .from(workerDocumentsTable).leftJoin(documentTypesTable, eq(workerDocumentsTable.docTypeId, documentTypesTable.id))
    .where(eq(workerDocumentsTable.id, docId));
  const pesel = (r?.number ?? "").replace(/\s+/g, "");
  if (r?.code !== "pesel" || !peselChecksumOk(pesel)) return;
  const set = await db.update(workersTable).set({ pesel })
    .where(and(eq(workersTable.id, workerId), or(isNull(workersTable.pesel), eq(workersTable.pesel, ""))))
    .returning({ id: workersTable.id });
  if (set.length) logger.info({ workerId, docId }, "pesel set from document");
}

// Поля профілю, від яких залежить результат движка (nationality/company/дати/легасі-статус).
export const LEGALITY_PROFILE_FIELDS = ["nationality", "companyId", "birthDate", "employmentStartDate", "firstWorkDate", "legalStatus", "isStudent", "notifyHours", "isActive", "factoryId", "positionId"] as const;

export async function workerLegalityChanged(workerId: number): Promise<void> {
  try { await recomputeWorkerLegality(workerId); }
  catch (e) { logger.warn({ err: String(e), workerId }, "legality recompute after change failed"); }
}
