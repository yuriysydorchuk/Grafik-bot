// Pure Enable Banking (PSD2 open banking) layer: JWT signing, mapping of API
// transactions to the bank_transactions shape, dedup hashing and holder→company
// matching. No DB and no network here — covered by enableBanking.test.ts.
// The I/O (fetch + persistence) lives in bankApi.ts.
import crypto from "node:crypto";

// ── JWT (RS256, kid = application id) ──────────────────────────────────────────
export function ebJwt(appId: string, privateKeyPem: string, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  const header = b64(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const body = b64(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: nowSec, exp: nowSec + 3600 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${header}.${body}`).sign(privateKeyPem).toString("base64url");
  return `${header}.${body}.${sig}`;
}

// ── API shapes (subset we consume) ─────────────────────────────────────────────
export type ApiTransaction = {
  entry_reference?: string | null;
  transaction_amount?: { currency?: string; amount?: string } | null;
  credit_debit_indicator?: string | null;   // CRDT | DBIT
  status?: string | null;                   // BOOK | PDNG | …
  booking_date?: string | null;
  value_date?: string | null;
  creditor?: { name?: string | null } | null;
  debtor?: { name?: string | null } | null;
  creditor_account?: { iban?: string | null } | null;
  debtor_account?: { iban?: string | null } | null;
  remittance_information?: string[] | null;
  bank_transaction_code?: { description?: string | null; code?: string | null } | null;
};

export type MappedTxn = {
  valueDate: string;
  bookingDate: string | null;
  direction: "in" | "out";
  amount: number;
  currency: string;
  counterparty: string | null;
  counterpartyAccount: string | null;
  title: string | null;
  txType: string | null;
  bankRef: string | null;
};

// Booked transaction → bank_transactions row shape; null = skip (pending/malformed).
// Counterparty: для вхідної — платник (debtor), для вихідної — отримувач (creditor),
// дзеркально тому, як MT940-парсер читає ^32/^33.
export function mapApiTxn(t: ApiTransaction): MappedTxn | null {
  if (t.status && t.status !== "BOOK") return null; // pending зникає/міняється — беремо лише заведене
  const amount = Number(t.transaction_amount?.amount);
  const date = t.value_date || t.booking_date;
  const ind = t.credit_debit_indicator;
  if (!Number.isFinite(amount) || amount <= 0 || !date || (ind !== "CRDT" && ind !== "DBIT")) return null;
  const direction = ind === "CRDT" ? "in" : "out";
  const other = direction === "in" ? t.debtor : t.creditor;
  const otherAcc = direction === "in" ? t.debtor_account : t.creditor_account;
  const title = (t.remittance_information ?? []).map(s => s?.trim()).filter(Boolean).join(" ") || null;
  return {
    valueDate: date,
    bookingDate: t.booking_date ?? null,
    direction,
    amount: Math.round(amount * 100) / 100,
    currency: t.transaction_amount?.currency || "PLN",
    counterparty: other?.name?.trim() || null,
    counterpartyAccount: otherAcc?.iban?.replace(/\s+/g, "") || null,
    title,
    txType: t.bank_transaction_code?.description?.trim() || null,
    bankRef: t.entry_reference?.trim() || null,
  };
}

export const normAccount = (s: string | null | undefined): string => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Dedup hash for an API row. entry_reference is stable per transaction; without it
// identical same-day rows (дві однакові виплати одній людині) are disambiguated by
// an ordinal within the fetched batch — assign with apiDedupHashes().
export function apiDedupHash(iban: string, m: MappedTxn, ordinal: number): string {
  const base = m.bankRef
    ? ["api", normAccount(iban), "ref", m.bankRef]
    : ["api", normAccount(iban), m.valueDate, m.direction, m.amount.toFixed(2), (m.counterparty ?? "").slice(0, 24), (m.title ?? "").slice(0, 24), String(ordinal)];
  return crypto.createHash("sha1").update(base.join("|")).digest("hex");
}

// Hashes for a whole batch, counting ordinals among identical no-reference keys.
export function apiDedupHashes(iban: string, txns: MappedTxn[]): string[] {
  const seen = new Map<string, number>();
  return txns.map(m => {
    if (m.bankRef) return apiDedupHash(iban, m, 0);
    const key = [m.valueDate, m.direction, m.amount.toFixed(2), m.counterparty ?? "", m.title ?? ""].join("|");
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return apiDedupHash(iban, m, n);
  });
}

// ── Holder name → company ──────────────────────────────────────────────────────
// Matches the bank's account-holder name against our legal entities: every
// meaningful token of the legal name must be present (EUROSUPPORT GROUP ≠ ESO);
// the most specific match (more tokens) wins.
export function matchHolderCompany(
  holder: string | null | undefined,
  companies: { id: number; name: string; legalName: string | null }[],
): number | null {
  const hay = (holder ?? "").toUpperCase();
  if (!hay) return null;
  // фолбек без пробілів: банк пише «EURO SUPPORT OUTSOURCING», у нас «Eurosupport
  // Outsourcing» — токени не збігаються, а суцільні рядки збігаються
  const haySquashed = hay.replace(/[^A-ZĄĆĘŁŃÓŚŹŻ0-9]+/g, "");
  let best: { id: number; tokens: number } | null = null;
  for (const c of companies) {
    const legal = (c.legalName || c.name).toUpperCase();
    const tokens = legal.split(/[^A-ZĄĆĘŁŃÓŚŹŻ0-9]+/).filter(t => t.length > 2);
    if (!tokens.length) continue;
    const hit = tokens.every(t => hay.includes(t)) || haySquashed.includes(tokens.join(""));
    if (!hit) continue;
    if (!best || tokens.length > best.tokens) best = { id: c.id, tokens: tokens.length };
  }
  return best?.id ?? null;
}

// ── Alert classification for freshly synced rows ───────────────────────────────
// Internal moves (свій-на-свій, VAT MPP) не алертимо; komornik/egzekucja — завжди.
const T_INTERNAL_RE = /PRZELEW\s+W[ŁL]ASNY|BETWEEN YOUR OWN|PRZEKSI[ĘE]GOWANIE VAT|PSZELEW\s+W[ŁL]ASNY/i;
const T_KOMORNIK_RE = /KOMORNIK|EGZEKUC|ZAJ[ĘE]CI/i;

export function isInternalTransfer(m: MappedTxn, ownNames: string[]): boolean {
  if (T_INTERNAL_RE.test(m.title ?? "")) return true;
  const cp = (m.counterparty ?? "").toUpperCase();
  return !!cp && ownNames.some(n => cp.includes(n.toUpperCase()));
}

export function isKomornik(m: MappedTxn): boolean {
  return T_KOMORNIK_RE.test(`${m.title ?? ""} ${m.counterparty ?? ""} ${m.txType ?? ""}`);
}
