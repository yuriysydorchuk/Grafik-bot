// Чорний список (рішення власника 21.09.2026): workers.do_not_hire + причина. Людина
// лишається в базі зі своєю історією, але показується окремою вкладкою «Чорний список»
// і не повертається на роботу без явного підтвердження власника (restoreWorker force).
// Кандидат з таким самим імʼям або телефоном — попередження 409 при створенні.
import { db, workersTable, workerQuestionnairesTable, candidatesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { matchWorker, normalizeName } from "../bot/workerMatch";
import { normalizePhone } from "../lib/questionnaireRules";

export type BlacklistHit = { id: number; fullName: string; reason: string | null; by: "name" | "phone" | "pesel" };

export async function findBlacklisted(input: { fullName?: string | null; phone?: string | null; pesel?: string | null }): Promise<BlacklistHit | null> {
  const rows = await db.select({ id: workersTable.id, fullName: workersTable.fullName, workerCode: workersTable.workerCode, pesel: workersTable.pesel, reason: workersTable.doNotHireReason, isActive: workersTable.isActive })
    .from(workersTable).where(eq(workersTable.doNotHire, true));
  if (!rows.length) return null;
  const pesel = (input.pesel ?? "").replace(/\D/g, "");
  if (pesel) { const hit = rows.find(r => r.pesel === pesel); if (hit) return { id: hit.id, fullName: hit.fullName, reason: hit.reason, by: "pesel" }; }
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (phone) {
    // телефон живе в анкеті АБО в картці кандидата, з якої людина прийшла (профіль читає обидва)
    const ids = rows.map(r => r.id);
    const q = await db.select({ workerId: workerQuestionnairesTable.workerId, phone: workerQuestionnairesTable.phone }).from(workerQuestionnairesTable).where(inArray(workerQuestionnairesTable.workerId, ids));
    const c = await db.select({ workerId: candidatesTable.workerId, phone: candidatesTable.phone }).from(candidatesTable).where(inArray(candidatesTable.workerId, ids));
    const digits = (s: string | null) => (s ?? "").replace(/\D/g, "").slice(-9);
    const hit = [...q, ...c].find(x => x.workerId != null && digits(x.phone) === digits(phone));
    if (hit) { const r = rows.find(r => r.id === hit.workerId)!; return { id: r.id, fullName: r.fullName, reason: r.reason, by: "phone" }; }
  }
  if (input.fullName?.trim()) {
    // той самий матчер, що й для введених вручну імен у боті (транслітерація, порядок слів);
    // плюс точний збіг нормалізованого імені — matchWorker не «впевнений», коли поруч
    // схоже прізвище (Kowalski/Kowalska), а для чорного списку точний збіг має спрацювати
    const m = matchWorker(input.fullName, rows);
    if (m.confident) return { id: m.confident.id, fullName: m.confident.fullName, reason: m.confident.reason, by: "name" };
    const key = (s: string) => normalizeName(s).split(" ").filter(Boolean).sort().join(" ");
    const exact = rows.find(r => key(r.fullName) === key(input.fullName!));
    if (exact) return { id: exact.id, fullName: exact.fullName, reason: exact.reason, by: "name" };
  }
  return null;
}
