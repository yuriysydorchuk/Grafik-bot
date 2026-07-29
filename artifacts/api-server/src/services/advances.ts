// Авто-помітка затверджених авансів «виплачено» по факту банківського переказу.
// Строгі правила (жодного матчингу «по сумі» без ідентичності): переказ мусить
// належати саме цьому працівнику (його IBAN з worker_bank_accounts АБО повне ім'я
// в контрагенті), сума — точна (±2 гроші), дата — після затвердження, і це не
// зарплатний переказ (WYNAGRODZ). Непевні випадки не чіпаємо — ручна кнопка.
import { db, advanceRequestsTable, workersTable, workerBankAccountsTable } from "@workspace/db";
import { and, eq, asc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { T_OWNER_ANY } from "./bankClassify";
import { matchWorkerByName, normIban } from "./counterparties";

const rowsOf = (r: any): any[] => r?.rows ?? r ?? [];
const fmtPln = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function autoMarkPaidAdvances(): Promise<string[]> {
  const advances = await db.select({
    id: advanceRequestsTable.id,
    workerId: advanceRequestsTable.workerId,
    amount: advanceRequestsTable.amount,
    decidedAt: advanceRequestsTable.decidedAt,
    createdAt: advanceRequestsTable.createdAt,
    fullName: workersTable.fullName,
  }).from(advanceRequestsTable)
    .innerJoin(workersTable, eq(advanceRequestsTable.workerId, workersTable.id))
    .where(eq(advanceRequestsTable.status, "approved"))
    .orderBy(asc(advanceRequestsTable.createdAt));
  if (!advances.length) return [];

  // кандидатні перекази: вихідні, не власникам, не зарплатні, ще не привʼязані
  const txns = rowsOf(await db.execute(sql`
    SELECT id, value_date, amount, counterparty, counterparty_account
    FROM bank_transactions t
    WHERE direction = 'out'
      AND value_date >= (now() - interval '60 days')::date
      AND coalesce(title, '') !~* 'WYNAGRODZ'
      AND NOT (${sql.raw(T_OWNER_ANY)})
      AND NOT EXISTS (SELECT 1 FROM advance_requests ar WHERE ar.paid_txn_id = t.id)
    ORDER BY value_date ASC, id ASC`));
  if (!txns.length) return [];

  const ibanToWorker = new Map<string, number>();
  for (const w of await db.select().from(workerBankAccountsTable)) ibanToWorker.set(w.iban, w.workerId);
  const workers = await db.select({ id: workersTable.id, fullName: workersTable.fullName }).from(workersTable);

  const alerts: string[] = [];
  const used = new Set<number>();
  for (const adv of advances) {
    const decidedDate = (adv.decidedAt ?? adv.createdAt).toISOString().slice(0, 10);
    const candidate = txns.find(t => {
      if (used.has(Number(t.id))) return false;
      if (Math.abs(Number(t.amount) - adv.amount) > 0.02) return false;
      if (String(t.value_date) < decidedDate) return false;
      const byIban = ibanToWorker.get(normIban(String(t.counterparty_account ?? "")));
      if (byIban != null) return byIban === adv.workerId;
      return matchWorkerByName(String(t.counterparty ?? ""), workers) === adv.workerId;
    });
    if (!candidate) continue;
    const [updated] = await db.update(advanceRequestsTable)
      .set({ status: "paid", paidAt: new Date(`${candidate.value_date}T12:00:00Z`), paidTxnId: Number(candidate.id) })
      .where(and(eq(advanceRequestsTable.id, adv.id), eq(advanceRequestsTable.status, "approved")))
      .returning({ id: advanceRequestsTable.id });
    if (!updated) continue;
    used.add(Number(candidate.id));
    import("../bot/notify").then(m => m.notifyWorkerAdvance(adv.workerId, "paid", adv.amount, null))
      .catch(err => logger.error({ err }, "notifyWorkerAdvance (auto) failed"));
    alerts.push(`💸 Аванс ${adv.fullName} — ${fmtPln(adv.amount)} zł: знайшов переказ від ${candidate.value_date}, позначив виплаченим`);
    logger.info({ advanceId: adv.id, txnId: candidate.id }, "advance auto-marked paid");
  }
  return alerts;
}
