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

// ── Expense categories ────────────────────────────────────────────────────────
// Every `expenses` transaction falls into exactly one category: first matching
// pattern wins (order matters — e.g. a card payment at ORLEN is fuel, not "card").
// Unmatched → "other". Assignments confirmed against the company's cost registers.
export const EXPENSE_CATS: [key: string, pattern: string][] = [
  ["zus", `${TXT} ~ 'ZUS|ZAK.AD UB|SK.ADKA'`],
  ["vat", `${TXT} ~ 'SKARBOW|/SFP/|VAT-7'`],
  ["seizure", `${TXT} ~ 'EGZEKUC|KOMORNIK|ZAJ.CIE|CA. Z\\.'`],
  ["salary", T_SALARY],
  ["zaliczki", `${TXT} ~ 'ZALICZK'`],
  // all bank commissions in one place: transfers, deposits, cash withdrawals,
  // account/card/package maintenance, e-banking (GOonline), ELIXIR transfer fees
  ["fees", `${TXT} ~ 'PROWIZ|PROW-PRZEL|C38|OP.ATA ZA PROWADZENIE|OP..MIES|OP.ATA MIESI|ZA OBS.UG|WEWN.TRZNE OBCI..ENIE|OP.ATA ZA PRZELEW|OP.ATA ZA RACHUNEK|GOONLINE'`],
  ["fuel", `${TXT} ~ 'ORLEN|SHELL|CIRCLE K|LOTOS|MOYA|AMIC|PALIW|STACJA PALIW'`],
  ["housing", `${TXT} ~ 'BLUERENT|HOUSE POLAND|HOSTEL|GIMIK|BARTKOWIAK|ZALEWSKA|FSDW|NOCLEG|APART|MIESZKAN|CZYNSZ|NAJEM'`],
  ["car_repair", `${TXT} ~ 'TECHNO HOUSE|ANDRII BOIKO|BOIKO ANDRII'`],
  ["office_rent", `${TXT} ~ 'ODROW..-PIENI|PIENI..EK'`],
  ["clothing", `${TXT} ~ '\\yULAN\\y'`],
  ["multisport", `${TXT} ~ 'BENEFIT'`],
  ["trainer", `${TXT} ~ 'PALUSI.SKI|PALUSINSKI'`],
  ["leasing", `${TXT} ~ 'LEASING|VOLKSWAGEN|SANTANDER CONSUMER|AUDI|TOYOTA'`],
  ["credit", `${TXT} ~ 'KREDYT|SP.ATA KAPITA|SP.ATA ODSET'`],
  ["services", `${TXT} ~ 'TKM|RACHUNKOW|KANCELARIA|ADWOKA|NOTARI|ONESOFT|LUXMED|MEDYCZN'`],
  ["marketing", `${TXT} ~ 'FB\\.|FACEBOOK|FACEBK|GOOGLE|TIKTOK|OLX|FREELINE|META PLATFORM|OTOMOTO'`],
  ["permits", `${TXT} ~ 'WOJEWODZKI|WOJEW.DZKI|ZEZWOLEN|OP.ATA SKARBOWA'`],
  ["b2b", `${TXT} ~ 'ANDROSHCHUK|SIMONIAN'`],
  // card purchases by merchant type (cash withdrawals by card are NOT here — they're in the cash bucket)
  ["taxi", `${TXT} ~ '\\yBOLT\\y|BOLT\\.EU|\\yUBER\\y|FREENOW|ITAXI'`],
  ["travel", `${TXT} ~ 'AIRBNB|BOOKI|KIWI\\.COM|GOTOGATE|RAINBOW|HOTEL|GETYOURGUIDE|RYANAIR|WIZZ|\\yLOT\\y|BKG-|ESKY|INTERCITY|BILET\\.|DISCOVERCARS'`],
  ["shops", `${TXT} ~ 'ZABKA|.ABKA|BIEDRONKA|LIDL|AUCHAN|CARREFOUR|KAUFLAND|PEPCO|ACTION|DEALZ|STOKROTKA|LEWIATAN|TRANSGOURMET'`],
  ["tech", `${TXT} ~ 'X-KOM|MEDIA MARKT|MEDIA SATURN|EURO-NET|KOMPUTRONIK|SMARTSPOT|RTV EURO|APPLE|ALLEGRO'`],
  ["household", `${TXT} ~ '\\yOBI\\y|BRICOMAN|CASTORAMA|LEROY|JYSK|IKEA|STALPOL|TEDI|SUPERHOBBY|DEDRA|DOMATOR|MAT[- ]?BUD|\\yPSB\\y|MR.WKA|BUDOWLAN|HURTOWNIA|MERKURY|BUDMAT'`],
  ["card", `${TXT} ~ 'BEZGOT|KART. DEBET'`],
];
// per-category exclusive condition: manual override wins; otherwise first matching pattern
export function catCondition(key: string): string | null {
  const idx = EXPENSE_CATS.findIndex(([k]) => k === key);
  if (idx < 0 && key !== "other") return null;
  const base = BUCKET.expenses!;
  if (key === "other") return `${base} AND (${MC} = 'other' OR (${MC} IS NULL AND NOT (${EXPENSE_CATS.map(([, p]) => `(${p})`).join(" OR ")})))`;
  const earlier = EXPENSE_CATS.slice(0, idx).map(([, p]) => `(${p})`).join(" OR ");
  return `${base} AND (${MC} = '${key}' OR (${MC} IS NULL AND (${EXPENSE_CATS[idx]![1]})${earlier ? ` AND NOT (${earlier})` : ""}))`;
}

// period (year or year+month) → [from, to] ISO date strings
export function periodRange(year: string, month?: string): [string, string] {
  if (month && /^(0[1-9]|1[0-2])$/.test(month)) {
    const last = new Date(Number(year), Number(month), 0).getDate();
    return [`${year}-${month}-01`, `${year}-${month}-${last}`];
  }
  return [`${year}-01-01`, `${year}-12-31`];
}

