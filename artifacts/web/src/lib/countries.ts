// Коди країн з MRZ паспорта (ICAO 9303, 3 літери) → назва країни ПОЛЬСЬКОЮ
// (документи системи — польською) і каталог NATIONALITIES (routes/admin-api.ts,
// дзеркало web/src/lib/nationality.tsx). 11.10.2026: сирий код «UKR» зі скану
// йшов як є в анкету, бот-картку й плейсхолдер «Obywatelstwo» в умовах.
//
// OCR плутає цифри з літерами («P0L», «5RB», «8GR») — normalizeMrzCountry
// виправляє перед пошуком. Невідомий код → лишаємо як ввели (офіс поправить).

const MRZ_OCR_FIX: Record<string, string> = { "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z" };
export const normalizeMrzCountry = (code: string | null): string | null =>
  code ? code.toUpperCase().replace(/[01582]/g, ch => MRZ_OCR_FIX[ch] ?? ch).replace(/</g, "") : null;

type Region = "ukraine" | "belarus" | "poland" | "moldova" | "romania" | "georgia" | "azerbaijan" | "turkey"
  | "eu_other" | "africa" | "latin_america" | "central_asia" | "south_asia" | "other";

// [назва польською, значення каталогу NATIONALITIES]
export const COUNTRIES: Record<string, [string, Region]> = {
  UKR: ["Ukraina", "ukraine"], BLR: ["Białoruś", "belarus"], POL: ["Polska", "poland"], MDA: ["Mołdawia", "moldova"],
  ROU: ["Rumunia", "romania"], ROM: ["Rumunia", "romania"], GEO: ["Gruzja", "georgia"], AZE: ["Azerbejdżan", "azerbaijan"], TUR: ["Turcja", "turkey"],
  // Центральна Азія
  KAZ: ["Kazachstan", "central_asia"], UZB: ["Uzbekistan", "central_asia"], KGZ: ["Kirgistan", "central_asia"],
  TJK: ["Tadżykistan", "central_asia"], TKM: ["Turkmenistan", "central_asia"],
  // Південна Азія
  IND: ["Indie", "south_asia"], NPL: ["Nepal", "south_asia"], BGD: ["Bangladesz", "south_asia"], PAK: ["Pakistan", "south_asia"],
  LKA: ["Sri Lanka", "south_asia"], BTN: ["Bhutan", "south_asia"],
  // ЄС / ЄЕЗ / Швейцарія (poland, romania — окремо вище)
  D: ["Niemcy", "eu_other"], DEU: ["Niemcy", "eu_other"], LTU: ["Litwa", "eu_other"], LVA: ["Łotwa", "eu_other"], EST: ["Estonia", "eu_other"],
  CZE: ["Czechy", "eu_other"], SVK: ["Słowacja", "eu_other"], HUN: ["Węgry", "eu_other"], BGR: ["Bułgaria", "eu_other"], HRV: ["Chorwacja", "eu_other"],
  SVN: ["Słowenia", "eu_other"], ITA: ["Włochy", "eu_other"], ESP: ["Hiszpania", "eu_other"], PRT: ["Portugalia", "eu_other"], FRA: ["Francja", "eu_other"],
  NLD: ["Holandia", "eu_other"], BEL: ["Belgia", "eu_other"], LUX: ["Luksemburg", "eu_other"], AUT: ["Austria", "eu_other"], IRL: ["Irlandia", "eu_other"],
  GRC: ["Grecja", "eu_other"], CYP: ["Cypr", "eu_other"], MLT: ["Malta", "eu_other"], SWE: ["Szwecja", "eu_other"], FIN: ["Finlandia", "eu_other"],
  DNK: ["Dania", "eu_other"], NOR: ["Norwegia", "eu_other"], ISL: ["Islandia", "eu_other"], LIE: ["Liechtenstein", "eu_other"], CHE: ["Szwajcaria", "eu_other"],
  // Європа поза ЄС
  GBR: ["Wielka Brytania", "other"], GBD: ["Wielka Brytania", "other"], GBN: ["Wielka Brytania", "other"], GBO: ["Wielka Brytania", "other"], GBS: ["Wielka Brytania", "other"],
  SRB: ["Serbia", "other"], BIH: ["Bośnia i Hercegowina", "other"], MKD: ["Macedonia Północna", "other"], ALB: ["Albania", "other"],
  MNE: ["Czarnogóra", "other"], RKS: ["Kosowo", "other"], XKX: ["Kosowo", "other"], RUS: ["Rosja", "other"], ARM: ["Armenia", "other"],
  // Африка
  NGA: ["Nigeria", "africa"], GHA: ["Ghana", "africa"], KEN: ["Kenia", "africa"], ZWE: ["Zimbabwe", "africa"], ZAF: ["Republika Południowej Afryki", "africa"],
  CMR: ["Kamerun", "africa"], EGY: ["Egipt", "africa"], MAR: ["Maroko", "africa"], TUN: ["Tunezja", "africa"], DZA: ["Algieria", "africa"],
  ETH: ["Etiopia", "africa"], UGA: ["Uganda", "africa"], TZA: ["Tanzania", "africa"], SEN: ["Senegal", "africa"], CIV: ["Wybrzeże Kości Słoniowej", "africa"],
  COD: ["Demokratyczna Republika Konga", "africa"], COG: ["Kongo", "africa"], AGO: ["Angola", "africa"], MOZ: ["Mozambik", "africa"], ZMB: ["Zambia", "africa"],
  RWA: ["Rwanda", "africa"], BDI: ["Burundi", "africa"], SDN: ["Sudan", "africa"], GIN: ["Gwinea", "africa"], MLI: ["Mali", "africa"], GMB: ["Gambia", "africa"],
  MWI: ["Malawi", "africa"], SSD: ["Sudan Południowy", "africa"], SOM: ["Somalia", "africa"], ERI: ["Erytrea", "africa"], DJI: ["Dżibuti", "africa"],
  LBY: ["Libia", "africa"], NAM: ["Namibia", "africa"], BWA: ["Botswana", "africa"], LSO: ["Lesotho", "africa"], SWZ: ["Eswatini", "africa"],
  NER: ["Niger", "africa"], TCD: ["Czad", "africa"], BFA: ["Burkina Faso", "africa"], TGO: ["Togo", "africa"], BEN: ["Benin", "africa"],
  SLE: ["Sierra Leone", "africa"], LBR: ["Liberia", "africa"], MDG: ["Madagaskar", "africa"], MUS: ["Mauritius", "africa"], GAB: ["Gabon", "africa"],
  GNQ: ["Gwinea Równikowa", "africa"], CAF: ["Republika Środkowoafrykańska", "africa"], MRT: ["Mauretania", "africa"], CPV: ["Republika Zielonego Przylądka", "africa"],
  // Латинська Америка
  COL: ["Kolumbia", "latin_america"], VEN: ["Wenezuela", "latin_america"], PER: ["Peru", "latin_america"], ARG: ["Argentyna", "latin_america"],
  BRA: ["Brazylia", "latin_america"], MEX: ["Meksyk", "latin_america"], CUB: ["Kuba", "latin_america"], ECU: ["Ekwador", "latin_america"],
  BOL: ["Boliwia", "latin_america"], CHL: ["Chile", "latin_america"], PRY: ["Paragwaj", "latin_america"], URY: ["Urugwaj", "latin_america"],
  DOM: ["Dominikana", "latin_america"], GTM: ["Gwatemala", "latin_america"], HND: ["Honduras", "latin_america"], SLV: ["Salwador", "latin_america"],
  NIC: ["Nikaragua", "latin_america"], CRI: ["Kostaryka", "latin_america"], PAN: ["Panama", "latin_america"],
  HTI: ["Haiti", "latin_america"], JAM: ["Jamajka", "latin_america"], TTO: ["Trynidad i Tobago", "latin_america"], GUY: ["Gujana", "latin_america"], SUR: ["Surinam", "latin_america"],
  // Решта світу
  PHL: ["Filipiny", "other"], VNM: ["Wietnam", "other"], IDN: ["Indonezja", "other"], THA: ["Tajlandia", "other"], MMR: ["Mjanma", "other"],
  MYS: ["Malezja", "other"], CHN: ["Chiny", "other"], MNG: ["Mongolia", "other"], KOR: ["Korea Południowa", "other"], JPN: ["Japonia", "other"], IRN: ["Iran", "other"],
  IRQ: ["Irak", "other"], SYR: ["Syria", "other"], AFG: ["Afganistan", "other"], ISR: ["Izrael", "other"], JOR: ["Jordania", "other"],
  LBN: ["Liban", "other"], USA: ["Stany Zjednoczone", "other"], CAN: ["Kanada", "other"], AUS: ["Australia", "other"], NZL: ["Nowa Zelandia", "other"],
  KHM: ["Kambodża", "other"], LAO: ["Laos", "other"], SGP: ["Singapur", "other"], TWN: ["Tajwan", "other"], HKG: ["Hongkong", "other"],
  SAU: ["Arabia Saudyjska", "other"], ARE: ["Zjednoczone Emiraty Arabskie", "other"], KWT: ["Kuwejt", "other"], QAT: ["Katar", "other"],
  YEM: ["Jemen", "other"], PSE: ["Palestyna", "other"], AND: ["Andora", "eu_other"], MCO: ["Monako", "other"], SMR: ["San Marino", "other"], VAT: ["Watykan", "other"],
};

const NAME_TO_CODE = new Map<string, string>(Object.entries(COUNTRIES).map(([code, [name]]) => [name.toLowerCase(), code]));

/** Код з MRZ або вже назва → польська назва країни; невідоме — як ввели (trim) */
export function countryNamePl(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (/^[A-Za-z0-9<]{1,3}$/.test(s)) {
    const code = normalizeMrzCountry(s);
    const hit = code ? COUNTRIES[code] : undefined;
    if (hit) return hit[0];
  }
  return s;
}

/** Код з MRZ або польська назва → значення каталогу NATIONALITIES; невідоме → null */
export function countryToCatalog(raw: string | null | undefined): Region | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const code = /^[A-Za-z0-9<]{1,3}$/.test(s) ? normalizeMrzCountry(s) : (NAME_TO_CODE.get(s.toLowerCase()) ?? null);
  return code && COUNTRIES[code] ? COUNTRIES[code][1] : null;
}

/** Унікальні польські назви, відсортовані по-польськи — для випадаючого списку в анкеті */
export const COUNTRY_NAMES: readonly string[] = [...new Set(Object.values(COUNTRIES).map(([name]) => name))].sort((a, b) => a.localeCompare(b, "pl"));
/** Найчастіші в агенції — згори списку */
export const COUNTRY_NAMES_TOP: readonly string[] = ["Ukraina", "Białoruś", "Mołdawia", "Gruzja", "Polska", "Kazachstan", "Uzbekistan", "Indie", "Nepal", "Kolumbia"];
const KNOWN = new Map(COUNTRY_NAMES.map(n => [n.toLowerCase(), n]));
export const isKnownCountry = (name: string): boolean => KNOWN.has(name.trim().toLowerCase());
/** Код MRZ або назва в будь-якому регістрі → точна назва зі списку (для select-а); невідоме → "" */
export const canonicalCountry = (raw: string | null | undefined): string => KNOWN.get(countryNamePl(raw).toLowerCase()) ?? "";
