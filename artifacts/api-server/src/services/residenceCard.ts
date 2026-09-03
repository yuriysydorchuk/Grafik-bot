// Скан karta pobytu (польська карта побиту, формат ID-1) → чернетка документа.
// Що на карті надруковано (рішення власника 03.09.2026 — «мету TRC додати,
// зчитувати автоматично»): лицьова — «RODZAJ ZEZWOLENIA» (POBYT CZASOWY /
// POBYT STAŁY / REZYDENT UE / статус uchodźcy …), номер, строк дії; зворот —
// MRZ TD1 (3×30, ICAO 9303 з чек-сумами) і «ADNOTACJE», де стоїть «DOSTĘP DO
// RYNKU PRACY». Мета перебування (праця/навчання/сімʼя) на карті НЕ друкується —
// вона в decyzji, тож лишається ручним селектом (attrs.purpose).
// Чисті функції — під юніт-тестами; OCR — той самий Vision, що для паспорта.
import { callVisionOcr, toVisionCompatible, normalizeForOcr, mrzValid, mrzYearToIso, normalizeMrzCountry } from "./docai";
import { logger } from "../lib/logger";

export type ResidenceCardTypeCode =
  | "trc" | "karta_stalego_pobytu" | "rezydent_ue" | "refugee_status" | "subsidiary_protection"
  | "humanitarian_stay" | "tolerated_stay" | "eu_family_member_card";

export const RESIDENCE_CARD_CODES: ResidenceCardTypeCode[] = [
  "trc", "karta_stalego_pobytu", "rezydent_ue", "refugee_status", "subsidiary_protection", "humanitarian_stay", "tolerated_stay", "eu_family_member_card",
];

export type Td1Mrz = {
  documentCode: string; issuingCountry: string; documentNumber: string; nationality: string;
  surname: string; givenNames: string; sex: "M" | "F" | null;
  birthDate: string | null; expiryDate: string | null;
  documentNumberValid: boolean; birthDateValid: boolean; expiryDateValid: boolean; compositeValid: boolean;
};

// TD1 (3×30). Рядок 1: код документа (2) + країна (3) + номер (9) + чек (1) + опційне (15).
// Рядок 2: народження (6) + чек + стать + строк (6) + чек + громадянство (3) + опційне (11) + composite.
// Рядок 3: NAZWISKO<<IMIONA. OCR-плутанина 0/O в буквених полях — як у паспорті (normalizeMrzCountry).
export function parseTd1Mrz(text: string): Td1Mrz | null {
  const lines = text.split(/\r?\n/).map(l => l.trim().toUpperCase().replace(/\s/g, "")).filter(l => /^[A-Z0-9<]{28,32}$/.test(l));
  for (let i = 0; i < lines.length - 2; i++) {
    const l1 = lines[i]!.padEnd(30, "<").slice(0, 30);
    const l2 = lines[i + 1]!.padEnd(30, "<").slice(0, 30);
    const l3 = lines[i + 2]!.padEnd(30, "<").slice(0, 30);
    if (!/^[IAC]/.test(l1)) continue; // ICAO: карти/посвідчення — I, A, C
    if (!/^\d{6}[0-9<][MF<X]\d{6}[0-9<]/.test(l2)) continue;
    if (!/^[A-Z<]{30}$/.test(l3)) continue;

    const documentNumber = l1.slice(5, 14), docCheck = l1[14]!;
    const birthRaw = l2.slice(0, 6), birthCheck = l2[6]!;
    const sexRaw = l2[7]!;
    const expiryRaw = l2.slice(8, 14), expiryCheck = l2[14]!;
    const nationality = normalizeMrzCountry(l2.slice(15, 18).replace(/</g, "")) ?? "";
    const compositeCheck = l2[29]!;
    const composite = l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29);
    const [surnameRaw, givenRaw = ""] = l3.split("<<");
    return {
      documentCode: l1.slice(0, 2).replace(/</g, ""),
      issuingCountry: normalizeMrzCountry(l1.slice(2, 5).replace(/</g, "")) ?? "",
      documentNumber: documentNumber.replace(/</g, ""),
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

// Польські діакритики й регістр — OCR бачить їх нестабільно («STAŁY»/«STALY»).
const fold = (s: string) => s.toUpperCase()
  .replace(/Ł/g, "L").replace(/Ą/g, "A").replace(/Ę/g, "E").replace(/Ó/g, "O").replace(/Ś/g, "S").replace(/Ć/g, "C").replace(/Ń/g, "N").replace(/Ż|Ź/g, "Z")
  .replace(/\s+/g, " ");

export type ResidenceCardDraft = {
  typeCode: ResidenceCardTypeCode | null;
  permitText: string | null;            // як надруковано (для показу офісу)
  cardNumber: string | null;
  expiresAt: string | null;
  birthDate: string | null;
  nationality: string | null;           // ICAO3 з MRZ (UKR/BLR/…)
  sex: "M" | "F" | null;
  laborMarketAccess: boolean | null;    // null = на звороті анотації не побачили (або звороту не було)
  isResidenceCard: boolean;             // «KARTA POBYTU» знайдено хоч десь
  mrzValid: boolean;
};

// Тип карти — з «RODZAJ ZEZWOLENIA»; порядок важливий (специфічніше — вище).
const PERMIT_PATTERNS: [RegExp, ResidenceCardTypeCode][] = [
  [/CZLONEK RODZINY OBYWATELA (UE|UNII)/, "eu_family_member_card"],
  [/REZYDENT/, "rezydent_ue"],
  [/POBYT STALY|STALY POBYT/, "karta_stalego_pobytu"],
  [/UCHODZC/, "refugee_status"],
  [/OCHRONA UZUPELNIAJACA|OCHRONY UZUPELNIAJACEJ/, "subsidiary_protection"],
  [/POBYT TOLEROWANY|TOLEROWANY/, "tolerated_stay"],
  [/HUMANITARN/, "humanitarian_stay"],
  [/POBYT CZASOWY|CZASOWY/, "trc"],
];

export function parseResidenceCardText(fullText: string, mrz: Td1Mrz | null): ResidenceCardDraft {
  const f = fold(fullText);
  let typeCode: ResidenceCardTypeCode | null = null;
  let permitText: string | null = null;
  for (const [re, code] of PERMIT_PATTERNS) {
    const m = f.match(re);
    if (m) { typeCode = code; permitText = m[0]; break; }
  }
  const laborMarketAccess = /DOSTEP DO RYNKU PRACY/.test(f) ? true : /ADNOTACJE|UWAGI|REMARKS/.test(f) ? false : null;
  // строк дії з тексту — фолбек, якщо MRZ не зчитався: «WAZNA DO / DATE OF EXPIRY 12.05.2027»
  const expiryFromText = f.match(/(?:WAZN[AY] DO|DATE OF EXPIRY|EXPIRY)[^0-9]{0,20}(\d{2})[.\-/ ](\d{2})[.\-/ ](\d{4})/);
  const expiresAt = mrz?.expiryDate ?? (expiryFromText ? `${expiryFromText[3]}-${expiryFromText[2]}-${expiryFromText[1]}` : null);
  return {
    typeCode, permitText,
    cardNumber: mrz?.documentNumber || null,
    expiresAt,
    birthDate: mrz?.birthDate ?? null,
    nationality: mrz?.nationality || null,
    sex: mrz?.sex ?? null,
    laborMarketAccess,
    isResidenceCard: /KARTA POBYTU|RESIDENCE (CARD|PERMIT)/.test(f) || !!mrz,
    mrzValid: !!mrz && mrz.documentNumberValid && mrz.expiryDateValid,
  };
}

// Обидві сторони (або лише лицьова) → OCR кожної → один текст → чернетка.
export async function processResidenceCard(sides: { buffer: Buffer; mime: string }[]): Promise<{ draft: ResidenceCardDraft; mrz: Td1Mrz | null; fullText: string }> {
  const texts: string[] = [];
  for (const s of sides) {
    let prepared = await toVisionCompatible(s.buffer);
    if (s.mime !== "application/pdf") prepared = await normalizeForOcr(prepared);
    texts.push(await callVisionOcr(prepared));
  }
  const fullText = texts.join("\n");
  const mrz = parseTd1Mrz(fullText);
  const draft = parseResidenceCardText(fullText, mrz);
  logger.info({ typeCode: draft.typeCode, mrzFound: !!mrz, mrzValid: draft.mrzValid, laborMarketAccess: draft.laborMarketAccess }, "residence card parsed");
  return { draft, mrz, fullText };
}
