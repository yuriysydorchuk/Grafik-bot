// Журнал змін фактур: пишеться з /cost-invoices, /ksef і бот-сканера.
// Кожен запис — «хто, коли, що зробив»; для updated — список полів old→new.
// Помилка запису журналу ніколи не валить основну операцію (best-effort).
import { db, invoiceAuditTable, adminsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger";

export type AuditOrigin = "ksef" | "local";
export type AuditAction = "created" | "updated" | "file" | "deleted";
export interface AuditChange { field: string; from?: unknown; to?: unknown }

export async function logInvoiceAudit(
  origin: AuditOrigin, invoiceId: number, action: AuditAction,
  admin: { adminId?: number | null; name?: string | null },
  changes?: AuditChange[] | null,
): Promise<void> {
  try {
    let name = admin.name ?? null;
    if (!name && admin.adminId) {
      const [a] = await db.select({ name: adminsTable.name }).from(adminsTable).where(eq(adminsTable.id, admin.adminId));
      name = a?.name ?? null;
    }
    await db.insert(invoiceAuditTable).values({
      origin, invoiceId, action,
      changes: changes?.length ? changes : null,
      adminId: admin.adminId ?? null, adminName: name,
    });
  } catch (e) {
    logger.warn({ err: String(e), origin, invoiceId, action }, "invoice audit write failed");
  }
}

// Дифф для action='updated': порівнює патч із рядком ДО оновлення; службові
// поля (drive_*, periodMonth тощо) в історію не пишемо — то не дії людини.
const AUDIT_SKIP = new Set([
  "driveFileId", "drivePdfId", "driveError", "driveSyncedAt", "xmlPath",
  "periodMonth", "statusRaw", "sortIdx", "tabName", "paymentMethodXml",
]);

export function auditDiff(before: Record<string, any>, patch: Record<string, unknown>): AuditChange[] {
  const out: AuditChange[] = [];
  for (const [key, to] of Object.entries(patch)) {
    if (AUDIT_SKIP.has(key)) continue;
    const from = before[key];
    if (from === to || (from == null && to == null)) continue;
    out.push({ field: key, from: from ?? null, to: to ?? null });
  }
  return out;
}

export async function invoiceAuditRows(origin: AuditOrigin, invoiceId: number) {
  return db.select().from(invoiceAuditTable)
    .where(and(eq(invoiceAuditTable.origin, origin), eq(invoiceAuditTable.invoiceId, invoiceId)))
    .orderBy(desc(invoiceAuditTable.id))
    .limit(200);
}
