// Open banking sync (Enable Banking PSD2 API) — the operational layer of the bank
// module. Pulls transactions and balances for every active consent into
// bank_transactions with source='api'; the MT940 import stays the source of truth
// and supersedes API rows for the periods it covers (see bankStatements.ts).
// The pure mapping/hashing layer lives in enableBanking.ts (unit-tested).
import fs from "node:fs";
import crypto from "node:crypto";
import { db, bankApiConsentsTable, bankApiAccountsTable, bankTransactionsTable, companiesTable } from "@workspace/db";
import { and, eq, isNull, sql, ne } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  ebJwt, mapApiTxn, apiDedupHashes, matchHolderCompany, isInternalTransfer, isKomornik,
  normAccount, type ApiTransaction, type MappedTxn,
} from "./enableBanking";

const API = "https://api.enablebanking.com";
// Redirect must EXACTLY match one registered in the Enable Banking Control Panel.
const REDIRECT_URL = process.env.ENABLE_BANKING_REDIRECT_URL || "https://161.97.117.151.sslip.io/api/bank/psd2-callback";
const BACKFILL_DAYS = Number(process.env.BANK_API_BACKFILL_DAYS) || 30;
const ALERT_IN_MIN = Number(process.env.BANK_API_ALERT_IN_MIN) || 2000;   // вхідні ≥ цієї суми — алерт власнику
const LOW_BALANCE_PLN = Number(process.env.BANK_API_LOW_BALANCE_PLN) || 10000;

export const ebConfigured = (): boolean => !!(process.env.ENABLE_BANKING_APP_ID && process.env.ENABLE_BANKING_KEY_FILE);

async function ebFetch(method: string, path: string, payload?: unknown): Promise<any> {
  const appId = process.env.ENABLE_BANKING_APP_ID;
  const keyFile = process.env.ENABLE_BANKING_KEY_FILE;
  if (!appId || !keyFile) throw new Error("Enable Banking не налаштований (ENABLE_BANKING_APP_ID / ENABLE_BANKING_KEY_FILE)");
  const jwt = ebJwt(appId, fs.readFileSync(keyFile, "utf8"));
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err: any = new Error(`Enable Banking ${method} ${path.split("?")[0]} → ${res.status}: ${data?.message ?? data?.detail ?? text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── Authorization flow ─────────────────────────────────────────────────────────
export async function listAspsps(country: string): Promise<{ name: string; country: string }[]> {
  const data = await ebFetch("GET", `/aspsps?country=${encodeURIComponent(country)}`);
  return (data.aspsps ?? []).map((a: any) => ({ name: a.name, country: a.country }));
}

export async function startAuth(aspspName: string, aspspCountry: string): Promise<{ url: string }> {
  const state = crypto.randomUUID();
  const validUntil = new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString();
  const data = await ebFetch("POST", "/auth", {
    access: { valid_until: validUntil },
    aspsp: { name: aspspName, country: aspspCountry },
    state,
    redirect_url: REDIRECT_URL,
    psu_type: "business",
  });
  return { url: data.url };
}

// Redirect back from the bank: exchange the code for a session and store it.
export async function completeAuth(code: string): Promise<{ consentId: number; accounts: number }> {
  const session = await ebFetch("POST", "/sessions", { code });
  return storeSession(session.session_id, session);
}

// Import an already-created session by id (used to seed the sessions authorized
// with the scratch probe before this module existed).
export async function importSession(sessionId: string): Promise<{ consentId: number; accounts: number }> {
  const session = await ebFetch("GET", `/sessions/${sessionId}`);
  return storeSession(sessionId, session);
}

async function storeSession(sessionId: string, session: any): Promise<{ consentId: number; accounts: number }> {
  const aspspName: string = session.aspsp?.name ?? "?";
  const aspspCountry: string = session.aspsp?.country ?? "PL";
  const validUntil = new Date(session.access?.valid_until ?? Date.now() + 180 * 24 * 3600 * 1000);
  // POST /sessions віддає рахунки обʼєктами, GET /sessions/{id} — масивом uid-рядків;
  // для рядків дотягуємо деталі окремим запитом.
  const accounts: any[] = [];
  for (const a of (session.accounts ?? []) as any[]) {
    if (typeof a === "string") {
      try { accounts.push({ ...(await ebFetch("GET", `/accounts/${a}/details`)), uid: a }); }
      catch (e: any) { logger.warn({ uid: a, err: e?.message }, "account details fetch failed"); accounts.push({ uid: a }); }
    } else accounts.push(a);
  }

  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name, legalName: companiesTable.legalName }).from(companiesTable);
  const accCompany = (holder: string | null) => matchHolderCompany(holder, companies);
  // юрособа згоди = юрособа рахунків (логін у банку завжди однієї фірми)
  const consentCompanyId = accounts.map(a => accCompany(a.name ?? null)).find(id => id != null) ?? null;

  const [consent] = await db.insert(bankApiConsentsTable)
    .values({ sessionId, aspspName, aspspCountry, companyId: consentCompanyId, validUntil })
    .onConflictDoUpdate({ target: bankApiConsentsTable.sessionId, set: { validUntil, revokedAt: null, companyId: consentCompanyId } })
    .returning();
  await db.delete(bankApiAccountsTable).where(eq(bankApiAccountsTable.consentId, consent!.id));
  if (accounts.length) {
    await db.insert(bankApiAccountsTable).values(accounts.map(a => ({
      consentId: consent!.id,
      uid: String(a.uid),
      iban: a.account_id?.iban ?? null,
      holderName: a.name ?? null,
      product: a.product ?? null,
      currency: a.currency ?? null,
      companyId: accCompany(a.name ?? null),
    })));
  }
  // поновлення: старі згоди того самого банку+юрособи відкликаємо (сесія замінена)
  if (consentCompanyId != null) {
    await db.update(bankApiConsentsTable)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(bankApiConsentsTable.aspspName, aspspName),
        eq(bankApiConsentsTable.companyId, consentCompanyId),
        ne(bankApiConsentsTable.id, consent!.id),
        isNull(bankApiConsentsTable.revokedAt),
      ));
  }
  logger.info({ aspspName, accounts: accounts.length, companyId: consentCompanyId }, "bank api consent stored");
  return { consentId: consent!.id, accounts: accounts.length };
}

export async function revokeConsent(id: number): Promise<void> {
  const [row] = await db.select().from(bankApiConsentsTable).where(eq(bankApiConsentsTable.id, id));
  if (!row) throw new Error("Згоду не знайдено");
  try { await ebFetch("DELETE", `/sessions/${row.sessionId}`); } catch (e: any) { logger.warn({ err: e?.message }, "upstream session revoke failed (ignored)"); }
  await db.update(bankApiConsentsTable).set({ revokedAt: new Date() }).where(eq(bankApiConsentsTable.id, id));
}

// ── Sync ───────────────────────────────────────────────────────────────────────
export interface BankApiSyncResult { accounts: number; inserted: number; alerts: string[]; errors: string[] }

const fmtPln = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function syncBankApi(): Promise<BankApiSyncResult> {
  const result: BankApiSyncResult = { accounts: 0, inserted: 0, alerts: [], errors: [] };
  if (!ebConfigured()) return result;
  const consents = await db.select().from(bankApiConsentsTable)
    .where(and(isNull(bankApiConsentsTable.revokedAt), sql`${bankApiConsentsTable.validUntil} > now()`));
  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name, legalName: companiesTable.legalName }).from(companiesTable);
  const coName = new Map(companies.map(c => [c.id, c.name]));
  const ownNames = companies.flatMap(c => [c.name, c.legalName ?? ""]).filter(s => s.length > 2);

  for (const consent of consents) {
    const accounts = await db.select().from(bankApiAccountsTable).where(eq(bankApiAccountsTable.consentId, consent.id));
    for (const acc of accounts) {
      if (!acc.iban) continue;
      result.accounts++;
      const label = `${coName.get(acc.companyId ?? -1) ?? acc.holderName ?? "?"} · ${consent.aspspName}`;
      try {
        await syncAccountBalances(acc.id, acc.uid, label, acc.product, result);
        const inserted = await syncAccountTransactions(consent.companyId ?? acc.companyId ?? null, acc, label, ownNames, result);
        result.inserted += inserted;
        await db.update(bankApiAccountsTable).set({ lastSyncAt: new Date() }).where(eq(bankApiAccountsTable.id, acc.id));
      } catch (e: any) {
        // 401/403 тут означає, що банк відкликав/вичерпав згоду — видно на /bank
        result.errors.push(`${label}: ${e?.message ?? e}`);
        logger.warn({ account: acc.iban, err: e?.message }, "bank api account sync failed");
      }
    }
  }
  if (result.inserted) {
    logger.info({ inserted: result.inserted, accounts: result.accounts }, "bank api sync done");
    // свіжі рядки — у довідник контрагентів (і ЗП/аванси по IBAN працівника)
    try { const { resolveBankCounterparties } = await import("./counterparties"); await resolveBankCounterparties(); }
    catch (e: any) { logger.warn({ err: e?.message }, "counterparty resolve after api sync failed"); }
  }
  return result;
}

async function syncAccountBalances(accId: number, uid: string, label: string, product: string | null, result: BankApiSyncResult): Promise<void> {
  const data = await ebFetch("GET", `/accounts/${uid}/balances`);
  const balances: any[] = data.balances ?? [];
  const pick = (...types: string[]) => balances.find(b => types.includes(b.balance_type))?.balance_amount?.amount;
  const booked = Number(pick("ITBD", "CLBD", "CLAV") ?? balances[0]?.balance_amount?.amount);
  const available = Number(pick("ITAV", "XPCD"));
  const prev = (await db.select({ b: bankApiAccountsTable.lastBookedBalance }).from(bankApiAccountsTable).where(eq(bankApiAccountsTable.id, accId)))[0]?.b;
  await db.update(bankApiAccountsTable).set({
    lastBookedBalance: Number.isFinite(booked) ? booked : null,
    lastAvailableBalance: Number.isFinite(available) ? available : null,
    balanceAt: new Date(),
  }).where(eq(bankApiAccountsTable.id, accId));
  // низький баланс: алерт на перетині порогу вниз (не спамимо, поки стоїть низько);
  // VAT-рахунок пропускаємо — там низько за визначенням
  const isVat = /VAT/i.test(product ?? "");
  if (!isVat && Number.isFinite(booked) && booked < LOW_BALANCE_PLN && (prev == null || prev >= LOW_BALANCE_PLN)) {
    result.alerts.push(`⚠️ Низький баланс: ${label} — ${fmtPln(booked)} zł (поріг ${fmtPln(LOW_BALANCE_PLN)})`);
  }
}

async function syncAccountTransactions(
  companyId: number | null,
  acc: { id: number; uid: string; iban: string | null; lastTxDate: string | null },
  label: string,
  ownNames: string[],
  result: BankApiSyncResult,
): Promise<number> {
  // з перекриттям у 3 дні від останньої відомої транзакції (пізні букінги), але не глибше backfill
  const floor = new Date(Date.now() - BACKFILL_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let from = floor;
  if (acc.lastTxDate) {
    const overlap = new Date(new Date(acc.lastTxDate + "T00:00:00Z").getTime() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (overlap > floor) from = overlap;
  }
  // період, уже покритий витягами, — за MT940 (джерело правди): не тягнемо його з API
  // і прибираємо оперативні рядки, які встигли туди потрапити (пізно імпортований витяг)
  const key = (acc.iban ?? "").replace(/[^0-9]/g, "").match(/\d{26}/)?.[0];
  if (key) {
    const r: any = await db.execute(sql`
      SELECT to_char(max(closing_date), 'YYYY-MM-DD') AS d FROM bank_statements
      WHERE regexp_replace(coalesce(account, ''), '[^0-9]', '', 'g') LIKE ${"%" + key + "%"}`);
    const lastClose: string | null = (r?.rows ?? r)?.[0]?.d ?? null;
    if (lastClose) {
      await db.execute(sql`
        DELETE FROM bank_transactions
        WHERE source = 'api' AND value_date <= ${lastClose}
          AND regexp_replace(coalesce(account, ''), '[^0-9]', '', 'g') LIKE ${"%" + key + "%"}`);
      const next = new Date(new Date(lastClose + "T12:00:00Z").getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      if (next > from) from = next;
    }
  }
  const mapped: MappedTxn[] = [];
  let continuationKey: string | undefined;
  for (let page = 0; page < 30; page++) {
    const qs = new URLSearchParams({ date_from: from });
    if (continuationKey) qs.set("continuation_key", continuationKey);
    const data = await ebFetch("GET", `/accounts/${acc.uid}/transactions?${qs}`);
    for (const raw of (data.transactions ?? []) as ApiTransaction[]) {
      const m = mapApiTxn(raw);
      if (m) mapped.push(m);
    }
    continuationKey = data.continuation_key;
    if (!continuationKey) break;
  }
  if (!mapped.length) return 0;

  const hashes = apiDedupHashes(acc.iban!, mapped);
  const rows = mapped.map((m, i) => ({
    companyId,
    account: normAccount(acc.iban),
    valueDate: m.valueDate,
    bookingDate: m.bookingDate,
    direction: m.direction,
    amount: m.amount,
    currency: m.currency,
    counterparty: m.counterparty,
    counterpartyAccount: m.counterpartyAccount,
    title: m.title,
    txType: m.txType,
    bankRef: m.bankRef,
    source: "api",
    dedupHash: hashes[i]!,
  }));
  const inserted = await db.insert(bankTransactionsTable).values(rows)
    .onConflictDoNothing().returning({ dedupHash: bankTransactionsTable.dedupHash });
  const insertedSet = new Set(inserted.map(r => r.dedupHash));

  const maxDate = mapped.reduce((mx, m) => (m.valueDate > mx ? m.valueDate : mx), acc.lastTxDate ?? "");
  if (maxDate) await db.update(bankApiAccountsTable).set({ lastTxDate: maxDate }).where(eq(bankApiAccountsTable.id, acc.id));

  // алерти лише по щойно вставлених СВІЖИХ рядках (дедуп гарантує «рівно раз»;
  // фільтр дати рятує від зливи історичних алертів на першому бекфілі)
  const alertFloor = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  for (let i = 0; i < mapped.length; i++) {
    if (!insertedSet.has(hashes[i]!)) continue;
    const m = mapped[i]!;
    if (m.valueDate < alertFloor) continue;
    if (isKomornik(m)) {
      result.alerts.push(`🚨 Komornik/egzekucja: ${label} — ${m.direction === "out" ? "−" : "+"}${fmtPln(m.amount)} zł, ${m.counterparty ?? ""} ${((m.title ?? "").slice(0, 120))}`.trim());
    } else if (m.direction === "in" && m.amount >= ALERT_IN_MIN && !isInternalTransfer(m, ownNames)) {
      result.alerts.push(`💰 Надходження: ${label} — +${fmtPln(m.amount)} zł від ${m.counterparty ?? "?"}${m.title ? ` · ${m.title.slice(0, 100)}` : ""}`);
    }
  }
  return inserted.length;
}

// ── Consent expiry warnings (щоденна перевірка) ────────────────────────────────
export async function consentExpiryWarnings(): Promise<string[]> {
  const rows = await db.select({
    id: bankApiConsentsTable.id,
    aspspName: bankApiConsentsTable.aspspName,
    validUntil: bankApiConsentsTable.validUntil,
    companyId: bankApiConsentsTable.companyId,
    warnedAt: bankApiConsentsTable.expiryWarnedAt,
  }).from(bankApiConsentsTable).where(and(isNull(bankApiConsentsTable.revokedAt), sql`${bankApiConsentsTable.validUntil} < now() + interval '14 days'`));
  if (!rows.length) return [];
  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable);
  const coName = new Map(companies.map(c => [c.id, c.name]));
  const out: string[] = [];
  for (const r of rows) {
    // нагадуємо не частіше ніж раз на 3 дні
    if (r.warnedAt && Date.now() - r.warnedAt.getTime() < 3 * 24 * 3600 * 1000) continue;
    const days = Math.max(0, Math.ceil((r.validUntil.getTime() - Date.now()) / (24 * 3600 * 1000)));
    out.push(`⏳ Згода ${r.aspspName}${r.companyId ? ` (${coName.get(r.companyId)})` : ""} спливає через ${days} дн. — понови на сторінці Витяги → Банк API`);
    await db.update(bankApiConsentsTable).set({ expiryWarnedAt: new Date() }).where(eq(bankApiConsentsTable.id, r.id));
  }
  return out;
}
