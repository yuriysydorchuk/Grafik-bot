// Журнал дій над документами працівника (дзеркало services/invoiceAudit.ts):
// «хто, коли, що зробив»; для updated — список полів old→new. Помилка запису
// журналу ніколи не валить основну операцію (best-effort). Рядки живуть без FK
// на документ — історія переживає видалення.
import { db, documentAuditTable, adminsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger";

export type DocumentAuditAction = "created" | "updated" | "file" | "verified" | "rejected" | "case" | "requested" | "deleted" | "sent";
export type DocumentAuditSource = "office" | "worker_bot" | "ocr" | "system";
export interface DocumentAuditChange { field: string; from?: unknown; to?: unknown }

export async function logDocumentAudit(
  doc: { id: number; workerId: number }, action: DocumentAuditAction,
  admin: { adminId?: number | null; name?: string | null; source?: DocumentAuditSource },
  changes?: DocumentAuditChange[] | null,
): Promise<void> {
  try {
    let name = admin.name ?? null;
    if (!name && admin.adminId) {
      const [a] = await db.select({ name: adminsTable.name }).from(adminsTable).where(eq(adminsTable.id, admin.adminId));
      name = a?.name ?? null;
    }
    await db.insert(documentAuditTable).values({
      documentId: doc.id, workerId: doc.workerId, action,
      changes: changes?.length ? changes : null,
      adminId: admin.adminId ?? null, adminName: name, source: admin.source ?? (admin.adminId ? "office" : "system"),
    });
  } catch (e) {
    logger.warn({ err: String(e), documentId: doc.id, action }, "document audit write failed");
  }
}

// службові поля — не дії людини, в історію не пишемо
const AUDIT_SKIP = new Set(["updatedAt", "expiryWarnedAt", "filePath", "fileMime"]);

export function documentAuditDiff(before: Record<string, any>, patch: Record<string, unknown>): DocumentAuditChange[] {
  const out: DocumentAuditChange[] = [];
  for (const [key, to] of Object.entries(patch)) {
    if (AUDIT_SKIP.has(key)) continue;
    const from = before[key];
    const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
    if (norm(from) === norm(to) || (from == null && to == null)) continue;
    out.push({ field: key, from: from ?? null, to: to ?? null });
  }
  return out;
}

export async function documentAuditRows(documentId: number) {
  return db.select().from(documentAuditTable)
    .where(eq(documentAuditTable.documentId, documentId))
    .orderBy(desc(documentAuditTable.id))
    .limit(200);
}
