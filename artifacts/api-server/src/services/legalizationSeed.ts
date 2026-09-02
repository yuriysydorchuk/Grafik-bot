// Ідемпотентний сід каталогу легалізації в БД (для інтеграційних тестів після
// harness TRUNCATE і для dev-баз без накаченої міграції). Дані — legalizationCatalog.ts.
import { db, documentTypesTable, legalRulesTable } from "@workspace/db";
import { DOCUMENT_TYPE_SEED, LEGAL_RULE_SEED } from "./legalizationCatalog";

export { DOCUMENT_TYPE_SEED, LEGAL_RULE_SEED };

export async function seedLegalizationCatalog(): Promise<void> {
  await db.insert(documentTypesTable).values(DOCUMENT_TYPE_SEED.map(t => ({ ...t, isSystem: true }))).onConflictDoNothing({ target: documentTypesTable.code });
  await db.insert(legalRulesTable).values(LEGAL_RULE_SEED.map(r => ({
    code: r.code, kind: r.kind, axis: r.axis, conditions: r.conditions, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
    source: r.source, note: r.note, verifiedAt: r.verified ? new Date() : null,
  }))).onConflictDoNothing({ target: [legalRulesTable.code, legalRulesTable.effectiveFrom] });
}
