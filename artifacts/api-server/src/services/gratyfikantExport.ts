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
