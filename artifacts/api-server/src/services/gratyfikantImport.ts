// Імпорт вивантажень з Gratyfikant nexo (Налаштування → Gratyfikant):
// два типи файлів — список умов (Pracownik | Nr umowy | Od/Do dnia | Dział)
// і картотека працівників (Nazwisko i imię | PESEL). Тип визначається по
// заголовках. Матчер імен — двигун, відточений на ручних звірках 08.2026:
// фолд діакритиків → точний збіг → перестановка/підмножина токенів
// (єдиний кандидат) → обережний fuzzy (Левенштейн ≤1 на токенах від 3 літер,
// префікс від 4 літер з обох боків, єдиний лідер; профілі з технічними
// суфіксами «- A»/«- D» — лише точний збіг: вони тричі давали сміттєві матчі).
// Чисті функції працюють з масивами клітинок — тестуються без xlsx.

export type UmowaRow = { name: string; nr: string; od: string | null; do: string | null; dzial: string | null };
export type KartotekaRow = { name: string; pesel: string | null };

export const foldName = (s: string): string =>
  String(s).normalize("NFD").replace(/\p{M}/gu, "").replace(/ł/g, "l").replace(/Ł/g, "L");
export const normName = (s: string): string =>
  foldName(s).trim().replace(/\s+/g, " ").toUpperCase();
const toks = (s: string) => normName(s).split(" ");

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

// ── Визначення типу файлу по рядку заголовків ────────────────────────────────
export function detectFileKind(headerCells: unknown[]): "umowy" | "kartoteka" | null {
  const h = headerCells.map(c => normName(String(c ?? "")));
  if (h.some(c => c.includes("NR UMOWY"))) return "umowy";
  if (h.some(c => c === "PESEL")) return "kartoteka";
  return null;
}

// ── Парсери (вхід — масив рядків, кожен рядок — масив клітинок 1-based-зсунутий у 0-based) ──
const cellStr = (v: unknown): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && "result" in (v as any)) return cellStr((v as any).result);
  return String(v).trim();
};

export function parseUmowyRows(rows: unknown[][]): UmowaRow[] {
  // колонки: [U, Pracownik, Nr umowy, Od dnia, Do dnia, (Kwota na UC)?, Dział, Flaga]
  const header = rows[0] ?? [];
  const idx = (needle: string) => header.findIndex(c => normName(String(c ?? "")).includes(needle));
  const iName = idx("PRACOWNIK"), iNr = idx("NR UMOWY"), iOd = idx("OD DNIA"), iDo = idx("DO DNIA"), iDzial = idx("DZIAL");
  const out: UmowaRow[] = [];
  for (const r of rows.slice(1)) {
    const name = cellStr(r[iName]);
    if (!name) continue;
    const date = (v: unknown) => {
      const s = cellStr(v);
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    };
    out.push({
      name: name.replace(/\s+/g, " "),
      nr: cellStr(r[iNr]),
      od: date(r[iOd]),
      do: date(r[iDo]),
      dzial: iDzial >= 0 ? cellStr(r[iDzial]) || null : null,
    });
  }
  return out;
}

export function parseKartotekaRows(rows: unknown[][]): KartotekaRow[] {
  const header = rows[0] ?? [];
  const idx = (fn: (c: string) => boolean) => header.findIndex(c => fn(normName(String(c ?? ""))));
  const iName = idx(c => c.includes("NAZWISKO"));
  const iPesel = idx(c => c === "PESEL");
  const out: KartotekaRow[] = [];
  for (const r of rows.slice(1)) {
    const name = cellStr(r[iName]);
    if (!name) continue;
    const pesel = cellStr(r[iPesel]);
    out.push({ name: name.replace(/\s+/g, " "), pesel: /^\d{11}$/.test(pesel) ? pesel : null });
  }
  return out;
}

// ── Матчер: наш профіль → запис nexo ─────────────────────────────────────────
export type NameMatch<T> = { hit: T; method: "exact" | "strict" | "fuzzy" } | null;

export function matchNexo<T extends { name: string }>(ourName: string, candidates: Map<string, T>): NameMatch<T> {
  const key = normName(ourName);
  const exact = candidates.get(key);
  if (exact) return { hit: exact, method: "exact" };
  if (/\s-\s?[A-Za-z]$/.test(ourName.trim())) return null; // «Imie - D» — лише точний
  const oT = toks(ourName), oSet = new Set(oT);
  const strict = [...candidates.keys()].filter(n => {
    const nT = toks(n);
    const sh = nT.filter(t => oSet.has(t)).length;
    return (sh === nT.length || sh === oT.length) && sh >= 2;
  });
  if (strict.length === 1) return { hit: candidates.get(strict[0]!)!, method: "strict" };
  if (strict.length > 1) return null;
  const scored = [...candidates.keys()].map(n => {
    const nT = toks(n);
    const hits = oT.filter(t => nT.some(x =>
      (lev(t, x) <= 1 && Math.min(t.length, x.length) >= 3) ||
      (t.length >= 4 && x.length >= 4 && (x.startsWith(t) || t.startsWith(x))))).length;
    return { n, hits };
  }).filter(x => x.hits >= 2).sort((a, b) => b.hits - a.hits);
  if (!scored.length || (scored.length > 1 && scored[0]!.hits === scored[1]!.hits)) return null;
  return { hit: candidates.get(scored[0]!.n)!, method: "fuzzy" };
}

// Зручний конструктор мапи кандидатів (перший запис імені виграє)
export function candidateMap<T extends { name: string }>(items: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) if (!m.has(normName(it.name))) m.set(normName(it.name), it);
  return m;
}

// Дефолтна дата виплати: 25-те наступного місяця після місяця сводної
// (у серпні (25-го) платимо за липень).
export function defaultPayDate(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const ny = m === 12 ? y! + 1 : y!;
  const nm = m === 12 ? 1 : m! + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-25`;
}

// Статус умови людини у фірмі на місяць праці (для попереджень експорту):
// умова «покриває» місяць, якщо перетинається з [початок, кінець місяця].
export type UmowaStatus = "ok" | "expired" | "none" | "other_firm";
export function umowaStatusFor(
  month: string,
  firm: string,
  workerUmowy: { firm: string; od: string | null; do: string | null }[],
): UmowaStatus {
  const from = `${month}-01`;
  const to = `${month}-31`;
  const inFirm = workerUmowy.filter(u => u.firm === firm);
  const covers = (u: { od: string | null; do: string | null }) =>
    (u.od == null || u.od <= to) && (u.do == null || u.do >= from);
  if (inFirm.some(covers)) return "ok";
  if (inFirm.length) return "expired";
  if (workerUmowy.some(covers)) return "other_firm";
  return workerUmowy.length ? "other_firm" : "none";
}
