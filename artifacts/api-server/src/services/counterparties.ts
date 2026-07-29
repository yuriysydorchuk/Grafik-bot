// Довідник контрагентів: сідинг із KSeF (NIP+назви), клієнтських прив'язок фабрик
// і витягів (IBAN-и), резолюція bank_transactions.counterparty_id та IBAN-и
// працівників (перекази на них = ЗП/аванси). Чисті хелпери внизу — під тестами
// (counterparties.test.ts); все, що з БД, — угорі.
import { db } from "@workspace/db";
import {
  counterpartiesTable, counterpartyAliasesTable, counterpartyAccountsTable,
  workerBankAccountsTable, companiesTable, factoriesTable, workersTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { T_OWNER_ANY } from "./bankClassify";

export interface CounterpartySyncResult {
  created: number; aliases: number; accounts: number;
  workerAccounts: number; resolved: number; recategorized: number;
}

// ── Чисті хелпери ──────────────────────────────────────────────────────────────

// Нормалізація назви для аліасів: upper, без діакритики, сквошнуті пробіли.
export function normAlias(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/Ą/g, "A").replace(/Ć/g, "C").replace(/Ę/g, "E").replace(/Ł/g, "L")
    .replace(/Ń/g, "N").replace(/Ó/g, "O").replace(/Ś/g, "S").replace(/[ŹŻ]/g, "Z")
    .replace(/\s+/g, " ")
    .trim();
}

export const normIban = (s: string | null | undefined): string => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// NIP-и з призначення платежу: беремо лише коли РІВНО один чужий NIP (свої фірмові
// NIP-и в титулах трапляються постійно — «Id płatnika», зайняття коморника тощо).
export function extractForeignNip(title: string | null | undefined, ownNips: Set<string>): string | null {
  const found = new Set<string>();
  for (const m of (title ?? "").matchAll(/(?:NIP|ID\s*P[ŁL]ATNIKA)[:/\s.]*?(\d{10})(?!\d)/gi)) {
    if (!ownNips.has(m[1]!)) found.add(m[1]!);
  }
  return found.size === 1 ? [...found][0]! : null;
}

// Матч контрагента-фізособи на працівника: всі токени імені (≥2 токени) присутні
// в назві контрагента. Повертає workerId лише при однозначному кандидаті.
export function matchWorkerByName(
  counterparty: string | null | undefined,
  workers: { id: number; fullName: string }[],
): number | null {
  const hayTokens = new Set(normAlias(counterparty).split(/[^A-Z0-9]+/).filter(Boolean));
  if (!hayTokens.size) return null;
  const hits: number[] = [];
  for (const w of workers) {
    const tokens = normAlias(w.fullName).split(/[^A-Z0-9]+/).filter(t => t.length > 1);
    if (tokens.length < 2) continue;
    if (tokens.every(t => hayTokens.has(t))) hits.push(w.id);
  }
  return hits.length === 1 ? hits[0]! : null;
}

// ── Сідинг ─────────────────────────────────────────────────────────────────────

const rowsOf = (r: any): any[] => r?.rows ?? r ?? [];

async function ownNipSet(): Promise<Set<string>> {
  const companies = await db.select({ nip: companiesTable.nip }).from(companiesTable);
  return new Set(companies.map(c => (c.nip ?? "").replace(/\D/g, "")).filter(n => n.length === 10));
}

// Upsert контрагента по NIP; повертає id. kind еволюціонує: client+supplier → both.
async function upsertByNip(nip: string, name: string, kind: "client" | "supplier"): Promise<number | null> {
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const [existing] = await db.select().from(counterpartiesTable).where(eq(counterpartiesTable.nip, nip));
  if (!existing) {
    const [row] = await db.insert(counterpartiesTable).values({ nip, name: clean, kind }).onConflictDoNothing().returning();
    if (!row) return null;
    await db.insert(counterpartyAliasesTable).values({ counterpartyId: row.id, alias: normAlias(clean) }).onConflictDoNothing();
    return row.id;
  }
  if (existing.kind !== kind && existing.kind !== "both" && (existing.kind === "client" || existing.kind === "supplier")) {
    await db.update(counterpartiesTable).set({ kind: "both" }).where(eq(counterpartiesTable.id, existing.id));
  }
  await db.insert(counterpartyAliasesTable).values({ counterpartyId: existing.id, alias: normAlias(clean) }).onConflictDoNothing();
  return existing.id;
}

export async function syncCounterparties(): Promise<CounterpartySyncResult> {
  const result: CounterpartySyncResult = { created: 0, aliases: 0, accounts: 0, workerAccounts: 0, resolved: 0, recategorized: 0 };
  const before = async (t: any) => Number(rowsOf(await db.execute(sql`SELECT count(*) AS n FROM ${t}`))[0]?.n ?? 0);
  const cpBefore = await before(counterpartiesTable);
  const alBefore = await before(counterpartyAliasesTable);
  const accBefore = await before(counterpartyAccountsTable);
  const ownNips = await ownNipSet();

  // 1) KSeF: покупці наших фактур = клієнти, продавці закупівельних = постачальники.
  //    Свої фірми (міжфірмові фактури) пропускаємо.
  const buyers = rowsOf(await db.execute(sql`
    SELECT DISTINCT buyer_nip AS nip, coalesce(client_label, buyer_name) AS name
    FROM ksef_invoices WHERE kind = 'sale' AND buyer_nip IS NOT NULL AND buyer_name IS NOT NULL`));
  for (const b of buyers) {
    const nip = String(b.nip).replace(/\D/g, "");
    if (nip.length !== 10 || ownNips.has(nip)) continue;
    await upsertByNip(nip, String(b.name), "client");
  }
  const sellers = rowsOf(await db.execute(sql`
    SELECT DISTINCT seller_nip AS nip, seller_name AS name
    FROM ksef_invoices WHERE kind = 'purchase' AND seller_nip IS NOT NULL AND seller_name IS NOT NULL`));
  for (const s of sellers) {
    const nip = String(s.nip).replace(/\D/g, "");
    if (nip.length !== 10 || ownNips.has(nip)) continue;
    await upsertByNip(nip, String(s.name), "supplier");
  }

  // 2) Клієнтські прив'язки фабрик: NIP + P&L-назва як канон для клієнта.
  const factories = await db.select({ nip: factoriesTable.clientNip, label: factoriesTable.pnlLabel }).from(factoriesTable);
  for (const f of factories) {
    const nip = (f.nip ?? "").replace(/\D/g, "");
    if (nip.length !== 10 || ownNips.has(nip)) continue;
    const id = await upsertByNip(nip, f.label ?? nip, "client");
    if (id && f.label) await db.update(counterpartiesTable).set({ name: f.label }).where(eq(counterpartiesTable.id, id));
  }

  // 3) IBAN-и + аліаси з переказів, уже зматчених із фактурами (paid_txn_id):
  //    продаж → рахунок платника належить покупцю; закупівля → отримувача — продавцю.
  const matched = rowsOf(await db.execute(sql`
    SELECT DISTINCT
      CASE WHEN i.kind = 'sale' THEN i.buyer_nip ELSE i.seller_nip END AS nip,
      t.counterparty_account AS iban, t.counterparty AS cp_name
    FROM ksef_invoices i JOIN bank_transactions t ON t.id = i.paid_txn_id
    WHERE i.paid_txn_id IS NOT NULL AND t.counterparty_account IS NOT NULL`));
  for (const m of matched) {
    const nip = String(m.nip ?? "").replace(/\D/g, "");
    const iban = normIban(m.iban);
    if (nip.length !== 10 || ownNips.has(nip) || iban.length < 15) continue;
    const [cp] = await db.select().from(counterpartiesTable).where(eq(counterpartiesTable.nip, nip));
    if (!cp) continue;
    await db.insert(counterpartyAccountsTable).values({ counterpartyId: cp.id, iban }).onConflictDoNothing();
    if (m.cp_name) await db.insert(counterpartyAliasesTable).values({ counterpartyId: cp.id, alias: normAlias(String(m.cp_name)) }).onConflictDoNothing();
  }

  // 4) IBAN-и з переказів, де в призначенні рівно один чужий NIP відомого контрагента.
  const nipTitled = rowsOf(await db.execute(sql`
    SELECT DISTINCT counterparty_account AS iban, counterparty AS cp_name, title
    FROM bank_transactions
    WHERE counterparty_account IS NOT NULL AND title ~* '(NIP|ID *P[ŁL]ATNIKA)'`));
  for (const r of nipTitled) {
    const nip = extractForeignNip(String(r.title ?? ""), ownNips);
    const iban = normIban(r.iban);
    if (!nip || iban.length < 15) continue;
    const [cp] = await db.select().from(counterpartiesTable).where(eq(counterpartiesTable.nip, nip));
    if (!cp) continue;
    await db.insert(counterpartyAccountsTable).values({ counterpartyId: cp.id, iban }).onConflictDoNothing();
    if (r.cp_name) await db.insert(counterpartyAliasesTable).values({ counterpartyId: cp.id, alias: normAlias(String(r.cp_name)) }).onConflictDoNothing();
  }

  result.created = (await before(counterpartiesTable)) - cpBefore;
  result.aliases = (await before(counterpartyAliasesTable)) - alBefore;
  result.accounts = (await before(counterpartyAccountsTable)) - accBefore;

  result.workerAccounts = await seedWorkerAccounts();
  const res = await resolveBankCounterparties();
  result.resolved = res.resolved;
  result.recategorized = res.recategorized;
  logger.info(result, "counterparties sync done");
  return result;
}

// ── IBAN-и працівників ─────────────────────────────────────────────────────────
// Сідинг: вихідні ЗП/авансові перекази (за текстом призначення) з рахунком
// отримувача → строгий матч імені на працівника → прив'язка IBAN (source=auto).
async function seedWorkerAccounts(): Promise<number> {
  const workers = await db.select({ id: workersTable.id, fullName: workersTable.fullName }).from(workersTable);
  const candidates = rowsOf(await db.execute(sql`
    SELECT DISTINCT counterparty_account AS iban, counterparty AS cp
    FROM bank_transactions
    WHERE direction = 'out' AND counterparty_account IS NOT NULL AND counterparty IS NOT NULL
      AND title ~* '(WYNAGRODZ|ZALICZK|RACHUNEK.*UMOW)'
      AND NOT (${sql.raw(T_OWNER_ANY)})`));
  let added = 0;
  for (const c of candidates) {
    const iban = normIban(c.iban);
    if (iban.length < 15) continue;
    const workerId = matchWorkerByName(String(c.cp), workers);
    if (!workerId) continue;
    const ins = await db.insert(workerBankAccountsTable).values({ workerId, iban, source: "auto" }).onConflictDoNothing().returning({ id: workerBankAccountsTable.id });
    added += ins.length;
  }
  return added;
}

// ── Резолюція транзакцій ───────────────────────────────────────────────────────
// Інкрементальна (лише counterparty_id IS NULL): IBAN → NIP у призначенні → аліас.
// Плюс перекази на IBAN-и працівників без категорії → salary/zaliczki.
export async function resolveBankCounterparties(): Promise<{ resolved: number; recategorized: number }> {
  let resolved = 0;
  const run = async (q: any) => { const r: any = await db.execute(q); resolved += Number(r?.rowCount ?? 0); };

  await run(sql`
    UPDATE bank_transactions t SET counterparty_id = ca.counterparty_id
    FROM counterparty_accounts ca
    WHERE t.counterparty_id IS NULL AND t.counterparty_account IS NOT NULL
      AND upper(replace(t.counterparty_account, ' ', '')) = ca.iban`);

  await run(sql`
    UPDATE bank_transactions t SET counterparty_id = a.counterparty_id
    FROM counterparty_aliases a
    WHERE t.counterparty_id IS NULL AND t.counterparty IS NOT NULL
      AND upper(regexp_replace(translate(t.counterparty, 'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ', 'acelnoszzACELNOSZZ'), '\\s+', ' ', 'g')) = a.alias`);

  // NIP у призначенні — по одному чужому NIP на титул (TS-фільтр extractForeignNip)
  const ownNips = await ownNipSet();
  const nipRows = rowsOf(await db.execute(sql`
    SELECT id, title FROM bank_transactions
    WHERE counterparty_id IS NULL AND title ~* '(NIP|ID *P[ŁL]ATNIKA)'`));
  const byNip = new Map<string, number>();
  for (const cp of await db.select({ id: counterpartiesTable.id, nip: counterpartiesTable.nip }).from(counterpartiesTable)) {
    if (cp.nip) byNip.set(cp.nip, cp.id);
  }
  const updates = nipRows
    .map(r => ({ id: Number(r.id), cpId: byNip.get(extractForeignNip(String(r.title ?? ""), ownNips) ?? "") }))
    .filter(u => u.cpId);
  for (const u of updates) {
    await db.execute(sql`UPDATE bank_transactions SET counterparty_id = ${u.cpId} WHERE id = ${u.id} AND counterparty_id IS NULL`);
    resolved++;
  }

  // ЗП/аванси по IBAN-у працівника (тільки некатегоризовані, власників не чіпаємо)
  const rec: any = await db.execute(sql`
    UPDATE bank_transactions t
    SET manual_category = CASE WHEN t.title ~* 'ZALICZK' THEN 'zaliczki' ELSE 'salary' END
    FROM worker_bank_accounts w
    WHERE t.direction = 'out' AND t.manual_category IS NULL
      AND t.counterparty_account IS NOT NULL
      AND upper(replace(t.counterparty_account, ' ', '')) = w.iban
      AND NOT (${sql.raw(T_OWNER_ANY)})`);
  return { resolved, recategorized: Number(rec?.rowCount ?? 0) };
}
