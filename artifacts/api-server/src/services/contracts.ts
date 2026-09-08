// Генерація пакетів документів (умова + додатки) — §4/§12 плану
// worker-docs-signing. Рушій: HTML {%Плейсхолдер%} (реальний формат шаблонів
// з архіву HrAppka, план Додаток A) → headless Chrome (Puppeteer) → PDF.
// Підпис/печатка НЕ малюються поверх координат — це повторний рендер того
// самого HTML з підставленим <img> у місце `{%Podpis odręczny ...%}`, оскільки
// сам шаблон уже описує, де саме виглядає підпис (порожній dashed-box у CSS).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { and, eq, inArray } from "drizzle-orm";
import puppeteer, { type Browser } from "puppeteer";
import {
  db, workersTable, factoriesTable, companiesTable, positionsTable, factoryPositionsTable, workerQuestionnairesTable,
  contractsTable, documentTemplatesTable, contractFilesTable, signatureEventsTable, type Contract, type DocumentTemplate,
} from "@workspace/db";
import { KSIEG_STD_BRUTTO } from "./svodni";
import { UPLOADS_ROOT, CONTRACTS_DIR, SIGNATURES_DIR, makeStoredName } from "../lib/uploads";
import { logger } from "../lib/logger";

export type Lang = "pl" | "en" | "es" | "ru" | "uk";
const LANGS: Lang[] = ["pl", "en", "es", "ru", "uk"];
export function asLang(v: string | null | undefined): Lang {
  return (LANGS as string[]).includes(v ?? "") ? (v as Lang) : "pl";
}

// ── Плейсхолдери ─────────────────────────────────────────────────────────────
// {%Ключ%} або {%Ключ модифікатор%} — модифікатор завжди останній «токен»:
// data:(d.m.Y) | format:tak_nie | format:iban | język:en|es|ru|uk
const PLACEHOLDER_RE = /\{%([^%]+)%\}/g;
const MODIFIER_RE = /^(data:|format:|język:)/;
const COMPANY_SIG_RE = /podpis.*pracodawc|piecz[eę]ć/i;
const WORKER_SIG_RE = /podpis.*pracownik/i;

export function parsePlaceholder(raw: string): { key: string; modifier: string | null } {
  const trimmed = raw.trim();
  const parts = trimmed.split(/\s+/);
  const last = parts[parts.length - 1]!;
  if (parts.length > 1 && MODIFIER_RE.test(last)) return { key: parts.slice(0, -1).join(" "), modifier: last };
  return { key: trimmed, modifier: null };
}

// Усі базові ключі (без модифікаторів), що реально трапляються в HTML — для
// перевірки повноти даних (missingFields) і для палітри редактора шаблонів.
export function extractPlaceholderKeys(html: string): string[] {
  const keys = new Set<string>();
  for (const m of html.matchAll(PLACEHOLDER_RE)) keys.add(parsePlaceholder(m[1]!).key);
  return [...keys];
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function formatPolishDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function formatValue(raw: string | undefined, modifier: string | null): string {
  const v = raw ?? "";
  if (!v) return "";
  if (modifier?.startsWith("data:")) return escapeHtml(formatPolishDate(v));
  if (modifier === "format:tak_nie") return v === "true" || v === "Tak" ? "Tak" : "Nie";
  return escapeHtml(v);
}

// Шаблони (архів HrAppka) обгортають {%Podpis...%} у dashed-рамку з сірим
// тлом (width/height + border: 1px dashed + background-color) — зручний
// плейсхолдер "постав підпис тут" в unsigned-прев'ю, але після РЕАЛЬНОГО
// підпису той самий dashed-бокс лишався навколо чорнила й виглядав як
// незаповнена форма (власник 03.09.2026). Знімаємо border/background САМЕ
// на боксі, куди підставляється реальне зображення — порожні боксі (ще не
// підписано) лишаються як є.
const SIG_BOX_RE = /<div\s+style="([^"]*)"([^>]*)>\s*\{%([^%]+)%\}\s*<\/div>/g;

// Підставляє дані в тіло шаблону. Підписи — окремий шлях (raw <img>, не
// екранується): opts.workerSignatureDataUrl / opts.companyStampDataUrl.
export function substitutePlaceholders(
  html: string, data: Record<string, string>,
  opts: { workerSignatureDataUrl?: string; companyStampDataUrl?: string } = {},
): string {
  const withSigBoxes = html.replace(SIG_BOX_RE, (whole: string, style: string, rest: string, raw: string) => {
    const { key } = parsePlaceholder(raw);
    const img = WORKER_SIG_RE.test(key) ? opts.workerSignatureDataUrl
      : COMPANY_SIG_RE.test(key) ? opts.companyStampDataUrl : undefined;
    if (!img) return whole; // не підпис, або ще не підписано — лишаємо як є
    const cleanStyle = style.replace(/border\s*:[^;]+;?/gi, "").replace(/background-color\s*:[^;]+;?/gi, "");
    return `<div style="${cleanStyle}"${rest}><img src="${img}" style="max-width:100%;max-height:100%;object-fit:contain" /></div>`;
  });
  return withSigBoxes.replace(PLACEHOLDER_RE, (_m, raw: string) => {
    const { key, modifier } = parsePlaceholder(raw);
    if (WORKER_SIG_RE.test(key)) {
      return opts.workerSignatureDataUrl
        ? `<img src="${opts.workerSignatureDataUrl}" style="max-width:100%;max-height:100%;object-fit:contain" />` : "";
    }
    if (COMPANY_SIG_RE.test(key)) {
      return opts.companyStampDataUrl
        ? `<img src="${opts.companyStampDataUrl}" style="max-width:100%;max-height:100%;object-fit:contain" />` : "";
    }
    return formatValue(data[key], modifier);
  });
}

// ── Дані для підстановки — словник РЕАЛЬНИХ польських ключів (архів HrAppka) ─
// Ключ відсутній у словнику (не просто "") ⇒ ми свідомо не вигадуємо джерело
// (напр. "Wynagrodzenie słownie", "Numer umowy", гранулярна адреса
// zameldowania/zamieszkania по woj./powiat/gmina — план §13, буде дороблено
// разом із конкретним документом, що це реально використовує). Такий ключ
// заблокує генерацію лише для шаблону, що його реально містить.
// Фірма в умові (рішення 05.09.2026): явно обрана при генерації (мультифірмова
// фабрика) → фірма фабрики → фірма профілю. Стара евристика «профіль → фабрика»
// лишається лише для сталого пакету без фабрики.
export async function resolveContractCompanyId(workerId: number, factoryId: number | null, explicit?: number | null): Promise<number | null> {
  if (explicit != null) return explicit;
  const [worker] = await db.select({ companyId: workersTable.companyId }).from(workersTable).where(eq(workersTable.id, workerId));
  if (factoryId == null) return worker?.companyId ?? null;
  const [factory] = await db.select({ companyId: factoriesTable.companyId, multiFirm: factoriesTable.multiFirm }).from(factoriesTable).where(eq(factoriesTable.id, factoryId));
  if (factory?.multiFirm) return worker?.companyId ?? factory.companyId ?? null;
  return factory?.companyId ?? worker?.companyId ?? null;
}

// {%Czynności%} — обов'язки в умові (рішення власника 05.09.2026: розписуються
// в налаштуваннях фабрики ПІД КОЖНУ ПОСАДУ): посада працівника на цій фабриці
// (factory_positions.contract_duties) → поле фабрики (factories.contract_duties)
// → назва посади. `source` — щоб модалка генерації показала, звідки текст,
// і попередила, коли для посади нічого не розписано.
export type ContractDutiesSource = "position" | "factory" | "position_name" | "none";
export async function resolveContractDuties(positionId: number | null, factoryId: number | null): Promise<{ text: string; source: ContractDutiesSource }> {
  if (factoryId != null && positionId != null) {
    const [fp] = await db.select({ d: factoryPositionsTable.contractDuties }).from(factoryPositionsTable)
      .where(and(eq(factoryPositionsTable.factoryId, factoryId), eq(factoryPositionsTable.positionId, positionId)));
    if (fp?.d) return { text: fp.d, source: "position" };
  }
  if (factoryId != null) {
    const [f] = await db.select({ d: factoriesTable.contractDuties }).from(factoriesTable).where(eq(factoriesTable.id, factoryId));
    if (f?.d) return { text: f.d, source: "factory" };
  }
  if (positionId != null) {
    const [p] = await db.select({ name: positionsTable.name }).from(positionsTable).where(eq(positionsTable.id, positionId));
    if (p?.name) return { text: p.name, source: "position_name" };
  }
  return { text: "", source: "none" };
}

export async function buildContractData(
  workerId: number, factoryId: number | null,
  dates: { dateFrom?: string | null; dateTo?: string | null } = {},
  rateOverride?: number | null,
  companyIdOverride?: number | null,
): Promise<Record<string, string>> {
  const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!worker) throw new Error("Працівника не знайдено");
  const [factory] = factoryId ? await db.select().from(factoriesTable).where(eq(factoriesTable.id, factoryId)) : [undefined];
  const [questionnaire] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  const [position] = worker.positionId ? await db.select().from(positionsTable).where(eq(positionsTable.id, worker.positionId)) : [undefined];

  // Ставка для {%Wynagrodzenie%} — ОКРЕМА від payroll-ставок (не hourlyRate/
  // rateBrutto): пер-генераційний override (адмін вписав вручну для цієї
  // людини) → ставка фабрики "в умові" (factories.contract_rate_brutto,
  // Налаштування → Фабрики) → останній рубіж — законодавча мінімальна ставка
  // zlecenia (Налаштування → Фінанси/ставки → «Сводні: мінімальна ставка
  // року», той самий KSIEG_STD_BRUTTO) — Wynagrodzenie ніколи не лишається пустим.
  const rate = rateOverride ?? factory?.contractRateBrutto ?? KSIEG_STD_BRUTTO();

  const companyId = await resolveContractCompanyId(workerId, factoryId, companyIdOverride);
  const [company] = companyId ? await db.select().from(companiesTable).where(eq(companiesTable.id, companyId)) : [undefined];

  const todayIso = new Date().toISOString().slice(0, 10);
  // Фолбек-евристика — лише для старих профілів без структурованих полів
  // (заповнених до worker-docs-signing "окремі поля з паспорта"); нові/оновлені
  // через скан-паспорта чи анкету йдуть напряму з worker.firstName/lastName.
  const [imieGuess, ...resztaGuess] = worker.fullName.trim().split(/\s+/);
  const nazwiskoGuess = resztaGuess.join(" ");

  const data: Record<string, string> = {
    "Imię": worker.firstName ?? imieGuess ?? "",
    "Drugie imię": worker.middleName ?? "",
    "Nazwisko": worker.lastName ?? nazwiskoGuess,
    "Data urodzenia": worker.birthDate ?? "",
    "PESEL pracownika": worker.pesel ?? "",
    "PESEL lub paszport": worker.pesel || questionnaire?.passportNumber || "",
    "Paszport": questionnaire?.passportNumber ?? "",
    "Paszport data wydania": questionnaire?.passportIssuedAt ?? "",
    "Paszport data ważności": questionnaire?.passportExpiresAt ?? "",
    "Seria i numer dowodu": questionnaire?.seriaINumerDowodu ?? "",
    "Miejsce urodzenia": questionnaire?.birthPlace ?? "",
    "Obywatelstwo": questionnaire?.citizenship ?? "",
    "Narodowość": worker.nationality ?? "",
    "Imię ojca": questionnaire?.fatherName ?? "",
    "Imię matki": questionnaire?.motherName ?? "",
    "Email pracownika": questionnaire?.email ?? "",
    "Telefon pracownika": questionnaire?.phone ?? "",
    "Pełny adres pracownika": questionnaire?.addressRegistered ?? "",
    "Pełny adres zamieszkania pracownika": questionnaire?.addressPl || questionnaire?.addressRegistered || "",
    "Bank pracownika": questionnaire?.bankName ?? "",
    "Rachunek pracownika": questionnaire?.bankIban ?? "",
    "Urząd Skarbowy pracownika": questionnaire?.taxOffice ?? "",
    "Urząd Skarbowy pracownika adres": questionnaire?.taxOfficeAddress ?? "",
    "Oddział NFZ": questionnaire?.nfzBranch ?? "",
    "Uczelnia": questionnaire?.schoolName ?? "",
    "Ankieta student": questionnaire?.isStudent ? "Tak" : "Nie",
    "NIP pracownika": questionnaire?.nip ?? "",
    "Ankieta 0 PIT": questionnaire?.pit0 ? "Tak" : "Nie",
    "Ankieta inny pracodawca": questionnaire?.ankietaInnyPracodawca ? "Tak" : "Nie",
    "Ankieta emeryt": questionnaire?.ankietaEmeryt ? "Tak" : "Nie",
    "Ankieta rencista": questionnaire?.ankietaRencista ? "Tak" : "Nie",
    "Ankieta niepełnosprawność": questionnaire?.ankietaNiepelnosprawnosc ? "Tak" : "Nie",
    "Ankieta składka chorobowa przy umowie zlecenie": questionnaire?.ankietaSkladkaChorobowa ? "Tak" : "Nie",
    "Województwo pracownika": questionnaire?.regWojewodztwo ?? "",
    "Powiat pracownika": questionnaire?.regPowiat ?? "",
    "Gmina pracownika": questionnaire?.regGmina ?? "",
    "Miejscowość pracownika": questionnaire?.regMiejscowosc ?? "",
    "Ulica pracownika": questionnaire?.regUlica ?? "",
    "Numer domu pracownika": questionnaire?.regNumerDomu ?? "",
    "Kod pocztowy pracownika": questionnaire?.regKodPocztowy ?? "",
    "Zamieszkania województwo pracownika": questionnaire?.zamWojewodztwo ?? "",
    "Zamieszkania powiat pracownika": questionnaire?.zamPowiat ?? "",
    "Zamieszkania gmina pracownika": questionnaire?.zamGmina ?? "",
    "Zamieszkania miejscowość pracownika": questionnaire?.zamMiejscowosc ?? "",
    "Zamieszkania ulica pracownika": questionnaire?.zamUlica ?? "",
    "Zamieszkania numer domu pracownika": questionnaire?.zamNumerDomu ?? "",
    "Zamieszkania kod pocztowy pracownika": questionnaire?.zamKodPocztowy ?? "",
    "Stanowisko": position?.name ?? "",
    "Czynności": (await resolveContractDuties(worker.positionId, factoryId)).text,
    "Wynagrodzenie": `${String(rate).replace(".", ",")} zł`,
    "Wynagrodzenie kwota i typ": `${String(rate).replace(".", ",")} zł brutto za godzinę`,
    "Nazwa Klienta": factory?.name ?? "",
    "Miejsce wykonywania pracy z projektu": factory?.name ?? "",
    "Miejsce lub miejsca wykonywania pracy": factory?.name ?? "",
    "Nazwa firmy": company?.legalName ?? company?.name ?? "",
    "NIP firmy": company?.nip ?? "",
    "KRS firmy": company?.krs ?? "",
    "REGON firmy": company?.regon ?? "",
    "Ulica firmy": company?.street ?? "",
    "Numer domu firmy": company?.houseNumber ?? "",
    "Kod pocztowy firmy": company?.postalCode ?? "",
    "Miejscowość firmy": company?.city ?? "",
    "Reprezentant firmy": company?.representative ?? "",
    "PKD firmy": company?.pkd ?? "", // świadectwo pracy: «Nr REGON-PKD»
    "Data dzisiejsza": todayIso,
    "Data zawarcia umowy": todayIso,
    "Data rozpoczęcia pracy": dates.dateFrom ?? "",
    "Data zakończenia pracy": dates.dateTo ?? "",
    "Podpis odręczny pracownika": "", "Podpis odręczny pracownik": "", "Podpis odręczny pracodawcy": "",
  };
  return data;
}

export function missingFields(data: Record<string, string>, keys: string[]): string[] {
  return keys.filter(k => data[k] === undefined);
}

// ── Резолюція комплекту документів (§2.2 плану: factory > company > all) ─────
export async function resolveDocumentSet(workerId: number, factoryId: number | null, companyIdOverride?: number | null): Promise<DocumentTemplate[]> {
  const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, workerId));
  if (!worker) throw new Error("Працівника не знайдено");
  const [questionnaire] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, workerId));
  const companyId = await resolveContractCompanyId(workerId, factoryId, companyIdOverride); // company-scope шаблони — за фірмою умови

  const all = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.isActive, true));
  const specificity = (t: DocumentTemplate): number => {
    if (t.scope === "factory" && factoryId != null && (t.scopeFactoryIds as number[]).includes(factoryId)) return 3;
    if (t.scope === "company" && companyId != null && (t.scopeCompanyIds as number[]).includes(companyId)) return 2;
    if (t.scope === "all") return 1;
    return 0;
  };

  const factoryKinds = new Set(["umowa", "regulamin", "andros_extra", "sprzatanie_umowa"]);
  // "Одиничні" типи — рівно один переможець на kind (найспецифічніший scope).
  // "Множинні" типи (andros_extra, custom) — це НЕ один документ, а ціла родина
  // окремих інструктажів/декларацій, що йдуть РАЗОМ, коли підходять — інакше
  // 13 різних додатків Andros звелися б до одного випадкового переможця.
  const SINGULAR_KINDS = new Set([
    "umowa", "regulamin", "zus", "tax", "ppk", "bhp",
    "wniosek_konto", "wniosek_reka", "wniosek_zaliczki", "sprzatanie_umowa",
  ]);
  const payoutKind = questionnaire?.payoutMethod === "reka" ? "wniosek_reka" : "wniosek_konto";

  const byKind = new Map<string, DocumentTemplate>();
  const multi: DocumentTemplate[] = [];
  for (const t of all) {
    const isFactoryLevel = factoryKinds.has(t.kind);
    if (isFactoryLevel !== (factoryId != null)) continue; // факторі-типи лише для факторі-пакету, і навпаки
    if (t.kind === "andros_extra" && t.positionId != null && t.positionId !== worker.positionId) continue;
    if (t.kind === "wniosek_konto" && payoutKind !== "wniosek_konto") continue;
    if (t.kind === "wniosek_reka" && payoutKind !== "wniosek_reka") continue;
    // Wniosek o niepobieranie zaliczek — рішення власника 02.09.2026: стандартно
    // йде всім (як zus/tax/ppk/bhp), не лише коли анкета позначена waivesTaxAdvance;
    // адмін і так може зняти галочку вручну в чеклісті перед генерацією.
    const score = specificity(t);
    if (score === 0) continue;
    if (!SINGULAR_KINDS.has(t.kind)) { multi.push(t); continue; }
    const cur = byKind.get(t.kind);
    if (!cur || specificity(cur) < score) byKind.set(t.kind, t);
  }
  return [...byKind.values(), ...multi];
}

// ── Рендер: HTML → PDF через headless Chrome ─────────────────────────────────
let browserPromise: Promise<Browser> | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  }
  return browserPromise;
}

// Закриває довгоживучий Chromium-інстанс (§4 плану) — без цього child-процес
// тримає event loop відкритим (node --test ніколи не завершує процес файлу,
// хоч усі тести й пройшли). Викликати в after() тестів, що генерують
// документи; у прод-процесі браузер живе, поки не завершиться сам сервер.
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}

// ── Прев'ю шаблону: структурний рендер (§ редактор бібліотеки) ──────────────
// Адмін бачить ФІНАЛЬНИЙ вигляд документа (реальний Puppeteer-рендер), але
// БЕЗ вигаданих демо-значень — на місці кожного {%Плейсхолдера%} підсвічена
// сама назва змінної (як вона записана в html). Мета прев'ю тут — верстка й
// розташування, не правдоподібний, але фейковий текст, який можна сплутати
// зі справжніми даними.
function placeholderNamePreview(html: string): string {
  return html.replace(PLACEHOLDER_RE, (_m, raw: string) => {
    const { key } = parsePlaceholder(raw);
    return `<span style="background:#fef08a;color:#78350f;padding:0 3px;border-radius:2px;font-size:0.9em">${escapeHtml(key)}</span>`;
  });
}

export async function renderTemplatePreview(html: string): Promise<Buffer> {
  return renderHtmlToPdf(placeholderNamePreview(html));
}

// ── Шрифт документа — вшитий, не системний ────────────────────────────────────
// Шаблони (архів HrAppka) верстані під 'Times New Roman'. На проді (Ubuntu) цього
// шрифту нема — Chrome підставив би DejaVu/Nimbus, і документ виглядав би
// інакше, ніж локально на Mac (інші метрики → інша розбивка на сторінки, інший
// sha256). Тому Liberation Serif (метричний двійник Times New Roman, SIL OFL,
// assets/fonts) вшивається @font-face ПІД ІМЕНЕМ «Times New Roman»: @font-face
// має пріоритет над локально встановленим шрифтом, тож рендер детермінований
// на будь-якій машині. Base64 CSS будується один раз на процес.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIRS = [path.resolve(HERE, "../../assets/fonts"), path.resolve(HERE, "../assets/fonts")];
const DOC_FONT_FACES: Array<[file: string, weight: string, style: string]> = [
  ["LiberationSerif-Regular.ttf", "normal", "normal"],
  ["LiberationSerif-Bold.ttf", "bold", "normal"],
  ["LiberationSerif-Italic.ttf", "normal", "italic"],
  ["LiberationSerif-BoldItalic.ttf", "bold", "italic"],
];
let docFontCss: string | null = null;
function documentFontCss(): string {
  if (docFontCss != null) return docFontCss;
  const rules: string[] = [];
  for (const [file, weight, style] of DOC_FONT_FACES) {
    const dir = FONT_DIRS.find(d => fs.existsSync(path.join(d, file)));
    if (!dir) { logger.warn({ file, dirs: FONT_DIRS }, "document font missing — falling back to system fonts"); continue; }
    const b64 = fs.readFileSync(path.join(dir, file)).toString("base64");
    for (const family of ["Times New Roman", "Times", "Liberation Serif"]) {
      rules.push(`@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};src:url(data:font/ttf;base64,${b64}) format("truetype")}`);
    }
  }
  docFontCss = rules.join("\n");
  return docFontCss;
}

async function renderHtmlToPdf(innerHtml: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const doc = `<!DOCTYPE html><html><head><meta charset="utf-8" /><style>${documentFontCss()}\nbody{font-family:"Times New Roman",serif}</style></head><body style="margin:0">${innerHtml}</body></html>`;
    await page.setContent(doc, { waitUntil: "load" });
    const bytes = await page.pdf({ format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" } });
    return Buffer.from(bytes);
  } finally {
    await page.close();
  }
}

async function writeContractFile(contractId: number, tpl: DocumentTemplate, sortOrder: number, bytes: Buffer): Promise<void> {
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const storedName = makeStoredName(`${tpl.kind}-${tpl.id}.pdf`);
  await fs.promises.writeFile(path.join(CONTRACTS_DIR, storedName), bytes);
  const pageCount = (await PDFDocument.load(bytes)).getPageCount();
  await db.insert(contractFilesTable).values({
    contractId, templateId: tpl.id, sortOrder, title: tpl.title,
    unsignedPath: path.join("contracts", storedName), unsignedSha256: sha256, pageCount,
  });
}

// ── Генерація пакета ──────────────────────────────────────────────────────────
export async function generateContract(opts: {
  workerId: number; factoryId: number | null; templateIds?: number[];
  dateFrom?: string | null; dateTo?: string | null; supersedesId?: number | null;
  /** Ставка "в умові" для цієї конкретної людини — перекриває factories.contract_rate_brutto */
  contractRateBrutto?: number | null;
  /** Наша фірма в умові (мультифірмова фабрика — вибір адміна); null = за фабрикою/профілем */
  companyId?: number | null;
  /** Документи офісу без підпису працівника (świadectwo pracy при звільненні): анкета може бути непідтверджена/відсутня */
  allowUnverified?: boolean;
}): Promise<Contract> {
  const [questionnaire] = await db.select().from(workerQuestionnairesTable).where(eq(workerQuestionnairesTable.workerId, opts.workerId));
  if (!opts.allowUnverified && (!questionnaire || questionnaire.status !== "verified")) {
    throw new Error("Анкета працівника ще не підтверджена (verified) — генерація документів заблокована");
  }
  const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, opts.workerId));
  if (!worker) throw new Error("Працівника не знайдено");

  const templates = opts.templateIds?.length
    ? await db.select().from(documentTemplatesTable).where(inArray(documentTemplatesTable.id, opts.templateIds))
    : await resolveDocumentSet(opts.workerId, opts.factoryId, opts.companyId ?? null);
  if (!templates.length) throw new Error("Не знайдено жодного шаблону для цього комплекту — прив'яжіть шаблони у бібліотеці");

  const companyId = await resolveContractCompanyId(opts.workerId, opts.factoryId, opts.companyId ?? null);
  const data = await buildContractData(opts.workerId, opts.factoryId, { dateFrom: opts.dateFrom ?? null, dateTo: opts.dateTo ?? null }, opts.contractRateBrutto ?? null, companyId);
  const lang = asLang(worker.language);

  const missing = new Set<string>();
  for (const tpl of templates) {
    const body = (tpl.body as Record<string, string>)[lang] || (tpl.body as Record<string, string>).pl || "";
    for (const f of missingFields(data, extractPlaceholderKeys(body))) missing.add(f);
  }
  if (missing.size) throw new Error(`Бракує даних для генерації: ${[...missing].join(", ")}`);

  const [contract] = await db.insert(contractsTable).values({
    workerId: opts.workerId, factoryId: opts.factoryId, companyId,
    payoutMethod: opts.factoryId == null ? questionnaire?.payoutMethod ?? null : null,
    status: "draft", dateFrom: opts.dateFrom ?? null, dateTo: opts.dateTo ?? null,
    supersedesId: opts.supersedesId ?? null, data, generatedAt: new Date(),
    contractRateBrutto: opts.contractRateBrutto ?? null,
  }).returning();

  let i = 0;
  for (const tpl of templates) {
    const body = (tpl.body as Record<string, string>)[lang] || (tpl.body as Record<string, string>).pl || "";
    const html = substitutePlaceholders(body, data);
    const pdf = await renderHtmlToPdf(html);
    await writeContractFile(contract!.id, tpl, i++, pdf);
  }
  logger.info({ contractId: contract!.id, workerId: opts.workerId, factoryId: opts.factoryId, files: templates.length }, "document package generated");
  return contract!;
}

// ── Дати заднім числом ────────────────────────────────────────────────────────
// Умову легально генерують і підписують без дат (дозвіл на роботу оформлюють уже з
// підписаною умовою). Дописані дати мають потрапити В ДОКУМЕНТ (рішення 08.09.2026):
//   • до підпису працівника (draft/pending_approval/approved/sent/viewed) — перерендер
//     unsigned-файлів;
//   • підписав працівник, фірма ще ні (worker_signed) — перерендер signed-файлів з
//     новими датами і збереженим PNG підпису працівника (як applyWorkerSignature),
//     подія signature_events `dates_filled` зі старим/новим sha256;
//   • підписано обома (signed) — лише запис у БД, файл не чіпається (печатка + аудит).
// dateFrom може бути null (лише «до», напр. закриття умови датою звільнення) — тоді «від» не чіпається.
export async function updateContractDates(contractId: number, dateFrom: string | null, dateTo?: string | null): Promise<Contract> {
  const [contract] = await db.select().from(contractsTable).where(eq(contractsTable.id, contractId));
  if (!contract) throw new Error("Пакет не знайдено");
  const DEAD = new Set(["declined", "cancelled", "superseded", "expired"]);
  if (DEAD.has(contract.status)) throw new Error(`Пакет у термінальному статусі (${contract.status}) — дату вже не дописати`);
  const from = dateFrom ?? (contract.dateFrom ? String(contract.dateFrom) : null);

  if (contract.status === "signed") {
    const [updated] = await db.update(contractsTable).set({
      dateFrom: from, dateTo: dateTo ?? null,
      data: { ...(contract.data as Record<string, string>), "Data rozpoczęcia pracy": from ?? "", "Data zakończenia pracy": dateTo ?? "" },
      updatedAt: new Date(),
    }).where(eq(contractsTable.id, contractId)).returning();
    logger.info({ contractId, dateFrom, dateTo, status: contract.status }, "contract dates recorded (signed by both — files untouched)");
    return updated!;
  }

  const files = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, contractId));
  const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, contract.workerId));
  const lang = asLang(worker?.language);
  // draft — повний перерахунок даних (профіль міг змінитись); після відправки/підпису —
  // ТІ САМІ дані, що бачив працівник (дата укладення, ставка, адреса), міняються лише дати
  const data = contract.status === "draft"
    ? await buildContractData(contract.workerId, contract.factoryId, { dateFrom: from, dateTo }, contract.contractRateBrutto, contract.companyId ?? null)
    : { ...(contract.data as Record<string, string>), "Data rozpoczęcia pracy": from ?? "", "Data zakończenia pracy": dateTo ?? "" };
  const workerSigned = contract.status === "worker_signed" && !!contract.workerSignaturePath;
  const workerSignatureDataUrl = workerSigned
    ? `data:image/png;base64,${(await fs.promises.readFile(path.join(UPLOADS_ROOT, contract.workerSignaturePath!))).toString("base64")}` : undefined;

  for (const file of files) {
    if (!file.templateId || !file.unsignedPath) continue;
    const [tpl] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, file.templateId));
    if (!tpl) continue;
    const body = (tpl.body as Record<string, string>)[lang] || (tpl.body as Record<string, string>).pl || "";
    const missing = missingFields(data, extractPlaceholderKeys(body));
    if (missing.length) throw new Error(`Бракує даних для генерації: ${missing.join(", ")}`);
    // unsigned — завжди (прев'ю без підпису)
    const pdf = await renderHtmlToPdf(substitutePlaceholders(body, data));
    const sha256 = crypto.createHash("sha256").update(pdf).digest("hex");
    await fs.promises.writeFile(path.join(UPLOADS_ROOT, file.unsignedPath), pdf);
    const pageCount = (await PDFDocument.load(pdf)).getPageCount();
    const patch: Partial<typeof contractFilesTable.$inferInsert> = { unsignedSha256: sha256, pageCount };
    // підписав працівник — перерендер signed-файла з тим самим PNG підпису
    if (workerSigned) {
      const signedPdf = await renderHtmlToPdf(substitutePlaceholders(body, data, { workerSignatureDataUrl }));
      const signedSha = crypto.createHash("sha256").update(signedPdf).digest("hex");
      const storedName = makeStoredName(`signed-${file.id}.pdf`);
      await fs.promises.writeFile(path.join(CONTRACTS_DIR, storedName), signedPdf);
      patch.signedPath = path.join("contracts", storedName); patch.signedSha256 = signedSha;
      await db.insert(signatureEventsTable).values({
        contractId, event: "dates_filled", docSha256: signedSha,
        extra: { fileId: file.id, previousSha256: file.signedSha256, dateFrom: from, dateTo: dateTo ?? null },
      }).catch(err => logger.warn({ err: String(err), contractId }, "dates_filled event failed"));
    }
    await db.update(contractFilesTable).set(patch).where(eq(contractFilesTable.id, file.id));
  }

  const [updated] = await db.update(contractsTable).set({ dateFrom: from, dateTo: dateTo ?? null, data, updatedAt: new Date() })
    .where(eq(contractsTable.id, contractId)).returning();
  logger.info({ contractId, dateFrom, dateTo, status: contract.status, workerSigned }, "contract dates updated, files regenerated");
  return updated!;
}

// ── Підпис працівника ─────────────────────────────────────────────────────────
// Зберігає PNG на диск (доказова база), перерендерює кожен файл пакета з
// підставленим підписом у місце {%Podpis odręczny pracownik(a)%}. Статус →
// worker_signed (НЕ signed — компанія підписує у відповідь, finalizeContractSignature).
export async function applyWorkerSignature(contractId: number, signaturePngBase64: string): Promise<{ signedFiles: number }> {
  const [contract] = await db.select().from(contractsTable).where(eq(contractsTable.id, contractId));
  if (!contract) throw new Error("Пакет не знайдено");

  const b64 = signaturePngBase64.replace(/^data:image\/png;base64,/, "");
  const sigBytes = Buffer.from(b64, "base64");
  if (sigBytes.length < 8 || sigBytes.toString("latin1", 0, 8) !== "\x89PNG\r\n\x1a\n") {
    throw new Error("Підпис має бути PNG-зображенням");
  }
  const sigStoredName = makeStoredName(`sig-${contractId}.png`);
  const sigPath = path.join("signatures", sigStoredName);
  await fs.promises.writeFile(path.join(SIGNATURES_DIR, sigStoredName), sigBytes);
  const workerSignatureDataUrl = `data:image/png;base64,${sigBytes.toString("base64")}`;

  const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, contract.workerId));
  const lang = asLang(worker?.language);
  const data = contract.data as Record<string, string>;
  const files = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, contractId));

  let signedCount = 0;
  for (const file of files) {
    if (!file.templateId) continue;
    const [tpl] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, file.templateId));
    if (!tpl) continue;
    const body = (tpl.body as Record<string, string>)[lang] || (tpl.body as Record<string, string>).pl || "";
    const hasWorkerSpot = WORKER_SIG_RE.test(body);
    const pdf = await renderHtmlToPdf(substitutePlaceholders(body, data, { workerSignatureDataUrl }));
    const sha256 = crypto.createHash("sha256").update(pdf).digest("hex");
    const storedName = makeStoredName(`signed-${file.id}.pdf`);
    await fs.promises.writeFile(path.join(CONTRACTS_DIR, storedName), pdf);
    await db.update(contractFilesTable).set({ signedPath: path.join("contracts", storedName), signedSha256: sha256 }).where(eq(contractFilesTable.id, file.id));
    if (hasWorkerSpot) signedCount++;
  }

  await db.update(contractsTable).set({
    status: "worker_signed", signedAt: new Date(), workerSignaturePath: sigPath, updatedAt: new Date(),
  }).where(eq(contractsTable.id, contractId));
  logger.info({ contractId, signedFiles: signedCount }, "worker signature applied (awaiting company countersignature)");
  return { signedFiles: signedCount };
}

// ── Фінальний підпис компанії ─────────────────────────────────────────────────
// Лише зі статусу worker_signed. Перерендерює кожен файл ЩЕ РАЗ — тепер з
// ОБОМА підписами (worker з collectedWorkerSignaturePath + печатка компанії з
// COMPANY_STAMP_PNG, best-effort якщо не налаштована — не блокує статус),
// переводить у термінальний signed, супersede-ить попередню версію в
// межах (workerId, factoryId)-ланцюга.
export async function finalizeContractSignature(contractId: number, adminId: number | null): Promise<{ stamped: boolean; reason?: string }> {
  const [contract] = await db.select().from(contractsTable).where(eq(contractsTable.id, contractId));
  if (!contract) throw new Error("Пакет не знайдено");
  if (contract.status !== "worker_signed") {
    throw new Error(`Підписати від компанії можна лише після підпису працівника (поточний статус: ${contract.status})`);
  }

  const stampPath = process.env.COMPANY_STAMP_PNG;
  const stampOk = !!stampPath && fs.existsSync(stampPath);
  const companyStampDataUrl = stampOk ? `data:image/png;base64,${(await fs.promises.readFile(stampPath!)).toString("base64")}` : undefined;
  const workerSignatureDataUrl = contract.workerSignaturePath
    ? `data:image/png;base64,${(await fs.promises.readFile(path.join(UPLOADS_ROOT, contract.workerSignaturePath))).toString("base64")}` : undefined;

  const [worker] = await db.select().from(workersTable).where(eq(workersTable.id, contract.workerId));
  const lang = asLang(worker?.language);
  const data = contract.data as Record<string, string>;
  const files = await db.select().from(contractFilesTable).where(eq(contractFilesTable.contractId, contractId));

  let stamped = 0;
  for (const file of files) {
    if (!file.templateId) continue;
    const [tpl] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, file.templateId));
    if (!tpl) continue;
    const body = (tpl.body as Record<string, string>)[lang] || (tpl.body as Record<string, string>).pl || "";
    const pdf = await renderHtmlToPdf(substitutePlaceholders(body, data, { workerSignatureDataUrl, companyStampDataUrl }));
    const sha256 = crypto.createHash("sha256").update(pdf).digest("hex");
    const storedName = makeStoredName(`signed-${file.id}.pdf`);
    await fs.promises.writeFile(path.join(CONTRACTS_DIR, storedName), pdf);
    await db.update(contractFilesTable).set({ signedPath: path.join("contracts", storedName), signedSha256: sha256 }).where(eq(contractFilesTable.id, file.id));
    if (COMPANY_SIG_RE.test(body)) stamped++;
  }

  await db.update(contractsTable).set({
    status: "signed", companySignedBy: adminId, companySignedAt: new Date(), updatedAt: new Date(),
  }).where(eq(contractsTable.id, contractId));
  if (contract.supersedesId) {
    await db.update(contractsTable).set({ status: "superseded", supersededAt: new Date(), updatedAt: new Date() }).where(eq(contractsTable.id, contract.supersedesId));
  }
  logger.info({ contractId, stamped: stamped > 0 }, "contract finalized — company countersigned");
  return stampOk ? { stamped: stamped > 0 } : { stamped: false, reason: "COMPANY_STAMP_PNG не налаштований на цьому сервері" };
}
