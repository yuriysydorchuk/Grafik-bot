// Експорт ліст до Gratyfikant nexo (кнопка Gratyfikant на /svodni).
// Формат файлу — той, що відпрацьований на липні 2026 (боєм, з księgową):
// БЕЗ заголовка, 4 колонки: Імʼя (нексо-форма) | PESEL | Дата виплати | Сума.
// Сума = księg. brutto рядка сводної; у файл входять лише люди, «кому щось
// іде на конто» (konto > 0), батьківські рядки. Одна ліста = одна фірма
// (підмiot nexo); скоуп — вибрані фабрики / все місто / вся фірма.
// Імʼя: workers.gratyfikant_name (точне написання nexo) → повне імʼя профілю
// → rawName рядка. Свідомо БЕЗ nameCaps — файл машинний, і матчинг по PESEL
// (основний) або по імені має збігатися з nexo байт у байт.
import { OFFICE_TAB_RE, EXTRA_STUDENTS_LABEL } from "./svodniSync";

export type ListaSourceRow = {
  id: number;
  rawName: string;
  workerName?: string | null;
  gratyfikantName?: string | null;
  pesel?: string | null;
  factoryLabel: string;
  firm: string | null;
  ksiegBrutto: number | null;
  konto: number | null;
  segmentOf: number | null;
};

export type ListaRecord = { rowId: number; name: string; pesel: string; data: string; kwota: number };

const normLabel = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const exportNameOf = (r: Pick<ListaSourceRow, "gratyfikantName" | "workerName" | "rawName">): string =>
  (r.gratyfikantName ?? r.workerName ?? r.rawName).trim().replace(/\s+/g, " ");

// Ліста залічок (сторінка Аванси → Gratyfikant): аванси «передано до виплати»
// вибраної групи 15/30 → той самий 4-колонковий файл. Сума = сума авансу,
// фірма = фірма працівника (підмiot nexo), сортування фабрика → імʼя (pl).
export type ZaliczkaSourceRow = {
  id: number;
  workerName?: string | null;
  gratyfikantName?: string | null;
  pesel?: string | null;
  firm: string | null;
  factoryLabel: string | null;
  amount: number;
};

export function zaliczkaRecords(
  rows: ZaliczkaSourceRow[],
  opts: { firm: string; payDate: string },
): ListaRecord[] {
  const collator = new Intl.Collator("pl");
  const nameOf = (r: ZaliczkaSourceRow) =>
    (r.gratyfikantName ?? r.workerName ?? "").trim().replace(/\s+/g, " ");
  return rows
    .filter(r => (r.firm ?? "") === opts.firm)
    .sort((a, b) => collator.compare(a.factoryLabel ?? "", b.factoryLabel ?? "") || collator.compare(nameOf(a), nameOf(b)))
    .map(r => ({
      rowId: r.id,
      name: nameOf(r),
      pesel: r.pesel ?? "",
      data: opts.payDate,
      kwota: Math.round(r.amount * 100) / 100,
    }));
}

// Дефолтна дата лісти залічок = день групи виплати: «15» → 15-те місяця,
// «30» → 30-те (лютий — останній день місяця).
export function groupPayDate(month: string, group: "15" | "30"): string {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(y!, m!, 0).getDate();
  const day = Math.min(Number(group), lastDay);
  return `${month}-${String(day).padStart(2, "0")}`;
}

// Спільний генератор XLSX-лісти: БЕЗ заголовка, Arkusz1,
// колонки Імʼя | PESEL | Дата | Сума (формат, відпрацьований з księgową).
export async function listaXlsxBuffer(records: ListaRecord[]): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Arkusz1");
  for (const r of records) ws.addRow([r.name, r.pesel, r.data, r.kwota]);
  ws.getColumn(1).width = 32;
  ws.getColumn(2).width = 14;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Рядки сводної місяця → записи лісти однієї фірми.
// factoryLabels — обмеження по вкладках (нормалізовано); порожньо = всі.
export function listaRecords(
  rows: ListaSourceRow[],
  opts: { firm: string; payDate: string; factoryLabels?: string[] },
): ListaRecord[] {
  const collator = new Intl.Collator("pl");
  const want = (opts.factoryLabels ?? []).map(normLabel);
  return rows
    .filter(r => r.segmentOf == null)
    .filter(r => !OFFICE_TAB_RE.test(r.factoryLabel) && r.factoryLabel !== EXTRA_STUDENTS_LABEL)
    .filter(r => (r.firm ?? "") === opts.firm)
    .filter(r => !want.length || want.includes(normLabel(r.factoryLabel)))
    .filter(r => (r.konto ?? 0) > 0)
    .sort((a, b) => collator.compare(a.factoryLabel, b.factoryLabel) || collator.compare(exportNameOf(a), exportNameOf(b)))
    .map(r => ({
      rowId: r.id,
      name: exportNameOf(r),
      pesel: r.pesel ?? "",
      data: opts.payDate,
      kwota: Math.round((r.ksiegBrutto ?? 0) * 100) / 100,
    }));
}
