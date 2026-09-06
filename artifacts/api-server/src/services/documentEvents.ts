// Події документів/профілю → журнал document_audit + перерахунок кешу worker_legality.
// Єдина точка, яку викликають усі мутації документів (admin-api, legalization,
// бот-аплоуд) і зміни профілю, що впливають на легальність. Best-effort: помилка
// тут ніколи не валить основну операцію. Пише document_audit, worker_legality і (при зміні
// ефективного статусу виплат) запис у worker_changes на ревʼю офісу — НЕ workers.legal_status.
import { logDocumentAudit, type DocumentAuditAction, type DocumentAuditChange, type DocumentAuditSource } from "./documentAudit";
import { recomputeWorkerLegality } from "./legalityRecompute";
import { logger } from "../lib/logger";

export async function documentChanged(
  doc: { id: number; workerId: number }, action: DocumentAuditAction,
  actor: { adminId?: number | null; name?: string | null; source?: DocumentAuditSource },
  changes?: DocumentAuditChange[] | null,
): Promise<void> {
  await logDocumentAudit(doc, action, actor, changes);
  await workerLegalityChanged(doc.workerId);
}

// Поля профілю, від яких залежить результат движка (nationality/company/дати/легасі-статус).
export const LEGALITY_PROFILE_FIELDS = ["nationality", "companyId", "birthDate", "employmentStartDate", "legalStatus", "isStudent", "notifyHours", "isActive", "factoryId", "positionId"] as const;

export async function workerLegalityChanged(workerId: number): Promise<void> {
  try { await recomputeWorkerLegality(workerId); }
  catch (e) { logger.warn({ err: String(e), workerId }, "legality recompute after change failed"); }
}
