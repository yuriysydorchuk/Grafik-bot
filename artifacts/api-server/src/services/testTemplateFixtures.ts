// ТЕСТОВІ шаблони бібліотеки документів (worker-docs-signing, план §12 Етап 3).
// Не юридичний текст — плейсхолдерний каркас польською (HTML {%Плейсхолдер%},
// формат реальних шаблонів з архіву HrAppka, план Додаток A), щоб перевірити
// рушій генерації (services/contracts.ts, Puppeteer HTML→PDF) без чекання на
// реальний імпорт бібліотеки. scope="all" — підходить будь-якому працівнику/
// фабриці в тестах.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { PDFDocument, rgb, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { UPLOADS_ROOT } from "../lib/uploads";
import { db, documentTemplatesTable } from "@workspace/db";

const SIG_BOX = (label: string) =>
  `<div style="width:220px;height:46px;border:1px dashed #999;display:flex;align-items:center;justify-content:center;margin:6px 0">{%${label}%}</div>`;

// factory-level: умова + regulamin (kind ∈ umowa|regulamin|andros_extra)
const UMOWA_HTML = `<div style="font-family:'Times New Roman',serif;font-size:11pt">
<p style="color:#c00;font-size:8pt">WZÓR TESTOWY — nie używać jako dokumentu wiążącego</p>
<h1>UMOWA ZLECENIA</h1>
<p>Zawarta {%Data zawarcia umowy%} w {%Nazwa firmy%} pomiędzy Zleceniodawcą a {%Imię%} {%Nazwisko%}, PESEL {%PESEL pracownika%}, zam. {%Pełny adres zamieszkania pracownika%}.</p>
<p>Miejsce wykonywania: {%Nazwa Klienta%}. Okres: {%Data rozpoczęcia pracy%} — {%Data zakończenia pracy%}.</p>
${SIG_BOX("Podpis odręczny pracodawcy")}${SIG_BOX("Podpis odręczny pracownika")}
</div>`;

const REGULAMIN_HTML = `<div style="font-family:'Times New Roman',serif;font-size:11pt">
<p style="color:#c00;font-size:8pt">WZÓR TESTOWY</p>
<h1>REGULAMIN PRACY</h1>
<p>{%Imię%} {%Nazwisko%}, PESEL {%PESEL pracownika%} — potwierdzam zapoznanie się z regulaminem {%Nazwa firmy%}.</p>
${SIG_BOX("Podpis odręczny pracownika")}
</div>`;

// worker-level (сталий пакет): zus + ppk (kind ∈ zus|tax|ppk|bhp|wniosek_*)
const ZUS_HTML = `<div style="font-family:'Times New Roman',serif;font-size:11pt">
<p style="color:#c00;font-size:8pt">WZÓR TESTOWY</p>
<h1>OŚWIADCZENIE DLA CELÓW ZUS</h1>
<p>{%Imię%} {%Nazwisko%}, PESEL {%PESEL pracownika%}, ur. {%Data urodzenia%}. Status studenta: {%Ankieta student%}. Urząd skarbowy: {%Urząd Skarbowy pracownika%}. Oddział NFZ: {%Oddział NFZ%}.</p>
${SIG_BOX("Podpis odręczny pracownika")}
</div>`;

const PPK_HTML = `<div style="font-family:'Times New Roman',serif;font-size:11pt">
<p style="color:#c00;font-size:8pt">WZÓR TESTOWY</p>
<h1>REZYGNACJA Z PPK</h1>
<p>{%Imię%} {%Nazwisko%}, PESEL {%PESEL pracownika%} — rezygnuję z wpłat do PPK w {%Nazwa firmy%}.</p>
${SIG_BOX("Podpis odręczny pracownika")}
</div>`;

const TEST_TEMPLATES = [
  { kind: "umowa", title: "Umowa zlecenia (WZÓR TESTOWY)", html: UMOWA_HTML },
  { kind: "regulamin", title: "Regulamin (WZÓR TESTOWY)", html: REGULAMIN_HTML },
  { kind: "zus", title: "Oświadczenie ZUS (WZÓR TESTOWY)", html: ZUS_HTML },
  { kind: "ppk", title: "Rezygnacja z PPK (WZÓR TESTOWY)", html: PPK_HTML },
] as const;

// Сідить 4 тестові document_templates (scope="all", isBase=true) — достатньо,
// щоб resolveDocumentSet() підібрав і факторі-пакет (umowa+regulamin), і
// сталий (zus+ppk) для будь-якого працівника/фабрики в інтеграційних тестах.
export async function seedTestDocumentTemplates(): Promise<{ templateIds: Record<string, number> }> {
  const templateIds: Record<string, number> = {};
  for (const t of TEST_TEMPLATES) {
    const [row] = await db.insert(documentTemplatesTable).values({
      kind: t.kind, title: t.title, isBase: true, scope: "all",
      body: { pl: t.html, en: t.html, es: t.html, ru: t.html, uk: t.html },
    }).returning({ id: documentTemplatesTable.id });
    templateIds[t.kind] = row!.id;
  }
  return { templateIds };
}

// ── Тестова печатка фірми (applyCompanyStamp/finalizeContractSignature читає
// її зі шляху в env COMPANY_STAMP_PNG, §13 плану — реальний файл ще не надано
// власником). Незалежна від рушія генерації — лишається на pdf-lib+pdftoppm.
export async function generateTestCompanyStamp(outPath: string = path.join(UPLOADS_ROOT, "test-fixtures", "company-stamp.png")): Promise<string> {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const FONT_DIRS = [path.resolve(HERE, "../../assets/fonts"), path.resolve(HERE, "../assets/fonts")];
  const loadFont = (file: string): Buffer => {
    for (const d of FONT_DIRS) { const p = path.join(d, file); if (fs.existsSync(p)) return fs.readFileSync(p); }
    throw new Error(`font not found: ${file}`);
  };

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(loadFont("DejaVuSans.ttf"), { subset: true });
  const bold = await doc.embedFont(loadFont("DejaVuSans-Bold.ttf"), { subset: true });

  const W = 660, H = 138;
  const NAVY = rgb(0.09, 0.16, 0.35);
  const page = doc.addPage([W, H]);

  page.drawRectangle({ x: 6, y: 6, width: W - 12, height: H - 12, borderColor: NAVY, borderWidth: 2 });
  page.drawRectangle({ x: 11, y: 11, width: W - 22, height: H - 22, borderColor: NAVY, borderWidth: 0.8 });

  page.drawText("EURO SUPPORT", { x: 26, y: H - 42, size: 26, font: bold, color: NAVY });
  page.drawText("Sp. z o.o.", { x: 26, y: H - 68, size: 15, font, color: NAVY });
  page.drawText("NIP 9462698100 · Poznań", { x: 26, y: H - 90, size: 13, font, color: NAVY });

  const sx = 440, sy = 55;
  const pts = [[sx, sy], [sx + 35, sy + 35], [sx + 70, sy + 10], [sx + 105, sy + 40], [sx + 140, sy + 15]];
  for (let i = 0; i < pts.length - 1; i++) {
    page.drawLine({ start: { x: pts[i]![0]!, y: pts[i]![1]! }, end: { x: pts[i + 1]![0]!, y: pts[i + 1]![1]! }, thickness: 2.4, color: NAVY });
  }
  page.drawText("podpis", { x: sx + 20, y: 22, size: 11, font, color: rgb(0.55, 0.55, 0.55) });
  page.drawText("WZÓR TESTOWY — nie prawdziwa pieczęć", { x: 40, y: 18, size: 10.5, font, color: rgb(0.85, 0.12, 0.12), rotate: degrees(5) });

  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPdf = path.join(dir, "__stamp_tmp.pdf");
  fs.writeFileSync(tmpPdf, await doc.save());
  const outBase = outPath.replace(/\.png$/, "");
  try {
    execFileSync("pdftoppm", ["-png", "-r", "300", "-singlefile", tmpPdf, outBase]);
  } finally {
    fs.rmSync(tmpPdf, { force: true });
  }
  return outPath;
}
