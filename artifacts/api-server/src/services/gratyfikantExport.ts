// Експорт сводної в Gratyfikant nexo PRO (InsERT, kadry i płace).
// Формуємо файл під вбудований імпорт «Naliczenia i potrącenia»
// (Ewidencje dodatkowe → Laboratorium → «Eksport/import danych»); структура
// дзеркалить власний експорт nexo: аркуш «Arkusz1», колонки
// Pracownik | Data | Rodzaj | Składnik płacowy | Wartość.
//
// Рішення 14.08.2026: в Gratyfikant їде ЛИШЕ księg. brutto — один запис-
// naliczenie «Rachunki - kwota rachunku» на рядок сводної. Людина на кількох
// фабриках дістає окремі записи (księgowa виставляє окремі rachunki під
// лісту кожної фабрики). Години/ставки/потронення не возимо: komornik
// nexo рахує сам, решта знімається поза офіційним контуром.
//
// Імена — rawName як є (mixed case «Nazwisko Imię», формат збігається з
// nexo). Свідомо БЕЗ nameCaps: файл машинний, точний збіг рядка імені
// критичний для матчингу працівника в майстрі імпорту.
import { OFFICE_TAB_RE, EXTRA_STUDENTS_LABEL } from "./svodniSync";

export const GRATYFIKANT_SKLADNIK = "Rachunki - kwota rachunku";

export type GratyfikantSource = {
  rawName: string;
  factoryLabel: string;
  firm: string | null;
  ksiegBrutto: number | null;
  segmentOf: number | null;
};

export type GratyfikantRecord = {
  pracownik: string;
  data: string; // YYYY-MM-DD — день формування файлу (виплата 25-го — поза файлом)
  rodzaj: "naliczenie";
  skladnik: string;
  wartosc: number;
};

const normLabel = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

// Рядки сводної місяця → записи naliczeń для однієї фірми (підмiota nexo).
// Батьківські рядки (segment_of NULL) з ksiegBrutto > 0; офісні вкладки і
// «Додаткові студенти» не входять — у Gratyfikancie вони йдуть не через
// фабричні лісти rachunków (окрема розмова, якщо знадобиться).
export function gratyfikantRecords(
  rows: GratyfikantSource[],
  opts: { firm: string; date: string; factoryLabel?: string | null },
): GratyfikantRecord[] {
  const collator = new Intl.Collator("pl");
  const wantFactory = opts.factoryLabel ? normLabel(opts.factoryLabel) : null;
  return rows
    .filter(r => r.segmentOf == null)
    .filter(r => !OFFICE_TAB_RE.test(r.factoryLabel) && r.factoryLabel !== EXTRA_STUDENTS_LABEL)
    .filter(r => (r.firm ?? "") === opts.firm)
    .filter(r => !wantFactory || normLabel(r.factoryLabel) === wantFactory)
    .filter(r => (r.ksiegBrutto ?? 0) > 0)
    .sort((a, b) => collator.compare(a.factoryLabel, b.factoryLabel)
      || collator.compare(a.rawName, b.rawName))
    .map(r => ({
      pracownik: r.rawName.trim().replace(/\s+/g, " "),
      data: opts.date,
      rodzaj: "naliczenie" as const,
      skladnik: GRATYFIKANT_SKLADNIK,
      wartosc: Math.round(r.ksiegBrutto! * 100) / 100,
    }));
}
