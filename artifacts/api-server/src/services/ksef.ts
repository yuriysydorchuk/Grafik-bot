// KSeF (Krajowy System e-Faktur) — sales invoices per firm («KSeF», /ksef).
// Auth: KSeF token per company (env KSEF_TOKEN_<ES|ESO|KLINEX>) → challenge →
// token|timestamp encrypted with the KSeF public key → JWT access token.
// Sync: incremental metadata query (subject1 = we are the seller), upsert by
// KSeF number. Revenue accrual: invoice issued in June for May's work → May
// (revenue_month = issue month − 1); P&L gets netto per mapped client.
// Payments: strict match — the invoice number appearing in an INCOMING bank
// transfer title of the same firm; plus manual override from the UI.
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { ksefInvoicesTable, companiesTable, pnlEntriesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const KSEF_BASE = process.env.KSEF_BASE_URL || "https://api.ksef.mf.gov.pl/api/v2";

// buyer name (normalized, no legal suffixes) → our P&L client label
const BUYER_ALIASES: [RegExp, string][] = [
  [/SERWIS ?PLUS/, "Dezynfekcja"],
  [/KUZNIA ?MATRYCOWA/, "Kuźnia"],
  [/EUROCASH/, "Eurocash"],
  [/TOP ?2/, "TOP-2"],
  [/AGRAM/, "Agram"],
  [/^BLC\b/, "BLC"],
  [/INPOST/, "InPost"],
  [/^LST\b|LST[- ]POLSKA/, "LST"],
  [/SUSHI/, "Sushi&Food Factory"],
  [/PREMIUM ?FRUITS/, "Premium Fruits"],
  [/OSMOFROST/, "Osmofrost"],
  [/UREN/, "Uren Nova Berry"],
  [/JUKKI/, "JUKKI"],
  [/NOWOPAK|NOWO ?PAK/, "NowoPak"],
  [/PAK[- ]?SERWIS|PAK[- ]?SERVICE/, "Pak-Service"],
  [/AUNDE/, "Aunde"],
  [/ANDROS|MATERNE/, "Andros"],
  [/RECYKLING/, "Recykling"],
  [/RABEN/, "Raben"],
  [/MAKARUK/, "Makaruk"],
  [/DATA ?MODUL/, "Data Modul"],
];

const normBuyer = (s: string) =>
  s.toUpperCase()
    .replace(/[ĄĆĘŁŃÓŚŹŻ]/g, ch => ({ Ą: "A", Ć: "C", Ę: "E", Ł: "L", Ń: "N", Ó: "O", Ś: "S", Ź: "Z", Ż: "Z" }[ch] ?? ch))
    .replace(/["'„”]/g, "").replace(/\s+/g, " ").trim();

// the cleaning sub-business, counted separately: wspólnoty mieszkaniowe + named clients
export function segmentForBuyer(buyerName: string | null): string {
  const n = normBuyer(buyerName ?? "");
  return /WSPOLNOT|GALEY|GALEJ/.test(n) ? "cleaning" : "main";
}

export function mapBuyerToClient(buyerName: string | null): string | null {
  if (!buyerName) return null;
  const n = normBuyer(buyerName);
  for (const [re, label] of BUYER_ALIASES) if (re.test(n)) return label;
  // fallback: buyer name without legal forms, title-cased-ish
  const cleaned = n
    .replace(/SPOLKA Z OGRANICZONA ODPOWIEDZIALNOSCIA|SP\.? ?Z ?O\.? ?O\.?|SPOLKA AKCYJNA|S\.?A\.?$|SPOLKA KOMANDYTOWA|SP\.? ?K\.?$|SPOLKA JAWNA/g, "")
    .replace(/\s+/g, " ").trim();
  return cleaned || n;
}

// issue month − 1 (June invoice bills May's work)
export function revenueMonthFor(issueDate: string): string {
  const [y, m] = issueDate.slice(0, 7).split("-").map(Number);
  return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, "0")}`;
}

function companyTokens(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, env] of [["ES", "KSEF_TOKEN_ES"], ["ESO", "KSEF_TOKEN_ESO"], ["Klinex", "KSEF_TOKEN_KLINEX"]] as const) {
    const v = process.env[env];
    if (v) out.set(name, v);
  }
  return out;
}

// ── auth ───────────────────────────────────────────────────────────────────────
let cachedPubKey: { key: crypto.KeyObject; fetchedAt: number } | null = null;

async function jfetch(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${KSEF_BASE}${path}`, init);
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function ksefPublicKey(): Promise<crypto.KeyObject> {
  if (cachedPubKey && Date.now() - cachedPubKey.fetchedAt < 12 * 3600e3) return cachedPubKey.key;
  const { status, body } = await jfetch("/security/public-key-certificates");
  if (status !== 200) throw new Error(`KSeF public keys: HTTP ${status}`);
  const cert = (body as any[]).find(c => JSON.stringify(c.usage ?? "").includes("KsefToken"));
  if (!cert) throw new Error("KSeF token-encryption certificate not found");
  const x509 = new crypto.X509Certificate(Buffer.from(cert.certificate, "base64"));
  cachedPubKey = { key: x509.publicKey, fetchedAt: Date.now() };
  return x509.publicKey;
}

function encryptToken(pub: crypto.KeyObject, token: string, timestampMs: number): string {
  const payload = Buffer.from(`${token}|${timestampMs}`, "utf8");
  if (pub.asymmetricKeyType === "rsa") {
    return crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, payload).toString("base64");
  }
  // ECIES variant (per official SDK): ephemeral ECDH P-256 → SHA256(secret) → AES-256-GCM;
  // output = ephemeral SPKI || nonce(12) || tag(16) || ciphertext
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const jwk = pub.export({ format: "jwk" }) as any;
  const receiverPub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const key = crypto.createHash("sha256").update(ecdh.computeSecret(receiverPub)).digest();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
  const spki = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: ecdh.getPublicKey().subarray(1, 33).toString("base64url"), y: ecdh.getPublicKey().subarray(33).toString("base64url") },
    format: "jwk",
  }).export({ format: "der", type: "spki" }) as Buffer;
  return Buffer.concat([spki, nonce, cipher.getAuthTag(), ct]).toString("base64");
}

async function authenticate(nip: string, token: string): Promise<string> {
  const pub = await ksefPublicKey();
  const ch = await jfetch("/auth/challenge", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (ch.status !== 200) throw new Error(`challenge: HTTP ${ch.status}`);
  const init = await jfetch("/auth/ksef-token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challenge: ch.body.challenge,
      contextIdentifier: { type: "Nip", value: nip },
      encryptedToken: encryptToken(pub, token, ch.body.timestampMs),
    }),
  });
  if (init.status !== 202) throw new Error(`auth init: HTTP ${init.status} ${JSON.stringify(init.body).slice(0, 200)}`);
  const authToken = init.body.authenticationToken.token;
  const ref = init.body.referenceNumber;
  for (let i = 0; i < 20; i++) {
    await new Promise(s => setTimeout(s, 700));
    const st = await jfetch(`/auth/${ref}`, { headers: { Authorization: `Bearer ${authToken}` } });
    const code = st.body?.status?.code;
    if (code === 200) break;
    if (code >= 400) throw new Error(`auth failed: ${JSON.stringify(st.body.status)}`);
  }
  const redeem = await jfetch("/auth/token/redeem", { method: "POST", headers: { Authorization: `Bearer ${authToken}` } });
  if (redeem.status !== 200) throw new Error(`redeem: HTTP ${redeem.status}`);
  return redeem.body.accessToken.token;
}

// ── sync ───────────────────────────────────────────────────────────────────────
export interface KsefSyncResult { companies: number; fetched: number; inserted: number; paidMatched: number; errors: string[] }

export async function syncKsef(): Promise<KsefSyncResult> {
  const tokens = companyTokens();
  const result: KsefSyncResult = { companies: 0, fetched: 0, inserted: 0, paidMatched: 0, errors: [] };
  if (!tokens.size) { result.errors.push("немає KSEF_TOKEN_* у середовищі"); return result; }
  const companies = await db.select().from(companiesTable);
  const touchedMonths = new Set<string>();

  for (const [name, token] of tokens) {
    const company = companies.find(c => c.name === name);
    if (!company?.nip) { result.errors.push(`${name}: немає NIP у довіднику фірм`); continue; }
    try {
      const access = await authenticate(company.nip, token);
      // sale = ми виставили (Subject1), purchase = виставили нам (Subject2).
      // Sales land in the P&L month «issue − 1»; purchases are display-only and
      // grouped by the calendar issue month (owner's call).
      for (const kind of ["sale", "purchase"] as const) {
        // incremental: from 14 days before the newest stored invoice (or 2026-01-01),
        // in windows of ≤80 days (API limit is 3 months per query)
        const last: any = await db.execute(sql`SELECT max(issue_date) AS d FROM ksef_invoices WHERE company_id = ${company.id} AND kind = ${kind}`);
        const lastDate = (last.rows ?? last)[0]?.d as string | null;
        let from = lastDate ? new Date(new Date(lastDate).getTime() - 14 * 86400e3) : new Date("2026-01-01T00:00:00Z");
        const now = new Date();
        while (from < now) {
          const to = new Date(Math.min(from.getTime() + 80 * 86400e3, now.getTime()));
          for (let pageOffset = 0; ; pageOffset++) {
            const q = await jfetch(`/invoices/query/metadata?pageOffset=${pageOffset}&pageSize=100`, {
              method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
              body: JSON.stringify({
                subjectType: kind === "sale" ? "Subject1" : "Subject2",
                dateRange: { dateType: "Issue", from: from.toISOString(), to: to.toISOString() },
              }),
            });
            if (q.status !== 200) throw new Error(`query: HTTP ${q.status} ${JSON.stringify(q.body).slice(0, 150)}`);
            const invoices = q.body.invoices ?? [];
            result.fetched += invoices.length;
            for (const m of invoices) {
              const issue = String(m.issueDate).slice(0, 10);
              const revenueMonth = kind === "sale" ? revenueMonthFor(issue) : issue.slice(0, 7);
              if (kind === "sale") touchedMonths.add(revenueMonth);
              // upsert: existing rows only get their hashes backfilled (needed for
              // korekta↔original linking); xmax=0 distinguishes fresh inserts
              const upserted = await db.insert(ksefInvoicesTable).values({
                companyId: company.id, kind, ksefNumber: m.ksefNumber, invoiceNumber: m.invoiceNumber,
                issueDate: issue, invoicingDate: m.invoicingDate ? String(m.invoicingDate).slice(0, 10) : null,
                buyerNip: m.buyer?.identifier?.value ?? null, buyerName: m.buyer?.name ?? null,
                sellerNip: m.seller?.nip ?? null, sellerName: m.seller?.name ?? null,
                net: Number(m.netAmount ?? 0), vat: Number(m.vatAmount ?? 0), gross: Number(m.grossAmount ?? 0),
                currency: m.currency ?? "PLN", invoiceType: m.invoiceType ?? null,
                revenueMonth,
                clientLabel: kind === "sale" ? mapBuyerToClient(m.buyer?.name ?? null) : null,
                segment: kind === "sale" ? segmentForBuyer(m.buyer?.name ?? null) : "main",
                invoiceHash: m.invoiceHash ?? null, correctedHash: m.hashOfCorrectedInvoice ?? null,
              }).onConflictDoUpdate({
                target: [ksefInvoicesTable.ksefNumber, ksefInvoicesTable.kind],
                set: { invoiceHash: sql`excluded.invoice_hash`, correctedHash: sql`excluded.corrected_hash` },
              }).returning({ isNew: sql<boolean>`(xmax = 0)` });
              result.inserted += upserted.filter(r => r.isNew).length;
            }
            if (invoices.length < 100) break;
          }
          from = new Date(to.getTime() + 1);
        }
      }
      result.companies++;
    } catch (e) {
      result.errors.push(`${name}: ${String(e).slice(0, 200)}`);
      logger.warn({ company: name, err: String(e) }, "KSeF sync failed");
    }
  }

  result.paidMatched = await matchKsefPayments();
  // rebuild every month present — cheap, and it picks up re-labeling/segmenting
  const all: any = await db.execute(sql`SELECT DISTINCT revenue_month AS m FROM ksef_invoices`);
  for (const row of (all.rows ?? all) as any[]) await feedPnlRevenue(String(row.m));
  return result;
}

// Strict payment matching, three passes. The anchor is always the invoice
// number inside the incoming transfer title; the exact gross amount
// disambiguates, because invoice numbers collide across our firms (A3/4/2026
// exists at ES, ESO and Klinex at once) and clients sometimes pay to the
// wrong firm's account:
//  1) same firm + number in title + exact amount;
//  2) any of our firms + number in title + exact amount (cross-firm payments);
//  3) invoice minus the same buyer's open korekta: the transfer carries the
//     main invoice number and equals exactly invoice + korekta — closes both;
//  4) same firm + number in title, amount differs (batch transfers covering
//     several invoices) — only with transfers not already claimed by an exact match.
export async function matchKsefPayments(): Promise<number> {
  let total = 0;
  const run = async (q: any) => {
    const r: any = await db.execute(q);
    total += Number(r.rowCount ?? 0);
  };
  await run(sql`
    UPDATE ksef_invoices i
    SET paid_date = t.value_date, paid_txn_id = t.id, paid_via = 'bank'
    FROM bank_transactions t
    WHERE i.kind = 'sale' AND i.paid_date IS NULL AND t.direction = 'in' AND t.value_date >= i.issue_date
      AND t.company_id = i.company_id
      AND position(upper(i.invoice_number) IN upper(coalesce(t.title, ''))) > 0
      AND abs(t.amount - i.gross) <= 0.02`);
  await run(sql`
    UPDATE ksef_invoices i
    SET paid_date = t.value_date, paid_txn_id = t.id, paid_via = 'bank'
    FROM bank_transactions t
    WHERE i.kind = 'sale' AND i.paid_date IS NULL AND t.direction = 'in' AND t.value_date >= i.issue_date
      AND position(upper(i.invoice_number) IN upper(coalesce(t.title, ''))) > 0
      AND abs(t.amount - i.gross) <= 0.02`);
  await run(sql`
    WITH pairs AS (
      SELECT i.id AS inv_id, k.id AS kor_id, t.id AS txn_id, t.value_date
      FROM ksef_invoices i
      JOIN ksef_invoices k ON k.company_id = i.company_id AND k.kind = 'sale'
        AND coalesce(k.buyer_nip, '?') = coalesce(i.buyer_nip, '!')
        AND k.gross < 0 AND k.paid_date IS NULL AND k.manual_status IS NULL AND k.id <> i.id
      JOIN bank_transactions t ON t.direction = 'in' AND t.value_date >= i.issue_date
        AND position(upper(i.invoice_number) IN upper(coalesce(t.title, ''))) > 0
        AND abs(t.amount - (i.gross + k.gross)) <= 0.02
      WHERE i.kind = 'sale' AND i.paid_date IS NULL AND i.manual_status IS NULL AND i.gross > 0
    )
    UPDATE ksef_invoices x SET paid_date = p.value_date, paid_txn_id = p.txn_id, paid_via = 'bank'
    FROM pairs p WHERE x.id = p.inv_id OR x.id = p.kor_id`);
  await run(sql`
    UPDATE ksef_invoices i
    SET paid_date = t.value_date, paid_txn_id = t.id, paid_via = 'bank'
    FROM bank_transactions t
    WHERE i.kind = 'sale' AND i.paid_date IS NULL AND t.direction = 'in' AND t.value_date >= i.issue_date
      AND t.company_id = i.company_id
      AND position(upper(i.invoice_number) IN upper(coalesce(t.title, ''))) > 0
      AND NOT EXISTS (SELECT 1 FROM ksef_invoices x WHERE x.paid_txn_id = t.id)`);
  // purchases: OUR outgoing transfer from the same firm carrying the invoice
  // number, exact gross — anything else stays manual (no amount-only heuristics)
  await run(sql`
    UPDATE ksef_invoices i
    SET paid_date = t.value_date, paid_txn_id = t.id, paid_via = 'bank'
    FROM bank_transactions t
    WHERE i.kind = 'purchase' AND i.paid_date IS NULL AND t.direction = 'out' AND t.value_date >= i.issue_date
      AND t.company_id = i.company_id
      AND position(upper(i.invoice_number) IN upper(coalesce(t.title, ''))) > 0
      AND abs(t.amount - i.gross) <= 0.02`);
  // purchases the office register (Faktury Kosztowe) marks paid but the bank
  // can't see: «Gotówka» (cash) and transfers without the number in the title.
  // Anchor = exact invoice number + amount (not amount alone); paid_txn_id stays
  // NULL — the UI shows these as «реєстр», not «витяг».
  await run(sql`
    UPDATE ksef_invoices k
    SET paid_date = coalesce(reg.paid_date, reg.due_date, k.issue_date), paid_via = 'register'
    FROM (
      SELECT DISTINCT ON (upper(trim(number)), amount) upper(trim(number)) AS num, amount,
             coalesce(manual_paid_date, paid_date) AS paid_date, due_date
      FROM invoices
      WHERE number IS NOT NULL
        AND CASE WHEN manual_status IS NOT NULL THEN manual_status = 'paid' ELSE NOT unpaid END
      ORDER BY upper(trim(number)), amount, coalesce(manual_paid_date, paid_date) DESC NULLS LAST
    ) reg
    WHERE k.kind = 'purchase' AND k.paid_date IS NULL AND k.manual_status IS NULL
      AND reg.num = upper(trim(k.invoice_number))
      AND abs(reg.amount - k.gross) <= 0.05`);
  // purchase invoice fully cancelled by its korekta: the exact link comes from
  // KSeF metadata (corrected_hash = original's invoice_hash — suppliers reissue
  // invoices this way, e.g. to another of our firms), amounts must zero out.
  // Both legs get settled at the korekta issue date; no money moved.
  await run(sql`
    WITH pairs AS (
      SELECT i.id AS inv_id, k.id AS kor_id, k.issue_date
      FROM ksef_invoices i
      JOIN ksef_invoices k ON k.kind = 'purchase' AND k.company_id = i.company_id
        AND k.corrected_hash IS NOT NULL AND k.corrected_hash = i.invoice_hash
        AND k.gross < 0 AND k.paid_date IS NULL AND k.manual_status IS NULL
        AND abs(i.gross + k.gross) <= 0.02
      WHERE i.kind = 'purchase' AND i.paid_date IS NULL AND i.manual_status IS NULL AND i.gross > 0
    )
    UPDATE ksef_invoices x SET paid_date = p.issue_date, paid_via = 'korekta'
    FROM pairs p WHERE x.id = p.inv_id OR x.id = p.kor_id`);
  // fallback for korekty without the metadata link (suppliers rarely fill it):
  // same seller NIP + same firm + amounts zero out + korekta not older than the
  // invoice — but ONLY when the pairing is unambiguous in both directions
  // (exactly one candidate invoice for the korekta and vice versa). Ambiguous
  // cases (two open invoices with the same amount) stay manual by design.
  await run(sql`
    WITH cand AS (
      SELECT k.id AS kor_id, i.id AS inv_id, k.issue_date,
             count(*) OVER (PARTITION BY k.id) AS n_inv,
             count(*) OVER (PARTITION BY i.id) AS n_kor
      FROM ksef_invoices k
      JOIN ksef_invoices i ON i.kind = 'purchase' AND i.company_id = k.company_id
        AND i.seller_nip IS NOT NULL AND i.seller_nip = k.seller_nip
        AND i.gross > 0 AND i.paid_date IS NULL AND i.manual_status IS NULL
        AND abs(i.gross + k.gross) <= 0.02 AND i.issue_date <= k.issue_date
      WHERE k.kind = 'purchase' AND k.gross < 0 AND k.paid_date IS NULL AND k.manual_status IS NULL
    )
    UPDATE ksef_invoices x SET paid_date = c.issue_date, paid_via = 'korekta'
    FROM cand c WHERE (x.id = c.inv_id OR x.id = c.kor_id) AND c.n_inv = 1 AND c.n_kor = 1`);
  return total;
}

// Receivables («нам винні») at a date: invoices issued on or before asOf that
// were not yet paid at asOf. Payment date comes from the bank match; manual
// override wins (manual «paid» without a date = never counted as a debt).
// Netting per client: clients with a positive open position are receivables;
// clients netting NEGATIVE (uncovered korekty/overpayments) come back as
// `credits` — that money is owed TO the client, the Balance shows it under
// «Ми винні». Only the main business — cleaning (wspólnoty) is separate.
export async function ksefReceivablesAt(asOf: string): Promise<{
  total: number; count: number; byClient: { client: string; count: number; gross: number }[];
  credits: { total: number; count: number; byClient: { client: string; count: number; gross: number }[] };
}> {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rows = await db.select().from(ksefInvoicesTable)
    .where(and(eq(ksefInvoicesTable.kind, "sale"), sql`${ksefInvoicesTable.issueDate} <= ${asOf}`));
  const perClient = new Map<string, { client: string; count: number; gross: number }>();
  for (const inv of rows) {
    if (inv.segment === "cleaning") continue;
    let openAt: boolean;
    if (inv.manualStatus === "paid") {
      const d = inv.manualPaidDate ?? inv.paidDate;
      openAt = d != null && d > asOf;
    } else if (inv.manualStatus === "unpaid") openAt = true;
    else openAt = inv.paidDate == null || inv.paidDate > asOf;
    if (!openAt) continue;
    const label = inv.clientLabel ?? inv.buyerName ?? "—";
    const g = perClient.get(label) ?? perClient.set(label, { client: label, count: 0, gross: 0 }).get(label)!;
    g.count++;
    g.gross = r2(g.gross + inv.gross);
  }
  const positive = [...perClient.values()].filter(c => c.gross > 0).sort((a, b) => b.gross - a.gross);
  const negative = [...perClient.values()].filter(c => c.gross < 0)
    .map(c => ({ ...c, gross: r2(-c.gross) })) // shown as what WE owe, positive number
    .sort((a, b) => b.gross - a.gross);
  return {
    total: r2(positive.reduce((s, c) => s + c.gross, 0)),
    count: positive.reduce((s, c) => s + c.count, 0),
    byClient: positive,
    credits: {
      total: r2(negative.reduce((s, c) => s + c.gross, 0)),
      count: negative.reduce((s, c) => s + c.count, 0),
      byClient: negative,
    },
  };
}

// P&L revenue per client for the month (netto), source='ksef'; the cleaning
// sub-business (wspólnoty) goes into its own segment
export async function feedPnlRevenue(revenueMonth: string) {
  const rows = await db.select().from(ksefInvoicesTable)
    .where(and(eq(ksefInvoicesTable.revenueMonth, revenueMonth), eq(ksefInvoicesTable.kind, "sale")));
  const byClient = new Map<string, { net: number; gross: number; count: number; firms: Set<string>; segment: string }>();
  const companies = new Map((await db.select().from(companiesTable)).map(c => [c.id, c.name]));
  for (const inv of rows) {
    const label = inv.clientLabel ?? inv.buyerName ?? "—";
    const k = `${inv.segment}|${label}`;
    const g = byClient.get(k) ?? byClient.set(k, { net: 0, gross: 0, count: 0, firms: new Set(), segment: inv.segment }).get(k)!;
    g.net = Math.round((g.net + inv.net) * 100) / 100;
    g.gross = Math.round((g.gross + inv.gross) * 100) / 100;
    g.count++;
    g.firms.add(companies.get(inv.companyId) ?? "?");
  }
  await db.transaction(async tx => {
    await tx.delete(pnlEntriesTable).where(and(
      eq(pnlEntriesTable.periodMonth, revenueMonth),
      eq(pnlEntriesTable.section, "revenue"),
      eq(pnlEntriesTable.source, "ksef"),
    ));
    for (const [k, g] of byClient) {
      if (!g.net) continue;
      await tx.insert(pnlEntriesTable).values({
        periodMonth: revenueMonth, section: "revenue", label: k.split("|")[1]!, amount: g.net, amountGross: g.gross,
        source: "ksef", segment: g.segment,
        note: `KSeF: ${g.count} фактур (${[...g.firms].join(", ")}), netto`,
      });
    }
  });
}
