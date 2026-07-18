// Bank-transaction classification — the SINGLE SOURCE OF TRUTH for how raw
// bank_transactions rows become buckets (income / expenses / cash / owners) and
// expense categories. Imported by routes/bank.ts (dashboards) and routes/cash.ts
// (cash-register reconciliation) so both always agree.
//
// Postgres notes: word boundary is \\y (NOT \\b); Polish declensions are matched by
// stem (BANKOMA covers bankomat/bankomacie).

// ── Classification (SQL, single source of truth) ──────────────────────────────
export const TXT = `upper(coalesce(counterparty,'')||' '||coalesce(title,'')||' '||coalesce(tx_type,''))`;
// own-account moves; unnamed bare "Przelew" rows are verified inter-bank transfers
// (each has a mirror EUROSUPPORT credit on another of our accounts within ±3 days)
export const T_INTERNAL = `(${TXT} ~ 'EUROSUPPORT|EURO SUPPORT|KLINEX|PRZELEW W.ASN|BETWEEN YOUR OWN' OR (counterparty IS NULL AND coalesce(title,'') = 'Przelew'))`;
// outgoing split-payment VAT auto-move (mirror of a client's MPP payment); the bank
// sometimes strips the /VAT//IDC markers leaving only a date-like title
export const T_VATSPLIT_OUT = `((${TXT} ~ '/VAT/' AND ${TXT} ~ '/IDC/') OR (counterparty IS NULL AND tx_type IS NULL AND title ~ '^[0-9/.]+ ES-?\\.?\\s*$'))`;
// owner payouts (transfers to the Sydorchuk family incl. their salaries); excluded:
// card spending AND bank charges that merely mention the cardholder's name
// (e.g. "MIESIĘCZNA OPŁATA ZA OBSŁUGĘ KARTY YURIY SYDORCHUK" is a fee, not a payout)
export const T_CARDOP = `${TXT} ~ 'BEZGOT|KART. DEBET|535472|OP.ATA|OPLATA|PROWIZ'`;
export const T_OWNER_ROMAN = `(${TXT} ~ 'SYDORCZUK ROMAN|ROMAN SYDORCZUK|SYDORCHUK ROMAN|ROMAN SYDORCHUK' AND NOT ${T_CARDOP})`;
// Tetiana's payouts also include transfers for Sydorczuk Daniel (owner's decision)
export const T_OWNER_TETIANA = `(${TXT} ~ 'SYDORCZUK TETIANA|TETIANA SYDORCZUK|SYDORCHUK TETIANA|TETIANA SYDORCHUK|SYDORCZUK TATIANA|TATIANA SYDORCZUK|SYDORCZUK DANIEL|DANIEL SYDORCZUK|SYDORCHUK DANIEL|DANIEL SYDORCHUK' AND NOT ${T_CARDOP})`;
export const T_OWNER_YURIY = `(${TXT} ~ 'SYDORCZUK YURI|YURI. SYDORCZUK|SYDORCHUK YURI|YURI. SYDORCHUK' AND NOT ${T_CARDOP})`;
export const T_OWNER_ANY = `(${T_OWNER_ROMAN} OR ${T_OWNER_TETIANA} OR ${T_OWNER_YURIY})`;
export const T_VATREF = `${TXT} ~ 'SKARBOW|URZ.D SKARB'`;                                         // tax-office VAT refund
// VAT split-payment rebooking between our own VAT & settlement accounts (A87
// "PRZEKSIĘGOWANIE VAT MPP") and incoming /SFP/ tax-form postings — not real income.
export const T_VATMOVE = `(${TXT} ~ 'PRZEKS' OR ${TXT} ~ '/SFP/')`;
// cash withdrawal (not cashless card); the bank's withdrawal COMMISSION also mentions
// "gotówki" but is a company cost, not withdrawn cash → routed to the fees category
export const T_CASH = `((${TXT} ~ 'BANKOMA' OR (${TXT} ~ 'GOT.WK' AND ${TXT} !~ 'BEZGOT')) AND ${TXT} !~ 'PROWIZ|OP.ATA')`;
export const T_CASHDEP = `(${TXT} ~ 'WP.ATOMA' OR ${TXT} ~ 'ITCARD')`;                            // own cash deposited via a cash-deposit machine (ITCARD)
// salary transfers: "Wynagrodzenie za MM.YYYY" + umowa-zlecenie invoices ("RACHUNEK … DO UMOWY")
export const T_SALARY = `(${TXT} ~ 'WYNAGRODZ|PENSJ' OR (${TXT} ~ 'RACHUNEK' AND ${TXT} ~ 'UMOW'))`;
// The bank-credit account is debt, not operating cash: its inflows are our own
// loan repayments (real expense = the outgoing transfer from the main account) and
// the bank charges interest on it without :61: entries. Exclude it from operating
// buckets and balances entirely.
export const CREDIT_ACCOUNTS = `coalesce(account,'') IN ('PL75109025900000000158258415')`;
export const OPER = `NOT ${CREDIT_ACCOUNTS}`;
// Manual override (bank_transactions.manual_category): the owner can move an expense
// transaction to any category or mark it personal (owner_*). Override wins over the
// automatic patterns everywhere below.
export const OWNER_KEYS = ["owner_roman", "owner_tetiana", "owner_yuriy"] as const;
export const MC = `manual_category`;
const ownerBucket = (key: string, auto: string) =>
  `${OPER} AND direction='out' AND NOT (${T_INTERNAL}) AND NOT (${T_CASH}) AND ((${MC} = '${key}') OR (${MC} IS NULL AND ${auto}))`;
export const BUCKET: Record<string, string> = {
  income: `${OPER} AND direction='in' AND NOT (${T_INTERNAL}) AND NOT (${T_VATREF}) AND NOT (${T_VATMOVE}) AND NOT (${T_CASHDEP})`,
  // expenses INCLUDE salaries (they show as a category in the breakdown);
  // owner payouts stay separate; PRZEKS + outgoing VAT-split legs are internal VAT moves
  expenses: `${OPER} AND direction='out' AND NOT (${T_INTERNAL}) AND NOT (${T_CASH}) AND NOT (${TXT} ~ 'PRZEKS') AND NOT (${T_VATSPLIT_OUT})
    AND ((${MC} IS NULL AND NOT (${T_OWNER_ANY})) OR (${MC} IS NOT NULL AND ${MC} NOT IN ('owner_roman','owner_tetiana','owner_yuriy')))`,
  cash: `${OPER} AND direction='out' AND (${T_CASH})`,
  cashdep: `${OPER} AND direction='in' AND (${T_CASHDEP})`,
  owner_roman: ownerBucket("owner_roman", T_OWNER_ROMAN),
  owner_tetiana: ownerBucket("owner_tetiana", T_OWNER_TETIANA),
  owner_yuriy: ownerBucket("owner_yuriy", T_OWNER_YURIY),
};
// combined cash movement (withdrawals + deposits) for the «Готівковий рух» drill-down
BUCKET.cashmove = `((${BUCKET.cash}) OR (${BUCKET.cashdep}))`;

// ── Expense categories (DB-driven, owner-editable) ────────────────────────────
// Categories live in the `expense_categories` table (seeded by migration
// 2026-07-15 from the historical hardcoded list). Every `expenses` transaction
// falls into exactly one category: manual_category wins; otherwise the first
// matching pattern by sort_order (order matters — e.g. a card payment at ORLEN
// is fuel, not "card"). Unmatched → "other" (virtual, not in the table).
//
// `pattern` mini-DSL: each line is an OR-alternative; terms joined by " + "
// within a line must ALL match; each term is a Postgres regex evaluated against
// TXT. Single quotes are escaped on composition, so a pattern can never break
// out of the SQL literal.
export type ExpenseCat = { id: number; key: string; label: string; pattern: string | null; sortOrder: number };

export function patternCondition(pattern: string): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const ors = pattern.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
    const ands = line.split(" + ").map(t => t.trim()).filter(Boolean).map(t => `${TXT} ~ '${esc(t)}'`);
    return ands.length > 1 ? `(${ands.join(" AND ")})` : ands[0]!;
  });
  if (ors.length === 0) return "FALSE";
  return ors.length > 1 ? `(${ors.join(" OR ")})` : `(${ors[0]!})`;
}

// Seed list — the single source for the migration, the test harness and the labels
// that existed before categories moved to the DB. NOT read at runtime.
export const DEFAULT_EXPENSE_CATS: { key: string; label: string; pattern: string }[] = [
  { key: "zus", label: "ZUS", pattern: "ZUS|ZAK.AD UB|SK.ADKA" },
  { key: "vat", label: "Податки (VAT, US)", pattern: "SKARBOW|/SFP/|VAT-7" },
  { key: "seizure", label: "Зайняття (komornik)", pattern: "EGZEKUC|KOMORNIK|ZAJ.CIE|CA. Z\\." },
  { key: "salary", label: "Зарплати", pattern: "WYNAGRODZ|PENSJ\nRACHUNEK + UMOW" },
  { key: "zaliczki", label: "Аванси (zaliczki)", pattern: "ZALICZK" },
  // all bank commissions in one place: transfers, deposits, cash withdrawals,
  // account/card/package maintenance, e-banking (GOonline), ELIXIR transfer fees
  { key: "fees", label: "Комісії банку (перекази, вплати, зняття)", pattern: "PROWIZ|PROW-PRZEL|C38|OP.ATA ZA PROWADZENIE|OP..MIES|OP.ATA MIESI|ZA OBS.UG|WEWN.TRZNE OBCI..ENIE|OP.ATA ZA PRZELEW|OP.ATA ZA RACHUNEK|GOONLINE" },
  { key: "fuel", label: "Паливо", pattern: "ORLEN|SHELL|CIRCLE K|LOTOS|MOYA|AMIC|PALIW|STACJA PALIW" },
  { key: "housing", label: "Житло / готелі", pattern: "BLUERENT|HOUSE POLAND|HOSTEL|GIMIK|BARTKOWIAK|ZALEWSKA|FSDW|NOCLEG|APART|MIESZKAN|CZYNSZ|NAJEM" },
  { key: "car_repair", label: "Ремонт авто", pattern: "TECHNO HOUSE|ANDRII BOIKO|BOIKO ANDRII" },
  { key: "office_rent", label: "Оренда офісу", pattern: "ODROW..-PIENI|PIENI..EK" },
  { key: "clothing", label: "Одяг", pattern: "\\yULAN\\y" },
  { key: "multisport", label: "Мультиспорт (Benefit)", pattern: "BENEFIT" },
  { key: "trainer", label: "Тренер (Palusiński)", pattern: "PALUSI.SKI|PALUSINSKI" },
  { key: "leasing", label: "Лізинг / авто", pattern: "LEASING|VOLKSWAGEN|SANTANDER CONSUMER|AUDI|TOYOTA" },
  { key: "credit", label: "Кредит", pattern: "KREDYT|SP.ATA KAPITA|SP.ATA ODSET" },
  { key: "services", label: "Послуги (бух., юристи)", pattern: "TKM|RACHUNKOW|KANCELARIA|ADWOKA|NOTARI|ONESOFT|LUXMED|MEDYCZN" },
  { key: "marketing", label: "Маркетинг", pattern: "FB\\.|FACEBOOK|FACEBK|GOOGLE|TIKTOK|OLX|FREELINE|META PLATFORM|OTOMOTO" },
  { key: "permits", label: "Дозволи / уряд", pattern: "WOJEWODZKI|WOJEW.DZKI|ZEZWOLEN|OP.ATA SKARBOWA" },
  { key: "b2b", label: "Підрядники B2B", pattern: "ANDROSHCHUK|SIMONIAN" },
  // card purchases by merchant type (cash withdrawals by card are NOT here — they're in the cash bucket)
  { key: "taxi", label: "Таксі (Bolt, Uber)", pattern: "\\yBOLT\\y|BOLT\\.EU|\\yUBER\\y|FREENOW|ITAXI" },
  { key: "travel", label: "Подорожі / відрядження", pattern: "AIRBNB|BOOKI|KIWI\\.COM|GOTOGATE|RAINBOW|HOTEL|GETYOURGUIDE|RYANAIR|WIZZ|\\yLOT\\y|BKG-|ESKY|INTERCITY|BILET\\.|DISCOVERCARS" },
  { key: "shops", label: "Магазини (продукти)", pattern: "ZABKA|.ABKA|BIEDRONKA|LIDL|AUCHAN|CARREFOUR|KAUFLAND|PEPCO|ACTION|DEALZ|STOKROTKA|LEWIATAN|TRANSGOURMET" },
  { key: "tech", label: "Техніка / електроніка", pattern: "X-KOM|MEDIA MARKT|MEDIA SATURN|EURO-NET|KOMPUTRONIK|SMARTSPOT|RTV EURO|APPLE|ALLEGRO" },
  { key: "household", label: "Госптовари / буд", pattern: "\\yOBI\\y|BRICOMAN|CASTORAMA|LEROY|JYSK|IKEA|STALPOL|TEDI|SUPERHOBBY|DEDRA|DOMATOR|MAT[- ]?BUD|\\yPSB\\y|MR.WKA|BUDOWLAN|HURTOWNIA|MERKURY|BUDMAT" },
  { key: "card", label: "Інші карткові", pattern: "BEZGOT|KART. DEBET" },
];

// In-memory cache of the category list — this is a single-process app, so
// invalidating on every category mutation keeps it correct.
let catsCache: ExpenseCat[] | null = null;
export async function getExpenseCats(): Promise<ExpenseCat[]> {
  if (!catsCache) {
    const { db, expenseCategoriesTable } = await import("@workspace/db");
    const { asc } = await import("drizzle-orm");
    const rows = await db.select().from(expenseCategoriesTable)
      .orderBy(asc(expenseCategoriesTable.sortOrder), asc(expenseCategoriesTable.id));
    catsCache = rows.map(r => ({ id: r.id, key: r.key, label: r.label, pattern: r.pattern, sortOrder: r.sortOrder }));
  }
  return catsCache;
}
export function invalidateExpenseCats() { catsCache = null; }

// per-category exclusive condition: manual override wins; otherwise first matching
// pattern; a pattern-less (manual-only) category is reachable only via override
export function catCondition(key: string, cats: ExpenseCat[]): string | null {
  const base = BUCKET.expenses!;
  const esc = (s: string) => s.replace(/'/g, "''");
  if (key === "other") {
    const pats = cats.filter(c => c.pattern).map(c => patternCondition(c.pattern!));
    const notAuto = pats.length ? ` AND NOT (${pats.join(" OR ")})` : "";
    return `${base} AND (${MC} = 'other' OR (${MC} IS NULL${notAuto}))`;
  }
  const idx = cats.findIndex(c => c.key === key);
  if (idx < 0) return null;
  const cat = cats[idx]!;
  const manual = `${MC} = '${esc(cat.key)}'`;
  if (!cat.pattern) return `${base} AND ${manual}`;
  const earlier = cats.slice(0, idx).filter(c => c.pattern).map(c => patternCondition(c.pattern!)).join(" OR ");
  return `${base} AND (${manual} OR (${MC} IS NULL AND ${patternCondition(cat.pattern)}${earlier ? ` AND NOT (${earlier})` : ""}))`;
}

// CASE expression labelling every expenses row with its category key
export function catCaseExpr(cats: ExpenseCat[]): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const whens = cats.filter(c => c.pattern).map(c => `WHEN ${patternCondition(c.pattern!)} THEN '${esc(c.key)}'`).join(" ");
  return `CASE WHEN ${MC} IS NOT NULL THEN ${MC}${whens ? ` ${whens}` : ""} ELSE 'other' END`;
}

// period (year or year+month) → [from, to] ISO date strings
export function periodRange(year: string, month?: string): [string, string] {
  if (month && /^(0[1-9]|1[0-2])$/.test(month)) {
    const last = new Date(Number(year), Number(month), 0).getDate();
    return [`${year}-${month}-01`, `${year}-${month}-${last}`];
  }
  return [`${year}-01-01`, `${year}-12-31`];
}

