// Парсер файлів/списків годин ВІД ФАБРИК для звірки з рапортами працівників
// (сторінка «Облік годин», колонка «Години з фабрики»). Чистий шар без БД —
// покривається юніт-тестами. Підтримувані формати:
//   A. «Матриця»: рядок-заголовок `… | Imię i nazwisko | 1..31 | Razem godziny`,
//      під ним по працівнику сумарні години (EUROSUPPORT CZERWIEC.xlsx).
//   B. «Lista dni szczegółowo» (експорт RCP, Lublin/Motycz): секції
//      `Ім'я [id] Czas i obecności - lista dni szczegółowo (від - до)`,
//      у кожній підсумок «Godzin zaliczonych» у форматі HH:MM.
//   C. Вставлений текст: рядки «Ім'я Прізвище 123,5» / «Ім'я — 123:30».
//   D. «Ewidencja» (ANDROS, файли EWIDENCJA KLINEX/ES): заголовок
//      `SUMA | premia | Imię Nazwisko | 1..31 | UMOWY`, під ним підзаголовок
//      змін I/II/III (день = 3 підколонки, номер дня — merge над першою);
//      аркуші KOBIETY + MĘŻCZYZNI зливаються. SUMA = Σ денних клітинок
//      (перевірено на файлі), premia — окремо, у години не входить.
import * as XLSX from "xlsx";

export interface ParsedHoursRow {
  name: string;
  hours: number;
  /** розбивка по днях місяця (день 1..31), якщо файл її містить: число =
   *  разом за день (матриця/lista); обʼєкт = по змінах, ключ — № зміни
   *  ("1".."6" → години; ewidencja I/II/III) */
  days?: Record<number, number | Record<string, number>>;
}
export interface ParsedHoursFile {
  rows: ParsedHoursRow[];
  /** "YYYY-MM", якщо місяць вдалося визначити з файлу */
  monthDetected: string | null;
  format: "matrix" | "lista" | "ewidencja";
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

// RCP-експорт інколи дублює ім'я в заголовку секції («Petrenko Oleksii
// Petrenko Oleksii») — без згортання матчер бачить 4 токени проти 2 у базі
// і не знаходить людину. Якщо друга половина токенів = першій — лишаємо одну.
export function dedupeDoubledName(name: string): string {
  const t = collapse(name).split(" ");
  if (t.length >= 2 && t.length % 2 === 0) {
    const half = t.length / 2;
    const a = t.slice(0, half).join(" ").toLowerCase();
    const b = t.slice(half).join(" ").toLowerCase();
    if (a === b) return t.slice(0, half).join(" ");
  }
  return collapse(name);
}

/** "136:00" / "93:52" → десяткові години (з округленням до 2 знаків) */
export function hhmmToHours(s: string): number | null {
  const m = /^(\d{1,4}):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  return r2(Number(m[1]) + Number(m[2]) / 60);
}

/** Десяткове число ("216.5", "216,5") або HH:MM → години */
export function parseHoursValue(raw: string): number | null {
  const s = raw.trim();
  const asHhmm = hhmmToHours(s);
  if (asHhmm != null) return asHhmm;
  if (!/^\d{1,4}([.,]\d{1,2})?$/.test(s)) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? r2(n) : null;
}

// Аркуш → масив рядків-рядків. dateNF робить дата-клітинки (місяць матриці)
// передбачуваними "yyyy-mm" незалежно від локалі Excel.
function sheetRows(ws: XLSX.WorkSheet): string[][] {
  return XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, raw: false, dateNF: "yyyy-mm", defval: null })
    .map(row => row.map(c => (c == null ? "" : String(c))));
}

// ── Формат A: матриця з колонкою «Razem godziny» ─────────────────────────────
function parseMatrix(rows: string[][]): ParsedHoursFile | null {
  let headerIdx = -1, nameCol = -1, totalCol = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i]!;
    const n = row.findIndex(c => /imi[eę]\s+i\s+nazwisko/i.test(c));
    if (n < 0) continue;
    const t = row.findIndex(c => /razem/i.test(c));
    if (t < 0) continue;
    headerIdx = i; nameCol = n; totalCol = t;
    break;
  }
  if (headerIdx < 0) return null;
  // місяць: дата-клітинка над заголовком ("yyyy-mm" завдяки dateNF) або текст "06.2026"
  let monthDetected: string | null = null;
  for (let i = 0; i <= headerIdx && !monthDetected; i++) {
    for (const c of rows[i]!) {
      let m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(c.trim());
      if (m) { monthDetected = `${m[1]}-${m[2]}`; break; }
      m = /^(\d{2})\.(\d{4})$/.exec(c.trim());
      if (m) { monthDetected = `${m[2]}-${m[1]}`; break; }
      // дата-клітинка з кешованим форматом mmm-yy ("Jun-26")
      m = /^([A-Za-z]{3})-(\d{2})$/.exec(c.trim());
      if (m) {
        const mi = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1]!.toLowerCase());
        if (mi >= 0) { monthDetected = `20${m[2]}-${String(mi + 1).padStart(2, "0")}`; break; }
      }
    }
  }
  // колонки днів: заголовки-числа 1..31 між іменем і підсумком
  const dayCols: { col: number; day: number }[] = [];
  for (let c = nameCol + 1; c < (rows[headerIdx]!.length ?? 0); c++) {
    if (c === totalCol) continue;
    const d = Number((rows[headerIdx]![c] ?? "").trim());
    if (Number.isInteger(d) && d >= 1 && d <= 31) dayCols.push({ col: c, day: d });
  }
  const out: ParsedHoursRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i]!;
    const name = dedupeDoubledName(row[nameCol] ?? "");
    if (!name || /razem|suma/i.test(name)) continue; // порожні та підсумкові рядки
    const hours = parseHoursValue(row[totalCol] ?? "");
    if (hours == null) continue;
    const days: Record<number, number> = {};
    for (const { col, day } of dayCols) {
      const h = parseHoursValue(row[col] ?? ""); // "W"/"NN"/порожнє → не число → пропуск
      if (h != null && h > 0) days[day] = h;
    }
    out.push({ name, hours, ...(dayCols.length ? { days } : {}) });
  }
  return { rows: out, monthDetected, format: "matrix" };
}

// ── Формат B: lista dni szczegółowo (секції по людині) ───────────────────────
const LISTA_HDR = /^\s*(.+?)\s*\[\d+\]\s*Czas i obecno/i;

function parseLista(rows: string[][]): ParsedHoursFile | null {
  let monthDetected: string | null = null;
  const out: ParsedHoursRow[] = [];
  let current: string | null = null;
  let days: Record<number, number> = {};
  let found = false;
  for (const row of rows) {
    const first = row[0] ?? "";
    const hdr = LISTA_HDR.exec(first);
    if (hdr) {
      found = true;
      current = dedupeDoubledName(hdr[1]!);
      days = {};
      if (!monthDetected) {
        const m = /\((\d{4})-(\d{2})-\d{2}\s*-\s*\d{4}-\d{2}-\d{2}\)/.exec(first);
        if (m) monthDetected = `${m[1]}-${m[2]}`;
      }
      continue;
    }
    // денний рядок секції: "01.06.2026 … Suma: … Czas zaliczony" — останній HH:MM
    const dm = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(first.trim());
    if (current && dm) {
      const vals = row.slice(1).map(c => hhmmToHours(c)).filter((v): v is number => v != null);
      const dayTotal = vals.length ? vals[vals.length - 1]! : null;
      if (dayTotal != null && dayTotal > 0) days[Number(dm[1])] = dayTotal;
      continue;
    }
    if (current && /^Godzin zaliczonych/i.test(first)) {
      const val = row.slice(1).map(c => hhmmToHours(c)).find(v => v != null) ?? null;
      if (val != null) out.push({ name: current, hours: val, ...(Object.keys(days).length ? { days } : {}) });
      current = null; // одна сума на секцію
    }
  }
  return found ? { rows: out, monthDetected, format: "lista" } : null;
}

// ── Формат D: ewidencja зі змінами I/II/III (ANDROS) ─────────────────────────
// Ім'я інколи має суфікс посади («BATSAN SERHII - WÓZ», «… - pom.mech») —
// зрізаємо по « - » (дефіс із пробілами; подвійні прізвища через дефіс без
// пробілів не зачіпаються).
const stripPositionSuffix = (name: string) => collapse(name).split(/\s+[-–]\s+/)[0]!;

function parseEwidencja(rows: string[][]): ParsedHoursFile | null {
  let headerIdx = -1, nameCol = -1, sumaCol = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i]!;
    const n = row.findIndex(c => /imi[eę]\s+(i\s+)?nazwisko/i.test(c));
    if (n < 0) continue;
    const s = row.findIndex(c => /^suma$/i.test(c.trim()));
    if (s < 0) continue;
    headerIdx = i; nameCol = n; sumaCol = s;
    break;
  }
  if (headerIdx < 0) return null;
  // визначальна риса формату — підзаголовок змін I/II/III під шапкою
  const sub = rows[headerIdx + 1] ?? [];
  if (!sub.some(c => /^i{1,3}$/i.test(c.trim()))) return null;
  // групи колонок дня: заголовок-число 1..31 відкриває день, merge-порожнечі
  // праворуч належать йому; інший непорожній заголовок (UMOWY) закриває групу
  const header = rows[headerIdx]!;
  const dayCols = new Map<number, number[]>();
  let curDay: number | null = null;
  for (let c = nameCol + 1; c < Math.max(header.length, sub.length); c++) {
    const h = (header[c] ?? "").trim();
    if (h) {
      const d = Number(h);
      curDay = Number.isInteger(d) && d >= 1 && d <= 31 ? d : null;
      if (curDay != null) dayCols.set(curDay, [c]);
      continue;
    }
    if (curDay != null) dayCols.get(curDay)!.push(c);
  }
  if (!dayCols.size) return null;
  const out: ParsedHoursRow[] = [];
  for (let i = headerIdx + 2; i < rows.length; i++) {
    const row = rows[i]!;
    const name = stripPositionSuffix(dedupeDoubledName(row[nameCol] ?? ""));
    if (!name || /razem|suma/i.test(name)) continue;
    const hours = parseHoursValue(row[sumaCol] ?? "");
    if (hours == null) continue;
    // розбивка дня ПО ЗМІНАХ: № зміни — з римської цифри підзаголовка
    // (I/II/III), фолбек — позиція підколонки в групі дня
    const days: Record<number, Record<string, number>> = {};
    for (const [day, cols] of dayCols) {
      const byShift: Record<string, number> = {};
      cols.forEach((c, idx) => {
        const h = parseHoursValue(row[c] ?? "");
        if (h == null || h <= 0) return;
        const roman = (sub[c] ?? "").trim().toUpperCase();
        const shift = roman === "I" ? 1 : roman === "II" ? 2 : roman === "III" ? 3 : idx + 1;
        byShift[String(shift)] = r2((byShift[String(shift)] ?? 0) + h);
      });
      if (Object.keys(byShift).length) days[day] = byShift;
    }
    out.push({ name, hours, days });
  }
  return { rows: out, monthDetected: null, format: "ewidencja" };
}

/** Розбір Excel-файла фабрики (усі формати, авто-детекція). Аркуші формату
 *  ewidencja (KOBIETY/MĘŻCZYZNI) зливаються в один список. */
export function parseFactoryHoursWorkbook(buf: Buffer): ParsedHoursFile {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const ew: ParsedHoursFile = { rows: [], monthDetected: null, format: "ewidencja" };
  let ewFound = false;
  for (const name of wb.SheetNames) {
    const rows = sheetRows(wb.Sheets[name]!);
    if (!rows.length) continue;
    const e = parseEwidencja(rows);
    if (e) { ewFound = true; ew.rows.push(...e.rows); continue; }
    if (ewFound) continue; // режим евіденції — сторонні аркуші не пробуємо
    const lista = parseLista(rows);
    if (lista) return lista;
    const matrix = parseMatrix(rows);
    if (matrix) return matrix;
  }
  if (ewFound) return ew;
  throw new Error("Невідомий формат файла: не знайдено ні «Imię i nazwisko … Razem», ні «lista dni szczegółowo», ні евіденції «SUMA … I/II/III»");
}

// Місяць з імені файла евіденції («EWIDENCJA KLINEX 2026 LIPIEC.xlsx») —
// фолбек, коли в самому аркуші дати немає.
const PL_MONTHS = ["STYCZEN", "LUTY", "MARZEC", "KWIECIEN", "MAJ", "CZERWIEC", "LIPIEC", "SIERPIEN", "WRZESIEN", "PAZDZIERNIK", "LISTOPAD", "GRUDZIEN"];
export function monthFromPolishFilename(filename: string): string | null {
  const flat = filename.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const year = /(?:^|\D)(20\d{2})(?:\D|$)/.exec(flat)?.[1];
  if (!year) return null;
  const mi = PL_MONTHS.findIndex(m => flat.includes(m));
  if (mi < 0) return null;
  return `${year}-${String(mi + 1).padStart(2, "0")}`;
}

// ── Формат C: вставлений текст ───────────────────────────────────────────────
// Рядок: [№] Ім'я Прізвище <розділювач> години. Години — десяткові або HH:MM.
export function parseFactoryHoursText(text: string): ParsedHoursRow[] {
  const out: ParsedHoursRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = collapse(rawLine.replace(/\t/g, " "));
    if (!line) continue;
    const m = /^(?:\d{1,3}[.)]\s*)?(.+?)[\s;,–—-]+(\d{1,4}(?:[.,]\d{1,2})?|\d{1,4}:[0-5]\d)$/.exec(line);
    if (!m) continue;
    const name = dedupeDoubledName(m[1]!.replace(/[;,–—-]+$/, ""));
    const hours = parseHoursValue(m[2]!);
    if (!name || hours == null) continue;
    out.push({ name, hours });
  }
  return out;
}
