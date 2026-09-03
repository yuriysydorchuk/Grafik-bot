// OCR-сервіси на Google Cloud. Дві незалежні частини:
// 1) Фактури — Google Document AI (інвойс-процесор, проєкт invoice-bot-123,
//    локація eu). Фото/PDF → чернетка: постачальник (+NIP), номер, дата
//    виставлення, брутто, наша фірма (по NIP покупця).
// 2) Паспорт (worker-docs-signing) — звичайний Vision API TEXT_DETECTION +
//    власний MRZ-парсер нижче, не окремий платний Document AI-процесор
//    (див. коментар біля processPassport).
// Чисті хелпери мапінгу (entitiesToDraft, sanitizeAmount, parsePassportMrz, …) —
// під тестами docai.test.ts.
import fs from "node:fs";
import { google } from "googleapis";
import heicConvert from "heic-convert";
import sharp from "sharp";
import { logger } from "../lib/logger";
import { sniffDocMime } from "../lib/uploads";

// ── Чисті хелпери ──────────────────────────────────────────────────────────────

export type DocAiEntity = {
  type?: string | null;
  mentionText?: string | null;
  confidence?: number | null;
  normalizedValue?: { text?: string | null } | null;
  properties?: DocAiEntity[] | null;
};

export type InvoiceDraft = {
  seller: string | null;
  sellerNip: string | null;
  customerNip: string | null;
  number: string | null;
  issueDate: string | null; // ISO YYYY-MM-DD
  gross: number | null;
  net: number | null;
};

// Польські формати сум: "12 345,67", "12.345,67", "12345.67" → число
export function sanitizeAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d.,\s]/g, "").trim();
  if (!s) return null;
  s = s.replace(/\s/g, "");
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");      // 12.345,67 → 12345.67
  else if (lastDot > lastComma) s = s.replace(/,/g, "");                    // 12,345.67 → 12345.67
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export const normNip = (s: string | null | undefined): string | null => {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length === 10 ? d : null;
};

// "31.07.2026" | "2026-07-31" | "31/07/2026" → ISO
export function normDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return null;
}

const SUPPLIER_TYPES = new Set(["supplier", "seller", "sprzedawca", "wystawca", "dostawca"]);
const CUSTOMER_TYPES = new Set(["buyer", "customer", "receiver", "recipient", "nabywca", "odbiorca"]);

// Мапінг сутностей інвойс-процесора в чернетку (порт flatten_entities з бота Faktury)
export function entitiesToDraft(entities: DocAiEntity[], fullText = ""): InvoiceDraft {
  const best: Record<string, { v: string; conf: number }> = {};
  const keep = (key: string, val: string | null | undefined, conf: number | null | undefined) => {
    const v = (val ?? "").trim();
    if (!v) return;
    if (!best[key] || (conf ?? 0) >= best[key]!.conf) best[key] = { v, conf: conf ?? 0 };
  };
  const valOf = (e: DocAiEntity) => e.normalizedValue?.text || e.mentionText || "";

  for (const ent of entities) {
    const etype = (ent.type ?? "").toLowerCase();
    if (SUPPLIER_TYPES.has(etype) || CUSTOMER_TYPES.has(etype)) {
      const prefix = SUPPLIER_TYPES.has(etype) ? "supplier" : "customer";
      keep(`${prefix}_name`, valOf(ent), ent.confidence);
      for (const p of ent.properties ?? []) {
        const ptype = (p.type ?? "").toLowerCase();
        if (ptype === "name" || ptype === "company_name") keep(`${prefix}_name`, valOf(p), p.confidence);
        if (["tax_id", "vat_id", "vat", "nip"].includes(ptype)) keep(`${prefix}_tax_id`, valOf(p), p.confidence);
      }
      continue;
    }
    if (etype && etype !== "line_item") keep(etype, valOf(ent), ent.confidence);
  }
  const g = (k: string) => best[k]?.v ?? null;

  // дата: normalized ISO від процесора; фолбек — «data wystawienia» у тексті
  let issueDate = normDate(g("invoice_date"));
  if (!issueDate) {
    const m = fullText.match(/wystawieni\w*\D{0,20}?(\d{1,2}[./]\d{1,2}[./]\d{4}|\d{4}-\d{2}-\d{2})/i);
    if (m) issueDate = normDate(m[1]);
  }
  // номер: invoice_id; фолбек — рядок після "Faktura (VAT) nr"
  let number = g("invoice_id");
  if (!number) {
    const m = fullText.match(/FAKTURA(?:\s+VAT)?\s*(?:NR|NUMER)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/._ ]{2,30})/i);
    if (m) number = m[1]!.trim().replace(/\s+/g, " ");
  }
  return {
    seller: g("supplier_name"),
    sellerNip: normNip(g("supplier_tax_id")),
    customerNip: normNip(g("customer_tax_id")),
    number: number?.trim() || null,
    issueDate,
    gross: sanitizeAmount(g("total_amount")) ?? sanitizeAmount(g("grand_total")) ?? sanitizeAmount(g("amount_due")),
    net: sanitizeAmount(g("net_amount")) ?? sanitizeAmount(g("subtotal")),
  };
}

// Наша фірма-покупець: NIP покупця з сутностей; фолбек — свій NIP у тексті,
// який НЕ дорівнює NIP-у постачальника.
export function detectOurCompany(
  draft: InvoiceDraft,
  fullText: string,
  companies: { id: number; nip: string | null }[],
): number | null {
  const byNip = new Map(companies.filter(c => normNip(c.nip)).map(c => [normNip(c.nip)!, c.id]));
  if (draft.customerNip && byNip.has(draft.customerNip)) return byNip.get(draft.customerNip)!;
  const found = new Set<number>();
  for (const [nip, id] of byNip) {
    if (nip === draft.sellerNip) continue;
    if (new RegExp(nip.split("").join("[\\s-]?")).test(fullText)) found.add(id);
  }
  return found.size === 1 ? [...found][0]! : null;
}

// ── Паспорт (Google Vision API TEXT_DETECTION + MRZ) ─────────────────────────────
// Спершу планувався окремий Document AI Identity Document processor (~$0.10/
// документ, платний ресурс під створення в консолі) — після звірки цін замінено
// на звичайний Vision API TEXT_DETECTION (1000 сканів/міс безкоштовно, далі
// $1.50/1000) + власний MRZ-парсер із чек-сумами нижче. Паспорт має спеціальну
// машинозчитувану зону саме для дешевого розпізнавання — платний «розумний»
// процесор для цього не потрібен. OCR лише ПРОПОНУЄ значення (worker_questionnaires
// зі статусом draft) — людина завжди підтверджує перед генерацією документів.
export type PassportDraft = {
  passportNumber: string | null;
  passportCountry: string | null;
  passportIssuedAt: string | null;
  passportExpiresAt: string | null;
  citizenship: string | null;
  sex: string | null;
  birthDate: string | null;
  fullName: string | null;
  // Структуровані ім'я/по-батькові/прізвище (MRZ givenNames/surname — ICAO 9303
  // вже розділяє їх структурно, тут лише не втрачаємо цю структуру).
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
};

// MRZ не кодує дату видачі паспорта (лише народження й закінчення — ICAO 9303) —
// це поле лишається порожнім, працівник/офіс вводить вручну.
export function mrzToPassportDraft(mrz: MrzResult | null): PassportDraft {
  if (!mrz) return { passportNumber: null, passportCountry: null, passportIssuedAt: null, passportExpiresAt: null, citizenship: null, sex: null, birthDate: null, fullName: null, firstName: null, middleName: null, lastName: null };
  // givenNames може містити кілька слів («JAN PAWEL») — перше = firstName,
  // решта (якщо є) = middleName; surname — прізвище як є (може бути складене).
  const givenParts = mrz.givenNames.split(/\s+/).filter(Boolean);
  const firstName = givenParts[0] || null;
  const middleName = givenParts.slice(1).join(" ") || null;
  const lastName = mrz.surname || null;
  return {
    passportNumber: mrz.documentNumber || null,
    passportCountry: mrz.issuingCountry || null,
    passportIssuedAt: null,
    passportExpiresAt: mrz.expiryDate,
    citizenship: mrz.nationality || null,
    sex: mrz.sex,
    birthDate: mrz.birthDate,
    fullName: [mrz.givenNames, mrz.surname].filter(Boolean).join(" ") || null,
    firstName, middleName, lastName,
  };
}

// ── MRZ (ICAO 9303 TD3, 2×44) — детерміновано з чек-сумами, без жодного OCR API ──
const MRZ_CHAR_VALUE = (c: string): number => {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "A" && c <= "Z") return c.charCodeAt(0) - 55; // A=10 … Z=35
  return 0; // '<' та інше — 0
};
const MRZ_WEIGHTS = [7, 3, 1];
function mrzCheckDigit(s: string): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += MRZ_CHAR_VALUE(s[i]!) * MRZ_WEIGHTS[i % 3]!;
  return sum % 10;
}
const mrzValid = (data: string, check: string): boolean => /^[0-9]$/.test(check) && mrzCheckDigit(data) === Number(check);

export type MrzResult = {
  documentNumber: string; issuingCountry: string; nationality: string;
  surname: string; givenNames: string; sex: "M" | "F" | null;
  birthDate: string | null; expiryDate: string | null;
  documentNumberValid: boolean; birthDateValid: boolean; expiryDateValid: boolean; compositeValid: boolean;
};

// Двоцифровий рік MRZ без діапазону контексту: дата народження — евристика
// «>30 → 19xx, інакше 20xx» (паспорт видають дорослим); дата закінчення —
// завжди 20xx (немає паспортів з майбутнім строком у 19xx).
function mrzYearToIso(yymmdd: string, isExpiry: boolean): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const century = isExpiry ? 2000 : (yy > 30 ? 1900 : 2000);
  return `${century + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

// Діагностика невдалого розпізнавання — БЕЗ самого тексту (паспортні дані —
// чутлива RODO-інформація, у логи не пишемо), лише структурні метрики: скільки
// рядків Vision взагалі побачив, скільки з них має форму MRZ-рядка (довжина
// 30-44, лише [A-Z0-9<]) і чи є серед них такий, що починається з "P" (перший
// рядок TD3). Дозволяє відрізнити «Vision взагалі нічого не розпізнав» від
// «розпізнав щось, але не збіглась структура/чек-сума» без логування самого паспорта.
export function mrzDiagnostics(text: string): { totalLines: number; candidateLines: number; candidateLengths: number[]; hasPStart: boolean } {
  const rawLines = text.split(/\r?\n/).filter(l => l.trim());
  const candidates = rawLines.map(l => l.trim().toUpperCase().replace(/\s/g, "")).filter(l => /^[A-Z0-9<]{30,44}$/.test(l));
  return {
    totalLines: rawLines.length,
    candidateLines: candidates.length,
    candidateLengths: candidates.map(l => l.length),
    hasPStart: candidates.some(l => l[0] === "P"),
  };
}

export function parsePassportMrz(text: string): MrzResult | null {
  const lines = text.split(/\r?\n/).map(l => l.trim().toUpperCase().replace(/\s/g, "")).filter(l => /^[A-Z0-9<]{30,44}$/.test(l));
  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = lines[i]!.padEnd(44, "<").slice(0, 44);
    const l2 = lines[i + 1]!.padEnd(44, "<").slice(0, 44);
    if (l1[0] !== "P" || !/^[A-Z<]{42}$/.test(l1.slice(2))) continue;
    if (!/^[A-Z0-9<]{44}$/.test(l2)) continue;

    const documentNumber = l2.slice(0, 9), docCheck = l2[9]!;
    const nationality = l2.slice(10, 13).replace(/</g, "");
    const birthRaw = l2.slice(13, 19), birthCheck = l2[19]!;
    const sexRaw = l2[20]!;
    const expiryRaw = l2.slice(21, 27), expiryCheck = l2[27]!;
    const compositeCheck = l2[43]!;
    const composite = l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43);

    const namePart = l1.slice(5);
    const [surnameRaw, givenRaw = ""] = namePart.split("<<");

    return {
      documentNumber: documentNumber.replace(/</g, ""),
      issuingCountry: l1.slice(2, 5).replace(/</g, ""),
      nationality,
      surname: (surnameRaw ?? "").replace(/</g, " ").trim(),
      givenNames: givenRaw.replace(/</g, " ").trim(),
      sex: sexRaw === "M" ? "M" : sexRaw === "F" ? "F" : null,
      birthDate: mrzYearToIso(birthRaw, false),
      expiryDate: mrzYearToIso(expiryRaw, true),
      documentNumberValid: mrzValid(documentNumber, docCheck),
      birthDateValid: mrzValid(birthRaw, birthCheck),
      expiryDateValid: mrzValid(expiryRaw, expiryCheck),
      compositeValid: mrzValid(composite, compositeCheck),
    };
  }
  return null;
}

// ── I/O: виклик Document AI / Vision ─────────────────────────────────────────────
export const docaiConfigured = (): boolean => !!(process.env.DOCAI_PROCESSOR && process.env.GOOGLE_DOCAI_KEY_FILE);
// Паспорт не потребує окремого processor ID (Vision API — спільний endpoint) —
// той самий сервісний ключ, що й для фактур, якщо в проєкті увімкнений Vision API.
export const passportOcrConfigured = (): boolean => !!process.env.GOOGLE_DOCAI_KEY_FILE;

async function callProcessor(buffer: Buffer, mimeType: string, processor: string): Promise<{ doc: any; fullText: string }> {
  const keyFile = process.env.GOOGLE_DOCAI_KEY_FILE;
  if (!processor || !keyFile || !fs.existsSync(keyFile)) throw new Error("Document AI не налаштований (processor / GOOGLE_DOCAI_KEY_FILE)");
  const location = processor.match(/locations\/([a-z0-9-]+)\//)?.[1] ?? "eu";
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const res: any = await client.request({
    url: `https://${location}-documentai.googleapis.com/v1/${processor}:process`,
    method: "POST",
    data: { rawDocument: { content: buffer.toString("base64"), mimeType }, skipHumanReview: true },
  });
  const doc = res.data?.document ?? {};
  return { doc, fullText: doc.text ?? "" };
}

export async function processInvoice(buffer: Buffer, mimeType: string): Promise<{ draft: InvoiceDraft; fullText: string }> {
  const { doc, fullText } = await callProcessor(buffer, mimeType, process.env.DOCAI_PROCESSOR ?? "");
  const draft = entitiesToDraft((doc.entities ?? []) as DocAiEntity[], fullText);
  logger.info({ number: draft.number, gross: draft.gross, sellerNip: draft.sellerNip }, "docai invoice parsed");
  return { draft, fullText };
}

async function callVisionOcr(buffer: Buffer): Promise<string> {
  const keyFile = process.env.GOOGLE_DOCAI_KEY_FILE;
  if (!keyFile || !fs.existsSync(keyFile)) throw new Error("OCR паспорта не налаштований (GOOGLE_DOCAI_KEY_FILE)");
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const res: any = await client.request({
    url: "https://vision.googleapis.com/v1/images:annotate",
    method: "POST",
    data: { requests: [{ image: { content: buffer.toString("base64") }, features: [{ type: "TEXT_DETECTION" }] }] },
  });
  const result = res.data?.responses?.[0];
  if (result?.error) throw new Error(result.error.message || "Vision API error");
  return result?.fullTextAnnotation?.text ?? result?.textAnnotations?.[0]?.description ?? "";
}

// Vision API визначає формат зображення з байтів сам і НЕ підтримує HEIC (лише
// JPEG/PNG/PDF/TIFF/…) — фото з бота завжди jpeg (Telegram перекодовує), але
// сканування через веб/«прикріпити файлом» з iPhone часто дає HEIC, тож
// конвертуємо в JPEG за магічними байтами (не заявленим mimeType — той самий
// принцип, що sniffDocMime в lib/uploads.ts) перед відправкою в Vision.
export async function toVisionCompatible(buffer: Buffer): Promise<Buffer> {
  if (sniffDocMime(buffer) !== "image/heic") return buffer;
  const out = await heicConvert({ buffer, format: "JPEG", quality: 0.92 });
  return Buffer.from(out);
}

// Телефонні фото часто зберігаються «лежачи» з EXIF-тегом орієнтації (той
// самий нюанс, що й services/imagePdf.ts — pdf-lib його теж ігнорує). Vision
// на нашому досвіді НЕ завжди повертає текст у правильному читальному
// порядку для такого фото: рядки MRZ (горизонтальні на екрані) у сирих
// пікселях йдуть вертикально, і fullTextAnnotation розбиває їх на короткі
// уривки замість двох чітких 44-символьних рядків (жоден не починається з
// "P" — симптом, який і виявив цю причину). sharp().rotate() без аргументів
// застосовує поворот з EXIF і одразу знімає сам тег — пікселі вже фізично
// вирівняні. Разом масштабуємо задовгу сторону (телефонні фото 4000px+ не
// дають Vision нічого корисного понад це, лише повільніше) і перекодовуємо
// в JPEG. Тільки для растрових зображень — PDF пропускаємо як є.
export async function normalizeForOcr(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer).rotate().resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  } catch (e) {
    logger.warn({ err: e }, "passport OCR: нормалізація зображення не вдалась, використовую оригінал");
    return buffer;
  }
}

// ICAO3 (MRZ nationality/issuing country) → каталог NATIONALITIES (routes/admin-api.ts,
// дзеркало web/src/lib/nationality.tsx). Мапимо лише країни, звідки реально
// приймаємо працівників — регіональні каталожні значення (africa/latin_america/…)
// з одного 3-літерного коду не вгадати надійно, лишаємо null (офіс доставить
// вручну в профілі за потреби). Використовується при створенні нового
// працівника з паспорта (routes/contracts.ts: createWorkerFromPassportScan).
const MRZ_NATIONALITY_TO_CATALOG: Record<string, string> = {
  UKR: "ukraine", BLR: "belarus", POL: "poland", MDA: "moldova",
  ROU: "romania", ROM: "romania", GEO: "georgia", AZE: "azerbaijan", TUR: "turkey",
};
// OCR плутає цифри з літерами в MRZ-коді країни («P0L» замість «POL», «5RB», «8GR»)
// — нормалізуємо перед мапою (реальний кейс 02.09.2026: власний паспорт зчитався як P0L).
const MRZ_OCR_FIX: Record<string, string> = { "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z" };
export const normalizeMrzCountry = (code: string | null): string | null =>
  code ? code.toUpperCase().replace(/[01582]/g, ch => MRZ_OCR_FIX[ch] ?? ch) : null;
export const mrzNationalityToCatalog = (code: string | null): string | null => {
  const norm = normalizeMrzCountry(code);
  return norm ? (MRZ_NATIONALITY_TO_CATALOG[norm] ?? null) : null;
};

// mimeType лишається в сигнатурі для узгодженості виклику з боту/роуту —
// формат реально визначається з байтів (toVisionCompatible/sniffDocMime).
export async function processPassport(buffer: Buffer, mimeType: string): Promise<{ draft: PassportDraft; mrz: MrzResult | null; fullText: string }> {
  let prepared = await toVisionCompatible(buffer);
  if (mimeType !== "application/pdf") prepared = await normalizeForOcr(prepared);
  const fullText = await callVisionOcr(prepared);
  const mrz = parsePassportMrz(fullText);
  const draft = mrzToPassportDraft(mrz);
  logger.info({ passportNumber: draft.passportNumber, mrzValid: mrz?.documentNumberValid ?? null }, "vision passport parsed");
  return { draft, mrz, fullText };
}