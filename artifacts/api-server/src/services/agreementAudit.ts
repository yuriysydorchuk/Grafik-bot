// Журнал дій над умовами (/cost-invoices → «Умови») і їх місячними записами.
// Дзеркало services/invoiceAudit.ts — «хто, коли, що зробив», best-effort.
import { db, agreementAuditTable, adminsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger";

export type AgreementEntity = "condition" | "charge";
export type AgreementAuditAction = "created" | "updated" | "file" | "deleted";
export interface AgreementAuditChange { field: string; from?: unknown; to?: unknown }

export async function logAgreementAudit(
  entity: AgreementEntity, entityId: number, action: AgreementAuditAction,
  admin: { adminId?: number | null; name?: string | null },
  changes?: AgreementAuditChange[] | null,
): Promise<void> {
  try {
    let name = admin.name ?? null;
    if (!name && admin.adminId) {
      const [a] = await db.select({ name: adminsTable.name }).from(adminsTable).where(eq(adminsTable.id, admin.adminId));
      name = a?.name ?? null;
    }
    await db.insert(agreementAuditTable).values({
      entity, entityId, action,
      changes: changes?.length ? changes : null,
      adminId: admin.adminId ?? null, adminName: name,
    });
  } catch (e) {
    logger.warn({ err: String(e), entity, entityId, action }, "agreement audit write failed");
  }
}

// службові поля — не дії людини, в історію не пишемо
const AUDIT_SKIP = new Set(["driveFileId", "driveError", "grossAmount", "updatedAt"]);

export function agreementAuditDiff(before: Record<string, any>, patch: Record<string, unknown>): AgreementAuditChange[] {
  const out: AgreementAuditChange[] = [];
  for (const [key, to] of Object.entries(patch)) {
    if (AUDIT_SKIP.has(key)) continue;
    const from = before[key];
    if (from === to || (from == null && to == null)) continue;
    out.push({ field: key, from: from ?? null, to: to ?? null });
  }
  return out;
}

export async function agreementAuditRows(entity: AgreementEntity, entityId: number) {
  return db.select().from(agreementAuditTable)
    .where(and(eq(agreementAuditTable.entity, entity), eq(agreementAuditTable.entityId, entityId)))
    .orderBy(desc(agreementAuditTable.id))
    .limit(200);
}
