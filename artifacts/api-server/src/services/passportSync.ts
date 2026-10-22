// Новий паспорт підтверджено офісом → чи оновити анкету (22.10.2026, кейс Koshmak Kira: при
// реєстрації паспорта при собі не було — завантажила випадкову картинку з вигаданими даними, анкету
// підтвердили; новий паспорт прийшов на запит офісу, але анкета лишилась зі старим номером → у
// Powiadomienie пішов чужий номер). Сама анкета автоматично НЕ змінюється — офіс вирішує в модалці
// після підтвердження документа; зміна йде в історію анкети (journalQuestionnaire, q.*).
import { eq } from "drizzle-orm";
import { db, workerDocumentsTable, documentTypesTable, workerQuestionnairesTable } from "@workspace/db";
import { journalQuestionnaire } from "./questionnaireJournal";

export type PassportDiffField = "passportNumber" | "passportIssuedAt" | "passportExpiresAt";
export interface PassportDiff { workerId: number; documentId: number; rows: { field: PassportDiffField; questionnaire: string | null; document: string }[] }

const DOC_TO_Q: [keyof typeof workerDocumentsTable.$inferSelect, PassportDiffField][] = [
  ["number", "passportNumber"], ["issuedAt", "passportIssuedAt"], ["expiresAt", "passportExpiresAt"],
];
const norm = (f: PassportDiffField, v: unknown) => {
  const s = v == null ? "" : String(v).trim();
  return f === "passportNumber" ? s.replace(/[\s-]/g, "").toUpperCase() : s;
};

// Розбіжності паспорта-документа з анкетою: лише поля, заповнені в документі. null — не паспорт
// або все збігається.
export async function passportQuestionnaireDiff(documentId: number): Promise<PassportDiff | null> {
  const [doc] = await db.select({ d: workerDocumentsTable, code: documentTypesTable.code }).from(workerDocumentsTable)
    .innerJoin(documentTypesTable, eq(documentTypesTable.id, workerDocumentsTable.docTypeId))
    .where(eq(workerDocumentsTable.id, documentId));
  if (!doc || doc.code !== "passport") return null;
  const [q] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, doc.d.workerId));
  const rows: PassportDiff["rows"] = [];
  for (const [dk, qk] of DOC_TO_Q) {
    const dv = doc.d[dk];
    if (dv == null || String(dv).trim() === "") continue;
    if (norm(qk, dv) !== norm(qk, q?.[qk])) rows.push({ field: qk, questionnaire: q?.[qk] == null ? null : String(q[qk]), document: String(dv).trim() });
  }
  return rows.length ? { workerId: doc.d.workerId, documentId, rows } : null;
}

// Переносить дані паспорта-документа в анкету (лише розбіжні поля) + історія анкети від імені адміна.
export async function applyPassportToQuestionnaire(documentId: number, adminId: number | null): Promise<{ changed: PassportDiffField[] }> {
  // лише з ПІДТВЕРДЖЕНОГО паспорта: модалка могла лишитись відкритою, поки документ відхилили
  const [d] = await db.select({ status: workerDocumentsTable.status, verifiedAt: workerDocumentsTable.verifiedAt }).from(workerDocumentsTable).where(eq(workerDocumentsTable.id, documentId));
  if (!d || d.status !== "present" || !d.verifiedAt) throw new Error("Паспорт не підтверджено — анкету з нього не оновлюємо");
  const diff = await passportQuestionnaireDiff(documentId);
  if (!diff) return { changed: [] };
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const r of diff.rows) patch[r.field] = r.document;
  const [before] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, diff.workerId));
  if (before) await db.update(workerQuestionnairesTable).set(patch).where(eq(workerQuestionnairesTable.workerId, diff.workerId));
  else await db.insert(workerQuestionnairesTable).values({ workerId: diff.workerId, ...patch });
  await journalQuestionnaire(diff.workerId, before, patch, adminId);
  return { changed: diff.rows.map(r => r.field) };
}
