// Анкета працівника → профіль (рішення власника 20.09.2026: «дані анкети звʼязувати з даними
// профілю»). Що вже синхронне: PESEL, дата народження, стать, громадянство (скан паспорта /
// PUT анкети), імʼя-прізвище. Тут — решта: банківський рахунок з анкети стає рахунком профілю
// (worker_bank_accounts, основний, якщо основного ще нема) — саме ці рахунки матчить банк
// у витягах і сводна для konto. Телефон живе лише в анкеті (у workers колонки немає) —
// профіль читає його звідти напряму (GET /workers/:id phone).
import { db, workerQuestionnairesTable, workerBankAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger";

// Як у POST /workers/:id/bank-accounts: великі літери, лише A-Z0-9; польський NRB зберігаємо
// без «PL» (так лежать auto-рядки з витягів), інші країни — з кодом.
export function normalizeIban(raw: string | null | undefined): string | null {
  const s = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length < 15) return null;
  return /^PL\d{26}$/.test(s) ? s.slice(2) : s;
}

export async function ensureWorkerBankAccount(workerId: number, rawIban: string | null | undefined, source: string): Promise<"added" | "exists" | "foreign" | "skip"> {
  const iban = normalizeIban(rawIban);
  if (!iban) return "skip";
  const [ex] = await db.select({ workerId: workerBankAccountsTable.workerId }).from(workerBankAccountsTable).where(eq(workerBankAccountsTable.iban, iban));
  if (ex) {
    if (ex.workerId !== workerId) { logger.warn({ workerId, ownerId: ex.workerId }, "questionnaire IBAN belongs to another worker — not linked"); return "foreign"; }
    return "exists";
  }
  const [hasPrimary] = await db.select({ id: workerBankAccountsTable.id }).from(workerBankAccountsTable)
    .where(and(eq(workerBankAccountsTable.workerId, workerId), eq(workerBankAccountsTable.isPrimary, true))).limit(1);
  await db.insert(workerBankAccountsTable).values({ workerId, iban, source, isPrimary: !hasPrimary });
  return "added";
}

// Викликати після кожного збереження анкети (працівник за лінком, офіс у панелі).
export async function syncQuestionnaireToProfile(workerId: number): Promise<void> {
  const [q] = await db.select({ bankIban: workerQuestionnairesTable.bankIban }).from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  if (!q) return;
  try { await ensureWorkerBankAccount(workerId, q.bankIban, "questionnaire"); }
  catch (e: any) { logger.warn({ err: e?.message, workerId }, "questionnaire → bank account sync failed"); }
}
