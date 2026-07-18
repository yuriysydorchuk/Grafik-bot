// Bank statements — faithful MT940 reader (the clean foundation of the finance rework).
// Reads the monthly per-entity uploads from Drive, decodes each file with the right
// encoding, parses every transaction with all its fields, and stores them raw in
// bank_transactions. No interpretation here — economics is layered on separately.
import { google } from "googleapis";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { bankTransactionsTable, bankStatementsTable, companiesTable, counterpartyRulesTable } from "@workspace/db";
import { sql as sqlRaw } from "drizzle-orm";
import { logger } from "../lib/logger";
import { T_OWNER_ANY } from "./bankClassify";
import { decodeStatement, parseMt940, matchCompanyName, type Statement } from "./mt940";

// The pure MT940 layer (encoding, parsing, entity matching) lives in mt940.ts —
// unit-testable without DB/Drive. Re-exported so existing importers keep working.
export { decodeStatement, parseMt940, matchCompanyName, type Statement, type BankTxn } from "./mt940";

const BANK_FOLDER_ID = process.env.BANK_STATEMENTS_FOLDER_ID || "1_ELPng7jyd2jWjrCAgB_HPIJuhcb0Ac2";

// ── Google Drive traversal ──────────────────────────────────────────────────
function getDrive() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(json), scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  return google.drive({ version: "v3", auth });
}
type DriveFile = { id: string; name: string; mimeType: string };
async function listFolder(drive: ReturnType<typeof getDrive>, id: string): Promise<DriveFile[]> {
  const res = await drive.files.list({ q: `'${id}' in parents and trashed=false`, fields: "files(id,name,mimeType)", pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true });
  return (res.data.files ?? []) as DriveFile[];
}
const isFolder = (f: DriveFile) => f.mimeType === "application/vnd.google-apps.folder";

export interface StatementSyncResult { files: number; imported: number; skipped: number; byCompany: Record<string, number>; unmatched: string[] }

export async function syncBankTransactions(filter?: (monthFolder: string) => boolean): Promise<StatementSyncResult> {
  const drive = getDrive();
  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable);
  const coId = new Map(companies.map(c => [c.name, c.id]));
  const result: StatementSyncResult = { files: 0, imported: 0, skipped: 0, byCompany: {}, unmatched: [] };
  const unmatched = new Set<string>();

  // month folder → entity subfolders (one extra nesting level tolerated), Kokos skipped
  async function entityDirs(parentId: string, depth: number): Promise<{ folder: string; companyId: number | null; id: string }[]> {
    const acc: { folder: string; companyId: number | null; id: string }[] = [];
    for (const child of (await listFolder(drive, parentId)).filter(isFolder)) {
      const coName = matchCompanyName(child.name);
      if (coName) acc.push({ folder: child.name, companyId: coId.get(coName) ?? null, id: child.id });
      else if (child.name.toUpperCase().includes("KOKOS")) { /* separate business — skip */ }
      else if (depth > 0) acc.push(...await entityDirs(child.id, depth - 1));
      else unmatched.add(child.name);
    }
    return acc;
  }

  for (const month of (await listFolder(drive, BANK_FOLDER_ID)).filter(isFolder)) {
    if (filter && !filter(month.name)) continue;
    for (const ent of await entityDirs(month.id, 1)) {
      for (const file of (await listFolder(drive, ent.id)).filter(f => f.name.toLowerCase().endsWith(".mt940"))) {
        result.files++;
        let statements: Statement[];
        try {
          const bin = await drive.files.get({ fileId: file.id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
          statements = parseMt940(decodeStatement(Buffer.from(bin.data as ArrayBuffer)));
        } catch (e: any) { logger.warn({ file: file.name, err: e?.message }, "statement parse failed"); continue; }

        // store per-statement balances (for opening/closing snapshots)
        const balRows: (typeof bankStatementsTable.$inferInsert)[] = [];
        for (const st of statements) {
          if (st.closingBalance == null && st.openingBalance == null) continue;
          const h = crypto.createHash("sha1").update([ent.companyId ?? ent.folder, st.account ?? "", st.statementNo ?? "", st.closingDate ?? "", st.closingBalance ?? ""].join("|")).digest("hex");
          balRows.push({ companyId: ent.companyId, account: st.account, statementNo: st.statementNo, fileName: file.name, openingDate: st.openingDate, openingBalance: st.openingBalance, closingDate: st.closingDate, closingBalance: st.closingBalance, closingDerived: st.closingDerived ?? false, dedupHash: h });
        }
        if (balRows.length) await db.insert(bankStatementsTable).values(balRows).onConflictDoNothing();

        const rows: (typeof bankTransactionsTable.$inferInsert)[] = [];
        for (const st of statements) {
          let seq = 0;
          for (const tx of st.txns) {
            seq++;
            const dedupHash = crypto.createHash("sha1")
              .update([ent.companyId ?? ent.folder, st.account ?? "", st.statementNo ?? "", tx.valueDate, tx.direction, tx.amount.toFixed(2), seq, tx.bankRef ?? "", (tx.title ?? "").slice(0, 24)].join("|"))
              .digest("hex");
            rows.push({
              companyId: ent.companyId, entityFolder: ent.folder, account: st.account, statementNo: st.statementNo, fileName: file.name,
              valueDate: tx.valueDate, bookingDate: tx.bookingDate, direction: tx.direction, amount: tx.amount, currency: tx.currency,
              counterparty: tx.counterparty, counterpartyAccount: tx.counterpartyAccount, title: tx.title, txType: tx.txType, bankRef: tx.bankRef, dedupHash,
            });
          }
        }
        if (!rows.length) continue;
        const inserted = await db.insert(bankTransactionsTable).values(rows).onConflictDoNothing().returning({ id: bankTransactionsTable.id });
        result.imported += inserted.length;
        result.skipped += rows.length - inserted.length;
        if (ent.companyId) { const nm = companies.find(c => c.id === ent.companyId)!.name; result.byCompany[nm] = (result.byCompany[nm] ?? 0) + inserted.length; }
      }
    }
  }
  result.unmatched = [...unmatched];

  // Chain-correct derived closings: when :62F: had no amount we computed the closing
  // from the entries, but banks may also charge silent interest with no :61: line.
  // The NEXT statement's :60F: opening is authoritative — adopt it.
  await db.execute(sqlRaw`
    UPDATE bank_statements s SET closing_balance = (
      SELECT n.opening_balance FROM bank_statements n
      WHERE n.account = s.account AND n.opening_date > s.opening_date AND n.opening_balance IS NOT NULL
      ORDER BY n.opening_date ASC LIMIT 1)
    WHERE s.closing_derived AND EXISTS (
      SELECT 1 FROM bank_statements n
      WHERE n.account = s.account AND n.opening_date > s.opening_date AND n.opening_balance IS NOT NULL)`);

  // counterparty rules cover future imports too — apply to freshly arrived rows
  await applyCounterpartyRules({ onlyUncategorized: true });

  logger.info({ files: result.files, imported: result.imported, skipped: result.skipped }, "bank statements sync done");
  return result;
}

// ── Counterparty → category rules ──────────────────────────────────────────────
// Bulk re-categorization by a substring of the counterparty name OR its account
// number (IBAN pattern → matches by account). Owner payouts are exempt: neither
// auto-detected owner transfers nor per-txn owner overrides are touched.
// The same haystack expression is used when a rule is rolled back (routes/bank.ts).
export const RULE_HAYSTACK = `upper(coalesce(counterparty, '') || ' ' || coalesce(replace(counterparty_account, ' ', ''), ''))`;

export async function applyCounterpartyRules(opts: { onlyUncategorized?: boolean; ruleId?: number } = {}): Promise<number> {
  const rules = opts.ruleId
    ? await db.select().from(counterpartyRulesTable).where(sqlRaw`id = ${opts.ruleId}`)
    : await db.select().from(counterpartyRulesTable);
  let updated = 0;
  for (const r of rules) {
    const guard = opts.onlyUncategorized
      ? sqlRaw` AND manual_category IS NULL`
      : sqlRaw` AND (manual_category IS NULL OR manual_category NOT IN ('owner_roman','owner_tetiana','owner_yuriy'))`;
    const res: any = await db.execute(sqlRaw`
      UPDATE bank_transactions SET manual_category = ${r.category}
      WHERE direction = 'out'
        AND ${sqlRaw.raw(RULE_HAYSTACK)} LIKE ${"%" + r.pattern.toUpperCase().replace(/\s+/g, " ") + "%"}
        AND NOT (${sqlRaw.raw(T_OWNER_ANY)})
        AND manual_category IS DISTINCT FROM ${r.category}${guard}`);
    updated += Number(res?.rowCount ?? 0);
  }
  return updated;
}
