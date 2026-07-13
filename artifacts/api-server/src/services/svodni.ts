// Сводні — повне дзеркало зарплатних таблиць трьох міст (Люблін / Познань /
// Лодзь): кожен рядок людини з УСІМА колонками вкладки + перерахунок формул
// таблиці кодом і звірка з числами у клітинках (mismatch). Чисте ядро без
// БД/Drive — покривається юніт-тестами на фікстурах реальних вкладок.
//
//शари даних: відкритий (фактичні години, ставки, відрахування, до виплати)
// і закритий — księgowość/готівка (hoursDeclared/ksieg*/gotowka/konto) — API
// віддає закритий шар лише з capability svodniSensitive.
import { num, cell, dateCell, norm, key, isServiceRow, cleanName, nameTokens } from "./payrollSummaries";

export interface SvodniParsedRow {
  section: string | null;
  rawName: string;
  // відкритий шар
  hoursNotified: number | null;
  hours: number | null;
  shifts: number | null;
  rateBrutto: number | null;
  rateNetto: number | null;
  premia: number | null;
  zaliczka: number | null;
  zaliczkaBd: number | null;
  hostel: number | null;
  odziez: number | null;
  dojazd: number | null;
  kara: number | null;
  komornik: number | null;
  kaucja: number | null;
  potracenia: number | null;
  doWyplaty: number | null;
  brutto: number | null;
  // закритий шар
  hoursDeclared: number | null;
  ksiegBrutto: number | null;
  ksiegNetto: number | null;
  gotowka: number | null;
  konto: number | null;
  isStudent: boolean | null;
  under26: boolean | null;
  extras: Record<string, number | string>;
  hr: Record<string, string>;
  sheetValues: Record<string, number>; // клітинки з обчислюваних колонок — для звірки
  mismatch: Record<string, { ours: number; sheet: number }> | null;
}

export interface SvodniParsedTab {
  factoryLabel: string;
  firmGuess: string | null;
  rows: SvodniParsedRow[];
  /** значення рядка SUMA вкладки за канонічними ключами (для tab_checks) */
  sheetSuma: Record<string, number>;
  counts: { workers?: number; students?: number; over26?: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ── канонічні колонки (Люблін/Познань): заголовок → ключ ─────────────────────
// core = пишемо у власну колонку svodni_rows; решта — в extras.
type ColKind =
  | { key: keyof SvodniParsedRow & string; core: true }
  | { key: string; core: false };
const LUBLIN_COLS: { re: RegExp; col: ColKind; premia?: boolean }[] = [
  { re: /GODZ W POWIADOMIENIU/, col: { key: "hoursNotified", core: true } },
  { re: /^ILOSC GODZIN$|^GODZINY$|^GODZIN$/, col: { key: "hours", core: true } },
  { re: /^ILOSC ZMIAN$/, col: { key: "shifts", core: true } },
  { re: /^STAWKA BRUTTO$/, col: { key: "rateBrutto", core: true } },
  { re: /^STAWKA NETTO$/, col: { key: "rateNetto", core: true } },
  { re: /^ZALICZKA$|^ZALICZKI$/, col: { key: "zaliczka", core: true } },
  { re: /^ZALICZKA BD/, col: { key: "zaliczkaBd", core: true } },
  { re: /^HOSTEL$/, col: { key: "hostel", core: true } },
  { re: /^ODZIEZ/, col: { key: "odziez", core: true } }, // «Odzież», «Odzież+ kurs»
  { re: /^DOJAZD$|^DOPLATA ZA DOJAZD$/, col: { key: "dojazd", core: true } },
  { re: /^KARA(?! Z SUSHI| ES)/, col: { key: "kara", core: true } }, // «Kara za nieobecność»
  { re: /^KOMORNIK|KOMORNIK\/ZADLUZENIE/, col: { key: "komornik", core: true } },
  { re: /^KAUCJA/, col: { key: "kaucja", core: true } }, // Chip / Klucze
  { re: /POMYLKOWOSC|^POTRACENIA$|^SUMA POTRACEN/, col: { key: "potracenia", core: true } },
  { re: /^DO WYPLATY( NETTO)?$/, col: { key: "doWyplaty", core: true } },
  // премії: сумуються в premia, кожна окремо — в extras
  { re: /^PREMIA AGRAM/, col: { key: "premiaAgram", core: false }, premia: true },
  { re: /^PREMIA ES$/, col: { key: "premiaEs", core: false }, premia: true },
  { re: /^PREMIA$|^KIEROWCA\/PREMIA$/, col: { key: "premiaBase", core: false }, premia: true },
  // фабричні нюанси → extras
  { re: /^SUMA NOCNE/, col: { key: "nocneH", core: false } },
  { re: /^DOPLATA ZA NOCNE/, col: { key: "doplataNocna", core: false } },
  { re: /^OPLATA DLA KIEROWCY/, col: { key: "oplataKierowcy", core: false } },
  { re: /^DOPLATA ES$/, col: { key: "doplataEs", core: false } },
  { re: /^BADANIA/, col: { key: "badania", core: false } },
  { re: /^NAKLADKI/, col: { key: "nakladki", core: false } },
  { re: /^ZWROT KOSZTOW/, col: { key: "zwrotKosztow", core: false } },
  { re: /^KARTA POBYTU/, col: { key: "kartaPobytu", core: false } },
  { re: /^KARA Z SUSHI/, col: { key: "karaKlient", core: false } },
  { re: /^KARA ES$/, col: { key: "karaEs", core: false } },
  { re: /ЗАБОРГОВАН|ZADLUZENIE Z ZESZL/, col: { key: "zadluzenie", core: false } },
];
// кадрові колонки (текст/дата) → hr
const HR_COLS: { re: RegExp; key: string }[] = [
  { re: /^ZASWIADCZENIE DO KIEDY/, key: "zaswiadczenieDo" },
  { re: /ZASWIADCZENIE\s+KIEDY WYSTAWIONE/, key: "zaswiadczenieWystawione" },
  { re: /^KONIEC STUDIOW/, key: "koniecStudiow" },
  { re: /^WNIOSEK ZALICZKI/, key: "wniosekZaliczki" },
  { re: /^DATA (ROZPOCZECIA PRACY|POCZATKU PRACY)/, key: "dataStart" },
  { re: /^DATA OD KTOREJ LICZYMY/, key: "dataLiczymy" },
  { re: /^DATA WYPOWIEDZENIA/, key: "dataWypowiedzenia" },
  { re: /^DATA URODZEN/, key: "dataUrodzenia" },
  { re: /^DNI KTORE ODPRACOWANE/, key: "dniOdpracowane" },
  { re: /^STANOWISKO$/, key: "stanowisko" },
  { re: /^LINIA$/, key: "linia" },
  { re: /^SZKOLENIE$/, key: "szkolenie" },
  { re: /^ODDZIAL$/, key: "oddzial" },
  { re: /^NR OSOBOWY$/, key: "nrOsobowy" },
  { re: /^FIRMA$/, key: "firma" },
  { re: /^STATUS$/, key: "status" },
  { re: /^UWAGI$/, key: "uwagi" },
  { re: /^DOKUMENTY$/, key: "dokumenty" },
];

// секційні рядки всередині вкладки (не людина, не сервіс)
const SECTION_RE = /^(KOBIETY|MEZCZYZNI|NIE OPODATKOWANE|OPODATKOWANE|STUDENCI|NIE STUDENCI)$/;

// ── Люблін / Познань: одна вкладка = одна фабрика ────────────────────────────
export function parseLublinTab(factoryLabel: string, rows: unknown[][]): SvodniParsedTab | null {
  const header = rows[0];
  if (!header) return null;
  const labels = header.map(c => norm(String(c ?? "")));
  const hIdx = (re: RegExp, from = 0, to = labels.length) => labels.findIndex((h, i) => i >= from && i < to && re.test(h));
  const doWyplatyCol = hIdx(/^DO WYPLATY( NETTO)?$/);
  if (doWyplatyCol < 0) return null; // не зарплатна вкладка
  // імʼя — зліва від «Ilość godz w powiadomieniu» (Познань має службові колонки перед ним)
  const powiadCol = hIdx(/GODZ W POWIADOMIENIU/);
  const nameCol = powiadCol > 0 ? powiadCol - 1 : 0;

  // мапа колонок: ставки/brutto ліворуч від Do wypłaty; обчислені Brutto/Godzin
  // Faktycznie/Księgowość — праворуч (ANDROS: «Brutto|Netto» без слова Stawka = ставки)
  const colOf = new Map<number, { key: string; core: boolean; premia?: boolean }>();
  const hrOf = new Map<number, string>();
  for (let i = 0; i < labels.length; i++) {
    if (i === nameCol || !labels[i]) continue;
    const hr = HR_COLS.find(h => h.re.test(labels[i]!));
    if (hr && i > doWyplatyCol) { hrOf.set(i, hr.key); continue; }
    const m = LUBLIN_COLS.find(c => c.re.test(labels[i]!));
    if (m && i < doWyplatyCol) { colOf.set(i, { key: m.col.key, core: m.col.core, premia: m.premia }); continue; }
    if (i < doWyplatyCol && /^BRUTTO$/.test(labels[i]!)) colOf.set(i, { key: "rateBrutto", core: true });
    else if (i < doWyplatyCol && /^NETTO$/.test(labels[i]!)) colOf.set(i, { key: "rateNetto", core: true });
    else if (i === doWyplatyCol) colOf.set(i, { key: "doWyplaty", core: true });
    else if (i > doWyplatyCol && /^BRUTTO$/.test(labels[i]!)) colOf.set(i, { key: "brutto", core: true });
    else if (i > doWyplatyCol && /GODZIN FAKTYCZNIE/.test(labels[i]!)) colOf.set(i, { key: "ksiegHours", core: false });
    else if (i > doWyplatyCol && /^KSIEGOWOSC$/.test(labels[i]!)) colOf.set(i, { key: "zusStatus", core: false });
    else if (hr) hrOf.set(i, hr.key);
  }
  colOf.set(doWyplatyCol, { key: "doWyplaty", core: true });

  const out: SvodniParsedTab = { factoryLabel, firmGuess: null, rows: [], sheetSuma: {}, counts: {} };
  let section: string | null = null;
  let r = 1;
  for (; r < rows.length; r++) {
    const name = cell(rows[r], nameCol);
    const normName = norm(name);
    if (/^SUMA GODZIN/.test(normName) || /^SUMA GODZIN/.test(norm(cell(rows[r], nameCol + 1)))) break;
    if (SECTION_RE.test(normName)) { section = name; continue; }
    if (!name || isServiceRow(name)) continue;
    // Познань: колонка «Firma» лівіше імені
    if (!out.firmGuess) for (let j = 0; j < nameCol; j++) {
      const v = norm(cell(rows[r], j));
      if (/OUTS/.test(v)) out.firmGuess = "ESO";
      else if (/KLINEX/.test(v)) out.firmGuess = "Klinex";
      else if (/EURO ?SUP/.test(v)) out.firmGuess = "ES";
      if (out.firmGuess) break;
    }
    const hasAnyNumber = [...colOf.keys()].some(i => num(rows[r]?.[i]) != null);
    const powiadMark = powiadCol >= 0 ? norm(cell(rows[r], powiadCol)) : "";
    const row = emptyRow(section, name);
    (row as any).__hasNum = hasAnyNumber || powiadMark === "STUD";
    let premiaSum: number | null = null;
    for (const [i, c] of colOf) {
      const v = rows[r]?.[i];
      if (c.key === "zusStatus") { const s = cell(rows[r], i); if (s) row.extras.zusStatus = s; continue; }
      const n = num(v);
      if (n == null) continue;
      if (c.premia) { premiaSum = (premiaSum ?? 0) + n; row.extras[c.key] = n; continue; }
      if (c.core) (row as any)[c.key] = n;
      else row.extras[c.key] = n;
    }
    row.premia = premiaSum != null ? r2(premiaSum) : null;
    for (const [i, k] of hrOf) { const v = dateCell(rows[r], i); if (v) row.hr[k] = v; }
    // STUD-маркер у колонці «повідомлення» + ZUS-текст «do 26 / Wyżej 26 / student»
    const powiadTxt = powiadCol >= 0 ? norm(cell(rows[r], powiadCol)) : "";
    const zusTxt = norm(String(row.extras.zusStatus ?? ""));
    row.isStudent = powiadTxt === "STUD" || /STUDENT/.test(zusTxt) ? true : zusTxt ? false : null;
    row.under26 = /DO ?26/.test(zusTxt) ? true : /WYZEJ ?26/.test(zusTxt) ? false : null;
    if (powiadTxt === "STUD") row.hoursNotified = null;
    out.rows.push(row);
  }

  // рядок SUMA: клітинки під канонічними колонками
  if (r < rows.length) {
    for (const [i, c] of colOf) {
      const n = num(rows[r]?.[i]);
      if (n != null) out.sheetSuma[c.premia ? c.key : c.key] = n;
    }
  }
  // сервісні лічильники нижче
  for (let i = r; i < Math.min(r + 12, rows.length); i++) {
    const label = norm(cell(rows[i], nameCol)) || norm(cell(rows[i], 0));
    const v = num(rows[i]?.[nameCol + 1]) ?? num(rows[i]?.[1]);
    if (/^ILOSC PRACOWNIKOW/.test(label) && v != null) out.counts.workers = Math.round(v);
    if (/^(W TYM )?STUDENTOW|^W TYM STUDENTOW/.test(label) && v != null && out.counts.students == null) out.counts.students = Math.round(v);
    if (/WYZEJ ?26/.test(label) && v != null) out.counts.over26 = Math.round(v);
  }

  // Розділювачі позицій («OSOBY FUNKCYJNE», «LIDERZY», назви ліній) — рядки без
  // жодного числа. Але лише коли У ВКЛАДЦІ Є числові рядки: у травневих ANDROS
  // головна таблиця — самі імена (дані в нижньому блоці), там усі рядки — люди.
  if (out.rows.some(x => (x as any).__hasNum)) {
    const filtered: typeof out.rows = [];
    let divSection: string | null = null;
    let prevLoopSection: string | null | undefined;
    for (const x of out.rows) {
      if (prevLoopSection !== undefined && x.section !== prevLoopSection) divSection = null; // нова секція таблиці
      prevLoopSection = x.section;
      if (!(x as any).__hasNum) { divSection = x.rawName; continue; }
      if (divSection) x.section = divSection;
      filtered.push(x);
    }
    out.rows = filtered;
  }
  for (const x of out.rows) delete (x as any).__hasNum;

  // Premia ES на вкладках AGRAM — ставка-індикатор бонусної програми (1/1,5),
  // яку Agram платить окремо: формула Do wypłaty її НЕ додає. Прибираємо з premia.
  const hasPremiaAgram = [...colOf.values()].some(c => c.key === "premiaAgram");
  if (hasPremiaAgram) for (const row of out.rows) {
    const pes = typeof row.extras.premiaEs === "number" ? (row.extras.premiaEs as number) : 0;
    if (pes && row.premia != null) row.premia = r2(row.premia - pes) || null;
  }

  // нижній блок księgowość/готівка (як у payrollSummaries.parseFactoryTab)
  mergeKsiegBlock(rows, r, out, nameCol);
  return out;
}

// нижній блок «godz fakt / godz księgowość / brutto / netto / gotówka» — якщо
// є, наповнює закритий шар відповідних людей (матч по імені). Варіанти:
//  a) з підписами (godz fakt / księgowość / gotówka);
//  b) без жодного підпису (Познань): та сама пʼятірка колонок одразу праворуч
//     від колонки імен головної таблиці — впізнаємо за рядком, де імʼя з
//     головної таблиці має ≥4 числа праворуч.
function mergeKsiegBlock(rows: unknown[][], from: number, out: SvodniParsedTab, mainNameCol: number) {
  const mainKeys = new Set(out.rows.map(w => key(cleanName(w.rawName))));
  let start = -1, faktCol = -1, ksieg = -1, bru = -1, net = -1, got = -1, nameCol = -1;
  for (let r = from; r < rows.length && start < 0; r++) {
    const line = rows[r] ?? [];
    const labels = line.map(c => norm(String(c ?? "")));
    const idx = (re: RegExp) => labels.findIndex(h => re.test(h));
    const fakt = idx(/GODZ\.?\s*FAKT/);
    const ksiegLbl = idx(/KSIEGOWOSC/);
    const gotLbl = idx(/GOTOWKA|DOTOWKA/);
    if (fakt >= 0 || (ksiegLbl >= 0 && gotLbl >= 0)) {
      ksieg = ksiegLbl >= 0 ? ksiegLbl : fakt + 1;
      faktCol = fakt >= 0 ? fakt : ksieg - 1;
      const bruLbl = idx(/^BRUTTO/); bru = bruLbl >= 0 ? bruLbl : ksieg + 1;
      const netLbl = idx(/^NETTO/); net = netLbl >= 0 ? netLbl : bru + 1;
      got = gotLbl >= 0 ? gotLbl : net + 1;
      const firstData = rows[r + 1] ?? [];
      for (let j = faktCol - 1; j >= 0; j--) {
        const v = String(firstData[j] ?? "").trim();
        if (!v || num(v) != null) continue;
        if (/^(STUD|DYPLOM|NIE ZG|KARTA|POWIAD|СТОЛБЕЦ|STOLBEC)/.test(norm(v))) continue;
        nameCol = j;
        break;
      }
      if (nameCol >= 0) start = r + 1;
      continue;
    }
    if (gotLbl >= 5 && labels.filter(h => h).length === 1) {
      got = gotLbl; net = got - 1; bru = got - 2; ksieg = got - 3; faktCol = got - 4;
      nameCol = -1;
      const firstData = rows[r + 1] ?? [];
      for (let j = faktCol - 1; j >= 0; j--) {
        const v = String(firstData[j] ?? "").trim();
        if (v && num(v) == null) { nameCol = j; break; }
      }
      if (nameCol >= 0) start = r + 1;
      continue;
    }
    // варіант (b): безлейбловий — імʼя з головної таблиці + ≥4 числа праворуч
    const nm = cell(line, mainNameCol);
    if (nm && mainKeys.has(key(cleanName(nm)))) {
      const nums = [1, 2, 3, 4, 5].map(o => num(line[mainNameCol + o]));
      if (nums.filter(v => v != null).length >= 4) {
        nameCol = mainNameCol;
        faktCol = mainNameCol + 1; ksieg = mainNameCol + 2; bru = mainNameCol + 3;
        net = mainNameCol + 4; got = mainNameCol + 5;
        start = r;
      }
    }
  }
  if (start < 0) return;
  {
    const used = new Set<number>();
    for (let i = start; i < rows.length; i++) {
      const name = cell(rows[i], nameCol);
      if (!name || isServiceRow(name)) break;
      const bk = key(cleanName(name));
      const bt = nameTokens(name);
      let m = out.rows.findIndex((w, wi) => !used.has(wi) && key(cleanName(w.rawName)) === bk);
      if (m < 0) m = out.rows.findIndex((w, wi) => {
        if (used.has(wi)) return false;
        const wt = new Set(nameTokens(w.rawName));
        return bt.filter(t => wt.has(t)).length >= 2;
      });
      const vals = {
        hoursDeclared: num(rows[i]?.[ksieg]),
        ksiegBrutto: num(rows[i]?.[bru]),
        ksiegNetto: num(rows[i]?.[net]),
        gotowka: num(rows[i]?.[got]),
        faktBlock: num(rows[i]?.[faktCol]),
      };
      if (m >= 0) {
        used.add(m);
        const w = out.rows[m]!;
        w.hoursDeclared = vals.hoursDeclared;
        w.ksiegBrutto = vals.ksiegBrutto;
        w.ksiegNetto = vals.ksiegNetto;
        w.gotowka = vals.gotowka;
        w.konto = vals.ksiegNetto;
        if (w.hours == null) w.hours = vals.faktBlock;
      } else {
        // людина є лише в нижньому блоці (у головній таблиці її нема — звільнена
        // або нульова виплата): додаємо окремим рядком, помічаємо blockOnly
        const row = emptyRow(null, name);
        row.extras.blockOnly = 1;
        row.hours = vals.faktBlock;
        row.hoursDeclared = vals.hoursDeclared;
        row.ksiegBrutto = vals.ksiegBrutto;
        row.ksiegNetto = vals.ksiegNetto;
        row.gotowka = vals.gotowka;
        row.konto = vals.ksiegNetto;
        row.doWyplaty = vals.ksiegNetto != null || vals.gotowka != null ? r2((vals.ksiegNetto ?? 0) + (vals.gotowka ?? 0)) : null;
        out.rows.push(row);
      }
    }
  }
}

function emptyRow(section: string | null, rawName: string): SvodniParsedRow {
  return {
    section, rawName,
    hoursNotified: null, hours: null, shifts: null, rateBrutto: null, rateNetto: null,
    premia: null, zaliczka: null, zaliczkaBd: null, hostel: null, odziez: null,
    dojazd: null, kara: null, komornik: null, kaucja: null, potracenia: null,
    doWyplaty: null, brutto: null,
    hoursDeclared: null, ksiegBrutto: null, ksiegNetto: null, gotowka: null, konto: null,
    isStudent: null, under26: null,
    extras: {}, hr: {}, sheetValues: {}, mismatch: null,
  };
}

// ── Познань: Sushi&Food Factory + Work List ──────────────────────────────────
// Основна вкладка парситься люблінським парсером (та сама модель заголовків);
// Work List — вивантаження обліку часу: Nr Osobowy → години (час × 24). Тут
// звіряємо години кожного рядка з Work List (розбіжність → mismatch.workList).
export function parseWorkList(rows: unknown[][]): Map<string, number> {
  const hours = new Map<string, number>();
  const header = (rows[0] ?? []).map(c => norm(String(c ?? "")));
  const numCol = header.findIndex(h => /^NUMER$/.test(h));
  const hCol = header.findIndex(h => /GODZINY LICZBOWO/.test(h));
  const sumCol = header.findIndex(h => /^SUMA GODZIN$/.test(h));
  if (numCol < 0) return hours;
  for (let r = 1; r < rows.length; r++) {
    const id = cell(rows[r], numCol);
    if (!id) continue;
    // «GODZINY LICZBOWO» — уже число; fallback: «SUMA GODZIN» час × 24
    const direct = hCol >= 0 ? num(rows[r]?.[hCol]) : null;
    const fromTime = sumCol >= 0 ? num(rows[r]?.[sumCol]) : null;
    const h = direct ?? (fromTime != null ? fromTime * 24 : null);
    if (h != null) hours.set(id, r2(h));
  }
  return hours;
}

// ── Лодзь: вкладки фірмових книг (ES/ESO: секційні заголовки; Klinex: Ew.) ───
// RAZEM = godziny×stawkaNetto + migawka − zaliczki − potrącenia − hostel + premia (+dojazd…)
// Офіційна частина: Ew.-години → ksiegNetto = Ew×stawkaNetto, gotówka = RAZEM − ksiegNetto + Dopłata ES.
export function parseLodzFullTab(factoryLabel: string, rows: unknown[][]): SvodniParsedTab | null {
  const out: SvodniParsedTab = { factoryLabel, firmGuess: null, rows: [], sheetSuma: {}, counts: {} };
  let c: Record<string, number> | null = null;
  let section: string | null = null;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const labels = row.map(x => norm(String(x ?? "")));
    if (labels.some(h => /NAZWISKO/.test(h)) && labels.some(h => /^RAZEM$/.test(h))) {
      const idx = (re: RegExp) => labels.findIndex(h => re.test(h));
      c = {
        name: idx(/NAZWISKO/), status: idx(/^STATUS$/), hours: idx(/^GODZINY?$/),
        stB: idx(/STAWKA.*BRUTTO/), stN: idx(/STAWKA.*NETTO/),
        premia: idx(/^PREMIA$/), hostel: idx(/^HOSTEL$/), potr: idx(/^POTRACENIA$|^POTRONCENIA$/),
        zal: idx(/^ZALICZKI$|^ZALICZKA$/), migawka: idx(/^MIGAWK/), dojazd: idx(/^DOJAZD$/),
        odziez: idx(/^ODZIEZ/), dokumenty: idx(/^DOKUMENTY$/),
        razem: idx(/^RAZEM$/), kontoH: idx(/^NA KONTO/), ew: idx(/^EW\.?$/), hRest: idx(/^H\.?$/),
        zl: idx(/^ZL\.?$/), doplata: idx(/^DOPLATA/), konto: idx(/^KONTO$/), ksieg: idx(/KSIEGOWOSC/),
        pow: idx(/^POW/), wniosek: idx(/WNIOSEK/), uwagi: idx(/^UWAGI$/),
      };
      continue;
    }
    if (!c) continue;
    const name = cell(row, c.name);
    const nn = norm(name);
    if (!name) continue;
    if (/^UL[. ]/.test(nn)) { section = name; continue; } // адреса-секція (точка збору)
    if (/^TOTAL/.test(nn)) {
      // рядок Total: — суми вкладки для tab_checks
      const grab = (col: number, k: string) => { if (col >= 0) { const v = num(row[col]); if (v != null) out.sheetSuma[k] = v; } };
      grab(c.hours!, "hours"); grab(c.razem!, "doWyplaty"); grab(c.premia!, "premia");
      grab(c.zal!, "zaliczka"); grab(c.hostel!, "hostel"); grab(c.potr!, "potracenia");
      grab(c.migawka!, "migawka"); grab(c.dojazd!, "dojazd"); grab(c.odziez!, "odziez");
      continue;
    }
    if (isServiceRow(name)) continue;
    const razem = num(row[c.razem]);
    if (razem == null) continue;
    const p = emptyRow(section, name);
    p.hours = c.hours >= 0 ? num(row[c.hours]) : null;
    p.rateBrutto = c.stB >= 0 ? num(row[c.stB]) : null;
    p.rateNetto = c.stN >= 0 ? num(row[c.stN]) : null;
    p.premia = c.premia >= 0 ? num(row[c.premia]) : null;
    p.hostel = c.hostel >= 0 ? num(row[c.hostel]) : null;
    p.potracenia = c.potr >= 0 ? num(row[c.potr]) : null;
    p.zaliczka = c.zal >= 0 ? num(row[c.zal]) : null;
    p.dojazd = c.dojazd >= 0 ? num(row[c.dojazd]) : null;
    p.odziez = c.odziez >= 0 ? num(row[c.odziez]) : null;
    p.doWyplaty = razem;
    const status = c.status >= 0 ? cell(row, c.status) : "";
    if (status) { p.hr.status = status; p.isStudent = /NIE\s*STUD/i.test(status) ? false : /STUD/i.test(status); }
    if (c.migawka >= 0) { const v = num(row[c.migawka]); if (v != null) p.extras.migawka = v; }
    if (c.dokumenty >= 0) { const v = num(row[c.dokumenty]); if (v != null) p.extras.dokumenty = v; }
    if (c.kontoH >= 0) { const v = num(row[c.kontoH]); if (v != null) p.extras.kontoH = v; }
    if (c.pow >= 0) { const v = cell(row, c.pow); if (v) p.hr.powOsw = v; }
    if (c.wniosek >= 0) { const v = cell(row, c.wniosek); if (v) p.hr.wniosekZaliczki = v; }
    if (c.uwagi >= 0) { const v = cell(row, c.uwagi); if (v) p.hr.uwagi = v; }
    // офіційна частина: повний Ew.-розклад (Klinex) або колонка KONTO
    const stN = p.rateNetto ?? 0;
    const stB = p.rateBrutto ?? 0;
    if (c.ew >= 0 && stN > 0) {
      const ew = num(row[c.ew]);
      if (ew != null) {
        const doplata = c.doplata >= 0 ? num(row[c.doplata]) ?? 0 : 0;
        p.hoursDeclared = ew;
        p.ksiegBrutto = r2(ew * stB);
        p.ksiegNetto = r2(ew * stN);
        p.gotowka = r2(razem - p.ksiegNetto + doplata);
        p.konto = p.ksiegNetto;
        if (doplata) p.extras.doplataEs = doplata;
        if (c.hRest >= 0) { const v = num(row[c.hRest]); if (v != null) p.extras.gotowkaH = v; }
      }
    } else if (c.konto >= 0) {
      // «KONTO» в ES/ESO-вкладках — часто НОМЕР РАХУНКУ (текст «68 1600 …»),
      // а не сума: приймаємо як гроші лише правдоподібні значення
      const kontoRaw = cell(row, c.konto);
      const konto = num(kontoRaw);
      if (konto != null && konto > 0 && konto < 100_000) {
        p.konto = konto;
        p.ksiegNetto = konto;
        p.gotowka = r2(razem - konto);
        if (stN > 0) p.hoursDeclared = r2(konto / stN);
      } else if (/^\d[\d ]{20,}$/.test(kontoRaw)) {
        p.hr.kontoNr = kontoRaw; // номер банківського рахунку
      }
    }
    out.rows.push(p);
  }
  if (!out.rows.length) return null;
  // лічильники в колонці Status (COUNTA-рядки під секціями обробляти не треба —
  // сервісні рядки відфільтровано; кількість рахуємо самі)
  out.counts.workers = out.rows.length;
  out.counts.students = out.rows.filter(x => x.isStudent).length;
  return out;
}

// ── Офісні вкладки (OFFICE ES / OFFICE KLINEX / Офис Лодзь …) ────────────────
// Люблін: name | status | godziny | stawka | brutto | umowa od/do | koniec
// studiów | zaświadczenie (+секції «LUBLIN», «STUDENTY», «Kierowcy | godziny»).
// Лодзь: Biuro | godziny | migawka | zaliczka | stawka | razem.
export function parseOfficeTab(tabLabel: string, rows: unknown[][]): SvodniParsedTab | null {
  const out: SvodniParsedTab = { factoryLabel: tabLabel, firmGuess: null, rows: [], sheetSuma: {}, counts: {} };
  const isLodz = rows.some(r => (r ?? []).some(c => /MIGAWKA/.test(norm(String(c ?? "")))));
  let section: string | null = null;
  for (const row of rows) {
    const name = cell(row, 0);
    if (!name) continue;
    const n = norm(name);
    if (/^BIURO$/.test(n)) continue; // заголовок лодзької вкладки
    if (/^LUBLIN|^LODZ|OFFICE|STUDENTY/.test(n) && num(row?.[4]) == null && num(row?.[5]) == null) { section = name; continue; }
    if (/^\d/.test(name) || isServiceRow(name)) continue;
    // секційні заголовки всередині («Kierowcy | godziny | stawka»)
    if (/GODZIN|DNI/.test(norm(cell(row, 1))) || /GODZIN|DNI/.test(norm(cell(row, 2)))) { section = name; continue; }
    const p = emptyRow(section, name);
    if (isLodz) {
      const h = num(row?.[1]);
      if (h != null) p.hours = h; else if (cell(row, 1)) p.hr.hoursText = cell(row, 1);
      const mig = num(row?.[2]); if (mig != null) p.extras.migawka = mig;
      p.zaliczka = num(row?.[3]);
      p.rateBrutto = num(row?.[4]);
      p.doWyplaty = num(row?.[5]);
    } else {
      if (cell(row, 1)) p.hr.status = cell(row, 1);
      const h = num(row?.[2]);
      if (h != null) p.hours = h; else if (cell(row, 2)) p.hr.hoursText = cell(row, 2);
      p.rateBrutto = num(row?.[3]);
      p.doWyplaty = num(row?.[4]);
      const d5 = dateCell(row, 5); if (d5) p.hr.umowaOd = d5;
      const d6 = dateCell(row, 6); if (d6) p.hr.umowaDo = d6;
      const d7 = dateCell(row, 7); if (d7) p.hr.koniecStudiow = d7;
      const d8 = dateCell(row, 8); if (d8) p.hr.zaswiadczenieDo = d8;
    }
    if (p.doWyplaty == null && p.hours == null && !p.hr.hoursText) continue;
    out.rows.push(p);
  }
  return out.rows.length ? out : null;
}

// «WYPŁATA GOTÓWKĄ <фірма>»: вкладка = місяць MM.YYYY, рядки Imie/Nazwisko |
// Fabryka | Razem | Na konto | (Dopłata) | Na renke → фактичний розподіл.
export interface GotowkaRow { name: string; factory: string; razem: number | null; konto: number; renke: number }
export function parseGotowkaTab(rows: unknown[][]): GotowkaRow[] {
  const out: GotowkaRow[] = [];
  let c: { name: number; fab: number; razem: number; konto: number; renke: number } | null = null;
  for (const row of rows) {
    const labels = (row ?? []).map(x => norm(String(x ?? "")));
    if (labels.some(h => /NAZWISKO/.test(h)) && labels.some(h => /NA KONTO/.test(h))) {
      const idx = (re: RegExp) => labels.findIndex(h => re.test(h));
      c = { name: idx(/NAZWISKO/), fab: idx(/FABRYKA/), razem: idx(/^RAZEM$/), konto: idx(/^NA KONTO/), renke: idx(/NA RENKE|NA REKE/) };
      continue;
    }
    if (!c) continue;
    const name = cell(row, c.name);
    const fab = cell(row, c.fab);
    const konto = num(row?.[c.konto]);
    if (!name || !fab || isServiceRow(name) || konto == null) continue;
    out.push({ name, factory: fab, razem: num(row?.[c.razem]), konto, renke: num(row?.[c.renke]) ?? 0 });
  }
  return out;
}

// накладає фактичний банк/готівка-розподіл на рядки фабрики (де нема Ew.-даних)
export function overlayGotowka(tab: SvodniParsedTab, rows: GotowkaRow[]) {
  const used = new Set<number>();
  for (const g of rows) {
    const gk = key(cleanName(g.name));
    const gt = nameTokens(g.name);
    let m = tab.rows.findIndex((w, wi) => !used.has(wi) && key(cleanName(w.rawName)) === gk);
    if (m < 0) m = tab.rows.findIndex((w, wi) => {
      if (used.has(wi)) return false;
      const wt = new Set(nameTokens(w.rawName));
      return gt.filter(t => wt.has(t)).length >= 2;
    });
    if (m < 0) continue;
    used.add(m);
    const w = tab.rows[m]!;
    if (w.hoursDeclared != null && w.gotowka != null) continue; // точний Ew.-розклад сильніший
    w.konto = g.konto;
    w.ksiegNetto = g.konto;
    w.gotowka = g.renke;
    if (w.rateNetto) w.hoursDeclared = r2(g.konto / w.rateNetto);
  }
}

// ── перерахунок формул: do wypłaty з компонентів ─────────────────────────────
// Люблін/Познань: hours×rateNetto (+нічні +доплати +премії) − всі відрахування.
// Лодзь: hours×rateNetto + migawka + premia − zaliczka − potrącenia − hostel (+dojazd/odzież/dokumenty…).
const TOL = 0.05; // заокруглення в таблицях

// Чистий розрахунок «до виплати» з компонентів рядка (формула таблиці) —
// використовується і для звірки з клітинкою, і для перерахунку після
// ручного редагування на сайті. null = бракує даних (годин/ставки).
type PayoutLike = Pick<SvodniParsedRow,
  "hours" | "rateNetto" | "premia" | "zaliczka" | "zaliczkaBd" | "hostel" | "odziez"
  | "dojazd" | "kara" | "komornik" | "kaucja" | "potracenia" | "extras">;
export function computePayout(row: PayoutLike, city: "Люблін" | "Познань" | "Лодзь"): number | null {
  if (row.hours == null || row.rateNetto == null) return null;
  const ex = (k: string) => (typeof row.extras[k] === "number" ? (row.extras[k] as number) : 0);
  let ours: number;
  if (city === "Лодзь") {
    ours = row.hours * row.rateNetto + ex("migawka") + (row.premia ?? 0) + (row.dojazd ?? 0)
      - (row.zaliczka ?? 0) - (row.potracenia ?? 0) - (row.hostel ?? 0) - (row.odziez ?? 0) - ex("dokumenty");
  } else {
    ours = row.hours * row.rateNetto
      + ex("nocneH") * ex("doplataNocna")
      + (row.premia ?? 0) + ex("oplataKierowcy") + ex("doplataEs") + ex("zwrotKosztow")
      - (row.zaliczka ?? 0) - (row.zaliczkaBd ?? 0) - (row.hostel ?? 0) - (row.odziez ?? 0)
      - (row.dojazd ?? 0) - (row.kara ?? 0) - (row.komornik ?? 0) - (row.kaucja ?? 0)
      - (row.potracenia ?? 0) - ex("badania") - ex("kartaPobytu") - ex("karaKlient") - ex("karaEs") - ex("zadluzenie");
  }
  return r2(ours);
}

export function computeMismatch(row: SvodniParsedRow, city: "Люблін" | "Познань" | "Лодзь"): void {
  const sheet = row.doWyplaty;
  if (sheet == null) return;
  const ours = computePayout(row, city);
  if (ours == null) return;
  row.sheetValues.doWyplaty = sheet;
  if (Math.abs(ours - sheet) > TOL) {
    row.mismatch = { ...(row.mismatch ?? {}), doWyplaty: { ours, sheet } };
  }
}
