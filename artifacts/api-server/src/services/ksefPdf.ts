// PDF-візуалізація фактури KSeF з її XML (FA(2)/FA(3)) — за зразком стандартних
// візуалізацій «Krajowy System e-Faktur» (шапка з номером KSeF, Sprzedawca/Nabywca,
// Szczegóły, таблиця Pozycje, Podsumowanie stawek podatku, Płatność, Rejestry,
// QR-код верифікації qr.ksef.mf.gov.pl). Юридичний оригінал — XML; PDF допоміжний.
// Чистий модуль без БД/Drive: парсер полів під юніт-тестами, рендер — pdf-lib +
// шрифт DejaVu (польські знаки), QR — пакет qrcode.
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFFont, PDFPage, rgb, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import QRCode from "qrcode";

// ── Парсер FA-XML (регекси, толерантні до namespace-префіксів) ─────────────────

const tagRe = (name: string) => new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "g");
const one = (src: string | null, name: string): string | null => {
  if (!src) return null;
  const m = tagRe(name).exec(src);
  return m ? m[1]!.trim() : null;
};
const all = (src: string | null, name: string): string[] => {
  if (!src) return [];
  return [...src.matchAll(tagRe(name))].map(m => m[1]!.trim());
};
// текстове значення: без вкладених тегів + XML-ентіті
const txt = (src: string | null, name: string): string | null => {
  const v = one(src, name);
  if (v == null || /</.test(v)) return v && !/</.test(v) ? v : null;
  return v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
};

const num = (s: string | null): number | null => {
  if (s == null || s === "") return null;
  const n = Number(String(s).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const ddmmyyyy = (iso: string | null): string => (iso ? iso.slice(0, 10).split("-").reverse().join(".") : "");

const FORMA_PLATNOSCI: Record<string, string> = {
  "1": "Gotówka", "2": "Karta", "3": "Bon", "4": "Czek", "5": "Kredyt", "6": "Przelew", "7": "Mobilna",
};
const RODZAJ: Record<string, string> = {
  VAT: "Faktura podstawowa", KOR: "Faktura korygująca", ZAL: "Faktura zaliczkowa",
  ROZ: "Faktura rozliczeniowa", UPR: "Faktura uproszczona", KOR_ZAL: "Korekta faktury zaliczkowej", KOR_ROZ: "Korekta faktury rozliczeniowej",
};

export interface FaParty {
  nip: string | null; name: string | null; prefix: string | null;
  address: string[]; addressKoresp: string[]; clientNo: string | null;
}
export interface FaLine {
  lp: string; name: string; unitPrice: number | null; qty: string | null; unit: string | null;
  rate: string | null; net: number | null; gross: number | null; vat: number | null;
}
export interface ParsedFa {
  invoiceNumber: string | null; issueDate: string | null; place: string | null;
  currency: string; kind: string; kindLabel: string;
  deliveryPeriod: string | null;
  seller: FaParty; buyer: FaParty;
  lines: FaLine[];
  total: number | null;                                   // P_15 — kwota należności ogółem
  vatSummary: { rate: string; net: number; vat: number; gross: number }[];
  extraInfo: { key: string; value: string }[];            // DodatkowyOpis
  deductions: { reason: string; amount: number | null }[]; // Rozliczenie/Odliczenia
  toPay: number | null;                                   // Rozliczenie/DoZaplaty
  paymentForm: string | null; paymentTerms: string[];
  bankAccount: string | null; bankName: string | null;
  footer: string | null;                                  // Stopka/Informacje/StopkaFaktury
  registries: { name: string | null; krs: string | null; regon: string | null }[];
}

function parseParty(src: string | null): FaParty {
  const ident = one(src, "DaneIdentyfikacyjne");
  const adres = one(src, "Adres");
  const koresp = one(src, "AdresKoresp");
  const addrLines = (b: string | null): string[] => {
    const lines = [txt(b, "AdresL1"), txt(b, "AdresL2")].filter(Boolean) as string[];
    const kraj = txt(b, "KodKraju");
    if (kraj) lines.push(kraj === "PL" ? "Polska" : kraj);
    return lines;
  };
  return {
    nip: txt(ident, "NIP"),
    name: txt(ident, "Nazwa") ?? ([txt(ident, "ImiePierwsze"), txt(ident, "Nazwisko")].filter(Boolean).join(" ") || null),
    prefix: txt(src, "PrefiksPodatnika"),
    address: addrLines(adres),
    addressKoresp: addrLines(koresp),
    clientNo: txt(src, "NrKlienta"),
  };
}

export function parseFaInvoice(xml: string): ParsedFa {
  const fa = one(xml, "Fa") ?? xml;
  const kind = txt(fa, "RodzajFaktury") ?? "VAT";

  const okres = one(fa, "OkresFa");
  const p6 = txt(fa, "P_6");
  const deliveryPeriod = okres
    ? `od ${ddmmyyyy(txt(okres, "P_6_Od"))} do ${ddmmyyyy(txt(okres, "P_6_Do"))}`
    : p6 ? ddmmyyyy(p6) : null;

  const lines: FaLine[] = all(fa, "FaWiersz").map(w => {
    const net = num(txt(w, "P_11"));
    const grossX = num(txt(w, "P_11A"));
    const rate = txt(w, "P_12");
    const rateN = num(rate);
    const vat = grossX != null && net != null ? r2(grossX - net)
      : net != null && rateN != null ? r2(net * rateN / 100) : null;
    const gross = grossX ?? (net != null && vat != null ? r2(net + vat) : net);
    return {
      lp: txt(w, "NrWierszaFa") ?? "", name: txt(w, "P_7") ?? "",
      unitPrice: num(txt(w, "P_9A")), qty: txt(w, "P_8B"), unit: txt(w, "P_8A"),
      rate, net, gross, vat,
    };
  });

  // Підсумок по ставках — з агрегатів P_13_x/P_14_x (як у зразку); чого нема в XML,
  // те не малюємо (докладати з рядків не ризикуємо — джерело правди агрегати)
  const vatSummary: ParsedFa["vatSummary"] = [];
  const sumRow = (label: string, netKeys: string[], vatKeys: string[]) => {
    const net = netKeys.map(k => num(txt(fa, k)) ?? 0).reduce((a, b) => a + b, 0);
    const vat = vatKeys.map(k => num(txt(fa, k)) ?? 0).reduce((a, b) => a + b, 0);
    const present = netKeys.some(k => txt(fa, k) != null) || vatKeys.some(k => txt(fa, k) != null);
    if (present) vatSummary.push({ rate: label, net: r2(net), vat: r2(vat), gross: r2(net + vat) });
  };
  sumRow("23% lub 22%", ["P_13_1"], ["P_14_1"]);
  sumRow("8% lub 7%", ["P_13_2"], ["P_14_2"]);
  sumRow("5%", ["P_13_3"], ["P_14_3"]);
  sumRow("ryczałt (taxi)", ["P_13_4"], ["P_14_4"]);
  sumRow("0%", ["P_13_6_1", "P_13_6_2", "P_13_6_3", "P_13_6"], []);
  sumRow("zw", ["P_13_7"], []);
  sumRow("np", ["P_13_8", "P_13_9"], []);
  sumRow("oo", ["P_13_10"], []);
  sumRow("marża", ["P_13_11"], []);

  const platnosc = one(fa, "Platnosc");
  const formaCode = txt(platnosc, "FormaPlatnosci");
  const rachunek = one(platnosc, "RachunekBankowy");
  const rozliczenie = one(fa, "Rozliczenie");
  const stopka = one(xml, "Stopka");

  return {
    invoiceNumber: txt(fa, "P_2") ?? txt(fa, "P_2A"),
    issueDate: txt(fa, "P_1"),
    place: txt(fa, "P_1M"),
    currency: txt(fa, "KodWaluty") ?? "PLN",
    kind, kindLabel: RODZAJ[kind] ?? `Faktura (${kind})`,
    deliveryPeriod,
    seller: parseParty(one(xml, "Podmiot1")),
    buyer: parseParty(one(xml, "Podmiot2")),
    lines,
    total: num(txt(fa, "P_15")),
    vatSummary,
    extraInfo: all(fa, "DodatkowyOpis").map(b => ({ key: txt(b, "Klucz") ?? "", value: txt(b, "Wartosc") ?? "" }))
      .filter(x => x.key || x.value),
    deductions: all(rozliczenie, "Odliczenia").map(b => ({ reason: txt(b, "Powod") ?? "", amount: num(txt(b, "Kwota")) })),
    toPay: num(txt(rozliczenie, "DoZaplaty")),
    paymentForm: formaCode ? FORMA_PLATNOSCI[formaCode] ?? formaCode : null,
    paymentTerms: all(platnosc, "TerminPlatnosci").map(b => ddmmyyyy(txt(b, "Termin"))).filter(Boolean),
    bankAccount: txt(rachunek, "NrRB"),
    bankName: txt(rachunek, "NazwaBanku"),
    footer: txt(one(stopka, "Informacje"), "StopkaFaktury"),
    registries: all(stopka, "Rejestry").map(b => ({ name: txt(b, "PelnaNazwa"), krs: txt(b, "KRS"), regon: txt(b, "REGON") }))
      .filter(r => r.name || r.krs || r.regon),
  };
}

// Лінк верифікації (QR): NIP продавця / дата виставлення dd-mm-yyyy / SHA-256(XML) base64url
export function ksefVerificationUrl(xml: string, sellerNip: string, issueDate: string): string {
  const hash = crypto.createHash("sha256").update(Buffer.from(xml, "utf8")).digest("base64url");
  const d = issueDate.slice(0, 10).split("-").reverse().join("-");
  return `https://qr.ksef.mf.gov.pl/invoice/${sellerNip}/${d}/${hash}`;
}

// ── Рендер ─────────────────────────────────────────────────────────────────────

const A4: [number, number] = [595.28, 841.89];
const M = 40;                      // поля
const W = A4[0] - 2 * M;           // робоча ширина
const BOTTOM = 46;                 // резерв під номер сторінки
const GRAY = rgb(0.45, 0.45, 0.45);
const LIGHT = rgb(0.82, 0.82, 0.82);
const BLACK = rgb(0.13, 0.13, 0.13);
const RED = rgb(0.85, 0.12, 0.12);
const SKY = rgb(0.05, 0.4, 0.75);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIRS = [path.resolve(HERE, "../../assets/fonts"), path.resolve(HERE, "../assets/fonts")];
function loadFont(file: string): Buffer {
  for (const d of FONT_DIRS) {
    const p = path.join(d, file);
    if (fs.existsSync(p)) return fs.readFileSync(p);
  }
  throw new Error(`font not found: ${file} (шукав у ${FONT_DIRS.join(", ")})`);
}

const money = (n: number | null | undefined): string =>
  n == null ? "" : n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyStr = (s: string | null): string => (s == null ? "" : String(Number(s.replace(",", ".")) || s).replace(".", ","));
// ціна одиниці: до 2 знаків — грошовий формат, довші (0,5032) — повна точність
const unitStr = (n: number | null): string => {
  if (n == null) return "";
  const dec = (String(n).split(".")[1] ?? "").length;
  return dec <= 2 ? money(n) : String(n).replace(".", ",");
};
const rateStr = (r: string | null): string => (r == null ? "" : /^\d+(\.\d+)?$/.test(r) ? `${r}%` : r);

class Painter {
  doc!: PDFDocument; page!: PDFPage; y = 0;
  font!: PDFFont; bold!: PDFFont;
  static async create(): Promise<Painter> {
    const p = new Painter();
    p.doc = await PDFDocument.create();
    p.doc.registerFontkit(fontkit);
    p.font = await p.doc.embedFont(loadFont("DejaVuSans.ttf"), { subset: true });
    p.bold = await p.doc.embedFont(loadFont("DejaVuSans-Bold.ttf"), { subset: true });
    p.addPage();
    return p;
  }
  addPage() { this.page = this.doc.addPage(A4); this.y = A4[1] - M; }
  ensure(h: number) { if (this.y - h < BOTTOM) this.addPage(); }
  wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
    const out: string[] = [];
    for (const para of String(text).split(/\n/)) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        // довжелезні токени (IBAN, лінки) ріжемо посимвольно
        let w = word;
        while (font.widthOfTextAtSize(w, size) > maxW) {
          let cut = w.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxW) cut--;
          const head = w.slice(0, cut);
          if (line) { out.push(line); line = ""; }
          out.push(head);
          w = w.slice(cut);
        }
        const cand = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(cand, size) <= maxW) line = cand;
        else { if (line) out.push(line); line = w; }
      }
      out.push(line);
    }
    return out.length ? out : [""];
  }
  text(str: string, x: number, size: number, opts: { bold?: boolean; color?: RGB; maxW?: number; align?: "left" | "right"; lineH?: number } = {}): number {
    const font = opts.bold ? this.bold : this.font;
    const lineH = opts.lineH ?? size * 1.35;
    const lines = opts.maxW ? this.wrap(str, font, size, opts.maxW) : [String(str)];
    for (const ln of lines) {
      this.ensure(lineH);
      const w = font.widthOfTextAtSize(ln, size);
      const px = opts.align === "right" ? x - w : x;
      this.page.drawText(ln, { x: px, y: this.y - size, size, font, color: opts.color ?? BLACK });
      this.y -= lineH;
    }
    return lines.length;
  }
  // пара «жирний підпис: значення» одним рядком (значення загортається з відступом)
  pair(label: string, value: string, x: number, size: number, maxW: number) {
    const lw = this.bold.widthOfTextAtSize(`${label}: `, size);
    const lines = this.wrap(value, this.font, size, maxW - lw);
    this.ensure(size * 1.35);
    this.page.drawText(`${label}: `, { x, y: this.y - size, size, font: this.bold, color: BLACK });
    this.page.drawText(lines[0] ?? "", { x: x + lw, y: this.y - size, size, font: this.font, color: BLACK });
    this.y -= size * 1.35;
    for (const ln of lines.slice(1)) this.text(ln, x + lw, size);
  }
  hr(gap = 10) {
    this.ensure(gap * 2);
    this.y -= gap;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + W, y: this.y }, thickness: 0.7, color: LIGHT });
    this.y -= gap;
  }
  section(title: string) {
    this.ensure(26);
    this.text(title, M, 11.5, { bold: true });
    this.y -= 2;
  }
  // таблиця з бордерами; заголовок повторюється на новій сторінці
  table(cols: { w: number; h: string; align?: "left" | "right" }[], rows: string[][], size = 8) {
    const pad = 4;
    const drawRow = (cells: string[], bold: boolean) => {
      const font = bold ? this.bold : this.font;
      const wrapped = cells.map((c, i) => this.wrap(c ?? "", font, size, cols[i]!.w - pad * 2));
      const h = Math.max(...wrapped.map(l => l.length)) * size * 1.3 + pad * 2;
      if (this.y - h < BOTTOM) { this.addPage(); if (!bold) drawRow(cols.map(c => c.h), true); return drawRow(cells, bold); }
      const top = this.y;
      let x = M;
      for (let i = 0; i < cols.length; i++) {
        const col = cols[i]!;
        this.page.drawRectangle({ x, y: top - h, width: col.w, height: h, borderColor: LIGHT, borderWidth: 0.6 });
        let ty = top - pad - size;
        for (const ln of wrapped[i]!) {
          const lw = font.widthOfTextAtSize(ln, size);
          this.page.drawText(ln, { x: col.align === "right" ? x + col.w - pad - lw : x + pad, y: ty, size, font, color: BLACK });
          ty -= size * 1.3;
        }
        x += col.w;
      }
      this.y = top - h;
      return undefined;
    };
    drawRow(cols.map(c => c.h), true);
    for (const r of rows) drawRow(r, false);
  }
  pageNumbers() {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      const label = `${i + 1} z ${pages.length}`;
      const w = this.font.widthOfTextAtSize(label, 8);
      p.drawText(label, { x: A4[0] - M - w, y: 24, size: 8, font: this.font, color: GRAY });
    });
  }
}

export interface KsefPdfMeta {
  ksefNumber: string;
  invoicingDate?: string | null; // дата надання номера KSeF (з метаданих)
}

export async function buildKsefInvoicePdf(xml: string, meta: KsefPdfMeta): Promise<Uint8Array> {
  const inv = parseFaInvoice(xml);
  const p = await Painter.create();

  // ── шапка ──
  const headParts: [string, RGB][] = [["Krajowy System ", BLACK], ["e-", RED], ["Faktur", BLACK]];
  let hx = M;
  for (const [part, color] of headParts) {
    p.page.drawText(part, { x: hx, y: p.y - 19, size: 19, font: p.bold, color });
    hx += p.bold.widthOfTextAtSize(part, 19);
  }
  const right = M + W;
  p.page.drawText("Numer Faktury:", { x: right - p.font.widthOfTextAtSize("Numer Faktury:", 9), y: p.y - 9, size: 9, font: p.font, color: GRAY });
  p.y -= 24;
  p.text(inv.invoiceNumber ?? "—", right, 15, { bold: true, align: "right" });
  p.text(inv.kindLabel, right, 9, { align: "right", color: GRAY });
  p.text(`Numer KSeF: ${meta.ksefNumber}`, right, 9, { align: "right" });
  if (meta.invoicingDate) p.text(`Data nadania numeru KSeF: ${ddmmyyyy(meta.invoicingDate)}`, right, 9, { align: "right" });
  p.hr();

  // ── сторони: дві колонки ──
  const colW = W / 2 - 12;
  const startY = p.y;
  const party = (x: number, title: string, pt: FaParty) => {
    p.y = startY;
    p.text(title, x, 11.5, { bold: true });
    p.y -= 2;
    if (pt.prefix) p.pair("Prefiks VAT", pt.prefix, x, 8.5, colW);
    if (pt.nip) p.pair("NIP", pt.nip, x, 8.5, colW);
    if (pt.name) p.pair("Nazwa", pt.name, x, 8.5, colW);
    if (pt.address.length) {
      p.y -= 4;
      p.text("Adres", x, 8.5, { bold: true });
      for (const ln of pt.address) p.text(ln, x, 8.5, { maxW: colW });
    }
    if (pt.addressKoresp.length) {
      p.y -= 4;
      p.text("Adres do korespondencji", x, 8.5, { bold: true });
      for (const ln of pt.addressKoresp) p.text(ln, x, 8.5, { maxW: colW });
    }
    if (pt.clientNo) { p.y -= 4; p.pair("Numer klienta", pt.clientNo, x, 8.5, colW); }
    return p.y;
  };
  const y1 = party(M, "Sprzedawca", inv.seller);
  const y2 = party(M + W / 2 + 12, "Nabywca", inv.buyer);
  p.y = Math.min(y1, y2);
  p.hr();

  // ── szczegóły ──
  p.section("Szczegóły");
  if (inv.issueDate) p.pair("Data wystawienia", ddmmyyyy(inv.issueDate), M, 8.5, W);
  if (inv.deliveryPeriod) p.pair("Data dokonania lub zakończenia dostawy / wykonania usługi", inv.deliveryPeriod, M, 8.5, W);
  if (inv.place) p.pair("Miejsce wystawienia", inv.place, M, 8.5, W);
  p.pair("Kod waluty", inv.currency, M, 8.5, W);
  p.hr();

  // ── pozycje ──
  if (inv.lines.length) {
    p.section("Pozycje");
    p.text(`Faktura wystawiona w walucie ${inv.currency}`, M, 8, { color: GRAY });
    p.y -= 4;
    p.table(
      [
        { w: 24, h: "Lp." },
        { w: 169, h: "Nazwa towaru lub usługi" },
        { w: 52, h: "Cena jedn. netto", align: "right" },
        { w: 34, h: "Ilość", align: "right" },
        { w: 34, h: "Miara" },
        { w: 50, h: "Stawka podatku" },
        { w: 51, h: "Wartość netto", align: "right" },
        { w: 51, h: "Wartość brutto", align: "right" },
        { w: 50, h: "Wartość VAT", align: "right" },
      ],
      inv.lines.map(l => [
        l.lp, l.name, unitStr(l.unitPrice), qtyStr(l.qty), l.unit ?? "",
        rateStr(l.rate), money(l.net), money(l.gross), money(l.vat),
      ]),
    );
    p.y -= 10;
  }
  if (inv.total != null) {
    p.ensure(20);
    p.text(`Kwota należności ogółem: ${money(inv.total)} ${inv.currency}`, M + W, 11, { bold: true, align: "right" });
  }

  // ── podsumowanie stawek ──
  if (inv.vatSummary.length) {
    p.y -= 4;
    p.section("Podsumowanie stawek podatku");
    p.table(
      [
        { w: 30, h: "Lp." },
        { w: 155, h: "Stawka podatku" },
        { w: 110, h: "Kwota netto", align: "right" },
        { w: 110, h: "Kwota podatku", align: "right" },
        { w: 110, h: "Kwota brutto", align: "right" },
      ],
      inv.vatSummary.map((s, i) => [String(i + 1), s.rate, money(s.net), money(s.vat), money(s.gross)]),
    );
  }

  // ── dodatkowe informacje ──
  if (inv.extraInfo.length) {
    p.y -= 6;
    p.section("Dodatkowe informacje");
    p.table(
      [{ w: 30, h: "Lp." }, { w: 130, h: "Rodzaj informacji" }, { w: 355, h: "Treść informacji" }],
      inv.extraInfo.map((x, i) => [String(i + 1), x.key, x.value]),
    );
  }

  // ── rozliczenie (odliczenia / do zapłaty) ──
  if (inv.deductions.length || inv.toPay != null) {
    p.y -= 6;
    p.section("Rozliczenie");
    if (inv.deductions.length) {
      p.table(
        [{ w: 355, h: "Powód odliczenia" }, { w: 160, h: "Kwota", align: "right" }],
        inv.deductions.map(d => [d.reason, money(d.amount)]),
      );
      p.y -= 4;
    }
    if (inv.toPay != null) p.text(`Do zapłaty: ${money(inv.toPay)} ${inv.currency}`, M + W, 11, { bold: true, align: "right" });
  }

  // ── płatność ──
  if (inv.paymentForm || inv.paymentTerms.length || inv.bankAccount) {
    p.y -= 6;
    p.section("Płatność");
    if (inv.paymentForm) p.pair("Forma płatności", inv.paymentForm, M, 8.5, W);
    if (inv.paymentTerms.length) p.pair("Termin płatności", inv.paymentTerms.join(", "), M, 8.5, W);
    if (inv.bankAccount) p.pair("Numer rachunku bankowego", inv.bankAccount, M, 8.5, W);
    if (inv.bankName) p.pair("Nazwa banku", inv.bankName, M, 8.5, W);
  }

  // ── rejestry / stopka ──
  if (inv.registries.length) {
    p.y -= 6;
    p.section("Rejestry");
    p.table(
      [{ w: 255, h: "Pełna nazwa" }, { w: 130, h: "KRS" }, { w: 130, h: "REGON" }],
      inv.registries.map(r => [r.name ?? "", r.krs ?? "", r.regon ?? ""]),
    );
  }
  if (inv.footer) {
    p.y -= 6;
    p.section("Pozostałe informacje");
    p.text(inv.footer, M, 7.5, { maxW: W, color: GRAY });
  }

  // ── QR верифікації ──
  if (inv.seller.nip && inv.issueDate) {
    const url = ksefVerificationUrl(xml, inv.seller.nip, inv.issueDate);
    const png = await QRCode.toBuffer(url, { type: "png", margin: 1, width: 240 });
    const img = await p.doc.embedPng(png);
    const qrSize = 100;
    p.hr();
    p.ensure(qrSize + 46);
    p.text("Sprawdź, czy Twoja faktura znajduje się w KSeF!", M, 11.5, { bold: true });
    p.y -= 4;
    const qrTop = p.y;
    p.page.drawImage(img, { x: M, y: qrTop - qrSize, width: qrSize, height: qrSize });
    p.y = qrTop;
    const tx = M + qrSize + 16;
    const tw = W - qrSize - 16;
    p.text("Nie możesz zeskanować kodu z obrazka? Kliknij w link weryfikacyjny i przejdź do weryfikacji faktury!", tx, 8.5, { maxW: tw });
    p.text(url, tx, 8, { maxW: tw, color: SKY });
    p.y = qrTop - qrSize - 6;
    p.text(meta.ksefNumber, M, 8, { color: GRAY });
  }

  p.pageNumbers();
  return p.doc.save();
}
