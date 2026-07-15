// Fuzzy matching of a driver-typed name against the workers base.
// DB names are Latin (Polish alphabet, "Last First" or "First Last"); drivers
// type from memory: Cyrillic, swapped word order, typos, partial names.
// Everything is folded to a rough phonetic-latin form so "Гнатюк Юрій",
// "Hnatiuk Yurii" and "hnatuk juri" land on the same worker.

export type WorkerLike = { id: number; fullName: string; workerCode: string | null };
export type MatchResult<T extends WorkerLike> = {
  /** Single worker we are sure about — safe to auto-link. */
  confident: T | null;
  /** Plausible workers (best first) when not confident — offer as a pick list. */
  candidates: T[];
};

// Ukrainian + Russian → rough latin. Digraph drift (ж/rz, ш/sz, ч/cz) is left
// to the per-token Levenshtein tolerance instead of exhaustive mapping.
const CYR_LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "e", ё: "e",
  ж: "z", з: "z", и: "i", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h",
  ц: "c", ч: "c", ш: "s", щ: "s", ь: "", ъ: "", ы: "i", э: "e", ю: "iu", я: "ia",
};

// Latin letters that speakers use interchangeably when latinising Slavic names.
const LAT_FOLD: Record<string, string> = { w: "v", y: "i", j: "i", g: "h" };

export function normalizeName(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase().replaceAll("ł", "l").normalize("NFD")) {
    if (ch >= "̀" && ch <= "ͯ") continue; // diacritics from NFD
    if (CYR_LAT[ch] !== undefined) { out += CYR_LAT[ch]; continue; }
    if (ch >= "a" && ch <= "z") { out += LAT_FOLD[ch] ?? ch; continue; }
    if ((ch >= "0" && ch <= "9") || ch === " ") { out += ch; continue; }
    out += " "; // punctuation → token boundary
  }
  return out.replace(/\s+/g, " ").trim();
}

const tokens = (s: string) => normalizeName(s).split(" ").filter(t => t.length >= 2);

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

function tokenScore(a: string, b: string): number {
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short)) return 0.85;
  const d = levenshtein(a, b);
  if (d <= 1) return 0.8;
  if (d === 2 && short.length >= 5) return 0.6;
  return 0;
}

// Word-order-independent: each query token greedily takes its best name token.
export function nameScore(query: string, fullName: string): number {
  const qt = tokens(query), nt = tokens(fullName);
  if (qt.length === 0 || nt.length === 0) return 0;
  const free = [...nt];
  let sum = 0;
  for (const q of qt) {
    let bestI = -1, best = 0;
    for (let i = 0; i < free.length; i++) {
      const s = tokenScore(q, free[i]!);
      if (s > best) { best = s; bestI = i; }
    }
    if (bestI >= 0) free.splice(bestI, 1);
    sum += best;
  }
  return sum / qt.length;
}

const MIN_CANDIDATE = 0.55;

export function matchWorker<T extends WorkerLike>(input: string, workers: T[]): MatchResult<T> {
  const text = input.trim();
  const byCode = workers.find(w => w.workerCode != null && w.workerCode === text);
  if (byCode) return { confident: byCode, candidates: [byCode] };

  const scored = workers
    .map(w => ({ w, score: nameScore(text, w.fullName) }))
    .filter(x => x.score >= MIN_CANDIDATE)
    .sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 4).map(x => x.w);
  if (scored.length === 0) return { confident: null, candidates: [] };

  const best = scored[0]!, second = scored[1];
  const clearWinner = !second || best.score - second.score >= 0.2;
  // Single-word queries ("Kowalski") must match near-exactly to auto-link.
  const threshold = tokens(text).length >= 2 ? 0.75 : 0.85;
  if (best.score >= threshold && clearWinner) return { confident: best.w, candidates };
  return { confident: null, candidates };
}

// Імовірний дубль перед створенням нового працівника: точний збіг
// нормалізованого імені (без регістру/діакритики/порядку слів) або впевнений
// matchWorker. Активний профіль пріоритетніший за звільнений.
export function findLikelyDuplicate<T extends WorkerLike & { isActive?: boolean | null }>(
  name: string, workers: T[],
): T | null {
  const nk = normalizeName(name).split(" ").sort().join(" ");
  const exact = workers.filter(w => normalizeName(w.fullName).split(" ").sort().join(" ") === nk);
  const pick = (list: T[]) => list.find(w => w.isActive) ?? list[0] ?? null;
  if (exact.length) return pick(exact);
  const m = matchWorker(name, workers);
  return m.confident ?? null;
}
