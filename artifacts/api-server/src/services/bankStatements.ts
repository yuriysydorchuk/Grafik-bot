// Bank statements — faithful MT940 reader (the clean foundation of the finance rework).
// Reads the monthly per-entity uploads from Drive, decodes each file with the right
// encoding, parses every transaction with all its fields, and stores them raw in
// bank_transactions. No interpretation here — economics is layered on separately.
import { google } from "googleapis";
import iconv from "iconv-lite";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { bankTransactionsTable, bankStatementsTable, companiesTable } from "@workspace/db";
import { sql as sqlRaw } from "drizzle-orm";
import { logger } from "../lib/logger";

const BANK_FOLDER_ID = process.env.BANK_STATEMENTS_FOLDER_ID || "1_ELPng7jyd2jWjrCAgB_HPIJuhcb0Ac2";

// ── Encoding detection ─────────────────────────────────────────────────────────
// Files come in UTF-8, Windows-1250 or CP852 (DOS) depending on the bank. Financial
// fields are ASCII; only names/titles differ. Prefer strict UTF-8; otherwise decode
// as both single-byte candidates and keep the one with more valid Polish (fewer junk
// glyphs).
const PL = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g;
const JUNK = /[─-╿¤ŕťřůđ]/g;
const score = (s: string) => (s.match(PL)?.length ?? 0) * 2 - (s.match(JUNK)?.length ?? 0);
export function decodeStatement(buf: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { /* not utf-8 */ }
  const cp1250 = iconv.decode(buf, "win1250");
  const cp852 = iconv.decode(buf, "cp852");
  return score(cp852) > score(cp1250) ? cp852 : cp1250;
}

// ── MT940 parsing ────────────────────────────────────────────────────────────
export interface BankTxn {
  valueDate: string; bookingDate: string | null;
  direction: "in" | "out"; amount: number; currency: string;
  counterparty: string | null; counterpartyAccount: string | null;
  title: string | null; txType: string | null; bankRef: string | null;
}
export interface Statement {
  account: string | null; statementNo: string | null;
  openingDate: string | null; openingBalance: number | null;
  closingDate: string | null; closingBalance: number | null;
  closingDerived?: boolean; // :62F: carried no amount → closing computed from entries
  txns: BankTxn[];
}

// :61: YYMMDD [MMDD] D|C|RD|RC [funds] amount N type //ref
const RE_61 = /^:61:(\d{6})(\d{4})?(R?[DC])([A-Z])?([\d,]+)(?:N(.{3}))?/;
// :60F:/:62F: C|D YYMMDD CUR amount  (balance; D = negative)
const RE_BAL = /^:6[02][FM]:([CD])(\d{6})[A-Z]{3}([\d,]+)/;
const iso = (yymmdd: string) => `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;

// Parse a :86: block. Two layouts occur: structured (^NN subfields) and a flat
// SWIFT split-payment format (/VAT/.../IDC/.../INV/.../TXT/<purpose>) that carries no
// payer name — there we surface the /TXT/ purpose as the title.
function parse86(raw: string): { txType: string | null; counterparty: string | null; counterpartyAccount: string | null; title: string | null } {
  const sub: Record<string, string> = {};
  for (const m of raw.matchAll(/\^(\d\d)([^^]*)/g)) sub[m[1]!] = (sub[m[1]!] ?? "") + m[2];
  if (Object.keys(sub).length === 0) {
    // flat format — no name; take the /TXT/ purpose if present, else the leftover text
    let title: string | null = null;
    if (raw.includes("/TXT/")) title = raw.split("/TXT/").slice(1).join("/TXT/").trim();
    else title = raw.replace(/\/(VAT|IDC|INV|TI|OKR|SFP|IBK|DEB|CRE)\/[^/]*/gi, " ").trim();
    return { txType: null, counterparty: null, counterpartyAccount: null, title: title ? title.replace(/\s+/g, " ").trim() : null };
  }
  const head = raw.replace(/\^\d\d.*$/s, "").trim();          // text before the first ^NN = transaction-type descr
  const join = (...codes: string[]) => { const v = codes.map(c => sub[c] ?? "").join("").replace(/\s+/g, " ").trim(); return v || null; };
  return {
    txType: (head + (sub["00"] ? " " + sub["00"] : "")).replace(/\s+/g, " ").trim() || null,
    counterparty: join("32", "33"),
    counterpartyAccount: join("38"),
    title: join("20", "21", "22", "23", "24", "25", "26", "27", "28", "29"),
  };
}

export function parseMt940(text: string): Statement[] {
  const lines = text.split(/\r?\n/);
  const out: Statement[] = [];
  let cur: Statement | null = null;
  let pending: BankTxn | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(":20:")) { if (pending && cur) { cur.txns.push(pending); pending = null; } if (cur) out.push(cur); cur = { account: null, statementNo: null, openingDate: null, openingBalance: null, closingDate: null, closingBalance: null, txns: [] }; }
    else if (line.startsWith(":25:")) { if (cur) cur.account = line.slice(4).trim(); }
    else if (line.startsWith(":28C:") || line.startsWith(":28:")) { if (cur) cur.statementNo = line.replace(/^:28C?:/, "").trim(); }
    else if ((line.startsWith(":60F:") || line.startsWith(":60M:")) && cur) { const m = RE_BAL.exec(line); if (m) { cur.openingDate = iso(m[2]!); cur.openingBalance = (m[1] === "D" ? -1 : 1) * Number(m[3]!.replace(",", ".")); } }
    else if ((line.startsWith(":62F:") || line.startsWith(":62M:")) && cur) { const m = RE_BAL.exec(line); if (m) { cur.closingDate = iso(m[2]!); cur.closingBalance = (m[1] === "D" ? -1 : 1) * Number(m[3]!.replace(",", ".")); } }
    else if (line.startsWith(":61:")) {
      if (pending && cur) { cur.txns.push(pending); pending = null; }
      const m = RE_61.exec(line);
      if (m && cur) {
        const bookMMDD = m[2];
        pending = {
          valueDate: iso(m[1]!),
          bookingDate: bookMMDD ? `20${m[1]!.slice(0, 2)}-${bookMMDD.slice(0, 2)}-${bookMMDD.slice(2, 4)}` : null,
          direction: m[3]!.replace("R", "") === "D" ? "out" : "in",
          amount: Number(m[5]!.replace(",", ".")),
          currency: "PLN",
          counterparty: null, counterpartyAccount: null, title: null,
          txType: m[6] ?? null,
          bankRef: (line.split("//")[1] || "").trim() || null,
        };
      }
    } else if (line.startsWith(":86:") && pending) {
      let raw = line.slice(4);
      while (i + 1 < lines.length && !/^:\d\d/.test(lines[i + 1]!)) raw += lines[++i];
      const p = parse86(raw);
      pending.counterparty = p.counterparty;
      pending.counterpartyAccount = p.counterpartyAccount;
      pending.title = p.title;
      pending.txType = [pending.txType, p.txType].filter(Boolean).join(" ") || null;
      cur!.txns.push(pending);
      pending = null;
    }
  }
  if (pending && cur) cur.txns.push(pending);
  if (cur) out.push(cur);
  // Some banks emit :62F: without an amount (e.g. credit accounts). The closing is
  // still fully determined by the document: opening + sum of the statement's entries.
  for (const st of out) {
    if (st.closingBalance == null && st.openingBalance != null) {
      const flow = st.txns.reduce((s, tx) => s + (tx.direction === "in" ? tx.amount : -tx.amount), 0);
      st.closingBalance = Math.round((st.openingBalance + flow) * 100) / 100;
      st.closingDerived = true; // chain-corrected against the next statement's opening after import
      if (!st.closingDate) st.closingDate = st.txns.length ? st.txns[st.txns.length - 1]!.valueDate : st.openingDate;
    }
  }
  return out;
}

// entity subfolder → company name; Kokos (separate business) and unknowns → null
export function matchCompanyName(folder: string): string | null {
  const u = folder.toUpperCase();
  if (u.includes("KOKOS")) return null;
  if (u.includes("ESO") || u.includes("OUTSOURCING")) return "ESO";
  if (u.includes("ESG") || u.includes("GROUP")) return "ES";
  if (u.includes("KLINEX")) return "Klinex";
  return null;
}

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

  logger.info({ files: result.files, imported: result.imported, skipped: result.skipped }, "bank statements sync done");
  return result;
}
