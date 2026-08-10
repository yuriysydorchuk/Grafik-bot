// Парсер флотових фактур ORLEN («Rozliczenie Nr …»): шапка + детальний wykaz
// транзакцій по картках. Два шари: extractPdfItems (pdfjs, тонкий) і чистий
// parseOrlenInvoice (текстові елементи з координатами → структура) — під
// юніт-тестами з фікстурою (правило: парсери під тестами).
//
// Формат wykaz-у: рядок транзакції «висить» на 17-цифровому номері картки;
// дата і час (та другий рядок назви продукту) — окремі елементи в межах
// вертикальної смуги рядка. Тип секції (паливо в літрах / товари в штуках)
// визначає найближчий зверху заголовок колонок: «Ilość w l/kg» vs «Ilość sztuk».

export type PdfItem = { s: string; x: number; y: number };

export type OrlenTx = {
  lp: number;
  cardNumber: string;
  regNumber: string | null;
  product: string;
  isFuel: boolean;
  stationCity: string | null;
  stationNo: string | null;
  txDate: string;          // YYYY-MM-DD
  txTime: string | null;   // HH:MM:SS
  qty: number;
  unitPrice: number | null;
  priceAfterRebate: number | null;
  vatRate: number | null;  // null = ND
  net: number;
  vatAmount: number;
  gross: number;
};

export type ParsedOrlenInvoice = {
  number: string;
  invoiceDate: string;     // YYYY-MM-DD
  saleDate: string | null;
  ksefNumber: string | null;
  net: number;
  vat: number;
  gross: number;
  transactions: OrlenTx[];
  warnings: string[];
};

const CARD_RE = /^\d{17}$/;
// картка може бути злита з сусідньою колонкою в один елемент («7897… 2026-01-21»)
const CARD_IN_RE = /(?:^|\s)\d{17}(?:\s|$)/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;
// номер авто: 2-3 літери + цифри/літери, мін. 2 цифри (LU113LA, NBR11324, DX0052A)
const REG_RE = /^[A-Z]{2,3}[0-9A-Z]{4,6}$/;
const NUM_RE = /^-?\d{1,3}(?:[  ]\d{3})*[.,]\d{1,2}-?$|^-?\d+[.,]\d{1,2}-?$|^\d+$/;

const r2 = (n: number) => Math.round(n * 100) / 100;

// "18 836,27" | "17.851,00" | "217.68" | "98,87-" → число. Мінус може бути в
// хвості; тисячні розділювачі гуляють між фактурами (пробіл/nbsp або крапка),
// десятковий — кома (шапка) або крапка з 2 знаками (wykaz).
export function parseOrlenNum(s: string): number | null {
  let t = s.replace(/[\s\u00a0\u202f]/g, "");
  let neg = false;
  if (t.startsWith("-")) { neg = true; t = t.slice(1); }
  if (t.endsWith("-")) { neg = true; t = t.slice(0, -1); }
  if (!/^\d[\d.,]*$/.test(t)) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");  // кома — десяткова
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(t) && !/\.\d{2}$/.test(t)) t = t.replace(/\./g, ""); // крапки-тисячні
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

const isoDate = (ddmmyyyy: string): string | null => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(ddmmyyyy.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

// Рядки сторінки: групування елементів по y (толеранс), сортування зверху вниз.
function pageLines(items: PdfItem[]): { y: number; text: string }[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; parts: PdfItem[] }[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= 3) last.parts.push(it);
    else lines.push({ y: it.y, parts: [it] });
  }
  return lines.map(l => ({ y: l.y, text: l.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(" ") }));
}

// Шапка + підсумки — з обох перших сторінок (totals «Ogółem» друкуються в кінці
// зведення позицій, зазвичай стор. 2).
function parseHeader(pages: PdfItem[][], warnings: string[]) {
  const text = pages.slice(0, 3).map(p => pageLines(p).map(l => l.text).join("\n")).join("\n");
  const number = /Rozliczenie Nr\s+(\d+)/.exec(text)?.[1] ?? null;
  const invoiceDate = isoDate(/dnia:\s*(\d{2}\.\d{2}\.\d{4})/.exec(text)?.[1] ?? "");
  const saleDate = isoDate(/Data sprzedaży:\s*(\d{2}\.\d{2}\.\d{4})/.exec(text)?.[1] ?? "");
  const ksefNumber = /NrKSEF:\s*([A-Z0-9-]{10,})/i.exec(text)?.[1] ?? null;

  let net = 0, vat = 0, gross = 0;
  const totalLine = text.split("\n").find(l => /^Ogółem(?!\s+dla)/.test(l.trim()));
  if (totalLine) {
    const nums = totalLine.match(/-?\d{1,3}(?:[ \u00a0\u202f.]\d{3})*,\d{2}-?/g)?.map(parseOrlenNum) ?? [];
    if (nums.length >= 3 && nums.every(n => n != null)) [net, vat, gross] = nums as number[];
    else warnings.push("не розібрав рядок «Ogółem»");
  } else warnings.push("не знайшов рядок «Ogółem» з підсумками");

  return { number, invoiceDate, saleDate, ksefNumber, net, vat, gross };
}

// Токени смуги рядка: слова елементів у порядку колонок (x, при збігу — верхній
// рядок комірки перший). Зберігаємо x елемента для лівіше/правіше картки.
type Tok = { w: string; x: number; y: number };
function bandTokens(items: PdfItem[], cy: number, headerYs: number[]): Tok[] {
  // у товарній таблиці заголовок колонок друкується над КОЖНИМ рядком (~8pt) —
  // лінії заголовків виключаємо зі смуги явно
  const band = items
    .filter(it => Math.abs(it.y - cy) <= 9 && !headerYs.some(hy => Math.abs(it.y - hy) <= 3))
    .sort((a, b) => a.x - b.x || b.y - a.y);
  const toks: Tok[] = [];
  for (const it of band) for (const w of it.s.split(/\s+/)) if (w) toks.push({ w, x: it.x, y: it.y });
  return toks;
}

function parseTxRow(toks: Tok[], cy: number, isFuel: boolean, warnings: string[]): OrlenTx | null {
  const cardIdx = toks.findIndex(t => CARD_RE.test(t.w));
  if (cardIdx < 0) return null;
  const card = toks[cardIdx]!;
  const left = toks.slice(0, cardIdx);
  const right = toks.slice(cardIdx + 1);

  // Зліва: lp, позиція фактури, назва продукту (може з CN-кодом), номер авто.
  if (left.length < 3 || !/^\d+$/.test(left[0]!.w) || !/^\d+$/.test(left[1]!.w)) {
    warnings.push(`пропустив рядок біля картки ${card.w}: не бачу lp/позиції`);
    return null;
  }
  const lp = Number(left[0]!.w);
  let prodToks = left.slice(2).map(t => t.w);
  let regNumber: string | null = null;
  const lastProd = prodToks[prodToks.length - 1];
  if (lastProd && REG_RE.test(lastProd) && !/^CN\d+$/.test(lastProd) && /\d{2}/.test(lastProd)) {
    regNumber = lastProd;
    prodToks = prodToks.slice(0, -1);
  }
  const product = prodToks.join(" ").replace(/\s*CN\d+\s*$/, "").trim();

  // Справа: станція («Місто - №»), рід станції (2-3 літери), дата, час, MPK, числа.
  const dateIdx = right.findIndex(t => DATE_RE.test(t.w));
  if (dateIdx < 0) {
    warnings.push(`пропустив рядок lp=${lp}: немає дати транзакції`);
    return null;
  }
  const txDate = right[dateIdx]!.w;
  // час стоїть окремим рядком комірки НИЖЧЕ центру; у смугу може потрапити і
  // час сусіднього рядка зверху — беремо найближчий знизу від центру
  const txTime = right
    .filter(t => TIME_RE.test(t.w) && t.y <= cy + 2)
    .sort((a, b) => b.y - a.y)[0]?.w ?? null;

  let stationCity: string | null = null, stationNo: string | null = null;
  const stToks = right.slice(0, dateIdx).filter(t => !TIME_RE.test(t.w)).map(t => t.w);
  while (stToks.length && /^[A-ZĄĆĘŁŃÓŚŹŻ]{1,3}$/.test(stToks[stToks.length - 1]!)) stToks.pop(); // Rodzaj stacji (ST…)
  const stStr = stToks.join(" ");
  const stM = /^(.*?)\s*-\s*(\d{1,5})$/.exec(stStr);
  if (stM) { stationCity = stM[1]!.trim() || null; stationNo = stM[2]!; }
  else if (stStr) stationCity = stStr;

  const nums = right
    .slice(dateIdx + 1)
    .filter(t => !TIME_RE.test(t.w) && !DATE_RE.test(t.w) && NUM_RE.test(t.w))
    .map(t => parseOrlenNum(t.w))
    .filter((n): n is number => n != null);
  // VAT «ND» (kaucje): колонки Wartość VAT і netto порожні — лише [qty, cena, brutto]
  if (nums.length === 3 && right.some(t => t.w === "ND")) {
    return {
      lp, cardNumber: card.w, regNumber, product, isFuel, stationCity, stationNo,
      txDate, txTime, qty: nums[0]!, unitPrice: nums[1] ?? null, priceAfterRebate: null,
      vatRate: null, net: nums[2]!, vatAmount: 0, gross: nums[2]!,
    };
  }
  if (nums.length < 4) {
    warnings.push(`пропустив рядок lp=${lp}: замало числових колонок (${nums.length})`);
    return null;
  }
  const net = nums[nums.length - 1]!, vatAmount = nums[nums.length - 2]!, gross = nums[nums.length - 3]!;
  const rem = nums.slice(0, nums.length - 3);
  const qty = rem[0] ?? 0;
  const unitPrice = rem[1] ?? null;
  // паливо: [qty, cena, cena po rabacie, VAT%]; товари: [qty, cena za szt., VAT%]
  const priceAfterRebate = isFuel ? rem[2] ?? null : null;
  const vatTok = isFuel ? rem[3] : rem[2];
  const vatRate = vatTok != null && Number.isInteger(vatTok) && vatTok >= 0 && vatTok <= 30 ? vatTok : null;

  return {
    lp, cardNumber: card.w, regNumber, product, isFuel, stationCity, stationNo,
    txDate, txTime, qty, unitPrice, priceAfterRebate, vatRate,
    net, vatAmount, gross,
  };
}

export function parseOrlenInvoice(pages: PdfItem[][]): ParsedOrlenInvoice {
  const warnings: string[] = [];
  const head = parseHeader(pages, warnings);
  if (!head.number) throw new Error("не знайшов «Rozliczenie Nr …» — це не флотова фактура Orlen?");
  if (!head.invoiceDate) throw new Error("не знайшов дату фактури («Płock, dnia: …»)");

  const transactions: OrlenTx[] = [];
  // Тип секції переноситься між сторінками: заголовок колонок повторюється
  // на кожній міні-таблиці, але станом «паливо/товари» страхуємось і між сторінками.
  let sectionIsFuel: boolean | null = null;

  for (const items of pages) {
    // маркери типу секції на цій сторінці (y заголовка колонок)
    const lines = pageLines(items);
    const markers = lines
      .filter(l => /Ilość w l\/kg/.test(l.text) || /Ilość sztuk/.test(l.text))
      .map(l => ({ y: l.y, fuel: /Ilość w l\/kg/.test(l.text) }));
    const headerYs = lines.filter(l => /Nazwa produktu/.test(l.text)).map(l => l.y);

    const cards = items
      .filter(it => CARD_IN_RE.test(it.s))
      .sort((a, b) => b.y - a.y);
    for (const card of cards) {
      const above = markers.filter(m => m.y > card.y).sort((a, b) => a.y - b.y)[0];
      const isFuel: boolean | null = above ? above.fuel : sectionIsFuel;
      if (isFuel == null) { warnings.push(`картка ${card.s}: не визначив тип секції — рядок пропущено`); continue; }
      sectionIsFuel = isFuel;
      const tx = parseTxRow(bandTokens(items, card.y, headerYs), card.y, isFuel, warnings);
      if (tx) transactions.push(tx);
    }
    if (markers.length) sectionIsFuel = markers.sort((a, b) => a.y - b.y)[0]!.fuel;
  }

  const dup = new Set<number>();
  for (const tx of transactions) {
    if (dup.has(tx.lp)) warnings.push(`подвійний lp=${tx.lp} — перевір парсинг`);
    dup.add(tx.lp);
  }

  return {
    number: head.number,
    invoiceDate: head.invoiceDate,
    saleDate: head.saleDate,
    ksefNumber: head.ksefNumber,
    net: r2(head.net), vat: r2(head.vat), gross: r2(head.gross),
    transactions,
    warnings,
  };
}

// ── pdfjs-шар ───────────────────────────────────────────────────────────────
// Текстові елементи з координатами по сторінках. Тонкий, без логіки.
export async function extractPdfItems(data: Uint8Array): Promise<PdfItem[][]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data, useSystemFonts: true, disableFontFace: true });
  const doc = await task.promise;
  try {
    const pages: PdfItem[][] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      // Таблиці wykaz-у надруковані повернутим на 90° текстом на портретній
      // сторінці (ротація сидить у матриці елемента, не в сторінці). Зводимо
      // до візуальних координат читача (x — вправо, y — вгору) за напрямком
      // базової лінії тексту (a,b з transform). Повернуті елементи отримують
      // відʼємні y — з нормальними (шапка/футер) вони не перетинаються.
      pages.push(
        (tc.items as Array<{ str?: string; transform?: number[] }>)
          .filter(i => typeof i.str === "string" && i.str.trim() !== "" && Array.isArray(i.transform))
          .map(i => {
            const [a = 1, b = 0, , , e = 0, f = 0] = i.transform!;
            let x: number, y: number;
            if (Math.abs(b) > Math.abs(a)) {
              if (b > 0) { x = f; y = -e; }        // 90°: текст біжить уздовж +y
              else { x = -f; y = e; }              // 270°
            } else if (a >= 0) { x = e; y = f; }   // звичайний
            else { x = -e; y = -f; }               // 180°
            return { s: i.str!.trim(), x, y };
          }),
      );
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

export async function parseOrlenPdf(data: Uint8Array): Promise<ParsedOrlenInvoice> {
  return parseOrlenInvoice(await extractPdfItems(data));
}
