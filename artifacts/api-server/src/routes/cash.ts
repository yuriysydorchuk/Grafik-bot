// Office cash box («Каса», /cash) — the office employee records safe movements here
// (instead of the legacy STAN KASY sheet). Gated by PAGE access, not viewFinance,
// so a non-finance role can fill it. Historical sheet rows are read-only (the sheet
// sync owns them); rows created here have tabName='manual' and are editable.
//
// Reconciliation against bank statements: withdrawals arrive in the bank as many
// small operations (e.g. 10×16 000) but the safe records one aggregated deposit
// (160 000) or a few (32k+64k+64k) — so matching is subset-sum in a date window,
// in BOTH directions, after exact 1:1 pairs are taken.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { cashEntriesTable, bankTransactionsTable, companiesTable } from "@workspace/db";
import { and, eq, gte, lte, asc, desc, inArray, isNull, sql } from "drizzle-orm";
import { authRequired, requirePage } from "../lib/auth";
import { BUCKET, periodRange, getExpenseCats, OWNER_KEYS } from "../services/bankClassify";

const router: IRouter = Router();
router.use(authRequired);
router.use(requirePage("/cash"));

const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, c: number, m: string) => res.status(c).json({ error: m });
const round2 = (n: number) => Math.round(n * 100) / 100;
const validDate = (d: any) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const MANUAL = "manual";

// Physical cash boxes: the office safe (sheet-synced, per firm) and the owners'
// reserve safes (company cash too, but not firm-specific → company_id NULL).
export const BOXES = ["office", "yuriy", "tetiana"] as const;
type Box = (typeof BOXES)[number];
const parseBox = (v: any): Box | undefined => (BOXES as readonly string[]).includes(String(v)) ? (String(v) as Box) : undefined;

// ── Outflow categories ─────────────────────────────────────────────────────────
// Same key set as the bank expense categories so a future cashflow can merge
// bank + cash per category; plus cash-only keys: deposit (put on the account,
// internal) and transfer (box↔box leg, internal). Auto-classified from the
// description text; manual_category wins when set. First match wins.
const CASH_AUTO: [key: string, re: RegExp][] = [
  ["deposit",      /ВПЛАЧЕНО НА РАХУНОК|WPLAC\w* NA RACHUNEK/i],
  ["marketing",    /DUBAI|REKRUT|TARGET|РЕКРУТ/i],
  ["salary",       /ЗАРПЛАТ|ZARPLAT|WYPLATA|ДЛЯ ПРАЦІВНИКІВ/i],
  ["zaliczki",     /ZALICZK|ЗАЛІЧК|АВАНС/i],
  ["permits",      /ДОВІДК|DOWIDK|MED DOK|DOKI|OSWIADCZEN|OŚWIADCZEN|STUD/i],
  ["services",     /ПОШТА|ЛИСТИ|POCZTA|DO.ADO.*TEL|ІНТЕРНЕТ/i],
  ["housing",      /HOSTEL|КВАРТИР|MIESZKAN|ЖИТЛО/i],
  ["travel",       /HOTEL|BILET|КВИТК|ПОЇЗДК/i],
  ["office_rent",  /PGE|СВІТЛО|PRAD|PRĄD|ОРЕНДА ОФІС/i],
  ["household",    /ZAKUPY|WYDATKI|BIUR|KANCELARI|OFFICE|ПРІНТЕР|PRINTER|ОФІСН/i],
  ["owner_roman",  /SHEF VZIAV|ROMA SHEF|ДЛЯ РОМАНА|DLA ROMANA/i],
  ["owner_yuriy",  /DLA YURY|ДЛЯ ЮРІЯ|DLA JURIJA/i],
  ["owner_tetiana",/DLA TANI|ДЛЯ ТЕТЯНИ|DLA TANIA/i],
];
export function cashCategory(e: { kind: string; description: string | null; transferGroup: string | null; manualCategory: string | null }): string | null {
  if (e.kind !== "out") return null;
  if (e.transferGroup) return "transfer";
  if (e.manualCategory) return e.manualCategory;
  const d = e.description ?? "";
  for (const [key, re] of CASH_AUTO) if (re.test(d)) return key;
  return "other";
}
// категорії каси = банківські (з БД) + owner_* + службові cash-only ключі
async function cashCatKeys(): Promise<Set<string>> {
  return new Set<string>([...(await getExpenseCats()).map(c => c.key), ...OWNER_KEYS, "other", "deposit"]);
}

// ── Ledger walk ────────────────────────────────────────────────────────────────
// Months ascending per firm: balance carries over; an explicit sheet opening row
// overrides the carry (and any gap between the two is a reported discrepancy).
export interface MonthLedger { month: string; opening: number; inflow: number; outflow: number; closing: number; openingExplicit: number | null; discrepancy: number; transferIn: number; transferOut: number }

// One ledger = one box for one firm (office) or one owner safe (companyId null).
async function ledgerFor(box: Box, companyId: number | null): Promise<MonthLedger[]> {
  const conds = [eq(cashEntriesTable.box, box)];
  if (companyId != null) conds.push(eq(cashEntriesTable.companyId, companyId));
  const entries = await db.select().from(cashEntriesTable)
    .where(and(...conds))
    .orderBy(asc(cashEntriesTable.periodMonth), asc(cashEntriesTable.sortIdx), asc(cashEntriesTable.id));
  const byMonth = new Map<string, { opening: number | null; inflow: number; outflow: number; transferIn: number; transferOut: number }>();
  for (const e of entries) {
    const m = byMonth.get(e.periodMonth) ?? { opening: null, inflow: 0, outflow: 0, transferIn: 0, transferOut: 0 };
    if (e.kind === "opening") m.opening = e.amount;          // last explicit opening of the month wins
    else if (e.kind === "in") { m.inflow += e.amount; if (e.transferGroup) m.transferIn += e.amount; }
    else if (e.kind === "out") { m.outflow += e.amount; if (e.transferGroup) m.transferOut += e.amount; }
    byMonth.set(e.periodMonth, m);
  }
  const months = [...byMonth.keys()].sort();
  const out: MonthLedger[] = [];
  let carry: number | null = null;
  for (const month of months) {
    const m = byMonth.get(month)!;
    const opening = m.opening ?? carry ?? 0;
    const discrepancy = m.opening != null && carry != null ? round2(m.opening - carry) : 0;
    const closing = round2(opening + m.inflow - m.outflow);
    out.push({ month, opening: round2(opening), inflow: round2(m.inflow), outflow: round2(m.outflow), closing, openingExplicit: m.opening != null ? round2(m.opening) : null, discrepancy, transferIn: round2(m.transferIn), transferOut: round2(m.transferOut) });
    carry = closing;
  }
  return out;
}

// Per-box cash snapshot at a month end — reused by the balance report.
export async function cashBoxesAt(toM: string): Promise<{ total: number; perBox: { box: string; closing: number }[] }> {
  const ledgers: { box: Box; companyId: number | null }[] = [];
  const firms = (await db.selectDistinct({ c: cashEntriesTable.companyId }).from(cashEntriesTable).where(eq(cashEntriesTable.box, "office"))).map(r => r.c).filter((x): x is number => x != null);
  ledgers.push(...firms.map(cid => ({ box: "office" as Box, companyId: cid })));
  for (const b of BOXES) if (b !== "office") ledgers.push({ box: b, companyId: null });
  const perBoxMap = new Map<string, number>();
  for (const lg of ledgers) {
    const ledger = await ledgerFor(lg.box, lg.companyId);
    const last = [...ledger].reverse().find(l => l.month <= toM);
    perBoxMap.set(lg.box, round2((perBoxMap.get(lg.box) ?? 0) + (last?.closing ?? 0)));
  }
  const perBox = [...perBoxMap.entries()].map(([box, closing]) => ({ box, closing }));
  return { total: round2(perBox.reduce((s, b) => s + b.closing, 0)), perBox };
}

// All-boxes cash position over a month range — reused by the cashflow report.
export async function cashPosition(fromM: string, toM: string): Promise<{ opening: number; closing: number }> {
  const ledgers: { box: Box; companyId: number | null }[] = [];
  const firms = (await db.selectDistinct({ c: cashEntriesTable.companyId }).from(cashEntriesTable).where(eq(cashEntriesTable.box, "office"))).map(r => r.c).filter((x): x is number => x != null);
  ledgers.push(...firms.map(cid => ({ box: "office" as Box, companyId: cid })));
  for (const b of BOXES) if (b !== "office") ledgers.push({ box: b, companyId: null });
  let opening = 0, closing = 0;
  for (const lg of ledgers) {
    const ledger = await ledgerFor(lg.box, lg.companyId);
    const prior = [...ledger].reverse().find(l => l.month < fromM);
    const inRange = ledger.filter(l => l.month >= fromM && l.month <= toM);
    opening += inRange.length ? inRange[0]!.opening : (prior?.closing ?? 0);
    closing += inRange.length ? inRange[inRange.length - 1]!.closing : (prior?.closing ?? 0);
  }
  return { opening: round2(opening), closing: round2(closing) };
}

// ── Summary for the picker (year or month, one box or all, one firm or all) ───
router.get("/cash/summary", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;
  const box = parseBox(req.query.box);
  const fromM = month ? `${year}-${month}` : `${year}-01`;
  const toM = month ? `${year}-${month}` : `${year}-12`;

  // which ledgers participate: office is per firm, owner safes are one each
  const ledgers: { box: Box; companyId: number | null }[] = [];
  if (!box || box === "office") {
    const firms = companyId
      ? [companyId]
      : (await db.selectDistinct({ c: cashEntriesTable.companyId }).from(cashEntriesTable).where(eq(cashEntriesTable.box, "office"))).map(r => r.c).filter((x): x is number => x != null);
    ledgers.push(...firms.map(cid => ({ box: "office" as Box, companyId: cid })));
  }
  // owner safes aren't firm-specific → they join "all boxes" view only without a firm filter
  const includeSafes = box ? box !== "office" : !companyId;
  if (includeSafes) for (const b of BOXES) if (b !== "office" && (!box || box === b)) ledgers.push({ box: b, companyId: null });

  let opening = 0, inflow = 0, outflow = 0, closing = 0, trIn = 0, trOut = 0;
  const boxTotals: Record<string, { opening: number; inflow: number; outflow: number; closing: number }> = {};
  const discrepancies: { box: Box; companyId: number | null; month: string; expected: number; entered: number; diff: number }[] = [];
  for (const lg of ledgers) {
    const ledger = await ledgerFor(lg.box, lg.companyId);
    const prior = [...ledger].reverse().find(l => l.month < fromM); // carry into the period when it has no own months
    const inRange = ledger.filter(l => l.month >= fromM && l.month <= toM);
    const o = inRange.length ? inRange[0]!.opening : (prior?.closing ?? 0);
    const c = inRange.length ? inRange[inRange.length - 1]!.closing : (prior?.closing ?? 0);
    let inf = 0, outf = 0;
    for (const l of inRange) {
      inf += l.inflow; outf += l.outflow; trIn += l.transferIn; trOut += l.transferOut;
      if (Math.abs(l.discrepancy) > 1) discrepancies.push({ box: lg.box, companyId: lg.companyId, month: l.month, expected: round2(l.openingExplicit! - l.discrepancy), entered: l.openingExplicit!, diff: l.discrepancy });
    }
    opening += o; closing += c; inflow += inf; outflow += outf;
    const bt = boxTotals[lg.box] ?? (boxTotals[lg.box] = { opening: 0, inflow: 0, outflow: 0, closing: 0 });
    bt.opening = round2(bt.opening + o); bt.inflow = round2(bt.inflow + inf); bt.outflow = round2(bt.outflow + outf); bt.closing = round2(bt.closing + c);
  }
  // in the consolidated view both legs of a box↔box transfer are present — they are
  // internal moves, not real cash in/out, so the totals exclude them
  const consolidated = !box && !companyId;
  if (consolidated) { inflow -= trIn; outflow -= trOut; }
  ok(res, {
    year, month: month ?? null, companyId, box: box ?? null,
    opening: round2(opening), inflow: round2(inflow), outflow: round2(outflow), closing: round2(closing),
    boxTotals,
    discrepancies,
  });
});

// ── Entries (list + CRUD; manual rows only are writable) ──────────────────────
router.get("/cash/entries", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;
  const box = parseBox(req.query.box);
  const conds = [gte(cashEntriesTable.periodMonth, month ? `${year}-${month}` : `${year}-01`), lte(cashEntriesTable.periodMonth, month ? `${year}-${month}` : `${year}-12`)];
  if (companyId) conds.push(eq(cashEntriesTable.companyId, companyId));
  if (box) conds.push(eq(cashEntriesTable.box, box));
  const rows = await db.select().from(cashEntriesTable).where(and(...conds))
    .orderBy(desc(cashEntriesTable.periodMonth), desc(cashEntriesTable.entryDate), desc(cashEntriesTable.sortIdx), desc(cashEntriesTable.id)).limit(1000);
  ok(res, { rows: rows.map(r => ({ ...r, editable: r.tabName === MANUAL, category: cashCategory(r) })) });
});

// category is OUR metadata, so it is settable on sheet rows too (unlike content)
router.patch("/cash/entries/:id/category", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(cashEntriesTable).where(eq(cashEntriesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (row.kind !== "out") return fail(res, 400, "категорія лише для видатків");
  if (row.transferGroup) return fail(res, 400, "переміщення не категоризується");
  const category = req.body?.category ?? null; // null → reset to auto
  if (category != null && !(await cashCatKeys()).has(String(category))) return fail(res, 400, "unknown category");
  const [updated] = await db.update(cashEntriesTable).set({ manualCategory: category }).where(eq(cashEntriesTable.id, id)).returning();
  ok(res, { ...updated, category: cashCategory(updated!) });
});

router.post("/cash/entries", async (req, res) => {
  const { companyId, entryDate, kind, amount, description, note } = req.body ?? {};
  const box = parseBox(req.body?.box) ?? "office";
  // office entries belong to a firm; owner safes hold company cash without a firm.
  // Owner safes have no sheet history, so an explicit opening (inventory count) is allowed.
  if (box === "office" && !companyId) return fail(res, 400, "companyId required");
  const kinds = box === "office" ? ["in", "out"] : ["in", "out", "opening"];
  if (!kinds.includes(kind)) return fail(res, 400, `kind must be ${kinds.join("|")}`);
  if (!validDate(entryDate)) return fail(res, 400, "entryDate must be YYYY-MM-DD");
  const amt = Number(String(amount ?? "").replace(",", "."));
  if (!Number.isFinite(amt) || amt < 0 || (kind !== "opening" && amt <= 0)) return fail(res, 400, "amount must be > 0");
  if (box === "office") {
    const [co] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, Number(companyId)));
    if (!co) return fail(res, 400, "unknown company");
  }
  const [row] = await db.insert(cashEntriesTable).values({
    box, companyId: box === "office" ? Number(companyId) : null,
    periodMonth: String(entryDate).slice(0, 7), entryDate: String(entryDate),
    kind, amount: amt, description: description ? String(description).trim() : null, note: note ? String(note).trim() : null,
    tabName: MANUAL, sortIdx: Math.floor(Date.now() / 1000),
  }).returning();
  ok(res, row);
});

router.patch("/cash/entries/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(cashEntriesTable).where(eq(cashEntriesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (row.tabName !== MANUAL) return fail(res, 400, "записи з таблиці — лише для читання (редагуйте в Google Sheet)");
  if (row.transferGroup) return fail(res, 400, "переміщення не редагується — видаліть його і створіть заново");
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.entryDate !== undefined) {
    if (!validDate(b.entryDate)) return fail(res, 400, "entryDate must be YYYY-MM-DD");
    patch.entryDate = String(b.entryDate); patch.periodMonth = String(b.entryDate).slice(0, 7);
  }
  const kinds = row.box === "office" ? ["in", "out"] : ["in", "out", "opening"];
  if (b.kind !== undefined) { if (!kinds.includes(b.kind)) return fail(res, 400, `kind must be ${kinds.join("|")}`); patch.kind = b.kind; }
  if (b.amount !== undefined) {
    const amt = Number(String(b.amount).replace(",", "."));
    const kind = (patch.kind as string) ?? row.kind;
    if (!Number.isFinite(amt) || amt < 0 || (kind !== "opening" && amt <= 0)) return fail(res, 400, "amount must be > 0");
    patch.amount = amt;
  }
  if (b.description !== undefined) patch.description = b.description ? String(b.description).trim() : null;
  if (b.note !== undefined) patch.note = b.note ? String(b.note).trim() : null;
  if (!Object.keys(patch).length) return fail(res, 400, "nothing to update");
  const [updated] = await db.update(cashEntriesTable).set(patch).where(eq(cashEntriesTable.id, id)).returning();
  ok(res, updated);
});

router.delete("/cash/entries/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return fail(res, 400, "bad id");
  const [row] = await db.select().from(cashEntriesTable).where(eq(cashEntriesTable.id, id));
  if (!row) return fail(res, 404, "not found");
  if (row.tabName !== MANUAL) return fail(res, 400, "записи з таблиці — лише для читання");
  // a transfer is one operation with two legs — deleting either removes both
  if (row.transferGroup) await db.delete(cashEntriesTable).where(eq(cashEntriesTable.transferGroup, row.transferGroup));
  else await db.delete(cashEntriesTable).where(eq(cashEntriesTable.id, id));
  ok(res, { ok: true });
});

// ── Transfers: box ↔ box (paired internal legs) or box ↔ bank (single leg) ────
const BOX_UA: Record<string, string> = { office: "Каса офісу", yuriy: "Сейф Юрія", tetiana: "Сейф Тетяни", bank: "Рахунок" };
router.post("/cash/transfer", async (req, res) => {
  const { from, to, companyId, entryDate, amount, note } = req.body ?? {};
  const sides = [...BOXES, "bank"];
  if (!sides.includes(from) || !sides.includes(to)) return fail(res, 400, "from/to must be office|yuriy|tetiana|bank");
  if (from === to) return fail(res, 400, "from and to must differ");
  if (from === "bank" && to === "bank") return fail(res, 400, "bank↔bank is not a cash transfer");
  if (!validDate(entryDate)) return fail(res, 400, "entryDate must be YYYY-MM-DD");
  const amt = Number(String(amount ?? "").replace(",", "."));
  if (!Number.isFinite(amt) || amt <= 0) return fail(res, 400, "amount must be > 0");
  const officeInvolved = from === "office" || to === "office";
  if (officeInvolved && !companyId) return fail(res, 400, "companyId required for the office leg");

  const base = {
    periodMonth: String(entryDate).slice(0, 7), entryDate: String(entryDate), amount: amt,
    note: note ? String(note).trim() : null, tabName: MANUAL, sortIdx: Math.floor(Date.now() / 1000),
  };
  const legCompany = (b: string) => (b === "office" ? Number(companyId) : null);
  const rows: (typeof cashEntriesTable.$inferInsert)[] = [];
  if (from !== "bank" && to !== "bank") {
    // internal move between our boxes: two linked legs that cancel out in totals
    const group = `tr${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    rows.push({ ...base, box: from, companyId: legCompany(from), kind: "out", transferGroup: group, description: `Переміщення → ${BOX_UA[to]}` });
    rows.push({ ...base, box: to, companyId: legCompany(to), kind: "in", transferGroup: group, description: `Переміщення ← ${BOX_UA[from]}` });
  } else if (to === "bank") {
    // cash deposited to the account: the counterpart arrives with the bank statement
    rows.push({ ...base, box: from, companyId: legCompany(from), kind: "out", description: "Вплачено на рахунок" });
  } else {
    // cash withdrawn from the account into a box
    rows.push({ ...base, box: to, companyId: legCompany(to), kind: "in", description: "Знято з карти" });
  }
  const created = await db.insert(cashEntriesTable).values(rows).returning();
  ok(res, { rows: created });
});

// ── Reconciliation kasa ↔ bank ────────────────────────────────────────────────
// Bank cash withdrawals vs kasa "in" entries, per firm. Steps: exact 1:1 in a date
// window → subset of bank ops summing to one kasa entry → subset of kasa entries
// summing to one bank op. Remaining are reported unmatched on both sides.
type Item = { id: number; date: string; amount: number };
const dayDiff = (a: string, b: string) => Math.abs((new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / 86400000);
const WINDOW = 7; // days

// find a subset of `cands` summing to `target` (amounts in grosze); small n → DFS with pruning
function findSubset(cands: Item[], target: number): Item[] | null {
  const items = cands.slice(0, 28).sort((a, b) => b.amount - a.amount);
  const t = Math.round(target * 100);
  const amounts = items.map(i => Math.round(i.amount * 100));
  const suffix: number[] = new Array(items.length + 1).fill(0);
  for (let i = items.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + amounts[i]!;
  const picked: number[] = [];
  const dfs = (i: number, rest: number): boolean => {
    if (rest === 0) return true;
    if (i >= items.length || rest < 0 || suffix[i]! < rest) return false;
    picked.push(i);
    if (dfs(i + 1, rest - amounts[i]!)) return true;
    picked.pop();
    return dfs(i + 1, rest);
  };
  return dfs(0, t) ? picked.map(i => items[i]!) : null;
}

export async function reconcileCash(year: string, month: string | undefined, companyId: number | null) {
  const [from, to] = periodRange(year, month);
  // fetch with a margin so boundary items can still find partners
  const margin = (d: string, days: number) => new Date(new Date(d + "T00:00:00Z").getTime() + days * 86400000).toISOString().slice(0, 10);
  const coCond = companyId ? sql`AND company_id = ${companyId}` : sql``;

  const bankRows = await db.execute(sql`
    SELECT id, company_id, value_date::text AS d, amount FROM bank_transactions
    WHERE ${sql.raw(BUCKET.cash!)} AND value_date >= ${margin(from, -WINDOW)} AND value_date <= ${margin(to, WINDOW)} ${coCond}`);
  // only the office safe reconciles against bank withdrawals (owner safes are fed from
  // the kasa); box↔box transfer legs have no bank counterpart by definition
  const cashConds = [eq(cashEntriesTable.box, "office"), isNull(cashEntriesTable.transferGroup), gte(cashEntriesTable.periodMonth, margin(from, -WINDOW).slice(0, 7)), lte(cashEntriesTable.periodMonth, margin(to, WINDOW).slice(0, 7)), eq(cashEntriesTable.kind, "in")];
  if (companyId) cashConds.push(eq(cashEntriesTable.companyId, companyId));
  const cashRows = await db.select().from(cashEntriesTable).where(and(...cashConds));

  const matchedBank = new Set<number>();
  const matchedCash = new Set<number>();
  const firms = new Set<number>();
  const bankBy = new Map<number, Item[]>();
  for (const r of (bankRows as any).rows ?? (bankRows as any)) {
    const cid = Number(r.company_id ?? 0); firms.add(cid);
    (bankBy.get(cid) ?? bankBy.set(cid, []).get(cid)!).push({ id: Number(r.id), date: String(r.d), amount: Number(r.amount) });
  }
  const cashBy = new Map<number, (Item & { pm: string })[]>();
  for (const e of cashRows) {
    const cid = e.companyId ?? 0; firms.add(cid);
    // typo guard: a date wildly outside its sheet tab month (wrong year etc.) would
    // break matching and fall out of the period — fall back to mid-month of the tab
    const mid = `${e.periodMonth}-15`;
    const date = e.entryDate && dayDiff(e.entryDate, mid) <= 60 ? e.entryDate : mid;
    (cashBy.get(cid) ?? cashBy.set(cid, []).get(cid)!).push({ id: e.id, date, amount: e.amount, pm: e.periodMonth });
  }

  for (const cid of firms) {
    const bank = (bankBy.get(cid) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const kasa = (cashBy.get(cid) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    // 1) exact 1:1
    for (const k of kasa) {
      const b = bank.find(x => !matchedBank.has(x.id) && Math.abs(x.amount - k.amount) < 0.005 && dayDiff(x.date, k.date) <= WINDOW);
      if (b) { matchedBank.add(b.id); matchedCash.add(k.id); }
    }
    // 2) many bank ops → one kasa entry
    for (const k of kasa) {
      if (matchedCash.has(k.id)) continue;
      const cands = bank.filter(x => !matchedBank.has(x.id) && dayDiff(x.date, k.date) <= WINDOW);
      const subset = findSubset(cands, k.amount);
      if (subset) { subset.forEach(s => matchedBank.add(s.id)); matchedCash.add(k.id); }
    }
    // 3) many kasa entries → one bank op
    for (const b of bank) {
      if (matchedBank.has(b.id)) continue;
      const cands = kasa.filter(x => !matchedCash.has(x.id) && dayDiff(x.date, b.date) <= WINDOW);
      const subset = findSubset(cands, b.amount);
      if (subset) { subset.forEach(s => matchedCash.add(s.id)); matchedBank.add(b.id); }
    }
  }

  // report only items inside the requested period; kasa belongs to a period by its
  // sheet tab (period_month) — same rule as the entries list and summary
  const inPeriod = (d: string) => d >= from && d <= to;
  const pmInPeriod = (pm: string) => pm >= from.slice(0, 7) && pm <= to.slice(0, 7);
  const unmatchedBank: { id: number; date: string; amount: number }[] = [];
  const unmatchedCash: { id: number; date: string; amount: number }[] = [];
  // period totals for the net line: matched pairs cancel exactly, but boundary
  // matches (partner outside the period) skew the unmatched net — full sums don't
  let bankTotal = 0, cashTotal = 0;
  for (const list of bankBy.values()) for (const b of list) if (inPeriod(b.date)) {
    bankTotal += b.amount;
    if (!matchedBank.has(b.id)) unmatchedBank.push(b);
  }
  for (const list of cashBy.values()) for (const k of list) if (pmInPeriod(k.pm)) {
    cashTotal += k.amount;
    if (!matchedCash.has(k.id)) unmatchedCash.push(k);
  }
  return {
    unmatchedBankIds: unmatchedBank.map(b => b.id),
    unmatchedBankTotal: round2(unmatchedBank.reduce((s, b) => s + b.amount, 0)),
    unmatchedCashIds: unmatchedCash.map(k => k.id),
    unmatchedCashTotal: round2(unmatchedCash.reduce((s, k) => s + k.amount, 0)),
    bankTotal: round2(bankTotal),
    cashTotal: round2(cashTotal),
  };
}

router.get("/cash/reconcile", async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : undefined;
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;
  ok(res, { year, month: month ?? null, companyId, ...(await reconcileCash(year, month, companyId)) });
});

// active firms for the picker (page-gated users can't call /bank/meta)
router.get("/cash/meta", async (_req, res) => {
  const ids = (await db.selectDistinct({ c: cashEntriesTable.companyId }).from(cashEntriesTable)).map(r => r.c).filter((x): x is number => x != null);
  const all = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.isActive, true));
  // include active firms even before their first entry (a new firm must be selectable)
  const companies = all.filter(c => ids.includes(c.id) || ["ES", "ESO", "Klinex"].includes(c.name));
  const years = (await db.execute(sql`SELECT DISTINCT left(period_month, 4) AS y FROM cash_entries ORDER BY 1 DESC`)) as any;
  ok(res, { companies, years: ((years.rows ?? years) as any[]).map(r => String(r.y)), boxes: BOXES });
});

export default router;
