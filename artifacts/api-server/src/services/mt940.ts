// Pure MT940 layer of the bank-statements module: encoding detection, statement/
// transaction parsing and entity-folder → company matching. No I/O and no DB here —
// keeps it unit-testable; Drive traversal and persistence live in bankStatements.ts.
import iconv from "iconv-lite";

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
